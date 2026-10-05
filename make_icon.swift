import AppKit
// Renders a 1024px app icon: dark teal rounded square with "M↓".
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let inset = 100.0
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let path = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(srgbRed: 0.02, green: 0.36, blue: 0.45, alpha: 1),
           ending: NSColor(srgbRed: 0.0, green: 0.22, blue: 0.30, alpha: 1))!.draw(in: path, angle: -90)
let para = NSMutableParagraphStyle(); para.alignment = .center
let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 400, weight: .bold),
    .foregroundColor: NSColor.white,
    .paragraphStyle: para,
]
let s = NSAttributedString(string: "M↓", attributes: attrs)
let h = s.size().height
s.draw(in: NSRect(x: inset, y: (size - h) / 2 - 10, width: size - 2 * inset, height: h))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
