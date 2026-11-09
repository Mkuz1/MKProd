import { useState } from 'react';
import { Comment, ID, SavedView, Space, StatusKind, Task, TaskTypeDef, addDays, iso, startOfDay, uid, PALETTE } from '../model';
import { Avatar, Empty, Markdown, Modal, StatusPill, member, statusOf, useApp } from '../ui';
import { FieldsEditor } from './Advanced';
import { assignTaskNumbers, clearDefault, fmtDuration, isClosedTask, saveView, taskKey, taskTypeOf, timeInStatus, viewsFor } from '../work';
import type { SyncEngine } from '../sync';

// ---------------------------------------------------------------- small chips

export function TypeBadge({ t, withName }: { t: Task; withName?: boolean }) {
  const { engine } = useApp();
  const ty = taskTypeOf(engine, t);
  if (!ty) return null;
  return <span className="type-badge" title={ty.name} style={{ color: ty.colorHex, background: ty.colorHex + '1f' }}>{ty.icon}{withName && <span>{ty.name}</span>}</span>;
}

export function KeyChip({ t }: { t: Task }) {
  const { engine, toast } = useApp();
  const k = taskKey(engine, t);
  if (!k) return null;
  return <span className="key-chip" title="Copy task ID" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(k); toast(`Copied ${k}`); }}>{k}</span>;
}

// ---------------------------------------------------------------- views bar

export type ViewState = { mode: string; groupBy: string; sortBy: string; filter: SavedView['filter'] };

/** Saved views of this location as tabs: click to apply, ⋯ to rename, make default, share or delete. */
export function ViewsBar({ scope, active, current, onApply, onClear }: {
  scope: string; active?: ID; current: ViewState; onApply: (v: SavedView) => void; onClear: () => void
}) {
  const { engine, toast } = useApp();
  const views = viewsFor(engine, scope);
  const [menu, setMenu] = useState<ID | null>(null);
  const [saving, setSaving] = useState(false);
  const activeView = views.find((v) => v.id === active);
  const dirty = !!activeView && JSON.stringify({ mode: activeView.mode, groupBy: activeView.groupBy, sortBy: activeView.sortBy, filter: activeView.filter }) !== JSON.stringify(current);
  const kindOf = (v: { private: boolean }) => (v.private ? 'privateViews' : 'views') as 'views' | 'privateViews';
  const mine = (v: SavedView & { private: boolean }) => v.private || v.ownerId === engine.me || engine.isAdmin;
  return (
    <div className="views-bar" onClick={() => setMenu(null)}>
      <button className={`vtab ${!active ? 'on' : ''}`} onClick={onClear} title="Start from the default settings">All tasks</button>
      {views.map((v) => (
        <div key={v.id} className={`vtab ${active === v.id ? 'on' : ''}`} onClick={() => onApply(v)}>
          {v.private && <span title="Private: only you see it">🔒</span>}
          {v.isDefault && <span title="Opens first here">★</span>}
          <span className="ellipsis">{v.name}</span>
          {active === v.id && dirty && <span className="dot" title="Changed since saved" />}
          <button className="btn ghost sm more" onClick={(e) => { e.stopPropagation(); setMenu(menu === v.id ? null : v.id); }}>⋯</button>
          {menu === v.id && (
            <div className="menu" style={{ top: 'calc(100% + 4px)', left: 0 }} onClick={(e) => e.stopPropagation()}>
              {dirty && active === v.id && mine(v) && <div className="item" onClick={() => { engine.update(kindOf(v), v.id, (x) => Object.assign(x, current)); setMenu(null); toast('View updated'); }}>💾 Save changes to this view</div>}
              {mine(v) && <div className="item" onClick={() => { const n = prompt('Rename view', v.name)?.trim(); if (n) engine.update(kindOf(v), v.id, (x) => { x.name = n; }); setMenu(null); }}>✏️ Rename</div>}
              <div className="item" onClick={() => {
                if (v.isDefault) engine.update(kindOf(v), v.id, (x) => { x.isDefault = false; });
                else { clearDefault(engine, scope, v.id); engine.update(kindOf(v), v.id, (x) => { x.isDefault = true; }); }
                setMenu(null);
              }}>{v.isDefault ? '☆ Stop opening first' : '★ Open this view first'}</div>
              <div className="item" onClick={() => { const { private: p, ...rest } = v; saveView(engine, { ...rest, id: undefined, name: `${v.name} copy`, isDefault: false }, p); setMenu(null); }}>⧉ Duplicate</div>
              {mine(v) && <div className="item" onClick={() => {
                const { private: p, ...rest } = v;
                engine.remove(kindOf(v), v.id);
                engine.put(p ? 'views' : 'privateViews', { ...rest });
                setMenu(null); toast(p ? 'Shared with the workspace' : 'Now private to you');
              }}>{v.private ? '👥 Share with the workspace' : '🔒 Make private'}</div>}
              {mine(v) && <div className="item danger" onClick={() => { if (confirm(`Delete the view “${v.name}”?`)) { engine.remove(kindOf(v), v.id); if (active === v.id) onClear(); } setMenu(null); }}>🗑 Delete view</div>}
            </div>
          )}
        </div>
      ))}
      {engine.canWrite && <button className="vtab add" onClick={(e) => { e.stopPropagation(); setSaving(true); }} title="Save the current view, filters and grouping">＋ Save view</button>}
      {saving && <SaveViewModal scope={scope} current={current} onClose={() => setSaving(false)} onSaved={(v) => { setSaving(false); onApply(v); toast(`Saved “${v.name}”`); }} />}
    </div>
  );
}

function SaveViewModal({ scope, current, onClose, onSaved }: { scope: string; current: ViewState; onClose: () => void; onSaved: (v: SavedView) => void }) {
  const { engine } = useApp();
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [isDefault, setDefault] = useState(false);
  const save = () => { if (name.trim()) onSaved(saveView(engine, { name: name.trim(), scope, ...current, isDefault }, isPrivate)); };
  return (
    <Modal title="Save view" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={save}>Save view</button></>}>
      <label className="field">Name<input className="input" autoFocus value={name} placeholder="e.g. My open bugs" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></label>
      <p className="small muted">Keeps the view type ({current.mode}), grouping, sorting and filters{current.filter.search ? ` (search “${current.filter.search}”)` : ''}.</p>
      <label className="row"><input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Private: only you see it (encrypted with your own key)</label>
      <label className="row"><input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} /> Open this view first here</label>
    </Modal>
  );
}

// ---------------------------------------------------------------- space settings

const KINDS: { value: StatusKind; label: string }[] = [{ value: 'open', label: 'Not started' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Done' }, { value: 'closed', label: 'Closed' }];
const TYPE_ICONS = ['🐞', '✨', '🧩', '📣', '🤝', '📅', '📦', '🧪', '🛠', '🎯', '📄', '💡'];

/** Everything about a space in one place: name, statuses with WIP limits, task types, task IDs, scheduling, fields. */
export function SpaceSettings({ spaceId, onClose }: { spaceId: ID; onClose: () => void }) {
  const { engine, toast } = useApp();
  const s = engine.get('spaces', spaceId);
  const [fields, setFields] = useState(false);
  if (!s) return null;
  const up = (fn: (x: Space) => void) => engine.update('spaces', spaceId, fn);
  const taskCount = (statusId: ID) => engine.list('tasks').filter((t) => t.statusId === statusId && !t.archived).length;
  return (
    <Modal title={`Space settings · ${s.name}`} wide onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="grid g2">
        <label className="field">Name<input className="input" value={s.name} onChange={(e) => up((x) => { x.name = e.target.value; })} /></label>
        <div className="field">Colour<div className="row wrap">{PALETTE.map((c) => <button key={c} className={`swatch ${s.colorHex === c ? 'on' : ''}`} style={{ background: c }} onClick={() => up((x) => { x.colorHex = c; })} aria-label={c} />)}</div></div>
      </div>

      <h3 style={{ marginTop: 14 }}>Statuses</h3>
      <p className="small muted">A work-in-progress limit flags a Board column or List group when it holds more open tasks than that.</p>
      <table className="t"><tbody>{s.statuses.map((st, i) => (
        <tr key={st.id}>
          <td style={{ width: 34 }}><input type="color" value={st.colorHex} onChange={(e) => up((x) => { x.statuses[i].colorHex = e.target.value.toUpperCase(); })} style={{ width: 26, height: 26, border: 'none', background: 'none', padding: 0 }} /></td>
          <td><input className="input" style={{ width: '100%' }} value={st.name} onChange={(e) => up((x) => { x.statuses[i].name = e.target.value; })} /></td>
          <td style={{ width: 130 }}><select className="input" value={st.kind} onChange={(e) => up((x) => { x.statuses[i].kind = e.target.value as StatusKind; })}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></td>
          <td style={{ width: 120 }}><input className="input" type="number" min={0} placeholder="No limit" style={{ width: '100%' }} value={st.wipLimit ?? ''} title="Work-in-progress limit"
            onChange={(e) => up((x) => { const n = Math.floor(Number(e.target.value)); if (e.target.value && n > 0) x.statuses[i].wipLimit = n; else delete x.statuses[i].wipLimit; })} /></td>
          <td className="num" style={{ width: 100 }}>
            <button className="btn ghost sm" disabled={i === 0} onClick={() => up((x) => { [x.statuses[i - 1], x.statuses[i]] = [x.statuses[i], x.statuses[i - 1]]; })}>↑</button>
            <button className="btn ghost sm" disabled={s.statuses.length <= 1 || taskCount(st.id) > 0} title={taskCount(st.id) ? 'Move its tasks to another status first' : 'Delete'} onClick={() => up((x) => { x.statuses.splice(i, 1); })}>🗑</button>
          </td>
        </tr>
      ))}</tbody></table>
      <button className="btn sm" onClick={() => up((x) => { const at = Math.max(x.statuses.findIndex((y) => y.kind === 'done'), 0) || x.statuses.length; x.statuses.splice(at, 0, { id: uid(), name: 'New status', colorHex: PALETTE[x.statuses.length % PALETTE.length], kind: 'active' }); })}>＋ Status</button>

      <h3 style={{ marginTop: 14 }}>Task types</h3>
      <p className="small muted">Tasks can represent different kinds of work (bugs, clients, events…). Each type shows its icon on rows and cards, and you can filter and chart by it.</p>
      {(s.taskTypes ?? []).map((ty, i) => (
        <div key={ty.id} className="row" style={{ padding: '3px 0' }}>
          <select className="input" value={ty.icon} onChange={(e) => up((x) => { x.taskTypes![i].icon = e.target.value; })} style={{ width: 64 }}>{TYPE_ICONS.map((ic) => <option key={ic}>{ic}</option>)}</select>
          <input className="input grow" value={ty.name} onChange={(e) => up((x) => { x.taskTypes![i].name = e.target.value; })} />
          <input type="color" value={ty.colorHex} onChange={(e) => up((x) => { x.taskTypes![i].colorHex = e.target.value.toUpperCase(); })} style={{ width: 30, height: 28, border: 'none', background: 'none' }} />
          <button className="btn ghost sm" onClick={() => up((x) => { x.taskTypes!.splice(i, 1); })}>🗑</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => up((x) => { const t: TaskTypeDef = { id: uid(), name: 'Bug', icon: TYPE_ICONS[(x.taskTypes?.length ?? 0) % TYPE_ICONS.length], colorHex: PALETTE[((x.taskTypes?.length ?? 0) + 4) % PALETTE.length] }; x.taskTypes = [...(x.taskTypes ?? []), t]; })}>＋ Task type</button>

      <h3 style={{ marginTop: 14 }}>Task IDs</h3>
      <div className="row wrap">
        <input className="input mono" style={{ width: 120, textTransform: 'uppercase' }} maxLength={10} placeholder="e.g. ENG" value={s.idPrefix ?? ''}
          onChange={(e) => up((x) => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v && /^[A-Z]/.test(v)) x.idPrefix = v; else delete x.idPrefix; })} />
        <span className="small muted grow">Tasks show <span className="key-chip">{s.idPrefix || 'ENG'}-42</span>, numbered in the order they were created. Search finds a task by its ID.</span>
        {s.idPrefix && <button className="btn sm" onClick={() => { assignTaskNumbers(engine); toast('Task IDs assigned'); }}>Number tasks now</button>}
      </div>

      <h3 style={{ marginTop: 14 }}>Scheduling</h3>
      <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" style={{ marginTop: 3 }} checked={!!s.rescheduleDependencies} onChange={(e) => up((x) => { if (e.target.checked) x.rescheduleDependencies = true; else delete x.rescheduleDependencies; })} />
        <span>Reschedule dependencies<div className="small muted">When a task's due date moves, the tasks waiting on it move by the same number of days (and the tasks waiting on those).</div></span></label>
      <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" style={{ marginTop: 3 }} checked={!!s.remapSubtasks} onChange={(e) => up((x) => { if (e.target.checked) x.remapSubtasks = true; else delete x.remapSubtasks; })} />
        <span>Move subtasks with their parent<div className="small muted">When a task's due date moves, its open subtasks move too. Closed subtasks stay put.</div></span></label>

      <h3 style={{ marginTop: 14 }}>Custom fields</h3>
      <div className="row"><span className="small muted grow">{s.fields.length} field{s.fields.length === 1 ? '' : 's'}{s.fields.some((f) => f.required) ? ` · ${s.fields.filter((f) => f.required).length} required` : ''}{s.fields.some((f) => f.pinned) ? ` · ${s.fields.filter((f) => f.pinned).length} pinned` : ''}</span><button className="btn sm" onClick={() => setFields(true)}>Edit fields…</button></div>
      {fields && <FieldsEditor space={s} onClose={() => setFields(false)} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Activity view

/** Everything that happened to the tasks in view, newest first, grouped by day. */
export function ActivityView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [days, setDays] = useState(14);
  const since = addDays(startOfDay(), -days).toISOString();
  const all = engine.list('tasks');
  const ids = new Set(tasks.map((t) => t.id));
  // Subtasks of tasks in view count too.
  const inView = all.filter((t) => ids.has(t.id) || (t.parentId && ids.has(t.parentId)));
  const entries = inView.flatMap((t) => [
    ...t.activity.filter((a) => a.date >= since).map((a) => ({ id: a.id, date: a.date, text: a.text, t, who: undefined as ID | undefined })),
    ...t.comments.filter((c) => c.date >= since).map((c) => ({ id: c.id, date: c.date, text: `💬 ${c.text.slice(0, 140)}${c.text.length > 140 ? '…' : ''}`, t, who: c.authorId })),
  ]).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 400);
  const byDay = new Map<string, typeof entries>();
  for (const e of entries) { const k = new Date(e.date).toDateString(); byDay.set(k, [...(byDay.get(k) ?? []), e]); }
  return (
    <div className="card col">
      <div className="row"><h3 className="grow">Activity</h3>
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>Today</option><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={365}>Last year</option></select></div>
      {!entries.length && <Empty icon="🕊" title="Nothing happened here yet" sub="Changes and comments on these tasks appear here." />}
      {[...byDay.entries()].map(([day, es]) => (
        <div key={day}>
          <div className="small muted" style={{ fontWeight: 700, margin: '10px 0 4px' }}>{new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
          {es.map((e) => (
            <div key={e.id} className="act-row" onClick={() => onOpen(e.t.id)}>
              {e.who ? <Avatar m={member(engine, e.who)} size={20} /> : <span className="act-dot" style={{ background: statusOf(engine, e.t)?.colorHex ?? 'var(--accent)' }} />}
              <span className="grow"><span className="ellipsis" style={{ display: 'block' }}>{e.text}</span><span className="small muted">{e.t.title}</span></span>
              <span className="small faint">{new Date(e.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Team view

/** One card per person: what they're working on, what's overdue, what they finished this week. */
export function TeamView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const weekAgo = addDays(startOfDay(), -7).toISOString();
  const today = startOfDay();
  const people = [...engine.members, { id: '', name: 'Unassigned', email: '', colorHex: '#B0B7C3' }];
  const col = (label: string, ts: Task[], tone?: string) => (
    <div className="team-col">
      <div className="small" style={{ fontWeight: 700, color: tone ?? 'var(--muted)' }}>{label} · {ts.length}</div>
      {ts.slice(0, 8).map((t) => <div key={t.id} className="team-task" onClick={() => onOpen(t.id)}><StatusPill s={statusOf(engine, t)} /><span className="ellipsis">{t.title}</span></div>)}
      {ts.length > 8 && <div className="small faint">+{ts.length - 8} more</div>}
    </div>
  );
  return (
    <div className="team-grid">
      {people.map((m) => {
        const mine = tasks.filter((t) => (m.id ? t.assigneeIds.includes(m.id) : !t.assigneeIds.length));
        if (!m.id && !mine.length) return null;
        const open = mine.filter((t) => !isClosedTask(engine, t));
        const doing = open.filter((t) => statusOf(engine, t)?.kind === 'active');
        const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate) < today);
        const done = mine.filter((t) => isClosedTask(engine, t) && (t.completedAt ?? '') >= weekAgo);
        const hours = open.reduce((a, t) => a + (t.estimateMinutes ?? 0), 0) / 60;
        return (
          <div key={m.id || 'none'} className="card col team-card">
            <div className="row"><Avatar m={m.id ? m : undefined} size={30} /><div className="grow"><strong>{m.name}</strong><div className="small muted">{open.length} open · {hours ? `${Math.round(hours * 10) / 10}h estimated` : 'no estimates'}</div></div>
              {engine.presence.some((p) => p.user_id === m.id) && <span className="online" title="Online" />}</div>
            {col('In progress', doing, 'var(--blue)')}
            {overdue.length > 0 && col('Overdue', overdue, 'var(--red)')}
            {col('Done this week', done, 'var(--green)')}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- comments with threads and reactions

const REACTIONS = ['👍', '❤️', '🎉', '😄', '👀', '✅'];

export function CommentsSection({ t, up }: { t: Task; up: (fn: (x: Task) => void) => void }) {
  const { engine } = useApp();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ID | null>(null);
  const [replyText, setReplyText] = useState('');
  const top = t.comments.filter((c) => !c.parentId || !t.comments.some((p) => p.id === c.parentId));
  const repliesOf = (id: ID) => t.comments.filter((c) => c.parentId === id);
  const add = (body: string, parentId?: ID) => up((x) => {
    const c: Comment = { id: uid(), authorId: engine.me, text: body, date: iso(), resolved: false };
    if (parentId) c.parentId = parentId;
    x.comments.push(c);
    x.activity.push({ id: uid(), date: iso(), text: `${member(engine, engine.me)?.name} ${parentId ? 'replied to a comment' : 'commented'}` });
  });
  const one = (c: Comment, isReply = false) => {
    const i = t.comments.findIndex((x) => x.id === c.id);
    const replies = isReply ? [] : repliesOf(c.id);
    return (
      <div key={c.id} className={`comment ${isReply ? 'reply' : ''}`} style={{ opacity: c.resolved ? 0.55 : 1 }}>
        <Avatar m={member(engine, c.authorId)} size={isReply ? 22 : 26} />
        <div className="grow">
          <div className="row"><strong>{member(engine, c.authorId)?.name ?? 'Unknown'}</strong><span className="small muted">{new Date(c.date).toLocaleString()}</span>
            {c.assigneeId && <span className="small">→ <Avatar m={member(engine, c.assigneeId)} size={16} /></span>}
            <span className="right" />
            {!isReply && <select className="input" style={{ fontSize: 11, padding: '1px 4px' }} value={c.assigneeId ?? ''} title="Assign comment" onChange={(e) => up((x) => { if (e.target.value) x.comments[i].assigneeId = e.target.value; else delete x.comments[i].assigneeId; })}>
              <option value="">Assign…</option>{engine.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>}
            {!isReply && <button className="btn sm ghost" onClick={() => up((x) => { x.comments[i].resolved = !c.resolved; })}>{c.resolved ? 'Reopen' : 'Resolve'}</button>}
          </div>
          <Markdown text={c.text} />
          <div className="row wrap reactions">
            {(c.reactions ?? []).filter((r) => r.memberIds.length).map((r) => (
              <button key={r.emoji} className={`react ${r.memberIds.includes(engine.me) ? 'mine' : ''}`} title={r.memberIds.map((id) => member(engine, id)?.name ?? '?').join(', ')} onClick={() => up((x) => toggleReaction(x.comments[i], r.emoji, engine.me))}>{r.emoji} {r.memberIds.length}</button>
            ))}
            <span className="react-pick">
              <button className="react add" title="React">☺︎＋</button>
              <span className="react-menu">{REACTIONS.map((e) => <button key={e} onClick={() => up((x) => toggleReaction(x.comments[i], e, engine.me))}>{e}</button>)}</span>
            </span>
            {!isReply && <button className="btn ghost sm" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyText(''); }}>↩ Reply{replies.length ? ` · ${replies.length}` : ''}</button>}
          </div>
          {replies.map((r) => one(r, true))}
          {replyTo === c.id && (
            <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
              <textarea className="input grow" rows={1} autoFocus placeholder="Reply…" value={replyText} onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && replyText.trim()) { add(replyText.trim(), c.id); setReplyText(''); setReplyTo(null); } }} />
              <button className="btn primary sm" disabled={!replyText.trim()} onClick={() => { add(replyText.trim(), c.id); setReplyText(''); setReplyTo(null); }}>Reply</button>
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="section">
      <h3>Comments {t.comments.length > 0 && <span className="small muted">{t.comments.length}</span>}</h3>
      {top.map((c) => one(c))}
      <div className="row" style={{ alignItems: 'flex-end', marginTop: 6 }}>
        <textarea className="input grow" rows={2} placeholder="Comment… use @name to mention · ⌘↵ to send" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) { add(text.trim()); setText(''); } }} />
        <button className="btn primary" disabled={!text.trim()} onClick={() => { add(text.trim()); setText(''); }}>Send</button>
      </div>
    </div>
  );
}

function toggleReaction(c: Comment, emoji: string, me: ID) {
  const rs = c.reactions ?? [];
  const r = rs.find((x) => x.emoji === emoji);
  if (!r) rs.push({ emoji, memberIds: [me] });
  else r.memberIds = r.memberIds.includes(me) ? r.memberIds.filter((x) => x !== me) : [...r.memberIds, me];
  c.reactions = rs.filter((x) => x.memberIds.length);
  if (!c.reactions.length) delete c.reactions;
}

// ---------------------------------------------------------------- task panel pieces

export function TimeInStatus({ t }: { t: Task }) {
  const { engine } = useApp();
  const rows = timeInStatus(engine, t);
  const max = Math.max(...rows.map((r) => r.ms), 1);
  return (
    <div className="section">
      <h3>Time in status</h3>
      {rows.map((r) => (
        <div key={r.statusId} className="tis-row">
          <span className="small ellipsis" style={{ width: 110, fontWeight: r.current ? 700 : 400 }}>{r.status?.name ?? 'Removed status'}{r.current ? ' · now' : ''}</span>
          <span className="tis-bar"><span style={{ width: `${(r.ms / max) * 100}%`, background: r.status?.colorHex ?? '#888' }} /></span>
          <span className="small mono" style={{ width: 70, textAlign: 'right' }}>{fmtDuration(r.ms)}</span>
        </div>
      ))}
      {!t.statusLog?.length && <p className="small faint">Counted from when the task was created; every status change from now on is recorded.</p>}
    </div>
  );
}

/** Home list plus the other lists the task also appears in. */
export function ListsRow({ t, up }: { t: Task; up: (fn: (x: Task) => void) => void }) {
  const { engine } = useApp();
  const lists = engine.list('lists').filter((l) => !l.archived);
  const name = (id: ID) => { const l = engine.get('lists', id); return l ? `${engine.get('spaces', l.spaceId)?.name ?? ''} › ${l.name}` : 'Removed list'; };
  return (
    <div className="row wrap">
      <span className="list-chip home" title="Home list">🏠 {name(t.listId)}</span>
      {(t.extraListIds ?? []).map((id) => (
        <span key={id} className="list-chip">{name(id)}<button className="btn ghost sm" onClick={() => up((x) => { x.extraListIds = (x.extraListIds ?? []).filter((y) => y !== id); if (!x.extraListIds.length) delete x.extraListIds; })}>✕</button></span>
      ))}
      <select className="input" value="" style={{ fontSize: 12 }} onChange={(e) => e.target.value && up((x) => { x.extraListIds = [...new Set([...(x.extraListIds ?? []), e.target.value])]; })}>
        <option value="">＋ Also in…</option>
        {lists.filter((l) => l.id !== t.listId && !t.extraListIds?.includes(l.id)).map((l) => <option key={l.id} value={l.id}>{name(l.id)}</option>)}
      </select>
    </div>
  );
}

/** Task type picker for the props grid. */
export function TypeSelect({ t, up }: { t: Task; up: (fn: (x: Task) => void) => void }) {
  const { engine } = useApp();
  const types = engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.taskTypes ?? [];
  return (
    <select className="input" value={t.typeId ?? ''} onChange={(e) => up((x) => { if (e.target.value) x.typeId = e.target.value; else delete x.typeId; })}>
      <option value="">✓ Task</option>
      {types.map((ty) => <option key={ty.id} value={ty.id}>{ty.icon} {ty.name}</option>)}
    </select>
  );
}

export const hasTypes = (engine: SyncEngine, t: Task) => !!engine.get('spaces', engine.get('lists', t.listId)?.spaceId)?.taskTypes?.length;
