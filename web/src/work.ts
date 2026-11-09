// Work-management rules shared by the task views: task IDs, close warnings, rescheduling of
// dependent tasks and subtasks, time in status, multiple lists and saved views.
// Mirrors Sources/MKProd/WorkFeatures.swift so the Mac app and the website behave the same.

import { ID, SavedView, Space, StatusDef, Task, ViewFilter, addDays, iso, startOfDay, uid } from './model';
import type { SyncEngine } from './sync';
import { customValue, isComputedField } from './features';

const DAY = 86400_000;

export const spaceOfTask = (engine: SyncEngine, t: Task): Space | undefined => engine.get('spaces', engine.get('lists', t.listId)?.spaceId);
const statusOfTask = (engine: SyncEngine, t: Task): StatusDef | undefined => spaceOfTask(engine, t)?.statuses.find((s) => s.id === t.statusId);
export const isClosedTask = (engine: SyncEngine, t: Task) => { const k = statusOfTask(engine, t)?.kind; return k === 'done' || k === 'closed'; };

// ---------------------------------------------------------------- task IDs

/** "ENG-42" when the task's space has an ID prefix and the task has its number yet. */
export function taskKey(engine: SyncEngine, t: Task): string | undefined {
  const p = spaceOfTask(engine, t)?.idPrefix;
  return p && t.number ? `${p}-${t.number}` : undefined;
}

/**
 * Gives every task in a space with an ID prefix a number, oldest first, continuing after the highest
 * number in use. Runs whenever a task view opens, so tasks created anywhere (other device, import,
 * template, recurrence) get one. Two devices numbering offline at the same moment can collide; the
 * ID is a label, the record id stays the identity.
 */
export function assignTaskNumbers(engine: SyncEngine) {
  const spaces = engine.list('spaces').filter((s) => s.idPrefix);
  if (!spaces.length || !engine.canWrite) return;
  const listSpace = new Map(engine.list('lists').map((l) => [l.id, l.spaceId]));
  for (const s of spaces) {
    const inSpace = engine.list('tasks').filter((t) => listSpace.get(t.listId) === s.id);
    const missing = inSpace.filter((t) => !t.number).sort((a, b) => a.created.localeCompare(b.created));
    if (!missing.length) continue;
    let next = inSpace.reduce((m, t) => Math.max(m, t.number ?? 0), 0);
    for (const t of missing) { next += 1; const n = next; engine.update('tasks', t.id, (x) => { x.number = n; }); }
  }
}

/** Finds a task by its ID ("ENG-42", case ignored), for search. */
export function findByKey(engine: SyncEngine, key: string): Task | undefined {
  const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(key.trim());
  if (!m) return undefined;
  const space = engine.list('spaces').find((s) => s.idPrefix?.toUpperCase() === m[1].toUpperCase());
  if (!space) return undefined;
  const lists = new Set(engine.list('lists').filter((l) => l.spaceId === space.id).map((l) => l.id));
  return engine.list('tasks').find((t) => lists.has(t.listId) && t.number === Number(m[2]));
}

// ---------------------------------------------------------------- task types

export function taskTypeOf(engine: SyncEngine, t: Task) {
  return t.typeId ? spaceOfTask(engine, t)?.taskTypes?.find((x) => x.id === t.typeId) : undefined;
}

// ---------------------------------------------------------------- close warnings

/** Why closing this task might be premature: open subtasks or checklist items, empty required fields, open blockers. */
export function closeWarnings(engine: SyncEngine, t: Task): string[] {
  const out: string[] = [];
  const subs = engine.list('tasks').filter((x) => x.parentId === t.id && !x.archived && !isClosedTask(engine, x));
  if (subs.length) out.push(`${subs.length} subtask${subs.length === 1 ? ' is' : 's are'} still open`);
  const items = t.checklists.flatMap((c) => c.items).filter((i) => !i.done);
  if (items.length) out.push(`${items.length} checklist item${items.length === 1 ? ' is' : 's are'} not done`);
  const empty = (spaceOfTask(engine, t)?.fields ?? []).filter((f) => f.required && !isComputedField(f) && !customValue(t, f.id));
  if (empty.length) out.push(`Required field${empty.length === 1 ? '' : 's'} empty: ${empty.map((f) => f.name).join(', ')}`);
  const blockers = t.blockedBy.map((id) => engine.get('tasks', id)).filter((b): b is Task => !!b && !b.archived && !isClosedTask(engine, b));
  if (blockers.length) out.push(`Still waiting on: ${blockers.map((b) => b.title).join(', ')}`);
  return out;
}

/**
 * Asks before a status change closes a task that still has open work. Returns false to cancel.
 * The website, Windows, Android and iPhone apps all show the browser's confirm dialog.
 */
export function confirmStatusChange(engine: SyncEngine, t: Task, statusId: ID): boolean {
  const target = spaceOfTask(engine, t)?.statuses.find((s) => s.id === statusId);
  if (!target || (target.kind !== 'done' && target.kind !== 'closed') || isClosedTask(engine, t)) return true;
  const w = closeWarnings(engine, t);
  return !w.length || confirm(`Close “${t.title}” anyway?\n\n• ${w.join('\n• ')}`);
}

// ---------------------------------------------------------------- status history

/** Called inside an update whenever the status changed: keeps one entry per status entered. */
export function logStatusChange(t: Task, before: Task) {
  if (!t.statusLog?.length) t.statusLog = [{ statusId: before.statusId, at: t.created }];
  t.statusLog.push({ statusId: t.statusId, at: iso() });
}

/** Total time spent in each status (ms), the current one counted up to now, in workflow order. */
export function timeInStatus(engine: SyncEngine, t: Task): { status: StatusDef | undefined; statusId: ID; ms: number; current: boolean }[] {
  const log = t.statusLog?.length ? t.statusLog : [{ statusId: t.statusId, at: t.created }];
  const totals = new Map<ID, number>();
  log.forEach((e, i) => {
    const end = i + 1 < log.length ? new Date(log[i + 1].at).getTime() : Date.now();
    totals.set(e.statusId, (totals.get(e.statusId) ?? 0) + Math.max(0, end - new Date(e.at).getTime()));
  });
  const order = spaceOfTask(engine, t)?.statuses ?? [];
  return [...totals.entries()]
    .map(([statusId, ms]) => ({ statusId, ms, status: order.find((s) => s.id === statusId), current: statusId === t.statusId }))
    .sort((a, b) => (order.findIndex((s) => s.id === a.statusId) + 1 || 99) - (order.findIndex((s) => s.id === b.statusId) + 1 || 99));
}

export function fmtDuration(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---------------------------------------------------------------- rescheduling

const shift = (d: string | undefined, days: number) => (d ? iso(addDays(new Date(d), days)) : d);
export const dayDelta = (a?: string, b?: string) =>
  a && b ? Math.round((startOfDay(new Date(b)).getTime() - startOfDay(new Date(a)).getTime()) / DAY) : 0;

/**
 * After a task's dates moved by `days`: if its space says so, move the tasks waiting on it (and
 * theirs, once each) and its open subtasks by the same number of days. Returns how many moved.
 */
export function cascadeDates(engine: SyncEngine, t: Task, days: number, who: string): number {
  if (!days) return 0;
  const space = spaceOfTask(engine, t);
  if (!space?.rescheduleDependencies && !space?.remapSubtasks) return 0;
  const moved = new Set<ID>([t.id]);
  const move = (x: Task, why: string) => {
    if (moved.has(x.id) || isClosedTask(engine, x) || (!x.startDate && !x.dueDate)) return;
    moved.add(x.id);
    engine.update('tasks', x.id, (y) => {
      y.startDate = shift(y.startDate, days); y.dueDate = shift(y.dueDate, days);
      y.activity.push({ id: uid(), date: iso(), text: `${who} moved it ${days > 0 ? 'later' : 'earlier'} by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${why}` });
    });
  };
  const walk = (src: Task) => {
    if (space.remapSubtasks) for (const s of engine.list('tasks').filter((x) => x.parentId === src.id && !x.archived)) move(s, `with its parent “${src.title}”`);
    if (space.rescheduleDependencies) {
      for (const d of engine.list('tasks').filter((x) => x.blockedBy.includes(src.id) && !x.archived)) {
        const before = moved.size; move(d, `because “${src.title}” moved`);
        if (moved.size > before) walk(engine.get('tasks', d.id)!);
      }
    }
  };
  walk(t);
  return moved.size - 1;
}

// ---------------------------------------------------------------- multiple lists

export const inLists = (t: Task, listIds: Set<ID> | ID[]) => {
  const has = (id: ID) => (Array.isArray(listIds) ? listIds.includes(id) : listIds.has(id));
  return has(t.listId) || !!t.extraListIds?.some(has);
};

// ---------------------------------------------------------------- saved views

export const DEFAULT_FILTER: ViewFilter = { search: '', showClosed: true, onlyOverdue: false };

/** Views for a location the person can see: the shared ones and their own private ones, in order. */
export function viewsFor(engine: SyncEngine, scope: string): (SavedView & { private: boolean })[] {
  return [
    ...engine.list('views').filter((v) => v.scope === scope).map((v) => ({ ...v, private: false })),
    ...engine.list('privateViews').filter((v) => v.scope === scope && v.ownerId === engine.me).map((v) => ({ ...v, private: true })),
  ].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function saveView(engine: SyncEngine, v: Omit<SavedView, 'id' | 'ownerId' | 'order'> & { id?: ID }, isPrivate: boolean): SavedView {
  const all = viewsFor(engine, v.scope);
  const view: SavedView = { ...v, id: v.id ?? uid(), ownerId: engine.me, order: all.length ? Math.max(...all.map((x) => x.order)) + 1 : 0 };
  if (view.isDefault) clearDefault(engine, v.scope, view.id);
  engine.put(isPrivate ? 'privateViews' : 'views', view);
  return view;
}

/** One default per location and person: a private default wins over the shared one for its owner. */
export function clearDefault(engine: SyncEngine, scope: string, except?: ID) {
  for (const v of viewsFor(engine, scope)) if (v.isDefault && v.id !== except) engine.update(v.private ? 'privateViews' : 'views', v.id, (x) => { x.isDefault = false; });
}

export const defaultView = (engine: SyncEngine, scope: string) => {
  const vs = viewsFor(engine, scope).filter((v) => v.isDefault);
  return vs.find((v) => v.private) ?? vs[0];
};

// ---------------------------------------------------------------- CSV

export function toCSV(rows: (string | number | undefined)[][]): string {
  const cell = (v: string | number | undefined) => {
    let s = v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheets from running cell text as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export function download(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
