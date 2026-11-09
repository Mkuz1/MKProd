import { useState } from 'react';
import { FieldDef, ID, PRIORITIES, Space, Task, addDays, fmtDate, iso, fromInputDate, startOfDay, toInputDate, uid } from '../model';
import { Avatar, Avatars, CHART_COLORS, ChartBox, Empty, Modal, Seg, member, statusOf, useApp } from '../ui';
import {
  FIELD_TYPES, HEALTH_COLORS, ProjectSummary, allocatedHours, customValue, evaluateFormula, fieldDisplay, fmtNumber,
  formulaScope, isComputedField, isWorkingDay, projectSummary, resourceFor, setCustomValue, spaceOf, taskProgress,
} from '../features';
import { updateTask } from './Tasks';
import { taskTypeOf } from '../work';

// ---------------------------------------------------------------- Chart view

type GroupBy = 'status' | 'priority' | 'assignee' | 'tag' | 'list' | 'type' | 'month' | `field:${string}`;
type Metric = 'count' | 'estimate' | 'points' | 'tracked' | `field:${string}`;

/** Bar, donut or line chart of the tasks in the current scope, grouped and summed by any property. */
export function ChartView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: ID) => void }) {
  const { engine } = useApp();
  const [type, setType] = useState<'bar' | 'doughnut' | 'line'>(() => (localStorage.getItem('chart.type') as 'bar') || 'bar');
  const [by, setBy] = useState<GroupBy>(() => (localStorage.getItem('chart.by') as GroupBy) || 'status');
  const [metric, setMetric] = useState<Metric>(() => (localStorage.getItem('chart.metric') as Metric) || 'count');
  const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const fields = [...new Map(tasks.flatMap((t) => spaceOf(engine, t)?.fields ?? []).map((f) => [f.id, f])).values()];
  const groupFields = fields.filter((f) => ['dropdown', 'checkbox', 'people', 'rating', 'text'].includes(f.type));
  const numFields = fields.filter((f) => ['number', 'money', 'rating', 'formula', 'progress'].includes(f.type));

  const keysOf = (t: Task): string[] => {
    if (by === 'status') return [statusOf(engine, t)?.name ?? '—'];
    if (by === 'priority') return [PRIORITIES.find((p) => p.value === t.priority)?.label ?? '—'];
    if (by === 'assignee') return t.assigneeIds.length ? t.assigneeIds.map((a) => member(engine, a)?.name ?? '?') : ['Unassigned'];
    if (by === 'tag') return t.tags.length ? t.tags : ['No tag'];
    if (by === 'list') return [engine.get('lists', t.listId)?.name ?? '—'];
    if (by === 'type') { const ty = taskTypeOf(engine, t); return [ty ? `${ty.icon} ${ty.name}` : '✓ Task']; }
    if (by === 'month') return [t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 7) : 'No due date'];
    const f = fields.find((x) => x.id === by.slice(6));
    if (!f) return ['—'];
    if (f.type === 'people') { const v = customValue(t, f.id); return v ? v.split(',').map((id) => member(engine, id)?.name ?? '?') : ['Nobody']; }
    return [fieldDisplay(engine, t, f) || '(empty)'];
  };
  const valueOf = (t: Task): number => {
    if (metric === 'count') return 1;
    if (metric === 'estimate') return (t.estimateMinutes ?? 0) / 60;
    if (metric === 'points') return t.points ?? 0;
    if (metric === 'tracked') return engine.list('timeEntries').filter((e) => e.taskId === t.id)
      .reduce((a, e) => a + ((e.end ? new Date(e.end).getTime() : Date.now()) - new Date(e.start).getTime()), 0) / 3600_000;
    const f = fields.find((x) => x.id === metric.slice(6));
    if (!f) return 0;
    if (f.type === 'formula') { const r = evaluateFormula(f.options[0] ?? '', formulaScope(engine, t)); return typeof r === 'number' ? r : 0; }
    if (f.type === 'progress') return taskProgress(engine, t);
    return Number(customValue(t, f.id)) || 0;
  };

  const totals = new Map<string, { v: number; ids: ID[] }>();
  for (const t of tasks) {
    const v = valueOf(t);
    for (const k of keysOf(t)) { const g = totals.get(k) ?? { v: 0, ids: [] }; g.v += v; g.ids.push(t.id); totals.set(k, g); }
  }
  let rows = [...totals.entries()];
  if (by === 'month') rows.sort((a, b) => a[0].localeCompare(b[0]));
  else if (by === 'status' || by === 'priority') { /* keep insertion order */ } else rows.sort((a, b) => b[1].v - a[1].v);
  if (by === 'priority') rows = PRIORITIES.map((p) => [p.label, totals.get(p.label)] as const).filter((r) => r[1]).map((r) => [r[0], r[1]!]);
  const colorFor = (k: string, i: number) => {
    if (by === 'status') return engine.list('spaces').flatMap((s) => s.statuses).find((s) => s.name === k)?.colorHex ?? CHART_COLORS[i % CHART_COLORS.length];
    if (by === 'priority') return PRIORITIES.find((p) => p.label === k)?.color ?? '#888';
    return CHART_COLORS[i % CHART_COLORS.length];
  };
  const metricLabel = metric === 'count' ? 'Tasks' : metric === 'estimate' ? 'Estimated hours' : metric === 'points' ? 'Points' : metric === 'tracked' ? 'Tracked hours' : fields.find((f) => f.id === metric.slice(6))?.name ?? '';
  const total = rows.reduce((a, r) => a + r[1].v, 0);

  return (
    <div className="card col">
      <div className="row wrap">
        <Seg value={type} onChange={(v) => { setType(v); keep('chart.type', v); }} options={[{ value: 'bar', label: '📊 Bar' }, { value: 'doughnut', label: '🍩 Donut' }, { value: 'line', label: '📈 Line' }]} />
        <label className="row small">Group by
          <select className="input" value={by} onChange={(e) => { setBy(e.target.value as GroupBy); keep('chart.by', e.target.value); }}>
            <option value="status">Status</option><option value="priority">Priority</option><option value="assignee">Assignee</option>
            <option value="tag">Tag</option><option value="list">List</option><option value="type">Task type</option><option value="month">Due month</option>
            {groupFields.map((f) => <option key={f.id} value={`field:${f.id}`}>{f.name}</option>)}
          </select></label>
        <label className="row small">Measure
          <select className="input" value={metric} onChange={(e) => { setMetric(e.target.value as Metric); keep('chart.metric', e.target.value); }}>
            <option value="count">Number of tasks</option><option value="estimate">Estimated hours</option><option value="points">Points</option><option value="tracked">Tracked hours</option>
            {numFields.map((f) => <option key={f.id} value={`field:${f.id}`}>Sum of {f.name}</option>)}
          </select></label>
        <span className="right small muted">{metricLabel}: <strong>{fmtNumber(Math.round(total * 100) / 100)}</strong></span>
      </div>
      {!rows.length ? <Empty icon="📊" title="Nothing to chart" sub="No tasks match the current filters." /> : (
        <ChartBox height={320} config={{
          type,
          data: { labels: rows.map((r) => r[0]), datasets: [{ label: metricLabel, data: rows.map((r) => Math.round(r[1].v * 100) / 100), backgroundColor: rows.map((r, i) => colorFor(r[0], i)), borderColor: type === 'line' ? '#7B68EE' : undefined, tension: 0.3 }] },
          options: { plugins: { legend: { display: type === 'doughnut' } }, scales: type === 'doughnut' ? undefined : { y: { beginAtZero: true } } },
        }} />
      )}
      <table className="t">
        <thead><tr><th>{by.startsWith('field:') ? fields.find((f) => f.id === by.slice(6))?.name : by[0].toUpperCase() + by.slice(1)}</th><th className="num">{metricLabel}</th><th className="num">Share</th><th /></tr></thead>
        <tbody>{rows.map(([k, g], i) => (
          <tr key={k}><td><span className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: colorFor(k, i) }} />{k}</span></td>
            <td className="num">{fmtNumber(Math.round(g.v * 100) / 100)}</td><td className="num muted">{total ? Math.round((g.v / total) * 100) : 0}%</td>
            <td className="num"><button className="btn ghost sm" onClick={() => onOpen(g.ids[0])} title="Open the first task">↗</button></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- custom fields: editor and values

/** Space settings for custom fields, including formula and the automatic progress field. */
export function FieldsEditor({ space, onClose }: { space: Space; onClose: () => void }) {
  const { engine } = useApp();
  const s = engine.get('spaces', space.id) ?? space;
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const up = (fn: (f: FieldDef[]) => void) => engine.update('spaces', s.id, (x) => { fn(x.fields); });
  const sample = engine.list('tasks').find((t) => !t.archived && engine.get('lists', t.listId)?.spaceId === s.id);
  return (
    <Modal title={`Custom fields · ${s.name}`} onClose={onClose} wide footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <p className="small muted">Fields appear on every task in this space, as Table columns and in Chart view. A formula can use any field in braces, e.g. <code>{'{Cost} * {Quantity}'}</code> or <code>{'IF({Days left} < 0, "Late", "OK")'}</code>. Built-ins: <code>{'{Estimate hours}'}</code> <code>{'{Points}'}</code> <code>{'{Progress}'}</code> <code>{'{Tracked hours}'}</code> <code>{'{Priority}'}</code> <code>{'{Subtasks}'}</code> <code>{'{Days left}'}</code> <code>{'{Start}'}</code> <code>{'{Due}'}</code>; functions IF, ROUND, MIN, MAX, SUM, AVG, ABS, TODAY; <code>&amp;</code> joins text.</p>
      <table className="t"><tbody>
        {s.fields.map((f, i) => (
          <tr key={f.id}>
            <td style={{ width: 180 }}><input className="input" value={f.name} onChange={(e) => up((x) => { x[i].name = e.target.value; })} /></td>
            <td style={{ width: 170 }}><select className="input" value={f.type} onChange={(e) => up((x) => { x[i].type = e.target.value; x[i].options = []; })}>{FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></td>
            <td>
              {f.type === 'dropdown' && <input className="input" style={{ width: '100%' }} placeholder="Options, comma separated" value={f.options.join(', ')} onChange={(e) => up((x) => { x[i].options = e.target.value.split(',').map((o) => o.trim()).filter(Boolean); })} />}
              {f.type === 'formula' && (
                <div className="col" style={{ gap: 2 }}>
                  <input className="input mono" style={{ width: '100%' }} placeholder="{Budget} - {Spent}" value={f.options[0] ?? ''} onChange={(e) => up((x) => { x[i].options = [e.target.value]; })} />
                  {sample && <span className="small muted">On “{sample.title}”: <strong>{fieldDisplay(engine, sample, f) || '—'}</strong></span>}
                </div>
              )}
              {f.type === 'progress' && <span className="small muted">Share of subtasks and checklist items done</span>}
            </td>
            <td style={{ width: 150 }} className="small">
              {!isComputedField(f) && <label className="row" title="Closing a task with this field empty asks first"><input type="checkbox" checked={!!f.required} onChange={(e) => up((x) => { if (e.target.checked) x[i].required = true; else delete x[i].required; })} /> Required</label>}
              <label className="row" title="Show on list rows and board cards"><input type="checkbox" checked={!!f.pinned} onChange={(e) => up((x) => { if (e.target.checked) x[i].pinned = true; else delete x[i].pinned; })} /> Pinned</label>
            </td>
            <td className="num" style={{ width: 90 }}>
              <button className="btn ghost sm" disabled={i === 0} onClick={() => up((x) => { [x[i - 1], x[i]] = [x[i], x[i - 1]]; })}>↑</button>
              <button className="btn ghost sm" onClick={() => confirm(`Delete the field "${f.name}"? Values stay on tasks but are hidden.`) && up((x) => { x.splice(i, 1); })}>🗑</button>
            </td>
          </tr>
        ))}
      </tbody></table>
      <div className="row">
        <input className="input grow" placeholder="New field name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>{FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        <button className="btn primary" disabled={!name.trim()} onClick={() => { up((x) => { x.push({ id: uid(), name: name.trim(), type, options: [] }); }); setName(''); }}>Add field</button>
      </div>
    </Modal>
  );
}

/** Field values inside the task drawer. */
export function TaskFields({ t }: { t: Task }) {
  const { engine } = useApp();
  const space = spaceOf(engine, t);
  const [editing, setEditing] = useState(false);
  if (!space) return null;
  const set = (f: FieldDef, v: string | undefined) => updateTask(engine, t.id, (x) => { setCustomValue(x, f.id, v); });
  return (
    <div className="section">
      <div className="row"><h3 className="grow">Fields</h3>{engine.canWrite && <button className="btn sm ghost" onClick={() => setEditing(true)}>Edit fields</button>}</div>
      {!space.fields.length && <p className="small muted">No custom fields in this space yet.</p>}
      <div className="props">
        {space.fields.map((f) => {
          const v = customValue(t, f.id) ?? '';
          return [
            <span key={f.id + 'k'} className="k">{f.name}{f.required && <span className="red" title="Required before closing"> *</span>}</span>,
            <div key={f.id + 'v'} className="row">
              {isComputedField(f) ? <span className={f.type === 'formula' && fieldDisplay(engine, t, f).startsWith('#') ? 'red mono' : 'mono'}>
                {f.type === 'progress' ? <ProgressBar pct={taskProgress(engine, t)} /> : fieldDisplay(engine, t, f) || '—'}</span>
              : f.type === 'dropdown' ? <select className="input" value={v} onChange={(e) => set(f, e.target.value || undefined)}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === 'checkbox' ? <input type="checkbox" checked={v === 'true'} onChange={(e) => set(f, e.target.checked ? 'true' : undefined)} />
              : f.type === 'rating' ? <span>{[1, 2, 3, 4, 5].map((n) => <span key={n} style={{ cursor: 'pointer', color: n <= Number(v) ? 'var(--orange)' : 'var(--faint)' }} onClick={() => set(f, n === Number(v) ? undefined : String(n))}>★</span>)}</span>
              : f.type === 'date' ? <input className="input" type="date" value={toInputDate(v || undefined)} onChange={(e) => set(f, fromInputDate(e.target.value))} />
              : f.type === 'people' ? <span className="row wrap">{engine.members.map((m) => {
                  const ids = v ? v.split(',') : [];
                  return <label key={m.id} className="row small" style={{ gap: 3 }}><input type="checkbox" checked={ids.includes(m.id)} onChange={(e) => set(f, (e.target.checked ? [...ids, m.id] : ids.filter((x) => x !== m.id)).join(',') || undefined)} /><Avatar m={m} size={16} />{m.name.split(' ')[0]}</label>;
                })}</span>
              : <>
                  <input className="input grow" type={f.type === 'number' || f.type === 'money' ? 'number' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text'}
                    value={v} onChange={(e) => set(f, e.target.value || undefined)} placeholder={f.type === 'location' ? 'Address or place' : ''} />
                  {v && f.type === 'url' && /^https?:\/\//.test(v) && <a className="btn sm" href={v} target="_blank" rel="noopener noreferrer">↗</a>}
                  {v && f.type === 'email' && <a className="btn sm" href={`mailto:${v}`}>✉</a>}
                  {v && f.type === 'phone' && <a className="btn sm" href={`tel:${v.replace(/[^\d+]/g, '')}`}>📞</a>}
                  {v && f.type === 'location' && <a className="btn sm" title="Open in maps" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(v)}`} target="_blank" rel="noopener noreferrer">🗺</a>}
                </>}
            </div>,
          ];
        })}
      </div>
      {editing && <FieldsEditor space={space} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function ProgressBar({ pct, color = 'var(--green)', width = 120 }: { pct: number; color?: string; width?: number }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="bar-bg" style={{ width, display: 'inline-flex' }}><span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></span>
      <span className="small">{pct}%</span>
    </span>
  );
}

// ---------------------------------------------------------------- Portfolio

/** Every list as a project: progress against its schedule, health, owners and a mini timeline. */
export function PortfolioPage() {
  const { engine, go } = useApp();
  const [spaceId, setSpaceId] = useState('');
  const [health, setHealth] = useState('');
  const lists = engine.list('lists').filter((l) => !l.archived && (!spaceId || l.spaceId === spaceId));
  let rows = lists.map((l) => projectSummary(engine, l.id));
  if (health) rows = rows.filter((r) => r.health === health);
  rows.sort((a, b) => (a.end?.getTime() ?? Infinity) - (b.end?.getTime() ?? Infinity));
  const all = lists.map((l) => projectSummary(engine, l.id));
  const count = (h: string) => all.filter((r) => r.health === h).length;
  const span = rows.flatMap((r) => [r.start, r.end]).filter(Boolean) as Date[];
  const min = span.length ? Math.min(...span.map((d) => d.getTime()), startOfDay().getTime()) : 0;
  const max = span.length ? Math.max(...span.map((d) => d.getTime()), startOfDay().getTime()) : 1;
  const pos = (d: Date) => ((d.getTime() - min) / Math.max(max - min, 1)) * 100;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid g4">
        {(['on track', 'at risk', 'off track', 'done'] as const).map((h) => (
          <div key={h} className="kpi" style={{ background: `color-mix(in srgb, ${HEALTH_COLORS[h]} 12%, transparent)`, cursor: 'pointer', outline: health === h ? `2px solid ${HEALTH_COLORS[h]}` : undefined }} onClick={() => setHealth(health === h ? '' : h)}>
            <div><div className="v" style={{ fontSize: 24 }}>{count(h)}</div><div className="l">{h[0].toUpperCase() + h.slice(1)}</div></div>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <h2 className="grow">Portfolio</h2>
          <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}><option value="">All spaces</option>{engine.list('spaces').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </div>
        {!rows.length ? <Empty icon="🗂" title="No projects" sub="Every list is a project here. Create lists in a space to see them." /> : (
          <table className="t" style={{ minWidth: 900 }}>
            <thead><tr><th>Project</th><th>Health</th><th>Progress</th><th>Owners</th><th className="num">Open / total</th><th className="num">Overdue</th><th>Dates</th><th style={{ width: 220 }}>Timeline</th></tr></thead>
            <tbody>{rows.map((r) => <PortfolioRow key={r.listId} r={r} pos={pos} onOpen={() => go('list/' + r.listId)} />)}</tbody>
          </table>
        )}
      </div>
      <p className="small muted">Health compares progress with the time elapsed between a project's first start date and last due date (or its sprint dates): 15+ points behind or any overdue task is <em>at risk</em>, 30+ points behind or past its end date is <em>off track</em>.</p>
    </div>
  );
}

function PortfolioRow({ r, pos, onOpen }: { r: ProjectSummary; pos: (d: Date) => number; onOpen: () => void }) {
  const { engine } = useApp();
  const space = engine.get('spaces', r.spaceId);
  const c = HEALTH_COLORS[r.health];
  return (
    <tr className="click" onClick={onOpen}>
      <td><div className="row"><span style={{ width: 10, height: 10, borderRadius: 3, background: space?.colorHex }} /><div><div>{r.name}</div><div className="small muted">{space?.name}</div></div></div></td>
      <td><span className="pill" style={{ background: c + '26', color: c }}>{r.health.toUpperCase()}</span></td>
      <td><ProgressBar pct={r.progress} color={c} width={90} />{r.expected > 0 && r.health !== 'done' && <div className="small muted">expected {r.expected}%</div>}</td>
      <td><Avatars ids={r.owners} size={20} /></td>
      <td className="num">{r.total - r.done} / {r.total}</td>
      <td className={`num ${r.overdue ? 'red' : 'muted'}`}>{r.overdue}</td>
      <td className="small">{r.start ? fmtDate(iso(r.start), true) : '—'} → {r.end ? fmtDate(iso(r.end), true) : '—'}</td>
      <td>{r.start && r.end && (
        <div style={{ position: 'relative', height: 14, background: 'var(--hover)', borderRadius: 7 }}>
          <div style={{ position: 'absolute', left: `${pos(r.start)}%`, width: `${Math.max(pos(r.end) - pos(r.start), 2)}%`, top: 2, bottom: 2, background: c, borderRadius: 5, opacity: 0.8 }} />
          <div style={{ position: 'absolute', left: `${pos(startOfDay())}%`, top: -2, bottom: -2, width: 2, background: 'var(--red)' }} title="Today" />
        </div>
      )}</td>
    </tr>
  );
}

// ---------------------------------------------------------------- Resource management

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekly capacity per person (working days × hours, minus time off) against their estimated work. */
export function ResourcesPage() {
  const { engine, openTask } = useApp();
  const [weeks, setWeeks] = useState(8);
  const [from, setFrom] = useState(() => { const d = startOfDay(); return addDays(d, -((d.getDay() + 6) % 7)); });
  const [edit, setEdit] = useState<ID | null>(null);
  const tasks = engine.list('tasks').filter((t) => !t.archived);
  const starts = Array.from({ length: weeks }, (_, i) => addDays(from, i * 7));
  const week = (memberId: ID, ws: Date) => {
    const r = resourceFor(engine, memberId);
    let cap = 0, used = 0; const hit = new Map<ID, Task>();
    for (let d = 0; d < 7; d++) {
      const day = addDays(ws, d);
      if (isWorkingDay(r, day)) cap += r.hoursPerDay;
      const a = allocatedHours(engine, r, day, tasks);
      used += a.hours; for (const t of a.tasks) hit.set(t.id, t);
    }
    return { cap, used, tasks: [...hit.values()] };
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card" style={{ padding: 0 }}>
        <div className="row wrap" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <h2 className="grow">Resource management</h2>
          <button className="btn sm" onClick={() => setFrom(addDays(from, -7))}>‹</button>
          <button className="btn sm" onClick={() => { const d = startOfDay(); setFrom(addDays(d, -((d.getDay() + 6) % 7))); }}>This week</button>
          <button className="btn sm" onClick={() => setFrom(addDays(from, 7))}>›</button>
          <Seg value={weeks} onChange={setWeeks} options={[{ value: 4, label: '4 wk' }, { value: 8, label: '8 wk' }, { value: 12, label: '12 wk' }]} />
        </div>
        <div style={{ overflow: 'auto' }}>
          <table className="t" style={{ minWidth: 260 + weeks * 92 }}>
            <thead><tr><th style={{ minWidth: 240 }}>Person · capacity</th>{starts.map((s) => <th key={s.toISOString()} style={{ textAlign: 'center' }}>{s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</th>)}</tr></thead>
            <tbody>{engine.members.map((m) => {
              const r = resourceFor(engine, m.id);
              const off = r.timeOff.filter((o) => new Date(o.end) >= startOfDay()).length;
              return (
                <tr key={m.id}>
                  <td><div className="row"><Avatar m={m} size={24} /><div className="grow"><div>{m.name}</div>
                    <div className="small muted">{r.hoursPerDay}h × {r.workDays.map((d) => WEEKDAYS[d]).join(' ')}{off ? ` · ${off} time off` : ''}</div></div>
                    {engine.canWrite && <button className="btn ghost sm" onClick={() => setEdit(m.id)} title="Capacity and time off">⚙</button>}</div></td>
                  {starts.map((s) => {
                    const w = week(m.id, s);
                    const ratio = w.cap ? w.used / w.cap : w.used ? 2 : 0;
                    const bg = ratio > 1 ? 'var(--red)' : ratio > 0.8 ? 'var(--orange)' : ratio > 0 ? 'var(--green)' : 'transparent';
                    return (
                      <td key={s.toISOString()} title={w.tasks.map((t) => t.title).join('\n')} onClick={() => w.tasks[0] && openTask(w.tasks[0].id)}
                        style={{ textAlign: 'center', cursor: w.tasks.length ? 'pointer' : undefined, background: `color-mix(in srgb, ${bg} 22%, transparent)` }}>
                        <div className="small" style={{ fontWeight: 700 }}>{w.used ? `${w.used.toFixed(1)}h` : '—'}</div>
                        <div style={{ fontSize: 10 }} className="muted">of {w.cap}h{w.cap ? ` · ${Math.round(ratio * 100)}%` : ''}</div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
      <p className="small muted">Each open task's estimate (1h if none) is spread over its assignees' working days between start and due date. Green is under 80% of capacity, orange 80–100%, red over capacity. The Mac app shows the same numbers.</p>
      {edit && <ResourceEditor memberId={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ResourceEditor({ memberId, onClose }: { memberId: ID; onClose: () => void }) {
  const { engine } = useApp();
  const r = resourceFor(engine, memberId);
  const [off, setOff] = useState({ start: '', end: '', note: '' });
  const save = (fn: (x: typeof r) => void) => {
    const next = structuredClone(r); fn(next);
    engine.put('resources', next);
  };
  return (
    <Modal title={`Capacity · ${member(engine, memberId)?.name ?? ''}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <label className="field">Hours per working day<input className="input" type="number" min={0} max={24} step={0.5} value={r.hoursPerDay} onChange={(e) => save((x) => { x.hoursPerDay = Math.max(0, Math.min(24, Number(e.target.value) || 0)); })} /></label>
      <div className="field">Working days
        <div className="row wrap">{WEEKDAYS.map((d, i) => (
          <label key={d} className="row small" style={{ gap: 3 }}><input type="checkbox" checked={r.workDays.includes(i)} onChange={(e) => save((x) => { x.workDays = e.target.checked ? [...x.workDays, i].sort() : x.workDays.filter((y) => y !== i); })} />{d}</label>
        ))}</div>
      </div>
      <h3>Time off</h3>
      {!r.timeOff.length && <p className="small muted">None planned.</p>}
      {[...r.timeOff].sort((a, b) => a.start.localeCompare(b.start)).map((o) => (
        <div key={o.id} className="row small" style={{ padding: '3px 0' }}>
          <span className="grow">{new Date(o.start).toLocaleDateString()} → {new Date(o.end).toLocaleDateString()} {o.note && <span className="muted">· {o.note}</span>}</span>
          <button className="btn ghost sm" onClick={() => save((x) => { x.timeOff = x.timeOff.filter((y) => y.id !== o.id); })}>✕</button>
        </div>
      ))}
      <div className="row wrap">
        <input className="input" type="date" value={off.start} onChange={(e) => setOff({ ...off, start: e.target.value, end: off.end || e.target.value })} />→
        <input className="input" type="date" value={off.end} onChange={(e) => setOff({ ...off, end: e.target.value })} />
        <input className="input grow" placeholder="Note (vacation, training…)" value={off.note} onChange={(e) => setOff({ ...off, note: e.target.value })} />
        <button className="btn" disabled={!off.start || !off.end || off.end < off.start} onClick={() => {
          save((x) => { x.timeOff.push({ id: uid(), start: fromInputDate(off.start)!, end: fromInputDate(off.end)!, note: off.note.trim() }); });
          setOff({ start: '', end: '', note: '' });
        }}>Add</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Content directory

type DirRow = { id: ID; type: string; icon: string; name: string; where: string; items: number; updated?: string; isPrivate?: boolean; open?: string };

/** Everything in the workspace in one searchable table: spaces, folders, lists, docs, whiteboards, dashboards, channels, goals. */
export function DirectoryPage() {
  const { engine, go } = useApp();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const tasks = engine.list('tasks').filter((t) => !t.archived);
  const latest = (ts: Task[]) => ts.reduce<string | undefined>((a, t) => (!a || t.updated > a ? t.updated : a), undefined);
  const spaceName = (id?: ID) => engine.get('spaces', id)?.name ?? '';
  const rows: DirRow[] = [
    ...engine.list('spaces').map((s) => {
      const ls = engine.list('lists').filter((l) => l.spaceId === s.id).map((l) => l.id);
      const ts = tasks.filter((t) => ls.includes(t.listId));
      return { id: s.id, type: 'Space', icon: '🟪', name: s.name, where: '—', items: ts.length, updated: latest(ts), isPrivate: s.isPrivate, open: 'space/' + s.id };
    }),
    ...engine.list('folders').map((f) => {
      const ls = engine.list('lists').filter((l) => l.folderId === f.id).map((l) => l.id);
      const ts = tasks.filter((t) => ls.includes(t.listId));
      return { id: f.id, type: 'Folder', icon: '📁', name: f.name, where: spaceName(f.spaceId), items: ts.length, updated: latest(ts), isPrivate: engine.get('spaces', f.spaceId)?.isPrivate, open: 'folder/' + f.id };
    }),
    ...engine.list('lists').map((l) => {
      const ts = tasks.filter((t) => t.listId === l.id);
      return { id: l.id, type: l.archived ? 'List (archived)' : l.sprintStart ? 'Sprint' : 'List', icon: l.sprintStart ? '🏁' : '☰', name: l.name, where: [spaceName(l.spaceId), engine.get('folders', l.folderId)?.name].filter(Boolean).join(' › '), items: ts.length, updated: latest(ts), isPrivate: engine.get('spaces', l.spaceId)?.isPrivate, open: l.archived ? undefined : 'list/' + l.id };
    }),
    ...engine.list('docs').map((d) => ({ id: d.id, type: 'Doc', icon: '📝', name: d.title || 'Untitled', where: d.parentId ? engine.get('docs', d.parentId)?.title ?? '' : spaceName(d.spaceId) || 'Docs', items: d.body.length ? d.body.split(/\s+/).length : 0, updated: d.updated, open: 'docs/' + d.id })),
    ...engine.list('channels').map((c) => ({ id: c.id, type: 'Chat channel', icon: '💬', name: '#' + c.name, where: spaceName(c.spaceId) || 'Workspace', items: engine.list('messages').filter((m) => m.channelId === c.id).length, open: 'chat/' + c.id })),
    ...engine.list('goals').map((g) => ({ id: g.id, type: 'Goal', icon: '🎯', name: g.name, where: g.folder, items: g.targets.length, open: 'goals' })),
    ...engine.list('whiteboards').map((w) => ({ id: w.id, type: 'Whiteboard', icon: '🧩', name: w.name, where: 'Whiteboards', items: w.items?.length ?? 0 })),
    ...engine.list('dashboards').map((d) => ({ id: d.id, type: 'Dashboard', icon: '📊', name: d.name, where: 'Mac app', items: 0 })),
  ];
  const types = [...new Set(rows.map((r) => r.type))].sort();
  const s = q.toLowerCase();
  const shown = rows.filter((r) => (!type || r.type === type) && (!s || `${r.name} ${r.where}`.toLowerCase().includes(s)))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.name.localeCompare(b.name));
  const unit = (r: DirRow) => r.type === 'Doc' ? 'words' : r.type === 'Chat channel' ? 'messages' : r.type === 'Goal' ? 'targets' : 'tasks';
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <div className="row wrap" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
        <h2 className="grow">Content directory <span className="small muted">{rows.length} items</span></h2>
        <input className="input" placeholder="Search names and locations" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{types.map((t) => <option key={t}>{t}</option>)}</select>
      </div>
      <table className="t" style={{ minWidth: 720 }}>
        <thead><tr><th>Name</th><th>Type</th><th>Location</th><th className="num">Contains</th><th>Privacy</th><th>Last task update</th></tr></thead>
        <tbody>{shown.map((r) => (
          <tr key={r.type + r.id} className={r.open ? 'click' : ''} onClick={() => r.open && go(r.open)}>
            <td><span className="row">{r.icon} {r.name}</span></td><td className="muted">{r.type}</td><td className="small">{r.where}</td>
            <td className="num small">{r.items ? `${r.items} ${unit(r)}` : r.where === 'Mac app' ? '' : '—'}</td>
            <td className="small">{r.isPrivate ? '🔒 Private' : r.type === 'Space' || r.type.startsWith('List') || r.type === 'Folder' || r.type === 'Sprint' ? 'Workspace' : ''}</td>
            <td className="small muted">{r.updated ? new Date(r.updated).toLocaleString() : ''}</td>
          </tr>
        ))}</tbody>
      </table>
      {!shown.length && <Empty icon="🔎" title="Nothing found" />}
    </div>
  );
}
