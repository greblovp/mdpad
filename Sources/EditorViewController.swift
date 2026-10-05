import AppKit
import WebKit

/// Breaks the retain cycle between WKUserContentController and the controller.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class EditorViewController: NSViewController, WKScriptMessageHandler, WKNavigationDelegate, NSMenuItemValidation {
    private weak var document: Document?
    private var webView: WKWebView!
    private var indexURL: URL!
    private var ready = false
    private var sentPrefs = ""
    private var sourceMode = false
    private var exporter: Exporter?

    init(document: Document) {
        self.document = document
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakHandler(self), name: "md")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 860, height: 780), configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        view = webView

        NotificationCenter.default.addObserver(self, selector: #selector(prefsChanged), name: UserDefaults.didChangeNotification, object: nil)

        indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web")!
        // read access to the whole disk so relative images next to the document can load
        webView.loadFileURL(indexURL, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    // MARK: - Swift -> JS

    private func call(_ fn: String, _ args: [Any] = []) {
        guard ready,
              let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("md.\(fn)(...\(json))", completionHandler: nil)
    }

    func sendContent() { call("setContent", [document?.text ?? ""]) }

    func sendBase() { call("setBase", [documentDirectory?.path ?? ""]) }

    @objc private func prefsChanged() {
        let prefs = Prefs.forEditor
        guard let data = try? JSONSerialization.data(withJSONObject: prefs, options: .sortedKeys),
              let key = String(data: data, encoding: .utf8), key != sentPrefs else { return }
        sentPrefs = key
        call("setPrefs", [prefs])
    }

    private var documentDirectory: URL? { document?.fileURL?.deletingLastPathComponent() }

    // MARK: - JS -> Swift

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            sentPrefs = ""
            sendBase()
            prefsChanged()
            sendContent()
            debugHooks()
            if document?.text.isEmpty ?? true {
                view.window?.makeFirstResponder(webView)
                call("focus")
            }
        case "change":
            guard let text = body["text"] as? String, let doc = document else { return }
            doc.text = text
            doc.updateChangeCount(.changeDone)
        case "open":
            if let url = body["url"] as? String { open(url) }
        case "wikilink":
            if let target = body["target"] as? String { openWikilink(target) }
        case "copy":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(body["text"] as? String ?? "", forType: .string)
        case "copyRich":
            if let html = body["html"] as? String { writeRichText(html) }
        case "saveImage":
            saveImage(base64: body["data"] as? String ?? "", name: body["name"] as? String ?? "", mime: body["mime"] as? String ?? "")
        default:
            break
        }
    }

    // MARK: - Links

    private func open(_ link: String) {
        if link.hasPrefix("#") { return }
        if let url = URL(string: link), let scheme = url.scheme, !scheme.isEmpty {
            NSWorkspace.shared.open(url)
            return
        }
        let path = link.removingPercentEncoding ?? link
        let base = documentDirectory ?? FileManager.default.homeDirectoryForCurrentUser
        let target = path.hasPrefix("/") ? URL(fileURLWithPath: path) : base.appendingPathComponent(path)
        openFile(target)
    }

    private func openFile(_ url: URL) {
        if ["md", "markdown", "mdown", "txt"].contains(url.pathExtension.lowercased()) {
            NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, _ in }
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// [[Note]], [[Folder/Note]], [[Note#Heading]]: looked up from the Obsidian vault root
    /// (the nearest folder with .obsidian), or from the document's folder outside a vault.
    private func openWikilink(_ raw: String) {
        let name = raw.components(separatedBy: CharacterSet(charactersIn: "#^")).first?.trimmingCharacters(in: .whitespaces) ?? raw
        guard !name.isEmpty, let start = documentDirectory else { return }
        let fm = FileManager.default
        var root = start
        var dir = start
        while dir.path != "/" {
            if fm.fileExists(atPath: dir.appendingPathComponent(".obsidian").path) { root = dir; break }
            dir = dir.deletingLastPathComponent()
        }
        let file = (name as NSString).pathExtension.isEmpty ? name + ".md" : name
        let wanted = (file as NSString).lastPathComponent.lowercased()

        DispatchQueue.global(qos: .userInitiated).async {
            var found: URL?
            for candidate in [start.appendingPathComponent(file), root.appendingPathComponent(file)] where fm.fileExists(atPath: candidate.path) {
                found = candidate
                break
            }
            if found == nil, let walker = fm.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsPackageDescendants]) {
                for case let url as URL in walker {
                    let n = url.lastPathComponent
                    if n == ".obsidian" || n == ".git" || n == "node_modules" || n == ".trash" { walker.skipDescendants(); continue }
                    if n.lowercased() == wanted && (file.contains("/") ? url.path.lowercased().hasSuffix(file.lowercased()) : true) {
                        found = url
                        break
                    }
                }
            }
            DispatchQueue.main.async {
                if let found { self.openFile(found) }
                else { self.alert("Note not found", "No file named “\(file)” in \(root.path).") }
            }
        }
    }

    // MARK: - Clipboard

    private func writeRichText(_ html: String) {
        let styled = "<meta charset=\"utf-8\"><div style=\"font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 14px;\">\(html)</div>"
        let pb = NSPasteboard.general
        pb.clearContents()
        var plain = ""
        if let data = styled.data(using: .utf8),
           let attr = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.html,
                                                                    .characterEncoding: String.Encoding.utf8.rawValue],
                                              documentAttributes: nil) {
            plain = attr.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if let rtf = try? attr.data(from: NSRange(location: 0, length: attr.length),
                                        documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]) {
                pb.setData(rtf, forType: .rtf)
            }
        }
        pb.setString(styled, forType: .html)
        pb.setString(plain, forType: .string)
    }

    /// Pasted or dropped images go to an "assets" folder next to the document.
    private func saveImage(base64: String, name: String, mime: String) {
        guard var data = Data(base64Encoded: base64) else { return }
        guard let dir = documentDirectory else {
            alert("Save the document first", "Pasted images are stored in an “assets” folder next to the file, so the file needs a location.")
            return
        }
        var ext = (name as NSString).pathExtension.lowercased()
        if ext.isEmpty {
            ext = ["image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/tiff": "tiff"][mime] ?? "png"
        }
        if ext == "tiff" || ext == "tif", let rep = NSBitmapImageRep(data: data), let png = rep.representation(using: .png, properties: [:]) {
            data = png
            ext = "png"
        }
        let assets = dir.appendingPathComponent("assets", isDirectory: true)
        try? FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)

        var stem = ((name as NSString).deletingPathExtension)
            .replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: "/", with: "-")
        if stem.isEmpty || ["image", "pasted-image", "untitled"].contains(stem.lowercased()) {
            let f = DateFormatter()
            f.dateFormat = "yyyyMMdd-HHmmss"
            stem = "image-" + f.string(from: Date())
        }
        var fileName = "\(stem).\(ext)"
        var n = 1
        while FileManager.default.fileExists(atPath: assets.appendingPathComponent(fileName).path) {
            fileName = "\(stem)-\(n).\(ext)"
            n += 1
        }
        do {
            try data.write(to: assets.appendingPathComponent(fileName))
            call("insertImage", ["assets/\(fileName)", ""])
        } catch {
            alert("Couldn't save the image", error.localizedDescription)
        }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        if let w = view.window { a.beginSheetModal(for: w) } else { a.runModal() }
    }

    // MARK: - Navigation: the page itself never navigates away

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.isFileURL && url.path == indexURL.path { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        if url.isFileURL { openFile(url) }           // a file dropped onto the window
        else if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }

    // MARK: - PDF export and printing

    private var exportTitle: String {
        ((document?.displayName ?? "Untitled") as NSString).deletingPathExtension
    }

    private func renderForPrint(_ done: @escaping (Exporter) -> Void) {
        webView.callAsyncJavaScript("return await md.exportHTML(title)", arguments: ["title": exportTitle], in: nil, in: .page) { [weak self] result in
            guard let self, case .success(let value) = result, let html = value as? String else {
                if case .failure(let error) = result { self?.alert("Couldn't prepare the document", error.localizedDescription) }
                return
            }
            let exporter = Exporter(html: html)
            self.exporter = exporter
            exporter.load { done(exporter) }
        }
    }

    @objc func exportPDF(_ sender: Any?) {
        guard let window = view.window else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = exportTitle + ".pdf"
        if let dir = documentDirectory { panel.directoryURL = dir }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.exportPDF(to: url, reveal: true)
        }
    }

    private func exportPDF(to url: URL, reveal: Bool) {
        renderForPrint { [weak self] exporter in
            guard let self, let window = self.view.window else { return }
            exporter.run(on: window, saveTo: url) { ok in
                self.exporter = nil
                if ok && reveal { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            }
        }
    }

    @objc func printMarkdown(_ sender: Any?) {
        renderForPrint { [weak self] exporter in
            guard let self, let window = self.view.window else { return }
            exporter.run(on: window, saveTo: nil) { _ in self.exporter = nil }
        }
    }

    // MARK: - Debug hooks (environment variables, used for automated checks)

    private func debugHooks() {
        let env = ProcessInfo.processInfo.environment
        if let js = env["MDPAD_DEBUG_JS"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.webView.evaluateJavaScript(js) }
        }
        if let pdf = env["MDPAD_EXPORT_PDF"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.exportPDF(to: URL(fileURLWithPath: pdf), reveal: false) }
        }
        if let out = env["MDPAD_SNAPSHOT"] {
            let delay = Double(env["MDPAD_SNAPSHOT_DELAY"] ?? "") ?? 1.5
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.webView.takeSnapshot(with: nil) { image, _ in
                    guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                          let png = rep.representation(using: .png, properties: [:]) else { return }
                    try? png.write(to: URL(fileURLWithPath: out))
                }
            }
        }
    }

    // MARK: - Menu actions

    @objc func mdUndo(_ sender: Any?) { call("undo") }
    @objc func mdRedo(_ sender: Any?) { call("redo") }
    @objc func mdSelectAll(_ sender: Any?) { call("selectAll") }
    @objc func mdFind(_ sender: Any?) { call("find") }
    @objc func mdBold(_ sender: Any?) { call("bold") }
    @objc func mdItalic(_ sender: Any?) { call("italic") }
    @objc func mdStrike(_ sender: Any?) { call("strike") }
    @objc func mdCode(_ sender: Any?) { call("code") }
    @objc func mdLink(_ sender: Any?) { call("link") }
    @objc func mdHeading(_ sender: NSMenuItem) { call("heading", [sender.tag]) }
    @objc func mdCopyRich(_ sender: Any?) { call("copyRich") }
    @objc func mdInsertTable(_ sender: Any?) { call("insertTable") }
    @objc func mdFormatTable(_ sender: Any?) { call("formatTable") }
    @objc func mdAddColumn(_ sender: Any?) { call("addColumn") }
    @objc func mdDeleteColumn(_ sender: Any?) { call("deleteColumn") }
    @objc func mdDeleteRow(_ sender: Any?) { call("deleteRow") }

    @objc func mdPastePlain(_ sender: Any?) {
        if let text = NSPasteboard.general.string(forType: .string) { call("insertText", [text]) }
    }

    @objc func mdToggleSource(_ sender: Any?) {
        sourceMode.toggle()
        call("toggleSource")
    }

    @objc func showInFinder(_ sender: Any?) {
        if let url = document?.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(mdToggleSource(_:)) { item.state = sourceMode ? .on : .off }
        if item.action == #selector(showInFinder(_:)) { return document?.fileURL != nil }
        return true
    }
}
