import SwiftUI
import AppKit

struct TaskDetailView: View {
    let taskId: UUID
    @Environment(Store.self) private var store
    @State private var editingDescription = false
    @State private var newSubtask = ""
    @State private var newComment = ""
    @State private var newTag = ""
    @State private var feedTab = 0
    @State private var reminderDate = Date().addingTimeInterval(3600)
    @State private var manualMinutes = 30

    private var task: TaskItem { store.task(taskId) ?? TaskItem(listId: UUID(), title: "", statusId: UUID()) }

    private func binding<T>(_ kp: WritableKeyPath<TaskItem, T>) -> Binding<T> {
        Binding(get: { task[keyPath: kp] }, set: { v in store.updateTask(taskId) { $0[keyPath: kp] = v } })
    }

    var body: some View {
        // The header (with Close) sits outside the scroll view so nothing inside can cover it.
        VStack(spacing: 0) {
            topBar
                .padding(.horizontal, 18).padding(.vertical, 10)
            Divider()
            ScrollView {
                content.padding(18)
            }
        }
        .mkSurface()
    }

    private var content: some View {
            VStack(alignment: .leading, spacing: 18) {
                if let p = store.task(task.parentId) {
                    Button { store.openTaskId = p.id } label: { Label(p.title, systemImage: "arrow.turn.left.up").font(.caption) }
                        .buttonStyle(.link)
                }
                TextField("Task name", text: binding(\.title), axis: .vertical)
                    .font(.title2.bold())
                    .textFieldStyle(.plain)
                if !store.blockers(of: task).isEmpty {
                    Label("Blocked by \(store.blockers(of: task).map(\.title).joined(separator: ", "))", systemImage: "hand.raised.fill")
                        .foregroundStyle(.red).font(.callout)
                }
                properties
                customFields
                description
                subtasks
                checklists
                relationships
                attachments
                timeTracking
                section("Time in Status") { TimeInStatusView(task: task) }
                reminders
                feed
            }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack {
            TypeBadge(task: task, withName: true)
            TaskKeyChip(task: task)
            Text(store.locationName(task)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            ViewersBadge(taskId: taskId)
            Button { store.toggleFavorite(taskId) } label: {
                Image(systemName: store.data.favorites.contains(taskId) ? "star.fill" : "star")
            }.buttonStyle(.plain)
            Menu {
                TaskContextMenu(task: task)
            } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).fixedSize()
            Button { store.openTaskId = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
        }
    }

    // MARK: Properties

    private var properties: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
            GridRow {
                propLabel("Status", "circle.dashed")
                HStack {
                    StatusMenu(task: task)
                    Button {
                        let st = store.statuses(for: task)
                        if let i = st.firstIndex(where: { $0.id == task.statusId }), i + 1 < st.count {
                            store.updateTask(taskId) { $0.statusId = st[i + 1].id }
                        }
                    } label: { Image(systemName: "chevron.right.2") }
                    .buttonStyle(.plain).help("Next status")
                }
            }
            if let types = store.space(ofTask: task)?.taskTypes, !types.isEmpty {
                GridRow {
                    propLabel("Type", "square.stack.3d.down.right")
                    Picker("", selection: binding(\.typeId)) {
                        Text("✓ Task").tag(UUID?.none)
                        ForEach(types) { Text("\($0.icon) \($0.name)").tag(Optional($0.id)) }
                    }
                    .labelsHidden().fixedSize()
                }
            }
            GridRow { propLabel("Lists", "list.bullet.indent"); TaskListsPicker(task: task) }
            GridRow { propLabel("Assignees", "person.2"); AssigneeMenu(task: task) }
            GridRow { propLabel("Priority", "flag"); PriorityMenu(task: task, showLabel: true) }
            GridRow {
                propLabel("Dates", "calendar")
                HStack {
                    DatePopoverButton(date: task.startDate) { d in store.updateTask(taskId) { $0.startDate = d } }
                    Image(systemName: "arrow.right").font(.caption).foregroundStyle(.tertiary)
                    DatePopoverButton(date: task.dueDate, overdue: store.isOverdue(task)) { d in store.updateTask(taskId) { $0.dueDate = d } }
                }
            }
            GridRow {
                propLabel("Estimate", "hourglass")
                HStack {
                    TextField("min", value: binding(\.estimateMinutes), format: .number).frame(width: 60)
                    Text("minutes").foregroundStyle(.secondary)
                }
            }
            GridRow {
                propLabel("Sprint points", "number")
                TextField("–", value: binding(\.points), format: .number).frame(width: 60)
            }
            GridRow {
                propLabel("Repeat", "repeat")
                Picker("", selection: binding(\.recurrence)) { ForEach(Recurrence.allCases) { Text($0.label).tag($0) } }
                    .labelsHidden().fixedSize()
            }
            GridRow {
                propLabel("Milestone", "diamond")
                Toggle("", isOn: binding(\.isMilestone)).labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
            GridRow {
                propLabel("Tags", "tag")
                VStack(alignment: .leading) {
                    HStack(spacing: 4) {
                        ForEach(task.tags, id: \.self) { tag in
                            HStack(spacing: 2) {
                                TagChip(tag: tag)
                                Button { store.updateTask(taskId) { $0.tags.removeAll { $0 == tag } } } label: { Image(systemName: "xmark").font(.system(size: 8)) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                    TextField("Add tag", text: $newTag).textFieldStyle(.roundedBorder).frame(width: 140)
                        .onSubmit {
                            let t = newTag.trimmingCharacters(in: .whitespaces).lowercased()
                            if !t.isEmpty && !task.tags.contains(t) { store.updateTask(taskId) { $0.tags.append(t) } }
                            newTag = ""
                        }
                }
            }
            GridRow {
                propLabel("Watchers", "eye")
                Menu {
                    ForEach(store.data.members) { m in
                        Button {
                            store.updateTask(taskId) {
                                if let i = $0.watcherIds.firstIndex(of: m.id) { $0.watcherIds.remove(at: i) } else { $0.watcherIds.append(m.id) }
                            }
                        } label: { Label(m.name, systemImage: task.watcherIds.contains(m.id) ? "checkmark" : "person") }
                    }
                } label: { AvatarStack(ids: task.watcherIds, size: 18) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
        }
        .font(.callout)
    }

    private func propLabel(_ t: String, _ icon: String) -> some View {
        Label(t, systemImage: icon).foregroundStyle(.secondary).frame(width: 120, alignment: .leading)
    }

    @ViewBuilder
    private var customFields: some View {
        let fields = store.space(ofTask: task)?.fields ?? []
        if !fields.isEmpty {
            section("Custom Fields") {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                    ForEach(fields) { f in
                        GridRow {
                            Text(f.name + ((f.required ?? false) ? " *" : "")).foregroundStyle(.secondary).frame(width: 120, alignment: .leading)
                                .help((f.required ?? false) ? "Required before closing" : "")
                            CustomFieldEditor(taskId: taskId, field: f)
                        }
                    }
                }
                .font(.callout)
            }
        }
    }

    // MARK: Description

    private var description: some View {
        section("Description", trailing: AnyView(
            Button(editingDescription ? "Done" : "Edit") { editingDescription.toggle() }.buttonStyle(.link)
        )) {
            if editingDescription || task.details.isEmpty {
                // Fixed, clipped height: a native text view with only a minimum height inside a
                // ScrollView can grow its click area over the controls above it.
                TextEditor(text: binding(\.details))
                    .font(.body.monospaced())
                    .scrollContentBackground(.hidden)
                    .frame(height: 160)
                    .clipped()
                    .padding(6)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
                Text("Supports Markdown: # headings, **bold**, *italic*, - lists, - [ ] checkboxes, > quotes, `code`, [links](url)")
                    .font(.caption2).foregroundStyle(.tertiary)
            } else {
                MarkdownText(text: task.details).onTapGesture(count: 2) { editingDescription = true }
            }
        }
    }

    // MARK: Subtasks

    private var subtasks: some View {
        let subs = store.subtasks(of: taskId)
        let done = subs.filter(store.isClosed).count
        return section("Subtasks", trailing: AnyView(Text(subs.isEmpty ? "" : "\(done)/\(subs.count)").foregroundStyle(.secondary))) {
            if !subs.isEmpty { ProgressView(value: Double(done), total: Double(subs.count)) }
            ForEach(subs) { s in
                HStack {
                    Button {
                        let st = store.statuses(for: s)
                        let target = store.isClosed(s) ? st.first : st.first { $0.kind == .done }
                        if let target { store.updateTask(s.id) { $0.statusId = target.id } }
                    } label: { Image(systemName: store.isClosed(s) ? "checkmark.circle.fill" : "circle") }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color(hex: store.status(of: s)?.colorHex ?? "#888"))
                    Text(s.title).strikethrough(store.isClosed(s))
                        .onTapGesture { store.openTaskId = s.id }
                    Spacer()
                    AssigneeMenu(task: s)
                    DatePopoverButton(date: s.dueDate) { d in store.updateTask(s.id) { $0.dueDate = d } }
                    PriorityMenu(task: s)
                }
            }
            HStack {
                Image(systemName: "plus").foregroundStyle(.secondary)
                TextField("Add subtask", text: $newSubtask).textFieldStyle(.plain)
                    .onSubmit {
                        let t = newSubtask.trimmingCharacters(in: .whitespaces)
                        if !t.isEmpty { store.addTask(t, list: task.listId, parent: taskId) }
                        newSubtask = ""
                    }
            }
        }
    }

    // MARK: Checklists

    private var checklists: some View {
        section("Checklists", trailing: AnyView(Button {
            store.updateTask(taskId) { $0.checklists.append(Checklist(name: "Checklist")) }
        } label: { Image(systemName: "plus") }.buttonStyle(.plain))) {
            ForEach(Array(task.checklists.enumerated()), id: \.element.id) { ci, cl in
                ChecklistEditor(taskId: taskId, index: ci, checklist: cl)
            }
        }
    }

    // MARK: Relationships

    private var relationships: some View {
        section("Dependencies & Links") {
            relationRow("Waiting on", ids: task.blockedBy, kp: \.blockedBy)
            let blocking = store.data.tasks.filter { $0.blockedBy.contains(taskId) }
            if !blocking.isEmpty {
                HStack(alignment: .top) {
                    Text("Blocking").foregroundStyle(.secondary).frame(width: 90, alignment: .leading)
                    VStack(alignment: .leading) {
                        ForEach(blocking) { b in Button(b.title) { store.openTaskId = b.id }.buttonStyle(.link) }
                    }
                }
            }
            relationRow("Linked", ids: task.linkedTaskIds, kp: \.linkedTaskIds)
        }
        .font(.callout)
    }

    private func relationRow(_ label: String, ids: [UUID], kp: WritableKeyPath<TaskItem, [UUID]>) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary).frame(width: 90, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(ids, id: \.self) { id in
                    if let t = store.task(id) {
                        HStack {
                            StatusPill(status: store.status(of: t), compact: true)
                            Button(t.title) { store.openTaskId = id }.buttonStyle(.link)
                            Button { store.updateTask(taskId) { $0[keyPath: kp].removeAll { $0 == id } } } label: { Image(systemName: "xmark.circle") }
                                .buttonStyle(.plain).foregroundStyle(.tertiary)
                        }
                    }
                }
                Menu("Add…") {
                    ForEach(store.data.tasks.filter { $0.id != taskId && !ids.contains($0.id) && !$0.archived }.prefix(60)) { t in
                        Button(t.title) { store.updateTask(taskId) { $0[keyPath: kp].append(t.id) } }
                    }
                }
                .menuStyle(.borderlessButton).fixedSize()
            }
        }
    }

    // MARK: Attachments

    private var attachments: some View {
        section("Attachments", trailing: AnyView(Button {
            let p = NSOpenPanel()
            p.allowsMultipleSelection = true
            if p.runModal() == .OK {
                let added = p.urls.map { Attachment(name: $0.lastPathComponent, path: $0.path) }
                store.updateTask(taskId) { $0.attachments += added }
            }
        } label: { Image(systemName: "paperclip") }.buttonStyle(.plain))) {
            if task.attachments.isEmpty {
                Text("Drop files here or click the paperclip.").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(task.attachments) { a in
                HStack {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: a.path)).resizable().frame(width: 20, height: 20)
                    Button(a.name) { NSWorkspace.shared.open(URL(fileURLWithPath: a.path)) }.buttonStyle(.link)
                    Spacer()
                    Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: a.path)]) } label: { Image(systemName: "folder") }.buttonStyle(.plain)
                    Button { store.updateTask(taskId) { $0.attachments.removeAll { $0.id == a.id } } } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                }
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            let added = urls.filter(\.isFileURL).map { Attachment(name: $0.lastPathComponent, path: $0.path) }
            store.updateTask(taskId) { $0.attachments += added }
            return !added.isEmpty
        }
    }

    // MARK: Time tracking

    private var timeTracking: some View {
        let entries = store.data.timeEntries.filter { $0.taskId == taskId }.sorted { $0.start > $1.start }
        let running = store.runningEntry?.taskId == taskId
        return section("Time Tracking", trailing: AnyView(
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text("\(store.tracked(taskId).hoursMinutes)\(task.estimateMinutes.map { " / \(TimeInterval($0 * 60).hoursMinutes)" } ?? "")")
                    .monospacedDigit().foregroundStyle(.secondary)
            }
        )) {
            HStack {
                Button { running ? store.stopTimer() : store.startTimer(task: taskId) } label: {
                    Label(running ? "Stop" : "Start timer", systemImage: running ? "stop.fill" : "play.fill")
                }
                .buttonStyle(.borderedProminent).tint(running ? .red : .accentColor)
                Spacer()
                Stepper("\(manualMinutes) min", value: $manualMinutes, in: 5...600, step: 5)
                Button("Add manually") {
                    let end = Date()
                    store.data.timeEntries.append(TimeEntry(taskId: taskId, memberId: store.data.currentUserId, start: end.addingTimeInterval(-Double(manualMinutes) * 60), end: end))
                }
            }
            if let est = task.estimateMinutes, est > 0 {
                ProgressView(value: min(store.tracked(taskId) / Double(est * 60), 1))
                    .tint(store.tracked(taskId) > Double(est * 60) ? .red : .accentColor)
            }
            ForEach(entries.prefix(8)) { e in
                HStack {
                    AvatarView(member: store.member(e.memberId), size: 16)
                    Text(e.start.formatted(date: .abbreviated, time: .shortened)).font(.caption)
                    if e.billable { Image(systemName: "dollarsign.circle.fill").foregroundStyle(.green).font(.caption) }
                    Spacer()
                    Text(e.end == nil ? "running" : e.duration.hoursMinutes).font(.caption.monospacedDigit())
                    Button { store.data.timeEntries.removeAll { $0.id == e.id } } label: { Image(systemName: "trash").font(.caption) }.buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: Reminders

    private var reminders: some View {
        let rs = store.data.reminders.filter { $0.taskId == taskId }
        return section("Reminders") {
            ForEach(rs) { r in
                HStack {
                    Image(systemName: r.done ? "bell.slash" : "bell").foregroundStyle(r.date < Date() ? .red : .secondary)
                    Text(r.date.formatted(date: .abbreviated, time: .shortened))
                    Spacer()
                    Button { store.data.reminders.removeAll { $0.id == r.id } } label: { Image(systemName: "trash") }.buttonStyle(.plain)
                }
                .font(.callout)
            }
            HStack {
                DatePicker("", selection: $reminderDate).labelsHidden()
                Button("Remind me") {
                    store.data.reminders.append(Reminder(title: task.title, date: reminderDate, taskId: taskId))
                }
            }
        }
    }

    // MARK: Comments & activity

    private var feed: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $feedTab) {
                Text("Comments (\(task.comments.count))").tag(0)
                Text("Activity").tag(1)
            }
            .pickerStyle(.segmented).labelsHidden()
            if feedTab == 0 {
                CommentThreadView(taskId: taskId)
                HStack(alignment: .bottom) {
                    TextField("Comment… use @name to mention", text: $newComment, axis: .vertical)
                        .lineLimit(1...6)
                        .textFieldStyle(.roundedBorder)
                    Button("Send") {
                        let t = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !t.isEmpty { store.addComment(t, to: taskId) }
                        newComment = ""
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                }
            } else {
                ForEach(task.activity.reversed()) { a in
                    HStack(alignment: .top) {
                        Circle().fill(Color.secondary.opacity(0.4)).frame(width: 6, height: 6).padding(.top, 6)
                        Text(a.text).font(.callout)
                        Spacer()
                        Text(a.date.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func setCommentAssignee(_ commentId: UUID, _ member: UUID?) {
        store.updateTask(taskId) { t in
            if let i = t.comments.firstIndex(where: { $0.id == commentId }) { t.comments[i].assigneeId = member; t.comments[i].resolved = false }
        }
        if let member, member != store.data.currentUserId {
            store.updateTask(taskId) { $0.activity.append(ActivityItem(text: "\(store.me.name) assigned a comment to \(store.member(member)?.name ?? "someone")")) }
        } else if member == store.data.currentUserId {
            store.notify("You have an assigned comment on \"\(task.title)\"", taskId: taskId)
        }
    }

    // MARK: Section chrome

    private func section<C: View>(_ title: String, trailing: AnyView? = nil, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                trailing
            }
            content()
        }
        .padding(.top, 4)
        .overlay(alignment: .top) { Divider().offset(y: -10) }
    }
}

struct ChecklistEditor: View {
    let taskId: UUID
    let index: Int
    let checklist: Checklist
    @Environment(Store.self) private var store
    @State private var newItem = ""

    var body: some View {
        let done = checklist.items.filter(\.done).count
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                TextField("Checklist", text: Binding(
                    get: { checklist.name },
                    set: { v in store.updateTask(taskId) { if $0.checklists.indices.contains(index) { $0.checklists[index].name = v } } }
                ))
                .textFieldStyle(.plain).font(.callout.bold())
                Text("\(done)/\(checklist.items.count)").font(.caption).foregroundStyle(.secondary)
                Button {
                    let id = checklist.id
                    DispatchQueue.main.async { store.updateTask(taskId) { $0.checklists.removeAll { $0.id == id } } }
                } label: { Image(systemName: "trash").font(.caption) }
                    .buttonStyle(.plain)
            }
            ForEach(Array(checklist.items.enumerated()), id: \.element.id) { ii, item in
                HStack {
                    Button {
                        store.updateTask(taskId) { $0.checklists[index].items[ii].done.toggle() }
                    } label: { Image(systemName: item.done ? "checkmark.square.fill" : "square") }
                        .buttonStyle(.plain).foregroundStyle(item.done ? .green : .secondary)
                    Text(item.text).strikethrough(item.done).foregroundStyle(item.done ? .secondary : .primary)
                    Spacer()
                    Menu {
                        Button("Unassigned") { store.updateTask(taskId) { $0.checklists[index].items[ii].assigneeId = nil } }
                        ForEach(store.data.members) { m in
                            Button(m.name) { store.updateTask(taskId) { $0.checklists[index].items[ii].assigneeId = m.id } }
                        }
                    } label: {
                        if let a = item.assigneeId { AvatarView(member: store.member(a), size: 16) } else { Image(systemName: "person.badge.plus").foregroundStyle(.tertiary) }
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    Button { let cid = checklist.id, iid = item.id; DispatchQueue.main.async { store.updateTask(taskId) { t in if let c = t.checklists.firstIndex(where: { $0.id == cid }) { t.checklists[c].items.removeAll { $0.id == iid } } } } } label: { Image(systemName: "xmark").font(.caption2) }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
                .font(.callout)
            }
            TextField("Add item", text: $newItem).textFieldStyle(.plain).font(.callout).padding(.leading, 22)
                .onSubmit {
                    let t = newItem.trimmingCharacters(in: .whitespaces)
                    if !t.isEmpty { store.updateTask(taskId) { $0.checklists[index].items.append(ChecklistItem(text: t)) } }
                    newItem = ""
                }
        }
        .padding(8)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct CustomFieldEditor: View {
    let taskId: UUID
    let field: FieldDef
    var compact = false
    @Environment(Store.self) private var store

    private var value: String { store.task(taskId)?.customValues[field.id] ?? "" }
    private func set(_ v: String) {
        store.updateTask(taskId) { t in if v.isEmpty { t.customValues[field.id] = nil } else { t.customValues[field.id] = v } }
    }
    private var text: Binding<String> { Binding(get: { value }, set: set) }

    var body: some View {
        switch field.type {
        case .text, .email:
            TextField(field.type == .email ? "name@example.com" : "–", text: text).textFieldStyle(.roundedBorder)
        case .number:
            TextField("0", text: text).textFieldStyle(.roundedBorder).frame(maxWidth: 100)
        case .money:
            HStack(spacing: 2) { Text("$").foregroundStyle(.secondary); TextField("0.00", text: text).textFieldStyle(.roundedBorder).frame(maxWidth: 100) }
        case .url:
            HStack {
                TextField("https://", text: text).textFieldStyle(.roundedBorder)
                if let u = URL(string: value), u.scheme?.hasPrefix("http") == true {
                    Button { NSWorkspace.shared.open(u) } label: { Image(systemName: "arrow.up.right.square") }.buttonStyle(.plain)
                }
            }
        case .checkbox:
            Toggle("", isOn: Binding(get: { value == "true" }, set: { set($0 ? "true" : "") })).labelsHidden()
        case .dropdown:
            Picker("", selection: text) {
                Text("–").tag("")
                ForEach(field.options, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden().fixedSize()
        case .date:
            DatePopoverButton(date: ISO8601DateFormatter().date(from: value)) { d in set(d.map { ISO8601DateFormatter().string(from: $0) } ?? "") }
        case .rating:
            HStack(spacing: 2) {
                ForEach(1...5, id: \.self) { i in
                    Image(systemName: i <= (Int(value) ?? 0) ? "star.fill" : "star")
                        .foregroundStyle(.yellow).font(compact ? .caption : .body)
                        .onTapGesture { set(Int(value) == i ? "" : String(i)) }
                }
            }
        case .phone:
            HStack {
                TextField("+971 …", text: text).textFieldStyle(.roundedBorder)
                if !compact, !value.isEmpty, let u = URL(string: "tel:" + value.filter { $0.isNumber || $0 == "+" }) {
                    Button { NSWorkspace.shared.open(u) } label: { Image(systemName: "phone") }.buttonStyle(.plain)
                }
            }
        case .location:
            HStack {
                TextField("Address or place", text: text).textFieldStyle(.roundedBorder)
                if !compact, !value.isEmpty, let q = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), let u = URL(string: "maps://?q=\(q)") {
                    Button { NSWorkspace.shared.open(u) } label: { Image(systemName: "map") }.buttonStyle(.plain).help("Open in Maps")
                }
            }
        case .people:
            let ids = value.split(separator: ",").compactMap { UUID(uuidString: String($0)) }
            Menu {
                ForEach(store.data.members) { m in
                    Button {
                        let next = ids.contains(m.id) ? ids.filter { $0 != m.id } : ids + [m.id]
                        set(next.map(\.uuidString).joined(separator: ","))
                    } label: { Label(m.name, systemImage: ids.contains(m.id) ? "checkmark" : "person") }
                }
            } label: { AvatarStack(ids: ids, size: compact ? 18 : 22) }
            .menuStyle(.borderlessButton).fixedSize()
        case .progress:
            let p = store.task(taskId).map { store.progress(of: $0) } ?? 0
            HStack(spacing: 6) {
                ProgressView(value: Double(p), total: 100).frame(width: compact ? 60 : 110)
                Text("\(p)%").font(.caption).monospacedDigit()
            }
        case .formula:
            let r = store.task(taskId).map { store.formulaValue($0, field).display } ?? ""
            Text(r.isEmpty ? "—" : r).monospacedDigit()
                .foregroundStyle(r.hasPrefix("#") ? Color.red : Color.secondary)
                .help(field.options.first.map { "= " + $0 } ?? "")
        }
    }
}
