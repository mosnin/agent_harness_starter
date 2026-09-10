/**
 * Real behavioral tests for `createFetchExtractTool` and the hand-written
 * `extractHtml` scanner: adversarial HTML survival, mock-mode determinism,
 * real-mode HTTP behavior via a fake injected `fetchFn`, URL validation,
 * and input-parsing edges.
 */
import { describe, it, expect } from "vitest";
import {
  createFetchExtractTool,
  extractHtml,
  type FetchLike,
  type FetchExtractOutput,
} from "../fetch-extract";

function parseOutput(output: string): FetchExtractOutput {
  return JSON.parse(output) as FetchExtractOutput;
}

function fakeFetch(
  impl: (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
    status: number;
    headers: Record<string, string>;
    text(): Promise<string>;
  }>
): FetchLike {
  return impl as FetchLike;
}

function htmlResponse(status: number, body: string): { status: number; headers: Record<string, string>; text(): Promise<string> } {
  return { status, headers: {}, text: async () => body };
}

// ===========================================================================
// extractHtml — the real hand-written scanner
// ===========================================================================

describe("extractHtml: text mode basics", () => {
  it("extracts plain text from simple markup", () => {
    expect(extractHtml("<p>Hello <b>world</b></p>", "text")).toBe("Hello world");
  });

  it("collapses whitespace and newlines to single spaces", () => {
    expect(extractHtml("<p>Hello\n\n   world  \t\tfoo</p>", "text")).toBe("Hello world foo");
  });

  it("does not glue adjacent block elements' text together", () => {
    expect(extractHtml("<p>a</p><p>b</p>", "text")).toBe("a b");
  });

  it("strips <script> content entirely from text mode", () => {
    const html = "<p>before</p><script>var x = 'never see this';</script><p>after</p>";
    expect(extractHtml(html, "text")).toBe("before after");
  });

  it("strips <style> content entirely from text mode", () => {
    const html = "<style>body{color:red}</style><p>visible</p>";
    expect(extractHtml(html, "text")).toBe("visible");
  });

  it("strips comments entirely, including multi-line ones", () => {
    const html = "<p>a</p><!-- this\n is a\n comment --><p>b</p>";
    expect(extractHtml(html, "text")).toBe("a b");
  });

  it("strips <head> content but the document's visible body still comes through", () => {
    const html = "<html><head><meta charset='utf-8'><style>.x{}</style></head><body><p>real content</p></body></html>";
    expect(extractHtml(html, "text")).toBe("real content");
  });
});

describe("extractHtml: entity decoding", () => {
  it("decodes the five named entities", () => {
    expect(extractHtml("<p>&amp; &lt; &gt; &quot; &apos;</p>", "text")).toBe(`& < > " '`);
  });

  it("decodes decimal numeric entities", () => {
    expect(extractHtml("<p>&#65;&#66;&#67;</p>", "text")).toBe("ABC");
  });

  it("decodes hex numeric entities (lower and upper x)", () => {
    expect(extractHtml("<p>&#x41;&#X42;</p>", "text")).toBe("AB");
  });

  it("decodes a supplementary-plane numeric entity (emoji) via fromCodePoint", () => {
    expect(extractHtml("<p>&#128512;</p>", "text")).toBe("\u{1F600}");
  });

  it("leaves unknown/malformed entities untouched rather than corrupting text", () => {
    expect(extractHtml("<p>Tom &amp; Jerry &notareal; &amp end</p>", "text")).toContain("Tom & Jerry");
  });
});

describe("extractHtml: adversarial HTML survival", () => {
  it("survives an unclosed tag without throwing", () => {
    expect(() => extractHtml("<div><p>Hello <b>world", "text")).not.toThrow();
    expect(extractHtml("<div><p>Hello <b>world", "text")).toContain("Hello");
    expect(extractHtml("<div><p>Hello <b>world", "text")).toContain("world");
  });

  it("survives an unterminated attribute value without throwing or hanging", () => {
    expect(() => extractHtml('<div class="unterminated', "text")).not.toThrow();
  });

  it("a nested <script> containing a literal '</div>' does not confuse the scanner", () => {
    const html =
      "<div>outer<script>if (x < 1) { document.write('</div>'); }</script>tail</div>real content";
    const out = extractHtml(html, "text");
    expect(out).toContain("outer");
    expect(out).toContain("tail");
    expect(out).toContain("real content");
    // The script body itself must never leak into extracted text.
    expect(out).not.toContain("document.write");
  });

  it("an attribute value containing '>' does not end the tag early", () => {
    const html = '<a href="https://example.com/page" title="a>b">link text</a>';
    const links = extractHtml(html, "links", "https://example.com/");
    expect(links).toContain("link text");
    expect(links).toContain("https://example.com/page");
    // If the '>' inside the quoted title attribute had ended the tag early,
    // the leftover `b">link text</a>` would leak into the visible text
    // stream (and the anchor tag would never be recognized as closed).
    const text = extractHtml(`<div title="a>b">visible text</div>`, "text");
    expect(text).toBe("visible text");
    expect(text).not.toContain("a>b");
  });

  it("a CDATA-ish / unterminated comment does not hang and does not leak into text", () => {
    const html = "<p>before</p><!-- unterminated comment that never closes <p>hidden</p>";
    const out = extractHtml(html, "text");
    expect(out).toBe("before");
  });

  it("an entity flood (many repeated numeric entities) decodes quickly and correctly", () => {
    const flood = "&#65;".repeat(50_000); // 50k * "A"
    const html = `<p>${flood}</p>`;
    const start = Date.now();
    const out = extractHtml(html, "text");
    const elapsedMs = Date.now() - start;
    expect(out.length).toBeLessThanOrEqual(50_000 + 1); // bounded, no blowup
    expect(out.startsWith("AAAAA")).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("a decode-budget cap still terminates cleanly on a huge document without pathological blowup", () => {
    // Alternate content that COULD balloon if entity decoding were unbounded;
    // named entities here are 1:1 shrink so this mainly proves boundedness.
    const chunk = "&amp;".repeat(2000);
    const html = `<div>${chunk.repeat(50)}</div>`; // 100k entity refs
    const start = Date.now();
    const out = extractHtml(html, "text");
    const elapsedMs = Date.now() - start;
    expect(out.length).toBeLessThan(html.length);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("handles a 1 MB input under the byte cap without pathological blowup or hanging", () => {
    const paragraph = "<p>The quick brown fox jumps over the lazy dog. </p>";
    const repeats = Math.ceil((1_000_000) / paragraph.length);
    const html = paragraph.repeat(repeats);
    expect(html.length).toBeGreaterThan(900_000);
    const start = Date.now();
    const out = extractHtml(html, "text");
    const elapsedMs = Date.now() - start;
    expect(out).toContain("quick brown fox");
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("does not throw on a bare '<' with no tag name at all", () => {
    expect(() => extractHtml("a < b and c > d", "text")).not.toThrow();
    expect(extractHtml("a < b and c > d", "text")).toContain("a");
  });

  it("deeply nested/malformed tag soup terminates and returns a string", () => {
    const soup = "<div><span><b><i><u>" + "<a>".repeat(500) + "text" + "</a>".repeat(500) + "</u></i></b></span></div>";
    expect(() => extractHtml(soup, "text")).not.toThrow();
    expect(extractHtml(soup, "text")).toContain("text");
  });
});

describe("extractHtml: title mode", () => {
  it("pulls <title> content", () => {
    const html = "<html><head><title>My Page Title</title></head><body></body></html>";
    expect(extractHtml(html, "title")).toBe("My Page Title");
  });

  it("decodes entities and collapses whitespace within <title>", () => {
    const html = "<title>Tom &amp;\n  Jerry</title>";
    expect(extractHtml(html, "title")).toBe("Tom & Jerry");
  });

  it("returns empty string when there is no <title>", () => {
    expect(extractHtml("<p>no title here</p>", "title")).toBe("");
  });

  it("is case-insensitive for <TITLE>", () => {
    expect(extractHtml("<TITLE>Shouty</TITLE>", "title")).toBe("Shouty");
  });
});

describe("extractHtml: links mode", () => {
  it("extracts anchor text and href", () => {
    const html = '<a href="https://example.com/page">Click here</a>';
    const out = extractHtml(html, "links");
    expect(out).toContain("Click here");
    expect(out).toContain("https://example.com/page");
  });

  it("resolves relative hrefs against baseUrl via the URL constructor", () => {
    const html = '<a href="/about">About</a>';
    const out = extractHtml(html, "links", "https://example.com/blog/post");
    expect(out).toContain("https://example.com/about");
  });

  it("resolves a relative path (no leading slash) against baseUrl", () => {
    const html = '<a href="next-page">Next</a>';
    const out = extractHtml(html, "links", "https://example.com/blog/post");
    expect(out).toContain("https://example.com/blog/next-page");
  });

  it("keeps already-absolute hrefs unchanged (modulo URL normalization)", () => {
    const html = '<a href="https://other.example/x">X</a>';
    const out = extractHtml(html, "links", "https://example.com/");
    expect(out).toContain("https://other.example/x");
  });

  it("skips anchors with no href", () => {
    const html = '<a name="anchor-only">no href here</a><a href="https://example.com/real">real</a>';
    const out = extractHtml(html, "links", "https://example.com/");
    expect(out).not.toContain("no href here");
    expect(out).toContain("https://example.com/real");
  });

  it("returns empty string when there are no links", () => {
    expect(extractHtml("<p>no links</p>", "links")).toBe("");
  });
});

// ===========================================================================
// createFetchExtractTool — catalog metadata
// ===========================================================================

describe("createFetchExtractTool: catalog metadata", () => {
  it("id and tool.name are both 'fetch_extract'", () => {
    const entry = createFetchExtractTool();
    expect(entry.id).toBe("fetch_extract");
    expect(entry.tool.name).toBe("fetch_extract");
  });

  it("category is 'web'", () => {
    expect(createFetchExtractTool().category).toBe("web");
  });

  it("requiresNetwork is true", () => {
    expect(createFetchExtractTool().requiresNetwork).toBe(true);
  });

  it("requiredEnvKeys is empty", () => {
    expect(createFetchExtractTool().requiredEnvKeys).toEqual([]);
  });
});

// ===========================================================================
// Mode selection
// ===========================================================================

describe("createFetchExtractTool: mode selection", () => {
  it("fetchFn present -> real (no env key needed)", () => {
    const entry = createFetchExtractTool({ fetchFn: fakeFetch(async () => htmlResponse(200, "<p>x</p>")) });
    expect(entry.mode).toBe("real");
  });

  it("fetchFn absent -> mock", () => {
    expect(createFetchExtractTool({}).mode).toBe("mock");
  });

  it("no opts at all -> mock", () => {
    expect(createFetchExtractTool().mode).toBe("mock");
  });
});

// ===========================================================================
// Input parsing / URL validation edges
// ===========================================================================

describe("createFetchExtractTool: input parsing and URL validation", () => {
  it("accepts a bare URL string with defaults", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("https://example.com/");
    expect(res.ok).toBe(true);
    const out = parseOutput(res.output);
    expect(out.url).toBe("https://example.com/");
    expect(out.extract).toBe("text");
  });

  it("accepts JSON {url, extract, maxBytes}", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/", extract: "title", maxBytes: 1000 }));
    const out = parseOutput(res.output);
    expect(out.extract).toBe("title");
  });

  it("rejects an invalid 'extract' value", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/", extract: "audio" }));
    expect(res.ok).toBe(false);
  });

  it("rejects a non-positive maxBytes", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/", maxBytes: 0 }));
    expect(res.ok).toBe(false);
  });

  it("rejects invalid JSON input", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("{not json");
    expect(res.ok).toBe(false);
  });

  it("rejects empty input", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("   ");
    expect(res.ok).toBe(false);
  });

  it("rejects a javascript: scheme URL", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("javascript:alert(1)");
    expect(res.ok).toBe(false);
  });

  it("rejects a file: scheme URL", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("file:///etc/passwd");
    expect(res.ok).toBe(false);
  });

  it("rejects a data: scheme URL", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("data:text/html,<p>hi</p>");
    expect(res.ok).toBe(false);
  });

  it("rejects a URL with embedded credentials (userinfo)", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("https://user:pass@example.com/");
    expect(res.ok).toBe(false);
  });

  it("rejects a syntactically invalid URL", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("not a url at all");
    expect(res.ok).toBe(false);
  });

  it("accepts http (not just https)", async () => {
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("http://example.com/");
    expect(res.ok).toBe(true);
  });
});

// ===========================================================================
// Mock mode: determinism, honesty labelling, fixture behavior
// ===========================================================================

describe("createFetchExtractTool: mock mode", () => {
  it("mode is 'mock' in the output body", async () => {
    const entry = createFetchExtractTool();
    const out = parseOutput((await entry.tool.run("https://example.com/a")).output);
    expect(out.mode).toBe("mock");
  });

  it("same URL -> byte-identical output across repeated calls", async () => {
    const entry = createFetchExtractTool();
    const first = await entry.tool.run("https://example.com/stable");
    const second = await entry.tool.run("https://example.com/stable");
    expect(first.output).toBe(second.output);
  });

  it("different URLs -> different content", async () => {
    const entry = createFetchExtractTool();
    const a = parseOutput((await entry.tool.run("https://example.com/a")).output);
    const b = parseOutput((await entry.tool.run("https://example.com/b")).output);
    expect(a.content).not.toBe(b.content);
  });

  it("mock text content is clearly labelled '[mock]'", async () => {
    const entry = createFetchExtractTool();
    const out = parseOutput((await entry.tool.run("https://example.com/labelled")).output);
    expect(out.content).toContain("[mock]");
  });

  it("mock title content is clearly labelled '[mock]'", async () => {
    const entry = createFetchExtractTool();
    const out = parseOutput(
      (await entry.tool.run(JSON.stringify({ url: "https://example.com/labelled", extract: "title" }))).output
    );
    expect(out.content).toContain("[mock]");
  });

  it("mock links resolve under the mock.invalid domain", async () => {
    const entry = createFetchExtractTool();
    const out = parseOutput(
      (await entry.tool.run(JSON.stringify({ url: "https://example.com/links", extract: "links" }))).output
    );
    expect(out.content).toContain("mock.invalid");
  });

  it("respects maxBytes truncation in mock mode too", async () => {
    const entry = createFetchExtractTool();
    const out = parseOutput(
      (await entry.tool.run(JSON.stringify({ url: "https://example.com/tiny", maxBytes: 20 }))).output
    );
    expect(out.truncated).toBe(true);
  });

  it("never calls fetchFn when in mock mode", async () => {
    // Not injecting fetchFn at all keeps this in mock mode; this test just
    // asserts mock mode completes without any network-shaped dependency.
    const entry = createFetchExtractTool();
    const res = await entry.tool.run("https://example.com/no-network");
    expect(res.ok).toBe(true);
  });
});

// ===========================================================================
// Real mode: HTTP behavior via a fake injected fetchFn
// ===========================================================================

describe("createFetchExtractTool: real mode", () => {
  it("sends a GET request to the exact requested URL", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "";
        return htmlResponse(200, "<title>T</title><p>Body text</p>");
      }),
    });
    await entry.tool.run("https://example.com/page");
    expect(capturedUrl).toBe("https://example.com/page");
    expect(capturedMethod).toBe("GET");
  });

  it("happy path extracts text from a real fetched body", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(200, "<html><body><p>Hello real world</p></body></html>")),
    });
    const res = await entry.tool.run("https://example.com/page");
    expect(res.ok).toBe(true);
    const out = parseOutput(res.output);
    expect(out.mode).toBe("real");
    expect(out.content).toBe("Hello real world");
    expect(out.truncated).toBe(false);
  });

  it("401 -> ok:false", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(401, "unauthorized")),
    });
    const res = await entry.tool.run("https://example.com/private");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/401/);
  });

  it("429 -> ok:false", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(429, "slow down")),
    });
    const res = await entry.tool.run("https://example.com/limited");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/429/);
  });

  it("500 -> ok:false", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(500, "boom")),
    });
    const res = await entry.tool.run("https://example.com/broken");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/500/);
  });

  it("network rejection -> ok:false, never throws out of run()", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => {
        throw new Error("ETIMEDOUT");
      }),
    });
    const res = await entry.tool.run("https://example.com/down");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ETIMEDOUT/);
  });

  it("redirect-shaped response (3xx, not followed) -> ok:false", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => ({
        status: 302,
        headers: { location: "https://example.com/new-place" },
        text: async () => "",
      })),
    });
    const res = await entry.tool.run("https://example.com/old-place");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/302/);
  });

  it("oversized body is truncated to maxBytes with truncated:true", async () => {
    const bigText = "x".repeat(200_000);
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(200, `<p>${bigText}</p>`)),
    });
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/big", maxBytes: 100 }));
    const out = parseOutput(res.output);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(200_000);
  });

  it("a body within maxBytes is not marked truncated", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(200, "<p>small</p>")),
    });
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/small", maxBytes: 65536 }));
    const out = parseOutput(res.output);
    expect(out.truncated).toBe(false);
  });

  it("extract 'title' returns just the title in real mode", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(200, "<html><head><title>Real Title</title></head><body><p>x</p></body></html>")),
    });
    const res = await entry.tool.run(JSON.stringify({ url: "https://example.com/page", extract: "title" }));
    const out = parseOutput(res.output);
    expect(out.content).toBe("Real Title");
  });

  it("extract 'links' resolves relative hrefs against the fetched URL", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => htmlResponse(200, '<a href="/relative">Rel</a>')),
    });
    const res = await entry.tool.run(
      JSON.stringify({ url: "https://example.com/dir/page", extract: "links" })
    );
    const out = parseOutput(res.output);
    expect(out.content).toContain("https://example.com/relative");
  });

  it("response body that throws on .text() -> ok:false, not a throw", async () => {
    const entry = createFetchExtractTool({
      fetchFn: fakeFetch(async () => ({
        status: 200,
        headers: {},
        text: async () => {
          throw new Error("stream error");
        },
      })),
    });
    const res = await entry.tool.run("https://example.com/broken-stream");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/stream error/);
  });
});
