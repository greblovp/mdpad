import AppKit
import WebKit

/// Lays out the rendered document in an offscreen web view and prints it,
/// either through the print panel or straight into a PDF file.
final class Exporter: NSObject, WKNavigationDelegate {
    private let html: String
    private let webView: WKWebView
    private var onLoad: (() -> Void)?
    private var onDone: ((Bool) -> Void)?
    private var file: URL?

    init(html: String) {
        self.html = html
        // ~A4 text width at 72 dpi
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 495, height: 700))
        super.init()
        webView.navigationDelegate = self
    }

    func load(_ done: @escaping () -> Void) {
        onLoad = done
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("MDPadExport", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(UUID().uuidString + ".html")
        self.file = file
        do {
            try html.write(to: file, atomically: true, encoding: .utf8)
            webView.loadFileURL(file, allowingReadAccessTo: URL(fileURLWithPath: "/"))
        } catch {
            onLoad = nil
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // give images a moment to decode before laying out pages
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.onLoad?()
            self?.onLoad = nil
        }
    }

    func run(on window: NSWindow, saveTo url: URL?, done: @escaping (Bool) -> Void) {
        onDone = done
        let info = (NSPrintInfo.shared.copy() as! NSPrintInfo)
        info.paperSize = NSSize(width: 595, height: 842)
        info.topMargin = 0
        info.bottomMargin = 0
        info.leftMargin = 0
        info.rightMargin = 0
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        if let url {
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
        }
        let op = webView.printOperation(with: info)
        op.showsPrintPanel = url == nil
        op.showsProgressPanel = false
        op.jobTitle = file.map { _ in window.title } ?? ""
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printDidRun(_:success:contextInfo:)), contextInfo: nil)
    }

    @objc private func printDidRun(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        if let file { try? FileManager.default.removeItem(at: file) }
        onDone?(success)
        onDone = nil
    }
}
