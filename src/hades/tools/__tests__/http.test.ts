/**
 * Tests for `http_request`: the full `isForbiddenHost` SSRF matrix
 * (table-driven, including exotic integer IPv4 encodings), allowHosts
 * interplay, header redaction, mock-mode determinism/labelling, and
 * fake-fetch coverage of status/rejection/truncation.
 */
import { describe, it, expect } from "vitest";
import { createHttpTool, isForbiddenHost, type FetchLike, type CatalogEntry } from "../http";

async function runTool(entry: CatalogEntry, input: string) {
  const result = await entry.tool.run(input);
  return { ok: result.ok, body: JSON.parse(result.output) };
}

/* ------------------------------------------------------------------ *
 * isForbiddenHost — table-driven matrix
 * ------------------------------------------------------------------ */

describe("isForbiddenHost", () => {
  const forbidden: string[] = [
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "a.b.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.20.5.9",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.169.254", // cloud metadata endpoint
    "169.254.0.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "feb0::1",
    "::ffff:127.0.0.1",
    // exotic single-integer IPv4 encodings, all == 127.0.0.1
    "2130706433",
    "0x7f000001",
    "0X7F000001",
    "017700000001",
  ];

  const allowed: string[] = [
    "example.com",
    "api.example.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.0", // just above 172.16/12
    "192.169.0.1", // not 192.168/16
    "169.253.255.255", // not 169.254/16
    "169.255.0.0",
    "9.255.255.255", // not 10/8
    "11.0.0.0", // not 10/8
    "2001:4860:4860::8888", // public IPv6 (Google DNS)
    "notlocalhost.example.com",
  ];

  it.each(forbidden)("blocks forbidden host: %s", (host) => {
    expect(isForbiddenHost(host)).toBe(true);
  });

  it.each(allowed)("allows public host: %s", (host) => {
    expect(isForbiddenHost(host)).toBe(false);
  });

  it("treats an empty host as forbidden", () => {
    expect(isForbiddenHost("")).toBe(true);
    expect(isForbiddenHost("   ")).toBe(true);
  });

  it("the three exotic encodings all resolve to the same forbidden 127.0.0.1", () => {
    expect(isForbiddenHost("2130706433")).toBe(true);
    expect(isForbiddenHost("0x7f000001")).toBe(true);
    expect(isForbiddenHost("017700000001")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Catalog metadata
 * ------------------------------------------------------------------ */

describe("createHttpTool: catalog metadata", () => {
  it("is mode:mock with no fetchFn injected", () => {
    const entry = createHttpTool({});
    expect(entry.mode).toBe("mock");
    expect(entry.id).toBe("http_request");
    expect(entry.tool.name).toBe("http_request");
    expect(entry.category).toBe("system");
    expect(entry.requiresNetwork).toBe(true);
    expect(entry.requiredEnvKeys).toEqual([]);
    expect(entry.verifierId).toBe("verify.http_request");
  });

  it("is mode:real when a fetchFn is injected", () => {
    const fetchFn: FetchLike = async () => ({
      status: 200,
      headers: {},
      text: async () => "",
    });
    const entry = createHttpTool({ fetchFn });
    expect(entry.mode).toBe("real");
  });
});

/* ------------------------------------------------------------------ *
 * SSRF gate wired through the tool
 * ------------------------------------------------------------------ */

describe("createHttpTool: SSRF gate", () => {
  it("rejects a request to a forbidden host before ever calling fetchFn", async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return { status: 200, headers: {}, text: async () => "" };
    };
    const entry = createHttpTool({ fetchFn });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "http://127.0.0.1/admin" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/forbidden host/);
    expect(called).toBe(false);
  });

  it("rejects a non-http(s) scheme", async () => {
    const entry = createHttpTool({ fetchFn: async () => ({ status: 200, headers: {}, text: async () => "" }) });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "file:///etc/passwd" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/forbidden scheme/);
  });

  it("rejects an invalid URL", async () => {
    const entry = createHttpTool({ fetchFn: async () => ({ status: 200, headers: {}, text: async () => "" }) });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "not a url" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/invalid url/);
  });

  it("allows a public host through to fetchFn", async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return { status: 200, headers: { "content-type": "text/plain" }, text: async () => "hi" };
    };
    const entry = createHttpTool({ fetchFn });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/" }));
    expect(r.ok).toBe(true);
    expect(called).toBe(true);
    expect(r.body.body).toBe("hi");
  });
});

describe("createHttpTool: allowHosts interplay", () => {
  it("allowHosts is applied AFTER the forbidden-host check: it cannot rescue a forbidden literal", async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return { status: 200, headers: {}, text: async () => "" };
    };
    const entry = createHttpTool({ fetchFn, allowHosts: ["127.0.0.1"] });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "http://127.0.0.1/" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/forbidden host/);
    expect(called).toBe(false);
  });

  it("rejects a public host not present in allowHosts", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "" }),
      allowHosts: ["good.example.com"],
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://evil.example.com/" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/not in allowlist/);
  });

  it("allows a public host present in allowHosts", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "ok" }),
      allowHosts: ["good.example.com"],
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://good.example.com/" }));
    expect(r.ok).toBe(true);
  });

  it("with no allowHosts set, any non-forbidden host is allowed", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "ok" }),
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://anything.example.org/" }));
    expect(r.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Header redaction
 * ------------------------------------------------------------------ */

describe("createHttpTool: sensitive header redaction", () => {
  it("redacts Authorization and Cookie (case-insensitive) in the echoed output", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "ok" }),
    });
    const r = await runTool(
      entry,
      JSON.stringify({
        method: "GET",
        url: "https://example.com/",
        headers: { Authorization: "Bearer secret-token", COOKIE: "session=abc123", "X-Trace": "keep-me" },
      })
    );
    expect(r.body.requestHeaders.Authorization).toBe("[redacted]");
    expect(r.body.requestHeaders.COOKIE).toBe("[redacted]");
    expect(r.body.requestHeaders["X-Trace"]).toBe("keep-me");
  });

  it("redacts headers even on a rejected (forbidden-host) request", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "ok" }),
    });
    // Forbidden host short-circuits before headers would even be echoed
    // in this implementation (the error path doesn't include headers at
    // all) — assert no leakage occurs either way.
    const r = await runTool(
      entry,
      JSON.stringify({
        method: "GET",
        url: "http://localhost/",
        headers: { Authorization: "Bearer leak-me" },
      })
    );
    expect(JSON.stringify(r.body)).not.toContain("leak-me");
  });
});

/* ------------------------------------------------------------------ *
 * Mock mode: determinism + labelling
 * ------------------------------------------------------------------ */

describe("createHttpTool: mock mode", () => {
  it("labels output with mode:'mock' and a '[mock] ' prefixed body", async () => {
    const entry = createHttpTool({});
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/x" }));
    expect(r.body.mode).toBe("mock");
    expect(r.body.body).toMatch(/^\[mock\] /);
  });

  it("is deterministic: identical input produces identical mock output across calls", async () => {
    const entry1 = createHttpTool({});
    const entry2 = createHttpTool({});
    const input = JSON.stringify({ method: "POST", url: "https://example.com/submit", body: "payload" });
    const r1 = await runTool(entry1, input);
    const r2 = await runTool(entry2, input);
    expect(r1.body.status).toBe(r2.body.status);
    expect(r1.body.body).toBe(r2.body.body);
  });

  it("varies output across genuinely different inputs (not a constant stub)", async () => {
    const entry = createHttpTool({});
    const r1 = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/a" }));
    const r2 = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/completely-different-path-xyz" }));
    expect(r1.body.body).not.toBe(r2.body.body);
  });

  it("still applies the SSRF gate in mock mode", async () => {
    const entry = createHttpTool({});
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "http://169.254.169.254/latest/meta-data/" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/forbidden host/);
  });
});

/* ------------------------------------------------------------------ *
 * Fake fetch: status, rejection, truncation
 * ------------------------------------------------------------------ */

describe("createHttpTool: fake-fetch behavior", () => {
  it("reports ok:false for a 4xx/5xx response status", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 404, headers: {}, text: async () => "not found" }),
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/missing" }));
    expect(r.ok).toBe(false);
    expect(r.body.status).toBe(404);
  });

  it("reports ok:true for a 2xx response status", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 201, headers: {}, text: async () => "created" }),
    });
    const r = await runTool(entry, JSON.stringify({ method: "POST", url: "https://example.com/create" }));
    expect(r.ok).toBe(true);
    expect(r.body.status).toBe(201);
  });

  it("surfaces a fetchFn rejection as ok:false, not a throw", async () => {
    const entry = createHttpTool({
      fetchFn: async () => {
        throw new Error("network unreachable");
      },
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/" }));
    expect(r.ok).toBe(false);
    expect(r.body.error).toMatch(/network unreachable/);
  });

  it("truncates the body at maxBytes and reports truncated:true", async () => {
    const bigBody = "y".repeat(1000);
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => bigBody }),
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/", maxBytes: 50 }));
    expect(r.body.body.length).toBe(50);
    expect(r.body.truncated).toBe(true);
  });

  it("does not report truncated when body fits under maxBytes", async () => {
    const entry = createHttpTool({
      fetchFn: async () => ({ status: 200, headers: {}, text: async () => "short" }),
    });
    const r = await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/", maxBytes: 1000 }));
    expect(r.body.truncated).toBe(false);
  });

  it("omits the body from a GET/HEAD request but includes it for POST", async () => {
    let seenBody: string | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      seenBody = init?.body;
      return { status: 200, headers: {}, text: async () => "ok" };
    };
    const entry = createHttpTool({ fetchFn });
    await runTool(entry, JSON.stringify({ method: "GET", url: "https://example.com/", body: "should-be-dropped" }));
    expect(seenBody).toBeUndefined();

    await runTool(entry, JSON.stringify({ method: "POST", url: "https://example.com/", body: "payload-data" }));
    expect(seenBody).toBe("payload-data");
  });
});

/* ------------------------------------------------------------------ *
 * Malformed input never throws
 * ------------------------------------------------------------------ */

describe("createHttpTool: malformed input never throws", () => {
  const malformed = [
    "not json",
    "{",
    "[]",
    "null",
    "42",
    "{}",
    '{"method":"GET"}',
    '{"method":"TRACE","url":"https://example.com"}',
    '{"method":"GET","url":123}',
    '{"method":"GET","url":""}',
    '{"method":"GET","url":"https://example.com","headers":"nope"}',
    '{"method":"GET","url":"https://example.com","headers":{"x":1}}',
    '{"method":"GET","url":"https://example.com","body":123}',
    '{"method":"GET","url":"https://example.com","maxBytes":-5}',
    '{"method":"GET","url":"https://example.com","maxBytes":"nope"}',
  ];

  it.each(malformed)("returns ok:false for malformed input %#", async (input) => {
    const entry = createHttpTool({});
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(false);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it("survives a seeded fuzz loop of 200 malformed inputs without throwing", async () => {
    const entry = createHttpTool({});
    let seed = 55555;
    function rand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    const chars = '{}[]":,0123456789abcXYZ.._-/\\% \n\thtpGETsPO';
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(rand() * 60);
      let s = "";
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(rand() * chars.length)];
      }
      const result = await entry.tool.run(s);
      expect(typeof result.output).toBe("string");
      expect(() => JSON.parse(result.output)).not.toThrow();
    }
  });
});
