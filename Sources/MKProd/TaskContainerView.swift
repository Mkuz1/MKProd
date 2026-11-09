import SwiftUI
import AppKit

enum ViewMode: String, CaseIterable, Identifiable {
    case list = "List", board = "Board", calendar = "Calendar", gantt = "Gantt", table = "Table", chart = "Chart", workload = "Workload", team = "Team", activity = "Activity", mindmap = "Mind Map", form = "Form"
    var id: String { rawValue }
    /// The website's key for this mode, used by saved views ("mindmap", "list"…).
    var key: String { rawValue.lowercased().replacingOccurrences(of: " ", with: "") }
    init?(key: String) { guard let m = ViewMode.allCases.first(where: { $0.key == key }) else { return nil }; self = m }
    var icon: String {
        switch self {
        case .list: "list.bullet"
        case .board: "rectangle.split.3x1"
        case .calendar: "calendar"
        case .gantt: "chart.bar.doc.horizontal"
        case .table: "tablecells"
        case .chart: "chart.pie"
        case .workload: "person.3.sequence"
        case .team: "person.2.crop.square.stack"
        case .activity: "clock.arrow.circlepath"
        case .mindmap: "point.3.connected.trianglepath.dotted"
        case .form: "list.clipboard"
        }
    }
}

enum GroupBy: String, CaseIterable, Identifiable {
    case status = "Status", priority = "Priority", assignee = "Assignee", type = "Task type", due = "Due date", list = "List", none = "None"
    var id: String { rawValue }
    /// The website's key, used by saved views.
    var key: String {
        switch self {
        case .status: "status"
        case .priority: "priority"
        case .assignee: "assignee"
        case .type: "type"
        case .due: "due"
        case .list: "list"
        case .none: "none"
        }
    }
    init(key: String) { self = GroupBy.allCases.first { $0.key == key } ?? .status }
}

enum SortBy: String, CaseIterable, Identifiable {
    case manual = "Manual", due = "Due date", priority = "Priority", title = "Name", created = "Date created", updated = "Date updated"
    var id: String { rawValue }
    var key: String {
        switch self {
        case .manual: "manual"
        case .due: "due"
        case .priority: "priority"
        case .title: "title"
        case .created: "created"
        case .updated: "updated"
        }
    }
    init(key: String) { self = SortBy.allCases.first { $0.key == key } ?? .manual }
}

struct TaskFilter {
    var search = ""
    var assignee: UUID?
    var priority: Priority?
    var tag: String?
    /// A task type id, or "task" for tasks without a type; matched by name across spaces.
    var typeId: String?
    var showClosed = true
    var onlyOverdue = false
}

struct TaskGroup: Identifiable {
    var id: String
    var title: String
    var color: Color
    var statusId: UUID?
    var priority: Priority?
    var assignee: UUID?
    var tasks: [TaskItem]
    /// Work-in-progress limit of the status (status grouping only).
    var wipLimit: Int?
    /// Dropping a task here gives it this task type (nil name = plain task).
    var typeName: String??
}

struct TaskContainerView: View {
    let location: SidebarItem
    @Environment(Store.self) private var store
    @AppStorage("viewMode") private var modeRaw = ViewMode.list.rawValue
    @State private var groupBy: GroupBy = .status
    @State private var sortBy: SortBy = .manual
    @State private var filter = TaskFilter()
    @State private var quickTitle = ""
    @State private var activeView: UUID?
    @State private var appliedDefault = false
    @FocusState private var quickFocused: Bool

    private var mode: ViewMode { ViewMode(rawValue: modeRaw) ?? .list }

    /// Saved-view location key, same as the website's ("everything", "mine", "list:<ID>"…).
    private var scopeKey: String {
        switch location {
        case .list(let id): "list:\(id.uuidString)"
        case .folder(let id): "folder:\(id.uuidString)"
        case .space(let id): "space:\(id.uuidString)"
        case .myTasks: "mine"
        default: "everything"
        }
    }

    private func currentView() -> SavedView {
        var f = ViewFilter()
        f.search = filter.search
        f.assigneeId = filter.assignee
        f.priority = filter.priority?.rawValue
        f.tag = filter.tag
        f.typeId = filter.typeId
        f.showClosed = filter.showClosed
        f.onlyOverdue = filter.onlyOverdue
        return SavedView(name: "", scope: scopeKey, mode: mode.key, groupBy: groupBy.key, sortBy: sortBy.key, filter: f, ownerId: store.data.currentUserId)
    }

    private func applyView(_ v: SavedView) {
        if let m = ViewMode(key: v.mode) { modeRaw = m.rawValue }
        groupBy = GroupBy(key: v.groupBy)
        sortBy = SortBy(key: v.sortBy)
        var f = TaskFilter()
        f.search = v.filter.search
        f.assignee = v.filter.assigneeId
        f.priority = v.filter.priority.flatMap(Priority.init(rawValue:))
        f.tag = v.filter.tag
        f.typeId = v.filter.typeId
        f.showClosed = v.filter.showClosed
        f.onlyOverdue = v.filter.onlyOverdue
        filter = f
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if case .list(let id) = location, let l = store.list(id), l.isSprint {
                SprintBar(list: l)
            }
            Divider()
            filterBar
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle(store.title(for: location))
        .onAppear {
            store.assignTaskNumbers()
            if !appliedDefault, let d = store.defaultView(for: scopeKey) { activeView = d.id; applyView(d) }
            appliedDefault = true
        }
        .onChange(of: store.data.tasks.count) { store.assignTaskNumbers() }
        .onReceive(NotificationCenter.default.publisher(for: .newTask)) { _ in quickFocused = true }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            breadcrumb
            SavedViewsBar(scope: scopeKey, active: $activeView, current: currentView, apply: applyView, reset: {
                activeView = nil; groupBy = .status; sortBy = .manual; filter = TaskFilter()
            })
            .padding(.horizontal, -16)
            Picker("View", selection: $modeRaw) {
                ForEach(ViewMode.allCases) { m in Label(m.rawValue, systemImage: m.icon).tag(m.rawValue) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    @ViewBuilder
    private var breadcrumb: some View {
        HStack(spacing: 6) {
            if case .list(let id) = location, let l = store.list(id) {
                if let s = store.space(l.spaceId) { Text(s.name).foregroundStyle(.secondary) ; Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                if let f = store.folder(l.folderId) { Text(f.name).foregroundStyle(.secondary); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
                Text(l.name).font(.title3.bold()).lineLimit(1).fixedSize()
                Button { store.toggleFavorite(id) } label: {
                    Image(systemName: store.data.favorites.contains(id) ? "star.fill" : "star").foregroundStyle(.yellow)
                }.buttonStyle(.plain)
            } else {
                Text(store.title(for: location)).font(.title3.bold())
            }
        }
    }

    private var filterBar: some View {
        HStack(spacing: 10) {
            HStack {
                Image(systemName: "plus.circle.fill").foregroundStyle(Color.accentColor)
                TextField("Add a task and press Return (⌘N)", text: $quickTitle)
                    .textFieldStyle(.plain)
                    .focused($quickFocused)
                    .onSubmit(addQuick)
            }
            .padding(6)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
            .frame(minWidth: 200, maxWidth: 320)

            Spacer(minLength: 8)

            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal.decrease").foregroundStyle(.secondary)
                TextField("Filter", text: $filter.search).textFieldStyle(.roundedBorder).frame(width: 110)
            }
            Menu {
                Picker("Assignee", selection: $filter.assignee) {
                    Text("Anyone").tag(UUID?.none)
                    ForEach(store.data.members) { Text($0.name).tag(Optional($0.id)) }
                }
                Picker("Priority", selection: $filter.priority) {
                    Text("Any").tag(Priority?.none)
                    ForEach(Priority.allCases.reversed()) { Text($0.label).tag(Optional($0)) }
                }
                Picker("Tag", selection: $filter.tag) {
                    Text("Any").tag(String?.none)
                    ForEach(allTags, id: \.self) { Text($0).tag(Optional($0)) }
                }
                if !allTypes.isEmpty {
                    Picker("Task type", selection: $filter.typeId) {
                        Text("Any").tag(String?.none)
                        Text("✓ Task").tag(Optional("task"))
                        ForEach(allTypes) { Text("\($0.icon) \($0.name)").tag(Optional($0.id.uuidString)) }
                    }
                }
                Divider()
                Toggle("Show closed", isOn: $filter.showClosed)
                Toggle("Only overdue", isOn: $filter.onlyOverdue)
                Divider()
                Button("Me mode") { filter.assignee = store.data.currentUserId }
                Button("Clear filters") { filter = TaskFilter() }
            } label: {
                Label(activeFilterCount > 0 ? "Filters (\(activeFilterCount))" : "Filters", systemImage: "slider.horizontal.3")
            }
            .fixedSize()
            Picker("Group", selection: $groupBy) { ForEach(GroupBy.allCases) { Text($0.rawValue).tag($0) } }
                .fixedSize()
            Picker("Sort", selection: $sortBy) { ForEach(SortBy.allCases) { Text($0.rawValue).tag($0) } }
                .fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private var activeFilterCount: Int {
        [filter.assignee != nil, filter.priority != nil, filter.tag != nil, filter.typeId != nil, !filter.showClosed, filter.onlyOverdue].filter { $0 }.count
    }

    private var allTags: [String] { Array(Set(store.data.tasks.flatMap(\.tags))).sorted() }

    /// Task types of the spaces in view, once per name.
    private var allTypes: [TaskTypeDef] {
        var seen: Set<String> = []
        return spacesInView.flatMap { $0.taskTypes ?? [] }.filter { seen.insert($0.name).inserted }
    }

    private var spacesInView: [Space] {
        switch location {
        case .list(let id): store.space(ofList: id).map { [$0] } ?? []
        case .folder(let id): store.space(store.folder(id)?.spaceId).map { [$0] } ?? []
        case .space(let id): store.space(id).map { [$0] } ?? []
        default: store.data.spaces
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        let tasks = filtered
        switch mode {
        case .list: TaskListView(groups: groups(tasks), defaultList: defaultListId)
        case .board: BoardView(groups: groups(tasks, forBoard: true), defaultList: defaultListId)
        case .calendar: CalendarView(tasks: tasks, defaultList: defaultListId)
        case .gantt: GanttView(tasks: tasks)
        case .table: TaskTableView(tasks: tasks, fields: fields)
        case .chart: TaskChartView(tasks: tasks)
        case .workload: WorkloadView(tasks: tasks)
        case .team: TeamModeView(tasks: tasks)
        case .activity: ActivityModeView(tasks: tasks)
        case .mindmap: MindMapView(location: location, tasks: tasks)
        case .form: TaskFormView(defaultList: defaultListId)
        }
    }

    private var fields: [FieldDef] {
        switch location {
        case .list(let id): store.space(ofList: id)?.fields ?? []
        case .space(let id): store.space(id)?.fields ?? []
        case .folder(let id): store.space(store.folder(id)?.spaceId)?.fields ?? []
        default: []
        }
    }

    private var defaultListId: UUID? {
        switch location {
        case .list(let id): return id
        case .folder(let id): return store.data.lists.first { $0.folderId == id }?.id
        case .space(let id): return store.data.lists.first { $0.spaceId == id }?.id
        default: return store.data.lists.first { !$0.archived }?.id
        }
    }

    private func addQuick() {
        let t = quickTitle.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let l = defaultListId else { return }
        let new = store.addTask(t, list: l)
        if case .myTasks = location { store.updateTask(new.id) { $0.assigneeIds = [store.data.currentUserId] } }
        quickTitle = ""
    }

    private var filtered: [TaskItem] {
        var ts = store.tasks(for: location)
        let q = filter.search.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { ts = ts.filter { $0.title.localizedCaseInsensitiveContains(q) || $0.tags.contains { $0.localizedCaseInsensitiveContains(q) } || (store.taskKey($0)?.localizedCaseInsensitiveContains(q) ?? false) } }
        if let ty = filter.typeId {
            let name = store.data.spaces.flatMap { $0.taskTypes ?? [] }.first { $0.id.uuidString == ty }?.name
            ts = ts.filter { ty == "task" ? store.taskType($0) == nil : store.taskType($0)?.name == name }
        }
        if let a = filter.assignee { ts = ts.filter { $0.assigneeIds.contains(a) } }
        if let p = filter.priority { ts = ts.filter { $0.priority == p } }
        if let tag = filter.tag { ts = ts.filter { $0.tags.contains(tag) } }
        if !filter.showClosed { ts = ts.filter { !store.isClosed($0) } }
        if filter.onlyOverdue { ts = ts.filter(store.isOverdue) }
        switch sortBy {
        case .manual: ts.sort { $0.order < $1.order }
        case .due: ts.sort { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
        case .priority: ts.sort { $0.priority > $1.priority }
        case .title: ts.sort { $0.title.localizedCompare($1.title) == .orderedAscending }
        case .created: ts.sort { $0.created > $1.created }
        case .updated: ts.sort { $0.updated > $1.updated }
        }
        return ts
    }

    private func groups(_ tasks: [TaskItem], forBoard: Bool = false) -> [TaskGroup] {
        let g = (forBoard && (groupBy == .none || groupBy == .due || groupBy == .list)) ? GroupBy.status : groupBy
        switch g {
        case .status:
            // Merge statuses by name so multi-space views still group sensibly.
            var order: [StatusDef] = []
            let spaces: [Space]
            switch location {
            case .list(let id): spaces = store.space(ofList: id).map { [$0] } ?? []
            case .folder(let id): spaces = store.space(store.folder(id)?.spaceId).map { [$0] } ?? []
            case .space(let id): spaces = store.space(id).map { [$0] } ?? []
            default: spaces = store.data.spaces
            }
            for s in spaces.flatMap(\.statuses) where !order.contains(where: { $0.name == s.name }) { order.append(s) }
            return order.compactMap { s in
                let ts = tasks.filter { store.status(of: $0)?.name == s.name }
                if ts.isEmpty && spaces.count > 1 { return nil }
                if !filter.showClosed && (s.kind == .done || s.kind == .closed) { return nil }
                let limit = spaces.flatMap(\.statuses).filter { $0.name == s.name }.compactMap(\.wipLimit).min()
                return TaskGroup(id: s.name, title: s.name, color: Color(hex: s.colorHex), statusId: spaces.count == 1 ? s.id : nil, tasks: ts, wipLimit: limit)
            }
        case .type:
            var out = [TaskGroup(id: "type:task", title: "✓ Task", color: .gray, tasks: tasks.filter { store.taskType($0) == nil }, typeName: .some(nil))]
            for ty in allTypes {
                out.append(TaskGroup(id: "type:" + ty.name, title: "\(ty.icon) \(ty.name)", color: Color(hex: ty.colorHex), tasks: tasks.filter { store.taskType($0)?.name == ty.name }, typeName: .some(ty.name)))
            }
            return out
        case .priority:
            return Priority.allCases.reversed().map { p in
                TaskGroup(id: p.label, title: p.label, color: p.color, priority: p, tasks: tasks.filter { $0.priority == p })
            }
        case .assignee:
            var out = store.data.members.map { m in
                TaskGroup(id: m.id.uuidString, title: m.name, color: Color(hex: m.colorHex), assignee: m.id, tasks: tasks.filter { $0.assigneeIds.contains(m.id) })
            }
            out.append(TaskGroup(id: "unassigned", title: "Unassigned", color: .gray, tasks: tasks.filter { $0.assigneeIds.isEmpty }))
            return out.filter { !$0.tasks.isEmpty || $0.assignee == store.data.currentUserId }
        case .due:
            let today = Date().startOfDay
            let buckets: [(String, Color, (TaskItem) -> Bool)] = [
                ("Overdue", .red, { ($0.dueDate ?? .distantFuture) < today }),
                ("Today", .orange, { $0.dueDate.map { Calendar.current.isDateInToday($0) } ?? false }),
                ("Next 7 days", .blue, { guard let d = $0.dueDate else { return false }; return d >= today.adding(days: 1) && d < today.adding(days: 8) }),
                ("Later", .purple, { ($0.dueDate ?? .distantPast) >= today.adding(days: 8) }),
                ("No due date", .gray, { $0.dueDate == nil }),
            ]
            return buckets.map { b in TaskGroup(id: b.0, title: b.0, color: b.1, tasks: tasks.filter(b.2)) }.filter { !$0.tasks.isEmpty }
        case .list:
            return store.data.lists.compactMap { l in
                let ts = tasks.filter { $0.listId == l.id }
                return ts.isEmpty ? nil : TaskGroup(id: l.id.uuidString, title: l.name, color: l.colorHex.map { Color(hex: $0) } ?? .accentColor, tasks: ts)
            }
        case .none:
            return [TaskGroup(id: "all", title: "All tasks", color: .accentColor, tasks: tasks)]
        }
    }
}

// MARK: - Shared row context menu

struct TaskContextMenu: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        Button("Open") { store.openTaskId = task.id }
        Button("Add Subtask") {
            let s = store.addTask("New subtask", list: task.listId, parent: task.id)
            store.openTaskId = s.id
        }
        Button("Start Timer") { store.startTimer(task: task.id) }
        Menu("Status") {
            ForEach(store.statuses(for: task)) { s in Button(s.name) { store.updateTask(task.id) { $0.statusId = s.id } } }
        }
        Menu("Priority") {
            ForEach(Priority.allCases.reversed()) { p in Button(p.label) { store.updateTask(task.id) { $0.priority = p } } }
        }
        Menu("Move to") {
            ForEach(store.data.lists.filter { !$0.archived }) { l in
                Button(l.name) {
                    let target = store.space(ofList: l.id)
                    store.updateTask(task.id) { t in
                        t.listId = l.id
                        if !(target?.statuses.contains { $0.id == t.statusId } ?? true) { t.statusId = target?.statuses.first?.id ?? t.statusId }
                    }
                }
            }
        }
        Divider()
        Button("Duplicate") { store.duplicateTask(task.id) }
        Button("Save as Template") { store.saveTemplate(from: task.id) }
        Button("Copy Link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("mkprod://task/\(task.id.uuidString)", forType: .string)
        }
        Button("Copy Title") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(task.title, forType: .string)
        }
        Divider()
        Button("Archive") { store.updateTask(task.id) { $0.archived = true } }
        Button("Delete", role: .destructive) { store.trashTask(task.id) }
    }
}

// MARK: - List view

struct TaskListView: View {
    let groups: [TaskGroup]
    let defaultList: UUID?
    @Environment(Store.self) private var store
    @State private var collapsed: Set<String> = []
    @State private var expanded: Set<UUID> = []
    @State private var selected: Set<UUID> = []

    var body: some View {
        if groups.allSatisfy({ $0.tasks.isEmpty }) && groups.count <= 1 {
            EmptyState(icon: "checklist", title: "No tasks yet", subtitle: "Add a task above to get started.")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(groups) { g in groupView(g) }
                }
                .padding(16)
                .padding(.bottom, selected.isEmpty ? 0 : 70)
            }
            .overlay(alignment: .bottom) {
                if !selected.isEmpty { BulkActionBar(selection: $selected) }
            }
            .onExitCommand { selected = [] }
        }
    }

    @ViewBuilder
    private func groupView(_ g: TaskGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button { toggle(g.id) } label: {
                    Image(systemName: collapsed.contains(g.id) ? "chevron.right" : "chevron.down").frame(width: 12)
                }.buttonStyle(.plain)
                Text(g.title.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(g.color, in: RoundedRectangle(cornerRadius: 4))
                    .foregroundStyle(.white)
                WipCount(group: g)
                Spacer()
            }
            .padding(.bottom, 6)
            if !collapsed.contains(g.id) {
                columnHeader
                ForEach(g.tasks) { t in
                    TaskRow(task: t, depth: 0, expanded: $expanded, selected: $selected)
                    if expanded.contains(t.id) {
                        ForEach(store.subtasks(of: t.id)) { s in TaskRow(task: s, depth: 1, expanded: $expanded, selected: $selected) }
                    }
                }
                InlineAdd(group: g, defaultList: defaultList)
            }
        }
        .dropDestination(for: String.self) { items, _ in
            for s in items { if let id = UUID(uuidString: s) { apply(g, to: id) } }
            return true
        }
    }

    private var columnHeader: some View {
        HStack {
            Text("Name").frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 36)
            Text("Assignee").frame(width: 80)
            Text("Due date").frame(width: 80)
            Text("Priority").frame(width: 60)
            Text("Tracked").frame(width: 60)
        }
        .font(.caption).foregroundStyle(.tertiary)
        .padding(.vertical, 4)
    }

    private func toggle(_ id: String) {
        if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
    }

    private func apply(_ g: TaskGroup, to id: UUID) {
        store.updateTask(id) { t in
            if let s = g.statusId { t.statusId = s }
            if let p = g.priority { t.priority = p }
            if let a = g.assignee, !t.assigneeIds.contains(a) { t.assigneeIds.append(a) }
            if let name = g.typeName { t.typeId = store.space(ofTask: t)?.taskTypes?.first { $0.name == name }?.id }
        }
    }
}

/// "3" or, with a work-in-progress limit, "3 / 2 · over limit" in red. Closed tasks don't count.
struct WipCount: View {
    let group: TaskGroup
    @Environment(Store.self) private var store

    var body: some View {
        let open = group.tasks.filter { !store.isClosed($0) }.count
        if let limit = group.wipLimit {
            Text(open > limit ? "\(open) / \(limit) · over limit" : "\(open) / \(limit)")
                .font(.caption.weight(open > limit ? .bold : .regular))
                .foregroundStyle(open > limit ? Color.red : Color.secondary)
                .help("Work-in-progress limit \(limit)")
        } else {
            Text("\(group.tasks.count)").foregroundStyle(.secondary).font(.caption)
        }
    }
}

struct TaskRow: View {
    let task: TaskItem
    let depth: Int
    @Binding var expanded: Set<UUID>
    @Binding var selected: Set<UUID>
    @Environment(Store.self) private var store
    @State private var hovering = false

    var body: some View {
        let subs = store.subtasks(of: task.id)
        let (done, total) = store.checklistProgress(task)
        let closed = store.isClosed(task)
        HStack(spacing: 8) {
            Group {
                if !subs.isEmpty {
                    Button {
                        if expanded.contains(task.id) { expanded.remove(task.id) } else { expanded.insert(task.id) }
                    } label: { Image(systemName: expanded.contains(task.id) ? "chevron.down" : "chevron.right").font(.caption) }
                    .buttonStyle(.plain)
                } else { Color.clear }
            }
            .frame(width: 12)
            .padding(.leading, CGFloat(depth) * 22)

            Button { toggleSelected() } label: {
                Image(systemName: selected.contains(task.id) ? "checkmark.square.fill" : "square")
                    .foregroundStyle(selected.contains(task.id) ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)
            .opacity(hovering || !selected.isEmpty ? 1 : 0.2)
            .help("Select for bulk edit (or ⌘-click the row)")

            Button {
                let st = store.statuses(for: task)
                let target = closed ? st.first : st.first { $0.kind == .done }
                if let target { store.updateTask(task.id) { $0.statusId = target.id } }
            } label: {
                Image(systemName: closed ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(Color(hex: store.status(of: task)?.colorHex ?? "#87909E"))
            }
            .buttonStyle(.plain)
            .help("Mark complete")

            HStack(spacing: 6) {
                if task.isMilestone { Image(systemName: "diamond.fill").foregroundStyle(.purple).font(.caption) }
                TypeBadge(task: task)
                TaskKeyChip(task: task)
                Text(task.title)
                    .strikethrough(closed)
                    .foregroundStyle(closed ? .secondary : .primary)
                    .lineLimit(1)
                if !store.blockers(of: task).isEmpty {
                    Image(systemName: "hand.raised.fill").foregroundStyle(.red).font(.caption).help("Blocked")
                }
                if !subs.isEmpty {
                    Label("\(subs.count)", systemImage: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary)
                }
                if total > 0 {
                    Label("\(done)/\(total)", systemImage: "checklist").font(.caption).foregroundStyle(done == total ? .green : .secondary)
                }
                if !task.comments.isEmpty {
                    Label("\(task.comments.count)", systemImage: "bubble.left").font(.caption).foregroundStyle(.secondary)
                }
                if task.recurrence != .none { Image(systemName: "repeat").font(.caption).foregroundStyle(.secondary) }
                ForEach(task.tags.prefix(3), id: \.self) { TagChip(tag: $0) }
                if (task.extraListIds?.count ?? 0) > 0 {
                    Label("\((task.extraListIds?.count ?? 0) + 1)", systemImage: "square.on.square").font(.caption).foregroundStyle(.secondary).help("Also in other lists")
                }
                PinnedFieldChips(task: task)
                if hovering {
                    StatusMenu(task: task)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            AssigneeMenu(task: task).frame(width: 80)
            DatePopoverButton(date: task.dueDate, overdue: store.isOverdue(task)) { d in store.updateTask(task.id) { $0.dueDate = d } }
                .frame(width: 80)
            PriorityMenu(task: task).frame(width: 60)
            Text(store.tracked(task.id) > 0 ? store.tracked(task.id).hoursMinutes : "—")
                .font(.caption).foregroundStyle(.secondary).frame(width: 60)
        }
        .padding(.vertical, 6).padding(.horizontal, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(selected.contains(task.id) || store.openTaskId == task.id ? Color.accentColor.opacity(0.12) : (hovering ? Color.primary.opacity(0.04) : .clear))
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.command) || !selected.isEmpty { toggleSelected() } else { store.openTaskId = task.id }
        }
        .draggable(task.id.uuidString)
        .contextMenu { TaskContextMenu(task: task) }
        Divider().opacity(0.5)
    }

    private func toggleSelected() {
        if selected.contains(task.id) { selected.remove(task.id) } else { selected.insert(task.id) }
    }
}

struct InlineAdd: View {
    let group: TaskGroup
    let defaultList: UUID?
    @Environment(Store.self) private var store
    @State private var adding = false
    @State private var text = ""

    var body: some View {
        if adding {
            HStack {
                Image(systemName: "circle").foregroundStyle(.tertiary)
                TextField("Task name", text: $text)
                    .textFieldStyle(.plain)
                    .onSubmit(commit)
                    .onExitCommand { adding = false }
                Button("Save", action: commit).buttonStyle(.borderedProminent).controlSize(.small)
                Button("Cancel") { adding = false }.controlSize(.small)
            }
            .padding(.vertical, 6).padding(.leading, 26)
        } else {
            Button { adding = true } label: {
                Label("New task", systemImage: "plus").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6).padding(.leading, 26)
        }
    }

    private func commit() {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let l = defaultList else { return }
        let new = store.addTask(t, list: l, status: group.statusId)
        store.updateTask(new.id) { x in
            if let p = group.priority { x.priority = p }
            if let a = group.assignee { x.assigneeIds = [a] }
        }
        text = ""
    }
}

// MARK: - Board view

struct BoardView: View {
    let groups: [TaskGroup]
    let defaultList: UUID?
    @Environment(Store.self) private var store
    @State private var targeted: String?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(groups) { g in column(g) }
            }
            .padding(16)
        }
    }

    private func column(_ g: TaskGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(g.color).frame(width: 9, height: 9)
                Text(g.title.uppercased()).font(.system(size: 11, weight: .bold))
                WipCount(group: g)
                Spacer()
            }
            .padding(.horizontal, 6).padding(.top, 4)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(g.tasks) { t in BoardCard(task: t) }
                    InlineAdd(group: g, defaultList: defaultList)
                }
                .padding(.bottom, 8)
            }
        }
        .padding(8)
        .frame(width: 280)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(g.color.opacity(targeted == g.id ? 0.18 : 0.06))
        )
        .overlay(alignment: .top) { Rectangle().fill(g.color).frame(height: 3).clipShape(RoundedRectangle(cornerRadius: 2)) }
        .overlay {
            if let limit = g.wipLimit, g.tasks.filter({ !store.isClosed($0) }).count > limit {
                RoundedRectangle(cornerRadius: 10).stroke(Color.red.opacity(0.55), lineWidth: 1.5)
            }
        }
        .dropDestination(for: String.self) { items, _ in
            for s in items {
                guard let id = UUID(uuidString: s) else { continue }
                store.updateTask(id) { t in
                    if let st = g.statusId { t.statusId = st }
                    else if let st = store.statuses(for: t).first(where: { $0.name == g.title }) { t.statusId = st.id }
                    if let p = g.priority { t.priority = p }
                    if let a = g.assignee { t.assigneeIds = [a] }
                    if let name = g.typeName { t.typeId = store.space(ofTask: t)?.taskTypes?.first { $0.name == name }?.id }
                }
            }
            return true
        } isTargeted: { targeted = $0 ? g.id : (targeted == g.id ? nil : targeted) }
    }
}

struct BoardCard: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        let (done, total) = store.checklistProgress(task)
        let subs = store.subtasks(of: task.id)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                TypeBadge(task: task)
                TaskKeyChip(task: task)
                Text(store.list(task.listId)?.name ?? "").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Text(task.title).font(.callout.weight(.medium)).strikethrough(store.isClosed(task)).lineLimit(3)
            if !task.tags.isEmpty || (store.space(ofTask: task)?.fields.contains { $0.pinned ?? false } ?? false) {
                HStack(spacing: 4) { ForEach(task.tags.prefix(3), id: \.self) { TagChip(tag: $0) }; PinnedFieldChips(task: task) }
            }
            HStack(spacing: 8) {
                AssigneeMenu(task: task)
                DatePopoverButton(date: task.dueDate, overdue: store.isOverdue(task)) { d in store.updateTask(task.id) { $0.dueDate = d } }
                PriorityMenu(task: task)
                Spacer()
                if !subs.isEmpty { Label("\(subs.count)", systemImage: "arrow.turn.down.right").font(.caption2).foregroundStyle(.secondary) }
                if total > 0 { Label("\(done)/\(total)", systemImage: "checklist").font(.caption2).foregroundStyle(.secondary) }
                if !store.blockers(of: task).isEmpty { Image(systemName: "hand.raised.fill").foregroundStyle(.red).font(.caption2) }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .mkCard(radius: 8)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(store.openTaskId == task.id ? Color.accentColor : Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
        .contentShape(Rectangle())
        .onTapGesture { store.openTaskId = task.id }
        .draggable(task.id.uuidString) {
            Text(task.title).padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        }
        .contextMenu { TaskContextMenu(task: task) }
    }
}
