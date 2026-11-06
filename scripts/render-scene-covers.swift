// Build-time renderer. Runtime users need only the generated PNG assets.
import AppKit
import Foundation

struct Job: Decodable {
    let input: String?
    let output: String
    let colors: [String]
    let kind: String?
}
func color(_ hex: String) -> NSColor {
    let value = UInt32(hex, radix: 16)!
    return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                   green: CGFloat((value >> 8) & 255) / 255,
                   blue: CGFloat(value & 255) / 255, alpha: 1)
}
let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
for job in jobs {
    guard job.colors.count == 2,
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 320, pixelsHigh: 320, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap),
          let gradient = NSGradient(starting: color(job.colors[0]), ending: color(job.colors[1])) else {
        throw NSError(domain: "SceneRenderer", code: 1)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    gradient.draw(in: NSRect(x: 0, y: 0, width: 320, height: 320), angle: -35)
    NSColor.white.withAlphaComponent(0.07).setFill()
    NSBezierPath(ovalIn: NSRect(x: 190, y: 180, width: 220, height: 220)).fill()
    NSBezierPath(ovalIn: NSRect(x: -110, y: -100, width: 270, height: 270)).fill()
    if let input = job.input {
        guard let image = NSImage(contentsOfFile: input) else { throw NSError(domain: "SceneRenderer", code: 2) }
        image.draw(in: NSRect(x: 62, y: 62, width: 196, height: 196), from: .zero, operation: .sourceOver, fraction: 1)
    } else {
        NSColor.white.setStroke()
        let shape = NSBezierPath()
        shape.lineWidth = 12
        shape.lineCapStyle = .round
        shape.lineJoinStyle = .round
        if job.kind == "familiar" {
            shape.move(to: NSPoint(x: 160, y: 98))
            shape.curve(to: NSPoint(x: 85, y: 183), controlPoint1: NSPoint(x: 100, y: 139), controlPoint2: NSPoint(x: 85, y: 155))
            shape.curve(to: NSPoint(x: 160, y: 204), controlPoint1: NSPoint(x: 85, y: 229), controlPoint2: NSPoint(x: 135, y: 237))
            shape.curve(to: NSPoint(x: 235, y: 183), controlPoint1: NSPoint(x: 185, y: 237), controlPoint2: NSPoint(x: 235, y: 229))
            shape.curve(to: NSPoint(x: 160, y: 98), controlPoint1: NSPoint(x: 235, y: 155), controlPoint2: NSPoint(x: 220, y: 139))
        } else {
            shape.move(to: NSPoint(x: 160, y: 244))
            shape.curve(to: NSPoint(x: 244, y: 160), controlPoint1: NSPoint(x: 172, y: 181), controlPoint2: NSPoint(x: 181, y: 172))
            shape.curve(to: NSPoint(x: 160, y: 76), controlPoint1: NSPoint(x: 181, y: 148), controlPoint2: NSPoint(x: 172, y: 139))
            shape.curve(to: NSPoint(x: 76, y: 160), controlPoint1: NSPoint(x: 148, y: 139), controlPoint2: NSPoint(x: 139, y: 148))
            shape.curve(to: NSPoint(x: 160, y: 244), controlPoint1: NSPoint(x: 139, y: 172), controlPoint2: NSPoint(x: 148, y: 181))
            shape.close()
        }
        shape.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "SceneRenderer", code: 3) }
    try data.write(to: URL(fileURLWithPath: job.output), options: .withoutOverwriting)
}
