/**
 * Real behavioral tests for `createImageGenTool`: mode-selection matrix,
 * deterministic procedural SVG generation (fnv1a32 + mulberry32), input
 * hardening, and real-mode HTTP behavior against a fake injected `fetchFn`.
 */
import { describe, it, expect } from "vitest";
import {
  createImageGenTool,
  fnv1a32,
  mulberry32,
  renderProceduralSvg,
  parseImageGenInput,
  type FetchLike,
  type ImageGenOutput,
} from "../image-gen";

function parseOutput(output: string): ImageGenOutput {
  return JSON.parse(output) as ImageGenOutput;
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

// ---------------------------------------------------------------------------
// Mode-selection matrix (all 4 cells)
// ---------------------------------------------------------------------------

describe("createImageGenTool: mode selection matrix", () => {
  it("key present + fetchFn present -> real", () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-real" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { data: [{ b64_json: "abc" }] })),
    });
    expect(entry.mode).toBe("real");
  });

  it("key present + fetchFn absent -> mock", () => {
    const entry = createImageGenTool({ env: { OPENAI_API_KEY: "sk-real" } });
    expect(entry.mode).toBe("mock");
  });

  it("key absent + fetchFn present -> mock", () => {
    const entry = createImageGenTool({ fetchFn: fakeFetch(async () => jsonResponse(200, {})) });
    expect(entry.mode).toBe("mock");
  });

  it("key absent + fetchFn absent -> mock", () => {
    expect(createImageGenTool({}).mode).toBe("mock");
    expect(createImageGenTool().mode).toBe("mock");
  });

  it("whitespace-only key + fetchFn present -> mock", () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "   " },
      fetchFn: fakeFetch(async () => jsonResponse(200, {})),
    });
    expect(entry.mode).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// Catalog metadata contract
// ---------------------------------------------------------------------------

describe("createImageGenTool: catalog metadata", () => {
  it("has the locked identity", () => {
    const entry = createImageGenTool();
    expect(entry.id).toBe("image_gen");
    expect(entry.tool.name).toBe("image_gen");
    expect(entry.category).toBe("media");
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual(["OPENAI_API_KEY"]);
    expect(entry.verifierId).toBe("verify.image_gen");
  });
});

// ---------------------------------------------------------------------------
// fnv1a32 / mulberry32 primitives
// ---------------------------------------------------------------------------

describe("fnv1a32", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a32("hello world")).toBe(fnv1a32("hello world"));
  });

  it("differs for different inputs (no trivial collision on close strings)", () => {
    expect(fnv1a32("hello world")).not.toBe(fnv1a32("hello worlds"));
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const s of ["", "x", "a very long prompt ".repeat(50)]) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mulberry32", () => {
  it("produces a deterministic, repeatable sequence for a given seed", () => {
    const rngB = mulberry32(42);
    const seqB = Array.from({ length: 10 }, () => rngB());
    const rngC = mulberry32(42);
    const seqC = Array.from({ length: 10 }, () => rngC());
    expect(seqB).toEqual(seqC);
    expect(seqB.length).toBe(10);
  });

  it("different seeds diverge", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("stays within [0, 1)", () => {
    const rng = mulberry32(fnv1a32("bounds check"));
    for (let i = 0; i < 200; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// renderProceduralSvg: real, deterministic, valid SVG
// ---------------------------------------------------------------------------

/** Minimal but real balanced-tag XML check: every non-self-closing open
 *  tag must be matched by a close tag in stack order. Self-closing tags
 *  (ending "/>") and the XML/SVG void convention are skipped. */
function assertBalancedXmlTags(xml: string): void {
  const tagRe = /<\/?[a-zA-Z][^>]*>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const tag = match[0];
    if (tag.endsWith("/>")) continue; // self-closing, no push/pop needed
    if (tag.startsWith("</")) {
      const name = /^<\/([a-zA-Z0-9]+)/.exec(tag)?.[1];
      const top = stack.pop();
      expect(top).toBe(name);
    } else {
      const name = /^<([a-zA-Z0-9]+)/.exec(tag)?.[1];
      expect(name).toBeTruthy();
      stack.push(name as string);
    }
  }
  expect(stack).toEqual([]);
}

describe("renderProceduralSvg", () => {
  it("is byte-identical across two calls with the same prompt and size", () => {
    const a = renderProceduralSvg("a red fox in the snow", 256);
    const b = renderProceduralSvg("a red fox in the snow", 256);
    expect(a).toBe(b);
  });

  it("produces different bytes for different prompts", () => {
    const a = renderProceduralSvg("prompt one", 256);
    const b = renderProceduralSvg("prompt two", 256);
    expect(a).not.toBe(b);
  });

  it("emits a standalone SVG document with the xmlns attribute", () => {
    const svg = renderProceduralSvg("xmlns check", 128);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("has balanced XML tags", () => {
    const svg = renderProceduralSvg("balance check with <special> & \"chars\"", 200);
    assertBalancedXmlTags(svg);
  });

  it("XML-escapes special characters from the prompt in the <title>", () => {
    const svg = renderProceduralSvg('<script>alert("x")</script> & friends', 100);
    expect(svg).not.toContain("<script>alert");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("honors the requested size in viewBox/width/height", () => {
    const svg = renderProceduralSvg("size check", 333);
    expect(svg).toContain('viewBox="0 0 333 333"');
    expect(svg).toContain('width="333"');
    expect(svg).toContain('height="333"');
  });

  it("clamps absurd sizes into a sane range without throwing", () => {
    expect(() => renderProceduralSvg("huge", 999999)).not.toThrow();
    expect(() => renderProceduralSvg("tiny", 0)).not.toThrow();
    expect(() => renderProceduralSvg("negative", -50)).not.toThrow();
    const svg = renderProceduralSvg("huge", 999999);
    expect(svg).toContain('viewBox="0 0 2048 2048"');
  });

  it("determinism fuzz: 50 seeded prompts are stable across repeated renders", () => {
    for (let i = 0; i < 50; i++) {
      const prompt = `fuzz-prompt-${i}-${fnv1a32(`seed-${i}`)}`;
      const first = renderProceduralSvg(prompt, 128 + (i % 5) * 16);
      const second = renderProceduralSvg(prompt, 128 + (i % 5) * 16);
      expect(second).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

describe("parseImageGenInput", () => {
  it("accepts a bare prompt string", () => {
    const result = parseImageGenInput("a lighthouse at dusk");
    expect(result).toEqual({ prompt: "a lighthouse at dusk", size: 512 });
  });

  it("accepts JSON {prompt, size}", () => {
    const result = parseImageGenInput('{"prompt":"a cat","size":128}');
    expect(result).toEqual({ prompt: "a cat", size: 128 });
  });

  it("rejects empty input", () => {
    const result = parseImageGenInput("   ");
    expect("error" in result).toBe(true);
  });

  it("rejects empty prompt in JSON", () => {
    const result = parseImageGenInput('{"prompt":"   "}');
    expect("error" in result).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseImageGenInput("{not json");
    expect("error" in result).toBe(true);
  });

  it("rejects JSON missing prompt field", () => {
    const result = parseImageGenInput('{"size":100}');
    expect("error" in result).toBe(true);
  });

  it("rejects non-positive size", () => {
    expect("error" in parseImageGenInput('{"prompt":"x","size":0}')).toBe(true);
    expect("error" in parseImageGenInput('{"prompt":"x","size":-5}')).toBe(true);
  });

  it("caps prompt at 1 MB with a clear error", () => {
    const huge = "a".repeat(1_000_001);
    const result = parseImageGenInput(huge);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/exceeds maximum size/);
  });

  it("accepts a prompt at exactly the 1 MB boundary", () => {
    const atLimit = "a".repeat(1_000_000);
    const result = parseImageGenInput(atLimit);
    expect("error" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock-mode behavior via the full tool
// ---------------------------------------------------------------------------

describe("createImageGenTool: mock mode", () => {
  it("returns mode=mock, format=svg, and the exact required note", () => {
    const entry = createImageGenTool();
    const result = entry.tool.run("a mountain landscape");
    return Promise.resolve(result).then((r) => {
      expect(r.ok).toBe(true);
      const out = parseOutput(r.output);
      expect(out.mode).toBe("mock");
      expect(out.format).toBe("svg");
      expect(out.prompt).toBe("a mountain landscape");
      expect(out.note).toBe("[mock] procedurally generated placeholder — no image model was called");
      expect(out.data.startsWith("<svg ")).toBe(true);
    });
  });

  it("never touches the network in mock mode even if a fetchFn is defined but no key", async () => {
    let called = false;
    const entry = createImageGenTool({
      fetchFn: fakeFetch(async () => {
        called = true;
        return jsonResponse(200, {});
      }),
    });
    await entry.tool.run("no network please");
    expect(called).toBe(false);
  });

  it("surfaces parse errors as ok:false", async () => {
    const entry = createImageGenTool();
    const result = await entry.tool.run("");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/image_gen:/);
  });
});

// ---------------------------------------------------------------------------
// Real-mode behavior against a fake fetchFn
// ---------------------------------------------------------------------------

describe("createImageGenTool: real mode", () => {
  it("posts to the exact OpenAI endpoint with the Bearer auth header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody = "";
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-test-123" },
      fetchFn: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        capturedBody = init?.body ?? "";
        return jsonResponse(200, { data: [{ b64_json: "ZmFrZS1wbmctYnl0ZXM=" }] });
      }),
    });
    const result = await entry.tool.run('{"prompt":"a golden retriever","size":256}');
    expect(capturedUrl).toBe("https://api.openai.com/v1/images/generations");
    expect(capturedHeaders?.Authorization).toBe("Bearer sk-test-123");
    expect(JSON.parse(capturedBody).prompt).toBe("a golden retriever");
    expect(JSON.parse(capturedBody).size).toBe("256x256");
    expect(result.ok).toBe(true);
    const out = parseOutput(result.output);
    expect(out.mode).toBe("real");
    expect(out.format).toBe("png-base64");
    expect(out.data).toBe("ZmFrZS1wbmctYnl0ZXM=");
    expect(out.note).toBeUndefined();
  });

  it("maps HTTP 401 to ok:false with the status surfaced", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-bad" },
      fetchFn: fakeFetch(async () => ({ status: 401, headers: {}, text: async () => "unauthorized" })),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("401");
  });

  it("maps HTTP 429 to ok:false with the status surfaced", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-rl" },
      fetchFn: fakeFetch(async () => ({ status: 429, headers: {}, text: async () => "rate limited" })),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("429");
  });

  it("maps HTTP 500 to ok:false with the status surfaced", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-500" },
      fetchFn: fakeFetch(async () => ({ status: 500, headers: {}, text: async () => "server error" })),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("500");
  });

  it("maps a rejected fetchFn to ok:false", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-neterr" },
      fetchFn: fakeFetch(async () => {
        throw new Error("network down");
      }),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("network down");
  });

  it("handles an absent/malformed b64_json payload gracefully", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-empty" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { data: [] })),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing image data/);
  });

  it("handles a non-JSON response body", async () => {
    const entry = createImageGenTool({
      env: { OPENAI_API_KEY: "sk-badjson" },
      fetchFn: fakeFetch(async () => ({ status: 200, headers: {}, text: async () => "not json at all" })),
    });
    const result = await entry.tool.run("anything");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not valid JSON/);
  });
});
