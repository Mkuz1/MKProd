import Foundation
import SwiftUI
import UserNotifications

enum SidebarItem: Hashable {
    case home, inbox, everything, myTasks
    case space(UUID), folder(UUID), list(UUID)
    case docs, doc(UUID)
    case whiteboards, whiteboard(UUID)
    case chat(UUID)
    case goals, dashboards, dashboard(UUID), timesheet, automations, templates
    case portfolio, resources, directory
    case trash, archive
    case finDashboard, finAlerts, finBudgets, finOrders, finApprovals, finCatalog, finContracts, finSavings
    case finAnalytics, finReports, finSettings, finAudit
}

@Observable
final class Store {
    var data: AppData {
        didSet {
            scheduleSave()
            cloud.localChanged()
        }
    }
    let cloud = CloudSync()
    var selection: SidebarItem? = .home
    var openTaskId: UUID?
    var showCommandPalette = false
    var lastError: String?

    private var saveWork: DispatchWorkItem?
    private var tickTimer: Timer?

    /// MKPROD_HOME lets several copies run side by side (e.g. to test team sync on one Mac).
    static let profile = ProcessInfo.processInfo.environment["MKPROD_HOME"]
    static let defaults = profile.flatMap { UserDefaults(suiteName: "com.mkoussa.mkprod.\(URL(fileURLWithPath: $0).lastPathComponent)") } ?? .standard

    static var dataDir: URL {
        let dir = profile.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MKProd", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return dir
    }

    /// The local (this Mac only) workspace. Each shared workspace has its own file, so switching
    /// between workspaces never discards anything.
    static var fileURL: URL { dataDir.appendingPathComponent("workspace.json") }
    static func fileURL(for workspaceId: UUID?) -> URL {
        workspaceId.map { dataDir.appendingPathComponent("workspace-\($0.uuidString).json") } ?? fileURL
    }
    /// The file the current workspace (shared or local) is saved to.
    var currentFileURL: URL { Store.fileURL(for: cloud.workspaceId) }

    static func load(_ url: URL) -> AppData? {
        guard let raw = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(AppData.self, from: raw)
    }

    /// Older versions kept the connected shared workspace in workspace.json, replacing the local
    /// data (after writing a backup). Move that copy to its own file and bring the local workspace
    /// back from the oldest backup, which is the one made when the local data was first replaced.
    private static func migrateLayout(currentWorkspace: UUID?) {
        guard let id = currentWorkspace else { return }
        let target = fileURL(for: id)
        let fm = FileManager.default
        guard !fm.fileExists(atPath: target.path), fm.fileExists(atPath: fileURL.path) else { return }
        try? fm.moveItem(at: fileURL, to: target)
        let backups = ((try? fm.contentsOfDirectory(at: dataDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("backup-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        if let oldest = backups.first { try? fm.copyItem(at: oldest, to: fileURL) }
    }

    init() {
        let wsId = Store.defaults.string(forKey: "cloudWorkspaceId").flatMap(UUID.init)
        Store.migrateLayout(currentWorkspace: wsId)
        // Only a shared workspace's cached copy is ever loaded; with none chosen the app shows the picker.
        if let wsId, let decoded = Store.load(Store.fileURL(for: wsId)) {
            data = decoded
        } else {
            data = AppData(currentUserId: UUID())
        }
        startTicker()
        cloud.store = self
        cloud.start()
    }

    /// Swaps the in-memory workspace (when switching between workspaces) without treating the
    /// swap as a local edit to sync.
    func replaceData(_ newData: AppData) {
        saveWork?.cancel()
        cloud.applyingRemote = true
        data = newData
        cloud.applyingRemote = false
        openTaskId = nil
        selection = .home
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    /// Makes a data file readable only by the current macOS user (on top of FileVault).
    static func restrict(_ url: URL) {
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Writes a private file (mode 600). Uses complete data protection where the system
    /// supports it; where it doesn't (that write fails with EPERM on some Macs and in
    /// sandboxes), falls back to a plain atomic write, still protected by FileVault.
    static func writePrivate(_ raw: Data, to url: URL) throws {
        do { try raw.write(to: url, options: [.atomic, .completeFileProtection]) } catch { try raw.write(to: url, options: .atomic) }
        restrict(url)
    }

    func saveNow() {
        guard cloud.workspaceId != nil else { return } // nothing is kept outside a shared workspace
        do {
            let raw = try Store.encoder.encode(data)
            try Store.writePrivate(raw, to: currentFileURL)
        } catch {
            lastError = "Save failed: \(error.localizedDescription)"
        }
    }

    // Periodic checks: reminders, overdue automations.
    private func startTicker() {
        tickTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.tick()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.tick() }
    }

    func tick() {
        let now = Date()
        for i in data.reminders.indices where !data.reminders[i].done && !data.reminders[i].notified && data.reminders[i].date <= now {
            data.reminders[i].notified = true
            notify(data.reminders[i].title, taskId: data.reminders[i].taskId)
            postSystemNotification(title: "Reminder", body: data.reminders[i].title)
        }
        for t in data.tasks where !t.archived && !isClosed(t) {
            if let due = t.dueDate, due < now, !t.activity.contains(where: { $0.text == "Due date passed" }) {
                updateTask(t.id) { $0.activity.append(ActivityItem(text: "Due date passed")) }
                runAutomations(.dueDatePassed, task: t.id, value: "")
            }
        }
    }

    // MARK: - Lookups

    var me: Member { member(data.currentUserId) ?? Member(name: "Me") }
    func member(_ id: UUID?) -> Member? { data.members.first { $0.id == id } }
    func space(_ id: UUID?) -> Space? { data.spaces.first { $0.id == id } }
    func folder(_ id: UUID?) -> Folder? { data.folders.first { $0.id == id } }
    func list(_ id: UUID?) -> TaskList? { data.lists.first { $0.id == id } }
    func task(_ id: UUID?) -> TaskItem? { data.tasks.first { $0.id == id } }

    func space(ofList listId: UUID) -> Space? { space(list(listId)?.spaceId) }
    func space(ofTask t: TaskItem) -> Space? { space(ofList: t.listId) }

    func statuses(for t: TaskItem) -> [StatusDef] { space(ofTask: t)?.statuses ?? StatusDef.defaults() }
    func status(of t: TaskItem) -> StatusDef? { statuses(for: t).first { $0.id == t.statusId } }
    func isClosed(_ t: TaskItem) -> Bool {
        guard let k = status(of: t)?.kind else { return false }
        return k == .done || k == .closed
    }
    func isOverdue(_ t: TaskItem) -> Bool {
        guard let d = t.dueDate else { return false }
        return d < Date().startOfDay && !isClosed(t)
    }

    func lists(inSpace id: UUID, folder: UUID?) -> [TaskList] {
        data.lists.filter { $0.spaceId == id && $0.folderId == folder && !$0.archived }
    }

    func subtasks(of id: UUID) -> [TaskItem] {
        data.tasks.filter { $0.parentId == id && !$0.archived }.sorted { $0.order < $1.order }
    }

    /// Top-level tasks for a sidebar location.
    func tasks(for item: SidebarItem, includeSubtasks: Bool = false) -> [TaskItem] {
        let base = data.tasks.filter { !$0.archived && (includeSubtasks || $0.parentId == nil) }
        switch item {
        case .list(let id): return base.filter { inLists($0, [id]) }
        case .folder(let id):
            let ids = Set(data.lists.filter { $0.folderId == id }.map(\.id))
            return base.filter { inLists($0, ids) }
        case .space(let id):
            let ids = Set(data.lists.filter { $0.spaceId == id }.map(\.id))
            return base.filter { inLists($0, ids) }
        case .myTasks: return base.filter { $0.assigneeIds.contains(data.currentUserId) }
        default: return base
        }
    }

    func locationName(_ t: TaskItem) -> String {
        guard let l = list(t.listId) else { return "" }
        let s = space(l.spaceId)?.name ?? ""
        if let f = folder(l.folderId) { return "\(s) › \(f.name) › \(l.name)" }
        return "\(s) › \(l.name)"
    }

    func title(for item: SidebarItem) -> String {
        switch item {
        case .home: "Home"
        case .inbox: "Inbox"
        case .everything: "Everything"
        case .myTasks: "My Tasks"
        case .space(let id): space(id)?.name ?? "Space"
        case .folder(let id): folder(id)?.name ?? "Folder"
        case .list(let id): list(id)?.name ?? "List"
        case .docs: "Docs"
        case .doc(let id): data.docs.first { $0.id == id }?.title ?? "Doc"
        case .whiteboards: "Whiteboards"
        case .whiteboard(let id): data.whiteboards.first { $0.id == id }?.name ?? "Whiteboard"
        case .chat(let id): "#" + (data.channels.first { $0.id == id }?.name ?? "chat")
        case .goals: "Goals"
        case .dashboards: "Dashboards"
        case .dashboard(let id): data.dashboards.first { $0.id == id }?.name ?? "Dashboard"
        case .timesheet: "Timesheets"
        case .automations: "Automations"
        case .templates: "Templates"
        case .trash: "Trash"
        case .archive: "Archive"
        case .finDashboard: "Finance Overview"
        case .finAlerts: "Alerts"
        case .finBudgets: "Budgets"
        case .finOrders: "Orders & Expenses"
        case .finApprovals: "My Approvals"
        case .finCatalog: "Shopping Catalog"
        case .finContracts: "Contracts"
        case .finSavings: "Savings"
        case .finAnalytics: "Analytics"
        case .finReports: "Reports"
        case .finSettings: "Finance Settings"
        case .finAudit: "Audit Log"
        case .portfolio: "Portfolio"
        case .resources: "Resources"
        case .directory: "Content Directory"
        }
    }

    // MARK: - Hierarchy CRUD

    @discardableResult
    func addSpace(_ name: String) -> Space {
        var s = Space(name: name)
        s.colorHex = paletteHexes.randomElement()!
        data.spaces.append(s)
        let l = TaskList(spaceId: s.id, name: "List")
        data.lists.append(l)
        data.channels.append(ChatChannel(name: name.lowercased().replacingOccurrences(of: " ", with: "-"), spaceId: s.id))
        return s
    }

    @discardableResult
    func addFolder(_ name: String, space: UUID) -> Folder {
        let f = Folder(spaceId: space, name: name)
        data.folders.append(f)
        return f
    }

    @discardableResult
    func addList(_ name: String, space: UUID, folder: UUID?) -> TaskList {
        let l = TaskList(spaceId: space, folderId: folder, name: name)
        data.lists.append(l)
        return l
    }

    func deleteSpace(_ id: UUID) {
        let listIds = Set(data.lists.filter { $0.spaceId == id }.map(\.id))
        data.tasks.removeAll { listIds.contains($0.listId) }
        data.lists.removeAll { $0.spaceId == id }
        data.folders.removeAll { $0.spaceId == id }
        data.spaces.removeAll { $0.id == id }
        selection = .home
    }

    func deleteFolder(_ id: UUID) {
        let listIds = Set(data.lists.filter { $0.folderId == id }.map(\.id))
        data.tasks.removeAll { listIds.contains($0.listId) }
        data.lists.removeAll { $0.folderId == id }
        data.folders.removeAll { $0.id == id }
        selection = .home
    }

    func deleteList(_ id: UUID) {
        data.tasks.removeAll { $0.listId == id }
        data.lists.removeAll { $0.id == id }
        selection = .home
    }

    func duplicateList(_ id: UUID) {
        guard var l = list(id) else { return }
        let oldId = l.id
        l.id = UUID()
        l.name += " (copy)"
        data.lists.append(l)
        var idMap: [UUID: UUID] = [:]
        let source = data.tasks.filter { $0.listId == oldId }
        for t in source { idMap[t.id] = UUID() }
        for var t in source {
            t.id = idMap[t.id]!
            t.listId = l.id
            t.parentId = t.parentId.flatMap { idMap[$0] }
            t.comments = []
            t.activity = [ActivityItem(text: "Duplicated")]
            data.tasks.append(t)
        }
    }

    func toggleFavorite(_ id: UUID) {
        if let i = data.favorites.firstIndex(of: id) { data.favorites.remove(at: i) } else { data.favorites.append(id) }
    }

    // MARK: - Task CRUD

    @discardableResult
    func addTask(_ title: String, list listId: UUID, parent: UUID? = nil, status: UUID? = nil, due: Date? = nil) -> TaskItem {
        let sp = space(ofList: listId)
        let st = status ?? sp?.statuses.first?.id ?? UUID()
        let order = (data.tasks.filter { $0.listId == listId }.map(\.order).max() ?? 0) + 1
        var t = TaskItem(listId: listId, parentId: parent, title: title, statusId: st)
        t.order = order
        t.dueDate = due
        t.activity = [ActivityItem(text: "\(me.name) created this task")]
        data.tasks.append(t)
        runAutomations(.taskCreated, task: t.id, value: "")
        return t
    }

    func updateTask(_ id: UUID, _ change: (inout TaskItem) -> Void) {
        guard let i = data.tasks.firstIndex(where: { $0.id == id }) else { return }
        var t = data.tasks[i]
        let before = t
        change(&t)
        // Closing a task with open work asks first (not when an automation does it).
        if automationDepth == 0, !isClosed(before), isClosed(t), !confirmClose(t) { return }
        if t.statusId != before.statusId {
            if t.statusLog?.isEmpty ?? true { t.statusLog = [StatusChange(statusId: before.statusId, at: before.created)] }
            t.statusLog?.append(StatusChange(statusId: t.statusId, at: Date()))
        }
        t.updated = Date()
        data.tasks[i] = t
        afterChange(before: before, after: t)
        // Dependent tasks and subtasks follow a moved due date, if the space says so.
        if let b = before.dueDate, let a = t.dueDate {
            let days = Calendar.current.dateComponents([.day], from: b.startOfDay, to: a.startOfDay).day ?? 0
            if days != 0, let now = task(id) { cascadeDates(from: now, days: days) }
        }
    }

    private func afterChange(before: TaskItem, after t: TaskItem) {
        if before.statusId != t.statusId {
            let name = status(of: t)?.name ?? "?"
            appendActivity(t.id, "\(me.name) changed status to \(name)")
            if isClosed(t) {
                setCompleted(t.id, Date())
                spawnRecurrence(t)
            } else {
                setCompleted(t.id, nil)
            }
            runAutomations(.statusChanged, task: t.id, value: name)
        }
        if before.priority != t.priority {
            appendActivity(t.id, "\(me.name) set priority to \(t.priority.label)")
            runAutomations(.priorityChanged, task: t.id, value: t.priority.label)
        }
        let added = Set(t.assigneeIds).subtracting(before.assigneeIds)
        for a in added {
            let n = member(a)?.name ?? "someone"
            appendActivity(t.id, "\(me.name) assigned \(n)")
            if a == data.currentUserId { notify("You were assigned \"\(t.title)\"", taskId: t.id) }
            runAutomations(.assigneeAdded, task: t.id, value: n)
        }
        for tag in Set(t.tags).subtracting(before.tags) {
            runAutomations(.tagAdded, task: t.id, value: tag)
        }
        if before.dueDate != t.dueDate {
            appendActivity(t.id, t.dueDate.map { "\(me.name) set due date to \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "\(me.name) removed the due date")
        }
        if before.listId != t.listId {
            appendActivity(t.id, "\(me.name) moved this task to \(list(t.listId)?.name ?? "?")")
        }
    }

    private func setCompleted(_ id: UUID, _ date: Date?) {
        guard let i = data.tasks.firstIndex(where: { $0.id == id }) else { return }
        data.tasks[i].completedAt = date
    }

    private func appendActivity(_ id: UUID, _ text: String) {
        guard let i = data.tasks.firstIndex(where: { $0.id == id }) else { return }
        data.tasks[i].activity.append(ActivityItem(text: text))
    }

    private func spawnRecurrence(_ t: TaskItem) {
        guard t.recurrence != .none else { return }
        let comp: Calendar.Component
        switch t.recurrence {
        case .daily: comp = .day
        case .weekly: comp = .weekOfYear
        case .monthly: comp = .month
        case .yearly: comp = .year
        case .none: return
        }
        var n = t
        n.id = UUID()
        n.statusId = statuses(for: t).first?.id ?? t.statusId
        n.dueDate = t.dueDate.flatMap { Calendar.current.date(byAdding: comp, value: 1, to: $0) }
        n.startDate = t.startDate.flatMap { Calendar.current.date(byAdding: comp, value: 1, to: $0) }
        n.completedAt = nil
        n.comments = []
        n.created = Date()
        n.checklists = t.checklists.map { var c = $0; c.items = c.items.map { var i = $0; i.done = false; return i }; return c }
        n.activity = [ActivityItem(text: "Created from recurring task")]
        n.statusLog = nil
        n.number = nil
        data.tasks.append(n)
    }

    /// Points every reference to one member at another (used when the local user signs in to the cloud).
    func remapMember(from old: UUID, to new: UUID) {
        guard old != new else { return }
        func swap(_ id: UUID) -> UUID { id == old ? new : id }
        var d = data
        for i in d.members.indices where d.members[i].id == old { d.members[i].id = new }
        d.currentUserId = swap(d.currentUserId)
        for i in d.tasks.indices {
            d.tasks[i].assigneeIds = d.tasks[i].assigneeIds.map(swap)
            d.tasks[i].watcherIds = d.tasks[i].watcherIds.map(swap)
            for c in d.tasks[i].comments.indices {
                d.tasks[i].comments[c].authorId = swap(d.tasks[i].comments[c].authorId)
                d.tasks[i].comments[c].assigneeId = d.tasks[i].comments[c].assigneeId.map(swap)
            }
            for c in d.tasks[i].checklists.indices {
                for j in d.tasks[i].checklists[c].items.indices {
                    d.tasks[i].checklists[c].items[j].assigneeId = d.tasks[i].checklists[c].items[j].assigneeId.map(swap)
                }
            }
        }
        for i in d.messages.indices { d.messages[i].authorId = swap(d.messages[i].authorId) }
        for i in d.timeEntries.indices { d.timeEntries[i].memberId = swap(d.timeEntries[i].memberId) }
        for i in d.goals.indices { d.goals[i].ownerId = d.goals[i].ownerId.map(swap) }
        data = d
    }

    func deleteTask(_ id: UUID) {
        let children = data.tasks.filter { $0.parentId == id }.map(\.id)
        children.forEach(deleteTask)
        data.tasks.removeAll { $0.id == id }
        for i in data.tasks.indices {
            data.tasks[i].blockedBy.removeAll { $0 == id }
            data.tasks[i].linkedTaskIds.removeAll { $0 == id }
        }
        if openTaskId == id { openTaskId = nil }
    }

    /// Moves a task and its subtasks to Trash; they can be restored until the trash is emptied.
    func trashTask(_ id: UUID) {
        let now = Date()
        for child in data.tasks.filter({ $0.parentId == id }) { trashTask(child.id) }
        updateTask(id) { $0.archived = true; $0.trashedAt = now }
        if openTaskId == id { openTaskId = nil }
    }

    func restoreTask(_ id: UUID) {
        let wasTrashed = task(id)?.trashedAt
        updateTask(id) { $0.archived = false; $0.trashedAt = nil }
        if let wasTrashed {
            for child in data.tasks.filter({ $0.parentId == id && $0.trashedAt == wasTrashed }) { restoreTask(child.id) }
        }
    }

    /// Creates the sprint list that follows `listId`, continuing its cadence.
    func nextSprint(after listId: UUID) -> UUID {
        guard let l = list(listId) else { return listId }
        let length = max(Calendar.current.dateComponents([.day], from: l.sprintStart ?? Date(), to: l.sprintEnd ?? Date().adding(days: 13)).day ?? 13, 1)
        let start = (l.sprintEnd ?? Date()).startOfDay.adding(days: 1)
        let siblings = data.lists.filter { $0.spaceId == l.spaceId && $0.folderId == l.folderId && $0.isSprint }.count
        var n = TaskList(spaceId: l.spaceId, folderId: l.folderId, name: "Sprint \(siblings + 1)")
        n.sprintStart = start
        n.sprintEnd = start.adding(days: length)
        data.lists.append(n)
        return n.id
    }

    func duplicateTask(_ id: UUID) {
        guard var t = task(id) else { return }
        t.id = UUID()
        t.title += " (copy)"
        t.created = Date()
        t.activity = [ActivityItem(text: "Duplicated")]
        t.number = nil
        t.statusLog = nil
        t.order += 0.5
        data.tasks.append(t)
    }

    func addComment(_ text: String, to id: UUID) {
        updateTask(id) { $0.comments.append(Comment(authorId: self.data.currentUserId, text: text)) }
        // @mentions reach the inbox.
        for m in data.members where text.localizedCaseInsensitiveContains("@" + m.name.split(separator: " ").first!) {
            if m.id == data.currentUserId { notify("You were mentioned on \"\(task(id)?.title ?? "")\"", taskId: id) }
        }
        appendActivity(id, "\(me.name) commented")
    }

    func blockers(of t: TaskItem) -> [TaskItem] {
        t.blockedBy.compactMap { task($0) }.filter { !isClosed($0) }
    }

    func checklistProgress(_ t: TaskItem) -> (Int, Int) {
        let items = t.checklists.flatMap(\.items)
        return (items.filter(\.done).count, items.count)
    }

    // MARK: - Templates

    func saveTemplate(from id: UUID) {
        guard let t = task(id) else { return }
        data.templates.append(TaskTemplate(name: t.title, task: t, subtasks: subtasks(of: id)))
    }

    func instantiate(_ tpl: TaskTemplate, list listId: UUID) {
        var t = tpl.task
        t.id = UUID()
        t.listId = listId
        t.statusId = space(ofList: listId)?.statuses.first?.id ?? t.statusId
        t.created = Date()
        t.comments = []
        t.activity = [ActivityItem(text: "Created from template \"\(tpl.name)\"")]
        t.number = nil
        t.statusLog = nil
        data.tasks.append(t)
        for var s in tpl.subtasks {
            s.id = UUID()
            s.number = nil
            s.statusLog = nil
            s.parentId = t.id
            s.listId = listId
            s.statusId = t.statusId
            data.tasks.append(s)
        }
    }

    // MARK: - Time tracking

    var runningEntry: TimeEntry? { data.timeEntries.first { $0.end == nil } }

    func startTimer(task: UUID?) {
        stopTimer()
        data.timeEntries.append(TimeEntry(taskId: task, memberId: data.currentUserId, start: Date()))
    }

    func stopTimer() {
        if let i = data.timeEntries.firstIndex(where: { $0.end == nil }) {
            data.timeEntries[i].end = Date()
        }
    }

    func tracked(_ taskId: UUID) -> TimeInterval {
        data.timeEntries.filter { $0.taskId == taskId }.reduce(0) { $0 + $1.duration }
    }

    // MARK: - Inbox & notifications

    func notify(_ text: String, taskId: UUID?) {
        data.inbox.insert(InboxItem(text: text, taskId: taskId), at: 0)
    }

    var unreadCount: Int { data.inbox.filter { !$0.read && !$0.cleared }.count }

    func requestNotificationPermission() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func postSystemNotification(title: String, body: String) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
    }

    // MARK: - Automations

    private(set) var automationDepth = 0

    func runAutomations(_ trigger: TriggerType, task id: UUID, value: String) {
        // Guard against rules that keep triggering each other.
        guard automationDepth < 4, let t = task(id) else { return }
        let sp = space(ofTask: t)?.id
        let rules = data.automations.filter {
            $0.enabled && $0.trigger == trigger && ($0.spaceId == nil || $0.spaceId == sp)
                && ($0.triggerValue.isEmpty || $0.triggerValue.caseInsensitiveCompare(value) == .orderedSame)
        }
        guard !rules.isEmpty else { return }
        automationDepth += 1
        defer { automationDepth -= 1 }
        for r in rules {
            apply(r, to: id)
            if let i = data.automations.firstIndex(where: { $0.id == r.id }) { data.automations[i].runCount += 1 }
        }
    }

    private func apply(_ r: Automation, to id: UUID) {
        guard let t = task(id) else { return }
        let v = r.actionValue
        switch r.action {
        case .setStatus:
            if let s = statuses(for: t).first(where: { $0.name.caseInsensitiveCompare(v) == .orderedSame }) {
                updateTask(id) { $0.statusId = s.id }
            }
        case .setPriority:
            if let p = Priority.allCases.first(where: { $0.label.caseInsensitiveCompare(v) == .orderedSame }) {
                updateTask(id) { $0.priority = p }
            }
        case .assign:
            if let m = data.members.first(where: { $0.name.caseInsensitiveCompare(v) == .orderedSame }), !t.assigneeIds.contains(m.id) {
                updateTask(id) { $0.assigneeIds.append(m.id) }
            }
        case .addTag:
            if !v.isEmpty, !t.tags.contains(v) { updateTask(id) { $0.tags.append(v) } }
        case .moveToList:
            if let l = data.lists.first(where: { $0.name.caseInsensitiveCompare(v) == .orderedSame }) {
                updateTask(id) { $0.listId = l.id }
            }
        case .addComment:
            updateTask(id) { $0.comments.append(Comment(authorId: self.data.currentUserId, text: "🤖 " + v)) }
        case .setDueInDays:
            if let n = Int(v) { updateTask(id) { $0.dueDate = Date().adding(days: n) } }
        case .archive:
            updateTask(id) { $0.archived = true }
        }
        appendActivity(id, "Automation \"\(r.name)\" ran")
    }

    // MARK: - Goals

    func progress(_ target: GoalTarget) -> Double {
        switch target.kind {
        case .boolean: return target.current >= 1 ? 1 : 0
        case .tasks:
            let ts = target.taskIds.compactMap { task($0) }
            guard !ts.isEmpty else { return 0 }
            return Double(ts.filter(isClosed).count) / Double(ts.count)
        case .number, .currency:
            let span = target.target - target.start
            guard span != 0 else { return 0 }
            return min(max((target.current - target.start) / span, 0), 1)
        }
    }

    func progress(_ g: Goal) -> Double {
        guard !g.targets.isEmpty else { return 0 }
        return g.targets.map(progress).reduce(0, +) / Double(g.targets.count)
    }

    // MARK: - Import / export

    func exportJSON(to url: URL) throws {
        try Store.encoder.encode(data).write(to: url, options: .atomic)
    }

    func importJSON(from url: URL) throws {
        data = try Store.decoder.decode(AppData.self, from: Data(contentsOf: url))
        selection = .home
    }

    func exportCSV(_ tasks: [TaskItem], to url: URL) throws {
        func esc(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        let df = ISO8601DateFormatter()
        var lines = ["Title,Status,Priority,Assignees,Tags,Start,Due,Location,Estimate (min),Tracked (min)"]
        for t in tasks {
            lines.append([
                esc(t.title), esc(status(of: t)?.name ?? ""), t.priority.label,
                esc(t.assigneeIds.compactMap { member($0)?.name }.joined(separator: "; ")),
                esc(t.tags.joined(separator: "; ")),
                t.startDate.map(df.string) ?? "", t.dueDate.map(df.string) ?? "",
                esc(locationName(t)), t.estimateMinutes.map(String.init) ?? "",
                String(Int(tracked(t.id) / 60)),
            ].joined(separator: ","))
        }
        try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    /// Handles mkprod://task/<id>, mkprod://list/<id> and mkprod://doc/<id> links.
    func open(_ url: URL) {
        guard url.scheme == "mkprod", let id = UUID(uuidString: url.lastPathComponent) else { return }
        switch url.host {
        case "task":
            if let t = task(id) { selection = .list(t.listId); openTaskId = id }
        case "list": selection = .list(id)
        case "doc": selection = .doc(id)
        default: break
        }
    }

    func resetToSample() {
        data = SampleData.make()
        selection = .home
    }
}

extension Notification.Name {
    static let newTask = Notification.Name("MKProd.newTask")
}
