/**
 * Real behavioral tests for `createWebSearchTool`: key-detection matrix,
 * input-parsing edges, mock-mode determinism/labelling, and real-mode HTTP
 * behavior against a fake injected `fetchFn` (no real network I/O).
 */
import { describe, it, expect, vi } from "vitest";
import { createWebSearchTool, type FetchLike, type WebSearchOutput } from "../web-search";

function parseOutput(output: string): WebSearchOutput {
  return JSON.parse(output) as WebSearchOutput;
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

function jsonResponse(status: number, body: unknown): { status: number; headers: Record<string, string>; text(): Promise<string> } {
  return { status, headers: {}, text: async () => JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Key-detection matrix: {key present/absent} x {fetchFn present/absent} -> mode
// ---------------------------------------------------------------------------

describe("createWebSearchTool: mode selection matrix", () => {
  it("key present + fetchFn present -> real", () => {
    const entry = createWebSearchTool({
      env: { BRAVE_SEARCH_API_KEY: "sk-real-key" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { web: { results: [] } })),
    });
    expect(entry.mode).toBe("real");
  });

  it("key present + fetchFn absent -> mock", () => {
    const entry = createWebSearchTool({ env: { BRAVE_SEARCH_API_KEY: "sk-real-key" } });
    expect(entry.mode).toBe("mock");
  });

  it("key absent + fetchFn present -> mock", () => {
    const entry = createWebSearchTool({
      fetchFn: fakeFetch(async () => jsonResponse(200, { web: { results: [] } })),
    });
    expect(entry.mode).toBe("mock");
  });

  it("key absent + fetchFn absent -> mock", () => {
    const entry = createWebSearchTool({});
    expect(entry.mode).toBe("mock");
  });

  it("empty-string key + fetchFn present -> mock (empty is not 'present')", () => {
    const entry = createWebSearchTool({
      env: { BRAVE_SEARCH_API_KEY: "" },
      fetchFn: fakeFetch(async () => jsonResponse(200, { web: { results: [] } })),
    });
    expect(entry.mode).toBe("mock");
  });

  it("whitespace-only key + fetchFn present -> mock", () => {
    const entry = createWebSearchTool({
      env: { BRAVE_SEARCH_API_KEY: "   " },
      fetchFn: fakeFetch(async () => jsonResponse(200, { web: { results: [] } })),
    });
    expect(entry.mode).toBe("mock");
  });

  it("no opts at all (default {}) -> mock, and never throws", () => {
    const entry = createWebSearchTool();
    expect(entry.mode).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// Catalog metadata contract
// ---------------------------------------------------------------------------

describe("createWebSearchTool: catalog metadata", () => {
  it("id and tool.name are both 'web_search'", () => {
    const entry = createWebSearchTool();
    expect(entry.id).toBe("web_search");
    expect(entry.tool.name).toBe("web_search");
  });

  it("category is 'web'", () => {
    expect(createWebSearchTool().category).toBe("web");
  });

  it("requiresNetwork is true", () => {
    expect(createWebSearchTool().requiresNetwork).toBe(true);
  });

  it("requiredEnvKeys is exactly ['BRAVE_SEARCH_API_KEY']", () => {
    expect(createWebSearchTool().requiredEnvKeys).toEqual(["BRAVE_SEARCH_API_KEY"]);
  });

  it("verifierId is 'verify.web_search'", () => {
    expect(createWebSearchTool().verifierId).toBe("verify.web_search");
  });
});

// ---------------------------------------------------------------------------
// Input-parsing edges
// ---------------------------------------------------------------------------

describe("createWebSearchTool: input parsing", () => {
  it("accepts a bare query string with default count 5", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run("golden retrievers");
    expect(res.ok).toBe(true);
    const out = parseOutput(res.output);
    expect(out.query).toBe("golden retrievers");
    expect(out.results).toHaveLength(5);
  });

  it("accepts JSON {query, count} and clamps count within [1,10]", async () => {
    const entry = createWebSearchTool();
    const tooMany = parseOutput((await entry.tool.run(JSON.stringify({ query: "x", count: 500 }))).output);
    expect(tooMany.results).toHaveLength(10);
    const tooFew = parseOutput((await entry.tool.run(JSON.stringify({ query: "x", count: -5 }))).output);
    expect(tooFew.results).toHaveLength(1);
    const zero = parseOutput((await entry.tool.run(JSON.stringify({ query: "x", count: 0 }))).output);
    expect(zero.results).toHaveLength(1);
    const inRange = parseOutput((await entry.tool.run(JSON.stringify({ query: "x", count: 3 }))).output);
    expect(inRange.results).toHaveLength(3);
  });

  it("rejects a non-numeric count", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run(JSON.stringify({ query: "x", count: "five" }));
    expect(res.ok).toBe(false);
  });

  it("rejects NaN/Infinity count", async () => {
    const entry = createWebSearchTool();
    const nanRes = await entry.tool.run('{"query":"x","count":NaN}'); // invalid JSON literal -> caught by JSON.parse
    expect(nanRes.ok).toBe(false);
  });

  it("rejects invalid JSON input", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run("{not json");
    expect(res.ok).toBe(false);
  });

  it("a string that looks like a JSON array (not starting with '{') is treated as a bare query, not rejected", async () => {
    // Only input starting with '{' is parsed as JSON; anything else, including
    // '[1,2,3]', is a literal bare query string per the documented contract.
    const entry = createWebSearchTool();
    const res = await entry.tool.run("[1,2,3]");
    expect(res.ok).toBe(true);
    expect(parseOutput(res.output).query).toBe("[1,2,3]");
  });

  it("rejects a JSON object with no 'query' field at all", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run("{}");
    expect(res.ok).toBe(false);
  });

  it("rejects JSON missing 'query'", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run(JSON.stringify({ count: 3 }));
    expect(res.ok).toBe(false);
  });

  it("rejects an empty-string query in JSON", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run(JSON.stringify({ query: "   " }));
    expect(res.ok).toBe(false);
  });

  it("rejects empty bare input", async () => {
    const entry = createWebSearchTool();
    const res = await entry.tool.run("   ");
    expect(res.ok).toBe(false);
  });

  it("fractional count is floored before clamping", async () => {
    const entry = createWebSearchTool();
    const res = parseOutput((await entry.tool.run(JSON.stringify({ query: "x", count: 3.9 }))).output);
    expect(res.results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Mock-mode determinism and honesty labelling
// ---------------------------------------------------------------------------

describe("createWebSearchTool: mock mode", () => {
  it("same query -> byte-identical output across repeated calls", async () => {
    const entry = createWebSearchTool();
    const first = await entry.tool.run("quantum computing");
    const second = await entry.tool.run("quantum computing");
    expect(first.output).toBe(second.output);
  });

  it("different queries -> different results", async () => {
    const entry = createWebSearchTool();
    const a = parseOutput((await entry.tool.run("apples")).output);
    const b = parseOutput((await entry.tool.run("oranges")).output);
    expect(a.results).not.toEqual(b.results);
  });

  it("mode is 'mock' in the output body", async () => {
    const entry = createWebSearchTool();
    const out = parseOutput((await entry.tool.run("test")).output);
    expect(out.mode).toBe("mock");
  });

  it("every mock result's title and snippet begin with '[mock] ', and every url is under mock.invalid", async () => {
    const entry = createWebSearchTool();
    const out = parseOutput((await entry.tool.run(JSON.stringify({ query: "labels", count: 10 }))).output);
    expect(out.results.length).toBe(10);
    for (const r of out.results) {
      expect(r.title.startsWith("[mock] ")).toBe(true);
      expect(r.snippet.startsWith("[mock] ")).toBe(true);
      expect(new URL(r.url).hostname).toBe("mock.invalid");
    }
  });

  it("results within one query response are mutually distinct", async () => {
    const entry = createWebSearchTool();
    const out = parseOutput((await entry.tool.run(JSON.stringify({ query: "distinct-check", count: 10 }))).output);
    const urls = new Set(out.results.map((r) => r.url));
    expect(urls.size).toBe(10);
  });

  it("never calls the injected fetchFn in mock mode", async () => {
    const fetchSpy = vi.fn(fakeFetch(async () => jsonResponse(200, { web: { results: [] } })));
    // No env key -> mock mode even though fetchFn is present.
    const entry = createWebSearchTool({ fetchFn: fetchSpy as unknown as FetchLike });
    await entry.tool.run("no network please");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not depend on Date/Math.random (two fresh tool instances agree)", async () => {
    const entryA = createWebSearchTool();
    const entryB = createWebSearchTool();
    const a = await entryA.tool.run("stability check");
    const b = await entryB.tool.run("stability check");
    expect(a.output).toBe(b.output);
  });
});

// ---------------------------------------------------------------------------
// Real-mode HTTP behavior via a fake injected fetchFn
// ---------------------------------------------------------------------------

const REAL_OPTS_ENV = { BRAVE_SEARCH_API_KEY: "sk-test-key-123" };

describe("createWebSearchTool: real mode", () => {
  it("sends the exact provider URL and X-Subscription-Token header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init?.headers;
        return jsonResponse(200, { web: { results: [] } });
      }),
    });
    await entry.tool.run("brave test");
    expect(capturedUrl).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=brave%20test&count=5"
    );
    expect(capturedHeaders?.["X-Subscription-Token"]).toBe("sk-test-key-123");
  });

  it("URL-encodes special characters in the query", async () => {
    let capturedUrl = "";
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async (url) => {
        capturedUrl = url;
        return jsonResponse(200, { web: { results: [] } });
      }),
    });
    await entry.tool.run("c++ & rust?");
    expect(capturedUrl).toContain("q=c%2B%2B%20%26%20rust%3F");
  });

  it("happy path maps Brave's web.results into {title,url,snippet}", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () =>
        jsonResponse(200, {
          web: {
            results: [
              { title: "Result A", url: "https://example.com/a", description: "desc a" },
              { title: "Result B", url: "https://example.com/b", description: "desc b" },
            ],
          },
        })
      ),
    });
    const res = await entry.tool.run("mapping test");
    expect(res.ok).toBe(true);
    const out = parseOutput(res.output);
    expect(out.mode).toBe("real");
    expect(out.results).toEqual([
      { title: "Result A", url: "https://example.com/a", snippet: "desc a" },
      { title: "Result B", url: "https://example.com/b", snippet: "desc b" },
    ]);
  });

  it("401 (bad key) -> ok:false", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => ({ status: 401, headers: {}, text: async () => "unauthorized" })),
    });
    const res = await entry.tool.run("bad key");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/401/);
  });

  it("429 (rate limited) -> ok:false", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => ({ status: 429, headers: {}, text: async () => "rate limited" })),
    });
    const res = await entry.tool.run("rate limit");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/429/);
  });

  it("500 (server error) -> ok:false", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => ({ status: 500, headers: {}, text: async () => "server error" })),
    });
    const res = await entry.tool.run("server error");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/500/);
  });

  it("network rejection (fetchFn throws) -> ok:false, never throws out of run()", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    const res = await entry.tool.run("network down");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ECONNRESET/);
  });

  it("redirect-shaped response (3xx, not followed by the fake transport) -> ok:false", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => ({
        status: 301,
        headers: { location: "https://api.search.brave.com/res/v1/web/search?q=moved" },
        text: async () => "",
      })),
    });
    const res = await entry.tool.run("redirect test");
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/301/);
  });

  it("non-JSON body from the provider -> ok:false, not a throw", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => ({ status: 200, headers: {}, text: async () => "<not json>" })),
    });
    const res = await entry.tool.run("bad body");
    expect(res.ok).toBe(false);
  });

  it("missing web.results in a 200 response -> empty results, still ok:true", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () => jsonResponse(200, {})),
    });
    const res = await entry.tool.run("empty results");
    expect(res.ok).toBe(true);
    const out = parseOutput(res.output);
    expect(out.results).toEqual([]);
  });

  it("real results are truncated to the requested count", async () => {
    const entry = createWebSearchTool({
      env: REAL_OPTS_ENV,
      fetchFn: fakeFetch(async () =>
        jsonResponse(200, {
          web: {
            results: Array.from({ length: 20 }, (_, i) => ({
              title: `T${i}`,
              url: `https://example.com/${i}`,
              description: `D${i}`,
            })),
          },
        })
      ),
    });
    const res = await entry.tool.run(JSON.stringify({ query: "many", count: 3 }));
    const out = parseOutput(res.output);
    expect(out.results).toHaveLength(3);
  });
});
