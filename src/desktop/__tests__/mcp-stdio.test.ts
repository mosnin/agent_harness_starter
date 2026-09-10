import { describe, it, expect } from "vitest";
import { connectMcp } from "../core/mcp-stdio";

const fixture = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line); if(!m.id)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 else if(m.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
 else {
  const a=m.params.arguments;
  if(a.mode==='hang')return;
  if(a.mode==='oversize-frame'){process.stdout.write('x'.repeat(40_200_001));return;}
  if(a.mode==='large-image')result={content:[{type:'image',mimeType:'image/png',data:Buffer.alloc(a.bytes,1).toString('base64')}]};
  else result=a.result || {content:[{type:'text',text:a.value}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});`;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==";
async function connection() {
  const abort = new AbortController();
  const client = await connectMcp(
    {
      name: "fixture",
      command: process.execPath,
      args: ["-e", fixture],
      enabled: true,
    },
    process.cwd(),
    abort.signal,
  );
  return {
    ...client,
    abort,
    run: (args: unknown) => client.tools[0].run(JSON.stringify(args)),
  };
}
describe("desktop MCP process transport", () => {
  it("initializes, discovers, invokes and closes a real stdio subprocess", async () => {
    const c = await connection();
    try {
      expect(c.tools[0].name).toBe("mcp_fixture_echo");
      expect(await c.run({ value: "MCP works" })).toEqual({
        ok: true,
        output: '[{"type":"text","text":"MCP works"}]',
      });
      c.abort.abort();
      await expect(c.run({ value: "after close" })).rejects.toThrow("closed");
    } finally {
      c.close();
    }
  });
  it("propagates an actual image data URL beside text and structured data without base64 in text", async () => {
    const c = await connection();
    try {
      const result = await c.run({
        result: {
          content: [
            { type: "text", text: "Screenshot observed" },
            { type: "image", mimeType: "image/png", data: png },
            { type: "resource_link", uri: "file:///fixture", name: "fixture" },
          ],
          structuredContent: { window: "Fixture", count: 1 },
        },
      });
      expect(result.images).toEqual([`data:image/png;base64,${png}`]);
      expect(result.output).not.toContain(png);
      expect(JSON.parse(result.output)).toEqual([
        { type: "text", text: "Screenshot observed" },
        { type: "image", mimeType: "image/png", imageIndex: 0 },
        { type: "resource_link", uri: "file:///fixture", name: "fixture" },
        { type: "structuredContent", value: { window: "Fixture", count: 1 } },
      ]);
    } finally {
      c.close();
    }
  });
  it("omits invalid MIME, malformed and noncanonical base64 without losing text or server error state", async () => {
    const c = await connection();
    try {
      const result = await c.run({
        result: {
          isError: true,
          content: [
            { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
            { type: "image", mimeType: "image/png", data: "bad!" },
            { type: "image", mimeType: "image/png", data: "Zh==" },
            { type: "text", text: "Useful failure" },
          ],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.images).toBeUndefined();
      expect(result.output).toContain("Useful failure");
      expect(result.output).toContain("unsupported image MIME");
      expect(result.output).toContain("invalid image base64");
      expect(result.output).not.toContain("PHN2Zz4=");
    } finally {
      c.close();
    }
  });
  it.each([
    { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
    { type: "image", mimeType: "image/png", data: "bad!" },
    { type: "image", mimeType: "image/png", data: "Zh==" },
  ])(
    "rejects an invalid image in an otherwise successful response: %j",
    async (image) => {
      const c = await connection();
      try {
        const result = await c.run({
          result: {
            content: [
              { type: "text", text: "Action already completed" },
              image,
              { type: "image", mimeType: "image/png", data: png },
            ],
          },
        });
        expect(result.ok).toBe(false);
        expect(result.output).toContain("Action already completed");
        expect(result.images).toEqual([`data:image/png;base64,${png}`]);
        expect(result.output).not.toContain(png);
      } finally {
        c.close();
      }
    },
  );
  it("preserves image-shaped structured metadata without promoting it", async () => {
    const c = await connection();
    try {
      const metadata = {
        type: "image",
        mimeType: "image/png",
        data: "arbitrary metadata",
      };
      const result = await c.run({
        result: { content: [], structuredContent: metadata },
      });
      expect(result.ok).toBe(true);
      expect(result.images).toBeUndefined();
      expect(JSON.parse(result.output)).toEqual([
        { type: "structuredContent", value: metadata },
      ]);
    } finally {
      c.close();
    }
  });
  it("caps top-level image count without interpreting structured metadata", async () => {
    const c = await connection();
    try {
      const image = { type: "image", mimeType: "image/png", data: png };
      const result = await c.run({
        result: {
          content: Array(6).fill(image),
          structuredContent: {
            nested: { type: "image", data: "metadata only" },
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(result.images).toHaveLength(5);
      expect(JSON.parse(result.output).at(-1)).toEqual({
        type: "structuredContent",
        value: { nested: { type: "image", data: "metadata only" } },
      });
      expect(result.output).not.toContain(png);
      expect(result.output).toContain("maximum five images");
    } finally {
      c.close();
    }
  });
  it("accepts screenshot frames larger than the previous 2M transport limit", async () => {
    const c = await connection();
    try {
      const result = await c.run({ mode: "large-image", bytes: 1_600_000 });
      expect(result.images).toHaveLength(1);
      expect(result.output.length).toBeLessThan(200);
    } finally {
      c.close();
    }
  });
  it("omits over-limit images without putting their payload into text", async () => {
    const c = await connection();
    try {
      const result = await c.run({ mode: "large-image", bytes: 6_000_000 });
      expect(result.images).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.output).toContain("exceeds");
      expect(result.output.length).toBeLessThan(200);
    } finally {
      c.close();
    }
  });
  it("bounds a protocol frame even when no newline arrives", async () => {
    const c = await connection();
    try {
      await expect(c.run({ mode: "oversize-frame" })).rejects.toThrow("closed");
    } finally {
      c.close();
    }
  });
  it("cancellation rejects an in-flight call and subsequent calls", async () => {
    const c = await connection();
    try {
      const pending = c.run({ mode: "hang" });
      const rejection = expect(pending).rejects.toThrow("closed");
      c.abort.abort();
      await rejection;
      await expect(c.run({ value: "late" })).rejects.toThrow("closed");
    } finally {
      c.close();
    }
  });
  it("does not spawn an already-cancelled connection", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      connectMcp(
        { name: "fixture", command: "missing", args: [], enabled: true },
        process.cwd(),
        abort.signal,
      ),
    ).rejects.toThrow("Cancelled");
  });
});
