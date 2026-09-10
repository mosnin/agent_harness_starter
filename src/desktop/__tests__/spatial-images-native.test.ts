import { expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { existsSync } from "node:fs";
import { computerBridge } from "../core/computer-control";
function crc(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}
function png(pixels: number[][]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.from([
    0,
    ...pixels[0],
    ...pixels[1],
    0,
    ...pixels[2],
    ...pixels[3],
  ]);
  return (
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
  );
}
const helper = process.env.HADES_SPATIAL_TEST_HELPER;
it.skipIf(!helper || !existsSync(helper))(
  "native pixel masks cover the intended top-left pixels; diffs count actual changed pixels",
  async () => {
    const invoke = computerBridge(helper!),
      white = [255, 255, 255, 255],
      black = [0, 0, 0, 255];
    const input = png([white, white, white, white]);
    const redacted = await invoke({
      op: "spatial.image",
      operation: "redact",
      images: [input],
      masks: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    });
    const expected = png([black, white, white, white]);
    expect(
      await invoke({
        op: "spatial.image",
        operation: "diff",
        images: [expected, redacted.image],
      }),
    ).toMatchObject({ comparable: true, changedPixels: 0 });
    expect(
      await invoke({
        op: "spatial.image",
        operation: "diff",
        images: [input, redacted.image],
      }),
    ).toMatchObject({ changedPixels: 1, changedFraction: 0.25 });
    await expect(
      invoke({
        op: "spatial.image",
        operation: "redact",
        images: [input],
        masks: [{ x: 0.9, y: 0, width: 0.5, height: 1 }],
      }),
    ).rejects.toThrow(/outside/);
    await expect(
      invoke({
        op: "spatial.image",
        operation: "diff",
        images: ["data:image/png;base64,AAAA", input],
      }),
    ).rejects.toThrow(/Invalid/);
  },
);
