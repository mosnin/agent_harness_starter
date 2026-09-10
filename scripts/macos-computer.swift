// Hades native computer bridge. JSON over stdin/stdout; no shell interpreter.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

struct BridgeError: Error { let message: String }
func fail(_ message: String) throws -> Never { throw BridgeError(message: message) }
func attribute(_ node: AXUIElement, _ key: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, key as CFString, &value) == .success ? value : nil
}
func children(_ node: AXUIElement) -> [AXUIElement] { attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func string(_ node: AXUIElement, _ key: String) -> String { (attribute(node, key) as? String ?? "").prefix(600).description }
func fingerprint(_ node: AXUIElement) -> String { [string(node,kAXRoleAttribute),string(node,kAXSubroleAttribute),string(node,kAXTitleAttribute),string(node,kAXIdentifierAttribute)].joined(separator:"|") }
func bounds(_ node: AXUIElement) -> [String: Double]? {
    var point = CGPoint.zero, size = CGSize.zero
    guard let p = attribute(node,kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(node,kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID(),
          AXValueGetValue(p as! AXValue,.cgPoint,&point), AXValueGetValue(s as! AXValue,.cgSize,&size) else { return nil }
    return ["x":point.x,"y":point.y,"width":size.width,"height":size.height]
}
func apps() -> [[String:Any]] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map {
        ["pid":Int($0.processIdentifier),"bundle":$0.bundleIdentifier ?? "","name":$0.localizedName ?? ""]
    }
}
func target(_ request: [String:Any], foreground: Bool = true) throws -> NSRunningApplication {
    guard let pid = request["pid"] as? Int, let app = NSRunningApplication(processIdentifier:pid_t(pid)),
          let bundle = request["bundle"] as? String, app.bundleIdentifier == bundle else { try fail("Target app changed. Observe again.") }
    if foreground && request["returnFromApproval"] as? Bool == true && NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "ai.hades.desktop" {
        _ = app.activate(options:[])
        for _ in 0..<40 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { break }
            RunLoop.current.run(until:Date(timeIntervalSinceNow:0.025))
        }
    }
    if foreground && NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier { try fail("The foreground app changed. Observe again before acting.") }
    return app
}
func root(_ app: NSRunningApplication) -> AXUIElement { AXUIElementCreateApplication(app.processIdentifier) }
func windowIdentity(_ app: NSRunningApplication) -> String {
    let ax = root(app)
    guard let value = attribute(ax,kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return "none" }
    let window = value as! AXUIElement
    let rect = bounds(window) ?? [:]
    let values = ["x","y","width","height"].map { String(rect[$0] ?? -1) }.joined(separator:",")
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    let id = windows.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? Int ?? -1
    return "\(id)|" + fingerprint(window) + "|" + values
}
func focusedIdentity(_ app: NSRunningApplication) -> String {
    guard let value = attribute(root(app),kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return "none" }
    let element = value as! AXUIElement
    let rect = bounds(element) ?? [:]
    let geometry = ["x","y","width","height"].map { String(rect[$0] ?? -1) }.joined(separator:",")
    let text = string(element,kAXSubroleAttribute).lowercased().contains("secure") ? "[secure]" : string(element,kAXValueAttribute)
    return fingerprint(element) + "|" + geometry + "|" + text
}
func element(_ request: [String:Any], app: NSRunningApplication) throws -> AXUIElement {
    guard let path = request["path"] as? [Int], path.count <= 15 else { try fail("Invalid element reference") }
    var node = root(app)
    for index in path { let list = children(node); guard index >= 0 && index < list.count else { try fail("Element no longer exists. Observe again.") }; node = list[index] }
    guard attribute(node,kAXEnabledAttribute) as? Bool == true else { try fail("Element is disabled or its enabled state is unknown") }
    guard let expected = request["fingerprint"] as? String, fingerprint(node) == expected else { try fail("Element changed. Observe again.") }
    if let expected = request["bounds"] as? [String:Double], bounds(node) != expected { try fail("Element moved. Observe again.") }
    return node
}
func emitKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource:nil, virtualKey:code, keyDown:true)
    let up = CGEvent(keyboardEventSource:nil, virtualKey:code, keyDown:false)
    down?.flags = flags; up?.flags = flags; down?.post(tap:.cghidEventTap); up?.post(tap:.cghidEventTap)
}
// Pixel-only operations never inspect the desktop or require OS capture access.
// Masks use normalized top-left image coordinates, independent of AppKit points.
func spatialPixels(_ value: Any?) throws -> (CGImage, CGContext) {
    guard let url = value as? String, url.utf8.count <= 8_000_000,
          let comma = url.firstIndex(of: ","), url.hasPrefix("data:image/"),
          let data = Data(base64Encoded:String(url[url.index(after:comma)...])),
          let source = CGImageSourceCreateWithData(data as CFData,nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 16_000_000,
          let image = CGImageSourceCreateImageAtIndex(source,0,nil),
          let context = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,
            space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { try fail("Invalid or oversized spatial image") }
    context.draw(image,in:CGRect(x:0,y:0,width:width,height:height))
    return (image,context)
}
func spatialImageOperation(_ request: [String:Any]) throws -> [String:Any] {
    guard let images = request["images"] as? [String], images.count >= 1, images.count <= 2 else { try fail("Invalid image operation") }
    let (image,context) = try spatialPixels(images[0])
    if request["operation"] as? String == "redact" {
        guard images.count == 1, let masks = request["masks"] as? [[String:Double]], masks.count <= 32 else { try fail("Invalid image masks") }
        context.setFillColor(CGColor(gray:0,alpha:1))
        for mask in masks {
            guard let x=mask["x"],let y=mask["y"],let w=mask["width"],let h=mask["height"],
                  [x,y,w,h].allSatisfy({$0.isFinite}), x>=0,y>=0,w>0,h>0,x+w<=1,y+h<=1 else { try fail("Mask is outside image bounds") }
            let left=floor(x*Double(image.width)), top=floor(y*Double(image.height))
            let right=ceil((x+w)*Double(image.width)), bottom=ceil((y+h)*Double(image.height))
            context.fill(CGRect(x:left,y:Double(image.height)-bottom,width:right-left,height:bottom-top))
        }
        guard let result=context.makeImage() else { try fail("Image redaction failed") }
        let data=NSMutableData()
        guard let destination=CGImageDestinationCreateWithData(data,UTType.png.identifier as CFString,1,nil) else { try fail("Image encoding failed") }
        CGImageDestinationAddImage(destination,result,nil)
        guard CGImageDestinationFinalize(destination), data.length<=6_000_000 else { try fail("Redacted image exceeds attachment limit") }
        return ["image":"data:image/png;base64,"+(data as Data).base64EncodedString(),"width":image.width,"height":image.height]
    }
    guard request["operation"] as? String == "diff", images.count == 2 else { try fail("Unknown image operation") }
    let (other,otherContext) = try spatialPixels(images[1])
    guard image.width==other.width,image.height==other.height else { return ["comparable":false,"reason":"Image dimensions differ"] }
    guard let a=context.data?.assumingMemoryBound(to:UInt8.self),let b=otherContext.data?.assumingMemoryBound(to:UInt8.self) else { try fail("Image decode failed") }
    var changed=0, maxDelta=0
    for pixel in 0..<(image.width*image.height) {
        var delta=0
        for channel in 0..<4 { delta=max(delta,abs(Int(a[pixel*4+channel])-Int(b[pixel*4+channel]))) }
        if delta>0 { changed+=1 };maxDelta=max(maxDelta,delta)
    }
    return ["comparable":true,"width":image.width,"height":image.height,"changedPixels":changed,
      "changedFraction":Double(changed)/Double(image.width*image.height),"maxChannelDelta":maxDelta]
}
@main struct HadesComputer {
    @MainActor static func main() async {
        do {
            let input = FileHandle.standardInput.readDataToEndOfFile()
            guard input.count <= 16_100_000, let request = try JSONSerialization.jsonObject(with:input) as? [String:Any], let op = request["op"] as? String else { try fail("Invalid computer request") }
            if op != "spatial.image" && input.count > 1_000_000 { try fail("Invalid computer request") }
            let result = try await run(op,request)
            let data = try JSONSerialization.data(withJSONObject:["ok":true,"result":result],options:[.sortedKeys])
            FileHandle.standardOutput.write(data)
        } catch {
            let message = (error as? BridgeError)?.message ?? error.localizedDescription
            let data = try! JSONSerialization.data(withJSONObject:["ok":false,"error":message])
            FileHandle.standardOutput.write(data)
        }
    }
    @MainActor static func run(_ op: String, _ request: [String:Any]) async throws -> [String:Any] {
        if op == "spatial.image" { return try spatialImageOperation(request) }
        if op == "permissions" {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options); _ = CGRequestScreenCaptureAccess()
        }
        if op == "status" || op == "permissions" { return ["accessibility":AXIsProcessTrusted(),"screenRecording":CGPreflightScreenCaptureAccess()] }
        guard AXIsProcessTrusted() else { try fail("Enable Accessibility for Hades in System Settings, then retry.") }
        if op == "apps" { return ["apps":apps()] }
        if op == "focus" { let app = try target(request,foreground:false); guard app.activate(options:[]) else { try fail("Could not activate the selected app") }; return ["activated":true] }
        if op == "observe" {
            guard CGPreflightScreenCaptureAccess() else { try fail("Enable Screen Recording for Hades in System Settings, then restart Hades.") }
            guard let app = NSWorkspace.shared.frontmostApplication else { try fail("No foreground app") }
            let observedWindow = windowIdentity(app), observedFocus = focusedIdentity(app)
            var rows = [[String:Any]](), remaining = 500
            func walk(_ node: AXUIElement, _ path: [Int], _ depth: Int) {
                guard remaining > 0, depth < 12 else { return }; remaining -= 1
                let role = string(node,kAXRoleAttribute), subrole = string(node,kAXSubroleAttribute)
                var row: [String:Any] = ["id":rows.count,"path":path,"role":role,"title":string(node,kAXTitleAttribute),"description":string(node,kAXDescriptionAttribute),"fingerprint":fingerprint(node)]
                if !subrole.lowercased().contains("secure") { row["value"] = string(node,kAXValueAttribute) }
                if let rect = bounds(node) { row["bounds"] = rect }
                var actions: CFArray?; if AXUIElementCopyActionNames(node,&actions) == .success { row["actions"] = actions as? [String] ?? [] }
                rows.append(row)
                for (index,child) in children(node).enumerated() { walk(child,path + [index],depth + 1) }
            }
            let axRoot = root(app); AXUIElementSetMessagingTimeout(axRoot,2); walk(axRoot,[],0)
            guard #available(macOS 14.0, *) else { try fail("Computer screenshots require macOS 14 or later.") }
            let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
            let displayID = request["display"] as? UInt32 ?? CGMainDisplayID()
            guard let display = content.displays.first(where:{$0.displayID == displayID}) else { try fail("Display not available") }
            let rect = CGDisplayBounds(displayID), config = SCStreamConfiguration()
            let scale = min(1.0,1536.0 / max(rect.width,rect.height))
            config.width = Int(rect.width * scale); config.height = Int(rect.height * scale); config.showsCursor = true
            let filter = SCContentFilter(display:display,excludingWindows:[])
            let capture = try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier, observedWindow == windowIdentity(app), observedFocus == focusedIdentity(app) else { try fail("App, window, or focused control changed during observation. Observe again.") }
            let bitmap = NSBitmapImageRep(cgImage:capture)
            guard let png = bitmap.representation(using:.png,properties:[:]) else { try fail("Screenshot encoding failed") }
            return ["pid":Int(app.processIdentifier),"bundle":app.bundleIdentifier ?? "","app":app.localizedName ?? "","elements":rows,"window":observedWindow,"focused":observedFocus,"truncated":remaining == 0,"apps":apps(),
                "display":["id":displayID,"x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height],
                "displays":content.displays.map { ["id":$0.displayID,"width":$0.width,"height":$0.height] },"image":"data:image/png;base64," + png.base64EncodedString()]
        }
        let app = try target(request)
        guard let observed = request["window"] as? String, observed == windowIdentity(app) else { try fail("The target window changed. Observe again.") }
        if op == "press" { let node = try element(request,app:app); guard AXUIElementPerformAction(node,kAXPressAction as CFString) == .success else { try fail("This element cannot be pressed") }; return ["performed":true] }
        if op == "setValue" {
            let node = try element(request,app:app)
            guard !string(node,kAXSubroleAttribute).lowercased().contains("secure"), let value = request["text"] as? String, value.count <= 10_000 else { try fail("Cannot set this field") }
            guard AXUIElementSetAttributeValue(node,kAXValueAttribute as CFString,value as CFString) == .success else { try fail("This element does not accept a value") }; return ["performed":true]
        }
        if op == "type" || op == "key" {
            guard request["focused"] as? String == focusedIdentity(app) else { try fail("The focused control changed. Observe again before typing.") }
        }
        if op == "type" {
            guard let text = request["text"] as? String, text.utf16.count <= 10_000 else { try fail("Text is too long") }
            let units = Array(text.utf16)
            var start = 0
            while start < units.count {
                var end = min(start + 20,units.count)
                // Never split an emoji or another supplementary scalar across events.
                if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                let chunk = Array(units[start..<end])
                let down = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true), up = CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)
                down?.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk); up?.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk)
                down?.post(tap:.cghidEventTap); up?.post(tap:.cghidEventTap)
                start = end
            }; return ["performed":true]
        }
        if op == "key" {
            let keys: [String:CGKeyCode] = ["return":36,"tab":48,"escape":53,"space":49,"delete":51,"up":126,"down":125,"left":123,"right":124,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"f":3,"l":37]
            guard let key = request["key"] as? String, let code = keys[key] else { try fail("Unsupported key") }
            var flags = CGEventFlags()
            for modifier in request["modifiers"] as? [String] ?? [] {
                switch modifier { case "command": flags.insert(.maskCommand); case "shift":flags.insert(.maskShift); case "option":flags.insert(.maskAlternate); case "control":flags.insert(.maskControl); default:try fail("Unsupported modifier") }
            }; emitKey(code,flags:flags); return ["performed":true]
        }
        if op == "click" || op == "scroll" {
            guard let x = request["x"] as? Double, let y = request["y"] as? Double, x.isFinite, y.isFinite,
                let displayID = request["display"] as? UInt32, CGDisplayBounds(displayID).contains(CGPoint(x:x,y:y)) else { try fail("Point is outside the observed display") }
            let point = CGPoint(x:x,y:y)
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(x),Float(y),&hit) == .success, let hit = hit else { try fail("Cannot verify the click target. Observe again.") }
            var hitPID: pid_t = 0; AXUIElementGetPid(hit,&hitPID)
            guard hitPID == app.processIdentifier else { try fail("Another app covers the target. Observe again.") }
            CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
            if op == "click" {
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
                CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left)?.post(tap:.cghidEventTap)
            } else {
                guard let delta = request["delta"] as? Int, abs(delta) <= 2000 else { try fail("Invalid scroll distance") }
                CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:1,wheel1:Int32(delta),wheel2:0,wheel3:0)?.post(tap:.cghidEventTap)
            }; return ["performed":true]
        }
        try fail("Unsupported computer operation")
    }
}
