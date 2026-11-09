import Foundation
import AppKit
import SwiftUI
import CryptoKit

struct CloudWorkspace: Identifiable, Hashable {
    let id: UUID
    let name: String
    let role: String
}

struct CloudMember: Identifiable, Hashable {
    let id: UUID
    var email: String
    var name: String
    var color: String
    var role: String
    var publicKey: String?
    var hasKey = false
}

struct CloudInvite: Identifiable, Hashable {
    var id: String { email }
    let email: String
    let role: String
}

struct PresenceInfo: Identifiable, Hashable {
    let id: UUID
    let viewing: String
    let client: String
}

enum SyncStatus: Equatable {
    case off, syncing, synced(Date), error(String)
}

/// Keeps the local workspace in step with the team's Cloudflare workspace (shared with the website).
///
/// Every synced object is one row on the server. A sync cycle first pulls rows whose `seq`
/// is above the cursor (merging with unsynced local edits field by field), then pushes
/// objects whose encoding differs from what was last synced. Both are POST /sync calls.
@Observable
final class CloudSync {
    private(set) var client: CloudClient
    var status: SyncStatus = .off
    var workspaces: [CloudWorkspace] = []
    var team: [CloudMember] = []
    var invites: [CloudInvite] = []
    var online: [PresenceInfo] = []
    var workspaceName = ""
    var myRole = "member"
    /// 0 = workspace not encrypted yet; otherwise the current workspace key version.
    var keyVersion = 0
    var waitingForKey = false
    var isEncrypted: Bool { keyVersion > 0 }

    var config: CloudConfig {
        didSet {
            client.config = config
            if let raw = try? JSONEncoder().encode(config) { Store.defaults.set(raw, forKey: "cloudServer") }
        }
    }

    var workspaceId: UUID? {
        didSet { Store.defaults.set(workspaceId?.uuidString, forKey: "cloudWorkspaceId") }
    }

    var isSignedIn: Bool { client.isSignedIn }
    var isConnected: Bool { isSignedIn && workspaceId != nil }
    var canWrite: Bool { myRole != "viewer" }
    var isAdmin: Bool { myRole == "owner" || myRole == "admin" }
    var email: String { client.session?.email ?? "" }

    weak var store: Store?

    private var cursor: Int64 = 0
    /// Canonical *plaintext* of each object as last synced (stays on this Mac, file mode 600).
    private var lastSynced: [String: Data] = [:]
    /// Workspace keys by version; raw bytes are kept so they can be shared with new members.
    private var keys: [Int: Data] = [:]
    private var forcePushAll = false
    private var running = false
    private var pending = false
    /// True while data is being replaced by remote or switched workspaces, so the change is not treated as a local edit.
    var applyingRemote = false
    private var timer: Timer?
    private var debounce: DispatchWorkItem?

    init() {
        let saved = Store.defaults.data(forKey: "cloudServer").flatMap { try? JSONDecoder().decode(CloudConfig.self, from: $0) }
        // The team's server is known: no set-up step before signing in.
        let cfg = saved.flatMap { $0.isComplete ? $0 : nil } ?? CloudConfig(url: CloudSync.defaultServer)
        config = cfg
        client = CloudClient(config: cfg)
        workspaceId = Store.defaults.string(forKey: "cloudWorkspaceId").flatMap(UUID.init)
        loadState()
    }

    static let defaultServer = "https://mkprod.mohamd-beam.workers.dev"

    /// Last time something changed here or arrived from a teammate; drives the polling cadence.
    private var lastActivity = Date()
    private var lastPoll = Date.distantPast

    func start() {
        timer?.invalidate()
        // Cadence: 2 s while anyone is actively changing things (for a minute after the last
        // change), 6 s when quiet. A local edit syncs within a second; coming to the front syncs at once.
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            let interval: TimeInterval = Date().timeIntervalSince(self.lastActivity) < 60 ? 2 : 6
            if Date().timeIntervalSince(self.lastPoll) >= interval { self.lastPoll = Date(); self.syncSoon(delay: 0) }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.syncSoon(delay: 0)
        }
        syncSoon(delay: 0.5)
        // Signed in but no workspace chosen yet: load the list so Settings can offer it right away.
        if isSignedIn { Task { @MainActor in try? await self.refreshWorkspaces() } }
    }

    func localChanged() {
        guard !applyingRemote, isConnected else { return }
        lastActivity = Date()
        syncSoon(delay: 1)
    }

    func syncSoon(delay: TimeInterval) {
        guard isConnected else { return }
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in Task { @MainActor in await self?.sync() } }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Account

    func signIn(email: String, password: String) async throws {
        try await client.signIn(email: email, password: password)
        try await refreshWorkspaces()
    }

    func signUp(email: String, password: String, name: String) async throws {
        try await client.signUp(email: email, password: password, name: name)
        if let store {
            store.data.members = store.data.members.map { m in var m = m; if m.id == store.data.currentUserId { m.name = name }; return m }
        }
        try await refreshWorkspaces()
    }

    func recover(email: String, code: String, newPassword: String) async throws {
        try await client.recover(email: email, code: code, newPassword: newPassword)
        try await refreshWorkspaces()
    }

    func signOut() {
        client.signOut()
        disconnect()
    }

    func refreshWorkspaces() async throws {
        let obj = try await client.call("GET", "/api/me")
        workspaces = (obj["workspaces"] as? [[String: Any]] ?? []).compactMap { r in
            guard let s = r["id"] as? String, let id = UUID(uuidString: s) else { return nil }
            return CloudWorkspace(id: id, name: r["name"] as? String ?? "Workspace", role: r["role"] as? String ?? "member")
        }
    }

    // MARK: - Connecting a workspace

    /// Uploads the current local workspace as a new shared workspace owned by the signed-in user.
    func publishCurrentWorkspace(name: String) async throws {
        guard let store, let uid = client.session?.userId else { return }
        let obj = try await client.call("POST", "/api/workspaces", ["name": name])
        guard let idString = obj["id"] as? String, let id = UUID(uuidString: idString) else { throw CloudError(message: "Could not create the workspace.") }
        let wasLocal = workspaceId == nil
        applyingRemote = true
        store.remapMember(from: store.data.currentUserId, to: uid)
        store.data.workspaceName = name
        applyingRemote = false
        workspaceId = id
        myRole = "owner"
        cursor = 0
        lastSynced = [:]
        keys = [:]
        keyVersion = 0
        saveState()
        store.saveNow() // now lives in workspace-<id>.json
        _ = wasLocal
        try await refreshWorkspaces()
        await sync()
    }

    /// Switches to a shared workspace. The current workspace is saved to its own file first, and
    /// the target is loaded from its file if it was opened before (otherwise pulled from the server).
    func join(_ ws: CloudWorkspace) async throws {
        guard let store, let uid = client.session?.userId else { return }
        guard ws.id != workspaceId else { return }
        store.saveNow()
        saveState()
        workspaceId = ws.id
        myRole = ws.role
        team = []
        online = []
        cursor = 0
        lastSynced = [:]
        keys = [:]
        keyVersion = 0
        loadState()
        var fresh = AppData(currentUserId: uid)
        fresh.workspaceName = ws.name
        store.replaceData(Store.load(Store.fileURL(for: ws.id)) ?? fresh)
        await sync()
    }

    /// Back to the local workspace (this Mac only). The shared workspace's file stays for next time.
    func disconnect() {
        if let store, workspaceId != nil {
            store.saveNow()
            saveState()
        }
        workspaceId = nil
        team = []
        online = []
        status = .off
        cursor = 0
        lastSynced = [:]
        keys = [:]
        keyVersion = 0
        if let store { store.replaceData(AppData(currentUserId: client.session?.userId ?? store.data.currentUserId)) }
    }

    /// New, empty shared workspace with a first space and list, opened right away.
    func createWorkspace(name: String) async throws {
        guard let store, let uid = client.session?.userId else { return }
        let obj = try await client.call("POST", "/api/workspaces", ["name": name])
        guard let idString = obj["id"] as? String, let id = UUID(uuidString: idString) else { throw CloudError(message: "Could not create the workspace.") }
        try await refreshWorkspaces()
        try await join(CloudWorkspace(id: id, name: name, role: "owner"))
        var d = store.data
        d.currentUserId = uid
        let space = Space(name: "Team")
        let list = TaskList(spaceId: space.id, name: "Tasks")
        d.spaces.append(space)
        d.lists.append(list)
        store.data = d
    }

    /// Data left by the old local-only version of the app, if any (workspace.json with content).
    var legacyLocalData: AppData? {
        guard let d = Store.load(Store.fileURL), !d.tasks.isEmpty || d.spaces.count > 1 || !d.orders.isEmpty else { return nil }
        return d
    }

    /// Uploads the old local-only data as a new shared workspace, once; the file is then renamed.
    func uploadLegacyLocalData(name: String) async throws {
        guard let store, let legacy = legacyLocalData else { return }
        if workspaceId != nil { store.saveNow(); saveState() }
        workspaceId = nil
        store.replaceData(legacy)
        try await publishCurrentWorkspace(name: name)
        let done = Store.dataDir.appendingPathComponent("workspace-uploaded-\(Int(Date().timeIntervalSince1970)).json")
        try? FileManager.default.moveItem(at: Store.fileURL, to: done)
    }

    private func backupLocal() {
        guard let store else { return }
        let url = Store.fileURL.deletingLastPathComponent().appendingPathComponent("backup-\(Int(Date().timeIntervalSince1970)).json")
        if let raw = try? Store.encoder.encode(store.data) { try? Store.writePrivate(raw, to: url) }
    }

    // MARK: - Team management

    private var wsPath: String { "/api/workspaces/\(workspaceId?.uuidString ?? "")" }

    /// Returns the one-time invite code to pass to the teammate.
    func invite(email: String, role: String) async throws -> String {
        let obj = try await client.call("POST", wsPath + "/invites", ["email": email, "role": role])
        try await fetchTeam()
        return obj["code"] as? String ?? ""
    }

    func acceptInvite(code: String) async throws {
        try await client.call("POST", "/api/invites/accept", ["code": code])
        try await refreshWorkspaces()
    }

    func cancelInvite(_ email: String) async throws {
        let e = email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email
        try await client.call("DELETE", wsPath + "/invites/\(e)")
        try await fetchTeam()
    }

    func setRole(_ user: UUID, _ role: String) async throws {
        try await client.call("POST", wsPath + "/members/\(user.uuidString)/role", ["role": role])
        try await fetchTeam()
    }

    /// Removes someone, then rotates the workspace key so they can't read anything new.
    func remove(_ user: UUID) async throws {
        try await client.call("DELETE", wsPath + "/members/\(user.uuidString)")
        try await fetchTeam()
        if isEncrypted { try await rotateKey() }
    }

    /// Picks a temporary password, sends only its stretched auth key, and returns it for the admin to pass on.
    func resetPassword(_ user: UUID) async throws -> String {
        guard let m = team.first(where: { $0.id == user }) else { throw CloudError(message: "Member not found") }
        let temp = E2E.randomPassword()
        let pk = E2E.passwordKeys(email: m.email, password: temp)
        try await client.call("POST", wsPath + "/members/\(user.uuidString)/password", ["authKey": pk.authKey])
        return temp
    }

    func updateMyProfile(name: String, color: String) async throws {
        try await client.updateProfile(name: name, color: color)
        try await fetchTeam()
    }

    func renameWorkspace(_ name: String) async throws {
        try await client.call("PATCH", wsPath, ["name": name])
        try await fetchTeam()
    }

    func fetchTeam() async throws {
        guard workspaceId != nil else { return }
        let obj: [String: Any]
        do { obj = try await client.call("GET", wsPath + "/team") } catch let e as CloudError where e.status == 403 {
            disconnect()
            throw CloudError(message: "You no longer have access to this workspace.")
        }
        workspaceName = obj["name"] as? String ?? workspaceName
        myRole = obj["role"] as? String ?? myRole
        if let v = (obj["keyVersion"] as? NSNumber)?.intValue { keyVersion = max(keyVersion, v) }
        applyMembers(obj["members"] as? [[String: Any]] ?? [])
        invites = (obj["invites"] as? [[String: Any]] ?? []).map { CloudInvite(email: $0["email"] as? String ?? "", role: $0["role"] as? String ?? "member") }
    }

    private func applyMembers(_ rows: [[String: Any]]) {
        team = rows.compactMap { r in
            guard let s = r["id"] as? String, let id = UUID(uuidString: s) else { return nil }
            let email = r["email"] as? String ?? ""
            let name = (r["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? email
            return CloudMember(id: id, email: email, name: name, color: r["color"] as? String ?? "#7B68EE", role: r["role"] as? String ?? "member",
                               publicKey: r["publicKey"] as? String, hasKey: (r["hasKey"] as? NSNumber)?.boolValue ?? false)
        }
        guard let store, !team.isEmpty else { return }
        let members = team.map { Member(id: $0.id, name: $0.name, email: $0.email, colorHex: $0.color) }
        applyingRemote = true
        if store.data.members != members { store.data.members = members }
        if let uid = client.session?.userId, store.data.currentUserId != uid { store.data.currentUserId = uid }
        if !workspaceName.isEmpty, store.data.workspaceName != workspaceName { store.data.workspaceName = workspaceName }
        applyingRemote = false
    }

    // MARK: - Sync loop

    @MainActor
    func sync() async {
        guard isConnected, let store else { return }
        if running { pending = true; return }
        running = true
        defer {
            running = false
            if pending { pending = false; syncSoon(delay: 0.2) }
        }
        if case .synced = status {} else { status = .syncing }
        do {
            var more = true
            while more { more = try await exchange(store, push: []) }
            // The first owner/admin to connect encrypts the workspace.
            if keyVersion == 0 && isAdmin && client.keyPair != nil {
                try await startNewKeyVersion()
            }
            waitingForKey = isEncrypted && keys[keyVersion] == nil
            if waitingForKey {
                status = .error("Waiting for a teammate to share the encryption key with you.")
                saveState()
                return
            }
            try? await shareKeys()
            let previous = lastSynced
            if forcePushAll { lastSynced = [:]; forcePushAll = false }
            if canWrite {
                let rows = try pushRows(store)
                let notices = previous.isEmpty ? [] : emailNotices(rows, previous: previous, store: store)
                // Keep each request well under the server's body limit.
                var batch: [[String: Any]] = []
                var size = 0
                for r in rows {
                    let n = ((r["data"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0).count }) ?? 100
                    if !batch.isEmpty && size + n > 1_500_000 { _ = try await exchange(store, push: batch); batch = []; size = 0 }
                    batch.append(r)
                    size += n
                }
                if !batch.isEmpty { _ = try await exchange(store, push: batch) }
                await sendNotices(notices + contractNotices(store))
            } else {
                revertLocalEdits(store)
            }
            saveState()
            status = .synced(Date())
        } catch let e as CloudError where e.status == 403 && e.message.contains("not a member") {
            disconnect()
            status = .error("You no longer have access to this workspace.")
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    /// One POST /sync round trip. Returns true when the server has more rows to send.
    private func exchange(_ store: Store, push: [[String: Any]]) async throws -> Bool {
        let viewing = store.openTaskId.map { "task:\($0.uuidString)" } ?? store.title(for: store.selection ?? .home)
        let wire = push.map { $0.filter { $0.key != "plain" } }
        let obj = try await client.call("POST", wsPath + "/sync", ["cursor": cursor, "push": wire, "viewing": viewing, "client": "mac"])
        for r in push {
            guard let kind = r["kind"] as? String, let id = r["id"] as? String else { continue }
            lastSynced["\(kind)/\(id)"] = r["deleted"] as? Bool == true ? nil : r["plain"] as? Data
        }
        myRole = obj["role"] as? String ?? myRole
        if let v = (obj["keyVersion"] as? NSNumber)?.intValue, v > keyVersion { keyVersion = v }
        unlockKeys(obj["myKeys"] as? [[String: Any]] ?? [])
        applyMembers(obj["members"] as? [[String: Any]] ?? [])
        online = (obj["presence"] as? [[String: Any]] ?? []).compactMap { r in
            guard let s = r["user_id"] as? String, let id = UUID(uuidString: s) else { return nil }
            return PresenceInfo(id: id, viewing: r["viewing"] as? String ?? "", client: r["client"] as? String ?? "")
        }
        // Rows we can't decrypt yet (key not shared with us): keep the cursor and retry later.
        guard let rows = decrypt(obj["records"] as? [[String: Any]] ?? []) else { return false }
        apply(rows, to: store)
        if let c = (obj["cursor"] as? NSNumber)?.int64Value { cursor = max(cursor, c) }
        return obj["more"] as? Bool ?? false
    }

    private func apply(_ rows: [[String: Any]], to store: Store) {
        guard !rows.isEmpty else { return }
        lastActivity = Date()
        var local = store.data
        var notifications: [() -> Void] = []
        let snapshots = Dictionary(uniqueKeysWithValues: SyncKind.all.map { ($0.name, $0.snapshot(local)) })
        for r in rows {
            guard let kindName = r["kind"] as? String, let kind = SyncKind.byName[kindName],
                  let idString = r["id"] as? String, let id = UUID(uuidString: idString) else { continue }
            let key = "\(kindName)/\(id.uuidString)"
            let localData = snapshots[kindName]?[id]
            if r["deleted"] as? Bool == true {
                kind.apply(&local, id, nil)
                lastSynced[key] = nil
                continue
            }
            guard let obj = r["data"], let raw = try? JSONSerialization.data(withJSONObject: obj),
                  let canonical = kind.canonicalize(raw) else { continue }
            if canonical == localData { lastSynced[key] = canonical; continue }
            let dirty = localData != lastSynced[key]
            if dirty, let localData {
                // Both sides changed since the last sync: keep each side's edited fields.
                let merged = SyncKind.merge(base: lastSynced[key], local: localData, remote: canonical, canonicalize: kind.canonicalize)
                kind.apply(&local, id, merged)
                lastSynced[key] = canonical
                continue
            }
            if kindName == "tasks" { notifications.append { [weak self] in self?.notifyRemoteTaskChange(store: store, old: localData, new: canonical) } }
            if kindName == "messages", localData == nil { notifications.append { [weak self] in self?.notifyMessage(store: store, raw: canonical) } }
            if kindName == "orders" { notifications.append { [weak self] in self?.notifyOrder(store: store, old: localData, new: canonical) } }
            kind.apply(&local, id, canonical)
            lastSynced[key] = canonical
        }
        applyingRemote = true
        store.data = local
        applyingRemote = false
        // After the merged snapshot is in place, so inbox items aren't overwritten by it.
        notifications.forEach { $0() }
    }

    /// Changed objects. `data` is encrypted when the workspace is; `plain` stays local for bookkeeping.
    private func pushRows(_ store: Store) throws -> [[String: Any]] {
        var rows: [[String: Any]] = []
        var seen = Set<String>()
        let wsKey = keys[keyVersion].map { SymmetricKey(data: $0) }
        let personalKey = try client.keyPair.map { try E2E.personalKey($0) }
        for kind in SyncKind.all {
            // Personal data is never uploaded in the clear; without a key pair it stays on this Mac.
            if kind.personal && personalKey == nil { continue }
            for (id, data) in kind.snapshot(store.data) {
                let key = "\(kind.name)/\(id.uuidString)"
                seen.insert(key)
                guard lastSynced[key] != data else { continue }
                let payload: Any
                if kind.personal, let personalKey, let ws = workspaceId {
                    var p = try E2E.encryptRecord(data, key: personalKey, version: keyVersion, ws: ws, kind: kind.name, id: id.uuidString)
                    p["p"] = 1
                    payload = p
                } else if isEncrypted, let wsKey, let ws = workspaceId {
                    payload = try E2E.encryptRecord(data, key: wsKey, version: keyVersion, ws: ws, kind: kind.name, id: id.uuidString)
                } else {
                    guard let obj = try? JSONSerialization.jsonObject(with: data) else { continue }
                    payload = obj
                }
                rows.append(["kind": kind.name, "id": id.uuidString, "data": payload, "deleted": false, "plain": data])
            }
        }
        for key in lastSynced.keys where !seen.contains(key) {
            let parts = key.split(separator: "/")
            guard parts.count == 2 else { continue }
            rows.append(["kind": String(parts[0]), "id": String(parts[1]), "deleted": true])
        }
        return rows
    }

    // MARK: - Encryption keys

    private func unlockKeys(_ mine: [[String: Any]]) {
        guard let pair = client.keyPair, let ws = workspaceId, let uid = client.session?.userId else { return }
        for w in mine {
            guard let v = (w["version"] as? NSNumber)?.intValue, keys[v] == nil, let wrapped = w["wrapped"] as? String else { continue }
            // A copy wrapped for an older key pair of ours fails here; a teammate re-shares it.
            if let raw = try? E2E.unwrap(wrapped, with: pair, ws: ws, user: uid, version: v) { keys[v] = raw }
        }
    }

    /// Decrypts pulled rows. Returns nil when a row needs the current key and we don't have it yet.
    private func decrypt(_ rows: [[String: Any]]) -> [[String: Any]]? {
        guard let ws = workspaceId else { return rows }
        var out: [[String: Any]] = []
        for var r in rows {
            guard r["deleted"] as? Bool != true, let d = r["data"] as? [String: Any], d["enc"] is String,
                  let v = (d["v"] as? NSNumber)?.intValue, let kind = r["kind"] as? String, let id = r["id"] as? String
            else { out.append(r); continue }
            if d["p"] != nil {
                // Someone's personal record (inbox/reminder). Ours decrypts with our own key; others' are skipped.
                guard let pair = client.keyPair, let personalKey = try? E2E.personalKey(pair),
                      let plain = try? E2E.decryptRecord(d, key: personalKey, ws: ws, kind: kind, id: id),
                      let obj = try? JSONSerialization.jsonObject(with: plain) else { continue }
                r["data"] = obj
                out.append(r)
                continue
            }
            guard let raw = keys[v] else {
                if v >= keyVersion { return nil }
                continue // retired key we never received; the record was re-encrypted since
            }
            guard let plain = try? E2E.decryptRecord(d, key: SymmetricKey(data: raw), ws: ws, kind: kind, id: id),
                  let obj = try? JSONSerialization.jsonObject(with: plain) else {
                print("MK Prod: could not decrypt \(kind) \(id)") // tampered or mis-addressed: ignore
                continue
            }
            r["data"] = obj
            out.append(r)
        }
        return out
    }

    /// Share the current key with members who have a key pair but no copy yet (trust on first use).
    private func shareKeys() async throws {
        guard canWrite, let raw = keys[keyVersion], let ws = workspaceId, let me = client.session?.userId else { return }
        let needs = team.filter { $0.publicKey != nil && !$0.hasKey && $0.id != me }
        guard !needs.isEmpty else { return }
        let wraps: [[String: Any]] = try needs.map { m in
            ["userId": m.id.uuidString, "wrapped": try E2E.wrap(workspaceKey: raw, for: m.publicKey!, ws: ws, user: m.id, version: keyVersion)]
        }
        try await client.call("POST", wsPath + "/keys", ["version": keyVersion, "wraps": wraps])
    }

    /// New key version (first encryption, or after removing someone); everything is re-encrypted on the next push.
    private func startNewKeyVersion() async throws {
        guard isAdmin, let ws = workspaceId, let me = client.session?.userId, let pair = client.keyPair else { return }
        let version = keyVersion + 1
        let raw = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        var recipients = team.compactMap { m in m.publicKey.map { (m.id, $0) } }
        if !recipients.contains(where: { $0.0 == me }) { recipients.append((me, pair.publicKey)) }
        let wraps: [[String: Any]] = try recipients.map { id, pub in
            ["userId": id.uuidString, "wrapped": try E2E.wrap(workspaceKey: raw, for: pub, ws: ws, user: id, version: version)]
        }
        try await client.call("POST", wsPath + "/keys", ["version": version, "wraps": wraps])
        keys[version] = raw
        keyVersion = version
        forcePushAll = true
    }

    @MainActor
    func rotateKey() async throws {
        try await startNewKeyVersion()
        await sync()
    }

    /// Viewers can't share edits, so local changes are rolled back to the team's version.
    private func revertLocalEdits(_ store: Store) {
        var local = store.data
        var changed = false
        for kind in SyncKind.all {
            for (id, data) in kind.snapshot(local) {
                let synced = lastSynced["\(kind.name)/\(id.uuidString)"]
                if synced != data { kind.apply(&local, id, synced); changed = true }
            }
        }
        guard changed else { return }
        applyingRemote = true
        store.data = local
        applyingRemote = false
    }

    func viewers(ofTask id: UUID) -> [UUID] {
        online.filter { $0.viewing == "task:\(id.uuidString)" && $0.id != client.session?.userId }.map(\.id)
    }

    // MARK: - Email notifications (composed here, relayed by the server)

    private var lastContractCheck = Date.distantPast

    private func emailNotices(_ rows: [[String: Any]], previous: [String: Data], store: Store) -> [[String: Any]] {
        rows.flatMap { r -> [[String: Any]] in
            guard let kind = r["kind"] as? String, let id = r["id"] as? String, let new = r["plain"] as? Data else { return [] }
            let old = previous["\(kind)/\(id)"]
            switch kind {
            case "tasks": return EmailNotices.forTask(old: old, new: new, store: store)
            case "orders": return EmailNotices.forOrder(old: old, new: new, store: store)
            default: return []
            }
        }
    }

    private func contractNotices(_ store: Store) -> [[String: Any]] {
        guard Date().timeIntervalSince(lastContractCheck) > 6 * 3600 else { return [] }
        lastContractCheck = Date()
        return EmailNotices.forContracts(store: store, admins: team.filter { $0.role == "owner" || $0.role == "admin" }.map(\.id))
    }

    /// Failures only cost an email, never the sync.
    private func sendNotices(_ notices: [[String: Any]]) async {
        let path = wsPath + "/notify"
        for start in stride(from: 0, to: notices.count, by: 50) {
            let chunk = Array(notices[start..<min(start + 50, notices.count)])
            do { try await client.call("POST", path, ["notices": chunk]) } catch { print("MK Prod: email notices not sent: \(error.localizedDescription)") }
        }
    }

    // MARK: Notification preferences (stored on the server, per account)

    var emailEnabledOnServer = false
    var notifyPrefs: [String: Bool] = [:]

    func loadNotifyPrefs() async throws {
        let me = try await client.call("GET", "/api/me")
        emailEnabledOnServer = me["emailEnabled"] as? Bool ?? false
        notifyPrefs = ((me["user"] as? [String: Any])?["notifyPrefs"] as? [String: Any] ?? [:]).compactMapValues { $0 as? Bool }
    }

    func saveNotifyPrefs(_ prefs: [String: Bool]) async throws {
        let obj = try await client.call("PUT", "/api/me/notifications", prefs)
        notifyPrefs = (obj["notifyPrefs"] as? [String: Any] ?? [:]).compactMapValues { $0 as? Bool }
    }

    func sendTestEmail() async throws { try await client.call("POST", "/api/me/notifications/test", [:]) }

    // MARK: - Notifications for teammates' changes

    private func firstName(_ store: Store) -> String { store.me.name.split(separator: " ").first.map(String.init) ?? store.me.name }

    private func notifyRemoteTaskChange(store: Store, old: Data?, new: Data) {
        guard let t = try? JSONDecoder.cloud.decode(TaskItem.self, from: new) else { return }
        let me = store.data.currentUserId
        let before = old.flatMap { try? JSONDecoder.cloud.decode(TaskItem.self, from: $0) }
        if t.assigneeIds.contains(me) && !(before?.assigneeIds.contains(me) ?? false) {
            store.notify("You were assigned \"\(t.title)\"", taskId: t.id)
            store.postSystemNotification(title: "New assignment", body: t.title)
        }
        let oldComments = Set(before?.comments.map(\.id) ?? [])
        for c in t.comments where !oldComments.contains(c.id) && c.authorId != me {
            let author = store.member(c.authorId)?.name ?? "Someone"
            if c.assigneeId == me {
                store.notify("\(author) assigned you a comment on \"\(t.title)\"", taskId: t.id)
            } else if c.text.localizedCaseInsensitiveContains("@" + firstName(store)) {
                store.notify("\(author) mentioned you on \"\(t.title)\"", taskId: t.id)
                store.postSystemNotification(title: "\(author) mentioned you", body: c.text)
            } else if t.assigneeIds.contains(me) || t.watcherIds.contains(me) {
                store.notify("\(author) commented on \"\(t.title)\"", taskId: t.id)
            }
        }
        if let b = before, b.statusId != t.statusId, t.watcherIds.contains(me) || t.assigneeIds.contains(me) {
            store.notify("\"\(t.title)\" moved to \(store.status(of: t)?.name ?? "a new status")", taskId: t.id)
        }
    }

    private func notifyMessage(store: Store, raw: Data) {
        guard let m = try? JSONDecoder.cloud.decode(ChatMessage.self, from: raw), m.authorId != store.data.currentUserId else { return }
        if m.text.localizedCaseInsensitiveContains("@" + firstName(store)) {
            let author = store.member(m.authorId)?.name ?? "Someone"
            store.notify("\(author) mentioned you in chat", taskId: nil)
            store.postSystemNotification(title: "\(author) mentioned you", body: m.text)
        }
    }

    private func notifyOrder(store: Store, old: Data?, new: Data) {
        guard let o = try? JSONDecoder.cloud.decode(PurchaseOrder.self, from: new) else { return }
        let before = old.flatMap { try? JSONDecoder.cloud.decode(PurchaseOrder.self, from: $0) }
        guard before?.status != o.status || before?.assignedTo != o.assignedTo else { return }
        let me = store.data.currentUserId
        if before?.status != o.status {
            if store.canApprove(o, member: me) {
                store.notify("Order #\(o.number) \"\(o.title)\" is waiting for your approval", taskId: nil)
                store.postSystemNotification(title: "Approval needed", body: o.title)
            } else if o.requestedBy == me {
                store.notify("Your order #\(o.number) \"\(o.title)\" is now \(o.status)", taskId: nil)
                store.postSystemNotification(title: "Order \(o.status)", body: o.title)
            }
        }
        if o.assignedTo == me && before?.assignedTo != me {
            store.notify("Order #\(o.number) \"\(o.title)\" was assigned to you", taskId: nil)
        }
    }

    // MARK: - Persistence of sync state

    private var stateURL: URL? {
        workspaceId.map { Store.fileURL.deletingLastPathComponent().appendingPathComponent("cf-sync-\($0.uuidString).json") }
    }

    private struct State: Codable {
        var cursor: Int64
        var lastSynced: [String: Data]
    }

    private func saveState() {
        guard let url = stateURL, let raw = try? JSONEncoder().encode(State(cursor: cursor, lastSynced: lastSynced)) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? Store.writePrivate(raw, to: url)
    }

    private func loadState() {
        guard let url = stateURL, let raw = try? Data(contentsOf: url), let s = try? JSONDecoder().decode(State.self, from: raw) else { return }
        cursor = s.cursor
        lastSynced = s.lastSynced
    }
}

/// One synced collection of `AppData`. Favorites stay local; the inbox and reminders are
/// `personal`: synced like everything else but encrypted with the person's own key (E2E.personalKey),
/// so they reach all of their devices and nobody else.
struct SyncKind {
    let name: String
    let snapshot: (AppData) -> [UUID: Data]
    let apply: (inout AppData, UUID, Data?) -> Void
    let canonicalize: (Data) -> Data?
    var personal = false

    /// `defaults` fills fields another client (e.g. an older website build) left out, so the
    /// object still decodes instead of being dropped.
    static func make<T: Codable & Identifiable>(_ name: String, _ kp: WritableKeyPath<AppData, [T]>, defaults: [String: Any] = [:], personal: Bool = false) -> SyncKind where T.ID == UUID {
        let enc = JSONEncoder.cloud
        let dec = JSONDecoder.cloud
        return SyncKind(
            name: name,
            snapshot: { d in
                var out: [UUID: Data] = [:]
                for item in d[keyPath: kp] { out[item.id] = (try? enc.encode(item)).map(stableOrder) }
                return out
            },
            apply: { d, id, raw in
                if let raw, let item = try? dec.decode(T.self, from: raw) {
                    if let i = d[keyPath: kp].firstIndex(where: { $0.id == id }) { d[keyPath: kp][i] = item } else { d[keyPath: kp].append(item) }
                } else if raw == nil {
                    d[keyPath: kp].removeAll { $0.id == id }
                }
            },
            canonicalize: { raw in
                var input = raw
                if !defaults.isEmpty, var obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] {
                    for (k, v) in defaults where obj[k] == nil || obj[k] is NSNull { obj[k] = v }
                    input = (try? JSONSerialization.data(withJSONObject: obj)) ?? raw
                }
                return (try? dec.decode(T.self, from: input)).flatMap { try? enc.encode($0) }.map(stableOrder)
            },
            personal: personal
        )
    }

    /// Swift encodes `[UUID: String]` (task custom values) as a flat [key, value, …] array in
    /// hash order, which differs between launches. Sorting the pairs keeps unchanged tasks
    /// byte-identical, so they aren't re-uploaded (and re-notified) every time the app starts.
    static func stableOrder(_ raw: Data) -> Data {
        guard raw.range(of: Data(#""customValues":["#.utf8)) != nil,
              var obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any],
              let flat = obj["customValues"] as? [String], flat.count >= 4, flat.count % 2 == 0 else { return raw }
        let pairs = stride(from: 0, to: flat.count, by: 2).map { (flat[$0], flat[$0 + 1]) }.sorted { $0.0 < $1.0 }
        let sorted = pairs.flatMap { [$0.0, $0.1] }
        guard sorted != flat else { return raw }
        obj["customValues"] = sorted
        // Both the local snapshot and incoming rows pass through here, so they compare equal.
        return (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? raw
    }

    /// Three-way merge of one object's JSON. Fields only the remote changed take the remote
    /// value; fields changed locally keep the local value. Arrays of objects with ids
    /// (comments, checklists, activity, board items) are merged item by item.
    static func merge(base: Data?, local: Data, remote: Data, canonicalize: (Data) -> Data?) -> Data {
        guard let l = (try? JSONSerialization.jsonObject(with: local)) as? [String: Any],
              let r = (try? JSONSerialization.jsonObject(with: remote)) as? [String: Any] else { return remote }
        let b = base.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
        let merged = mergeObjects(base: b, local: l, remote: r)
        guard let raw = try? JSONSerialization.data(withJSONObject: merged) else { return remote }
        return canonicalize(raw) ?? remote
    }

    private static func same(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (x?, y?): return (x as AnyObject).isEqual(y)
        default: return false
        }
    }

    private static func mergeObjects(base: [String: Any], local: [String: Any], remote: [String: Any]) -> [String: Any] {
        var out = remote
        for key in Set(local.keys).union(remote.keys) {
            let lv = local[key], rv = remote[key], bv = base[key]
            if let la = lv as? [[String: Any]], let ra = rv as? [[String: Any]],
               (la + ra).allSatisfy({ $0["id"] != nil }) {
                out[key] = mergeArrays(base: bv as? [[String: Any]] ?? [], local: la, remote: ra)
            } else if !same(lv, bv) {
                out[key] = lv // changed locally (or remote unchanged): local wins for this field
            }
        }
        return out
    }

    private static func mergeArrays(base: [[String: Any]], local: [[String: Any]], remote: [[String: Any]]) -> [[String: Any]] {
        func key(_ o: [String: Any]) -> String { "\(o["id"]!)" }
        let b = Dictionary(base.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        let l = Dictionary(local.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        let r = Dictionary(remote.map { (key($0), $0) }, uniquingKeysWith: { a, _ in a })
        var out: [[String: Any]] = []
        var seen = Set<String>()
        for item in remote + local {
            let k = key(item)
            guard seen.insert(k).inserted else { continue }
            let inBase = b[k] != nil
            switch (l[k], r[k]) {
            case let (lo?, ro?): out.append(mergeObjects(base: b[k] ?? [:], local: lo, remote: ro))
            case let (lo?, nil): if !inBase { out.append(lo) }      // added locally; else deleted remotely
            case let (nil, ro?): if !inBase { out.append(ro) }      // added remotely; else deleted locally
            default: break
            }
        }
        return out
    }


    private static let now = ISO8601DateFormatter.plain.string(from: Date())

    static let all: [SyncKind] = [
        make("spaces", \.spaces, defaults: ["colorHex": "#7B68EE", "icon": "square.grid.2x2", "statuses": [], "fields": [], "isPrivate": false]),
        make("folders", \.folders),
        make("lists", \.lists, defaults: ["archived": false]),
        make("tasks", \.tasks, defaults: [
            "details": "", "priority": 0, "assigneeIds": [], "watcherIds": [], "tags": [], "recurrence": "none",
            "checklists": [], "comments": [], "attachments": [], "blockedBy": [], "linkedTaskIds": [], "customValues": [],
            "activity": [], "created": now, "updated": now, "order": 0, "archived": false, "isMilestone": false,
        ]),
        make("docs", \.docs, defaults: ["body": "", "icon": "doc.text", "created": now, "updated": now, "favorite": false]),
        make("whiteboards", \.whiteboards, defaults: ["items": [], "connectors": []]),
        make("channels", \.channels),
        make("messages", \.messages, defaults: ["date": now]),
        make("goals", \.goals, defaults: ["details": "", "colorHex": "#7B68EE", "folder": "General", "targets": []]),
        make("timeEntries", \.timeEntries, defaults: ["note": "", "billable": false]),
        make("automations", \.automations, defaults: ["enabled": true, "triggerValue": "", "actionValue": "", "runCount": 0]),
        make("dashboards", \.dashboards, defaults: ["widgets": []]),
        make("templates", \.templates, defaults: ["subtasks": []]),
        make("resources", \.resources, defaults: ["hoursPerDay": 8, "workDays": [1, 2, 3, 4, 5], "timeOff": []]),
        // Budget & procurement
        make("entities", \.entities, defaults: ["code": "", "approvalLevels": ["Requestor", "Manager"], "roles": []]),
        make("budgets", \.budgets, defaults: ["notes": "", "lineItems": [], "created": now]),
        make("orders", \.orders, defaults: [
            "number": 0, "type": "order", "supplier": "", "supplierEmail": "", "items": [], "currency": "AED", "poNumber": "",
            "lpo": "", "itemCategory": "", "isUnbudgeted": false, "requestedDate": now, "trackingNumber": "",
            "deliveryNotes": "", "notes": "", "history": [], "updated": now,
        ]),
        make("savings", \.savings, defaults: ["date": now, "description": "", "lpo": ""]),
        make("contracts", \.contracts, defaults: ["type": "", "value": 0, "autoRenew": false, "terminated": false, "contact": "", "email": "", "phone": "", "notes": ""]),
        make("catalog", \.catalog, defaults: ["category": "", "unitPrice": 0, "unit": "pcs", "supplier": "", "status": "approved", "addedDate": now]),
        make("audit", \.audit, defaults: ["details": ""]),
        make("financeSettings", \.financeSettings),
        // Personal (own-key encrypted): same shapes as the website's InboxItem / Reminder.
        make("inbox", \.inbox, defaults: ["read": false, "cleared": false], personal: true),
        make("reminders", \.reminders, defaults: ["done": false, "notified": false], personal: true),
        make("views", \.views, defaults: ["mode": "list", "groupBy": "status", "sortBy": "manual", "filter": [String: Any](), "isDefault": false, "order": 0]),
        make("privateViews", \.privateViews, defaults: ["mode": "list", "groupBy": "status", "sortBy": "manual", "filter": [String: Any](), "isDefault": false, "order": 0], personal: true),
    ]

    static let byName: [String: SyncKind] = Dictionary(uniqueKeysWithValues: all.map { ($0.name, $0) })
}
