// Shared data model. Field names and JSON shapes match the Mac app's Swift Codable types
// (Sources/MKProd/Models.swift, FinanceModels.swift) so both clients read each other's records.
// Rules: every non-optional Swift field must be present, dates are ISO-8601 without
// milliseconds, ids are uppercase UUIDs, and optional fields are omitted when empty.

export type ID = string;

export const uid = (): ID => crypto.randomUUID().toUpperCase();
export const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const parseDate = (s?: string | null): Date | null => (s ? new Date(s) : null);
export const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export interface Member { id: ID; name: string; email: string; colorHex: string }

export type StatusKind = 'open' | 'active' | 'done' | 'closed';
/** `wipLimit`: most open tasks the status should hold; Board and List flag the column when it's exceeded. */
export interface StatusDef { id: ID; name: string; colorHex: string; kind: StatusKind; wipLimit?: number }
/** `required`: closing a task with it empty asks first. `pinned`: shown on rows and cards. */
export interface FieldDef { id: ID; name: string; type: string; options: string[]; required?: boolean; pinned?: boolean }
/** A kind of work a task can represent (Bug, Client, Event…); tasks without `typeId` are plain tasks. */
export interface TaskTypeDef { id: ID; name: string; icon: string; colorHex: string }
export interface Space {
  id: ID; name: string; colorHex: string; icon: string; statuses: StatusDef[]; fields: FieldDef[]; isPrivate: boolean
  /** Task IDs: when set, tasks in this space show PREFIX-<number>. */
  idPrefix?: string
  taskTypes?: TaskTypeDef[]
  /** When a task's dates move, move the tasks waiting on it by the same number of days. */
  rescheduleDependencies?: boolean
  /** When a task's due date moves, move its open subtasks by the same number of days. */
  remapSubtasks?: boolean
}
export interface Folder { id: ID; spaceId: ID; name: string }
export interface TaskList { id: ID; spaceId: ID; folderId?: ID; name: string; colorHex?: string; archived: boolean; sprintStart?: string; sprintEnd?: string }

export interface ChecklistItem { id: ID; text: string; done: boolean; assigneeId?: ID }
export interface Checklist { id: ID; name: string; items: ChecklistItem[] }
export interface Reaction { emoji: string; memberIds: ID[] }
/** `parentId` makes a comment a reply in that comment's thread. */
export interface Comment { id: ID; authorId: ID; text: string; date: string; resolved: boolean; assigneeId?: ID; parentId?: ID; reactions?: Reaction[] }
/** One entry per status change: the task entered `statusId` at `at`. */
export interface StatusChange { statusId: ID; at: string }
export interface Activity { id: ID; date: string; text: string }
/** `path` is a link or file name; `fileId`/`size` are set when the encrypted file itself is stored on the server. */
export interface Attachment { id: ID; name: string; path: string; added: string; fileId?: ID; size?: number; mime?: string }

export interface Task {
  id: ID; listId: ID; parentId?: ID; title: string; details: string; statusId: ID; priority: number
  assigneeIds: ID[]; watcherIds: ID[]; tags: string[]; startDate?: string; dueDate?: string
  estimateMinutes?: number; points?: number; recurrence: string; checklists: Checklist[]; comments: Comment[]
  attachments: Attachment[]; blockedBy: ID[]; linkedTaskIds: ID[]
  /** Swift encodes [UUID: String] as a flat [key, value, key, value] array. */
  customValues: string[]; activity: Activity[]; created: string; updated: string; completedAt?: string
  order: number; archived: boolean; isMilestone: boolean; trashedAt?: string
  /** Planned dates saved from the Gantt ("Save baseline"), drawn under the live bars to show slippage. */
  baselineStart?: string; baselineDue?: string
  /** Task type (Space.taskTypes) and number for the task ID (Space.idPrefix). */
  typeId?: ID; number?: number
  /** Other lists the task also appears in; `listId` stays its home. */
  extraListIds?: ID[]
  statusLog?: StatusChange[]
}

export interface Doc { id: ID; parentId?: ID; spaceId?: ID; title: string; body: string; icon: string; created: string; updated: string; favorite: boolean }

/** Whiteboards: same shape as the Mac app's `Whiteboard` / `BoardItem` / `BoardConnector`, so one board is edited from every platform. */
export type BoardItemKind = 'sticky' | 'text' | 'rectangle' | 'ellipse';
export interface BoardItem { id: ID; kind: BoardItemKind; text: string; x: number; y: number; width: number; height: number; colorHex: string }
export interface BoardConnector { id: ID; from: ID; to: ID }
export interface Whiteboard { id: ID; name: string; items: BoardItem[]; connectors: BoardConnector[] }
export interface Channel { id: ID; name: string; spaceId?: ID }
export interface Message { id: ID; channelId: ID; authorId: ID; text: string; date: string }
export interface GoalTarget { id: ID; name: string; kind: 'number' | 'boolean' | 'currency' | 'tasks'; start: number; target: number; current: number; taskIds: ID[] }
export interface Goal { id: ID; name: string; details: string; dueDate?: string; ownerId?: ID; colorHex: string; folder: string; targets: GoalTarget[] }
export interface TimeEntry { id: ID; taskId?: ID; memberId: ID; note: string; start: string; end?: string; billable: boolean }

/**
 * Personal records: synced to all of one person's devices, encrypted with that person's own
 * key (derived from their key pair), so teammates can't read them. Same shapes as Models.swift.
 * `target` is the web's richer link ("task:<id>", "order:<id>", "chat:<id>"); `taskId` is what the Mac app opens.
 */
export interface InboxItem { id: ID; date: string; text: string; taskId?: ID; target?: string; read: boolean; cleared: boolean }
export interface Reminder { id: ID; title: string; date: string; done: boolean; taskId?: ID; notified: boolean }

/** Resource management: one record per person (id = member id). `workDays` uses 0 = Sunday … 6 = Saturday. */
export interface TimeOff { id: ID; start: string; end: string; note: string }
export interface Resource { id: ID; hoursPerDay: number; workDays: number[]; timeOff: TimeOff[] }

/**
 * A saved view: a named view mode plus its filters, grouping and sorting, for one location
 * ("everything", "mine", "space:<id>", "folder:<id>", "list:<id>"). Shared views live in `views`;
 * private ones in `privateViews`, encrypted with the person's own key. Same shape as SavedView in Swift.
 */
export interface ViewFilter { search: string; assigneeId?: ID; priority?: number; tag?: string; typeId?: ID; showClosed: boolean; onlyOverdue: boolean }
export interface SavedView {
  id: ID; name: string; scope: string; mode: string; groupBy: string; sortBy: string; filter: ViewFilter
  ownerId: ID; isDefault: boolean; order: number
}

// Budget & procurement
export interface FinEntity { id: ID; name: string; code: string; approvalLevels: string[]; roles: { memberId: ID; role: string }[] }
export interface BudgetLine { id: ID; name: string; allocated: number; notes: string }
export interface Budget { id: ID; entityId: ID; year: number; category: string; notes: string; lineItems: BudgetLine[]; created: string }
export interface OrderLine { id: ID; name: string; qty: number; unitPrice: number; catalogItemId?: ID }
export interface OrderEvent { id: ID; date: string; memberId: ID; action: string; from: string; to: string; note: string }
export interface Order {
  id: ID; number: number; type: 'order' | 'expense'; title: string; entityId: ID; budgetId?: ID; lineItemId?: ID
  supplier: string; supplierEmail: string; items: OrderLine[]; currency: string; poNumber: string; lpo: string
  itemCategory: string; status: string; isUnbudgeted: boolean; requestedBy: ID; requestedDate: string
  expectedDelivery?: string; actualDelivery?: string; trackingNumber: string; deliveryNotes: string
  assignedTo?: ID; approvedBy?: ID; approvedDate?: string; notes: string; history: OrderEvent[]; updated: string
}
export interface Saving { id: ID; entityId: ID; budgetId?: ID; lineItemId?: ID; type: string; amount: number; date: string; description: string; lpo: string; recordedBy: ID }
export interface Contract {
  id: ID; entityId?: ID; title: string; supplier: string; type: string; value: number; startDate: string; endDate: string
  autoRenew: boolean; terminated: boolean; contact: string; email: string; phone: string; notes: string
}
export interface CatalogItem { id: ID; name: string; category: string; unitPrice: number; unit: string; supplier: string; status: string; addedBy: ID; addedDate: string }
export interface AuditEntry { id: ID; date: string; memberId: ID; action: string; details: string }
/** "While I'm away, `to` may approve whatever `from` could approve", until the end of `until` (ISO date). */
export interface Delegation { id: ID; from: ID; to: ID; until: string; note: string }
export interface FinanceSettings {
  id: ID; currency: string; years: number[]; categories: string[]; contractTypes: string[]
  itemCategories: string[]; savingsTypes: string[]; nextOrderNumber: number; delegations?: Delegation[]
}

/**
 * A supplier share link created by us. `key` is the link's decryption key (URL fragment), kept
 * here, encrypted with the workspace key like everything else, so teammates can read replies.
 * Web-only kind: the Mac app ignores record kinds it doesn't know.
 */
export interface ShareLink { id: ID; kind: 'order'; refId: ID; key: string; label: string; createdBy: ID; createdAt: string; expiresAt: string }

export const FINANCE_SETTINGS_ID = 'F1A2C3E4-0000-4000-8000-000000000001';

/** Synced collections: record kind → object type. Must match SyncKind.all in CloudSync.swift. */
export interface Collections {
  spaces: Space; folders: Folder; lists: TaskList; tasks: Task; docs: Doc; whiteboards: Whiteboard
  channels: Channel; messages: Message; goals: Goal; timeEntries: TimeEntry; automations: { id: ID; name: string }
  dashboards: { id: ID; name: string }; templates: { id: ID; name: string }
  entities: FinEntity; budgets: Budget; orders: Order; savings: Saving; contracts: Contract
  catalog: CatalogItem; audit: AuditEntry; financeSettings: FinanceSettings; shares: ShareLink
  inbox: InboxItem; reminders: Reminder; resources: Resource; views: SavedView; privateViews: SavedView
}
export type Kind = keyof Collections;
export const KINDS: Kind[] = [
  'spaces', 'folders', 'lists', 'tasks', 'docs', 'whiteboards', 'channels', 'messages', 'goals', 'timeEntries',
  'automations', 'dashboards', 'templates', 'entities', 'budgets', 'orders', 'savings', 'contracts', 'catalog', 'audit', 'financeSettings', 'shares',
  'inbox', 'reminders', 'resources', 'views', 'privateViews',
];
/** Kinds encrypted with the person's own key rather than the workspace key. */
export const PERSONAL_KINDS: Kind[] = ['inbox', 'reminders', 'privateViews'];
export type Data = { [K in Kind]: Record<ID, Collections[K]> };
export const emptyData = (): Data => Object.fromEntries(KINDS.map((k) => [k, {}])) as Data;

// ---------------------------------------------------------------- factories

export function defaultStatuses(): StatusDef[] {
  return [
    { id: uid(), name: 'To Do', colorHex: '#87909E', kind: 'open' },
    { id: uid(), name: 'In Progress', colorHex: '#5B8DEF', kind: 'active' },
    { id: uid(), name: 'Review', colorHex: '#F0A33A', kind: 'active' },
    { id: uid(), name: 'Complete', colorHex: '#3DBE7A', kind: 'done' },
  ];
}

export function newSpace(name: string, colorHex = '#7B68EE'): Space {
  return { id: uid(), name, colorHex, icon: 'square.grid.2x2', statuses: defaultStatuses(), fields: [], isPrivate: false };
}

export function newList(spaceId: ID, name: string, folderId?: ID): TaskList {
  const l: TaskList = { id: uid(), spaceId, name, archived: false };
  if (folderId) l.folderId = folderId;
  return l;
}

export function newTask(listId: ID, title: string, statusId: ID, by: Member | undefined): Task {
  const now = iso();
  return {
    id: uid(), listId, title, details: '', statusId, priority: 0, assigneeIds: [], watcherIds: [], tags: [],
    recurrence: 'none', checklists: [], comments: [], attachments: [], blockedBy: [], linkedTaskIds: [], customValues: [],
    activity: [{ id: uid(), date: now, text: `${by?.name ?? 'Someone'} created this task` }],
    created: now, updated: now, order: Date.now() / 1000, archived: false, isMilestone: false,
  };
}

export function newDoc(title: string, body = ''): Doc {
  const now = iso();
  return { id: uid(), title, body, icon: 'doc.text', created: now, updated: now, favorite: false };
}

export function newOrderDraft(entityId: ID, me: ID, type: 'order' | 'expense' = 'order'): Order {
  const now = iso();
  return {
    id: uid(), number: 0, type, title: '', entityId, supplier: '', supplierEmail: '', items: [{ id: uid(), name: '', qty: 1, unitPrice: 0 }],
    currency: 'AED', poNumber: '', lpo: '', itemCategory: '', status: '', isUnbudgeted: false, requestedBy: me,
    requestedDate: now, trackingNumber: '', deliveryNotes: '', notes: '', history: [], updated: now,
  };
}

export function defaultFinanceSettings(): FinanceSettings {
  return {
    id: FINANCE_SETTINGS_ID, currency: 'AED', years: [new Date().getFullYear()],
    categories: ['Operations', 'IT', 'Facilities', 'Marketing', 'Training'],
    contractTypes: ['Service', 'Maintenance', 'Supply', 'Lease', 'License'],
    itemCategories: ['Stationery', 'IT Equipment', 'Furniture', 'Cleaning', 'Other'],
    savingsTypes: ['Negotiation', 'Alternative supplier', 'Bulk discount', 'Cancelled need'],
    nextOrderNumber: 1001,
  };
}

export const PRIORITIES = [
  { value: 4, label: 'Urgent', color: '#E5484D' },
  { value: 3, label: 'High', color: '#F0A33A' },
  { value: 2, label: 'Normal', color: '#5B8DEF' },
  { value: 1, label: 'Low', color: '#87909E' },
  { value: 0, label: 'No priority', color: '#B0B7C3' },
];
export const priorityOf = (p: number) => PRIORITIES.find((x) => x.value === p) ?? PRIORITIES[4];

export const PALETTE = ['#7B68EE', '#5B8DEF', '#3DBE7A', '#F0A33A', '#E5484D', '#D6409F', '#12B5CB', '#87909E', '#8E5CF7', '#2F3A4A'];

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase();
}

export function fmtDate(s?: string | null, withYear = false) {
  if (!s) return '';
  const d = new Date(s);
  const today = startOfDay();
  const day = startOfDay(d).getTime();
  if (day === today.getTime()) return 'Today';
  if (day === addDays(today, 1).getTime()) return 'Tomorrow';
  if (day === addDays(today, -1).getTime()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

/** "YYYY-MM-DD" for <input type="date"> ↔ ISO strings. */
export const toInputDate = (s?: string) => (s ? new Date(s).toISOString().slice(0, 10) : '');
export const fromInputDate = (v: string) => (v ? iso(new Date(v + 'T00:00:00')) : undefined);
