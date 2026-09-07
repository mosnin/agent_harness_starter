import AppKit
let source = NSImage(contentsOfFile: CommandLine.arguments[1])!
let directory = CommandLine.arguments[2]
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories:true)
for size in [16,32,128,256,512] {
 for scale in [1,2] {
  let pixels=size*scale
  let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:pixels*4,bitsPerPixel:32)!
  NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
  let bounds=NSRect(x:0,y:0,width:pixels,height:pixels)
  NSBezierPath(roundedRect:bounds.insetBy(dx:Double(pixels)*0.06,dy:Double(pixels)*0.06),xRadius:Double(pixels)*0.2,yRadius:Double(pixels)*0.2).addClip()
  source.draw(in:bounds);NSGraphicsContext.restoreGraphicsState()
  let name="icon_\(size)x\(size)"+(scale==2 ? "@2x" : "")+".png"
  try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:directory+"/"+name))
 }
}
