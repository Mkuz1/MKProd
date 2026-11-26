import SwiftUI
import UIKit
import WebKit

enum AppConfig {
    static let appURL = URL(string: "https://mkprod.mk-uz02.workers.dev/")!
    static var host: String { appURL.host ?? "" }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }
}

struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Owns the web view and implements everything WKWebView leaves to the app.
final class WebModel: NSObject, ObservableObject {
    @Published var loaded = false
    @Published var offline = false
    let webView: WKWebView
    /// Ordinary (non-blob) downloads in progress, by download, with where they are being saved.
    fileprivate var pendingDownloads: [ObjectIdentifier: URL] = [:]

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // keeps the sign-in between launches
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "MKProdiOS/\(AppConfig.version)"
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: WebModel.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = content
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        content.add(WeakScriptHandler(self), name: "mkprod")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true   // swipe back between pages
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never   // the page handles safe areas
        webView.scrollView.keyboardDismissMode = .interactive
        webView.load(URLRequest(url: AppConfig.appURL))
    }

    /// mkprod://approvals, mkprod://list/<id>, or a full https link to the site.
    func open(_ url: URL) {
        var target = AppConfig.appURL
        if url.scheme == "mkprod" {
            let route = ((url.host ?? "") + url.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !route.isEmpty, let u = URL(string: "#/" + route, relativeTo: AppConfig.appURL) { target = u.absoluteURL }
        } else if url.host == AppConfig.host {
            target = url
        }
        offline = false
        webView.load(URLRequest(url: target))
    }

    func retry() {
        offline = false
        if webView.url == nil { webView.load(URLRequest(url: AppConfig.appURL)) } else { webView.reload() }
    }

    // MARK: Downloads

    /// Saves a file from the page (Excel exports, decrypted attachments) and offers the share
    /// sheet: Save to Files, AirDrop, Mail, Teams…
    fileprivate func share(name: String, data: Data) {
        let safe = name.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespaces)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(safe.isEmpty ? "download" : safe)
        do { try data.write(to: file, options: .atomic) } catch { return alert("Could not save \(safe).") }
        present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
    }

    fileprivate func present(_ vc: UIViewController) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        if let pop = vc.popoverPresentationController {   // iPad: anchor the share sheet
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        top.present(vc, animated: true)
    }

    private func alert(_ message: String) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a)
    }

    /// Downloads of blob:/data: links (how the site saves files) are read in the page and handed
    /// to the app, because WKWebView doesn't save them by itself.
    static let bridgeScript = """
    (function () {
      if (window.MKProdIOS) return;
      window.MKProdIOS = { platform: 'ios' };
      const blobs = new Map();
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (obj) { const u = create(obj); if (obj instanceof Blob) blobs.set(u, obj); return u; };
      function post(blob, name) {
        const r = new FileReader();
        r.onload = function () { window.webkit.messageHandlers.mkprod.postMessage({ type: 'download', name: name || 'download', data: String(r.result).split(',')[1] || '' }); };
        r.readAsDataURL(blob);
      }
      async function save(a) {
        const href = a.href || '';
        try { const blob = blobs.get(href) || await (await fetch(href)).blob(); post(blob, a.getAttribute('download') || a.download || 'download'); }
        catch (e) { window.webkit.messageHandlers.mkprod.postMessage({ type: 'error', message: 'Download failed: ' + e.message }); }
      }
      const isFile = (a) => /^(blob|data):/.test(a.href || '');
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (isFile(this)) { save(this); return; } return click.call(this); };
      document.addEventListener('click', function (e) {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a && isFile(a)) { e.preventDefault(); e.stopPropagation(); save(a); }
      }, true);
    })();
    """
}

// MARK: - Navigation

extension WebModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
        if ["about", "blob", "data"].contains(scheme) || url.host == AppConfig.host { return decisionHandler(.allow) }
        // Everything else (GitHub, supplier sites, mailto:, tel:) opens in Safari / the right app.
        if action.targetFrame?.isMainFrame ?? true { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        offline = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }   // frame load interrupted (a download)
        if e.domain == NSURLErrorDomain { offline = true }
    }

    /// iOS may stop a background web view to save memory: reload instead of showing a blank page.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

extension WebModel: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: file)
        pendingDownloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        present(UIActivityViewController(activityItems: [file], applicationActivities: nil))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloads.removeValue(forKey: ObjectIdentifier(download))
        alert("Download failed: \(error.localizedDescription)")
    }
}

// MARK: - Dialogs and new windows

extension WebModel: WKUIDelegate {
    /// target=_blank / window.open: our pages load here, anything else opens outside.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == AppConfig.host { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    // WKWebView shows no alert(), confirm() or prompt() on its own; the app uses all three.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText; $0.clearButtonMode = .whileEditing }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text ?? "") })
        present(a)
    }
}

// MARK: - Messages from the page

extension WebModel: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "download":
            guard let b64 = body["data"] as? String, let data = Data(base64Encoded: b64) else { return alert("Download failed.") }
            share(name: body["name"] as? String ?? "download", data: data)
        case "error":
            alert(body["message"] as? String ?? "Something went wrong.")
        default: break
        }
    }
}

/// WKUserContentController keeps its handlers strongly; this breaks the cycle with WebModel.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}
