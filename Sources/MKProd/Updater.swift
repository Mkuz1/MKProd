import SwiftUI
import AppKit

/// Keeps the Mac app current, like the "Update now" bar on the website, Windows and Android:
/// the server's `/version.json` says which version is live; once the matching Mac release exists
/// on GitHub, the sidebar offers **Update now**. Installing downloads the release zip, swaps the
/// app bundle in place after the app quits, and relaunches it.
@Observable
final class Updater {
    static let shared = Updater()
    static let repo = "Mkuz1/MKProd"

    enum State: Equatable { case idle, downloading(Double), installing, failed(String) }

    /// Newest version available for download, when newer than the running app.
    private(set) var available: String?
    private(set) var state: State = .idle
    private(set) var lastCheck: Date?

    let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    private var timer: Timer?
    private var checking = false

    private init() {}

    /// Starts periodic checks (every 30 minutes and whenever the app comes to the front).
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 30 * 60, repeats: true) { [weak self] _ in self?.check() }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, self.lastCheck.map({ Date().timeIntervalSince($0) > 120 }) ?? true else { return }
            self.check()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.check() }
    }

    var canInstallInPlace: Bool {
        let bundle = Bundle.main.bundleURL
        return bundle.pathExtension == "app" && FileManager.default.isWritableFile(atPath: bundle.deletingLastPathComponent().path)
    }

    func releasePage(_ v: String) -> URL { URL(string: "https://github.com/\(Updater.repo)/releases/tag/mac-v\(v)")! }
    private func zipURL(_ v: String) -> URL { URL(string: "https://github.com/\(Updater.repo)/releases/download/mac-v\(v)/MK-Prod-\(v)-mac.zip")! }

    /// Asks the server which version is live, then confirms the Mac build of it is downloadable.
    func check(server: String? = nil) {
        guard !checking else { return }
        checking = true
        let saved = Store.defaults.data(forKey: "cloudServer").flatMap { try? JSONDecoder().decode(CloudConfig.self, from: $0) }
        let base = server ?? (saved?.isComplete == true ? saved!.url : CloudSync.defaultServer)
        Task { @MainActor in
            defer { checking = false; lastCheck = Date() }
            guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/version.json?t=\(Int(Date().timeIntervalSince1970))") else { return }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let v = obj["version"] as? String, Updater.isNewer(v, than: currentVersion) else { available = nil; return }
                var head = URLRequest(url: zipURL(v)); head.httpMethod = "HEAD"
                let (_, res) = try await URLSession.shared.data(for: head)
                available = (res as? HTTPURLResponse)?.statusCode == 200 ? v : nil
            } catch { /* offline or GitHub unreachable: try again later */ }
        }
    }

    /// Downloads the release, replaces this app bundle once it has quit, and relaunches.
    func install() {
        guard let v = available, case .idle = state else { return }
        guard canInstallInPlace else { NSWorkspace.shared.open(releasePage(v)); return }
        state = .downloading(0)
        Task { @MainActor in
            do {
                let work = FileManager.default.temporaryDirectory.appendingPathComponent("mkprod-update-\(v)", isDirectory: true)
                try? FileManager.default.removeItem(at: work)
                try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
                let zip = work.appendingPathComponent("app.zip")
                let (tmp, res) = try await URLSession.shared.download(from: zipURL(v), delegate: nil)
                guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw CloudError(message: "Download failed (\((res as? HTTPURLResponse)?.statusCode ?? 0))") }
                try FileManager.default.moveItem(at: tmp, to: zip)
                state = .installing
                try run("/usr/bin/ditto", ["-xk", zip.path, work.path])
                let newApp = work.appendingPathComponent("MK Prod.app")
                guard FileManager.default.fileExists(atPath: newApp.appendingPathComponent("Contents/MacOS").path) else { throw CloudError(message: "The download did not contain the app") }
                // Replace the bundle only after this process has exited, then relaunch.
                let script = work.appendingPathComponent("install.sh")
                let target = Bundle.main.bundleURL.path
                try """
                #!/bin/bash
                APP="$1"; NEW="$2"; PID="$3"
                for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
                rm -rf "$APP.old"
                mv "$APP" "$APP.old" || exit 1
                if ditto "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi
                xattr -dr com.apple.quarantine "$APP" 2>/dev/null
                open "$APP"
                """.write(to: script, atomically: true, encoding: .utf8)
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/bash")
                p.arguments = [script.path, target, newApp.path, String(ProcessInfo.processInfo.processIdentifier)]
                try p.run()
                NSApp.terminate(nil)
            } catch {
                state = .failed(error.localizedDescription)
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in if case .failed = self?.state { self?.state = .idle } }
            }
        }
    }

    private func run(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 { throw CloudError(message: "\(URL(fileURLWithPath: tool).lastPathComponent) failed (\(p.terminationStatus))") }
    }

    /// 1.10.0 is newer than 1.9.3; unknown parts count as 0.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}

/// Sidebar footer button: shows up only when a newer release is ready.
struct UpdateButton: View {
    @State private var updater = Updater.shared

    var body: some View {
        if let v = updater.available {
            Button {
                updater.install()
            } label: {
                switch updater.state {
                case .idle: Label("Update to \(v)", systemImage: "arrow.down.circle.fill")
                case .downloading: Label("Downloading…", systemImage: "arrow.down.circle")
                case .installing: Label("Installing…", systemImage: "gearshape.arrow.triangle.2.circlepath")
                case .failed(let m): Label(m, systemImage: "exclamationmark.triangle").lineLimit(1)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(updater.state != .idle)
            .help(updater.canInstallInPlace ? "Download MK Prod \(v) from GitHub, replace this app and relaunch" : "Opens the GitHub release page: this app is in a folder that can't be replaced automatically")
        }
    }
}
