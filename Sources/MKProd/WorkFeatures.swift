import SwiftUI
import AppKit

// Work-management rules shared by the task views: task IDs, task types, close warnings, rescheduling
// of dependent tasks and subtasks, time in status, multiple lists, comment reactions and saved views.
// Mirrors web/src/work.ts so the Mac app and the website behave the same.

extension Store {
    // MARK: Task IDs and types

    /// "ENG-42" when the task's space has an ID prefix and the task has its number yet.
    func taskKey(_ t: TaskItem) -> String? {
        guard let p = space(ofTask: t)?.idPrefix, !p.isEmpty, let n = t.number else { return nil }
        return "\(p)-\(n)"
    }

    /// Numbers every task in a space with an ID prefix, oldest first, after the highest number in use.
    /// Runs when a task view opens, so tasks created anywhere get one.
    func assignTaskNumbers() {
        let spaces = data.spaces.filter { !($0.idPrefix ?? "").isEmpty }
        guard !spaces.isEmpty else { return }
        let listSpace = Dictionary(data.lists.map { ($0.id, $0.spaceId) }, uniquingKeysWith: { a, _ in a })
        for s in spaces {
            let idx = data.tasks.indices.filter { listSpace[data.tasks[$0].listId] == s.id }
            let missing = idx.filter { data.tasks[$0].number == nil }.sorted { data.tasks[$0].created < data.tasks[$1].created }
            guard !missing.isEmpty else { continue }
            var next = idx.compactMap { data.tasks[$0].number }.max() ?? 0
            for i in missing { next += 1; data.tasks[i].number = next }
        }
    }

    func task(byKey key: String) -> TaskItem? {
        let parts = key.trimmingCharacters(in: .whitespaces).split(separator: "-")
        guard parts.count == 2, let n = Int(parts[1]),
              let s = data.spaces.first(where: { $0.idPrefix?.caseInsensitiveCompare(String(parts[0])) == .orderedSame }) else { return nil }
        let lists = Set(data.lists.filter { $0.spaceId == s.id }.map(\.id))
        return data.tasks.first { lists.contains($0.listId) && $0.number == n }
    }

    func taskType(_ t: TaskItem) -> TaskTypeDef? {
        guard let id = t.typeId else { return nil }
        return space(ofTask: t)?.taskTypes?.first { $0.id == id }
    }

    // MARK: Multiple lists

    func inLists(_ t: TaskItem, _ ids: Set<UUID>) -> Bool {
        ids.contains(t.listId) || (t.extraListIds ?? []).contains { ids.contains($0) }
    }

    // MARK: Close warnings

    /// Why closing this task might be premature.
    func closeWarnings(_ t: TaskItem) -> [String] {
        var out: [String] = []
        let subs = subtasks(of: t.id).filter { !isClosed($0) }
        if !subs.isEmpty { out.append("\(subs.count) subtask\(subs.count == 1 ? " is" : "s are") still open") }
        let items = t.checklists.flatMap(\.items).filter { !$0.done }
        if !items.isEmpty { out.append("\(items.count) checklist item\(items.count == 1 ? " is" : "s are") not done") }
        let empty = (space(ofTask: t)?.fields ?? []).filter { ($0.required ?? false) && !$0.type.isComputed && (t.customValues[$0.id] ?? "").isEmpty }
        if !empty.isEmpty { out.append("Required field\(empty.count == 1 ? "" : "s") empty: \(empty.map(\.name).joined(separator: ", "))") }
        let open = blockers(of: t)
        if !open.isEmpty { out.append("Still waiting on: \(open.map(\.title).joined(separator: ", "))") }
        return out
    }

    /// Asks before a change closes a task that still has open work. Headless (tests) always proceeds.
    func confirmClose(_ t: TaskItem) -> Bool {
        let w = closeWarnings(t)
        guard !w.isEmpty, let app = NSApp, app.isRunning else { return true }
        let alert = NSAlert()
        alert.messageText = "Close “\(t.title)” anyway?"
        alert.informativeText = w.map { "• " + $0 }.joined(separator: "\n")
        alert.addButton(withTitle: "Close anyway")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    // MARK: Status history

    /// Total time in each status, the current one counted up to now, in workflow order.
    func timeInStatus(_ t: TaskItem) -> [(status: StatusDef?, statusId: UUID, seconds: TimeInterval, current: Bool)] {
        let log = (t.statusLog?.isEmpty ?? true) ? [StatusChange(statusId: t.statusId, at: t.created)] : t.statusLog!
        var totals: [UUID: TimeInterval] = [:]
        for (i, e) in log.enumerated() {
            let end = i + 1 < log.count ? log[i + 1].at : Date()
            totals[e.statusId, default: 0] += max(0, end.timeIntervalSince(e.at))
        }
        let order = statuses(for: t)
        let rank = { (id: UUID) in order.firstIndex { $0.id == id } ?? 99 }
        return totals
            .map { key, secs in (status: order.first { $0.id == key }, statusId: key, seconds: secs, current: key == t.statusId) }
            .sorted { rank($0.statusId) < rank($1.statusId) }
    }

    // MARK: Rescheduling

    /// After a task's due date moved by `days`: if its space says so, move the tasks waiting on it
    /// (and theirs, once each) and its open subtasks by the same number of days.
    @discardableResult
    func cascadeDates(from t: TaskItem, days: Int) -> Int {
        guard days != 0, let s = space(ofTask: t), (s.rescheduleDependencies ?? false) || (s.remapSubtasks ?? false) else { return 0 }
        var moved: Set<UUID> = [t.id]
        func move(_ id: UUID, _ why: String) -> Bool {
            guard !moved.contains(id), let i = data.tasks.firstIndex(where: { $0.id == id }), !isClosed(data.tasks[i]),
                  data.tasks[i].startDate != nil || data.tasks[i].dueDate != nil else { return false }
            moved.insert(id)
            data.tasks[i].startDate = data.tasks[i].startDate?.adding(days: days)
            data.tasks[i].dueDate = data.tasks[i].dueDate?.adding(days: days)
            data.tasks[i].updated = Date()
            let n = abs(days)
            data.tasks[i].activity.append(ActivityItem(text: "\(me.name) moved it \(days > 0 ? "later" : "earlier") by \(n) day\(n == 1 ? "" : "s") \(why)"))
            return true
        }
        func walk(_ src: TaskItem) {
            if s.remapSubtasks ?? false { for sub in subtasks(of: src.id) { _ = move(sub.id, "with its parent “\(src.title)”") } }
            if s.rescheduleDependencies ?? false {
                for d in data.tasks where d.blockedBy.contains(src.id) && !d.archived {
                    if move(d.id, "because “\(src.title)” moved"), let again = task(d.id) { walk(again) }
                }
            }
        }
        walk(t)
        return moved.count - 1
    }

    // MARK: Reactions

    func toggleReaction(_ emoji: String, comment: UUID, task id: UUID) {
        let me = data.currentUserId
        updateTask(id) { t in
            guard let i = t.comments.firstIndex(where: { $0.id == comment }) else { return }
            var rs = t.comments[i].reactions ?? []
            if let r = rs.firstIndex(where: { $0.emoji == emoji }) {
                if rs[r].memberIds.contains(me) { rs[r].memberIds.removeAll { $0 == me } } else { rs[r].memberIds.append(me) }
            } else {
                rs.append(Reaction(emoji: emoji, memberIds: [me]))
            }
            rs.removeAll { $0.memberIds.isEmpty }
            t.comments[i].reactions = rs.isEmpty ? nil : rs
        }
    }

    func addReply(_ text: String, to parent: UUID, task id: UUID) {
        updateTask(id) { t in
            var c = Comment(authorId: self.data.currentUserId, text: text)
            c.parentId = parent
            t.comments.append(c)
            t.activity.append(ActivityItem(text: "\(self.me.name) replied to a comment"))
        }
    }

    // MARK: Saved views

    /// Views of a location this person can see: shared ones, and their own private ones.
    func savedViews(for scope: String) -> [(view: SavedView, isPrivate: Bool)] {
        (data.views.filter { $0.scope == scope }.map { ($0, false) }
            + data.privateViews.filter { $0.scope == scope && $0.ownerId == data.currentUserId }.map { ($0, true) })
            .sorted { $0.0.order == $1.0.order ? $0.0.name < $1.0.name : $0.0.order < $1.0.order }
    }

    func defaultView(for scope: String) -> SavedView? {
        let d = savedViews(for: scope).filter { $0.view.isDefault }
        return (d.first { $0.isPrivate } ?? d.first)?.view
    }

    func saveView(_ v: SavedView, isPrivate: Bool) {
        var v = v
        let all = savedViews(for: v.scope)
        if !all.contains(where: { $0.view.id == v.id }) { v.order = (all.map(\.view.order).max() ?? -1) + 1 }
        if v.isDefault { clearDefaultView(scope: v.scope, except: v.id) }
        removeView(v.id)
        if isPrivate { data.privateViews.append(v) } else { data.views.append(v) }
    }

    func removeView(_ id: UUID) {
        data.views.removeAll { $0.id == id }
        data.privateViews.removeAll { $0.id == id }
    }

    func clearDefaultView(scope: String, except: UUID?) {
        for i in data.views.indices where data.views[i].scope == scope && data.views[i].id != except { data.views[i].isDefault = false }
        for i in data.privateViews.indices where data.privateViews[i].scope == scope && data.privateViews[i].id != except { data.privateViews[i].isDefault = false }
    }
}

func formatDuration(_ s: TimeInterval) -> String {
    let m = Int((s / 60).rounded())
    if m < 60 { return "\(m)m" }
    let h = m / 60
    if h < 48 { return "\(h)h \(m % 60)m" }
    return "\(h / 24)d \(h % 24)h"
}

// MARK: - Chips

struct TypeBadge: View {
    let task: TaskItem
    var withName = false
    @Environment(Store.self) private var store

    var body: some View {
        if let ty = store.taskType(task) {
            HStack(spacing: 3) {
                Text(ty.icon)
                if withName { Text(ty.name).font(.caption.weight(.semibold)) }
            }
            .font(.caption)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color(hex: ty.colorHex).opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(Color(hex: ty.colorHex))
            .help(ty.name)
        }
    }
}

struct TaskKeyChip: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        if let k = store.taskKey(task) {
            Text(k)
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
                .foregroundStyle(.secondary)
                .help("Copy \(k)")
                .onTapGesture {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(k, forType: .string)
                }
        }
    }
}

struct PinnedFieldChips: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        let fields = (store.space(ofTask: task)?.fields ?? []).filter { $0.pinned ?? false }
        ForEach(fields) { f in
            let v = store.fieldDisplay(task, f)
            if !v.isEmpty {
                HStack(spacing: 3) {
                    Text(f.name).foregroundStyle(.tertiary)
                    Text(v).lineLimit(1)
                }
                .font(.caption2)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 5))
                .help(f.name)
            }
        }
    }
}

// MARK: - Saved views bar

struct SavedViewsBar: View {
    let scope: String
    @Binding var active: UUID?
    let current: () -> SavedView
    let apply: (SavedView) -> Void
    let reset: () -> Void
    @Environment(Store.self) private var store
    @State private var naming = false
    @State private var name = ""
    @State private var makePrivate = false
    @State private var makeDefault = false

    var body: some View {
        let views = store.savedViews(for: scope)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                tab("All tasks", on: active == nil) { reset() }
                ForEach(views, id: \.view.id) { item in
                    let v = item.view
                    tab(v.name, on: active == v.id, lock: item.isPrivate, star: v.isDefault) { active = v.id; apply(v) }
                        .contextMenu { menu(v, isPrivate: item.isPrivate) }
                }
                Button { naming = true } label: { Label("Save view", systemImage: "plus") }
                    .buttonStyle(.plain).foregroundStyle(Color.accentColor).padding(.horizontal, 8)
                    .help("Save the current view, grouping, sorting and filters")
                    .popover(isPresented: $naming) { savePopover }
            }
            .padding(.horizontal, 16)
        }
    }

    private func tab(_ title: String, on: Bool, lock: Bool = false, star: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if lock { Image(systemName: "lock.fill").font(.caption2) }
                if star { Image(systemName: "star.fill").font(.caption2).foregroundStyle(.yellow) }
                Text(title).lineLimit(1)
            }
            .font(.callout.weight(on ? .semibold : .regular))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background {
                if on { RoundedRectangle(cornerRadius: 8).fill(.background).shadow(color: .black.opacity(0.08), radius: 2, y: 1) }
            }
            .overlay(alignment: .bottom) { if on { Capsule().fill(Color.accentColor).frame(height: 2).padding(.horizontal, 10).offset(y: 4) } }
            .foregroundStyle(on ? .primary : .secondary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func menu(_ v: SavedView, isPrivate: Bool) -> some View {
        if active == v.id {
            Button("Save Changes to This View") {
                var x = current(); x.id = v.id; x.name = v.name; x.ownerId = v.ownerId; x.isDefault = v.isDefault; x.order = v.order
                store.saveView(x, isPrivate: isPrivate)
            }
        }
        Button(v.isDefault ? "Stop Opening First" : "Open This View First") {
            var x = v; x.isDefault.toggle(); store.saveView(x, isPrivate: isPrivate)
        }
        Button("Duplicate") { var x = v; x.id = UUID(); x.name += " copy"; x.isDefault = false; store.saveView(x, isPrivate: isPrivate) }
        Button(isPrivate ? "Share with the Workspace" : "Make Private") { store.saveView(v, isPrivate: !isPrivate) }
        Divider()
        Button("Delete View", role: .destructive) { store.removeView(v.id); if active == v.id { reset() } }
    }

    private var savePopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Save view").font(.headline)
            TextField("Name, e.g. My open bugs", text: $name).textFieldStyle(.roundedBorder).frame(width: 260)
                .onSubmit(save)
            Toggle("Private: only you see it", isOn: $makePrivate)
            Toggle("Open this view first here", isOn: $makeDefault)
            HStack { Spacer(); Button("Cancel") { naming = false }; Button("Save", action: save).buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) }
        }
        .padding(16)
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        var v = current(); v.id = UUID(); v.name = n; v.isDefault = makeDefault
        store.saveView(v, isPrivate: makePrivate)
        active = v.id
        name = ""; makePrivate = false; makeDefault = false; naming = false
    }
}

// MARK: - Team and Activity views

struct TeamModeView: View {
    let tasks: [TaskItem]
    @Environment(Store.self) private var store

    var body: some View {
        let weekAgo = Date().adding(days: -7)
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 14)], spacing: 14) {
                ForEach(store.data.members) { m in
                    let mine = tasks.filter { $0.assigneeIds.contains(m.id) }
                    let open = mine.filter { !store.isClosed($0) }
                    let doing = open.filter { store.status(of: $0)?.kind == .active }
                    let overdue = open.filter(store.isOverdue)
                    let done = mine.filter { store.isClosed($0) && ($0.completedAt ?? .distantPast) >= weekAgo }
                    let hours = Double(open.compactMap(\.estimateMinutes).reduce(0, +)) / 60
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            AvatarView(member: m, size: 30)
                            VStack(alignment: .leading) {
                                Text(m.name).font(.headline)
                                Text("\(open.count) open · \(hours > 0 ? String(format: "%.1fh estimated", hours) : "no estimates")").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        column("In progress", doing, .blue)
                        if !overdue.isEmpty { column("Overdue", overdue, .red) }
                        column("Done this week", done, .green)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .mkCard()
                }
            }
            .padding(16)
        }
    }

    private func column(_ title: String, _ ts: [TaskItem], _ tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(title) · \(ts.count)").font(.caption.bold()).foregroundStyle(tone)
            ForEach(ts.prefix(8)) { t in
                HStack(spacing: 6) {
                    StatusPill(status: store.status(of: t), compact: true)
                    Text(t.title).lineLimit(1).font(.callout)
                }
                .contentShape(Rectangle())
                .onTapGesture { store.openTaskId = t.id }
            }
            if ts.count > 8 { Text("+\(ts.count - 8) more").font(.caption).foregroundStyle(.tertiary) }
        }
    }
}

struct ActivityModeView: View {
    let tasks: [TaskItem]
    @Environment(Store.self) private var store
    @State private var days = 14

    private struct Entry: Identifiable { let id: UUID; let date: Date; let text: String; let task: TaskItem; let author: UUID? }

    var body: some View {
        let since = Date().startOfDay.adding(days: -days)
        let ids = Set(tasks.map(\.id))
        let inView = store.data.tasks.filter { ids.contains($0.id) || ($0.parentId.map(ids.contains) ?? false) }
        let entries = inView.flatMap { t in
            t.activity.filter { $0.date >= since }.map { Entry(id: $0.id, date: $0.date, text: $0.text, task: t, author: nil) }
                + t.comments.filter { $0.date >= since }.map { Entry(id: $0.id, date: $0.date, text: "💬 " + $0.text.prefix(140), task: t, author: $0.authorId) }
        }.sorted { $0.date > $1.date }.prefix(400)
        let days_ = Dictionary(grouping: entries) { $0.date.startOfDay }.sorted { $0.key > $1.key }
        VStack(spacing: 0) {
            HStack {
                Text("Activity").font(.headline)
                Spacer()
                Picker("", selection: $days) { Text("Today").tag(1); Text("Last 7 days").tag(7); Text("Last 14 days").tag(14); Text("Last 30 days").tag(30); Text("Last year").tag(365) }
                    .labelsHidden().fixedSize()
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            if entries.isEmpty {
                EmptyState(icon: "clock.arrow.circlepath", title: "Nothing happened here yet", subtitle: "Changes and comments on these tasks appear here.")
            } else {
                List {
                    ForEach(days_, id: \.key) { day, es in
                        Section(day.formatted(.dateTime.weekday(.wide).month().day())) {
                            ForEach(es) { e in
                                HStack(alignment: .top, spacing: 10) {
                                    if let a = e.author { AvatarView(member: store.member(a), size: 20) } else {
                                        Circle().fill(Color(hex: store.status(of: e.task)?.colorHex ?? "#7B68EE")).frame(width: 9, height: 9).padding(.top, 5).frame(width: 20)
                                    }
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(e.text).lineLimit(2)
                                        Text(e.task.title).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(e.date.formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                                .onTapGesture { store.openTaskId = e.task.id }
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
    }
}

// MARK: - Task panel pieces

struct TimeInStatusView: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        let rows = store.timeInStatus(task)
        let top = max(rows.map(\.seconds).max() ?? 1, 1)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(rows, id: \.statusId) { r in
                HStack(spacing: 8) {
                    Text((r.status?.name ?? "Removed status") + (r.current ? " · now" : ""))
                        .font(.caption.weight(r.current ? .bold : .regular)).frame(width: 120, alignment: .leading).lineLimit(1)
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.primary.opacity(0.06))
                            Capsule().fill(Color(hex: r.status?.colorHex ?? "#87909E")).frame(width: max(4, g.size.width * r.seconds / top))
                        }
                    }
                    .frame(height: 8)
                    Text(formatDuration(r.seconds)).font(.caption.monospacedDigit()).frame(width: 70, alignment: .trailing)
                }
            }
            if task.statusLog?.isEmpty ?? true {
                Text("Counted from when the task was created; every status change from now on is recorded.").font(.caption).foregroundStyle(.tertiary)
            }
        }
    }
}

/// Home list plus the other lists the task also appears in.
struct TaskListsPicker: View {
    let task: TaskItem
    @Environment(Store.self) private var store

    var body: some View {
        let name = { (id: UUID) -> String in
            guard let l = store.list(id) else { return "Removed list" }
            return "\(store.space(l.spaceId)?.name ?? "") › \(l.name)"
        }
        HStack(spacing: 6) {
            Label(name(task.listId), systemImage: "house").font(.caption)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.12), in: Capsule())
            ForEach(task.extraListIds ?? [], id: \.self) { id in
                HStack(spacing: 2) {
                    Text(name(id)).font(.caption)
                    Button { store.updateTask(task.id) { t in t.extraListIds?.removeAll { $0 == id }; if t.extraListIds?.isEmpty ?? false { t.extraListIds = nil } } } label: { Image(systemName: "xmark").font(.system(size: 8)) }
                        .buttonStyle(.plain)
                }
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color.primary.opacity(0.06), in: Capsule())
            }
            Menu {
                ForEach(store.data.lists.filter { !$0.archived && $0.id != task.listId && !(task.extraListIds ?? []).contains($0.id) }) { l in
                    Button(name(l.id)) { store.updateTask(task.id) { $0.extraListIds = ($0.extraListIds ?? []) + [l.id] } }
                }
            } label: { Image(systemName: "plus.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Also show this task in another list")
        }
    }
}

/// Threaded comments with emoji reactions.
struct CommentThreadView: View {
    let taskId: UUID
    @Environment(Store.self) private var store
    @State private var replyTo: UUID?
    @State private var reply = ""
    private static let reactions = ["👍", "❤️", "🎉", "😄", "👀", "✅"]

    var body: some View {
        let t = store.task(taskId)
        let comments = t?.comments ?? []
        let top = comments.filter { c in c.parentId == nil || !comments.contains { $0.id == c.parentId } }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(top) { c in
                VStack(alignment: .leading, spacing: 6) {
                    CommentBubble(taskId: taskId, comment: c, isReply: false, onReply: { replyTo = replyTo == c.id ? nil : c.id; reply = "" })
                    ForEach(comments.filter { $0.parentId == c.id }) { r in
                        CommentBubble(taskId: taskId, comment: r, isReply: true, onReply: nil).padding(.leading, 28)
                    }
                    if replyTo == c.id {
                        HStack(alignment: .bottom) {
                            TextField("Reply…", text: $reply, axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder)
                            Button("Reply") {
                                let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !text.isEmpty { store.addReply(text, to: c.id, task: taskId) }
                                reply = ""; replyTo = nil
                            }
                            .keyboardShortcut(.return, modifiers: .command)
                        }
                        .padding(.leading, 28)
                    }
                }
            }
        }
    }

    static var emoji: [String] { reactions }
}

private struct CommentBubble: View {
    let taskId: UUID
    let comment: Comment
    let isReply: Bool
    let onReply: (() -> Void)?
    @Environment(Store.self) private var store

    var body: some View {
        let c = comment
        let replies = store.task(taskId)?.comments.filter { $0.parentId == c.id }.count ?? 0
        HStack(alignment: .top) {
            AvatarView(member: store.member(c.authorId), size: isReply ? 20 : 26)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(store.member(c.authorId)?.name ?? "Unknown").font(.callout.bold())
                    Text(c.date.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if !isReply {
                        Button(c.resolved ? "Resolved" : "Resolve") {
                            store.updateTask(taskId) { t in if let i = t.comments.firstIndex(where: { $0.id == c.id }) { t.comments[i].resolved.toggle() } }
                        }
                        .buttonStyle(.link).font(.caption)
                    }
                    Button { store.updateTask(taskId) { t in t.comments.removeAll { $0.id == c.id || $0.parentId == c.id } } } label: { Image(systemName: "trash").font(.caption) }
                        .buttonStyle(.plain).help(isReply ? "Delete reply" : "Delete comment and its replies")
                }
                MarkdownText(text: c.text).opacity(c.resolved ? 0.5 : 1)
                HStack(spacing: 4) {
                    ForEach(c.reactions ?? [], id: \.emoji) { r in
                        let mine = r.memberIds.contains(store.data.currentUserId)
                        Button { store.toggleReaction(r.emoji, comment: c.id, task: taskId) } label: {
                            Text("\(r.emoji) \(r.memberIds.count)").font(.caption.weight(mine ? .semibold : .regular))
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(mine ? Color.accentColor.opacity(0.15) : Color.primary.opacity(0.05), in: Capsule())
                                .overlay(Capsule().stroke(mine ? Color.accentColor.opacity(0.5) : .clear))
                        }
                        .buttonStyle(.plain)
                        .help(r.memberIds.compactMap { store.member($0)?.name }.joined(separator: ", "))
                    }
                    Menu {
                        ForEach(CommentThreadView.emoji, id: \.self) { e in Button(e) { store.toggleReaction(e, comment: c.id, task: taskId) } }
                    } label: { Image(systemName: "face.smiling") }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("React")
                    if let onReply {
                        Button(action: onReply) { Label(replies > 0 ? "Reply · \(replies)" : "Reply", systemImage: "arrowshape.turn.up.left") }
                            .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(8)
        .background(Color.primary.opacity(isReply ? 0.02 : 0.03), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Space settings additions

/// Task types, task IDs and scheduling options of a space (shown inside SpaceSettingsView).
struct SpaceWorkSettings: View {
    let index: Int
    @Environment(Store.self) private var store
    private static let icons = ["🐞", "✨", "🧩", "📣", "🤝", "📅", "📦", "🧪", "🛠", "🎯", "📄", "💡"]

    var body: some View {
        @Bindable var store = store
        Section("Task Types") {
            ForEach(Array((store.data.spaces[index].taskTypes ?? []).enumerated()), id: \.element.id) { i, ty in
                HStack {
                    Picker("", selection: Binding(get: { ty.icon }, set: { v in store.data.spaces[index].taskTypes?[i].icon = v })) {
                        ForEach(Self.icons, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().frame(width: 60)
                    TextField("Type", text: Binding(get: { ty.name }, set: { v in store.data.spaces[index].taskTypes?[i].name = v }))
                    ColorDots(hex: Binding(get: { ty.colorHex }, set: { v in store.data.spaces[index].taskTypes?[i].colorHex = v }))
                    Button { let id = ty.id; DispatchQueue.main.async { store.data.spaces[index].taskTypes?.removeAll { $0.id == id } } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                }
            }
            Button("Add task type") {
                let n = store.data.spaces[index].taskTypes?.count ?? 0
                store.data.spaces[index].taskTypes = (store.data.spaces[index].taskTypes ?? []) + [TaskTypeDef(name: "Bug", icon: Self.icons[n % Self.icons.count], colorHex: paletteHexes[(n + 4) % paletteHexes.count])]
            }
        }
        Section("Task IDs") {
            TextField("Prefix, e.g. ENG", text: Binding(
                get: { store.data.spaces[index].idPrefix ?? "" },
                set: { v in
                    let p = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(10))
                    store.data.spaces[index].idPrefix = p.first?.isLetter == true ? p : nil
                }))
            Text("Tasks show \(store.data.spaces[index].idPrefix ?? "ENG")-42, numbered in the order they were created. ⌘K finds a task by its ID.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Section("Scheduling") {
            Toggle("Reschedule dependencies", isOn: Binding(get: { store.data.spaces[index].rescheduleDependencies ?? false }, set: { store.data.spaces[index].rescheduleDependencies = $0 ? true : nil }))
            Text("When a task's due date moves, the tasks waiting on it move by the same number of days.").font(.caption).foregroundStyle(.secondary)
            Toggle("Move subtasks with their parent", isOn: Binding(get: { store.data.spaces[index].remapSubtasks ?? false }, set: { store.data.spaces[index].remapSubtasks = $0 ? true : nil }))
            Text("When a task's due date moves, its open subtasks move too.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
