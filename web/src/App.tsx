import { useCallback, useEffect, useMemo, useState } from 'react';
import { ID, defaultFinanceSettings, newList, newSpace, newTask, uid, PALETTE } from './model';
import { ApiError, Session, SessionUser, SyncEngine, WorkspaceInfo, api, idbClear, idbGet, idbSet } from './sync';
import { Bytes, newKeyPair, newRecoveryCode, passwordKeys, recoveryKeys, sealScalar, unlockKeyPair, open as openSealed } from './crypto';
import { Finance } from './finance';
import { APP_BUILD, APP_VERSION, reloadToLatest, useUpdateAvailable } from './version';
import { AppCtx, Avatars, Modal, useApp } from './ui';
import { HomePage, InboxPage, TaskDrawer, TasksPage, deleteFolder, deleteList, deleteSpace } from './pages/Tasks';
import { ChatPage, GoalsPage, TeamPage, TimesheetPage, TrashPage } from './pages/Workspace';
import { WhiteboardsPage } from './pages/Whiteboards';
import { DirectoryPage, FieldsEditor, PortfolioPage, ResourcesPage } from './pages/Advanced';
import { SpaceSettings } from './pages/Work';
import { findByKey, taskKey } from './work';
import {
  AuditPage, BudgetsPage, CatalogPage, ContractsPage, FinanceSettingsPage,
  OrdersPage, ReportsPage, SavingsPage,
} from './pages/Finance';
import { SharePage } from './pages/Share';
import { AppsPage } from './pages/Apps';
import { useInstallPrompt } from './pwa';

const USER_KEY = 'mkprod.user';
const WS_KEY = 'mkprod.workspace';
const SEED_KEY = 'mkprod.seed:';

/** Restores a session: profile from localStorage, non-extractable private key from IndexedDB, cookie for the API. */
async function restoreSession(): Promise<Session | null> {
  try {
    const user = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as SessionUser | null;
    if (!user) return null;
    const privateKey = await idbGet<CryptoKey>('pk:' + user.id);
    return privateKey ? { user, privateKey } : null;
  } catch { return null; }
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  // True when the person asked for the picker (switch / create / join): then it must not auto-open a workspace.
  const [manualPick, setManualPick] = useState(false);
  const isShare = location.pathname.startsWith('/share/');
  useEffect(() => { if (!isShare) restoreSession().then(setSession); }, []);

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(WS_KEY);
    await idbClear();
    setSession(null);
    setWorkspace(null);
  }, []);

  // Supplier links are public pages: no account, no workspace.
  if (isShare) return <SharePage />;
  if (session === undefined) return null;
  if (!session) return <AuthScreen onSession={setSession} />;
  if (!workspace) return <WorkspacePicker session={session} manual={manualPick} onPick={(w) => { localStorage.setItem(WS_KEY, w.id); setManualPick(false); setWorkspace(w); }} onSignOut={signOut} />;
  return <Workspace key={workspace.id} session={session} workspace={workspace} onSwitch={() => { localStorage.removeItem(WS_KEY); setManualPick(true); setWorkspace(null); }} onSwitchTo={(w) => { localStorage.setItem(WS_KEY, w.id); location.hash = ''; setWorkspace(w); }} onSignOut={signOut} />;
}

// ---------------------------------------------------------------- auth

/** After the server accepts us: unlock (or create) the key pair, make sure a recovery code exists. */
async function finishAuth(user: SessionUser, kek: CryptoKey, email: string): Promise<{ session: Session; recoveryCode?: string }> {
  let pair, scalar: Bytes;
  if (user.publicKey && user.encPrivateKey) {
    ({ pair, scalar } = await unlockKeyPair(kek, user.encPrivateKey, user.publicKey));
  } else {
    const k = await newKeyPair(kek);
    await api('/api/me/keys', { method: 'PUT', body: { publicKey: k.publicKey, encPrivateKey: k.encPrivateKey } });
    user = { ...user, publicKey: k.publicKey, encPrivateKey: k.encPrivateKey };
    pair = k.pair;
    scalar = k.scalar;
  }
  let recoveryCode: string | undefined;
  const me = await api<{ user: { hasRecovery: boolean } }>('/api/me');
  if (!me.user.hasRecovery) {
    recoveryCode = newRecoveryCode();
    const rk = await recoveryKeys(email, recoveryCode);
    await api('/api/me/recovery', { method: 'PUT', body: { recAuth: rk.authKey, encPrivateKeyRec: await sealScalar(rk.kek, scalar) } });
  }
  scalar.fill(0);
  await idbSet('pk:' + user.id, pair.privateKey);
  localStorage.setItem(USER_KEY, JSON.stringify({ id: user.id, email: user.email, name: user.name, color: user.color, publicKey: user.publicKey }));
  return { session: { user, privateKey: pair.privateKey }, recoveryCode };
}

type AuthStep =
  | { kind: 'form' }
  | { kind: 'mfa'; mfaToken: string; kek: CryptoKey; email: string }
  | { kind: 'verify'; result: { session: Session; recoveryCode?: string } }
  | { kind: 'recovery'; result: { session: Session; recoveryCode: string } };

function AuthScreen({ onSession }: { onSession: (s: Session) => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'recover'>('in');
  const [form, setForm] = useState({ name: '', email: '', password: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState<AuthStep>({ kind: 'form' });

  /** Recovery code first (shown once), then straight into the app. */
  const done = (r: { session: Session; recoveryCode?: string }) => (r.recoveryCode ? setStep({ kind: 'recovery', result: { session: r.session, recoveryCode: r.recoveryCode } }) : onSession(r.session));
  const afterLogin = async (res: { user: SessionUser; needsVerification?: boolean }, kek: CryptoKey, email: string) => {
    const r = await finishAuth(res.user, kek, email);
    if (res.needsVerification || res.user.emailVerified === false) setStep({ kind: 'verify', result: r });
    else done(r);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const email = form.email.trim().toLowerCase();
    try {
      if (mode !== 'in' && form.password.length < 10) throw new Error('Use at least 10 characters for your password.');
      setBusy('Securing your password…');
      if (mode === 'recover') {
        const rk = await recoveryKeys(email, form.code);
        const r = await api<{ token: string; encPrivateKeyRec: string }>('/api/auth/recover', { body: { email, recAuth: rk.authKey } });
        const scalar = await openSealed(rk.kek, r.encPrivateKeyRec, 'mkprod-v1:privkey');
        const pk = await passwordKeys(email, form.password);
        const res = await api<{ user: SessionUser }>('/api/auth/recover/finish', { bearer: r.token, body: { newAuthKey: pk.authKey, encPrivateKey: await sealScalar(pk.kek, scalar) } });
        scalar.fill(0);
        await afterLogin(res, pk.kek, email);
        return;
      }
      const pk = await passwordKeys(email, form.password);
      if (mode === 'up') {
        const k = await newKeyPair(pk.kek);
        const res = await api<{ user: SessionUser; needsVerification: boolean }>('/api/auth/signup', { body: { email, name: form.name, authKey: pk.authKey, publicKey: k.publicKey, encPrivateKey: k.encPrivateKey } });
        await afterLogin(res, pk.kek, email);
        return;
      }
      let res: { user: SessionUser; mfa?: boolean; mfaToken?: string };
      try {
        res = await api('/api/auth/login', { body: { email, authKey: pk.authKey } });
      } catch (err) {
        // Accounts from before client-side encryption: prove the password once, then upgrade.
        if (!(err instanceof ApiError && err.body.legacy)) throw err;
        res = await api('/api/auth/login', { body: { email, authKey: pk.authKey, password: form.password } });
      }
      if (res.mfa && res.mfaToken) { setStep({ kind: 'mfa', mfaToken: res.mfaToken, kek: pk.kek, email }); return; }
      await afterLogin(res, pk.kek, email);
    } catch (err) {
      setError((err as Error).name === 'OperationError' ? 'Could not unlock your encryption keys with this password.' : (err as Error).message);
    } finally { setBusy(''); }
  };

  if (step.kind === 'recovery') return <RecoveryCodeScreen code={step.result.recoveryCode} onDone={() => onSession(step.result.session)} />;
  if (step.kind === 'verify') return <VerifyEmailScreen email={step.result.session.user.email} onDone={() => done(step.result)} onSignOut={() => { setStep({ kind: 'form' }); api('/api/auth/logout', { method: 'POST' }).catch(() => {}); }} />;
  if (step.kind === 'mfa') {
    return (
      <MfaScreen onCancel={() => setStep({ kind: 'form' })} onCode={async (code) => {
        const res = await api<{ user: SessionUser }>('/api/auth/mfa', { bearer: step.mfaToken, body: { code } });
        await afterLogin(res, step.kek, step.email);
      }} />
    );
  }
  return (
    <div className="auth">
      <form className="card col" onSubmit={submit}>
        <div className="row"><div className="logo">MK</div><div><h2>MK Prod</h2><div className="small muted">🔒 End-to-end encrypted workspace</div></div></div>
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button type="button" className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')}>Sign in</button>
          <button type="button" className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')}>Create account</button>
        </div>
        {mode === 'recover' && <p className="small">Enter your email, the recovery code you saved, and a new password.</p>}
        {mode === 'up' && <label className="field">Your name<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" /></label>}
        <label className="field">Email<input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="username" /></label>
        {mode === 'recover' && <label className="field">Recovery code<input className="input" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} /></label>}
        <label className="field">{mode === 'recover' ? 'New password' : 'Password'}<input className="input" type="password" required minLength={mode === 'in' ? 8 : 10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></label>
        {error && <div className="red small">{error}</div>}
        <button className="btn primary" disabled={!!busy}>{busy || (mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Reset password')}</button>
        {mode === 'in' && <button type="button" className="btn ghost sm" onClick={() => setMode('recover')}>Forgot password? Use your recovery code</button>}
        {mode === 'recover' && <button type="button" className="btn ghost sm" onClick={() => setMode('in')}>Back to sign in</button>}
        <p className="small muted">Your password never leaves this device; it's stretched here and used to unlock your encryption keys. No recovery code? A workspace admin can reset your password.</p>
      </form>
    </div>
  );
}

function MfaScreen({ onCode, onCancel }: { onCode: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await onCode(code.trim()); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card col" onSubmit={submit}>
        <h2>🔐 Two-factor sign-in</h2>
        <p className="small muted">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
        <input className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" autoComplete="one-time-code" inputMode="numeric" style={{ fontSize: 22, textAlign: 'center', letterSpacing: 3 }} />
        {error && <div className="red small">{error}</div>}
        <button className="btn primary" disabled={busy || code.replace(/\W/g, '').length < 6}>{busy ? 'Checking…' : 'Continue'}</button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>Back</button>
      </form>
    </div>
  );
}

/** Shown after sign-up (and to older accounts that haven't confirmed) until the emailed code is entered. */
export function VerifyEmailScreen({ email, onDone, onSignOut }: { email: string; onDone: () => void; onSignOut: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api('/api/auth/verify', { body: { code: code.trim() } }); onDone(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const resend = async () => {
    setError(''); setInfo('');
    try { await api('/api/auth/verify/resend', { body: {} }); setInfo(`A new code was sent to ${email}.`); } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="auth">
      <form className="card col" onSubmit={submit}>
        <h2>✉️ Confirm your email</h2>
        <p className="small muted">We sent a 6-digit code to <strong>{email}</strong>. Enter it below. Check your spam folder if it hasn't arrived after a minute.</p>
        <input className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" style={{ fontSize: 22, textAlign: 'center', letterSpacing: 3 }} />
        {error && <div className="red small">{error}</div>}
        {info && <div className="green small">{info}</div>}
        <button className="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
        <div className="row"><button type="button" className="btn ghost sm" onClick={resend}>Send a new code</button><span className="grow" /><button type="button" className="btn ghost sm" onClick={onSignOut}>Sign out</button></div>
      </form>
    </div>
  );
}

function RecoveryCodeScreen({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="auth">
      <div className="card col">
        <h2>🔑 Save your recovery code</h2>
        <p className="small">Your data is end-to-end encrypted. If you forget your password, this code is the only way to get back in without losing access. Store it in a password manager or print it. It is shown <strong>only once</strong>.</p>
        <div className="mono" style={{ fontSize: 18, fontWeight: 700, padding: 12, borderRadius: 8, background: 'var(--hover)', textAlign: 'center', userSelect: 'all', wordBreak: 'break-all' }}>{code}</div>
        <div className="row">
          <button className="btn" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
        <label className="row small"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my recovery code somewhere safe</label>
        <button className="btn primary" disabled={!saved} onClick={onDone}>Continue</button>
      </div>
    </div>
  );
}

function WorkspacePicker({ session, manual, onPick, onSignOut }: { session: Session; manual?: boolean; onPick: (w: WorkspaceInfo) => void; onSignOut: () => void }) {
  const [list, setList] = useState<WorkspaceInfo[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [verify, setVerify] = useState(false);
  useEffect(() => {
    api<{ workspaces: WorkspaceInfo[]; user: { emailVerified?: boolean } }>('/api/me').then((r) => {
      setList(r.workspaces);
      if (r.user.emailVerified === false) { setVerify(true); return; }
      if (manual) return;
      const last = localStorage.getItem(WS_KEY);
      const w = r.workspaces.find((x) => x.id === last) ?? (r.workspaces.length === 1 ? r.workspaces[0] : undefined);
      if (w) onPick(w);
    }).catch((e) => { if (e instanceof ApiError && e.status === 401) onSignOut(); else setError(e.message); });
  }, []);
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.body.needsVerification) setVerify(true);
    setError((e as Error).message);
  };
  const create = async () => {
    try {
      const { id } = await api<{ id: ID }>('/api/workspaces', { body: { name: name || 'My workspace' } });
      // Starter content is created locally, so its first upload is already encrypted.
      const space = newSpace('Team', PALETTE[0]);
      const list = newList(space.id, 'Tasks');
      sessionStorage.setItem(SEED_KEY + id, JSON.stringify([
        ['spaces', space], ['lists', list], ['channels', { id: uid(), name: 'general' }], ['financeSettings', defaultFinanceSettings()],
      ]));
      onPick({ id, name: name || 'My workspace', role: 'owner' });
    } catch (e) { fail(e); }
  };
  const join = async () => {
    try {
      const r = await api<{ workspace: WorkspaceInfo }>('/api/invites/accept', { body: { code } });
      onPick(r.workspace);
    } catch (e) { fail(e); }
  };
  if (verify) return <VerifyEmailScreen email={session.user.email} onDone={() => { setVerify(false); setError(''); }} onSignOut={onSignOut} />;
  return (
    <div className="auth">
      <div className="card col">
        <div className="row"><div className="logo">MK</div><h2 className="grow">Choose a workspace</h2><button className="btn ghost sm" onClick={onSignOut}>Sign out</button></div>
        <div className="small muted">Signed in as {session.user.email}</div>
        {list === null && !error && <p className="muted">Loading…</p>}
        {list?.map((w) => <button key={w.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => onPick(w)}><span>{w.name}</span><span className="small muted">{w.locked ? '🔒 locked · ' : ''}{w.role}</span></button>)}
        {list?.length === 0 && <p className="small muted">No workspaces yet. Create one, or enter the invite code an admin gave you.</p>}
        <div className="row"><input className="input grow" placeholder="Invite code (XXXX-XXXX-XXXX)" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" /><button className="btn" disabled={code.replace(/\W/g, '').length < 12} onClick={join}>Join</button></div>
        <div className="row"><input className="input grow" placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn primary" onClick={create}>Create</button></div>
        {error && <div className="red small">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- workspace shell

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const task = new URLSearchParams(query ?? '').get('task') ?? undefined;
  return { route: path || 'home', task };
}

/** Shown when a newer build is live; one click reloads onto it (same on the website, Windows and Android). */
function UpdateBar() {
  const newer = useUpdateAvailable();
  if (!newer) return null;
  return (
    <div className="update-bar" role="status">
      <span>MK Prod {newer} is ready.</span>
      <button className="btn sm primary" onClick={() => reloadToLatest()}>Update now</button>
    </div>
  );
}

function Workspace({ session, workspace, onSwitch, onSwitchTo, onSignOut }: { session: Session; workspace: WorkspaceInfo; onSwitch: () => void; onSwitchTo: (w: WorkspaceInfo) => void; onSignOut: () => void }) {
  const engine = useMemo(() => new SyncEngine(session, workspace, onSignOut), [session, workspace]);
  const fin = useMemo(() => new Finance(engine), [engine]);
  const [{ route, task }, setLoc] = useState(parseHash);
  const [toastMsg, setToast] = useState('');
  useEffect(() => {
    engine.approvalCheck = (o, m) => fin.canApprove(o, m);
    const seed = sessionStorage.getItem(SEED_KEY + workspace.id);
    if (seed) {
      sessionStorage.removeItem(SEED_KEY + workspace.id);
      for (const [kind, obj] of JSON.parse(seed)) engine.put(kind, obj);
    }
    engine.start();
    const onHash = () => setLoc(parseHash());
    window.addEventListener('hashchange', onHash);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    return () => { engine.stop(); window.removeEventListener('hashchange', onHash); };
  }, [engine]);
  useEffect(() => { engine.viewing = task ? `task:${task}` : route; }, [route, task]);
  const go = useCallback((r: string) => { location.hash = '/' + r; }, []);
  const openTask = useCallback((id?: ID) => { location.hash = '/' + parseHash().route + (id ? `?task=${id}` : ''); }, []);
  const toast = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 3000); }, []);
  const ctx = { engine, fin, go, route, openTask, toast };
  return (
    <AppCtx.Provider value={ctx}>
      <Shell onSwitch={onSwitch} onSwitchTo={onSwitchTo} onSignOut={onSignOut}>
        <Page route={route} />
      </Shell>
      {task && <TaskDrawer id={task} onClose={() => openTask()} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
      <UpdateBar />
    </AppCtx.Provider>
  );
}

function Page({ route }: { route: string }) {
  const [p, id] = route.split('/');
  switch (p) {
    case 'home': return <HomePage />;
    case 'inbox': return <InboxPage />;
    case 'mine': return <TasksPage scope={{ kind: 'mine' }} />;
    case 'everything': return <TasksPage scope={{ kind: 'everything' }} />;
    case 'space': case 'folder': case 'list': return <TasksPage key={route} scope={{ kind: p, id }} />;
    case 'whiteboards': return <WhiteboardsPage id={id} />;
    case 'chat': return <ChatPage id={id} />;
    case 'goals': return <GoalsPage />;
    case 'portfolio': return <PortfolioPage />;
    case 'resources': return <ResourcesPage />;
    case 'directory': return <DirectoryPage />;
    case 'time': return <TimesheetPage />;
    case 'trash': return <TrashPage />;
    case 'team': return <TeamPage />;
    case 'budgets': return <BudgetsPage />;
    case 'orders': return <OrdersPage openId={id} />;
    case 'approvals': return <OrdersPage approvalsOnly openId={id} />;
    case 'catalog': return <CatalogPage />;
    case 'contracts': return <ContractsPage />;
    case 'savings': return <SavingsPage />;
    case 'reports': return <ReportsPage />;
    case 'audit': return <AuditPage />;
    case 'fsettings': return <FinanceSettingsPage />;
    case 'apps': return <AppsPage />;
    default: return <HomePage />;
  }
}

function Shell({ children, onSwitch, onSwitchTo, onSignOut }: { children: React.ReactNode; onSwitch: () => void; onSwitchTo: (w: WorkspaceInfo) => void; onSignOut: () => void }) {
  const { engine, fin, go, route, openTask, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [wsMenu, setWsMenu] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: { label: string; danger?: boolean; act: () => void }[] } | null>(null);
  const [fieldsFor, setFieldsFor] = useState<ID | null>(null);
  const [settingsFor, setSettingsFor] = useState<ID | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  useEffect(() => { api<{ workspaces: WorkspaceInfo[] }>('/api/me').then((r) => setWorkspaces(r.workspaces)).catch(() => {}); }, []);
  useEffect(() => {
    if (!menu && !wsMenu) return;
    const close = () => { setMenu(null); setWsMenu(false); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); };
  }, [menu, wsMenu]);
  /** Small context menu, opened by the ⋯ button or a right-click on a sidebar item. */
  const openMenu = (e: React.MouseEvent, items: { label: string; danger?: boolean; act: () => void }[]) => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: e.clientY, items });
  };
  const rename = (what: string, current: string, save: (v: string) => void) => { const v = prompt(`Rename ${what}`, current); if (v && v.trim() && v.trim() !== current) save(v.trim()); };
  const spaceMenu = (s: { id: ID; name: string }) => [
    { label: 'Rename space', act: () => rename('space', s.name, (v) => engine.update('spaces', s.id, (x) => { x.name = v; })) },
    { label: 'New list', act: () => addList(s.id) },
    { label: 'Space settings…', act: () => setSettingsFor(s.id) },
    { label: 'Custom fields…', act: () => setFieldsFor(s.id) },
    { label: 'Delete space…', danger: true, act: () => {
      const n = engine.list('lists').filter((l) => l.spaceId === s.id).reduce((a, l) => a + engine.list('tasks').filter((t) => t.listId === l.id).length, 0);
      if (confirm(`Delete the space "${s.name}" with its lists and ${n} task(s)? This cannot be undone.`)) { deleteSpace(engine, s.id); go('home'); toast('Space deleted'); }
    } },
  ];
  const listMenu = (l: { id: ID; name: string; archived: boolean }) => [
    { label: 'Rename list', act: () => rename('list', l.name, (v) => engine.update('lists', l.id, (x) => { x.name = v; })) },
    { label: 'Archive list', act: () => { engine.update('lists', l.id, (x) => { x.archived = true; }); go('home'); } },
    { label: 'Delete list…', danger: true, act: () => {
      const n = engine.list('tasks').filter((t) => t.listId === l.id).length;
      if (confirm(`Delete the list "${l.name}" and its ${n} task(s)? This cannot be undone.`)) { deleteList(engine, l.id); go('home'); toast('List deleted'); }
    } },
  ];
  const folderMenu = (f: { id: ID; name: string }) => [
    { label: 'Rename folder', act: () => rename('folder', f.name, (v) => engine.update('folders', f.id, (x) => { x.name = v; })) },
    { label: 'Delete folder…', danger: true, act: () => { if (confirm(`Delete the folder "${f.name}" with its lists and tasks?`)) { deleteFolder(engine, f.id); go('home'); toast('Folder deleted'); } } },
  ];
  const [search, setSearch] = useState(false);
  const [expanded, setExpanded] = useState<Set<ID>>(new Set());
  const install = useInstallPrompt();
  const nav = (r: string, icon: string, label: string, badge?: number, items?: { label: string; danger?: boolean; act: () => void }[]) => (
    <div className={`nav ${route === r || route.startsWith(r + '/') ? 'on' : ''}`} onClick={() => { go(r); setOpen(false); }} onContextMenu={items && engine.canWrite ? (e) => openMenu(e, items) : undefined}>
      <span className="ic">{icon}</span><span className="ellipsis grow">{label}</span>{badge ? <span className="badge">{badge}</span> : null}
      {items && engine.canWrite && <button className="btn ghost sm more" title="More" onClick={(e) => openMenu(e, items)}>⋯</button>}
    </div>
  );
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch(true); return; }
      const el = e.target as HTMLElement;
      if (e.key === '?' && !/INPUT|TEXTAREA|SELECT/.test(el.tagName) && !el.isContentEditable) { e.preventDefault(); setShortcuts(true); }
    };
    const open = () => setShortcuts(true);
    window.addEventListener('keydown', k);
    window.addEventListener('mkprod:shortcuts', open);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('mkprod:shortcuts', open); };
  }, []);
  const unread = engine.inbox.filter((n) => !n.read).length;
  const approvals = engine.list('orders').filter((o) => fin.canApprove(o)).length;
  const others = engine.presence.filter((p) => p.user_id !== engine.me).map((p) => p.user_id);
  const st = engine.status;
  const addSpace = () => {
    const n = prompt('Space name');
    if (!n) return;
    const s = newSpace(n, PALETTE[engine.list('spaces').length % PALETTE.length]);
    engine.put('spaces', s);
    const l = newList(s.id, 'List');
    engine.put('lists', l);
    go('list/' + l.id);
  };
  const addList = (spaceId: ID) => {
    const n = prompt('List name');
    if (n) { const l = newList(spaceId, n); engine.put('lists', l); go('list/' + l.id); }
  };
  return (
    <div className="app">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="side-scroll">
          <div className="row ws-head" style={{ padding: '4px 8px 8px', position: 'relative' }} onClick={(e) => { e.stopPropagation(); setWsMenu(!wsMenu); }} title="Switch workspace">
            <div className="logo" style={{ width: 28, height: 28, fontSize: 12, borderRadius: 8 }}>MK</div>
            <div className="grow ellipsis"><strong>{engine.workspace.name}</strong></div>
            <span className="small faint">{workspaces.length > 1 ? '⌄' : ''}</span>
            {wsMenu && (
              <div className="menu" style={{ left: 8, top: 40, minWidth: 220 }} onClick={(e) => e.stopPropagation()}>
                <div className="small faint" style={{ padding: '4px 10px' }}>Your workspaces</div>
                {workspaces.map((w) => (
                  <div key={w.id} className={`item ${w.id === engine.workspace.id ? 'on' : ''}`} onClick={() => { setWsMenu(false); if (w.id !== engine.workspace.id) onSwitchTo(w); }}>
                    <span className="grow ellipsis">{w.name}</span><span className="small muted">{w.role}</span>{w.id === engine.workspace.id && <span>✓</span>}
                  </div>
                ))}
                <div className="item" onClick={() => { setWsMenu(false); onSwitch(); }}>＋ Create or join a workspace…</div>
              </div>
            )}
          </div>
          <div className="nav" onClick={() => setSearch(true)}><span className="ic">🔍</span>Search<span className="small faint right">⌘K</span></div>
          {nav('home', '🏠', 'Home')}
          {nav('inbox', '📥', 'Inbox', unread)}
          {nav('mine', '👤', 'My Tasks')}
          {nav('everything', '🗂', 'Everything')}
          <h4>Spaces <button className="btn ghost sm right" onClick={addSpace} title="New space">＋</button></h4>
          {engine.list('spaces').map((s) => (
            <div key={s.id}>
              <div className={`nav ${route === 'space/' + s.id ? 'on' : ''}`} onContextMenu={engine.canWrite ? (e) => openMenu(e, spaceMenu(s)) : undefined}>
                <span className="ic" onClick={() => setExpanded((x) => { const n = new Set(x); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}>{expanded.has(s.id) ? '▾' : '▸'}</span>
                <span style={{ width: 14, height: 14, borderRadius: 4, background: s.colorHex }} />
                <span className="grow ellipsis" onClick={() => go('space/' + s.id)}>{s.name}</span>
                {engine.canWrite && <button className="btn ghost sm more" title="Rename, delete…" onClick={(e) => openMenu(e, spaceMenu(s))}>⋯</button>}
                <button className="btn ghost sm" title="New list" onClick={() => addList(s.id)}>＋</button>
              </div>
              {expanded.has(s.id) && (
                <div style={{ paddingLeft: 18 }}>
                  {engine.list('folders').filter((f) => f.spaceId === s.id).map((f) => (
                    <div key={f.id}>
                      {nav('folder/' + f.id, '📁', f.name, undefined, folderMenu(f))}
                      <div style={{ paddingLeft: 14 }}>{engine.list('lists').filter((l) => l.folderId === f.id && !l.archived).map((l) => <div key={l.id}>{nav('list/' + l.id, l.sprintStart ? '🏁' : '☰', l.name, undefined, listMenu(l))}</div>)}</div>
                    </div>
                  ))}
                  {engine.list('lists').filter((l) => l.spaceId === s.id && !l.folderId && !l.archived).map((l) => <div key={l.id}>{nav('list/' + l.id, '☰', l.name, undefined, listMenu(l))}</div>)}
                </div>
              )}
            </div>
          ))}
          <h4>Workspace</h4>
          {nav('whiteboards', '🧩', 'Whiteboards')}
          {nav('chat', '💬', 'Chat')}
          {nav('goals', '🎯', 'Goals')}
          {nav('portfolio', '🗂', 'Portfolio')}
          {nav('resources', '📅', 'Resources')}
          {nav('time', '⏱', 'Timesheets')}
          {nav('directory', '📚', 'Content directory')}
          {nav('trash', '🗑', 'Trash')}
          <h4>Budget & procurement</h4>
          {nav('budgets', '💰', 'Budgets')}
          {nav('orders', '📦', 'Orders & expenses')}
          {nav('approvals', '✅', 'My approvals', approvals)}
          {nav('catalog', '🛒', 'Shopping catalog')}
          {nav('contracts', '📄', 'Contracts')}
          {nav('savings', '💵', 'Savings')}
          {nav('reports', '📑', 'Reports')}
          {nav('audit', '📜', 'Audit log')}
          {nav('fsettings', '⚙️', 'Finance settings')}
          <h4>Apps</h4>
          {nav('apps', '📲', 'Get the apps')}
          {install && <div className="nav install" onClick={() => install()} title="Adds MK Prod to your Start menu / Dock as its own window. No admin rights needed."><span className="ic">⬇</span>Install as an app</div>}
        </div>
        <div className="side-foot">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis"><strong>{session().user.name}</strong></div>
            <div className="small muted row">
              <span title={st.error ?? ''}>{st.state === 'synced' ? (engine.encrypted ? '🔒 Synced · encrypted' : '✅ Synced') : st.state === 'syncing' ? '🔄 Syncing' : st.state === 'offline' ? '📴 Offline' : st.state === 'locked' ? '🔐 Waiting for key' : st.state === 'error' ? '⚠️ Sync error' : '…'}</span>
              {others.length > 0 && <Avatars ids={others} size={16} />}
              <span className="faint" title={`Build ${APP_BUILD}`}>v{APP_VERSION}</span>
            </div>
          </div>
          <button className="btn ghost sm" title="Team & account" onClick={() => go('team')}>👥</button>
          <button className="btn ghost sm" title="Switch workspace" onClick={onSwitch}>⇄</button>
          <button className="btn ghost sm" title="Sign out" onClick={onSignOut}>⏻</button>
        </div>
      </aside>
      {open && <div className="scrim" style={{ zIndex: 24 }} onClick={() => setOpen(false)} />}
      <main className="main">
        <div className="topbar">
          <button className="btn ghost menu-btn" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <strong className="grow ellipsis">{title(route, engine)}</strong>
          {engine.role === 'viewer' && <span className="pill" style={{ background: '#E8912D26', color: '#E8912D' }}>View only</span>}
        </div>
        {(st.state === 'error' || st.state === 'locked') && st.error && (
          <div className="banner" onClick={() => go('team')} role="status">⚠️ {st.error}</div>
        )}
        <div className="page">{children}</div>
      </main>
      {settingsFor && <SpaceSettings spaceId={settingsFor} onClose={() => setSettingsFor(null)} />}
      {shortcuts && <ShortcutsModal onClose={() => setShortcuts(false)} />}
      {fieldsFor && engine.get('spaces', fieldsFor) && <FieldsEditor space={engine.get('spaces', fieldsFor)!} onClose={() => setFieldsFor(null)} />}
      {search && <SearchModal onClose={() => setSearch(false)} onTask={(id) => { setSearch(false); openTask(id); }} />}
      {menu && (
        <div className="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 60 }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it) => <div key={it.label} className={`item ${it.danger ? 'danger' : ''}`} onClick={() => { setMenu(null); it.act(); }}>{it.label}</div>)}
        </div>
      )}
    </div>
  );

  function session() { return engine.session; }
}

function title(route: string, engine: SyncEngine) {
  const [p, id] = route.split('/');
  if (p === 'list') return engine.get('lists', id)?.name ?? 'List';
  if (p === 'space') return engine.get('spaces', id)?.name ?? 'Space';
  if (p === 'folder') return engine.get('folders', id)?.name ?? 'Folder';
  return ({ home: 'Home', inbox: 'Inbox', mine: 'My Tasks', everything: 'Everything', whiteboards: 'Whiteboards', chat: 'Chat', goals: 'Goals', portfolio: 'Portfolio', resources: 'Resource management', directory: 'Content directory', time: 'Timesheets', trash: 'Trash', team: 'Team & account',
    budgets: 'Budgets', orders: 'Orders & expenses', approvals: 'My approvals', catalog: 'Shopping catalog', contracts: 'Contracts',
    savings: 'Savings', reports: 'Reports', audit: 'Audit log', fsettings: 'Finance settings', apps: 'Get the apps' } as Record<string, string>)[p] ?? 'MK Prod';
}

/** ⌘K: jump anywhere, find tasks (also by ID, e.g. ENG-42), and run commands. ↑↓ to choose, Enter to open. */
function SearchModal({ onClose, onTask }: { onClose: () => void; onTask: (id: ID) => void }) {
  const { engine, go, route } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const s = q.trim().toLowerCase();
  const to = (r: string) => () => { go(r); onClose(); };
  const pages: [string, string, string][] = [
    ['home', '🏠', 'Home'], ['inbox', '📥', 'Inbox'], ['mine', '👤', 'My Tasks'], ['everything', '🗂', 'Everything'], ['whiteboards', '🧩', 'Whiteboards'],
    ['chat', '💬', 'Chat'], ['goals', '🎯', 'Goals'], ['portfolio', '🗂', 'Portfolio'], ['resources', '📅', 'Resources'], ['time', '⏱', 'Timesheets'],
    ['directory', '📚', 'Content directory'], ['trash', '🗑', 'Trash'], ['budgets', '💰', 'Budgets'], ['orders', '📦', 'Orders & expenses'],
    ['approvals', '✅', 'My approvals'], ['catalog', '🛒', 'Shopping catalog'], ['contracts', '📄', 'Contracts'], ['reports', '📑', 'Reports'], ['team', '👥', 'Team & account'],
  ];
  const listHere = route.startsWith('list/') ? route.slice(5) : engine.list('lists').find((l) => !l.archived)?.id;
  const commands = [
    ...(engine.canWrite && listHere ? [{ k: 'cmd-new', icon: '＋', label: `New task in ${engine.get('lists', listHere)?.name ?? 'list'}`, hint: 'n', act: () => {
      const title = prompt('Task name')?.trim();
      const list = engine.get('lists', listHere);
      const st = engine.get('spaces', list?.spaceId)?.statuses[0];
      if (title && list && st) { const t = newTask(list.id, title, st.id, engine.members.find((m) => m.id === engine.me)); engine.put('tasks', t); onTask(t.id); } else onClose();
    } }] : []),
    { k: 'cmd-shortcuts', icon: '⌨️', label: 'Keyboard shortcuts', hint: '?', act: () => { onClose(); window.dispatchEvent(new CustomEvent('mkprod:shortcuts')); } },
  ];
  const byKey = s ? findByKey(engine, s) : undefined;
  const hits = !s
    ? [...commands, ...pages.slice(0, 6).map(([r, icon, label]) => ({ k: r, icon, label, hint: 'Go to', act: to(r) }))]
    : [
      ...(byKey ? [{ k: 'key' + byKey.id, icon: '#', label: `${q.toUpperCase()} · ${byKey.title}`, hint: 'Task ID', act: () => onTask(byKey.id) }] : []),
      ...engine.list('tasks').filter((t) => !t.archived && t.id !== byKey?.id && (t.title + ' ' + t.details).toLowerCase().includes(s)).slice(0, 10)
        .map((t) => ({ k: t.id, icon: '✓', label: t.title, hint: [taskKey(engine, t), engine.get('lists', t.listId)?.name].filter(Boolean).join(' · '), act: () => onTask(t.id) })),
      ...commands.filter((c) => c.label.toLowerCase().includes(s)),
      ...pages.filter(([, , label]) => label.toLowerCase().includes(s)).map(([r, icon, label]) => ({ k: r, icon, label, hint: 'Go to', act: to(r) })),
      ...engine.list('lists').filter((l) => l.name.toLowerCase().includes(s)).slice(0, 4).map((l) => ({ k: l.id, icon: '☰', label: l.name, hint: engine.get('spaces', l.spaceId)?.name ?? 'List', act: to('list/' + l.id) })),
      ...engine.list('spaces').filter((x) => x.name.toLowerCase().includes(s)).slice(0, 3).map((x) => ({ k: x.id, icon: '🟪', label: x.name, hint: 'Space', act: to('space/' + x.id) })),
      ...engine.list('whiteboards').filter((w) => w.name.toLowerCase().includes(s)).slice(0, 4).map((w) => ({ k: w.id, icon: '🧩', label: w.name, hint: 'Whiteboard', act: to('whiteboards/' + w.id) })),
      ...engine.list('orders').filter((o) => `${o.title} ${o.supplier} ${o.poNumber} ${o.number}`.toLowerCase().includes(s)).slice(0, 6).map((o) => ({ k: o.id, icon: '📦', label: `#${o.number} ${o.title}`, hint: 'Order', act: to('orders/' + o.id) })),
      ...engine.list('contracts').filter((c) => `${c.title} ${c.supplier}`.toLowerCase().includes(s)).slice(0, 4).map((c) => ({ k: c.id, icon: '📄', label: c.title, hint: 'Contract', act: to('contracts') })),
    ];
  const cur = Math.min(sel, Math.max(hits.length - 1, 0));
  return (
    <Modal title="Search & commands" onClose={onClose}>
      <div className="search-box big"><span>🔍</span><input className="plain grow" autoFocus placeholder="Search tasks, IDs (ENG-42), lists, pages, orders… or a command" value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(x + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
          if (e.key === 'Enter') hits[cur]?.act();
        }} /></div>
      {!s && <div className="small faint" style={{ margin: '8px 4px 2px' }}>Suggestions</div>}
      <div className="cmd-list">{hits.map((h, i) => (
        <div key={h.k} className={`cmd ${i === cur ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={h.act}><span className="ic">{h.icon}</span><span className="grow ellipsis">{h.label}</span>{h.hint && <span className="small faint">{h.hint}</span>}</div>
      ))}</div>
      {s && !hits.length && <p className="muted">No matches.</p>}
    </Modal>
  );
}

/** "?" anywhere: the keyboard shortcuts. */
function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [['⌘K / Ctrl K', 'Search and commands'], ['n', 'New task (in a task view)'], ['/', 'Search the tasks in view'], ['?', 'This list'], ['Esc', 'Close a panel or dialog'], ['⌘↵ / Ctrl ↵', 'Send a comment or reply']];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="t"><tbody>{rows.map(([k, v]) => <tr key={k}><td style={{ width: 150 }}><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
    </Modal>
  );
}
