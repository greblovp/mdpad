import AppKit

@objc(Document)
final class Document: NSDocument {
    var text = ""
    weak var editor: EditorViewController?

    override class var autosavesInPlace: Bool { true }

    override var fileURL: URL? {
        didSet { editor?.sendBase() }
    }

    override func makeWindowControllers() {
        let vc = EditorViewController(document: self)
        editor = vc
        let window = NSWindow(contentViewController: vc)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 860, height: 780))
        window.minSize = NSSize(width: 420, height: 300)
        window.tabbingMode = .preferred
        window.tabbingIdentifier = "MDPadDocument"
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x1e / 255, green: 0x1f / 255, blue: 0x22 / 255, alpha: 1)
                : .white
        }
        let wc = NSWindowController(window: window)
        wc.shouldCascadeWindows = true
        addWindowController(wc)
        if NSApp.windows.filter({ $0.isVisible && $0 !== window }).isEmpty { window.center() }
    }

    override func data(ofType typeName: String) throws -> Data {
        Data(text.utf8)
    }

    override func read(from data: Data, ofType typeName: String) throws {
        text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .windowsCP1251)
            ?? String(decoding: data, as: UTF8.self)
        if Thread.isMainThread { editor?.sendContent() }
        else { DispatchQueue.main.async { self.editor?.sendContent() } }
    }

    // Reload silently when another program (an agent, git, Sublime) rewrites the file
    // and there are no unsaved edits here.
    override func presentedItemDidChange() {
        super.presentedItemDidChange()
        DispatchQueue.main.async { self.reloadIfChangedOnDisk() }
    }

    private func reloadIfChangedOnDisk() {
        guard let url = fileURL, !isDocumentEdited,
              let onDisk = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
              let known = fileModificationDate, onDisk > known,
              let type = fileType else { return }
        try? revert(toContentsOf: url, ofType: type)
    }
}
