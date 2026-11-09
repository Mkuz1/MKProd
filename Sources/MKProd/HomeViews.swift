import SwiftUI

struct HomeView: View {
    @Environment(Store.self) private var store
    @State private var newReminder = ""
    @State private var notepad = UserDefaults.standard.string(forKey: "notepad") ?? ""

    private var mine: [TaskItem] {
        store.data.tasks.filter { !$0.archived && $0.assigneeIds.contains(store.data.currentUserId) && !store.isClosed($0) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(greeting + ", " + (store.me.name.split(separator: " ").first.map(String.init) ?? "")).font(.largeTitle.bold())
                    Text(Date().formatted(date: .complete, time: .omitted)).foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    stat("Overdue", mine.filter(store.isOverdue).count, .red, "exclamationmark.circle")
                    stat("Due today", mine.filter { $0.dueDate.map { Calendar.current.isDateInToday($0) } ?? false }.count, .orange, "sun.max")
                    stat("Assigned to me", mine.count, .blue, "person")
                    stat("Completed this week", store.data.tasks.filter { ($0.completedAt ?? .distantPast) > Date().adding(days: -7) }.count, .green, "checkmark.seal")
                }
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 16) {
                    card("My Work", icon: "checklist") { myWork }
                    card("Reminders", icon: "bell") { remindersCard }
                    card("Recents", icon: "clock.arrow.circlepath") { recents }
                    card("Notepad", icon: "note.text") {
                        TextEditor(text: $notepad)
                            .frame(minHeight: 180)
                            .scrollContentBackground(.hidden)
                            .onChange(of: notepad) { _, v in UserDefaults.standard.set(v, forKey: "notepad") }
                    }
                    card("Agenda (next 7 days)", icon: "calendar") { agenda }
                    card("Goals", icon: "target") { goals }
                    card("Assigned comments", icon: "text.bubble") { assignedComments }
                }
            }
            .padding(24)
        }
        .navigationTitle("Home")
    }

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 12 ? "Good morning" : (h < 18 ? "Good afternoon" : "Good evening")
    }

    private func stat(_ title: String, _ n: Int, _ c: Color, _ icon: String) -> some View {
        HStack {
            Image(systemName: icon).font(.title2).foregroundStyle(c)
            VStack(alignment: .leading) {
                Text("\(n)").font(.title.bold())
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(c.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func card<C: View>(_ title: String, icon: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: icon).font(.headline)
            content()
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 240, alignment: .topLeading)
        .mkCard(radius: 12)
    }

    private var myWork: some View {
        let today = Date().startOfDay
        let buckets: [(String, [TaskItem])] = [
            ("Overdue", mine.filter(store.isOverdue)),
            ("Today", mine.filter { $0.dueDate.map { Calendar.current.isDateInToday($0) } ?? false }),
            ("Next", mine.filter { ($0.dueDate ?? .distantPast) >= today.adding(days: 1) }.sorted { $0.dueDate! < $1.dueDate! }),
            ("Unscheduled", mine.filter { $0.dueDate == nil }),
        ]
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(buckets, id: \.0) { b in
                if !b.1.isEmpty {
                    Text(b.0.uppercased()).font(.caption2.bold()).foregroundStyle(b.0 == "Overdue" ? .red : .secondary).padding(.top, 4)
                    ForEach(b.1.prefix(5)) { t in miniRow(t) }
                }
            }
            if mine.isEmpty { Text("Nothing assigned to you 🎉").foregroundStyle(.secondary) }
        }
    }

    private func miniRow(_ t: TaskItem) -> some View {
        HStack {
            StatusPill(status: store.status(of: t), compact: true)
            Text(t.title).lineLimit(1)
            Spacer()
            PriorityFlag(priority: t.priority)
            DueLabel(date: t.dueDate, overdue: store.isOverdue(t)).font(.caption)
        }
        .font(.callout)
        .contentShape(Rectangle())
        .onTapGesture { store.openTaskId = t.id }
    }

    private var remindersCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(store.data.reminders.filter { !$0.done }.sorted { $0.date < $1.date }) { r in
                HStack {
                    Button {
                        if let i = store.data.reminders.firstIndex(where: { $0.id == r.id }) { store.data.reminders[i].done = true }
                    } label: { Image(systemName: "circle") }.buttonStyle(.plain)
                    Text(r.title).lineLimit(1)
                        .onTapGesture { if let t = r.taskId { store.openTaskId = t } }
                    Spacer()
                    Text(r.date.formatted(.dateTime.month().day().hour().minute())).font(.caption)
                        .foregroundStyle(r.date < Date() ? .red : .secondary)
                }
                .font(.callout)
            }
            HStack {
                TextField("New reminder (tomorrow 9 AM)", text: $newReminder).textFieldStyle(.roundedBorder)
                    .onSubmit(addReminder)
                Button("Add", action: addReminder)
            }
        }
    }

    private func addReminder() {
        let t = newReminder.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        store.data.reminders.append(Reminder(title: t, date: Date().startOfDay.adding(days: 1).addingTimeInterval(9 * 3600)))
        newReminder = ""
    }

    private var recents: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(store.data.tasks.filter { !$0.archived }.sorted { $0.updated > $1.updated }.prefix(10)) { t in miniRow(t) }
        }
    }

    private var agenda: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(0..<7, id: \.self) { i in
                let day = Date().startOfDay.adding(days: i)
                let ts = store.data.tasks.filter { !$0.archived && !store.isClosed($0) && ($0.dueDate.map { Calendar.current.isDate($0, inSameDayAs: day) } ?? false) }
                if !ts.isEmpty {
                    Text(day.shortLabel + " · " + day.formatted(.dateTime.weekday(.wide))).font(.caption.bold()).foregroundStyle(.secondary)
                    ForEach(ts) { miniRow($0) }
                }
            }
        }
    }

    private var assignedComments: some View {
        let me = store.data.currentUserId
        let items = store.data.tasks.filter { !$0.archived }.flatMap { t in t.comments.filter { $0.assigneeId == me && !$0.resolved }.map { (t, $0) } }
        return VStack(alignment: .leading, spacing: 8) {
            if items.isEmpty { Text("No open assigned comments.").foregroundStyle(.secondary) }
            ForEach(items, id: \.1.id) { t, c in
                HStack(alignment: .top) {
                    Button {
                        store.updateTask(t.id) { x in if let i = x.comments.firstIndex(where: { $0.id == c.id }) { x.comments[i].resolved = true } }
                    } label: { Image(systemName: "circle") }.buttonStyle(.plain).help("Resolve")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.text).lineLimit(2)
                        Text("\(store.member(c.authorId)?.name ?? "") · \(t.title)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .font(.callout)
                .contentShape(Rectangle())
                .onTapGesture { store.openTaskId = t.id }
            }
        }
    }

    private var goals: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(store.data.goals) { g in
                HStack {
                    ProgressRing(value: store.progress(g), color: Color(hex: g.colorHex))
                    VStack(alignment: .leading) {
                        Text(g.name).font(.callout.bold())
                        if let d = g.dueDate { Text("Due \(d.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .onTapGesture { store.selection = .goals }
            }
        }
    }
}

// MARK: - Inbox

struct InboxView: View {
    @Environment(Store.self) private var store
    @State private var tab = 0

    var body: some View {
        let items = store.data.inbox.filter { tab == 0 ? !$0.cleared : $0.cleared }
        VStack(spacing: 0) {
            HStack {
                Picker("", selection: $tab) { Text("Inbox").tag(0); Text("Cleared").tag(1) }
                    .pickerStyle(.segmented).frame(width: 200)
                Spacer()
                Button("Mark all read") { for i in store.data.inbox.indices { store.data.inbox[i].read = true } }
                Button("Clear all") { for i in store.data.inbox.indices { store.data.inbox[i].cleared = true; store.data.inbox[i].read = true } }
            }
            .padding(12)
            Divider()
            if items.isEmpty {
                EmptyState(icon: "tray", title: tab == 0 ? "Inbox zero!" : "Nothing cleared yet", subtitle: "Assignments, mentions and reminders land here.")
            } else {
                List(items) { n in
                    HStack(alignment: .top) {
                        Circle().fill(n.read ? .clear : Color.accentColor).frame(width: 8, height: 8).padding(.top, 5)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(n.text).fontWeight(n.read ? .regular : .semibold)
                            if let t = store.task(n.taskId) {
                                Text(store.locationName(t)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Text(n.date.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                        Button { update(n.id) { $0.cleared.toggle(); $0.read = true } } label: {
                            Image(systemName: n.cleared ? "arrow.uturn.backward" : "checkmark")
                        }
                        .buttonStyle(.borderless).help(n.cleared ? "Restore" : "Clear")
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        update(n.id) { $0.read = true }
                        if let t = n.taskId, store.task(t) != nil { store.openTaskId = t }
                    }
                }
            }
        }
        .navigationTitle("Inbox")
    }

    private func update(_ id: UUID, _ f: (inout InboxItem) -> Void) {
        if let i = store.data.inbox.firstIndex(where: { $0.id == id }) { f(&store.data.inbox[i]) }
    }
}

// MARK: - Command palette

struct CommandPalette: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var highlighted = 0

    private struct Hit: Identifiable {
        let id: String
        let icon: String
        let title: String
        let subtitle: String
        let action: () -> Void
    }

    private var hits: [Hit] {
        let q = query.trimmingCharacters(in: .whitespaces)
        var out: [Hit] = []
        let nav: [(String, String, SidebarItem)] = [
            ("Home", "house", .home), ("Inbox", "tray", .inbox), ("My Tasks", "person", .myTasks), ("Everything", "square.stack.3d.up", .everything),
            ("Whiteboards", "scribble.variable", .whiteboards), ("Goals", "target", .goals), ("Dashboards", "chart.bar", .dashboards),
            ("Timesheets", "clock", .timesheet), ("Automations", "bolt", .automations), ("Templates", "square.on.square.dashed", .templates),
            ("Portfolio", "square.stack.3d.up", .portfolio), ("Resources", "person.badge.clock", .resources), ("Content Directory", "books.vertical", .directory),
        ]
        for n in nav where q.isEmpty || n.0.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: "nav\(n.0)", icon: n.1, title: n.0, subtitle: "Go to") { store.selection = n.2 })
        }
        guard !q.isEmpty else { return out }
        if let t = store.task(byKey: q) {
            out.insert(Hit(id: "key" + t.id.uuidString, icon: "number", title: "\(q.uppercased()) · \(t.title)", subtitle: "Task ID") {
                store.selection = .list(t.listId)
                store.openTaskId = t.id
            }, at: 0)
        }
        for l in store.data.lists where l.name.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: l.id.uuidString, icon: "list.bullet", title: l.name, subtitle: "List · \(store.space(l.spaceId)?.name ?? "")") { store.selection = .list(l.id) })
        }
        for s in store.data.spaces where s.name.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: s.id.uuidString, icon: s.icon, title: s.name, subtitle: "Space") { store.selection = .space(s.id) })
        }
        for t in store.data.tasks where !t.archived && (t.title.localizedCaseInsensitiveContains(q) || t.details.localizedCaseInsensitiveContains(q) || t.tags.contains(where: { $0.localizedCaseInsensitiveContains(q) })) {
            out.append(Hit(id: t.id.uuidString, icon: "checkmark.circle", title: t.title, subtitle: [store.taskKey(t), store.locationName(t)].compactMap { $0 }.joined(separator: " · ")) {
                store.selection = .list(t.listId)
                store.openTaskId = t.id
            })
        }
        for w in store.data.whiteboards where w.name.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: w.id.uuidString, icon: "scribble.variable", title: w.name, subtitle: "Whiteboard") { store.selection = .whiteboard(w.id) })
        }
        for g in store.data.goals where g.name.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: g.id.uuidString, icon: "target", title: g.name, subtitle: "Goal") { store.selection = .goals })
        }
        for m in store.data.messages where m.text.localizedCaseInsensitiveContains(q) {
            out.append(Hit(id: m.id.uuidString, icon: "bubble.left", title: m.text, subtitle: "Chat") { store.selection = .chat(m.channelId) })
        }
        if let l = store.data.lists.first {
            out.append(Hit(id: "create", icon: "plus.circle", title: "Create task \"\(q)\"", subtitle: "in \(l.name)") {
                let t = store.addTask(q, list: l.id)
                store.selection = .list(l.id)
                store.openTaskId = t.id
            })
        }
        return out
    }

    var body: some View {
        let results = Array(hits.prefix(40))
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search or jump to…", text: $query)
                    .textFieldStyle(.plain).font(.title3)
                    .onSubmit { run(results) }
                    .onChange(of: query) { highlighted = 0 }
                    .onKeyPress(.downArrow) { highlighted = min(highlighted + 1, max(results.count - 1, 0)); return .handled }
                    .onKeyPress(.upArrow) { highlighted = max(highlighted - 1, 0); return .handled }
            }
            .padding(14)
            Divider()
            ScrollViewReader { proxy in
                List(Array(results.enumerated()), id: \.element.id) { i, h in
                    HStack {
                        Image(systemName: h.icon).frame(width: 20)
                        VStack(alignment: .leading) {
                            Text(h.title).lineLimit(1)
                            Text(h.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if i == highlighted { Text("↩").foregroundStyle(.secondary) }
                    }
                    .padding(.vertical, 2)
                    .listRowBackground(i == highlighted ? Color.accentColor.opacity(0.2) : Color.clear)
                    .contentShape(Rectangle())
                    .onTapGesture { h.action(); dismiss() }
                    .id(i)
                }
                .onChange(of: highlighted) { _, v in proxy.scrollTo(v) }
            }
        }
        .frame(width: 600, height: 440)
    }

    private func run(_ results: [Hit]) {
        guard results.indices.contains(highlighted) else { return }
        results[highlighted].action()
        dismiss()
    }
}

// MARK: - Templates

struct TemplatesView: View {
    @Environment(Store.self) private var store
    @State private var targetList: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Task templates").font(.title2.bold())
                Spacer()
                Picker("Create in", selection: $targetList) {
                    ForEach(store.data.lists.filter { !$0.archived }) { Text($0.name).tag(Optional($0.id)) }
                }
                .frame(width: 260)
            }
            .padding(16)
            Divider()
            if store.data.templates.isEmpty {
                EmptyState(icon: "square.on.square.dashed", title: "No templates yet", subtitle: "Right-click any task → Save as Template.")
            } else {
                List {
                    ForEach(store.data.templates) { tpl in
                        HStack {
                            Image(systemName: "square.on.square.dashed")
                            VStack(alignment: .leading) {
                                Text(tpl.name).font(.headline)
                                Text("\(tpl.subtasks.count) subtasks · \(tpl.task.checklists.flatMap(\.items).count) checklist items · \(tpl.task.tags.joined(separator: ", "))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Use template") {
                                if let l = targetList ?? store.data.lists.first?.id {
                                    store.instantiate(tpl, list: l)
                                    store.selection = .list(l)
                                }
                            }
                            Button(role: .destructive) { store.data.templates.removeAll { $0.id == tpl.id } } label: { Image(systemName: "trash") }
                                .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .navigationTitle("Templates")
        .onAppear { targetList = targetList ?? store.data.lists.first?.id }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @Environment(Store.self) private var store

    var body: some View {
        TabView {
            general.tabItem { Label("General", systemImage: "gearshape") }
            CloudSettingsView().tabItem { Label("Cloud & Team", systemImage: "icloud") }
            members.tabItem { Label("People", systemImage: "person.3") }
            NotificationSettingsView().tabItem { Label("Notifications", systemImage: "bell.badge") }
            spaces.tabItem { Label("Spaces", systemImage: "square.grid.2x2") }
        }
        .padding()
    }

    private var general: some View {
        @Bindable var store = store
        return Form {
            TextField("Workspace name", text: $store.data.workspaceName)
            Picker("I am", selection: $store.data.currentUserId) {
                ForEach(store.data.members) { Text($0.name).tag($0.id) }
            }
            LabeledContent("Data file") {
                Button(store.currentFileURL.path) { NSWorkspace.shared.activateFileViewerSelecting([store.currentFileURL]) }.buttonStyle(.link)
            }
            LabeledContent("Archived lists") {
                Menu("\(store.data.lists.filter(\.archived).count) archived") {
                    ForEach(store.data.lists.filter(\.archived)) { l in
                        Button("Restore \(l.name)") { if let i = store.data.lists.firstIndex(where: { $0.id == l.id }) { store.data.lists[i].archived = false } }
                    }
                }.fixedSize()
            }
            LabeledContent("Archived tasks") {
                Button("Restore all (\(store.data.tasks.filter(\.archived).count))") {
                    for i in store.data.tasks.indices { store.data.tasks[i].archived = false }
                }
            }
            Button("Reset to sample workspace", role: .destructive) { store.resetToSample() }
        }
        .formStyle(.grouped)
    }

    private var members: some View {
        @Bindable var store = store
        return VStack(alignment: .leading) {
            if store.cloud.isConnected {
                Text("People come from your shared workspace. Manage them under Cloud & Team.").font(.callout).foregroundStyle(.secondary)
            }
            Text("Assign people to entities to give them a role in that entity's approvals and send them its contract reminders.")
                .font(.callout).foregroundStyle(.secondary)
            // Rows bind by id (not by array position) so removing someone can't leave a row reading a stale index.
            List {
                ForEach(store.data.members) { m in
                    HStack {
                        AvatarView(member: m, size: 28)
                        if store.cloud.isConnected {
                            Text(m.name)
                            Text(m.email).foregroundStyle(.secondary)
                            Spacer()
                            EntityAssignmentMenu(memberId: m.id)
                        } else {
                            TextField("Name", text: memberField(m.id, \.name))
                            TextField("Email", text: memberField(m.id, \.email))
                            ColorDots(hex: memberField(m.id, \.colorHex)).scaleEffect(0.8)
                            EntityAssignmentMenu(memberId: m.id)
                            if m.id != store.data.currentUserId {
                                Button(role: .destructive) {
                                    let id = m.id
                                    // Mutate after this click finishes rendering.
                                    DispatchQueue.main.async { store.data.members.removeAll { $0.id == id } }
                                } label: { Image(systemName: "trash") }
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
            if !store.cloud.isConnected {
                Button("Add person") { store.data.members.append(Member(name: "New Person", colorHex: paletteHexes.randomElement()!)) }
            }
        }
    }

    private func memberField(_ id: UUID, _ kp: WritableKeyPath<Member, String>) -> Binding<String> {
        Binding(
            get: { store.data.members.first { $0.id == id }?[keyPath: kp] ?? "" },
            set: { v in if let i = store.data.members.firstIndex(where: { $0.id == id }) { store.data.members[i][keyPath: kp] = v } }
        )
    }

    private var spaces: some View {
        NavigationStack {
            List(store.data.spaces) { s in
                NavigationLink(s.name) { SpaceSettingsView(spaceId: s.id, embedded: true) }
            }
        }
    }
}

struct SpaceSettingsView: View {
    let spaceId: UUID
    var embedded = false
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var newOption = ""

    private var index: Int? { store.data.spaces.firstIndex { $0.id == spaceId } }

    var body: some View {
        @Bindable var store = store
        if let i = index {
            VStack(alignment: .leading, spacing: 0) {
                Form {
                    Section("Space") {
                        TextField("Name", text: $store.data.spaces[i].name)
                        LabeledContent("Color") { ColorDots(hex: $store.data.spaces[i].colorHex) }
                        Picker("Icon", selection: $store.data.spaces[i].icon) {
                            ForEach(["square.grid.2x2", "hammer", "megaphone", "gearshape.2", "briefcase", "paintbrush", "chart.line.uptrend.xyaxis", "person.3", "house", "graduationcap", "heart", "cart"], id: \.self) {
                                Label($0, systemImage: $0).tag($0)
                            }
                        }
                        Toggle("Private", isOn: $store.data.spaces[i].isPrivate)
                    }
                    Section("Statuses") {
                        ForEach($store.data.spaces[i].statuses) { $s in
                            HStack {
                                Circle().fill(Color(hex: s.colorHex)).frame(width: 12)
                                TextField("Status", text: $s.name)
                                Picker("", selection: $s.kind) { ForEach(StatusKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }
                                    .labelsHidden().frame(width: 100)
                                TextField("WIP", value: Binding(get: { s.wipLimit }, set: { s.wipLimit = ($0 ?? 0) > 0 ? $0 : nil }), format: .number)
                                    .frame(width: 50).help("Work-in-progress limit: Board and List flag the status when it holds more open tasks")
                                Menu("Color") { ForEach(paletteHexes, id: \.self) { h in Button(h) { s.colorHex = h } } }.fixedSize()
                                Button { let id = s.id; DispatchQueue.main.async { store.data.spaces[i].statuses.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }
                                    .buttonStyle(.borderless).disabled(store.data.spaces[i].statuses.count <= 1)
                            }
                        }
                        .onMove { store.data.spaces[i].statuses.move(fromOffsets: $0, toOffset: $1) }
                        Button("Add status") {
                            let doneIdx = store.data.spaces[i].statuses.firstIndex { $0.kind == .done } ?? store.data.spaces[i].statuses.count
                            store.data.spaces[i].statuses.insert(StatusDef(name: "New Status", colorHex: paletteHexes.randomElement()!, kind: .active), at: doneIdx)
                        }
                    }
                    Section("Custom Fields") {
                        ForEach($store.data.spaces[i].fields) { $f in
                            VStack(alignment: .leading) {
                                HStack {
                                    TextField("Field name", text: $f.name)
                                    Picker("", selection: $f.type) { ForEach(FieldType.allCases) { Text($0.label).tag($0) } }
                                        .labelsHidden().frame(width: 170)
                                    if !f.type.isComputed {
                                        Toggle("Required", isOn: Binding(get: { f.required ?? false }, set: { f.required = $0 ? true : nil })).toggleStyle(.checkbox)
                                            .help("Closing a task with this field empty asks first")
                                    }
                                    Toggle("Pinned", isOn: Binding(get: { f.pinned ?? false }, set: { f.pinned = $0 ? true : nil })).toggleStyle(.checkbox)
                                        .help("Show on list rows and board cards")
                                    Button { let id = f.id; DispatchQueue.main.async { store.data.spaces[i].fields.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }
                                        .buttonStyle(.borderless)
                                }
                                if f.type == .formula {
                                    TextField("{Budget} - {Spent}", text: Binding(get: { f.options.first ?? "" }, set: { f.options = [$0] }))
                                        .font(.system(.body, design: .monospaced))
                                    Text("Use fields in braces and IF, ROUND, MIN, MAX, SUM, AVG, ABS, TODAY. Built-ins: {Estimate hours} {Points} {Progress} {Tracked hours} {Priority} {Subtasks} {Days left} {Start} {Due}; & joins text.")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                if f.type == .dropdown {
                                    HStack {
                                        ForEach(f.options, id: \.self) { o in
                                            Text(o).font(.caption).padding(4).background(Color.secondary.opacity(0.15), in: Capsule())
                                                .onTapGesture { f.options.removeAll { $0 == o } }
                                        }
                                        TextField("Add option", text: $newOption).frame(width: 120)
                                            .onSubmit { if !newOption.isEmpty { f.options.append(newOption); newOption = "" } }
                                    }
                                }
                            }
                        }
                        Button("Add custom field") { store.data.spaces[i].fields.append(FieldDef(name: "New Field", type: .text)) }
                    }
                    SpaceWorkSettings(index: i)
                }
                .formStyle(.grouped)
                if !embedded {
                    HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }.padding()
                }
            }
            .frame(minWidth: 520, minHeight: 520)
        }
    }
}
