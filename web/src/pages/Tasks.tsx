import { useEffect, useMemo, useRef, useState } from 'react';
import { ID, SavedView, Space, Task, addDays, fmtDate, fromInputDate, iso, newTask, startOfDay, toInputDate, uid, PRIORITIES } from '../model';
import { Avatar, Avatars, Empty, Flag, Markdown, PrioritySelect, Seg, StatusPill, Tag, isClosed, member, statusOf, useApp } from '../ui';
import type { SyncEngine } from '../sync';
import { Attachments } from './Procurement';
import { ChartView, FieldsEditor, TaskFields } from './Advanced';
import { criticalPath, fieldDisplay, isComputedField } from '../features';
import { ActivityView, CommentsSection, KeyChip, ListsRow, SpaceSettings, TeamView, TimeInStatus, TypeBadge, TypeSelect, ViewState, ViewsBar } from './Work';
import { DEFAULT_FILTER, assignTaskNumbers, cascadeDates, confirmStatusChange, dayDelta, defaultView, download, inLists, logStatusChange, taskKey, taskTypeOf, toCSV } from '../work';

// ---------------------------------------------------------------- task helpers (mirror Store.swift)

export function statusesFor(engine: SyncEngine, t: Task) {
  return engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.statuses ?? [];
}

export function updateTask(engine: SyncEngine, id: ID, fn: (t: Task) => void) {
  const before = engine.get('tasks', id);
  if (!before) return;
  const me = member(engine, engine.me)?.name ?? 'Someone';
  engine.update('tasks', id, (t) => {
    fn(t);
    const log = (text: string) => t.activity.push({ id: uid(), date: iso(), text });
    if (t.statusId !== before.statusId) {
      const st = statusesFor(engine, t).find((s) => s.id === t.statusId);
      logStatusChange(t, before);
      log(`${me} changed status to ${st?.name ?? '?'}`);
      const closed = st?.kind === 'done' || st?.kind === 'closed';
      if (closed) t.completedAt = iso(); else delete t.completedAt;
      if (closed && t.recurrence !== 'none') spawnRecurrence(engine, t);
    }
    if (t.priority !== before.priority) log(`${me} set priority to ${PRIORITIES.find((p) => p.value === t.priority)?.label}`);
    for (const a of t.assigneeIds) if (!before.assigneeIds.includes(a)) log(`${me} assigned ${member(engine, a)?.name ?? 'someone'}`);
    if (t.dueDate !== before.dueDate) log(t.dueDate ? `${me} set due date to ${new Date(t.dueDate).toLocaleDateString()}` : `${me} removed the due date`);
    if (t.listId !== before.listId) log(`${me} moved this task to ${engine.get('lists', t.listId)?.name ?? '?'}`);
  });
  // Dependent tasks and subtasks follow a moved due date (start date when there is no due date), if the space says so.
  const after = engine.get('tasks', id);
  if (after) cascadeDates(engine, after, dayDelta(before.dueDate, after.dueDate) || (!before.dueDate && !after.dueDate ? dayDelta(before.startDate, after.startDate) : 0), me);
}

function spawnRecurrence(engine: SyncEngine, t: Task) {
  const step = (d?: string) => {
    if (!d) return undefined;
    const x = new Date(d);
    if (t.recurrence === 'daily') x.setDate(x.getDate() + 1);
    if (t.recurrence === 'weekly') x.setDate(x.getDate() + 7);
    if (t.recurrence === 'monthly') x.setMonth(x.getMonth() + 1);
    if (t.recurrence === 'yearly') x.setFullYear(x.getFullYear() + 1);
    return iso(x);
  };
  const n: Task = structuredClone(t);
  n.id = uid();
  n.statusId = statusesFor(engine, t)[0]?.id ?? t.statusId;
  n.dueDate = step(t.dueDate);
  n.startDate = step(t.startDate);
  delete n.completedAt;
  n.comments = [];
  n.created = iso();
  n.checklists = t.checklists.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, done: false })) }));
  n.activity = [{ id: uid(), date: iso(), text: 'Created from recurring task' }];
  delete n.statusLog; delete n.number;
  if (!n.dueDate) delete n.dueDate;
  if (!n.startDate) delete n.startDate;
  engine.put('tasks', n);
}

export function toggleDone(engine: SyncEngine, t: Task) {
  const st = statusesFor(engine, t);
  const target = isClosed(engine, t) ? st[0] : st.find((s) => s.kind === 'done');
  if (target && confirmStatusChange(engine, t, target.id)) updateTask(engine, t.id, (x) => { x.statusId = target.id; });
}

/** Removes a list with every task in it (mirrors Store.deleteList on the Mac). */
export function deleteList(engine: SyncEngine, id: ID) {
  for (const t of engine.list('tasks').filter((t) => t.listId === id)) engine.remove('tasks', t.id);
  engine.remove('lists', id);
}

export function deleteFolder(engine: SyncEngine, id: ID) {
  for (const l of engine.list('lists').filter((l) => l.folderId === id)) deleteList(engine, l.id);
  engine.remove('folders', id);
}

export function deleteSpace(engine: SyncEngine, id: ID) {
  for (const l of engine.list('lists').filter((l) => l.spaceId === id)) deleteList(engine, l.id);
  for (const f of engine.list('folders').filter((f) => f.spaceId === id)) engine.remove('folders', f.id);
  engine.remove('spaces', id);
}

export function trashTask(engine: SyncEngine, id: ID) {
  const now = iso();
  for (const c of engine.list('tasks').filter((x) => x.parentId === id)) trashTask(engine, c.id);
  engine.update('tasks', id, (t) => { t.archived = true; t.trashedAt = now; });
}

const isOverdue = (engine: SyncEngine, t: Task) => !!t.dueDate && new Date(t.dueDate) < startOfDay() && !isClosed(engine, t);

// ---------------------------------------------------------------- Home

export function HomePage() {
  const { engine, openTask, go, fin } = useApp();
  const mine = engine.list('tasks').filter((t) => !t.archived && t.assigneeIds.includes(engine.me) && !isClosed(engine, t));
  const today = startOfDay();
  const buckets: [string, Task[]][] = [
    ['Overdue', mine.filter((t) => isOverdue(engine, t))],
    ['Today', mine.filter((t) => t.dueDate && startOfDay(new Date(t.dueDate)).getTime() === today.getTime())],
    ['Next', mine.filter((t) => t.dueDate && new Date(t.dueDate) >= addDays(today, 1)).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))],
    ['Unscheduled', mine.filter((t) => !t.dueDate)],
  ];
  const approvals = engine.list('orders').filter((o) => fin.canApprove(o));
  const name = member(engine, engine.me)?.name.split(' ')[0] ?? '';
  const h = new Date().getHours();
  return (
    <div className="col" style={{ gap: 16 }}>
      <div><h1>{h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, {name}</h1><div className="muted">{new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}</div></div>
      <div className="grid g4">
        <Stat label="Overdue" n={buckets[0][1].length} color="var(--red)" />
        <Stat label="Due today" n={buckets[1][1].length} color="var(--orange)" />
        <Stat label="Assigned to me" n={mine.length} color="var(--blue)" />
        <Stat label="Approvals waiting" n={approvals.length} color="var(--accent)" onClick={() => go('approvals')} />
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>My work</h3>
          {mine.length === 0 && <p className="muted">Nothing assigned to you 🎉</p>}
          {buckets.map(([label, ts]) => ts.length > 0 && (
            <div key={label}>
              <div className="small" style={{ fontWeight: 700, marginTop: 10, color: label === 'Overdue' ? 'var(--red)' : 'var(--muted)' }}>{label.toUpperCase()}</div>
              {ts.slice(0, 6).map((t) => <MiniRow key={t.id} t={t} onClick={() => openTask(t.id)} />)}
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Recently updated</h3>
          {engine.list('tasks').filter((t) => !t.archived).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 10).map((t) => <MiniRow key={t.id} t={t} onClick={() => openTask(t.id)} />)}
        </div>
        <RemindersCard />
      </div>
    </div>
  );
}

/** Personal reminders: synced to every device of the person, encrypted with their own key. */
function RemindersCard() {
  const { engine, openTask } = useApp();
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState(() => { const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0); return toLocalInput(d); });
  const [showDone, setShowDone] = useState(false);
  const items = engine.reminders.filter((r) => showDone || !r.done);
  const add = () => {
    if (!title.trim() || !when) return;
    engine.addReminder(title.trim(), iso(new Date(when)));
    setTitle('');
  };
  return (
    <div className="card col">
      <div className="row"><h3 className="grow">⏰ Reminders</h3><label className="row small muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done</label></div>
      {items.length === 0 && <p className="muted small">No reminders. They pop up in your Inbox and on your desktop at the chosen time, on whichever device you're using.</p>}
      {items.map((r) => (
        <div key={r.id} className="row" style={{ padding: '3px 0' }}>
          <input type="checkbox" checked={r.done} onChange={() => engine.update('reminders', r.id, (x) => { x.done = !x.done; })} />
          <span className="grow" style={{ textDecoration: r.done ? 'line-through' : undefined, cursor: r.taskId ? 'pointer' : undefined }} onClick={() => r.taskId && openTask(r.taskId)}>{r.title}</span>
          <span className={`small ${!r.done && new Date(r.date) < new Date() ? 'red' : 'muted'}`}>{new Date(r.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <button className="btn ghost sm" onClick={() => engine.remove('reminders', r.id)}>✕</button>
        </div>
      ))}
      <div className="row wrap">
        <input className="input grow" placeholder="Remind me to…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <button className="btn primary" disabled={!title.trim() || !when} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function Stat({ label, n, color, onClick }: { label: string; n: number; color: string; onClick?: () => void }) {
  return (
    <div className="kpi" style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>
      <div><div className="v" style={{ fontSize: 24 }}>{n}</div><div className="l">{label}</div></div>
    </div>
  );
}

function MiniRow({ t, onClick }: { t: Task; onClick: () => void }) {
  const { engine } = useApp();
  return (
    <div className="row" style={{ padding: '5px 0', cursor: 'pointer' }} onClick={onClick}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: statusOf(engine, t)?.colorHex ?? '#888' }} />
      <span className="grow ellipsis">{t.title}</span>
      <Flag p={t.priority} />
      <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Inbox

export function InboxPage() {
  const { engine, openTask, go } = useApp();
  return (
    <div className="card">
      <div className="row"><h2 className="grow">Inbox</h2><button className="btn" onClick={() => engine.markInboxRead()}>Mark all read</button><button className="btn" onClick={() => confirm('Clear all inbox items?') && engine.clearInbox()}>Clear all</button></div>
      <p className="small muted">Synced to all your devices, and private to you: encrypted with your own key, not the workspace key.</p>
      {engine.inbox.length === 0 && <Empty icon="📭" title="Inbox zero" sub="Assignments, mentions, approvals and reminders appear here." />}
      {engine.inbox.map((n) => (
        <div key={n.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer', fontWeight: n.read ? 400 : 600 }}
          onClick={() => {
            engine.markInboxRead(n.id);
            const target = n.target ?? (n.taskId ? `task:${n.taskId}` : undefined);
            if (target?.startsWith('task:')) openTask(target.slice(5));
            else if (target?.startsWith('order:')) go('orders/' + target.slice(6));
            else if (target?.startsWith('chat:')) go('chat/' + target.slice(5));
          }}>
          {!n.read && <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)' }} />}
          <span className="grow">{n.text}</span>
          <span className="small muted">{new Date(n.date).toLocaleString()}</span>
          <button className="btn ghost sm" title="Clear" onClick={(e) => { e.stopPropagation(); engine.clearInbox(n.id); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- task container

type View = 'list' | 'board' | 'calendar' | 'table' | 'gantt' | 'chart' | 'workload' | 'activity' | 'team' | 'mindmap' | 'form';
type Scope = { kind: 'everything' } | { kind: 'mine' } | { kind: 'space' | 'folder' | 'list'; id: ID };
type GroupBy = 'status' | 'priority' | 'assignee' | 'type' | 'list' | 'due' | 'none';
type SortBy = 'manual' | 'due' | 'priority' | 'title' | 'created' | 'updated';

const VIEW_OPTIONS: { value: View; icon: string; label: string }[] = [
  { value: 'list', icon: '☰', label: 'List' }, { value: 'board', icon: '▦', label: 'Board' }, { value: 'calendar', icon: '📅', label: 'Calendar' },
  { value: 'table', icon: '▤', label: 'Table' }, { value: 'gantt', icon: '▬', label: 'Gantt' }, { value: 'chart', icon: '📊', label: 'Chart' },
  { value: 'workload', icon: '⚖️', label: 'Workload' }, { value: 'team', icon: '👥', label: 'Team' }, { value: 'activity', icon: '🕘', label: 'Activity' },
  { value: 'mindmap', icon: '🧠', label: 'Mind Map' }, { value: 'form', icon: '📋', label: 'Form' },
];
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'status', label: 'Status' }, { value: 'priority', label: 'Priority' }, { value: 'assignee', label: 'Assignee' }, { value: 'type', label: 'Task type' },
  { value: 'list', label: 'List' }, { value: 'due', label: 'Due date' }, { value: 'none', label: 'None' },
];
const SORTS: { value: SortBy; label: string }[] = [
  { value: 'manual', label: 'Manual' }, { value: 'due', label: 'Due date' }, { value: 'priority', label: 'Priority' }, { value: 'title', label: 'Name' },
  { value: 'created', label: 'Date created' }, { value: 'updated', label: 'Last updated' },
];

const scopeKey = (scope: Scope) => (scope.kind === 'everything' || scope.kind === 'mine' ? scope.kind : `${scope.kind}:${scope.id}`);

export function TasksPage({ scope }: { scope: Scope }) {
  const { engine, openTask, toast } = useApp();
  const key = scopeKey(scope);
  const initial = (): ViewState => {
    const d = defaultView(engine, key);
    if (d) return { mode: d.mode, groupBy: d.groupBy, sortBy: d.sortBy, filter: { ...DEFAULT_FILTER, ...d.filter } };
    return { mode: localStorage.getItem('view') || 'list', groupBy: 'status', sortBy: 'manual', filter: { ...DEFAULT_FILTER } };
  };
  const [state, setState] = useState<ViewState>(initial);
  const [activeView, setActiveView] = useState<ID | undefined>(() => defaultView(engine, key)?.id);
  const [quick, setQuick] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const view = state.mode as View;
  const f = state.filter;
  const setF = (patch: Partial<ViewState['filter']>) => { touched.current = true; setState((s) => ({ ...s, filter: { ...s.filter, ...patch } })); };
  const setV = (v: View) => { touched.current = true; setState((s) => ({ ...s, mode: v })); try { localStorage.setItem('view', v); } catch { /* private mode */ } };
  const apply = (v: SavedView) => { touched.current = true; setActiveView(v.id); setState({ mode: v.mode, groupBy: v.groupBy, sortBy: v.sortBy, filter: { ...DEFAULT_FILTER, ...v.filter } }); };
  // The page can open before saved views have loaded (cache, first sync): apply the default once it
  // shows up, unless the person already picked something here.
  const dv = defaultView(engine, key);
  useEffect(() => {
    if (touched.current || activeView || !dv) return;
    setActiveView(dv.id);
    setState({ mode: dv.mode, groupBy: dv.groupBy, sortBy: dv.sortBy, filter: { ...DEFAULT_FILTER, ...dv.filter } });
  }, [dv?.id]);

  // Tasks created anywhere get their number once their space uses task IDs.
  useEffect(() => { assignTaskNumbers(engine); }, [engine.version]);
  // n: new task, /: filter. Ignored while typing.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      if (e.key === 'n') { e.preventDefault(); quickRef.current?.focus(); }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const listIds = useMemo(() => {
    const lists = engine.list('lists').filter((l) => !l.archived);
    if (scope.kind === 'list') return [scope.id];
    if (scope.kind === 'folder') return lists.filter((l) => l.folderId === scope.id).map((l) => l.id);
    if (scope.kind === 'space') return lists.filter((l) => l.spaceId === scope.id).map((l) => l.id);
    return lists.map((l) => l.id);
  }, [engine.version, scope]);
  const listSet = new Set(listIds);

  // "My Tasks" includes subtasks assigned to you; the other views show top-level tasks (subtasks live inside their parent).
  const scoped = engine.list('tasks').filter((t) => !t.archived && (scope.kind === 'mine' || !t.parentId) && inLists(t, listSet));
  let tasks = scope.kind === 'mine' ? scoped.filter((t) => t.assigneeIds.includes(engine.me)) : scoped;
  const q = f.search.trim().toLowerCase();
  if (q) tasks = tasks.filter((t) => `${t.title} ${t.tags.join(' ')} ${taskKey(engine, t) ?? ''}`.toLowerCase().includes(q));
  if (f.assigneeId) tasks = tasks.filter((t) => t.assigneeIds.includes(f.assigneeId!));
  if (f.priority !== undefined) tasks = tasks.filter((t) => t.priority === f.priority);
  if (f.tag) tasks = tasks.filter((t) => t.tags.includes(f.tag!));
  if (f.typeId) {
    const name = engine.list('spaces').flatMap((s) => s.taskTypes ?? []).find((x) => x.id === f.typeId)?.name;
    tasks = tasks.filter((t) => f.typeId === 'task' ? !taskTypeOf(engine, t) : taskTypeOf(engine, t)?.name === name);
  }
  if (!f.showClosed) tasks = tasks.filter((t) => !isClosed(engine, t));
  if (f.onlyOverdue) tasks = tasks.filter((t) => isOverdue(engine, t));
  tasks = sortTasks(engine, tasks, state.sortBy as SortBy);

  const defaultList = listIds[0];
  const addQuick = () => {
    const title = quick.trim();
    if (!title || !defaultList) return;
    const list = engine.get('lists', defaultList)!;
    const st = engine.get('spaces', list.spaceId)?.statuses[0];
    if (!st) return;
    const t = newTask(defaultList, title, st.id, member(engine, engine.me));
    if (scope.kind === 'mine') t.assigneeIds = [engine.me];
    if (f.assigneeId) t.assigneeIds = [f.assigneeId];
    engine.put('tasks', t);
    setQuick('');
  };

  const spaces = (scope.kind === 'list' || scope.kind === 'folder' || scope.kind === 'space'
    ? [engine.get('spaces', engine.get('lists', listIds[0])?.spaceId ?? (scope.kind === 'space' ? scope.id : ''))]
    : engine.list('spaces')).filter((x): x is Space => !!x);
  const oneSpace = spaces.length === 1 ? spaces[0] : undefined;
  const groups = buildGroups(engine, tasks, state.groupBy as GroupBy, spaces);
  const types = [...new Map(spaces.flatMap((s) => s.taskTypes ?? []).map((x) => [x.name, x])).values()];
  const tags = [...new Set(scoped.flatMap((t) => t.tags))].sort();
  const activeFilters = [f.assigneeId, f.priority !== undefined, f.tag, f.typeId, !f.showClosed, f.onlyOverdue].filter(Boolean).length;
  const grouped = view === 'list' || view === 'board';

  const exportCSV = () => {
    const fields = [...new Map(tasks.flatMap((t) => engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.fields ?? []).map((x) => [x.name, x])).values()];
    const rows = [
      ['ID', 'Name', 'Type', 'Status', 'Priority', 'Assignees', 'Start', 'Due', 'Estimate (h)', 'Tags', 'List', ...fields.map((x) => x.name)],
      ...tasks.map((t) => {
        const own = engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.fields ?? [];
        return [taskKey(engine, t) ?? '', t.title, taskTypeOf(engine, t)?.name ?? 'Task', statusOf(engine, t)?.name ?? '', PRIORITIES.find((p) => p.value === t.priority)?.label ?? '',
          t.assigneeIds.map((a) => member(engine, a)?.name ?? '').join('; '), t.startDate?.slice(0, 10) ?? '', t.dueDate?.slice(0, 10) ?? '',
          t.estimateMinutes ? Math.round(t.estimateMinutes / 6) / 10 : '', t.tags.join('; '), engine.get('lists', t.listId)?.name ?? '',
          ...fields.map((x) => { const mine = own.find((o) => o.name === x.name); return mine ? fieldDisplay(engine, t, mine) : ''; })];
      }),
    ];
    download(`${scopeTitle(engine, scope).replace(/[^\w -]+/g, '')}-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows));
    toast(`Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  };

  return (
    <div className="tasks-page">
      <ViewsBar scope={key} active={activeView} current={state} onApply={apply} onClear={() => { setActiveView(undefined); setState({ mode: view, groupBy: 'status', sortBy: 'manual', filter: { ...DEFAULT_FILTER } }); }} />
      <div className="toolbar glass-bar">
        <div className="view-switch" role="tablist">
          {VIEW_OPTIONS.map((o) => <button key={o.value} role="tab" aria-selected={view === o.value} className={view === o.value ? 'on' : ''} onClick={() => setV(o.value)} title={o.label}><span>{o.icon}</span><span className="lbl">{o.label}</span></button>)}
        </div>
        <span className="right" />
        <div className="search-box"><span>🔍</span><input ref={searchRef} className="plain" placeholder="Search tasks or IDs  /" value={f.search} onChange={(e) => setF({ search: e.target.value })} />{f.search && <button className="btn ghost sm" onClick={() => setF({ search: '' })}>✕</button>}</div>
        <button className={`btn ${f.assigneeId === engine.me ? 'on' : ''}`} title="Only my tasks" onClick={() => setF({ assigneeId: f.assigneeId === engine.me ? undefined : engine.me })}>👤 Me</button>
        <div className="pop-wrap">
          <button className={`btn ${activeFilters ? 'on' : ''}`} onClick={() => setFiltersOpen(!filtersOpen)}>⚲ Filter{activeFilters ? ` · ${activeFilters}` : ''}</button>
          {filtersOpen && (
            <div className="menu pop" onClick={(e) => e.stopPropagation()}>
              <label className="field">Assignee<select className="input" value={f.assigneeId ?? ''} onChange={(e) => setF({ assigneeId: e.target.value || undefined })}><option value="">Anyone</option>{engine.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              <label className="field">Priority<select className="input" value={f.priority ?? ''} onChange={(e) => setF({ priority: e.target.value === '' ? undefined : Number(e.target.value) })}><option value="">Any</option>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
              {tags.length > 0 && <label className="field">Tag<select className="input" value={f.tag ?? ''} onChange={(e) => setF({ tag: e.target.value || undefined })}><option value="">Any</option>{tags.map((t) => <option key={t}>{t}</option>)}</select></label>}
              {types.length > 0 && <label className="field">Task type<select className="input" value={f.typeId ?? ''} onChange={(e) => setF({ typeId: e.target.value || undefined })}><option value="">Any</option><option value="task">✓ Task</option>{types.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></label>}
              <label className="row"><input type="checkbox" checked={f.showClosed} onChange={(e) => setF({ showClosed: e.target.checked })} /> Show closed tasks</label>
              <label className="row"><input type="checkbox" checked={f.onlyOverdue} onChange={(e) => setF({ onlyOverdue: e.target.checked })} /> Only overdue</label>
              <div className="row"><button className="btn sm" onClick={() => setState((s) => ({ ...s, filter: { ...DEFAULT_FILTER, search: s.filter.search } }))}>Clear filters</button><span className="right" /><button className="btn sm primary" onClick={() => setFiltersOpen(false)}>Done</button></div>
            </div>
          )}
        </div>
        {grouped && <label className="btn select-btn" title="Group by">▤ <select className="plain" value={state.groupBy} onChange={(e) => setState((s) => ({ ...s, groupBy: e.target.value }))}>{GROUPS.map((g) => <option key={g.value} value={g.value}>Group: {g.label}</option>)}</select></label>}
        <label className="btn select-btn" title="Sort">⇅ <select className="plain" value={state.sortBy} onChange={(e) => setState((s) => ({ ...s, sortBy: e.target.value }))}>{SORTS.map((g) => <option key={g.value} value={g.value}>Sort: {g.label}</option>)}</select></label>
        <button className="btn" title="Export these tasks as CSV (opens in Excel)" onClick={exportCSV} disabled={!tasks.length}>⤓ CSV</button>
        {oneSpace && engine.canWrite && <button className="btn" title="Space settings: statuses, task types, IDs, scheduling, fields" onClick={() => setSettings(true)}>⚙</button>}
      </div>
      {defaultList && view !== 'form' && view !== 'activity' && (
        <div className="quick-add">
          <span>＋</span>
          <input ref={quickRef} className="plain grow" placeholder={`Add a task to ${engine.get('lists', defaultList)?.name ?? 'this list'} and press Enter  ·  n`} value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addQuick()} />
          <span className="small faint">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
        </div>
      )}
      {!defaultList && <Empty icon="📋" title="No lists yet" sub="Create a space and a list from the sidebar." />}
      {defaultList && view === 'list' && <ListView groups={groups} onOpen={openTask} />}
      {defaultList && view === 'board' && <BoardView groups={groups} onOpen={openTask} />}
      {defaultList && view === 'calendar' && <CalendarView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'table' && <TableView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'gantt' && <GanttView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'chart' && <ChartView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'workload' && <WorkloadView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'team' && <TeamView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'activity' && <ActivityView tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'mindmap' && <MindMapView title={scopeTitle(engine, scope)} tasks={tasks} onOpen={openTask} />}
      {defaultList && view === 'form' && <FormView defaultList={defaultList} lists={listIds} />}
      {settings && oneSpace && <SpaceSettings spaceId={oneSpace.id} onClose={() => setSettings(false)} />}
      {filtersOpen && <div className="click-away" onClick={() => setFiltersOpen(false)} />}
    </div>
  );
}

function sortTasks(engine: SyncEngine, ts: Task[], by: SortBy): Task[] {
  const out = [...ts];
  if (by === 'manual') out.sort((a, b) => a.order - b.order);
  if (by === 'due') out.sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
  if (by === 'priority') out.sort((a, b) => b.priority - a.priority || a.order - b.order);
  if (by === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
  if (by === 'created') out.sort((a, b) => b.created.localeCompare(a.created));
  if (by === 'updated') out.sort((a, b) => b.updated.localeCompare(a.updated));
  void engine;
  return out;
}

type Group = { key: string; name: string; color: string; ids: ID[]; tasks: Task[]; limit?: number; apply?: (t: Task) => void; icon?: string };

/** Groups for List and Board. Status groups merge statuses of the same name, so multi-space views still line up. */
function buildGroups(engine: SyncEngine, tasks: Task[], by: GroupBy, spaces: Space[]): Group[] {
  if (by === 'status') {
    const out: Group[] = [];
    for (const s of spaces.flatMap((x) => x.statuses)) {
      const g = out.find((x) => x.name === s.name);
      if (g) { g.ids.push(s.id); if (s.wipLimit) g.limit = Math.min(g.limit ?? Infinity, s.wipLimit); }
      else out.push({ key: s.name, name: s.name, color: s.colorHex, ids: [s.id], tasks: [], limit: s.wipLimit, apply: (t) => {
        const st = statusesFor(engine, t).find((x) => x.name === s.name);
        if (st && st.id !== t.statusId && confirmStatusChange(engine, t, st.id)) updateTask(engine, t.id, (x) => { x.statusId = st.id; });
      } });
    }
    for (const g of out) g.tasks = tasks.filter((t) => g.ids.includes(t.statusId));
    return out.filter((g) => g.tasks.length || spaces.length === 1);
  }
  if (by === 'priority') return PRIORITIES.map((p) => ({ key: String(p.value), name: p.label, color: p.color, ids: [], tasks: tasks.filter((t) => t.priority === p.value), apply: (t: Task) => updateTask(engine, t.id, (x) => { x.priority = p.value; }) }));
  if (by === 'assignee') {
    const gs: Group[] = engine.members.map((m) => ({ key: m.id, name: m.name, color: m.colorHex, ids: [], tasks: tasks.filter((t) => t.assigneeIds.includes(m.id)), apply: (t: Task) => updateTask(engine, t.id, (x) => { x.assigneeIds = [m.id]; }) }));
    gs.push({ key: 'none', name: 'Unassigned', color: '#87909E', ids: [], tasks: tasks.filter((t) => !t.assigneeIds.length), apply: (t) => updateTask(engine, t.id, (x) => { x.assigneeIds = []; }) });
    return gs.filter((g) => g.tasks.length || g.key !== 'none');
  }
  if (by === 'type') {
    const names = [...new Map(spaces.flatMap((s) => s.taskTypes ?? []).map((x) => [x.name, x])).values()];
    const setType = (name?: string) => (t: Task) => updateTask(engine, t.id, (x) => {
      const id = engine.get('spaces', engine.get('lists', x.listId)?.spaceId)?.taskTypes?.find((y) => y.name === name)?.id;
      if (id) x.typeId = id; else delete x.typeId;
    });
    return [
      { key: 'task', name: 'Task', icon: '✓', color: '#87909E', ids: [], tasks: tasks.filter((t) => !taskTypeOf(engine, t)), apply: setType(undefined) },
      ...names.map((n) => ({ key: n.name, name: n.name, icon: n.icon, color: n.colorHex, ids: [], tasks: tasks.filter((t) => taskTypeOf(engine, t)?.name === n.name), apply: setType(n.name) })),
    ];
  }
  if (by === 'list') {
    const ids = [...new Set(tasks.map((t) => t.listId))];
    return ids.map((id) => { const l = engine.get('lists', id); return { key: id, name: l?.name ?? 'List', color: l?.colorHex ?? engine.get('spaces', l?.spaceId)?.colorHex ?? '#7B68EE', ids: [], tasks: tasks.filter((t) => t.listId === id) }; });
  }
  if (by === 'due') {
    const today = startOfDay(), tomorrow = addDays(today, 1), week = addDays(today, 7);
    const at = (t: Task) => (t.dueDate ? new Date(t.dueDate) : undefined);
    const set = (days?: number) => (t: Task) => updateTask(engine, t.id, (x) => { if (days === undefined) delete x.dueDate; else x.dueDate = iso(addDays(today, days)); });
    return [
      { key: 'overdue', name: 'Overdue', color: '#E5484D', ids: [], tasks: tasks.filter((t) => at(t) && at(t)! < today && !isClosed(engine, t)) },
      { key: 'today', name: 'Today', color: '#F0A33A', ids: [], tasks: tasks.filter((t) => at(t) && at(t)! >= today && at(t)! < tomorrow), apply: set(0) },
      { key: 'week', name: 'Next 7 days', color: '#5B8DEF', ids: [], tasks: tasks.filter((t) => at(t) && at(t)! >= tomorrow && at(t)! < week), apply: set(1) },
      { key: 'later', name: 'Later', color: '#7B68EE', ids: [], tasks: tasks.filter((t) => at(t) && at(t)! >= week), apply: set(7) },
      { key: 'none', name: 'No due date', color: '#87909E', ids: [], tasks: tasks.filter((t) => !at(t) || (at(t)! < today && isClosed(engine, t))), apply: set(undefined) },
    ];
  }
  return [{ key: 'all', name: 'All tasks', color: '#7B68EE', ids: [], tasks }];
}

function scopeTitle(engine: SyncEngine, scope: Scope) {
  if (scope.kind === 'mine') return 'My Tasks';
  if (scope.kind === 'everything') return 'Everything';
  const o = scope.kind === 'list' ? engine.get('lists', scope.id) : scope.kind === 'folder' ? engine.get('folders', scope.id) : engine.get('spaces', scope.id);
  return o?.name ?? 'Tasks';
}

// ---------------------------------------------------------------- workload (mirrors WorkloadView.swift)

/** Hours of estimated work per person per day, spreading each estimate across its start→due range. */
function WorkloadView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [start, setStart] = useState(() => startOfDay());
  const [capacity, setCapacity] = useState(8);
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const load = (memberId: ID, day: Date) => {
    let hours = 0; const list: Task[] = [];
    for (const t of tasks) {
      if (!t.assigneeIds.includes(memberId) || isClosed(engine, t) || !t.dueDate) continue;
      const due = startOfDay(new Date(t.dueDate)); const s = startOfDay(new Date(t.startDate ?? t.dueDate));
      if (day < s || day > due) continue;
      const span = Math.max(Math.round((due.getTime() - s.getTime()) / 86400_000) + 1, 1);
      hours += (t.estimateMinutes ?? 60) / 60 / span; list.push(t);
    }
    return { hours, list };
  };
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <button className="btn sm" onClick={() => setStart(addDays(start, -7))}>‹</button>
        <button className="btn sm" onClick={() => setStart(startOfDay())}>This week</button>
        <button className="btn sm" onClick={() => setStart(addDays(start, 7))}>›</button>
        <span className="grow" />
        <span className="small muted">Capacity per day</span>
        <input className="input" type="number" min={1} max={16} value={capacity} onChange={(e) => setCapacity(Math.max(1, Number(e.target.value) || 8))} style={{ width: 64 }} />
        <span className="small muted">h</span>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="t" style={{ minWidth: 160 + days.length * 66 }}>
          <thead><tr><th style={{ minWidth: 160 }}>Member</th>{days.map((d) => <th key={d.toISOString()} style={{ textAlign: 'center', width: 64 }}>{d.toLocaleDateString(undefined, { weekday: 'short' })}<br />{d.getDate()}</th>)}</tr></thead>
          <tbody>{engine.members.map((m) => (
            <tr key={m.id}><td><span className="row"><Avatar m={m} size={20} />{m.name}</span></td>
              {days.map((d) => {
                const { hours, list } = load(m.id, d);
                const r = hours / capacity;
                const bg = r > 1 ? 'var(--red)' : r > 0.7 ? 'var(--orange)' : r > 0 ? 'var(--green)' : 'transparent';
                return <td key={d.toISOString()} title={list.map((t) => t.title).join('\n')} onClick={() => list[0] && onOpen(list[0].id)} style={{ textAlign: 'center', cursor: list.length ? 'pointer' : undefined, background: `color-mix(in srgb, ${bg} 22%, transparent)` }}>
                  {hours > 0 && <div className="small" style={{ fontWeight: 700 }}>{hours.toFixed(1)}h</div>}{list.length > 0 && <div style={{ fontSize: 10 }} className="muted">{list.length} task{list.length === 1 ? '' : 's'}</div>}
                </td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- mind map (mirrors MindMapView.swift)

function MindMapView({ title, tasks, onOpen }: { title: string; tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const Branch = ({ t }: { t: Task }) => {
    const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived);
    const c = statusOf(engine, t)?.colorHex ?? '#87909E';
    return (
      <div className="mm-branch">
        <span className="mm-node" style={{ borderColor: c, background: c + '26' }} onClick={() => onOpen(t.id)}>{t.title}</span>
        {subs.length > 0 && <div className="mm-children">{subs.map((s) => <Branch key={s.id} t={s} />)}</div>}
      </div>
    );
  };
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <div className="mm-root">
        <span className="mm-node mm-title">{title}</span>
        <div className="mm-children">{tasks.map((t) => <Branch key={t.id} t={t} />)}{!tasks.length && <span className="muted small">No tasks</span>}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- form (mirrors TaskFormView.swift)

/** Request form: submissions become tasks in the chosen list, the same as in the Mac app. */
function FormView({ defaultList, lists }: { defaultList: ID; lists: ID[] }) {
  const { engine, toast } = useApp();
  const [f, setF] = useState({ listId: defaultList, title: '', email: '', priority: 2, due: '', details: '' });
  const options = engine.list('lists').filter((l) => !l.archived && lists.includes(l.id));
  const submit = () => {
    const list = engine.get('lists', f.listId); const st = engine.get('spaces', list?.spaceId ?? '')?.statuses[0];
    if (!list || !st || !f.title.trim()) return;
    const t = newTask(f.listId, f.title.trim(), st.id, member(engine, engine.me));
    t.details = f.details.trim(); t.priority = f.priority;
    if (f.due) t.dueDate = fromInputDate(f.due);
    t.activity.push({ id: uid(), date: iso(), text: `Submitted via form${f.email ? ` by ${f.email}` : ''}` });
    engine.put('tasks', t);
    setF({ ...f, title: '', details: '', due: '' });
    toast('Submitted: a task was created');
  };
  return (
    <div className="card col" style={{ maxWidth: 640 }}>
      <h2>Request form</h2>
      <p className="small muted">Submissions become tasks in the selected list.</p>
      <label className="field">Submit to list<select className="input" value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}>{options.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label className="field">Request title *<input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label className="field">Your email<input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <div className="grid g2">
        <label className="field">Priority<select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
        <label className="field">Needed by<input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
      </div>
      <label className="field">Details<textarea className="input" rows={4} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
      <button className="btn primary" disabled={!f.title.trim()} onClick={submit} style={{ alignSelf: 'flex-end' }}>Submit</button>
    </div>
  );
}

function GroupHeader({ g, collapsed, onToggle }: { g: Group; collapsed: boolean; onToggle: () => void }) {
  const { engine } = useApp();
  // Closed tasks don't count against a work-in-progress limit.
  const open = g.tasks.filter((t) => !isClosed(engine, t)).length;
  const over = g.limit !== undefined && open > g.limit;
  return (
    <div className="group-h">
      <button className="btn ghost sm" onClick={onToggle} aria-label={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? '▸' : '▾'}</button>
      <span className="label" style={{ background: g.color }}>{g.icon ? `${g.icon} ` : ''}{g.name}</span>
      <span className={`small ${over ? 'wip-over' : 'muted'}`} title={g.limit ? `Work-in-progress limit ${g.limit}` : undefined}>{g.limit ? `${open} / ${g.limit}` : g.tasks.length}{over ? ' · over limit' : ''}</span>
    </div>
  );
}

function ListView({ groups, onOpen }: { groups: Group[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [over, setOver] = useState('');
  return (
    <div className="card list-card" style={{ padding: 8 }}>
      {groups.map((g) => (
        <div key={g.key} className={over === g.key ? 'drop-on' : ''}
          onDragOver={g.apply ? (e) => { e.preventDefault(); setOver(g.key); } : undefined} onDragLeave={() => setOver('')}
          onDrop={g.apply ? (e) => { e.preventDefault(); setOver(''); const t = engine.get('tasks', e.dataTransfer.getData('text/plain')); if (t) g.apply!(t); } : undefined}>
          <GroupHeader g={g} collapsed={collapsed.has(g.key)} onToggle={() => setCollapsed((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })} />
          {!collapsed.has(g.key) && g.tasks.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpen} />)}
          {!collapsed.has(g.key) && g.tasks.length === 0 && <div className="small faint" style={{ padding: '4px 36px' }}>No tasks</div>}
        </div>
      ))}
      {groups.length === 0 && <Empty icon="✅" title="No tasks" sub="Nothing matches. Add one above, or clear the filters." />}
      <span hidden>{engine.version}</span>
    </div>
  );
}

/** Pinned custom fields of the task's space, as small chips. */
function PinnedFields({ t }: { t: Task }) {
  const { engine } = useApp();
  const fields = (engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.fields ?? []).filter((x) => x.pinned);
  return <>{fields.map((x) => { const v = fieldDisplay(engine, t, x); return v ? <span key={x.id} className="field-chip" title={x.name}><span className="faint">{x.name}</span> {v}</span> : null; })}</>;
}

function TaskRow({ t, onOpen }: { t: Task; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const st = statusOf(engine, t);
  const closed = isClosed(engine, t);
  const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived);
  const items = t.checklists.flatMap((c) => c.items);
  const blocked = t.blockedBy.some((b) => { const x = engine.get('tasks', b); return x && !x.archived && !isClosed(engine, x); });
  return (
    <div className="trow" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} onClick={() => onOpen(t.id)}>
      <span className="check" style={{ color: st?.colorHex, background: closed ? st?.colorHex : 'transparent' }} onClick={(e) => { e.stopPropagation(); toggleDone(engine, t); }} title={closed ? 'Reopen' : 'Mark complete'}>{closed ? <span style={{ color: '#fff' }}>✓</span> : ''}</span>
      <span className="row grow" style={{ minWidth: 0 }}>
        <TypeBadge t={t} />
        <KeyChip t={t} />
        <span className="ellipsis" style={{ textDecoration: closed ? 'line-through' : undefined, color: closed ? 'var(--muted)' : undefined }}>{t.title}</span>
        {blocked && <span className="small orange" title="Waiting on another task">⛔</span>}
        {subs.length > 0 && <span className="small muted">↳ {subs.length}</span>}
        {items.length > 0 && <span className="small muted">☑ {items.filter((i) => i.done).length}/{items.length}</span>}
        {t.comments.length > 0 && <span className="small muted">💬 {t.comments.length}</span>}
        {(t.extraListIds?.length ?? 0) > 0 && <span className="small muted" title="Also in other lists">⧉ {t.extraListIds!.length + 1}</span>}
        {t.tags.slice(0, 3).map((x) => <Tag key={x} t={x} />)}
        <span className="hide-sm row" style={{ gap: 4 }}><PinnedFields t={t} /></span>
      </span>
      <span className="hide-sm"><Avatars ids={t.assigneeIds} /></span>
      <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
      <span className="hide-sm"><Flag p={t.priority} /></span>
    </div>
  );
}

function BoardView({ groups, onOpen }: { groups: Group[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [over, setOver] = useState('');
  return (
    <div className="board">
      {groups.map((g) => {
        const open = g.tasks.filter((t) => !isClosed(engine, t)).length;
        const wipOver = g.limit !== undefined && open > g.limit;
        return (
          <div key={g.key} className={`col-b ${wipOver ? 'wip' : ''}`} style={{ background: `color-mix(in srgb, ${g.color} ${over === g.key ? 18 : 7}%, transparent)`, borderTop: `3px solid ${g.color}` }}
            onDragOver={g.apply ? (e) => { e.preventDefault(); setOver(g.key); } : undefined} onDragLeave={() => setOver('')}
            onDrop={g.apply ? (e) => { e.preventDefault(); setOver(''); const t = engine.get('tasks', e.dataTransfer.getData('text/plain')); if (t) g.apply!(t); } : undefined}>
            <div className="row"><strong className="small">{g.icon ? `${g.icon} ` : ''}{g.name.toUpperCase()}</strong>
              <span className={`small ${wipOver ? 'wip-over' : 'muted'}`} title={g.limit ? `Work-in-progress limit ${g.limit}` : undefined}>{g.limit ? `${open}/${g.limit}` : g.tasks.length}</span>
              {wipOver && <span className="small wip-over right" title="More open tasks than the limit">over limit</span>}</div>
            {g.tasks.map((t) => (
              <div key={t.id} className="tcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} onClick={() => onOpen(t.id)}>
                <div className="row small faint"><TypeBadge t={t} /><KeyChip t={t} /><span className="ellipsis grow">{engine.get('lists', t.listId)?.name}</span></div>
                <div style={{ fontWeight: 500, margin: '4px 0' }}>{t.title}</div>
                <div className="row wrap">{t.tags.slice(0, 3).map((x) => <Tag key={x} t={x} />)}<PinnedFields t={t} /></div>
                <div className="row" style={{ marginTop: 6 }}>
                  <Avatars ids={t.assigneeIds} size={20} />
                  <span className={`small ${isOverdue(engine, t) ? 'red' : 'muted'}`}>{fmtDate(t.dueDate)}</span>
                  <span className="right"><Flag p={t.priority} /></span>
                </div>
              </div>
            ))}
            {!g.tasks.length && <div className="small faint" style={{ padding: 10, textAlign: 'center' }}>Drop tasks here</div>}
          </div>
        );
      })}
    </div>
  );
}

function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); return startOfDay(d); });
  const first = new Date(month);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const todayT = startOfDay().getTime();
  return (
    <div>
      <div className="toolbar">
        <button className="btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
        <button className="btn" onClick={() => { const d = new Date(); d.setDate(1); setMonth(startOfDay(d)); }}>Today</button>
        <button className="btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
        <h2>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="d small muted" style={{ minHeight: 0, textAlign: 'center' }}>{d}</div>)}
        {days.map((d) => {
          const items = tasks.filter((t) => t.dueDate && startOfDay(new Date(t.dueDate)).getTime() === d.getTime());
          return (
            <div key={d.toISOString()} className={`d ${d.getMonth() !== month.getMonth() ? 'out' : ''} ${d.getTime() === todayT ? 'today' : ''}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { const id = e.dataTransfer.getData('text/plain'); updateTask(engine, id, (t) => { t.dueDate = iso(d); }); }}>
              <span className="n">{d.getDate()}</span>
              {items.map((t) => {
                const c = statusOf(engine, t)?.colorHex ?? '#888';
                return <div key={t.id} className="ev" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} style={{ background: c + '26' }} onClick={() => onOpen(t.id)}>{t.title}</div>;
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [sort, setSort] = useState<string>('due');
  const [editFields, setEditFields] = useState(false);
  const [calc, setCalc] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem('table.calc') || '{}'); } catch { return {}; } });
  const setCalcFor = (n: string, v: string) => { const next = { ...calc, [n]: v }; setCalc(next); try { localStorage.setItem('table.calc', JSON.stringify(next)); } catch { /* private mode */ } };
  const showKey = tasks.some((t) => taskKey(engine, t));
  const showType = tasks.some((t) => engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.taskTypes?.length);
  // Custom-field columns: the fields of every space shown, once each.
  const spaces = [...new Map(tasks.map((t) => engine.get('spaces', engine.get('lists', t.listId)?.spaceId)).filter(Boolean).map((sp) => [sp!.id, sp!])).values()];
  const fields = spaces.flatMap((sp) => sp.fields);
  const fieldOf = (t: Task, name: string) => engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.fields.find((f) => f.name === name);
  const names = [...new Set(fields.map((f) => f.name))];
  const cell = (t: Task, name: string) => { const f = fieldOf(t, name); return f ? fieldDisplay(engine, t, f) : ''; };
  const sorted = [...tasks].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'priority') return b.priority - a.priority;
    if (sort.startsWith('f:')) {
      const x = cell(a, sort.slice(2)), y = cell(b, sort.slice(2));
      const nx = parseFloat(x), ny = parseFloat(y);
      return !isNaN(nx) && !isNaN(ny) ? ny - nx : x.localeCompare(y);
    }
    return (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9');
  });
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      {spaces.length === 1 && engine.canWrite && (
        <div className="row" style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
          <span className="small muted grow">{fields.length ? `${fields.length} custom field${fields.length === 1 ? '' : 's'}` : 'Add custom fields (numbers, money, people, formulas…) as extra columns'}</span>
          <button className="btn sm" onClick={() => setEditFields(true)}>⚙ Fields</button>
        </div>
      )}
      <table className="t">
        <thead><tr>
          {showKey && <th>ID</th>}{showType && <th>Type</th>}
          <th onClick={() => setSort('title')} style={{ cursor: 'pointer' }}>Name</th><th>Status</th><th>Assignees</th>
          <th onClick={() => setSort('priority')} style={{ cursor: 'pointer' }}>Priority</th><th>Start</th>
          <th onClick={() => setSort('due')} style={{ cursor: 'pointer' }}>Due</th><th className="num">Estimate</th><th>Tags</th><th>List</th>
          {names.map((n) => <th key={n} onClick={() => setSort('f:' + n)} style={{ cursor: 'pointer' }}>{n}</th>)}
        </tr></thead>
        <tbody>{sorted.map((t) => (
          <tr key={t.id} className="click" onClick={() => onOpen(t.id)}>
            {showKey && <td className="mono small muted">{taskKey(engine, t) ?? ''}</td>}{showType && <td className="small">{taskTypeOf(engine, t) ? `${taskTypeOf(engine, t)!.icon} ${taskTypeOf(engine, t)!.name}` : '✓ Task'}</td>}
            <td>{t.title}</td><td><StatusPill s={statusOf(engine, t)} /></td><td><Avatars ids={t.assigneeIds} size={18} /></td>
            <td><Flag p={t.priority} /> {PRIORITIES.find((p) => p.value === t.priority)?.label}</td>
            <td>{fmtDate(t.startDate)}</td><td className={isOverdue(engine, t) ? 'red' : ''}>{fmtDate(t.dueDate)}</td>
            <td className="num">{t.estimateMinutes ? `${Math.round(t.estimateMinutes / 6) / 10}h` : ''}</td>
            <td>{t.tags.map((x) => <Tag key={x} t={x} />)}</td><td className="muted">{engine.get('lists', t.listId)?.name}</td>
            {names.map((n) => {
              const f = fieldOf(t, n); const v = cell(t, n);
              return <td key={n} className={f && (['number', 'money', 'formula', 'progress'].includes(f.type)) ? 'num' : ''} style={f && isComputedField(f) ? { color: v.startsWith('#') ? 'var(--red)' : 'var(--muted)' } : undefined}>{v}</td>;
            })}
          </tr>
        ))}</tbody>
        {names.some((n) => fields.some((f) => f.name === n && ['number', 'money', 'formula'].includes(f.type))) && (
          <tfoot><tr><td colSpan={9 + (showKey ? 1 : 0) + (showType ? 1 : 0)} className="small muted">Calculate</td>
            {names.map((n) => {
              const numeric = fields.some((f) => f.name === n && ['number', 'money', 'formula', 'progress', 'rating'].includes(f.type));
              if (!numeric) return <td key={n} />;
              const vals = sorted.map((t) => parseFloat(cell(t, n))).filter((x) => !isNaN(x));
              const how = calc[n] ?? 'sum';
              const r = !vals.length ? undefined : how === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : how === 'min' ? Math.min(...vals) : how === 'max' ? Math.max(...vals) : how === 'count' ? vals.length : vals.reduce((a, b) => a + b, 0);
              return (
                <td key={n} className="num small">
                  <select className="plain small muted" value={how} onChange={(e) => setCalcFor(n, e.target.value)} title="Calculation">
                    <option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option><option value="count">Count</option>
                  </select>{' '}<strong>{r === undefined ? '—' : Math.round(r * 100) / 100}</strong>
                </td>
              );
            })}</tr></tfoot>
        )}
      </table>
      {editFields && spaces[0] && <FieldsEditor space={spaces[0]} onClose={() => setEditFields(false)} />}
    </div>
  );
}

/** Timeline with dependency-aware critical path and saved baselines (planned dates) under each bar. */
function GanttView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine, toast } = useApp();
  const [showCritical, setShowCritical] = useState(true);
  const [showBaseline, setShowBaseline] = useState(true);
  const dated = tasks.filter((t) => t.startDate || t.dueDate);
  const critical = useMemo(() => criticalPath(dated), [engine.version, tasks.length]);
  const hasBaseline = dated.some((t) => t.baselineStart || t.baselineDue);
  const dates = dated.flatMap((t) => [t.startDate, t.dueDate, showBaseline ? t.baselineStart : undefined, showBaseline ? t.baselineDue : undefined].filter(Boolean).map((d) => new Date(d!).getTime()));
  const start = addDays(startOfDay(new Date(Math.min(Date.now(), ...dates))), -3);
  const end = addDays(startOfDay(new Date(Math.max(Date.now(), ...dates))), 10);
  const dayW = 30, rowH = 34;
  const days = Math.max(21, Math.round((end.getTime() - start.getTime()) / 86400000));
  const x = (d: string) => Math.round((startOfDay(new Date(d)).getTime() - start.getTime()) / 86400000) * dayW;
  const slip = (t: Task) => t.baselineDue && t.dueDate ? Math.round((startOfDay(new Date(t.dueDate)).getTime() - startOfDay(new Date(t.baselineDue)).getTime()) / 86400000) : 0;
  const saveBaseline = () => {
    if (hasBaseline && !confirm('Replace the saved baseline with the current dates of these tasks?')) return;
    for (const t of dated) engine.update('tasks', t.id, (y) => {
      if (y.startDate) y.baselineStart = y.startDate; else delete y.baselineStart;
      if (y.dueDate) y.baselineDue = y.dueDate; else delete y.baselineDue;
    });
    toast(`Baseline saved for ${dated.length} task${dated.length === 1 ? '' : 's'}`);
  };
  const clearBaseline = () => { if (confirm('Remove the baseline from these tasks?')) for (const t of dated) engine.update('tasks', t.id, (y) => { delete y.baselineStart; delete y.baselineDue; }); };
  if (!dated.length) return <Empty icon="📊" title="No dated tasks" sub="Give tasks start or due dates to see them on the timeline." />;
  const index = new Map(dated.map((t, i) => [t.id, i]));
  const late = dated.filter((t) => slip(t) > 0).length;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap">
        <label className="row small"><input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} /> Critical path {critical.size > 0 && <span className="muted">({critical.size})</span>}</label>
        <label className="row small"><input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Baseline</label>
        {hasBaseline && <span className={`small ${late ? 'red' : 'green'}`}>{late ? `${late} task${late === 1 ? '' : 's'} behind baseline` : 'On baseline'}</span>}
        <span className="right" />
        {engine.canWrite && <button className="btn sm" onClick={saveBaseline}>📌 Save baseline</button>}
        {engine.canWrite && hasBaseline && <button className="btn sm ghost" onClick={clearBaseline}>Clear baseline</button>}
      </div>
      <div className="gantt" style={{ height: 40 + dated.length * rowH }}>
        <div style={{ position: 'relative', width: days * dayW + 220, height: '100%' }}>
          {Array.from({ length: days }, (_, i) => {
            const d = addDays(start, i);
            return <div key={i} className="small faint" style={{ position: 'absolute', left: 220 + i * dayW, top: 0, width: dayW, height: '100%', borderLeft: '1px solid var(--line)', textAlign: 'center', background: d.getDay() % 6 === 0 ? 'var(--hover)' : undefined }}>{d.getDate()}</div>;
          })}
          <div style={{ position: 'absolute', left: 220 + x(iso()) + dayW / 2, top: 20, bottom: 0, width: 2, background: 'var(--red)' }} />
          <svg style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} width={days * dayW + 220} height={40 + dated.length * rowH}>
            {dated.flatMap((t) => t.blockedBy.filter((p) => index.has(p)).map((p) => {
              const pt = dated[index.get(p)!];
              const x1 = 220 + x(pt.dueDate ?? pt.startDate!) + dayW, y1 = 38 + index.get(p)! * rowH;
              const x2 = 220 + x(t.startDate ?? t.dueDate!), y2 = 38 + index.get(t.id)! * rowH;
              const hot = showCritical && critical.has(t.id) && critical.has(p);
              return <path key={p + t.id} d={`M${x1},${y1} C${x1 + 14},${y1} ${x2 - 14},${y2} ${x2},${y2}`} fill="none" stroke={hot ? 'var(--red)' : 'var(--muted)'} strokeWidth={hot ? 2 : 1} markerEnd="url(#arr)" />;
            }))}
            <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="var(--muted)" /></marker></defs>
          </svg>
          {dated.map((t, i) => {
            const s = t.startDate ?? t.dueDate!, e = t.dueDate ?? t.startDate!;
            const c = statusOf(engine, t)?.colorHex ?? '#7B68EE';
            const bs = t.baselineStart ?? t.baselineDue, be = t.baselineDue ?? t.baselineStart;
            const hot = showCritical && critical.has(t.id);
            const d = slip(t);
            return (
              <div key={t.id}>
                <div className="ellipsis small" style={{ position: 'absolute', left: 8, width: 205, top: 30 + i * rowH, color: hot ? 'var(--red)' : undefined, fontWeight: hot ? 600 : undefined }}>{t.title}</div>
                {showBaseline && bs && be && <div title={`Baseline ${new Date(bs).toLocaleDateString()} → ${new Date(be).toLocaleDateString()}`} style={{ position: 'absolute', left: 220 + x(bs), top: 50 + i * rowH, width: Math.max(dayW, x(be) - x(bs) + dayW), height: 5, borderRadius: 3, background: 'var(--muted)', opacity: 0.45 }} />}
                <div className="bar" style={{ left: 220 + x(s), top: 26 + i * rowH, width: Math.max(dayW, x(e) - x(s) + dayW), background: c, outline: hot ? '2px solid var(--red)' : undefined }} onClick={() => onOpen(t.id)}
                  title={`${t.title}${hot ? ' · on the critical path' : ''}${d ? ` · ${d > 0 ? `${d} day${d === 1 ? '' : 's'} late` : `${-d} day${d === -1 ? '' : 's'} early`} vs baseline` : ''}`}>{t.title}</div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="small muted">The critical path is the longest chain of dependent tasks (set them under Dependencies in a task): a delay on any of them delays the end of the whole chain. A baseline keeps today's planned dates so later slips show as the gap between the bar and the grey line.</p>
    </div>
  );
}

// ---------------------------------------------------------------- task drawer

export function TaskDrawer({ id, onClose }: { id: ID; onClose: () => void }) {
  const { engine, openTask, toast } = useApp();
  const t = engine.get('tasks', id);
  const [sub, setSub] = useState('');
  const [tag, setTag] = useState('');
  const [edit, setEdit] = useState(false);
  if (!t) return null;
  const up = (fn: (x: Task) => void) => updateTask(engine, id, fn);
  const statuses = statusesFor(engine, t);
  const subs = engine.list('tasks').filter((x) => x.parentId === id && !x.archived);
  const viewers = engine.presence.filter((p) => p.viewing === `task:${id}` && p.user_id !== engine.me);
  const list = engine.get('lists', t.listId);
  const space = engine.get('spaces', list?.spaceId);
  const entries = engine.list('timeEntries').filter((e) => e.taskId === id);
  const tracked = entries.reduce((a, e) => a + ((e.end ? new Date(e.end).getTime() : Date.now()) - new Date(e.start).getTime()), 0) / 3600000;
  const running = entries.find((e) => !e.end && e.memberId === engine.me);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="row" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
          <span className="row grow" style={{ minWidth: 0 }}><TypeBadge t={t} withName /><KeyChip t={t} /><span className="small muted ellipsis">{space?.name} › {list?.name}</span></span>
          {viewers.length > 0 && <span className="row small muted"><Avatars ids={viewers.map((v) => v.user_id)} size={18} /> viewing</span>}
          <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(`mkprod://task/${id}`); toast('Link copied'); }}>Copy link</button>
          <button className="btn sm danger" onClick={() => { trashTask(engine, id); onClose(); }}>Delete</button>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="body">
          {t.parentId && <a href="#" onClick={(e) => { e.preventDefault(); openTask(t.parentId); }} className="small">↖ {engine.get('tasks', t.parentId)?.title}</a>}
          <textarea className="plain" rows={1} style={{ fontSize: 22, fontWeight: 700, width: '100%', resize: 'none' }} value={t.title} onChange={(e) => up((x) => { x.title = e.target.value; })} />
          <div className="props" style={{ marginTop: 10 }}>
            <span className="k">Status</span>
            <select className="input" value={t.statusId} onChange={(e) => { const v = e.target.value; if (confirmStatusChange(engine, t, v)) up((x) => { x.statusId = v; }); }}>{statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            {(space?.taskTypes?.length ?? 0) > 0 && <><span className="k">Type</span><TypeSelect t={t} up={up} /></>}
            <span className="k">Lists</span><ListsRow t={t} up={up} />
            <span className="k">Assignees</span>
            <div className="row wrap">
              {engine.members.map((m) => (
                <label key={m.id} className="row small" style={{ gap: 4 }}>
                  <input type="checkbox" checked={t.assigneeIds.includes(m.id)} onChange={(e) => up((x) => { x.assigneeIds = e.target.checked ? [...x.assigneeIds, m.id] : x.assigneeIds.filter((a) => a !== m.id); })} />
                  <Avatar m={m} size={18} />{m.name.split(' ')[0]}
                </label>
              ))}
            </div>
            <span className="k">Priority</span><PrioritySelect value={t.priority} onChange={(v) => up((x) => { x.priority = v; })} />
            <span className="k">Dates</span>
            <div className="row">
              <input type="date" className="input" value={toInputDate(t.startDate)} onChange={(e) => up((x) => { const v = fromInputDate(e.target.value); if (v) x.startDate = v; else delete x.startDate; })} />→
              <input type="date" className="input" value={toInputDate(t.dueDate)} onChange={(e) => up((x) => { const v = fromInputDate(e.target.value); if (v) x.dueDate = v; else delete x.dueDate; })} />
            </div>
            <span className="k">Estimate (min)</span>
            <input className="input" type="number" value={t.estimateMinutes ?? ''} onChange={(e) => up((x) => { if (e.target.value) x.estimateMinutes = Number(e.target.value); else delete x.estimateMinutes; })} />
            <span className="k">Repeat</span>
            <select className="input" value={t.recurrence} onChange={(e) => up((x) => { x.recurrence = e.target.value; })}>{['none', 'daily', 'weekly', 'monthly', 'yearly'].map((r) => <option key={r} value={r}>{r === 'none' ? 'Never' : r}</option>)}</select>
            <span className="k">Tags</span>
            <div className="row wrap">
              {t.tags.map((x) => <span key={x} onClick={() => up((y) => { y.tags = y.tags.filter((z) => z !== x); })} style={{ cursor: 'pointer' }} title="Remove"><Tag t={x} /></span>)}
              <input className="input" placeholder="Add tag" value={tag} style={{ width: 110 }} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tag.trim()) { const v = tag.trim().toLowerCase(); up((x) => { if (!x.tags.includes(v)) x.tags.push(v); }); setTag(''); } }} />
            </div>
            <span className="k">Time</span>
            <div className="row">
              <span className="mono">{tracked.toFixed(1)}h tracked</span>
              {running
                ? <button className="btn sm danger" onClick={() => engine.update('timeEntries', running.id, (x) => { x.end = iso(); })}>■ Stop</button>
                : <button className="btn sm" onClick={() => engine.put('timeEntries', { id: uid(), taskId: id, memberId: engine.me, note: '', start: iso(), billable: false })}>▶ Start timer</button>}
            </div>
          </div>

          <TaskFields t={t} />

          <div className="section">
            <h3>Dependencies</h3>
            {t.blockedBy.map((b) => engine.get('tasks', b)).filter((b): b is Task => !!b).map((b) => (
              <div key={b.id} className="row small" style={{ padding: '2px 0' }}>
                <span className={isClosed(engine, b) ? 'green' : 'orange'}>{isClosed(engine, b) ? '✓' : '⏳'} Waiting on</span>
                <a href="#" className="grow" onClick={(e) => { e.preventDefault(); openTask(b.id); }}>{b.title}</a>
                <button className="btn ghost sm" onClick={() => up((x) => { x.blockedBy = x.blockedBy.filter((y) => y !== b.id); })}>✕</button>
              </div>
            ))}
            {engine.list('tasks').filter((x) => x.blockedBy.includes(id) && !x.archived).map((x) => (
              <div key={x.id} className="row small" style={{ padding: '2px 0' }}><span className="muted">⛔ Blocking</span><a href="#" className="grow" onClick={(e) => { e.preventDefault(); openTask(x.id); }}>{x.title}</a></div>
            ))}
            <select className="input" style={{ width: '100%', marginTop: 4 }} value="" onChange={(e) => e.target.value && up((x) => { if (!x.blockedBy.includes(e.target.value)) x.blockedBy.push(e.target.value); })}>
              <option value="">+ Waiting on another task…</option>
              {engine.list('tasks').filter((x) => !x.archived && x.id !== id && !t.blockedBy.includes(x.id) && engine.get('lists', x.listId)?.spaceId === list?.spaceId)
                .sort((a, b) => a.title.localeCompare(b.title)).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </div>

          <div className="section">
            <div className="row"><h3 className="grow">Description</h3><button className="btn sm ghost" onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit'}</button></div>
            {edit || !t.details
              ? <textarea className="input" style={{ width: '100%', minHeight: 120, marginTop: 6 }} value={t.details} placeholder="Markdown supported" onChange={(e) => up((x) => { x.details = e.target.value; })} />
              : <Markdown text={t.details} />}
          </div>

          <div className="section">
            <h3>Subtasks {subs.length > 0 && <span className="muted small">{subs.filter((s) => isClosed(engine, s)).length}/{subs.length}</span>}</h3>
            {subs.map((s) => (
              <div key={s.id} className="row" style={{ padding: '4px 0' }}>
                <span className="check" style={{ color: statusOf(engine, s)?.colorHex }} onClick={() => toggleDone(engine, s)}>{isClosed(engine, s) ? '✓' : ''}</span>
                <a href="#" className="grow" onClick={(e) => { e.preventDefault(); openTask(s.id); }} style={{ color: 'var(--text)', textDecoration: isClosed(engine, s) ? 'line-through' : undefined }}>{s.title}</a>
                <Avatars ids={s.assigneeIds} size={18} />
              </div>
            ))}
            <input className="input" style={{ width: '100%', marginTop: 4 }} placeholder="+ Add subtask" value={sub} onChange={(e) => setSub(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && sub.trim()) { const n = newTask(t.listId, sub.trim(), statuses[0]?.id ?? t.statusId, member(engine, engine.me)); n.parentId = id; engine.put('tasks', n); setSub(''); } }} />
          </div>

          <div className="section">
            <div className="row"><h3 className="grow">Checklists</h3><button className="btn sm" onClick={() => up((x) => { x.checklists.push({ id: uid(), name: 'Checklist', items: [] }); })}>+ Checklist</button></div>
            {t.checklists.map((c, ci) => (
              <div key={c.id} className="card" style={{ padding: 10, marginTop: 8 }}>
                <div className="row"><input className="plain grow" style={{ fontWeight: 600 }} value={c.name} onChange={(e) => up((x) => { x.checklists[ci].name = e.target.value; })} />
                  <button className="btn sm ghost" onClick={() => up((x) => { x.checklists.splice(ci, 1); })}>🗑</button></div>
                {c.items.map((it, ii) => (
                  <label key={it.id} className="row" style={{ padding: '2px 0' }}>
                    <input type="checkbox" checked={it.done} onChange={() => up((x) => { x.checklists[ci].items[ii].done = !it.done; })} />
                    <span className="grow" style={{ textDecoration: it.done ? 'line-through' : undefined }}>{it.text}</span>
                    <button className="btn sm ghost" onClick={(e) => { e.preventDefault(); up((x) => { x.checklists[ci].items.splice(ii, 1); }); }}>✕</button>
                  </label>
                ))}
                <input className="input" style={{ width: '100%' }} placeholder="Add item" onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (e.key === 'Enter' && v) { up((x) => { x.checklists[ci].items.push({ id: uid(), text: v, done: false }); }); (e.target as HTMLInputElement).value = ''; }
                }} />
              </div>
            ))}
          </div>

          <Attachments items={t.attachments} onChange={(fn) => up((x) => { fn(x.attachments); })} />

          <CommentsSection t={t} up={up} />

          <TimeInStatus t={t} />

          <div className="section">
            <h3>Activity</h3>
            {[...t.activity].reverse().slice(0, 30).map((a) => <div key={a.id} className="row small" style={{ padding: '2px 0' }}><span className="grow">{a.text}</span><span className="muted">{new Date(a.date).toLocaleString()}</span></div>)}
          </div>
        </div>
      </aside>
    </>
  );
}
