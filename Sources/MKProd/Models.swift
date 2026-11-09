import Foundation
import SwiftUI

// MARK: - People

struct Member: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var email: String = ""
    var colorHex: String = "#7B68EE"

    var initials: String {
        let parts = name.split(separator: " ")
        return parts.prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
    }
}

// MARK: - Hierarchy

enum StatusKind: String, Codable, CaseIterable {
    case open, active, done, closed
}

struct StatusDef: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var colorHex: String
    var kind: StatusKind
    /// Most open tasks this status should hold; Board and List flag it when exceeded.
    var wipLimit: Int?

    static func defaults() -> [StatusDef] {
        [
            StatusDef(name: "To Do", colorHex: "#87909E", kind: .open),
            StatusDef(name: "In Progress", colorHex: "#5B8DEF", kind: .active),
            StatusDef(name: "Review", colorHex: "#F0A33A", kind: .active),
            StatusDef(name: "Complete", colorHex: "#3DBE7A", kind: .done),
        ]
    }
}

enum FieldType: String, Codable, CaseIterable, Identifiable {
    case text, number, money, dropdown, checkbox, date, url, rating, email
    case people, phone, location, progress, formula
    var id: String { rawValue }
    var label: String {
        switch self {
        case .url: "URL"
        case .progress: "Progress (automatic)"
        default: rawValue.capitalized
        }
    }
    /// Computed from the task, not typed in.
    var isComputed: Bool { self == .formula || self == .progress }

    /// A type added by a newer app version reads as text instead of dropping the whole space.
    init(from decoder: Decoder) throws {
        self = FieldType(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .text
    }
}

struct FieldDef: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var type: FieldType
    var options: [String] = []
    /// Closing a task with this field empty asks first.
    var required: Bool?
    /// Shown on list rows and board cards.
    var pinned: Bool?
}

/// A kind of work a task can represent (Bug, Client, Event…); tasks without `typeId` are plain tasks.
struct TaskTypeDef: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var icon: String = "🧩"
    var colorHex: String = "#7B68EE"
}

struct Space: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var colorHex: String = "#7B68EE"
    var icon: String = "square.grid.2x2"
    var statuses: [StatusDef] = StatusDef.defaults()
    var fields: [FieldDef] = []
    var isPrivate = false
    /// Task IDs: when set, tasks in this space show PREFIX-<number>.
    var idPrefix: String?
    var taskTypes: [TaskTypeDef]?
    /// When a task's due date moves, move the tasks waiting on it by the same number of days.
    var rescheduleDependencies: Bool?
    /// When a task's due date moves, move its open subtasks too.
    var remapSubtasks: Bool?
}

struct Folder: Identifiable, Codable, Hashable {
    var id = UUID()
    var spaceId: UUID
    var name: String
}

struct TaskList: Identifiable, Codable, Hashable {
    var id = UUID()
    var spaceId: UUID
    var folderId: UUID?
    var name: String
    var colorHex: String?
    var archived = false
    // Optional so workspaces saved before sprints existed still decode.
    var sprintStart: Date?
    var sprintEnd: Date?

    var isSprint: Bool { sprintStart != nil && sprintEnd != nil }
}

// MARK: - Tasks

enum Priority: Int, Codable, CaseIterable, Identifiable, Comparable {
    case none = 0, low = 1, normal = 2, high = 3, urgent = 4
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .none: "No priority"
        case .low: "Low"
        case .normal: "Normal"
        case .high: "High"
        case .urgent: "Urgent"
        }
    }
    var color: Color {
        switch self {
        case .none: .secondary
        case .low: .gray
        case .normal: .blue
        case .high: .orange
        case .urgent: .red
        }
    }
    static func < (a: Priority, b: Priority) -> Bool { a.rawValue < b.rawValue }
}

enum Recurrence: String, Codable, CaseIterable, Identifiable {
    case none, daily, weekly, monthly, yearly
    var id: String { rawValue }
    var label: String { self == .none ? "Never" : rawValue.capitalized }
}

struct ChecklistItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var text: String
    var done = false
    var assigneeId: UUID?
}

struct Checklist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var items: [ChecklistItem] = []
}

struct Comment: Identifiable, Codable, Hashable {
    var id = UUID()
    var authorId: UUID
    var text: String
    var date = Date()
    var resolved = false
    /// An assigned comment is an action item for this person until resolved.
    var assigneeId: UUID?
    /// Set on a reply: the comment it answers.
    var parentId: UUID?
    var reactions: [Reaction]?
}

struct Reaction: Codable, Hashable {
    var emoji: String
    var memberIds: [UUID]
}

/// The task entered `statusId` at `at` (one entry per status change, for time in status).
struct StatusChange: Codable, Hashable {
    var statusId: UUID
    var at: Date
}

struct Attachment: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var path: String
    var added = Date()
    /// Set when the encrypted file itself is stored on the server (uploaded from the website);
    /// kept here so a Mac edit of the task doesn't drop the link to the file.
    var fileId: UUID?
    var size: Int?
    var mime: String?
}

struct ActivityItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var date = Date()
    var text: String
}

struct TaskItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var listId: UUID
    var parentId: UUID?
    var title: String
    var details: String = ""
    var statusId: UUID
    var priority: Priority = .none
    var assigneeIds: [UUID] = []
    var watcherIds: [UUID] = []
    var tags: [String] = []
    var startDate: Date?
    var dueDate: Date?
    var estimateMinutes: Int?
    var points: Int?
    var recurrence: Recurrence = .none
    var checklists: [Checklist] = []
    var comments: [Comment] = []
    var attachments: [Attachment] = []
    var blockedBy: [UUID] = []
    var linkedTaskIds: [UUID] = []
    var customValues: [UUID: String] = [:]
    var activity: [ActivityItem] = []
    var created = Date()
    var updated = Date()
    var completedAt: Date?
    var order: Double = 0
    var archived = false
    var isMilestone = false
    /// Set when deleted; the task stays archived in Trash until restored or purged.
    var trashedAt: Date?
    /// Planned dates saved from the Gantt ("Save baseline"), drawn under the live bars to show slippage.
    var baselineStart: Date?
    var baselineDue: Date?
    /// Task type (Space.taskTypes) and number for the task ID (Space.idPrefix).
    var typeId: UUID?
    var number: Int?
    /// Other lists the task also appears in; `listId` stays its home.
    var extraListIds: [UUID]?
    var statusLog: [StatusChange]?
}

// MARK: - Docs, whiteboards, chat

struct Doc: Identifiable, Codable, Hashable {
    var id = UUID()
    var parentId: UUID?
    var spaceId: UUID?
    var title: String
    var body: String = ""
    var icon: String = "doc.text"
    var created = Date()
    var updated = Date()
    var favorite = false
}

enum BoardItemKind: String, Codable, CaseIterable {
    case sticky, text, rectangle, ellipse
}

struct BoardItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var kind: BoardItemKind
    var text: String
    var x: Double
    var y: Double
    var width: Double = 160
    var height: Double = 120
    var colorHex: String = "#FFE27A"
}

struct BoardConnector: Identifiable, Codable, Hashable {
    var id = UUID()
    var from: UUID
    var to: UUID
}

struct Whiteboard: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var items: [BoardItem] = []
    var connectors: [BoardConnector] = []
}

struct ChatMessage: Identifiable, Codable, Hashable {
    var id = UUID()
    var channelId: UUID
    var authorId: UUID
    var text: String
    var date = Date()
}

struct ChatChannel: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var spaceId: UUID?
}

// MARK: - Goals

enum TargetKind: String, Codable, CaseIterable, Identifiable {
    case number, boolean, currency, tasks
    var id: String { rawValue }
    var label: String { rawValue == "boolean" ? "True / False" : rawValue.capitalized }
}

struct GoalTarget: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var kind: TargetKind
    var start: Double = 0
    var target: Double = 100
    var current: Double = 0
    var taskIds: [UUID] = []
}

struct Goal: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var details: String = ""
    var dueDate: Date?
    var ownerId: UUID?
    var colorHex: String = "#7B68EE"
    var folder: String = "General"
    var targets: [GoalTarget] = []
}

// MARK: - Time, reminders, inbox

struct TimeEntry: Identifiable, Codable, Hashable {
    var id = UUID()
    var taskId: UUID?
    var memberId: UUID
    var note: String = ""
    var start: Date
    var end: Date?
    var billable = false

    var duration: TimeInterval { (end ?? Date()).timeIntervalSince(start) }
}

struct Reminder: Identifiable, Codable, Hashable {
    var id = UUID()
    var title: String
    var date: Date
    var done = false
    var taskId: UUID?
    var notified = false
}

struct InboxItem: Identifiable, Codable, Hashable {
    var id = UUID()
    var date = Date()
    var text: String
    var taskId: UUID?
    var read = false
    var cleared = false
    /// Set by the website for non-task links ("order:<id>", "chat:<id>"); kept so it survives a Mac edit.
    var target: String?
}

// MARK: - Saved views

/// Filters of a saved view. Same JSON as the website's ViewFilter.
struct ViewFilter: Codable, Hashable {
    var search: String = ""
    var assigneeId: UUID?
    var priority: Int?
    var tag: String?
    var typeId: String?
    var showClosed = true
    var onlyOverdue = false

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        search = (try? c.decodeIfPresent(String.self, forKey: .search)) ?? ""
        assigneeId = try? c.decodeIfPresent(UUID.self, forKey: .assigneeId)
        priority = try? c.decodeIfPresent(Int.self, forKey: .priority)
        tag = try? c.decodeIfPresent(String.self, forKey: .tag)
        typeId = try? c.decodeIfPresent(String.self, forKey: .typeId)
        showClosed = (try? c.decodeIfPresent(Bool.self, forKey: .showClosed)) ?? true
        onlyOverdue = (try? c.decodeIfPresent(Bool.self, forKey: .onlyOverdue)) ?? false
    }
}

/// A named view of one location ("everything", "mine", "space:<id>", "folder:<id>", "list:<id>"):
/// view mode, grouping, sorting and filters. Shared ones sync as `views`, private ones as
/// `privateViews` (encrypted with the person's own key). `mode`, `groupBy` and `sortBy` use the
/// website's keys ("list", "mindmap", "due"…), mapped to the Mac enums in TaskContainerView.
struct SavedView: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var scope: String
    var mode: String = "list"
    var groupBy: String = "status"
    var sortBy: String = "manual"
    var filter = ViewFilter()
    var ownerId: UUID
    var isDefault = false
    var order: Double = 0
}

// MARK: - Resource management

struct TimeOff: Identifiable, Codable, Hashable {
    var id = UUID()
    var start: Date
    var end: Date
    var note: String = ""
}

/// Capacity of one person; the record id is the member id. `workDays` uses 0 = Sunday … 6 = Saturday,
/// the same as the website.
struct Resource: Identifiable, Codable, Hashable {
    var id: UUID
    var hoursPerDay: Double = 8
    var workDays: [Int] = [1, 2, 3, 4, 5]
    var timeOff: [TimeOff] = []
}

// MARK: - Automations

enum TriggerType: String, Codable, CaseIterable, Identifiable {
    case taskCreated, statusChanged, priorityChanged, assigneeAdded, tagAdded, dueDatePassed
    var id: String { rawValue }
    var label: String {
        switch self {
        case .taskCreated: "Task created"
        case .statusChanged: "Status changes to"
        case .priorityChanged: "Priority changes to"
        case .assigneeAdded: "Assignee added"
        case .tagAdded: "Tag added"
        case .dueDatePassed: "Due date passes"
        }
    }
}

enum ActionType: String, Codable, CaseIterable, Identifiable {
    case setStatus, setPriority, assign, addTag, moveToList, addComment, setDueInDays, archive
    var id: String { rawValue }
    var label: String {
        switch self {
        case .setStatus: "Change status to"
        case .setPriority: "Set priority to"
        case .assign: "Assign to"
        case .addTag: "Add tag"
        case .moveToList: "Move to list"
        case .addComment: "Post comment"
        case .setDueInDays: "Set due date (days from now)"
        case .archive: "Archive task"
        }
    }
}

struct Automation: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var enabled = true
    var spaceId: UUID?
    var trigger: TriggerType
    var triggerValue: String = ""
    var action: ActionType
    var actionValue: String = ""
    var runCount = 0
}

// MARK: - Dashboards

enum WidgetKind: String, Codable, CaseIterable, Identifiable {
    case statusBreakdown, priorityBreakdown, workload, overdue, completedTrend, timeTracked, goals, recentActivity
    var id: String { rawValue }
    var label: String {
        switch self {
        case .statusBreakdown: "Tasks by Status"
        case .priorityBreakdown: "Tasks by Priority"
        case .workload: "Workload by Assignee"
        case .overdue: "Overdue Tasks"
        case .completedTrend: "Completed (last 14 days)"
        case .timeTracked: "Time Tracked"
        case .goals: "Goal Progress"
        case .recentActivity: "Recent Activity"
        }
    }
}

struct DashboardWidget: Identifiable, Codable, Hashable {
    var id = UUID()
    var kind: WidgetKind
    var spaceId: UUID?
}

struct Dashboard: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var widgets: [DashboardWidget] = []
}

// MARK: - Templates

struct TaskTemplate: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var task: TaskItem
    var subtasks: [TaskItem] = []
}

// MARK: - Root document

struct AppData: Codable {
    var version = 1
    var workspaceName = "MK Prod Workspace"
    var currentUserId: UUID
    var members: [Member] = []
    var spaces: [Space] = []
    var folders: [Folder] = []
    var lists: [TaskList] = []
    var tasks: [TaskItem] = []
    var docs: [Doc] = []
    var whiteboards: [Whiteboard] = []
    var channels: [ChatChannel] = []
    var messages: [ChatMessage] = []
    var goals: [Goal] = []
    var timeEntries: [TimeEntry] = []
    var reminders: [Reminder] = []
    var inbox: [InboxItem] = []
    var automations: [Automation] = []
    var dashboards: [Dashboard] = []
    var templates: [TaskTemplate] = []
    var favorites: [UUID] = []
    var resources: [Resource] = []
    var views: [SavedView] = []
    var privateViews: [SavedView] = []
    // Budget & procurement
    var entities: [FinEntity] = []
    var budgets: [Budget] = []
    var orders: [PurchaseOrder] = []
    var savings: [Saving] = []
    var contracts: [Contract] = []
    var catalog: [CatalogItem] = []
    var audit: [AuditEntry] = []
    var financeSettings: [FinanceSettings] = [FinanceSettings()]

    var finance: FinanceSettings { financeSettings.first ?? FinanceSettings() }

    init(currentUserId: UUID) {
        self.currentUserId = currentUserId
    }

    /// Every field is optional on disk, so files written by older versions still load.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func v<T: Decodable>(_ k: CodingKeys, _ d: T) -> T { (try? c.decodeIfPresent(T.self, forKey: k)) ?? d }
        version = v(.version, 1)
        workspaceName = v(.workspaceName, "MK Prod Workspace")
        currentUserId = try c.decode(UUID.self, forKey: .currentUserId)
        members = v(.members, []); spaces = v(.spaces, []); folders = v(.folders, []); lists = v(.lists, [])
        tasks = v(.tasks, []); docs = v(.docs, []); whiteboards = v(.whiteboards, []); channels = v(.channels, [])
        messages = v(.messages, []); goals = v(.goals, []); timeEntries = v(.timeEntries, []); reminders = v(.reminders, [])
        inbox = v(.inbox, []); automations = v(.automations, []); dashboards = v(.dashboards, []); templates = v(.templates, [])
        favorites = v(.favorites, []); resources = v(.resources, [])
        views = v(.views, []); privateViews = v(.privateViews, [])
        entities = v(.entities, []); budgets = v(.budgets, []); orders = v(.orders, []); savings = v(.savings, [])
        contracts = v(.contracts, []); catalog = v(.catalog, []); audit = v(.audit, [])
        financeSettings = v(.financeSettings, [FinanceSettings()])
        if financeSettings.isEmpty { financeSettings = [FinanceSettings()] }
    }
}

// MARK: - Helpers

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }
}

let paletteHexes = ["#7B68EE", "#5B8DEF", "#3DBE7A", "#F0A33A", "#E5484D", "#D6409F", "#12B5CB", "#87909E", "#8E5CF7", "#2F3A4A"]

extension TimeInterval {
    var hms: String {
        let t = Int(self)
        return String(format: "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60)
    }
    var hoursMinutes: String {
        let t = Int(self) / 60
        return t >= 60 ? "\(t / 60)h \(t % 60)m" : "\(t)m"
    }
}

extension Date {
    var startOfDay: Date { Calendar.current.startOfDay(for: self) }
    func adding(days: Int) -> Date { Calendar.current.date(byAdding: .day, value: days, to: self)! }
    var shortLabel: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return "Today" }
        if cal.isDateInTomorrow(self) { return "Tomorrow" }
        if cal.isDateInYesterday(self) { return "Yesterday" }
        return formatted(.dateTime.month(.abbreviated).day())
    }
}
