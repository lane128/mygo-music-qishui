// Rebuild with: swift scripts/render-history-cover.swift assets/history.png
import AppKit
import Foundation

let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 320, pixelsHigh: 320, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)!
NSColor(srgbRed: 0.25, green: 0.23, blue: 0.30, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 320, height: 320).fill()
NSColor(srgbRed: 0.91, green: 0.88, blue: 0.95, alpha: 1).setStroke()
let circle = NSBezierPath()
circle.lineWidth = 11
circle.lineCapStyle = .round
circle.appendArc(withCenter: NSPoint(x: 160, y: 160), radius: 81, startAngle: 155, endAngle: -137, clockwise: true)
circle.stroke()
let hands = NSBezierPath()
hands.lineWidth = 11
hands.lineCapStyle = .round
hands.lineJoinStyle = .round
hands.move(to: NSPoint(x: 160, y: 213))
hands.line(to: NSPoint(x: 160, y: 160))
hands.line(to: NSPoint(x: 200, y: 137))
hands.move(to: NSPoint(x: 75, y: 222))
hands.line(to: NSPoint(x: 75, y: 185))
hands.line(to: NSPoint(x: 112, y: 185))
hands.stroke()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .withoutOverwriting)
