/**
 * Real behavioral tests for `createVisionDescribeTool`: mode-selection
 * matrix, real magic-byte + dimension sniffing against hand-built byte
 * fixtures (valid and corrupt), input hardening (base64 validation, size
 * caps), and real-mode HTTP behavior against a fake injected `fetchFn`.
 */
import { describe, it, expect } from "vitest";
import {
  createVisionDescribeTool,
  sniffImage,
  isValidBase64,
  parseVisionInput,
  type FetchLike,
  type VisionDescribeOutput,
} from "../vision";

function parseOutput(output: string): VisionDescribeOutput {
  return JSON.parse(output) as VisionDescribeOutput;
}

function fakeFetch(
  impl: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>
): FetchLike {
  return impl;
}

function jsonResponse(status: number, body: unknown): { status: number; headers: Record<string, string>; text(): Promise<string> } {
  return { status, headers: {}, text: async () => JSON.stringify(body) };
}

function encodeBase64ForTest(bytes: Uint8Array): string {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + "=";
  }
  return out;
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function ascii(s: string): number[] {
  return s.split("").map((c) => c.charCodeAt(0));
}
function crc32Stub(): number[] {
  // sniffPng never validates the CRC — 4 arbitrary bytes are fine.
  return [0, 0, 0, 0];
}

// ---------------------------------------------------------------------------
// Hand-built byte fixtures
// ---------------------------------------------------------------------------

/** A real, structurally valid minimal PNG: signature + IHDR chunk
 *  declaring width x height (CRC bytes are not checked by our sniffer,
 *  so they're zeroed — still a genuine IHDR layout). */
function buildPng(width: number, height: number): Uint8Array {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...u32be(13), // IHDR length
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    8, 6, 0, 0, 0, // bit depth, color type, compression, filter, interlace
    ...crc32Stub(),
  ];
  return new Uint8Array(bytes);
}

function buildGif(width: number, height: number): Uint8Array {
  const bytes = [...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0x00, 0x00, 0x00];
  return new Uint8Array(bytes);
}

/** A real, minimal baseline JPEG: SOI, then an SOF0 marker segment
 *  encoding precision/height/width/components, then EOI. */
function buildJpeg(width: number, height: number): Uint8Array {
  const sof0Body = [8 /* precision */, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]; // 1 component
  const sof0Length = sof0Body.length + 2; // length field includes itself
  const bytes = [
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0 marker
    ...u16be(sof0Length),
    ...sof0Body,
    0xff, 0xd9, // EOI
  ];
  return new Uint8Array(bytes);
}

function buildPpm(width: number, height: number): Uint8Array {
  const header = `P6\n${width} ${height}\n255\n`;
  const headerBytes = ascii(header);
  const pixelBytes = new Array(width * height * 3).fill(128);
  return new Uint8Array([...headerBytes, ...pixelBytes]);
}

function buildSvg(width: number, height: number): Uint8Array {
  const text = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect/></svg>`;
  return new Uint8Array(ascii(text));
}

// ---------------------------------------------------------------------------
// sniffImage: valid fixtures
// ---------------------------------------------------------------------------

describe("sniffImage: valid fixtures", () => {
  it("parses a real PNG IHDR chunk", () => {
    const result = sniffImage(buildPng(640, 480));
    expect(result).toEqual({ format: "png", width: 640, height: 480 });
  });

  it("parses a real GIF logical screen descriptor", () => {
    const result = sniffImage(buildGif(320, 200));
    expect(result).toEqual({ format: "gif", width: 320, height: 200 });
  });

  it("parses a real JPEG SOF0 marker segment", () => {
    const result = sniffImage(buildJpeg(1024, 768));
    expect(result).toEqual({ format: "jpeg", width: 1024, height: 768 });
  });

  it("parses a real JPEG SOF2 (progressive) marker segment", () => {
    const sof2Body = [8, ...u16be(100), ...u16be(200), 1, 1, 0x11, 0];
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc2, ...u16be(sof2Body.length + 2), ...sof2Body, 0xff, 0xd9]);
    const result = sniffImage(bytes);
    expect(result).toEqual({ format: "jpeg", width: 200, height: 100 });
  });

  it("parses a real PPM (P6) header", () => {
    const result = sniffImage(buildPpm(64, 32));
    expect(result.format).toBe("ppm");
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);
  });

  it("parses a PPM header with a comment line", () => {
    const header = "P6\n# a comment\n10 20\n255\n";
    const bytes = new Uint8Array(ascii(header));
    const result = sniffImage(bytes);
    expect(result).toEqual({ format: "ppm", width: 10, height: 20 });
  });

  it("parses width/height out of an SVG root tag", () => {
    const result = sniffImage(buildSvg(300, 150));
    expect(result).toEqual({ format: "svg", width: 300, height: 150 });
  });

  it("recognizes an SVG without numeric width/height as format-only", () => {
    const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
    const result = sniffImage(new Uint8Array(ascii(text)));
    expect(result.format).toBe("svg");
    expect(result.width).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sniffImage: truncated / corrupt input must never throw
// ---------------------------------------------------------------------------

describe("sniffImage: corrupt/truncated input never throws", () => {
  it("returns unknown for an empty buffer", () => {
    expect(() => sniffImage(new Uint8Array(0))).not.toThrow();
    expect(sniffImage(new Uint8Array(0))).toEqual({ format: "unknown" });
  });

  it("returns unknown for random short garbage", () => {
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toEqual({ format: "unknown" });
  });

  it("recognizes a truncated PNG signature but no IHDR as png without dimensions", () => {
    const truncated = buildPng(640, 480).slice(0, 10);
    expect(() => sniffImage(truncated)).not.toThrow();
    const result = sniffImage(truncated);
    expect(result.format).toBe("png");
    expect(result.width).toBeUndefined();
  });

  it("handles a PNG signature with a truncated IHDR body without throwing", () => {
    const truncated = buildPng(640, 480).slice(0, 18);
    expect(() => sniffImage(truncated)).not.toThrow();
  });

  it("handles a truncated GIF (no logical screen descriptor) without throwing", () => {
    const truncated = new Uint8Array(ascii("GIF89a"));
    expect(() => sniffImage(truncated)).not.toThrow();
    const result = sniffImage(truncated);
    expect(result.format).toBe("gif");
    expect(result.width).toBeUndefined();
  });

  it("handles a truncated JPEG (SOI only, no SOF) without throwing", () => {
    const truncated = new Uint8Array([0xff, 0xd8]);
    expect(() => sniffImage(truncated)).not.toThrow();
    expect(sniffImage(truncated).format).toBe("jpeg");
  });

  it("handles a JPEG with a truncated SOF0 segment without throwing", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08]);
    expect(() => sniffImage(bytes)).not.toThrow();
  });

  it("handles a JPEG with a corrupt/garbage marker stream without throwing", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56, 0xff]);
    expect(() => sniffImage(bytes)).not.toThrow();
  });

  it("handles a PPM with a missing height token without throwing", () => {
    const bytes = new Uint8Array(ascii("P6\n42"));
    expect(() => sniffImage(bytes)).not.toThrow();
    const result = sniffImage(bytes);
    expect(result.format).toBe("ppm");
    expect(result.width).toBeUndefined();
  });

  it("handles a bare 'P' byte without throwing", () => {
    expect(() => sniffImage(new Uint8Array([0x50]))).not.toThrow();
    expect(sniffImage(new Uint8Array([0x50]))).toEqual({ format: "unknown" });
  });

  it("handles an SVG-looking prefix cut off mid-tag without throwing", () => {
    const bytes = new Uint8Array(ascii("<?xml version=\"1.0\"?><sv"));
    expect(() => sniffImage(bytes)).not.toThrow();
  });

  it("handles a very large declared PNG dimension without throwing (no OOB read)", () => {
    const bytes = buildPng(0xffffffff, 0xffffffff);
    expect(() => sniffImage(bytes)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isValidBase64
// ---------------------------------------------------------------------------

describe("isValidBase64", () => {
  it("accepts valid unpadded/padded base64", () => {
    expect(isValidBase64("YQ==")).toBe(true);
    expect(isValidBase64("YWJj")).toBe(true);
    expect(isValidBase64("")).toBe(true);
  });

  it("rejects a bad alphabet", () => {
    expect(isValidBase64("not base64!!")).toBe(false);
    expect(isValidBase64("abc$")).toBe(false);
  });

  it("rejects a bad length (not a multiple of 4)", () => {
    expect(isValidBase64("YQ")).toBe(false);
    expect(isValidBase64("YWJ")).toBe(false);
  });

  it("rejects padding in the wrong place", () => {
    expect(isValidBase64("Y=Q=")).toBe(false);
    expect(isValidBase64("====")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

describe("parseVisionInput", () => {
  const validB64 = encodeBase64ForTest(buildPng(10, 10));

  it("accepts a bare base64 string, defaulting the question", () => {
    const result = parseVisionInput(validB64);
    expect(result).toEqual({ imageBase64: validB64, question: "Describe this image in detail." });
  });

  it("accepts JSON {imageBase64, question}", () => {
    const result = parseVisionInput(JSON.stringify({ imageBase64: validB64, question: "What color?" }));
    expect(result).toEqual({ imageBase64: validB64, question: "What color?" });
  });

  it("rejects empty input", () => {
    expect("error" in parseVisionInput("   ")).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect("error" in parseVisionInput("{oops")).toBe(true);
  });

  it("rejects JSON missing imageBase64", () => {
    expect("error" in parseVisionInput('{"question":"hi"}')).toBe(true);
  });

  it("rejects invalid base64 alphabet", () => {
    const result = parseVisionInput("not-valid-base64!!!");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/not valid base64/);
  });

  it("rejects invalid base64 length", () => {
    const result = parseVisionInput("YQ");
    expect("error" in result).toBe(true);
  });

  it("caps imageBase64 at 1,000,000 characters with a clear error", () => {
    const huge = "A".repeat(1_000_004); // valid alphabet, multiple of 4, over the cap
    const result = parseVisionInput(huge);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/exceeds maximum size/);
  });
});

// ---------------------------------------------------------------------------
// Mode-selection matrix (all 4 cells)
// ---------------------------------------------------------------------------

describe("createVisionDescribeTool: mode selection matrix", () => {
  it("key present + fetchFn present -> real", () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "sk-ant-real" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { content: [{ type: "text", text: "a picture" }] })),
    });
    expect(entry.mode).toBe("real");
  });

  it("key present + fetchFn absent -> mock", () => {
    expect(createVisionDescribeTool({ env: { ANTHROPIC_API_KEY: "sk-ant-real" } }).mode).toBe("mock");
  });

  it("key absent + fetchFn present -> mock", () => {
    expect(createVisionDescribeTool({ fetchFn: fakeFetch(async () => jsonResponse(200, {})) }).mode).toBe("mock");
  });

  it("key absent + fetchFn absent -> mock", () => {
    expect(createVisionDescribeTool({}).mode).toBe("mock");
    expect(createVisionDescribeTool().mode).toBe("mock");
  });

  it("whitespace-only key -> mock", () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "   " },
      fetchFn: fakeFetch(async () => jsonResponse(200, {})),
    });
    expect(entry.mode).toBe("mock");
  });
});

describe("createVisionDescribeTool: catalog metadata", () => {
  it("has the locked identity", () => {
    const entry = createVisionDescribeTool();
    expect(entry.id).toBe("vision_describe");
    expect(entry.tool.name).toBe("vision_describe");
    expect(entry.category).toBe("media");
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// Mock-mode behavior via the full tool
// ---------------------------------------------------------------------------

describe("createVisionDescribeTool: mock mode", () => {
  it("reports only facts actually parsed from the bytes, prefixed with the exact required note", async () => {
    const entry = createVisionDescribeTool();
    const b64 = encodeBase64ForTest(buildPng(800, 600));
    const result = await entry.tool.run(b64);
    expect(result.ok).toBe(true);
    const out = parseOutput(result.output);
    expect(out.mode).toBe("mock");
    expect(out.note).toBe("[mock] byte-level analysis only — no vision model was called");
    expect(out.description.startsWith("[mock] byte-level analysis only — no vision model was called")).toBe(true);
    expect(out.description).toContain("format=png");
    expect(out.description).toContain("dimensions=800x600");
    expect(out.description).toContain(`byteLength=${buildPng(800, 600).length}`);
  });

  it("reports unknown format honestly for unrecognized bytes", async () => {
    const entry = createVisionDescribeTool();
    const b64 = encodeBase64ForTest(new Uint8Array([1, 2, 3, 4]));
    const result = await entry.tool.run(b64);
    const out = parseOutput(result.output);
    expect(out.description).toContain("format=unknown");
    expect(out.description).toContain("dimensions=unknown");
  });

  it("carries the question through unchanged", async () => {
    const entry = createVisionDescribeTool();
    const b64 = encodeBase64ForTest(buildGif(1, 1));
    const result = await entry.tool.run(JSON.stringify({ imageBase64: b64, question: "Is this a cat?" }));
    const out = parseOutput(result.output);
    expect(out.question).toBe("Is this a cat?");
  });

  it("never touches the network in mock mode", async () => {
    let called = false;
    const entry = createVisionDescribeTool({
      fetchFn: fakeFetch(async () => {
        called = true;
        return jsonResponse(200, {});
      }),
    });
    await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(called).toBe(false);
  });

  it("surfaces parse errors as ok:false", async () => {
    const entry = createVisionDescribeTool();
    const result = await entry.tool.run("");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^vision_describe:/);
  });
});

// ---------------------------------------------------------------------------
// Real-mode behavior against a fake fetchFn
// ---------------------------------------------------------------------------

describe("createVisionDescribeTool: real mode", () => {
  it("posts to the exact Anthropic endpoint with the x-api-key/anthropic-version headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody = "";
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      fetchFn: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        capturedBody = init?.body ?? "";
        return jsonResponse(200, { content: [{ type: "text", text: "A red bicycle leaning on a wall." }] });
      }),
    });
    const b64 = encodeBase64ForTest(buildPng(4, 4));
    const result = await entry.tool.run(JSON.stringify({ imageBase64: b64, question: "What is this?" }));

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders?.["x-api-key"]).toBe("sk-ant-test");
    expect(capturedHeaders?.["anthropic-version"]).toBe("2023-06-01");
    const parsedBody = JSON.parse(capturedBody);
    expect(parsedBody.messages[0].content[0].type).toBe("image");
    expect(parsedBody.messages[0].content[0].source.media_type).toBe("image/png");
    expect(parsedBody.messages[0].content[1].text).toBe("What is this?");

    expect(result.ok).toBe(true);
    const out = parseOutput(result.output);
    expect(out.mode).toBe("real");
    expect(out.description).toBe("A red bicycle leaning on a wall.");
    expect(out.note).toBeUndefined();
  });

  it("maps HTTP 401 to ok:false with the status surfaced", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "bad" },
      fetchFn: fakeFetch(async () => ({ status: 401, headers: {}, text: async () => "unauthorized" })),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("401");
  });

  it("maps HTTP 429 to ok:false with the status surfaced", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "rl" },
      fetchFn: fakeFetch(async () => ({ status: 429, headers: {}, text: async () => "rate limited" })),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("429");
  });

  it("maps HTTP 500 to ok:false with the status surfaced", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "500" },
      fetchFn: fakeFetch(async () => ({ status: 500, headers: {}, text: async () => "server error" })),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("500");
  });

  it("maps a rejected fetchFn to ok:false", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "neterr" },
      fetchFn: fakeFetch(async () => {
        throw new Error("connection reset");
      }),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("connection reset");
  });

  it("handles a response with no text content block", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "k" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { content: [] })),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing text content/);
  });

  it("handles a non-JSON response body", async () => {
    const entry = createVisionDescribeTool({
      env: { ANTHROPIC_API_KEY: "k" },
      fetchFn: fakeFetch(async () => ({ status: 200, headers: {}, text: async () => "not json" })),
    });
    const result = await entry.tool.run(encodeBase64ForTest(buildGif(1, 1)));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not valid JSON/);
  });
});
