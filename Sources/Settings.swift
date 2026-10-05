import AppKit
import SwiftUI

struct SettingsView: View {
    @AppStorage("fontFamily") private var fontFamily = "sans"
    @AppStorage("fontSize") private var fontSize = Prefs.defaultFontSize
    @AppStorage("columnWidth") private var columnWidth = "medium"
    @AppStorage("showOutline") private var showOutline = false
    @AppStorage("spellcheck") private var spellcheck = false

    var body: some View {
        Form {
            Section("Text") {
                Picker("Font", selection: $fontFamily) {
                    Text("System (San Francisco)").tag("sans")
                    Text("Serif (New York)").tag("serif")
                    Text("Monospace").tag("mono")
                }
                LabeledContent("Size") {
                    HStack {
                        Slider(value: $fontSize, in: 12...26, step: 1)
                        Text("\(Int(fontSize)) pt").monospacedDigit().frame(width: 44, alignment: .trailing)
                    }
                }
                Picker("Text width", selection: $columnWidth) {
                    Text("Narrow").tag("narrow")
                    Text("Medium").tag("medium")
                    Text("Wide").tag("wide")
                    Text("Full window").tag("full")
                }
            }
            Section("Editor") {
                Toggle("Show outline sidebar", isOn: $showOutline)
                Toggle("Check spelling while typing", isOn: $spellcheck)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 340)
    }
}

func makeSettingsController() -> NSViewController {
    NSHostingController(rootView: SettingsView())
}
