/**
 * Tests for `browser` (tool.ts). Exercises real behaviour, not trivial
 * asserts: hostile-input fuzzing over the strict JSON protocol, honest
 * real-vs-mock mode gating against the actual `/opt/pw-browsers`
 * Playwright cache (and a genuinely empty temp dir), a fake injected
 * runner exercising the real/mock/failure/throw paths, CatalogEntry
 * invariants against the real `ToolCatalog`, and byte-for-byte mock
 * determinism.
 *
 * The one deliberate exception to "tool tests only import tool.ts" is
 * `verifier.ts`, imported in the LAST describe block below to prove the
 * tool<->verifier agreement the locked contract calls out explicitly:
 * "tool tests own that pairing".
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  createBrowserTool,
  validateBrowseInput,
  defaultProbeChromium,
  BROWSER_TOOL_ID,
  BROWSER_VERIFIER_ID,
  type BrowseRequest,
  type BrowseOutcome,
  type BrowserToolOutput,
} from "../tool";
import { ToolCatalog } from "../../tools/catalog";
import type { ToolResult } from "../../agent/tools";

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// validateBrowseInput — hostile-input fuzzing over the strict JSON protocol
// ---------------------------------------------------------------------------

describe("validateBrowseInput", () => {
  it("accepts a minimal well-formed browse request", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.url).toBe("https://example.com");
      expect(r.value.maxBytes).toBe(200_000);
      expect(r.value.actions).toEqual([]);
      expect(r.value.question).toBeUndefined();
    }
  });

  it("accepts question, maxBytes, and actions all populated", () => {
    const r = validateBrowseInput(
      JSON.stringify({
        op: "browse",
        url: "https://example.com/page",
        question: "what is the price?",
        maxBytes: 5000,
        actions: [
          { kind: "click", selector: "#buy" },
          { kind: "scroll", deltaY: 400 },
          { kind: "type", selector: "input", text: "hello" },
          { kind: "press", key: "Enter" },
          { kind: "fill", selector: "#x", value: "y" },
        ],
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.question).toBe("what is the price?");
      expect(r.value.maxBytes).toBe(5000);
      expect(r.value.actions).toHaveLength(5);
      expect(r.value.actions[0]).toEqual({ kind: "click", selector: "#buy" });
      expect(r.value.actions[1]).toEqual({ kind: "scroll", deltaY: 400 });
    }
  });

  it("rejects non-JSON input as bad-json", () => {
    const r = validateBrowseInput("not json at all {{{");
    expect(r).toMatchObject({ ok: false, code: "bad-json" });
  });

  it("rejects a JSON array as bad-json", () => {
    const r = validateBrowseInput(JSON.stringify([1, 2, 3]));
    expect(r).toMatchObject({ ok: false, code: "bad-json" });
  });

  it("rejects a bare JSON string/number/null as bad-json", () => {
    expect(validateBrowseInput('"hello"')).toMatchObject({ ok: false, code: "bad-json" });
    expect(validateBrowseInput("42")).toMatchObject({ ok: false, code: "bad-json" });
    expect(validateBrowseInput("null")).toMatchObject({ ok: false, code: "bad-json" });
  });

  it("rejects an oversized input string fast as bad-json", () => {
    const huge = JSON.stringify({ op: "browse", url: "https://example.com", question: "x".repeat(10_000_000) });
    expect(huge.length).toBeGreaterThan(9_000_000);
    const start = Date.now();
    const r = validateBrowseInput(huge);
    const elapsed = Date.now() - start;
    expect(r).toMatchObject({ ok: false, code: "bad-json" });
    // "rejected fast" — must not attempt a full JSON.parse of 10MB.
    expect(elapsed).toBeLessThan(200);
  });

  it("rejects a missing op as bad-op", () => {
    const r = validateBrowseInput(JSON.stringify({ url: "https://example.com" }));
    expect(r).toMatchObject({ ok: false, code: "bad-op" });
  });

  it("rejects an unknown op as bad-op", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "navigate", url: "https://example.com" }));
    expect(r).toMatchObject({ ok: false, code: "bad-op" });
  });

  it("rejects a non-string op as bad-op", () => {
    const r = validateBrowseInput(JSON.stringify({ op: 123, url: "https://example.com" }));
    expect(r).toMatchObject({ ok: false, code: "bad-op" });
  });

  it("rejects a missing url as bad-url", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse" }));
    expect(r).toMatchObject({ ok: false, code: "bad-url" });
  });

  it("rejects a non-string url as bad-url", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: 12345 }));
    expect(r).toMatchObject({ ok: false, code: "bad-url" });
  });

  it("rejects an empty-string url as bad-url", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "" }));
    expect(r).toMatchObject({ ok: false, code: "bad-url" });
  });

  it("rejects an unparseable url as bad-url", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "not a url" }));
    expect(r).toMatchObject({ ok: false, code: "bad-url" });
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>1</script>", "ftp://example.com/x"])(
    "rejects non-http(s) scheme %s as bad-url",
    (url) => {
      const r = validateBrowseInput(JSON.stringify({ op: "browse", url }));
      expect(r).toMatchObject({ ok: false, code: "bad-url" });
    }
  );

  it("accepts a unicode/IDN url", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://例え.テスト/ページ" }));
    expect(r.ok).toBe(true);
  });

  it("rejects a non-string question as bad-field", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", question: 5 }));
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("rejects a non-number maxBytes as bad-field", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", maxBytes: "big" }));
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("rejects a non-finite (null / Infinity-shaped) maxBytes as bad-field", () => {
    const rNull = validateBrowseInput('{"op":"browse","url":"https://example.com","maxBytes":null}');
    expect(rNull).toMatchObject({ ok: false, code: "bad-field" });

    // 1e999 is a syntactically valid JSON number token that overflows to Infinity.
    const rInf = validateBrowseInput('{"op":"browse","url":"https://example.com","maxBytes":1e999}');
    expect(rInf).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("clamps maxBytes below the floor up to 1000", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", maxBytes: 10 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maxBytes).toBe(1000);
  });

  it("clamps maxBytes above the ceiling down to 1000000", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", maxBytes: 50_000_000 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.maxBytes).toBe(1_000_000);
  });

  it("rejects actions that are not an array as bad-actions", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: "click" }));
    expect(r).toMatchObject({ ok: false, code: "bad-actions" });
  });

  it("rejects actions arrays with 17+ items as bad-actions", () => {
    const actions = Array.from({ length: 17 }, () => ({ kind: "click", selector: "#x" }));
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions }));
    expect(r).toMatchObject({ ok: false, code: "bad-actions" });
  });

  it("accepts an actions array with exactly 16 items", () => {
    const actions = Array.from({ length: 16 }, () => ({ kind: "click", selector: "#x" }));
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions).toHaveLength(16);
  });

  it("rejects a non-object action item as bad-actions", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: ["click"] }));
    expect(r).toMatchObject({ ok: false, code: "bad-actions" });
  });

  it("rejects a null action item as bad-actions", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: [null] }));
    expect(r).toMatchObject({ ok: false, code: "bad-actions" });
  });

  it("rejects an array action item as bad-actions", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: [[1, 2]] }));
    expect(r).toMatchObject({ ok: false, code: "bad-actions" });
  });

  it("rejects an action with a missing kind as bad-field", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: [{ selector: "#x" }] }));
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("rejects an action with a non-string kind as bad-field", () => {
    const r = validateBrowseInput(JSON.stringify({ op: "browse", url: "https://example.com", actions: [{ kind: 5 }] }));
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("rejects an action with a non-string selector as bad-field", () => {
    const r = validateBrowseInput(
      JSON.stringify({ op: "browse", url: "https://example.com", actions: [{ kind: "click", selector: 5 }] })
    );
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("rejects an action with a non-number deltaY as bad-field", () => {
    const r = validateBrowseInput(
      JSON.stringify({ op: "browse", url: "https://example.com", actions: [{ kind: "scroll", deltaY: "far" }] })
    );
    expect(r).toMatchObject({ ok: false, code: "bad-field" });
  });

  it("__proto__ and constructor keys in the top-level object cause no prototype pollution", () => {
    const raw = '{"op":"browse","url":"https://example.com","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
    const r = validateBrowseInput(raw);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("__proto__ keys inside an action object cause no prototype pollution", () => {
    const raw =
      '{"op":"browse","url":"https://example.com","actions":[{"kind":"click","__proto__":{"polluted":true}}]}';
    const r = validateBrowseInput(raw);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops unknown extra fields on an action rather than choking on them", () => {
    const r = validateBrowseInput(
      JSON.stringify({ op: "browse", url: "https://example.com", actions: [{ kind: "click", extra: "ignored" }] })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actions[0]).toEqual({ kind: "click" });
      expect((r.value.actions[0] as unknown as Record<string, unknown>).extra).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// defaultProbeChromium — real /opt/pw-browsers vs a genuinely empty temp dir
// ---------------------------------------------------------------------------

describe("defaultProbeChromium", () => {
  it("finds a real Chromium under /opt/pw-browsers", () => {
    // This sandbox genuinely has a Playwright Chromium install; this is a
    // real fs check, not a stub.
    expect(defaultProbeChromium("/opt/pw-browsers")).toBe(true);
  });

  it("reports false for a genuinely empty temp directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tool-probe-"));
    try {
      expect(defaultProbeChromium(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports false for a nonexistent directory", () => {
    expect(defaultProbeChromium("/definitely/does/not/exist/anywhere")).toBe(false);
  });

  it("reports false for a directory whose matching subdir has no executable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tool-probe-"));
    try {
      fs.mkdirSync(path.join(dir, "chromium-9999", "chrome-linux"), { recursive: true });
      // Directory name matches, but no `chrome` binary inside — honest false.
      expect(defaultProbeChromium(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a fabricated chromium_headless_shell-* layout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tool-probe-"));
    try {
      const execDir = path.join(dir, "chromium_headless_shell-1234", "chrome-linux");
      fs.mkdirSync(execDir, { recursive: true });
      fs.writeFileSync(path.join(execDir, "headless_shell"), "#!/bin/sh\n");
      expect(defaultProbeChromium(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createBrowserTool — mode gating
// ---------------------------------------------------------------------------

describe("createBrowserTool mode gating", () => {
  it("is mock when no runner is provided, even with a passing probe", () => {
    const entry = createBrowserTool({ probeChromium: () => true });
    expect(entry.mode).toBe("mock");
  });

  it("is mock when a runner is provided but the probe fails", () => {
    const entry = createBrowserTool({
      runner: async () => ({
        ok: true,
        url: "https://x.com",
        finalUrl: "https://x.com",
        title: "t",
        content: "c",
        passages: [],
        traceRoot: "a".repeat(64),
        eventCount: 1,
        truncated: false,
      }),
      probeChromium: () => false,
    });
    expect(entry.mode).toBe("mock");
  });

  it("is real only when both a runner is provided and the probe passes", () => {
    const entry = createBrowserTool({
      runner: async () => ({
        ok: true,
        url: "https://x.com",
        finalUrl: "https://x.com",
        title: "t",
        content: "c",
        passages: [],
        traceRoot: "a".repeat(64),
        eventCount: 1,
        truncated: false,
      }),
      probeChromium: () => true,
    });
    expect(entry.mode).toBe("real");
  });

  it("defaults browsersPath to /opt/pw-browsers, which is real in this sandbox", () => {
    const entry = createBrowserTool({
      runner: async () => ({
        ok: true,
        url: "https://x.com",
        finalUrl: "https://x.com",
        title: "t",
        content: "c",
        passages: [],
        traceRoot: "a".repeat(64),
        eventCount: 1,
        truncated: false,
      }),
    });
    expect(entry.mode).toBe("real");
  });

  it("respects opts.browsersPath over the env/default", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-tool-probe-"));
    try {
      const entry = createBrowserTool({
        runner: async () => ({
          ok: true,
          url: "https://x.com",
          finalUrl: "https://x.com",
          title: "t",
          content: "c",
          passages: [],
          traceRoot: "a".repeat(64),
          eventCount: 1,
          truncated: false,
        }),
        browsersPath: dir,
      });
      expect(entry.mode).toBe("mock");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throwing probeChromium override does not crash construction and yields mock", () => {
    const entry = createBrowserTool({
      runner: async () => {
        throw new Error("unreachable");
      },
      probeChromium: () => {
        throw new Error("probe exploded");
      },
    });
    expect(entry.mode).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// createBrowserTool — mock mode: deterministic, byte-for-byte, honest
// ---------------------------------------------------------------------------

describe("createBrowserTool mock mode", () => {
  const entry = createBrowserTool({ probeChromium: () => false });

  it("returns error envelopes for invalid input rather than throwing", async () => {
    const r = await entry.tool.run("not json");
    expect(r.ok).toBe(false);
    const body = parse(r);
    expect(body.error).toBe("bad-json");
    expect(typeof body.detail).toBe("string");
  });

  it("produces the exact locked mock shape for a well-formed request", async () => {
    const url = "https://example.com/widget";
    const r = await entry.tool.run(JSON.stringify({ op: "browse", url }));
    expect(r.ok).toBe(true);
    const body = parse(r) as unknown as BrowserToolOutput;
    expect(body.mode).toBe("mock");
    expect(body.op).toBe("browse");
    expect(body.url).toBe(url);
    expect(body.finalUrl).toBe(url);
    expect(body.title).toBe("[mock] browser");
    const expectedContent = `[mock] browse of ${url} — no Chromium executable or runner available; deterministic stand-in.`;
    expect(body.content).toBe(expectedContent);
    expect(body.passages).toHaveLength(1);
    expect(body.passages[0]).toEqual({
      text: expectedContent,
      sourceUrl: url,
      selectorPath: "mock:0",
      sha256: sha256Hex(expectedContent),
    });
    expect(body.traceRoot).toBe(sha256Hex(`mock-trace:${url}`));
    expect(/^[0-9a-f]{64}$/.test(body.traceRoot)).toBe(true);
    expect(body.eventCount).toBe(0);
    expect(body.truncated).toBe(false);
    expect(typeof body.note).toBe("string");
    expect((body.note as string).includes("[mock]")).toBe(true);
  });

  it("is byte-for-byte deterministic across repeated calls with the same url", async () => {
    const url = "https://example.com/same";
    const r1 = await entry.tool.run(JSON.stringify({ op: "browse", url }));
    const r2 = await entry.tool.run(JSON.stringify({ op: "browse", url }));
    expect(r1.output).toBe(r2.output);
  });

  it("produces different content for different urls", async () => {
    const r1 = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://a.example.com" }));
    const r2 = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://b.example.com" }));
    expect(r1.output).not.toBe(r2.output);
  });

  it("never touches the runner even if actions/question are supplied", async () => {
    let called = false;
    const withRunner = createBrowserTool({
      probeChromium: () => false, // forces mock even though a runner exists
      runner: async (req: BrowseRequest): Promise<BrowseOutcome> => {
        called = true;
        return {
          ok: true,
          url: req.url,
          finalUrl: req.url,
          title: "should not appear",
          content: "should not appear",
          passages: [],
          traceRoot: "b".repeat(64),
          eventCount: 3,
          truncated: false,
        };
      },
    });
    const r = await withRunner.tool.run(
      JSON.stringify({ op: "browse", url: "https://example.com", question: "q", actions: [{ kind: "click" }] })
    );
    expect(called).toBe(false);
    const body = parse(r) as unknown as BrowserToolOutput;
    expect(body.mode).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// createBrowserTool — real mode: runner outcome mapped verbatim
// ---------------------------------------------------------------------------

describe("createBrowserTool real mode", () => {
  function makeRealTool(runner: (req: BrowseRequest) => Promise<BrowseOutcome>) {
    return createBrowserTool({ probeChromium: () => true, runner });
  }

  it("maps a successful runner outcome verbatim onto the locked output shape", async () => {
    const outcome: BrowseOutcome = {
      ok: true,
      url: "https://example.com/start",
      finalUrl: "https://example.com/final",
      title: "Real Page Title",
      content: "Real extracted content.",
      passages: [
        {
          text: "Real extracted content.",
          sourceUrl: "https://example.com/final",
          selectorPath: "html>body>main>p",
          sha256: sha256Hex("Real extracted content."),
        },
      ],
      traceRoot: "c".repeat(64),
      eventCount: 7,
      truncated: false,
    };
    const entry = makeRealTool(async (req) => {
      expect(req.url).toBe("https://example.com/start");
      expect(req.maxBytes).toBe(200_000);
      expect(req.actions).toEqual([]);
      return outcome;
    });

    const r = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://example.com/start" }));
    expect(r.ok).toBe(true);
    const body = parse(r) as unknown as BrowserToolOutput;
    expect(body).toEqual({
      mode: "real",
      op: "browse",
      url: outcome.url,
      finalUrl: outcome.finalUrl,
      title: outcome.title,
      content: outcome.content,
      passages: outcome.passages,
      traceRoot: outcome.traceRoot,
      eventCount: outcome.eventCount,
      truncated: outcome.truncated,
    });
    expect(JSON.stringify(body).includes("[mock]")).toBe(false);
  });

  it("passes question and actions through to the runner request", async () => {
    const entry = makeRealTool(async (req) => {
      expect(req.question).toBe("what is the price?");
      expect(req.actions).toEqual([{ kind: "click", selector: "#buy" }]);
      return {
        ok: true,
        url: req.url,
        finalUrl: req.url,
        title: "t",
        content: "c",
        passages: [],
        traceRoot: "d".repeat(64),
        eventCount: 1,
        truncated: false,
      };
    });
    await entry.tool.run(
      JSON.stringify({
        op: "browse",
        url: "https://example.com",
        question: "what is the price?",
        actions: [{ kind: "click", selector: "#buy" }],
      })
    );
  });

  it("maps runner ok:false to a browse-failed ToolResult, never a crash", async () => {
    const entry = makeRealTool(async () => ({
      ok: false,
      url: "https://example.com",
      finalUrl: "https://example.com",
      title: "",
      content: "",
      passages: [],
      traceRoot: "e".repeat(64),
      eventCount: 0,
      truncated: false,
      error: "navigation timed out",
    }));
    const r = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://example.com" }));
    expect(r.ok).toBe(false);
    const body = parse(r);
    expect(body.error).toBe("browse-failed");
    expect(body.detail).toBe("navigation timed out");
  });

  it("maps a thrown runner exception to a browse-failed ToolResult, never a crash", async () => {
    const entry = makeRealTool(async () => {
      throw new Error("chromium crashed");
    });
    const r = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://example.com" }));
    expect(r.ok).toBe(false);
    const body = parse(r);
    expect(body.error).toBe("browse-failed");
    expect(body.detail).toBe("chromium crashed");
  });

  it("maps a rejected runner promise (non-Error rejection) to browse-failed without crashing", async () => {
    const entry = makeRealTool(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "a plain string rejection";
    });
    const r = await entry.tool.run(JSON.stringify({ op: "browse", url: "https://example.com" }));
    expect(r.ok).toBe(false);
    const body = parse(r);
    expect(body.error).toBe("browse-failed");
    expect(typeof body.detail).toBe("string");
  });

  it("still validates input before ever calling the runner", async () => {
    let called = false;
    const entry = makeRealTool(async () => {
      called = true;
      throw new Error("should not be called");
    });
    const r = await entry.tool.run(JSON.stringify({ op: "browse", url: "javascript:alert(1)" }));
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(parse(r).error).toBe("bad-url");
  });
});

// ---------------------------------------------------------------------------
// CatalogEntry invariants
// ---------------------------------------------------------------------------

describe("createBrowserTool CatalogEntry invariants", () => {
  it("has the locked ids/category/verifier and matches tool.name", () => {
    const entry = createBrowserTool({ probeChromium: () => false });
    expect(entry.id).toBe(BROWSER_TOOL_ID);
    expect(entry.id).toBe("browser");
    expect(entry.tool.name).toBe("browser");
    expect(entry.category).toBe("web");
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual([]);
    expect(entry.verifierId).toBe(BROWSER_VERIFIER_ID);
    expect(entry.verifierId).toBe("verify.browser");
  });

  it("registers into a fresh ToolCatalog without throwing, in both modes", () => {
    const mockEntry = createBrowserTool({ probeChromium: () => false });
    const catalog1 = new ToolCatalog();
    expect(() => catalog1.add(mockEntry)).not.toThrow();
    expect(catalog1.get("browser")).toBe(mockEntry);

    const realEntry = createBrowserTool({
      probeChromium: () => true,
      runner: async () => ({
        ok: true,
        url: "https://x.com",
        finalUrl: "https://x.com",
        title: "t",
        content: "c",
        passages: [],
        traceRoot: "f".repeat(64),
        eventCount: 1,
        truncated: false,
      }),
    });
    const catalog2 = new ToolCatalog();
    expect(() => catalog2.add(realEntry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tool <-> verifier agreement (the one integration-direction test this
// module is explicitly allowed to own, per the locked contract).
// ---------------------------------------------------------------------------

describe("tool <-> verifier agreement (mock)", () => {
  it("a genuine mock output from the actual tool passes the verifier at full confidence == prior", async () => {
    const { browserToolVerifier, browserCalibration } = await import("../verifier");
    const entry = createBrowserTool({ probeChromium: () => false });
    const input = JSON.stringify({ op: "browse", url: "https://verify-agreement.example.com" });
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(true);

    const verifier = browserToolVerifier();
    const verdict = verifier.verify(input, result);
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.confidence).toBeCloseTo(browserCalibration().prior, 12);
  });

  it("a genuine real output from the actual tool passes the verifier at full confidence == prior", async () => {
    const { browserToolVerifier, browserCalibration } = await import("../verifier");
    const entry = createBrowserTool({
      probeChromium: () => true,
      runner: async (req) => ({
        ok: true,
        url: req.url,
        finalUrl: req.url,
        title: "Real Title",
        content: "Real body text with substance.",
        passages: [
          {
            text: "Real body text with substance.",
            sourceUrl: req.url,
            selectorPath: "html>body>p",
            sha256: sha256Hex("Real body text with substance."),
          },
        ],
        traceRoot: sha256Hex("some-real-trace-payload"),
        eventCount: 4,
        truncated: false,
      }),
    });
    const input = JSON.stringify({ op: "browse", url: "https://real-agreement.example.com" });
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(true);

    const verifier = browserToolVerifier();
    const verdict = verifier.verify(input, result);
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.confidence).toBeCloseTo(browserCalibration().prior, 12);
  });
});
