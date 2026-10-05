import AppKit

enum Prefs {
    static let defaultFontSize = 16.0
    private static var d: UserDefaults { .standard }

    static var fontSize: Double {
        get { let v = d.double(forKey: "fontSize"); return v > 0 ? v : defaultFontSize }
        set { d.set(min(max(newValue, 10), 32), forKey: "fontSize") }
    }
    static var showOutline: Bool {
        get { d.bool(forKey: "showOutline") }
        set { d.set(newValue, forKey: "showOutline") }
    }

    /// Everything the page needs, in one object for `md.setPrefs`.
    static var forEditor: [String: Any] {
        [
            "fontSize": fontSize,
            "font": d.string(forKey: "fontFamily") ?? "sans",
            "width": d.string(forKey: "columnWidth") ?? "medium",
            "outline": showOutline,
            "spellcheck": d.bool(forKey: "spellcheck"),
        ]
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var settingsWindow: NSWindow?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { true }

    @objc func zoomIn(_ sender: Any?) { Prefs.fontSize += 1 }
    @objc func zoomOut(_ sender: Any?) { Prefs.fontSize -= 1 }
    @objc func zoomReset(_ sender: Any?) { Prefs.fontSize = Prefs.defaultFontSize }
    @objc func toggleOutline(_ sender: Any?) { Prefs.showOutline.toggle() }

    @objc func showSettings(_ sender: Any?) {
        if settingsWindow == nil {
            let w = NSWindow(contentViewController: makeSettingsController())
            w.title = "Settings"
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            w.center()
            settingsWindow = w
        }
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleOutline(_:)) { item.state = Prefs.showOutline ? .on : .off }
        return true
    }

    // MARK: - Menu

    private func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, tag: Int = 0) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.tag = tag
        return i
    }

    private func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        items.forEach { menu.addItem($0) }
        top.submenu = menu
        return top
    }

    private func buildMainMenu() -> NSMenu {
        typealias E = EditorViewController
        let main = NSMenu()

        main.addItem(submenu("MDPad", [
            item("About MDPad", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Settings…", #selector(showSettings(_:)), ","),
            .separator(),
            item("Hide MDPad", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit MDPad", #selector(NSApplication.terminate(_:)), "q"),
        ]))

        let recent = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "Open Recent")
        recentMenu.addItem(item("Clear Menu", #selector(NSDocumentController.clearRecentDocuments(_:))))
        recentMenu.perform(NSSelectorFromString("_setMenuName:"), with: "NSRecentDocumentsMenu")
        recent.submenu = recentMenu

        main.addItem(submenu("File", [
            item("New", #selector(NSDocumentController.newDocument(_:)), "n"),
            item("Open…", #selector(NSDocumentController.openDocument(_:)), "o"),
            recent,
            .separator(),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
            item("Save", #selector(NSDocument.save(_:)), "s"),
            item("Duplicate", #selector(NSDocument.duplicate(_:)), "s", [.command, .shift]),
            item("Rename…", #selector(NSDocument.rename(_:))),
            item("Move To…", #selector(NSDocument.move(_:))),
            item("Revert to Saved", #selector(NSDocument.revertToSaved(_:))),
            .separator(),
            item("Export as PDF…", #selector(E.exportPDF(_:)), "e", [.command, .shift]),
            item("Print…", #selector(E.printMarkdown(_:)), "p"),
            .separator(),
            item("Show in Finder", #selector(E.showInFinder(_:)), "r", [.command, .shift]),
        ]))

        main.addItem(submenu("Edit", [
            item("Undo", #selector(E.mdUndo(_:)), "z"),
            item("Redo", #selector(E.mdRedo(_:)), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Copy as Rich Text", #selector(E.mdCopyRich(_:)), "c", [.command, .shift]),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste as Plain Text", #selector(E.mdPastePlain(_:)), "v", [.command, .shift, .option]),
            item("Select All", #selector(E.mdSelectAll(_:)), "a"),
            .separator(),
            item("Find…", #selector(E.mdFind(_:)), "f"),
        ]))

        let table = submenu("Table", [
            item("Insert Table", #selector(E.mdInsertTable(_:)), "t", [.command, .option]),
            item("Format Table", #selector(E.mdFormatTable(_:))),
            .separator(),
            item("Add Column", #selector(E.mdAddColumn(_:))),
            item("Delete Column", #selector(E.mdDeleteColumn(_:))),
            item("Delete Row", #selector(E.mdDeleteRow(_:))),
        ])

        main.addItem(submenu("Format", [
            item("Bold", #selector(E.mdBold(_:)), "b"),
            item("Italic", #selector(E.mdItalic(_:)), "i"),
            item("Strikethrough", #selector(E.mdStrike(_:)), "x", [.command, .shift]),
            item("Inline Code", #selector(E.mdCode(_:)), "e"),
            item("Link", #selector(E.mdLink(_:)), "k"),
            .separator(),
            item("Heading 1", #selector(E.mdHeading(_:)), "1", [.command, .option], tag: 1),
            item("Heading 2", #selector(E.mdHeading(_:)), "2", [.command, .option], tag: 2),
            item("Heading 3", #selector(E.mdHeading(_:)), "3", [.command, .option], tag: 3),
            item("Plain Text", #selector(E.mdHeading(_:)), tag: 0),
            .separator(),
            table,
        ]))

        main.addItem(submenu("View", [
            item("Show Outline", #selector(toggleOutline(_:)), "o", [.command, .shift]),
            item("Show Markdown Source", #selector(E.mdToggleSource(_:)), "/"),
            .separator(),
            item("Zoom In", #selector(zoomIn(_:)), "="),
            item("Zoom Out", #selector(zoomOut(_:)), "-"),
            item("Actual Size", #selector(zoomReset(_:)), "0"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]))

        let window = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        main.addItem(window)
        NSApp.windowsMenu = window.submenu

        return main
    }
}
