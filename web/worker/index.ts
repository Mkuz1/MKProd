/**
 * MK Prod sync API (Cloudflare Worker + D1 + R2).
 *
 * The Mac app and the website are both clients of this API. Every synced object is a JSON
 * row in `records`; clients push changed objects and pull everything after their cursor
 * in a single POST /api/workspaces/:id/sync call.
 *
 * Record contents are end-to-end encrypted by the clients (see SECURITY.md): once a
 * workspace has a key version, `data` is `{"enc": "...", "v": n}` and this Worker never sees
 * plaintext. Passwords are stretched on the client; the server only receives an auth key.
 * The same holds for file attachments (ciphertext in R2) and supplier share links (snapshot
 * encrypted with a key that lives only in the link).
 *
 * Email notifications are composed by the clients (the only place data is readable) and
 * relayed here; the server checks the recipient is a member, applies their preferences,
 * de-duplicates and sends over SMTP (worker/email.ts). Account emails (verification codes,
 * sign-in alerts) are composed here because they contain no workspace data.
 */
import { emailConfigured, escapeHtml, sendMails, type Mail, type SmtpEnv } from './email';
import { newBackupCodes, newTotpSecret, normBackup, otpauthUrl, verifyTotp } from './totp';

interface Env extends SmtpEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  FILES?: R2Bucket;
  PBKDF2_ITERATIONS: string;
  /** Optional: lets /api/apps read releases while the GitHub repository is private. */
  GITHUB_TOKEN?: string;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface User { id: string; email: string; name: string; color: string; emailVerified: boolean; totpEnabled: boolean }
/** Per-request context: the raw request (for IP / location) and waitUntil for background email. */
interface Ctx { req: Request; env: Env; exec: ExecutionContext }

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const SESSION_DAYS = 30;
const MFA_SESSION_MS = 10 * 60_000;
const PULL_LIMIT = 500;
const MAX_BODY = 4 * 1024 * 1024;
/** One synced object (a task with its comments, a doc…). D1 rows are capped at 1 MB anyway. */
const MAX_RECORD = 900 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const MAX_FILES_PER_WORKSPACE = 2 * 1024 * 1024 * 1024;
const MAX_SHARE_BLOB = 200 * 1024;
const COOKIE = 'mkp_s';
const COLORS = ['#7B68EE', '#5B8DEF', '#3DBE7A', '#F0A33A', '#E5484D', '#D6409F', '#12B5CB', '#8E5CF7'];

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route({ req, env, exec }, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- routing

async function route(c: Ctx, url: URL): Promise<Response> {
  const { req, env } = c;
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (p === '/api/health') return json({ ok: true });
  if (p === '/api/auth/signup' && m === 'POST') return signup(c);
  if (p === '/api/auth/login' && m === 'POST') return login(c);
  if (p === '/api/auth/recover' && m === 'POST') return recoverStart(c);

  // Public supplier links: no account, rate-limited, ciphertext only.
  const share = p.match(/^\/api\/share\/([0-9A-Fa-f-]{36})(\/reply)?$/);
  if (share && !share[2] && m === 'GET') return shareGet(c, share[1].toUpperCase());
  if (share && share[2] && m === 'POST') return shareReply(c, share[1].toUpperCase());

  const { user, tokenHash, kind } = await authenticate(c);
  if (p === '/api/auth/logout' && m === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }
  if (p === '/api/auth/mfa' && m === 'POST') return mfaFinish(c, user, tokenHash, kind);
  if (p === '/api/auth/recover/finish' && m === 'POST') return recoverFinish(c, user, tokenHash, kind);
  if (kind === 'mfa') throw new HttpError(403, 'Enter your two-factor code first', { mfa: true });
  if (kind !== 'normal') throw new HttpError(403, 'Finish account recovery first');

  if (p === '/api/auth/verify' && m === 'POST') return verifyEmail(c, user);
  if (p === '/api/auth/verify/resend' && m === 'POST') return resendVerification(c, user);
  if (p === '/api/auth/password' && m === 'POST') return changePassword(c, user, tokenHash);
  if (p === '/api/auth/sessions' && m === 'GET') return listSessions(env, user, tokenHash);
  if (p === '/api/auth/sessions' && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, tokenHash).run();
    await logEvent(c, { userId: user.id, actorId: user.id, type: 'sessions_revoked_all', detail: 'Signed out of all other devices' });
    return json({ ok: true });
  }
  const sess = p.match(/^\/api\/auth\/sessions\/([A-Za-z0-9_-]{8,64})$/);
  if (sess && m === 'DELETE') return revokeSession(c, user, sess[1], tokenHash);
  if (p === '/api/me' && m === 'GET') return me(env, user);
  if (p === '/api/me' && m === 'PATCH') return updateMe(req, env, user);
  if (p === '/api/me' && m === 'DELETE') return deleteAccount(c, user);
  if (p === '/api/me/keys' && m === 'PUT') return setKeys(req, env, user);
  if (p === '/api/me/recovery' && m === 'PUT') return setRecovery(req, env, user);
  if (p === '/api/me/notifications' && m === 'PUT') return setNotifyPrefs(req, env, user);
  if (p === '/api/me/notifications/test' && m === 'POST') return testEmail(env, user);
  if (p === '/api/me/totp/start' && m === 'POST') return totpStart(env, user);
  if (p === '/api/me/totp/enable' && m === 'POST') return totpEnable(c, user);
  if (p === '/api/me/totp/disable' && m === 'POST') return totpDisable(c, user);
  if (p === '/api/me/security' && m === 'GET') return securityLog(env, { userId: user.id });
  if (p === '/api/apps' && m === 'GET') return appDownloads(env, url);
  if (p === '/api/invites/accept' && m === 'POST') return acceptInvite(c, user);
  if (p === '/api/workspaces' && m === 'POST') return createWorkspace(c, user);

  const ws = p.match(/^\/api\/workspaces\/([0-9A-Fa-f-]{36})(\/.*)?$/);
  if (!ws) throw new HttpError(404, 'Not found');
  const wsId = ws[1].toUpperCase();
  const sub = ws[2] ?? '';
  const wsRow = await env.DB.prepare('SELECT m.role, w.require_mfa, w.key_version, w.name, w.locked_at FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?')
    .bind(wsId, user.id).first<{ role: Role; require_mfa: number; key_version: number; name: string; locked_at: string | null }>();
  if (!wsRow) throw new HttpError(403, 'You are not a member of this workspace');
  const role = wsRow.role;
  // Panic mode: nobody but the owner gets in, whatever they ask for.
  if (wsRow.locked_at && role !== 'owner') {
    throw new HttpError(423, 'This workspace has been locked by its owner. Nobody can open it until the owner unlocks it.', { locked: true, lockedAt: wsRow.locked_at });
  }
  if (wsRow.require_mfa && !user.totpEnabled) {
    throw new HttpError(403, 'This workspace requires two-factor sign-in. Turn it on under Team & account › Your security, then try again.', { mfaRequired: true });
  }

  if (sub === '/sync' && m === 'POST') return sync(req, env, wsId, user, role, wsRow.key_version);
  if (sub === '/keys' && m === 'POST') return addKeys(c, wsId, user, role);
  if (sub === '/team' && m === 'GET') return team(env, wsId, role);
  if (sub === '/notify' && m === 'POST') return notify(req, env, wsId, user, role);
  if (sub === '/security' && m === 'GET') { requireAdmin(role); return securityLog(env, { wsId }); }
  if (sub === '/transfer' && m === 'POST') return transferOwnership(c, wsId, user, role);
  if (sub === '/lock' && m === 'POST') return setLock(c, wsId, user, role);
  if (sub === '' && m === 'DELETE') return deleteWorkspace(c, wsId, user, role);
  if (sub === '' && m === 'PATCH') {
    requireAdmin(role);
    const b = await body<{ name?: string; requireMfa?: boolean }>(req);
    if (typeof b.name === 'string') {
      await env.DB.prepare('UPDATE workspaces SET name = ? WHERE id = ?').bind(str(b.name, 120), wsId).run();
      await logEvent(c, { wsId, actorId: user.id, type: 'workspace_renamed', detail: `Renamed to "${str(b.name, 120)}"` });
    }
    if (typeof b.requireMfa === 'boolean') {
      if (role !== 'owner') throw new HttpError(403, 'Only the owner can change the two-factor requirement');
      if (b.requireMfa && !user.totpEnabled) throw new HttpError(409, 'Turn on two-factor sign-in for your own account first');
      await env.DB.prepare('UPDATE workspaces SET require_mfa = ? WHERE id = ?').bind(b.requireMfa ? 1 : 0, wsId).run();
      await logEvent(c, { wsId, actorId: user.id, type: 'require_mfa_changed', detail: b.requireMfa ? 'Two-factor sign-in now required for everyone' : 'Two-factor requirement removed' });
    }
    return json({ ok: true });
  }
  if (sub === '/invites' && m === 'POST') {
    requireAdmin(role);
    requireVerified(user);
    const b = await body<{ email: string; role: Role }>(req);
    const email = normEmail(b.email);
    const r = oneOf(b.role, ['admin', 'member', 'viewer']);
    if (r === 'admin' && role !== 'owner') throw new HttpError(403, 'Only the owner can invite admins');
    const code = inviteCode();
    const expires = new Date(Date.now() + 14 * 86400_000).toISOString();
    await env.DB.prepare('INSERT OR REPLACE INTO invites (workspace_id, email, role, invited_by, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(wsId, email, r, user.id, await sha256(normCode(code)), expires).run();
    await logEvent(c, { wsId, actorId: user.id, type: 'invite_created', detail: `Invited ${email} as ${r}` });
    // The code is shown once to the admin, who passes it to the teammate.
    return json({ code, expiresAt: expires });
  }
  const inv = sub.match(/^\/invites\/(.+)$/);
  if (inv && m === 'DELETE') {
    requireAdmin(role);
    const email = decodeURIComponent(inv[1]);
    await env.DB.prepare('DELETE FROM invites WHERE workspace_id = ? AND email = ?').bind(wsId, email).run();
    await logEvent(c, { wsId, actorId: user.id, type: 'invite_cancelled', detail: `Cancelled invite for ${email}` });
    return json({ ok: true });
  }
  const mem = sub.match(/^\/members\/([0-9A-Fa-f-]{36})(\/role|\/password)?$/);
  if (mem) {
    const target = mem[1].toUpperCase();
    const targetRole = await roleOf(env, wsId, target);
    if (!targetRole) throw new HttpError(404, 'Member not found');
    const targetName = (await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(target).first<{ email: string }>())?.email ?? target;
    if (mem[2] === '/role' && m === 'POST') {
      const r = oneOf((await body<{ role: string }>(req)).role, ['admin', 'member', 'viewer']);
      if (targetRole === 'owner') throw new HttpError(403, 'The owner role cannot be changed');
      if (role !== 'owner' && (r === 'admin' || targetRole === 'admin' || role !== 'admin')) throw new HttpError(403, 'Not allowed');
      await env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind(r, wsId, target).run();
      await logEvent(c, { wsId, userId: target, actorId: user.id, type: 'role_changed', detail: `${targetName}: ${targetRole} → ${r}` });
      return json({ ok: true });
    }
    if (mem[2] === '/password' && m === 'POST') {
      // Admin reset. The admin's client picks a temporary password and sends only its auth key.
      // The member's key pair is discarded (it was locked with the old password); teammates
      // re-share the workspace key once they sign in and create a new one.
      // An account is global, so the reset is only allowed when this workspace is the person's only
      // one: otherwise an admin here could sign in as them and be handed keys to other workspaces.
      // Two-factor stays on, so the temporary password alone never opens the account.
      requireAdmin(role);
      if (target === user.id) throw new HttpError(400, 'Change your own password under Your security instead');
      if (targetRole === 'owner') throw new HttpError(403, 'The owner resets their own password with their recovery code');
      if (targetRole === 'admin' && role !== 'owner') throw new HttpError(403, 'Only the owner can reset an admin\'s password');
      const elsewhere = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND workspace_id != ?').bind(target, wsId).first<{ n: number }>();
      if ((elsewhere?.n ?? 0) > 0) {
        throw new HttpError(409, `${targetName} also belongs to other workspaces, so their password can't be reset from here. Ask them to use their recovery code, or to reset it from a workspace they belong to alone.`);
      }
      await rateLimit(env, `admin-reset:${user.id}`, 10, 3600);
      const { authKey } = await body<{ authKey: string }>(req);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, pw_iter = 0, public_key = NULL, enc_private_key = NULL, rec_hash = NULL, rec_salt = NULL, enc_private_key_rec = NULL WHERE id = ?')
          .bind(await authHash(checkAuthKey(authKey), salt), salt, target),
        env.DB.prepare('DELETE FROM workspace_keys WHERE user_id = ?').bind(target),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target),
      ]);
      await logEvent(c, { wsId, userId: target, actorId: user.id, type: 'password_reset_admin', detail: `Password reset for ${targetName}` });
      const t = await env.DB.prepare('SELECT email, name FROM users WHERE id = ?').bind(target).first<{ email: string; name: string }>();
      if (t && emailConfigured(env)) {
        background(c, sendMails(env, 'MK Prod', [renderMail(t.email, t.name, 'Your password was reset by an admin', [
          `${user.name || user.email} reset your MK Prod password from the workspace "${wsRow.name}" and signed out all your devices.`,
          'They will give you a temporary password. Sign in with it and change it straight away. Your two-factor sign-in is unchanged.',
          'If you did not expect this, contact the workspace owner.',
        ], '')]));
      }
      return json({ ok: true });
    }
    if (!mem[2] && m === 'DELETE') {
      if (target !== user.id) requireAdmin(role);
      if (targetRole === 'owner') throw new HttpError(403, 'The owner cannot be removed. Transfer ownership first.');
      if (targetRole === 'admin' && role !== 'owner' && target !== user.id) throw new HttpError(403, 'Not allowed');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
        env.DB.prepare('DELETE FROM presence WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
        env.DB.prepare('DELETE FROM workspace_keys WHERE workspace_id = ? AND user_id = ?').bind(wsId, target),
      ]);
      await logEvent(c, { wsId, userId: target, actorId: user.id, type: target === user.id ? 'member_left' : 'member_removed', detail: target === user.id ? `${targetName} left` : `Removed ${targetName}` });
      return json({ ok: true });
    }
  }
  const sh = sub.match(/^\/shares(\/([0-9A-Fa-f-]{36}))?$/);
  if (sh && !sh[2] && m === 'POST') return shareCreate(c, wsId, user, role);
  if (sh && !sh[2] && m === 'GET') return shareList(env, wsId, url.searchParams.get('ref'));
  if (sh && sh[2] && m === 'DELETE') return shareDelete(c, wsId, user, role, sh[2].toUpperCase());
  const file = sub.match(/^\/files\/([0-9A-Fa-f-]{36})$/);
  if (file && m === 'PUT') return fileUpload(c, wsId, user, role, file[1].toUpperCase(), wsRow.key_version);
  if (file && m === 'GET') return fileDownload(env, wsId, file[1].toUpperCase());
  if (file && m === 'DELETE') return fileDelete(c, wsId, user, role, file[1].toUpperCase());
  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- auth

interface UserRow extends Omit<User, 'emailVerified' | 'totpEnabled'> {
  pw_hash: string; pw_salt: string; pw_iter: number; pw_scheme: number
  public_key: string | null; enc_private_key: string | null
  email_verified: number; totp_enabled: number; totp_secret: string | null; totp_recovery: string | null
  rec_hash: string | null; notify_prefs: string | null
}

function publicUser(u: UserRow) {
  return {
    id: u.id, email: u.email, name: u.name, color: u.color,
    publicKey: u.public_key, encPrivateKey: u.enc_private_key,
    emailVerified: !!u.email_verified, totpEnabled: !!u.totp_enabled,
  };
}

async function signup(c: Ctx): Promise<Response> {
  const { req, env } = c;
  await rateLimit(env, `signup:${ip(req)}`, 10, 3600);
  const b = await body<{ email: string; authKey: string; name?: string; publicKey?: string; encPrivateKey?: string; wantToken?: boolean }>(req);
  const email = normEmail(b.email);
  const authKey = checkAuthKey(b.authKey);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
  const id = crypto.randomUUID().toUpperCase();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const name = str(b.name || email.split('@')[0], 80);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  // Without a mail server there is no way to verify, so accounts count as verified.
  const needsVerification = emailConfigured(env);
  await env.DB.prepare(
    'INSERT INTO users (id, email, name, color, pw_hash, pw_salt, pw_iter, pw_scheme, public_key, enc_private_key, email_verified) VALUES (?, ?, ?, ?, ?, ?, 0, 2, ?, ?, ?)',
  ).bind(id, email, name, color, await authHash(authKey, salt), salt, keyField(b.publicKey, 120), keyField(b.encPrivateKey, 200), needsVerification ? 0 : 1).run();
  const token = await newSession(c, id);
  await logEvent(c, { userId: id, actorId: id, type: 'signup', detail: 'Account created' });
  if (needsVerification) await sendVerification(c, id, email, name);
  const user = { id, email, name, color, publicKey: b.publicKey ?? null, encPrivateKey: b.encPrivateKey ?? null, emailVerified: !needsVerification, totpEnabled: false };
  return json(b.wantToken ? { token, user, needsVerification } : { user, needsVerification }, 200, { 'Set-Cookie': cookie(token) });
}

async function sendVerification(c: Ctx, userId: string, email: string, name: string) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  await c.env.DB.prepare('UPDATE users SET verify_hash = ?, verify_expires = ? WHERE id = ?').bind(await sha256(`verify:${userId}:${code}`), expires, userId).run();
  background(c, sendMails(c.env, 'MK Prod', [renderMail(email, name, 'Your verification code',
    [`Your MK Prod verification code is: ${code}`, 'It is valid for 30 minutes. Enter it in the app to confirm this email address.'],
    'If you did not create an MK Prod account, you can ignore this email.')]));
}

async function verifyEmail(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  if (user.emailVerified) return json({ ok: true });
  await rateLimit(env, `verify:${user.id}`, 10, 900);
  const { code } = await body<{ code: string }>(req);
  const row = await env.DB.prepare('SELECT verify_hash, verify_expires FROM users WHERE id = ?').bind(user.id).first<{ verify_hash: string | null; verify_expires: string | null }>();
  const ok = row?.verify_hash && row.verify_expires && row.verify_expires > new Date().toISOString()
    && timingSafeEqual(await sha256(`verify:${user.id}:${String(code ?? '').replace(/\D/g, '')}`), row.verify_hash);
  if (!ok) throw new HttpError(400, 'That code is not right or has expired. Request a new one.');
  await env.DB.prepare('UPDATE users SET email_verified = 1, verify_hash = NULL, verify_expires = NULL WHERE id = ?').bind(user.id).run();
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'email_verified', detail: `Verified ${user.email}` });
  return json({ ok: true });
}

async function resendVerification(c: Ctx, user: User): Promise<Response> {
  if (user.emailVerified) return json({ ok: true });
  if (!emailConfigured(c.env)) {
    await c.env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  await rateLimit(c.env, `resend:${user.id}`, 5, 3600);
  await sendVerification(c, user.id, user.email, user.name);
  return json({ ok: true });
}

function requireVerified(user: User) {
  if (!user.emailVerified) throw new HttpError(403, 'Confirm your email address first (check your inbox for the code).', { needsVerification: true });
}

async function login(c: Ctx): Promise<Response> {
  const { req, env } = c;
  const b = await body<{ email: string; authKey: string; password?: string; wantToken?: boolean }>(req);
  const email = normEmail(b.email);
  await rateLimit(env, `login-ip:${ip(req)}`, 60, 900);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, since).first<{ n: number }>();
  if ((fails?.n ?? 0) >= 8) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  const authKey = checkAuthKey(b.authKey);
  let ok = false;
  if (u?.pw_scheme === 2) {
    ok = timingSafeEqual(await authHash(authKey, u.pw_salt), u.pw_hash);
  } else if (u) {
    // Account created before client-side stretching: verify the raw password once, then upgrade.
    if (typeof b.password !== 'string') throw new HttpError(409, 'Account upgrade needed', { legacy: true });
    ok = timingSafeEqual(await pbkdf2(b.password, u.pw_salt, u.pw_iter), u.pw_hash);
    if (ok) {
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, pw_iter = 0 WHERE id = ?').bind(await authHash(authKey, salt), salt, u.id).run();
    }
  }
  if (!u || !ok) {
    await env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, new Date().toISOString()).run();
    if (u) await logEvent(c, { userId: u.id, type: 'signin_failed', detail: 'Wrong password' });
    throw new HttpError(401, 'Invalid email or password');
  }
  // Housekeeping on every successful login: expired sessions and stale throttling rows.
  // login_failures and rate_events hold email addresses and IPs, so they are not kept beyond their use.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_failures WHERE email = ? OR at < ?').bind(email, new Date(Date.now() - 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()),
    env.DB.prepare('DELETE FROM rate_events WHERE at < ?').bind(new Date(Date.now() - 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM notify_log WHERE sent_at < ?').bind(new Date(Date.now() - 180 * 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM presence WHERE last_seen < ?').bind(new Date(Date.now() - 7 * 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM security_events WHERE at < ?').bind(new Date(Date.now() - 365 * 86400_000).toISOString()),
    env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(new Date(Date.now() - 30 * 86400_000).toISOString()),
  ]);
  if (u.totp_enabled) {
    // Password is right; the second factor comes in POST /api/auth/mfa with this short-lived token.
    const mfaToken = await newSession(c, u.id, 'mfa', MFA_SESSION_MS);
    return json({ mfa: true, mfaToken });
  }
  return await finishLogin(c, u, !!b.wantToken);
}

/** Creates the real session, logs it, and emails a sign-in alert if the person wants them. */
async function finishLogin(c: Ctx, u: UserRow, wantToken: boolean): Promise<Response> {
  const token = await newSession(c, u.id);
  const where = describeClient(c);
  await logEvent(c, { userId: u.id, actorId: u.id, type: 'signin', detail: `Signed in from ${where.client}${where.location ? ` (${where.location})` : ''}` });
  const prefs = prefsOf(u.notify_prefs);
  if (prefs.email && prefs.signInAlerts && emailConfigured(c.env)) {
    background(c, sendMails(c.env, 'MK Prod', [renderMail(u.email, u.name, 'New sign-in to your account', [
      `Your MK Prod account was just signed in to from ${where.client}${where.location ? ` near ${where.location}` : ''}.`,
      `Time: ${new Date().toUTCString()}. Approximate network address: ${where.ip}.`,
      'If this was you, there is nothing to do. If not, change your password now and use "Sign out other devices" under Team & account.',
    ], 'You can turn these alerts off in MK Prod › Settings › Notifications.')]));
  }
  // Browsers get only the HttpOnly cookie; native apps ask for the token to keep in their keychain.
  return json(wantToken ? { token, user: publicUser(u) } : { user: publicUser(u) }, 200, { 'Set-Cookie': cookie(token) });
}

async function mfaFinish(c: Ctx, user: User, tokenHash: string, kind: string): Promise<Response> {
  const { req, env } = c;
  if (kind !== 'mfa') throw new HttpError(403, 'Not a two-factor session');
  await rateLimit(env, `mfa:${user.id}`, 10, 900);
  const b = await body<{ code: string; wantToken?: boolean }>(req);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>();
  if (!u?.totp_secret) throw new HttpError(409, 'Two-factor is not set up');
  if (!(await checkSecondFactor(env, u, b.code))) {
    await logEvent(c, { userId: u.id, type: 'signin_mfa_failed', detail: 'Wrong two-factor code' });
    throw new HttpError(401, 'That code is not right. Codes change every 30 seconds.');
  }
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  return await finishLogin(c, u, !!b.wantToken);
}

/** Authenticator code, or one of the backup codes (which is then used up). */
async function checkSecondFactor(env: Env, u: UserRow, code: unknown): Promise<boolean> {
  const s = String(code ?? '').trim();
  if (!u.totp_secret) return false;
  if (await verifyTotp(u.totp_secret, s)) return true;
  const hashes: string[] = u.totp_recovery ? JSON.parse(u.totp_recovery) : [];
  const h = await sha256(`backup:${u.id}:${normBackup(s)}`);
  const i = hashes.indexOf(h);
  if (i < 0) return false;
  hashes.splice(i, 1);
  await env.DB.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').bind(JSON.stringify(hashes), u.id).run();
  return true;
}

async function totpStart(env: Env, user: User): Promise<Response> {
  if (user.totpEnabled) throw new HttpError(409, 'Two-factor sign-in is already on');
  const secret = newTotpSecret();
  await env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, user.id).run();
  return json({ secret, url: otpauthUrl(secret, user.email) });
}

async function totpEnable(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  if (user.totpEnabled) throw new HttpError(409, 'Two-factor sign-in is already on');
  await rateLimit(env, `totp-enable:${user.id}`, 10, 900);
  const { code } = await body<{ code: string }>(req);
  const row = await env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user.id).first<{ totp_secret: string | null }>();
  if (!row?.totp_secret) throw new HttpError(409, 'Start the set-up first');
  if (!(await verifyTotp(row.totp_secret, String(code ?? '')))) throw new HttpError(400, 'That code is not right. Scan the QR code again and enter the current 6 digits.');
  const codes = newBackupCodes();
  const hashes = await Promise.all(codes.map((x) => sha256(`backup:${user.id}:${normBackup(x)}`)));
  await env.DB.prepare('UPDATE users SET totp_enabled = 1, totp_recovery = ? WHERE id = ?').bind(JSON.stringify(hashes), user.id).run();
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'totp_enabled', detail: 'Two-factor sign-in turned on' });
  return json({ ok: true, backupCodes: codes });
}

async function totpDisable(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  await rateLimit(env, `totp-disable:${user.id}`, 10, 900);
  const b = await body<{ authKey: string; code: string }>(req);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>();
  if (!u || !timingSafeEqual(await authHash(checkAuthKey(b.authKey), u.pw_salt), u.pw_hash)) throw new HttpError(401, 'Password is incorrect');
  if (u.totp_enabled && !(await checkSecondFactor(env, u, b.code))) throw new HttpError(401, 'That two-factor code is not right');
  await env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL WHERE id = ?').bind(user.id).run();
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'totp_disabled', detail: 'Two-factor sign-in turned off' });
  return json({ ok: true });
}

async function changePassword(c: Ctx, user: User, tokenHash: string): Promise<Response> {
  const { req, env } = c;
  const b = await body<{ currentAuthKey: string; newAuthKey: string; encPrivateKey: string }>(req);
  const row = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(user.id).first<{ pw_hash: string; pw_salt: string }>();
  if (!row || !timingSafeEqual(await authHash(checkAuthKey(b.currentAuthKey), row.pw_salt), row.pw_hash)) {
    throw new HttpError(401, 'Current password is incorrect');
  }
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, enc_private_key = ? WHERE id = ?')
      .bind(await authHash(checkAuthKey(b.newAuthKey), salt), salt, keyField(b.encPrivateKey, 200), user.id),
    // Keep this session, sign out everywhere else.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, tokenHash),
  ]);
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'password_changed', detail: 'Password changed; other devices signed out' });
  return json({ ok: true });
}

/** First key pair for an account (new account, legacy account, or after an admin reset). */
async function setKeys(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ publicKey: string; encPrivateKey: string }>(req);
  const cur = await env.DB.prepare('SELECT public_key FROM users WHERE id = ?').bind(user.id).first<{ public_key: string | null }>();
  if (cur?.public_key) throw new HttpError(409, 'This account already has encryption keys');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET public_key = ?, enc_private_key = ? WHERE id = ?').bind(keyField(b.publicKey, 120), keyField(b.encPrivateKey, 200), user.id),
    env.DB.prepare('DELETE FROM workspace_keys WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true });
}

async function setRecovery(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ recAuth: string; encPrivateKeyRec: string }>(req);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('UPDATE users SET rec_hash = ?, rec_salt = ?, enc_private_key_rec = ? WHERE id = ?')
    .bind(await authHash(checkAuthKey(b.recAuth), salt), salt, keyField(b.encPrivateKeyRec, 200), user.id).run();
  return json({ ok: true });
}

/** Step 1 of recovery: prove the recovery code, receive the recovery-wrapped private key. */
async function recoverStart(c: Ctx): Promise<Response> {
  const { req, env } = c;
  await rateLimit(env, `recover:${ip(req)}`, 10, 3600);
  const b = await body<{ email: string; recAuth: string }>(req);
  const email = normEmail(b.email);
  const u = await env.DB.prepare('SELECT id, rec_hash, rec_salt, enc_private_key_rec FROM users WHERE email = ?')
    .bind(email).first<{ id: string; rec_hash: string | null; rec_salt: string | null; enc_private_key_rec: string | null }>();
  const ok = u?.rec_hash && u.rec_salt && timingSafeEqual(await authHash(checkAuthKey(b.recAuth), u.rec_salt), u.rec_hash);
  if (!u || !ok) {
    await env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, new Date().toISOString()).run();
    throw new HttpError(401, 'Recovery code is incorrect');
  }
  const token = await newSession(c, u.id, 'recovery', 15 * 60_000);
  return json({ token, encPrivateKeyRec: u.enc_private_key_rec });
}

/** Step 2: set a new password (and the private key re-locked with it). */
async function recoverFinish(c: Ctx, user: User, tokenHash: string, kind: string): Promise<Response> {
  const { req, env } = c;
  if (kind !== 'recovery') throw new HttpError(403, 'Not a recovery session');
  const b = await body<{ newAuthKey: string; encPrivateKey: string; wantToken?: boolean }>(req);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_scheme = 2, pw_hash = ?, pw_salt = ?, enc_private_key = ? WHERE id = ?')
      .bind(await authHash(checkAuthKey(b.newAuthKey), salt), salt, keyField(b.encPrivateKey, 200), user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  void tokenHash;
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'recovery_used', detail: 'Password reset with recovery code; all devices signed out' });
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first<UserRow>();
  return await finishLogin(c, u!, !!b.wantToken);
}

async function authenticate(c: Ctx): Promise<{ user: User; tokenHash: string; kind: string }> {
  const { req, env } = c;
  let token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) {
    token = readCookie(req, COOKIE) ?? '';
    // Cookie sessions must come from our own page: block cross-site form posts (CSRF).
    if (token && req.method !== 'GET' && req.headers.get('X-MKProd') !== '1') throw new HttpError(403, 'Missing request header');
  }
  if (!token) throw new HttpError(401, 'Sign in required');
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const u = await env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.color, u.email_verified, u.totp_enabled, s.kind, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(tokenHash, now).first<{ id: string; email: string; name: string; color: string; email_verified: number; totp_enabled: number; kind: string; last_used: string | null }>();
  if (!u) throw new HttpError(401, 'Your session expired. Please sign in again.');
  // "Last used" for the devices list, written at most every 10 minutes to stay within D1's free writes.
  if (!u.last_used || u.last_used < new Date(Date.now() - 10 * 60_000).toISOString()) {
    c.exec.waitUntil(env.DB.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').bind(now, tokenHash).run());
  }
  return { user: { id: u.id, email: u.email, name: u.name, color: u.color, emailVerified: !!u.email_verified, totpEnabled: !!u.totp_enabled }, tokenHash, kind: u.kind };
}

async function newSession(c: Ctx, userId: string, kind = 'normal', ttlMs = SESSION_DAYS * 86400_000): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const where = describeClient(c);
  const now = new Date().toISOString();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, kind, id, client, ip, location, last_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, expires, kind, b64url(crypto.getRandomValues(new Uint8Array(12))), where.client, where.ip, where.location, now, now).run();
  return token;
}

async function listSessions(env: Env, user: User, tokenHash: string): Promise<Response> {
  const rows = (await env.DB.prepare(
    "SELECT COALESCE(id, substr(token_hash, 1, 16)) AS id, client, ip, location, COALESCE(created_at, last_used) AS created_at, last_used, token_hash = ? AS current FROM sessions WHERE user_id = ? AND kind = 'normal' AND expires_at > ? ORDER BY last_used DESC",
  ).bind(tokenHash, user.id, new Date().toISOString()).all()).results;
  return json({ sessions: rows.map((r) => ({ ...r, current: !!r.current })) });
}

async function revokeSession(c: Ctx, user: User, id: string, tokenHash: string): Promise<Response> {
  const r = await c.env.DB.prepare("SELECT token_hash, client FROM sessions WHERE user_id = ? AND (id = ? OR substr(token_hash, 1, 16) = ?)").bind(user.id, id, id).first<{ token_hash: string; client: string | null }>();
  if (!r) throw new HttpError(404, 'Device not found');
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(r.token_hash).run();
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'session_revoked', detail: `Signed out ${r.client ?? 'a device'}` });
  return json({ ok: true }, 200, r.token_hash === tokenHash ? { 'Set-Cookie': clearCookie() } : {});
}

async function acceptInvite(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  requireVerified(user);
  await rateLimit(env, `invite:${user.id}`, 20, 3600);
  const { code } = await body<{ code: string }>(req);
  const inv = await env.DB.prepare('SELECT workspace_id, role, expires_at FROM invites WHERE email = ? AND code_hash = ?')
    .bind(user.email.toLowerCase(), await sha256(normCode(code))).first<{ workspace_id: string; role: Role; expires_at: string | null }>();
  if (!inv) throw new HttpError(404, 'That invite code is not valid for your email address');
  if (inv.expires_at && inv.expires_at < new Date().toISOString()) throw new HttpError(410, 'This invite has expired. Ask for a new one.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO members (workspace_id, user_id, role) VALUES (?, ?, ?)').bind(inv.workspace_id, user.id, inv.role),
    env.DB.prepare('DELETE FROM invites WHERE workspace_id = ? AND email = ?').bind(inv.workspace_id, user.email.toLowerCase()),
  ]);
  await logEvent(c, { wsId: inv.workspace_id, userId: user.id, actorId: user.id, type: 'invite_accepted', detail: `${user.email} joined as ${inv.role}` });
  const w = await env.DB.prepare('SELECT id, name FROM workspaces WHERE id = ?').bind(inv.workspace_id).first<{ id: string; name: string }>();
  return json({ workspace: { ...w, role: inv.role } });
}

// ---------------------------------------------------------------- profile & workspaces

async function me(env: Env, user: User): Promise<Response> {
  const [ws, u] = await env.DB.batch([
    env.DB.prepare('SELECT w.id, w.name, m.role, w.require_mfa AS requireMfa, w.locked_at AS lockedAt FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at').bind(user.id),
    env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id),
  ]);
  const row = u.results[0] as unknown as UserRow;
  return json({
    user: { ...publicUser(row), hasRecovery: !!row.rec_hash, notifyPrefs: prefsOf(row.notify_prefs), backupCodesLeft: row.totp_recovery ? (JSON.parse(row.totp_recovery) as string[]).length : 0 },
    workspaces: (ws.results as { requireMfa: number; lockedAt: string | null }[]).map((w) => ({ ...w, requireMfa: !!w.requireMfa, locked: !!w.lockedAt })), emailEnabled: emailConfigured(env), filesEnabled: !!env.FILES,
  });
}

async function updateMe(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<{ name?: string; color?: string }>(req);
  const name = b.name !== undefined ? str(b.name, 80) : user.name;
  const color = b.color && /^#[0-9A-Fa-f]{6}$/.test(b.color) ? b.color : user.color;
  await env.DB.prepare('UPDATE users SET name = ?, color = ? WHERE id = ?').bind(name, color, user.id).run();
  return json({ user: { ...user, name, color } });
}

/** Right to erasure: removes the account and every workspace only this person could own. */
async function deleteAccount(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  const b = await body<{ authKey: string }>(req);
  const u = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(user.id).first<{ pw_hash: string; pw_salt: string }>();
  if (!u || !timingSafeEqual(await authHash(checkAuthKey(b.authKey), u.pw_salt), u.pw_hash)) throw new HttpError(401, 'Password is incorrect');
  const owned = (await env.DB.prepare(`
    SELECT w.id, w.name, (SELECT COUNT(*) FROM members x WHERE x.workspace_id = w.id) AS n
    FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner'`).bind(user.id).all()).results as { id: string; name: string; n: number }[];
  const blocking = owned.filter((w) => w.n > 1);
  if (blocking.length) {
    throw new HttpError(409, `You own workspaces with other members: ${blocking.map((w) => w.name).join(', ')}. Transfer ownership or delete them first.`, { workspaces: blocking.map((w) => w.id) });
  }
  for (const w of owned) await wipeWorkspace(env, w.id);
  await env.DB.batch([
    // Workspaces this person created but no longer owns stay; their "created by" becomes the current owner.
    env.DB.prepare("UPDATE workspaces SET created_by = COALESCE((SELECT user_id FROM members WHERE workspace_id = workspaces.id AND role = 'owner' LIMIT 1), created_by) WHERE created_by = ?").bind(user.id),
    env.DB.prepare("UPDATE invites SET invited_by = COALESCE((SELECT user_id FROM members WHERE workspace_id = invites.workspace_id AND role = 'owner' LIMIT 1), invited_by) WHERE invited_by = ?").bind(user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM workspace_keys WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM presence WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(user.email),
    env.DB.prepare('DELETE FROM notify_log WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(user.email),
    env.DB.prepare('DELETE FROM security_events WHERE user_id = ? AND workspace_id IS NULL').bind(user.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

async function createWorkspace(c: Ctx, user: User): Promise<Response> {
  const { req, env } = c;
  requireVerified(user);
  const { name } = await body<{ name: string }>(req);
  const id = crypto.randomUUID().toUpperCase();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').bind(id, str(name || 'Workspace', 120), user.id),
    env.DB.prepare("INSERT INTO members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id),
    env.DB.prepare('INSERT INTO counters (workspace_id, seq) VALUES (?, 0)').bind(id),
  ]);
  await logEvent(c, { wsId: id, actorId: user.id, type: 'workspace_created', detail: `Created "${str(name || 'Workspace', 120)}"` });
  return json({ id });
}

async function deleteWorkspace(c: Ctx, wsId: string, user: User, role: Role): Promise<Response> {
  const { req, env } = c;
  if (role !== 'owner') throw new HttpError(403, 'Only the owner can delete a workspace');
  const b = await body<{ authKey: string }>(req);
  const u = await env.DB.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').bind(user.id).first<{ pw_hash: string; pw_salt: string }>();
  if (!u || !timingSafeEqual(await authHash(checkAuthKey(b.authKey), u.pw_salt), u.pw_hash)) throw new HttpError(401, 'Password is incorrect');
  const name = (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(wsId).first<{ name: string }>())?.name ?? wsId;
  await wipeWorkspace(env, wsId);
  await logEvent(c, { userId: user.id, actorId: user.id, type: 'workspace_deleted', detail: `Deleted workspace "${name}"` });
  return json({ ok: true });
}

async function wipeWorkspace(env: Env, wsId: string) {
  if (env.FILES) {
    const files = (await env.DB.prepare('SELECT id FROM files WHERE workspace_id = ?').bind(wsId).all()).results as { id: string }[];
    for (let i = 0; i < files.length; i += 100) await env.FILES.delete(files.slice(i, i + 100).map((f) => `${wsId}/${f.id}`));
  }
  await env.DB.batch([
    'DELETE FROM records WHERE workspace_id = ?', 'DELETE FROM counters WHERE workspace_id = ?', 'DELETE FROM members WHERE workspace_id = ?',
    'DELETE FROM invites WHERE workspace_id = ?', 'DELETE FROM workspace_keys WHERE workspace_id = ?', 'DELETE FROM presence WHERE workspace_id = ?',
    'DELETE FROM notify_log WHERE workspace_id = ?', 'DELETE FROM share_replies WHERE share_id IN (SELECT id FROM shares WHERE workspace_id = ?)',
    'DELETE FROM shares WHERE workspace_id = ?', 'DELETE FROM files WHERE workspace_id = ?', 'DELETE FROM security_events WHERE workspace_id = ?',
    'DELETE FROM workspaces WHERE id = ?',
  ].map((q) => env.DB.prepare(q).bind(wsId)));
}

async function transferOwnership(c: Ctx, wsId: string, user: User, role: Role): Promise<Response> {
  const { req, env } = c;
  if (role !== 'owner') throw new HttpError(403, 'Only the owner can transfer ownership');
  const { userId } = await body<{ userId: string }>(req);
  const target = String(userId ?? '').toUpperCase();
  const t = await env.DB.prepare('SELECT m.role, u.email, u.public_key FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?')
    .bind(wsId, target).first<{ role: Role; email: string; public_key: string | null }>();
  if (!t) throw new HttpError(404, 'Member not found');
  if (target === user.id) throw new HttpError(400, 'You are already the owner');
  if (!t.public_key) throw new HttpError(409, 'That person has no encryption keys yet; ask them to sign in with a current app first');
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").bind(wsId, target),
    env.DB.prepare("UPDATE members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").bind(wsId, user.id),
  ]);
  await logEvent(c, { wsId, userId: target, actorId: user.id, type: 'owner_transferred', detail: `Ownership transferred to ${t.email}` });
  return json({ ok: true });
}

/**
 * Panic mode, owner only. Locking takes effect on the next request of every other member (they get
 * 423 and their apps stop syncing), disables supplier links, and signs everyone else out so open
 * sessions can't linger. Unlocking restores access; people sign in again as usual.
 */
async function setLock(c: Ctx, wsId: string, user: User, role: Role): Promise<Response> {
  if (role !== 'owner') throw new HttpError(403, 'Only the owner can lock or unlock the workspace');
  const { locked } = await body<{ locked: boolean }>(c.req);
  if (typeof locked !== 'boolean') throw new HttpError(400, 'locked must be true or false');
  const now = new Date().toISOString();
  if (locked) {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE workspaces SET locked_at = ?, locked_by = ? WHERE id = ?').bind(now, user.id, wsId),
      // Other members' sessions end too, unless they still need them for another workspace.
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM members WHERE workspace_id = ? AND user_id != ?)
        AND user_id NOT IN (SELECT user_id FROM members WHERE workspace_id != ?)`).bind(wsId, user.id, wsId),
    ]);
  } else {
    await c.env.DB.prepare('UPDATE workspaces SET locked_at = NULL, locked_by = NULL WHERE id = ?').bind(wsId).run();
  }
  await logEvent(c, { wsId, actorId: user.id, type: locked ? 'workspace_locked' : 'workspace_unlocked', detail: locked ? 'Panic mode on: workspace locked for everyone but the owner' : 'Panic mode off: workspace unlocked' });
  return json({ ok: true, lockedAt: locked ? now : null });
}

async function team(env: Env, wsId: string, role: Role): Promise<Response> {
  const [w, mem, inv] = await env.DB.batch([
    env.DB.prepare('SELECT name, key_version, require_mfa, locked_at FROM workspaces WHERE id = ?').bind(wsId),
    membersQuery(env, wsId),
    env.DB.prepare('SELECT email, role, expires_at FROM invites WHERE workspace_id = ? ORDER BY created_at').bind(wsId),
  ]);
  const wr = w.results[0] as { name: string; key_version: number; require_mfa: number; locked_at: string | null } | undefined;
  return json({
    name: wr?.name ?? '', keyVersion: wr?.key_version ?? 0, requireMfa: !!wr?.require_mfa, lockedAt: wr?.locked_at ?? null, role,
    members: mem.results,
    invites: role === 'owner' || role === 'admin' ? inv.results : [],
  });
}

function membersQuery(env: Env, wsId: string) {
  return env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.color, m.role, u.public_key AS publicKey, u.totp_enabled AS totpEnabled,
           EXISTS (SELECT 1 FROM workspace_keys k JOIN workspaces w ON w.id = k.workspace_id
                   WHERE k.workspace_id = m.workspace_id AND k.user_id = u.id AND k.version = w.key_version) AS hasKey
    FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.joined_at`).bind(wsId);
}

// ---------------------------------------------------------------- security log

interface EventInput { userId?: string; wsId?: string; actorId?: string; type: string; detail: string }

async function logEvent(c: Ctx, e: EventInput) {
  const where = describeClient(c);
  await c.env.DB.prepare('INSERT INTO security_events (id, at, user_id, workspace_id, actor_id, type, detail, ip, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID().toUpperCase(), new Date().toISOString(), e.userId ?? null, e.wsId ?? null, e.actorId ?? null, e.type, str(e.detail, 300), where.ip, where.location).run();
}

async function securityLog(env: Env, scope: { userId?: string; wsId?: string }): Promise<Response> {
  const q = scope.wsId
    ? env.DB.prepare('SELECT e.*, u.name AS actor_name FROM security_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.workspace_id = ? ORDER BY e.at DESC LIMIT 200').bind(scope.wsId)
    : env.DB.prepare('SELECT e.*, u.name AS actor_name FROM security_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.user_id = ? ORDER BY e.at DESC LIMIT 200').bind(scope.userId!);
  return json({ events: (await q.all()).results });
}

/** Human-readable device label and approximate location from the request. */
function describeClient(c: Ctx): { client: string; ip: string; location: string | null } {
  const ua = c.req.headers.get('User-Agent') ?? '';
  let client = 'Unknown device';
  if (/MKProd|CFNetwork/.test(ua)) client = 'Mac app';
  else {
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    client = os ? `${browser} on ${os}` : browser;
  }
  const cf = (c.req as Request & { cf?: { city?: string; country?: string } }).cf;
  const location = cf?.city && cf?.country ? `${cf.city}, ${cf.country}` : cf?.country ?? null;
  return { client, ip: ip(c.req), location };
}

/** Email and other slow work that must not delay or fail the response. */
function background(c: Ctx, p: Promise<unknown>) {
  c.exec.waitUntil(p.catch((e) => console.error('background task failed', e)));
}

// ---------------------------------------------------------------- workspace keys

/**
 * Share wrapped workspace keys. Any writer may share the *current* version with members who
 * lack it; starting a new version (first encryption or rotation) is admin-only and must
 * include the caller's own copy.
 */
async function addKeys(c: Ctx, wsId: string, user: User, role: Role): Promise<Response> {
  const { req, env } = c;
  const b = await body<{ version: number; wraps: { userId: string; wrapped: string }[] }>(req);
  const w = await env.DB.prepare('SELECT key_version FROM workspaces WHERE id = ?').bind(wsId).first<{ key_version: number }>();
  const current = w?.key_version ?? 0;
  const version = Number(b.version);
  if (!Array.isArray(b.wraps) || !b.wraps.length || b.wraps.length > 500) throw new HttpError(400, 'No keys');
  if (version === current + 1) {
    requireAdmin(role);
    if (!b.wraps.some((x) => x.userId?.toUpperCase() === user.id)) throw new HttpError(400, 'Include your own key');
  } else if (version !== current || current === 0) {
    throw new HttpError(409, 'Key version changed; sync and try again', { keyVersion: current });
  } else if (role === 'viewer') {
    throw new HttpError(403, 'Viewers cannot share keys');
  }
  const members = new Set(((await env.DB.prepare('SELECT user_id FROM members WHERE workspace_id = ?').bind(wsId).all()).results as { user_id: string }[]).map((r) => r.user_id));
  const stmts = b.wraps.filter((x) => members.has(String(x.userId).toUpperCase())).map((x) =>
    env.DB.prepare('INSERT OR IGNORE INTO workspace_keys (workspace_id, user_id, version, wrapped) VALUES (?, ?, ?, ?)')
      .bind(wsId, String(x.userId).toUpperCase(), version, keyField(x.wrapped, 400)));
  if (version === current + 1) stmts.push(env.DB.prepare('UPDATE workspaces SET key_version = ? WHERE id = ? AND key_version = ?').bind(version, wsId, current));
  await env.DB.batch(stmts);
  if (version === current + 1) await logEvent(c, { wsId, actorId: user.id, type: 'key_rotated', detail: current === 0 ? 'Workspace encrypted (key v1)' : `Encryption key rotated to v${version}` });
  return json({ ok: true, keyVersion: version });
}

// ---------------------------------------------------------------- sync

interface PushRecord { kind: string; id: string; data?: unknown; deleted?: boolean }

async function sync(req: Request, env: Env, wsId: string, user: User, role: Role, keyVersion: number): Promise<Response> {
  const b = await body<{ cursor?: number; push?: PushRecord[]; viewing?: string; client?: string }>(req);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const push = Array.isArray(b.push) ? b.push : [];

  if (push.length) {
    if (role === 'viewer') throw new HttpError(403, 'Viewers cannot make changes');
    const rows = push.map((r) => {
      if (typeof r.kind !== 'string' || !/^[a-zA-Z]{1,40}$/.test(r.kind)) throw new HttpError(400, 'Bad record kind');
      if (typeof r.id !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(r.id)) throw new HttpError(400, 'Bad record id');
      if (!r.deleted && keyVersion > 0) {
        // Once a workspace is encrypted, refuse plaintext (e.g. from an outdated client).
        const d = r.data as { enc?: unknown; v?: unknown } | undefined;
        if (!d || typeof d.enc !== 'string' || typeof d.v !== 'number') throw new HttpError(426, 'This workspace is end-to-end encrypted. Update the app.', { keyVersion });
        // Only the current key version, so members added after a rotation can read every record.
        if (d.v !== keyVersion) throw new HttpError(409, 'Encryption key changed; sync and try again', { keyVersion });
      }
      const d = r.deleted ? '{}' : JSON.stringify(r.data ?? {});
      if (d.length > MAX_RECORD) throw new HttpError(413, 'One item is too large to sync (over 900 KB). Attach big files instead of pasting them.');
      return { k: r.kind, i: r.id.toUpperCase(), d, x: r.deleted ? 1 : 0 };
    });
    // One transaction: assign consecutive sequence numbers and upsert every row.
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO records (workspace_id, kind, id, data, deleted, seq, updated_at, updated_by)
        SELECT ?1, j.value ->> 'k', j.value ->> 'i', j.value ->> 'd', j.value ->> 'x',
               (SELECT seq FROM counters WHERE workspace_id = ?1) + j.key + 1, ?2, ?3
        FROM json_each(?4) AS j WHERE true
        ON CONFLICT (workspace_id, kind, id) DO UPDATE SET
          data = excluded.data, deleted = excluded.deleted, seq = excluded.seq,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(wsId, now, user.id, JSON.stringify(rows)),
      env.DB.prepare('UPDATE counters SET seq = seq + ? WHERE workspace_id = ?').bind(rows.length, wsId),
    ]);
  }

  const cursor = Math.max(0, Number(b.cursor) || 0);
  const viewing = str(b.viewing ?? '', 200);
  const recent = new Date(Date.now() - 20_000).toISOString();
  const [recs, , pres, mem, keys] = await env.DB.batch([
    env.DB.prepare('SELECT kind, id, data, deleted, seq, updated_by FROM records WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(wsId, cursor, PULL_LIMIT),
    // Presence: write at most every 20 s unless what the user is viewing changed.
    env.DB.prepare(`
      INSERT INTO presence (workspace_id, user_id, viewing, client, last_seen) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET viewing = excluded.viewing, client = excluded.client, last_seen = excluded.last_seen
      WHERE presence.viewing != excluded.viewing OR presence.last_seen < ?6`).bind(wsId, user.id, viewing, str(b.client ?? '', 20), now, recent),
    env.DB.prepare('SELECT user_id, viewing, client, last_seen FROM presence WHERE workspace_id = ? AND last_seen > ?')
      .bind(wsId, new Date(Date.now() - 60_000).toISOString()),
    membersQuery(env, wsId),
    env.DB.prepare('SELECT version, wrapped FROM workspace_keys WHERE workspace_id = ? AND user_id = ? ORDER BY version').bind(wsId, user.id),
  ]);

  type Row = { kind: string; id: string; data: string; deleted: number; seq: number; updated_by: string };
  const rows = recs.results as Row[];
  // Splice stored JSON in directly instead of parsing and re-serializing it.
  const records = rows.map((r) =>
    `{"kind":${JSON.stringify(r.kind)},"id":${JSON.stringify(r.id)},"deleted":${r.deleted ? 'true' : 'false'},"seq":${r.seq},"updatedBy":${JSON.stringify(r.updated_by)},"data":${r.data}}`,
  );
  const next = rows.length ? rows[rows.length - 1].seq : cursor;
  const out = `{"cursor":${next},"more":${rows.length === PULL_LIMIT},"role":${JSON.stringify(role)},"keyVersion":${keyVersion},` +
    `"myKeys":${JSON.stringify(keys.results)},"members":${JSON.stringify(mem.results)},"presence":${JSON.stringify(pres.results)},"records":[${records.join(',')}]}`;
  return new Response(out, { headers: headers() });
}

// ---------------------------------------------------------------- supplier share links

async function shareCreate(c: Ctx, wsId: string, user: User, role: Role): Promise<Response> {
  const { req, env } = c;
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot create links');
  await rateLimit(env, `share-create:${user.id}`, 60, 3600);
  const b = await body<{ id?: string; kind: string; refId: string; label?: string; blob: string; allowReply?: boolean; days?: number }>(req);
  if (typeof b.kind !== 'string' || !/^[a-zA-Z]{1,40}$/.test(b.kind)) throw new HttpError(400, 'Bad kind');
  if (typeof b.refId !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(b.refId)) throw new HttpError(400, 'Bad reference');
  const blob = keyField(b.blob, MAX_SHARE_BLOB);
  if (!blob) throw new HttpError(400, 'Nothing to share');
  const days = Math.min(90, Math.max(1, Number(b.days) || 14));
  // The client chooses the id because it is bound into the ciphertext (AAD); random UUIDs can't collide in practice.
  const id = typeof b.id === 'string' && /^[0-9A-Fa-f-]{36}$/.test(b.id) ? b.id.toUpperCase() : crypto.randomUUID().toUpperCase();
  if (await env.DB.prepare('SELECT 1 FROM shares WHERE id = ?').bind(id).first()) throw new HttpError(409, 'That link already exists');
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + days * 86400_000).toISOString();
  await env.DB.prepare('INSERT INTO shares (id, workspace_id, kind, ref_id, label, blob, allow_reply, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, wsId, b.kind, b.refId.toUpperCase(), str(b.label ?? '', 120), blob, b.allowReply === false ? 0 : 1, user.id, now, expires).run();
  await logEvent(c, { wsId, actorId: user.id, type: 'share_created', detail: `Supplier link created for ${b.kind} (${str(b.label ?? '', 60) || b.refId.slice(0, 8)}), ${days} days` });
  return json({ id, expiresAt: expires });
}

async function shareList(env: Env, wsId: string, ref: string | null): Promise<Response> {
  const q = ref
    ? env.DB.prepare('SELECT id, kind, ref_id, label, allow_reply, created_by, created_at, expires_at, views FROM shares WHERE workspace_id = ? AND ref_id = ? ORDER BY created_at DESC').bind(wsId, ref.toUpperCase())
    : env.DB.prepare('SELECT id, kind, ref_id, label, allow_reply, created_by, created_at, expires_at, views FROM shares WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200').bind(wsId);
  const shares = (await q.all()).results as { id: string }[];
  const replies = shares.length
    ? (await env.DB.prepare(`SELECT id, share_id, blob, at FROM share_replies WHERE share_id IN (${shares.map(() => '?').join(',')}) ORDER BY at`).bind(...shares.map((s) => s.id)).all()).results as { share_id: string }[]
    : [];
  return json({ shares: shares.map((s) => ({ ...s, replies: replies.filter((r) => r.share_id === s.id) })) });
}

async function shareDelete(c: Ctx, wsId: string, user: User, role: Role, id: string): Promise<Response> {
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot revoke links');
  const r = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM share_replies WHERE share_id IN (SELECT id FROM shares WHERE id = ? AND workspace_id = ?)').bind(id, wsId),
    c.env.DB.prepare('DELETE FROM shares WHERE id = ? AND workspace_id = ?').bind(id, wsId),
  ]);
  if (r[1].meta.changes) await logEvent(c, { wsId, actorId: user.id, type: 'share_revoked', detail: `Supplier link ${id.slice(0, 8)} revoked` });
  return json({ ok: true });
}

async function shareGet(c: Ctx, id: string): Promise<Response> {
  await rateLimit(c.env, `share-get:${ip(c.req)}`, 120, 3600);
  const s = await c.env.DB.prepare('SELECT s.kind, s.label, s.blob, s.allow_reply, s.expires_at, w.locked_at FROM shares s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?').bind(id).first<{ kind: string; label: string; blob: string; allow_reply: number; expires_at: string; locked_at: string | null }>();
  if (!s || s.expires_at < new Date().toISOString()) throw new HttpError(404, 'This link has expired or was removed.');
  if (s.locked_at) throw new HttpError(423, 'This link is temporarily unavailable.');
  c.exec.waitUntil(c.env.DB.prepare('UPDATE shares SET views = views + 1 WHERE id = ?').bind(id).run());
  return json({ kind: s.kind, label: s.label, blob: s.blob, allowReply: !!s.allow_reply, expiresAt: s.expires_at });
}

async function shareReply(c: Ctx, id: string): Promise<Response> {
  await rateLimit(c.env, `share-reply:${ip(c.req)}`, 20, 3600);
  const s = await c.env.DB.prepare('SELECT allow_reply, expires_at, (SELECT COUNT(*) FROM share_replies WHERE share_id = shares.id) AS n, (SELECT locked_at FROM workspaces WHERE id = shares.workspace_id) AS locked_at FROM shares WHERE id = ?').bind(id).first<{ allow_reply: number; expires_at: string; n: number; locked_at: string | null }>();
  if (!s || s.expires_at < new Date().toISOString()) throw new HttpError(404, 'This link has expired or was removed.');
  if (s.locked_at) throw new HttpError(423, 'This link is temporarily unavailable.');
  if (!s.allow_reply) throw new HttpError(403, 'This link does not accept replies.');
  if (s.n >= 20) throw new HttpError(429, 'This link has received the maximum number of replies.');
  const { blob } = await body<{ blob: string }>(c.req);
  const b = keyField(blob, 20 * 1024);
  if (!b) throw new HttpError(400, 'Empty reply');
  await c.env.DB.prepare('INSERT INTO share_replies (id, share_id, blob, at) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID().toUpperCase(), id, b, new Date().toISOString()).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------- encrypted file attachments (R2)

function requireFiles(env: Env): R2Bucket {
  if (!env.FILES) throw new HttpError(503, 'File storage is not set up on this server yet (see CLOUD_SETUP.md).');
  return env.FILES;
}

async function fileUpload(c: Ctx, wsId: string, user: User, role: Role, id: string, keyVersion: number): Promise<Response> {
  const { req, env } = c;
  const bucket = requireFiles(env);
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot upload files');
  if (keyVersion === 0) throw new HttpError(409, 'Encrypt the workspace first (sync once from an admin app)');
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (!len || len > MAX_FILE) throw new HttpError(413, 'Files up to 25 MB can be attached');
  const v = Number(req.headers.get('X-Key-Version'));
  if (v !== keyVersion) throw new HttpError(409, 'Encryption key changed; sync and try again', { keyVersion });
  const used = (await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE workspace_id = ?').bind(wsId).first<{ n: number }>())?.n ?? 0;
  if (used + len > MAX_FILES_PER_WORKSPACE) throw new HttpError(413, 'This workspace has reached its 2 GB attachment limit. Delete old attachments first.');
  const exists = await env.DB.prepare('SELECT 1 FROM files WHERE id = ?').bind(id).first();
  if (exists) throw new HttpError(409, 'That file already exists');
  await bucket.put(`${wsId}/${id}`, req.body, { httpMetadata: { contentType: 'application/octet-stream' } });
  await env.DB.prepare('INSERT INTO files (id, workspace_id, size, key_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, wsId, len, v, user.id, new Date().toISOString()).run();
  return json({ ok: true, id, size: len });
}

async function fileDownload(env: Env, wsId: string, id: string): Promise<Response> {
  const bucket = requireFiles(env);
  const meta = await env.DB.prepare('SELECT key_version FROM files WHERE id = ? AND workspace_id = ?').bind(id, wsId).first<{ key_version: number }>();
  if (!meta) throw new HttpError(404, 'File not found');
  const obj = await bucket.get(`${wsId}/${id}`);
  if (!obj) throw new HttpError(404, 'File not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Key-Version': String(meta.key_version),
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment',
    },
  });
}

async function fileDelete(c: Ctx, wsId: string, user: User, role: Role, id: string): Promise<Response> {
  const bucket = requireFiles(c.env);
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot delete files');
  await bucket.delete(`${wsId}/${id}`);
  await c.env.DB.prepare('DELETE FROM files WHERE id = ? AND workspace_id = ?').bind(id, wsId).run();
  void user;
  return json({ ok: true });
}

// ---------------------------------------------------------------- app downloads

const RELEASES_REPO = 'Mkuz1/MKProd';
let appsCache: { at: number; body: unknown } | null = null;

interface AppAsset { name: string; url: string; size?: number }
interface AppEntry { platform: string; version: string; page: string; assets: AppAsset[]; publishedAt?: string }

/**
 * Latest Mac/Windows/Android builds for signed-in people. The links come from apps.json, written
 * at build time from the version files (release names are fixed by the workflows), so this works
 * without talking to GitHub. With a GITHUB_TOKEN secret the sizes and dates are added from the
 * Releases API (anonymous calls hit GitHub's per-address limit from shared Cloudflare egress).
 */
async function appDownloads(env: Env, url: URL): Promise<Response> {
  if (appsCache && Date.now() - appsCache.at < 10 * 60_000) return json(appsCache.body);
  let base: { apps: AppEntry[]; releases: string } = { apps: [], releases: `https://github.com/${RELEASES_REPO}/releases` };
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/apps.json', url.origin).toString()));
    if (res.ok) base = await res.json<{ apps: AppEntry[]; releases: string }>();
  } catch { /* no manifest: links stay empty */ }
  if (env.GITHUB_TOKEN) {
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`, {
        headers: { 'User-Agent': 'mkprod-worker', Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}` },
      });
      if (res.ok) {
        const rels = await res.json<{ tag_name: string; published_at: string; assets: { name: string; size: number }[] }[]>();
        for (const a of base.apps) {
          const r = rels.find((x) => x.tag_name === `${a.platform}-v${a.version}`);
          if (!r) continue;
          a.publishedAt = r.published_at;
          for (const f of a.assets) f.size = r.assets.find((x) => x.name === f.name)?.size;
        }
      }
    } catch { /* enrichment only */ }
  }
  appsCache = { at: Date.now(), body: base };
  return json(base);
}

// ---------------------------------------------------------------- email notifications

const NOTICE_TYPES = ['taskAssigned', 'taskUpdated', 'contractExpiring', 'approvals', 'mentions', 'weeklyDigest'] as const;
type NoticeType = (typeof NOTICE_TYPES)[number];
/** Notice types a client may address to the sender themself (reminders and digests, not task events). */
const SELF_OK: NoticeType[] = ['contractExpiring', 'weeklyDigest'];
type NotifyPrefs = { email: boolean; includeDetails: boolean; signInAlerts: boolean } & Record<NoticeType, boolean>;
const DEFAULT_PREFS: NotifyPrefs = {
  email: true, includeDetails: true, signInAlerts: true,
  taskAssigned: true, taskUpdated: true, contractExpiring: true, approvals: true, mentions: true, weeklyDigest: true,
};

function prefsOf(raw: string | null | undefined): NotifyPrefs {
  let saved: Record<string, unknown> = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch { /* corrupt row: defaults */ }
  const out = { ...DEFAULT_PREFS };
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof NotifyPrefs)[]) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean;
  return out;
}

async function setNotifyPrefs(req: Request, env: Env, user: User): Promise<Response> {
  const b = await body<Partial<NotifyPrefs>>(req);
  const prefs = prefsOf(JSON.stringify(b));
  await env.DB.prepare('UPDATE users SET notify_prefs = ? WHERE id = ?').bind(JSON.stringify(prefs), user.id).run();
  return json({ notifyPrefs: prefs });
}

async function testEmail(env: Env, user: User): Promise<Response> {
  if (!emailConfigured(env)) throw new HttpError(503, 'Email is not set up on this server yet (see CLOUD_SETUP.md).');
  await rateLimit(env, `testmail:${user.id}`, 5, 3600);
  await sendMails(env, 'MK Prod', [renderMail(user.email, user.name, 'Test email from MK Prod', ['Email notifications are working for your account.'], '')]);
  return json({ ok: true });
}

interface Notice { to: string; type: string; subject: string; lines?: string[]; generic?: string; dedupe?: string }

/**
 * Relays notification emails composed by a client. Recipients must be members of the
 * workspace; each recipient's preferences decide whether it is sent and whether details
 * (task titles etc.) are included or replaced by the generic line.
 */
async function notify(req: Request, env: Env, wsId: string, user: User, role: Role): Promise<Response> {
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot send notifications');
  const b = await body<{ notices: Notice[] }>(req);
  const notices = Array.isArray(b.notices) ? b.notices.slice(0, 50) : [];
  if (!notices.length) return json({ sent: 0, skipped: 0 });
  if (!emailConfigured(env)) return json({ sent: 0, skipped: notices.length, emailEnabled: false });
  await rateLimit(env, `notify:${user.id}`, 60, 3600);

  const rows = (await env.DB.prepare('SELECT u.id, u.email, u.name, u.notify_prefs FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?')
    .bind(wsId).all()).results as { id: string; email: string; name: string; notify_prefs: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wsName = (await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(wsId).first<{ name: string }>())?.name ?? 'MK Prod';
  const now = new Date().toISOString();
  const mails: Mail[] = [];
  const logged: [string, string][] = [];
  let skipped = 0;
  for (const n of notices) {
    const to = byId.get(String(n.to ?? '').toUpperCase());
    const type = NOTICE_TYPES.includes(n.type as NoticeType) ? (n.type as NoticeType) : null;
    // Task events go to others; reminders and digests may go to the sender too.
    if (!to || !type || (to.id === user.id && !SELF_OK.includes(type))) { skipped++; continue; }
    const prefs = prefsOf(to.notify_prefs);
    if (!prefs.email || !prefs[type]) { skipped++; continue; }
    const dedupe = str(n.dedupe || crypto.randomUUID(), 200);
    const fresh = await env.DB.prepare('INSERT OR IGNORE INTO notify_log (workspace_id, user_id, dedupe, sent_at) VALUES (?, ?, ?, ?)')
      .bind(wsId, to.id, `${type}:${dedupe}`, now).run();
    if (!fresh.meta.changes) { skipped++; continue; }
    logged.push([to.id, `${type}:${dedupe}`]);
    const detailed = prefs.includeDetails;
    const subject = detailed ? str(n.subject, 200) : str(n.generic || 'You have a new notification', 200);
    const lines = detailed ? (Array.isArray(n.lines) ? n.lines : []).slice(0, type === 'weeklyDigest' ? 40 : 12).map((l) => str(l, 500)) : [str(n.generic || subject, 500)];
    const from = type === 'weeklyDigest' ? `Your weekly summary for ${wsName}.` : `From ${user.name || user.email} in ${wsName}.`;
    mails.push(renderMail(to.email, to.name, subject, [...lines, from], 'You can turn these emails off in MK Prod › Settings › Notifications.'));
  }
  if (!mails.length) return json({ sent: 0, skipped });
  try {
    const sent = await sendMails(env, 'MK Prod', mails);
    return json({ sent, skipped });
  } catch (e) {
    console.error('notify send failed', e);
    // Forget the de-dupe marks so a later attempt can send them.
    await env.DB.batch(logged.map(([uid, d]) => env.DB.prepare('DELETE FROM notify_log WHERE workspace_id = ? AND user_id = ? AND dedupe = ?').bind(wsId, uid, d)));
    throw new HttpError(502, 'The email server rejected the message. Check the SMTP settings.');
  }
}

function renderMail(to: string, name: string, subject: string, lines: string[], footer: string): Mail {
  const greeting = `Hi ${name || to.split('@')[0]},`;
  const text = [greeting, '', ...lines, '', footer].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1f2330;max-width:560px">
<div style="font-weight:700;color:#7B68EE;font-size:16px;margin-bottom:12px">MK Prod</div>
<p>${escapeHtml(greeting)}</p>${lines.map((l) => `<p style="margin:6px 0">${escapeHtml(l)}</p>`).join('')}
<p style="color:#8a8f98;font-size:12px;margin-top:20px">${escapeHtml(footer)}</p></div>`;
  return { to, subject: `[MK Prod] ${subject}`, text, html };
}

// ---------------------------------------------------------------- helpers

async function roleOf(env: Env, wsId: string, userId: string): Promise<Role | null> {
  const r = await env.DB.prepare('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?').bind(wsId, userId).first<{ role: Role }>();
  return r?.role ?? null;
}

function requireAdmin(role: Role) {
  if (role !== 'owner' && role !== 'admin') throw new HttpError(403, 'Only owners and admins can do this');
}

async function rateLimit(env: Env, bucket: string, max: number, windowSec: number) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND at > ?').bind(bucket, since).first<{ n: number }>();
  if ((r?.n ?? 0) >= max) throw new HttpError(429, 'Too many requests. Please wait and try again.');
  await env.DB.prepare('INSERT INTO rate_events (bucket, at) VALUES (?, ?)').bind(bucket, new Date().toISOString()).run();
}

function ip(req: Request) {
  return req.headers.get('CF-Connecting-IP') ?? 'local';
}

async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Request too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try { return (text ? JSON.parse(text) : {}) as T; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function headers(extra: Record<string, string> = {}): HeadersInit {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: headers(extra) });
}

function cookie(token: string) {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function oneOf<T extends string>(v: unknown, allowed: T[]): T {
  if (!allowed.includes(v as T)) throw new HttpError(400, `Must be one of: ${allowed.join(', ')}`);
  return v as T;
}

function normEmail(v: unknown): string {
  const e = str(v, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email address');
  return e;
}

/** Auth keys are 32-byte values (base64), derived on the client. */
function checkAuthKey(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v)) throw new HttpError(400, 'Update the app to sign in');
  return v;
}

function keyField(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9+/=]+$/.test(v)) throw new HttpError(400, 'Bad key data');
  return v;
}

function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((x) => alphabet[x % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const normCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function authHash(authKey: string, salt: string): Promise<string> {
  const a = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
  const b2 = Uint8Array.from(atob(authKey), (c) => c.charCodeAt(0));
  const all = new Uint8Array(a.length + b2.length);
  all.set(a); all.set(b2, a.length);
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', all)));
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return b64(new Uint8Array(bits));
}

async function sha256(s: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
