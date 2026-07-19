/**
 * Phase 3 CENTRAL-INTEGRATION tests — the wiring the build teams were
 * forbidden from doing, exercised end-to-end through the PRODUCT paths:
 *
 *  - the `browser` tool is in the shipped default catalog, its verifier
 *    is in the one product verifier registry, and the two agree;
 *  - `createBrowseRunner` (runner.ts: driver + extract + trace composed)
 *    drives a REAL headless Chromium against a REAL local node:http
 *    fixture — passages hash-verify, actions genuinely mutate the DOM,
 *    the trace chain roots to a verified certificate;
 *  - a GENUINE real-mode output and a GENUINE mock-mode output each pass
 *    `verify.browser` at exactly its calibrated prior;
 *  - failure paths are honest (`ok:false`, never fabricated content);
 *  - the `hades browser` CLI routes work through `HadesCli` itself.
 *
 * REAL-VS-MOCK POLICY: no mocks anywhere in this file. The browser is the
 * real installed Chromium (same policy as driver.test.ts / browse-bench
 * .test.ts — this environment ships /opt/pw-browsers); the server is a
 * real node:http listener on 127.0.0.1; hashes are recomputed with an
 * independent node:crypto call, not the modules' own helpers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { defaultToolCatalog } from "../../tools/default-catalog";
import { toolVerifiers, calibrationTable } from "../../tools/verifiers";
import { browserCalibration } from "../verifier";
import { createBrowseRunner } from "../runner";
import { TRACE_GENESIS } from "../trace";
import type { BrowserToolOutput } from "../tool";
import { HadesCli } from "../../cli/cli";

const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const REVEALED_TEXT =
  "Revealed content paragraph that only exists after a real click happened in a real browser session.";

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>Hades Integration Fixture</title></head><body>
<main>
<h1>Hades browser integration fixture</h1>
<p>First paragraph, long enough to clear the default minimum passage length for citation.</p>
<p>Second paragraph, also comfortably long enough to become an independently cited passage.</p>
<button id="reveal" onclick="const p=document.createElement('p');p.id='revealed';p.textContent='${REVEALED_TEXT}';document.querySelector('main').appendChild(p)">Reveal</button>
</main>
</body></html>`;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Registry wiring (pure, no browser launch)
// ---------------------------------------------------------------------------

describe("product registry wiring", () => {
  it("the shipped default catalog contains `browser` wired to `verify.browser`", () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true });
    const entry = catalog.get("browser");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("web");
    expect(entry!.requiresNetwork).toBe(true);
    expect(entry!.verifierId).toBe("verify.browser");
    // offline withholds the runner => honest mock, regardless of Chromium.
    expect(entry!.mode).toBe("mock");
  });

  it("toolVerifiers()/calibrationTable() carry verify.browser, consistently", () => {
    const v = toolVerifiers().get("verify.browser");
    expect(v).toBeDefined();
    expect(v!.toolName).toBe("browser");
    const entry = calibrationTable()["verify.browser"];
    expect(entry).toEqual(browserCalibration());
    expect(entry.tier).toBe("T4-consistency");
    expect(entry.prior).toBeGreaterThanOrEqual(0.6);
    expect(entry.prior).toBeLessThanOrEqual(0.75);
  });

  it("a GENUINE offline mock browse passes verify.browser at exactly its prior", async () => {
    const catalog = defaultToolCatalog({ env: {}, offline: true });
    const input = JSON.stringify({ op: "browse", url: "https://example.com/mock-check" });
    const result = await catalog.get("browser")!.tool.run(input);
    expect(result.ok).toBe(true);
    const out = JSON.parse(result.output) as BrowserToolOutput;
    expect(out.mode).toBe("mock");
    expect(out.content).toContain("[mock]");

    const verdict = toolVerifiers().get("verify.browser")!.verify(input, result);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(Math.abs(verdict.confidence - browserCalibration().prior)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end: runner composition (driver + extract + trace)
// ---------------------------------------------------------------------------

describe("createBrowseRunner against a real Chromium + real fixture server", () => {
  it("browses, extracts hash-verifiable passages, and roots a real trace", async () => {
    const outcome = await createBrowseRunner()({ url: `${baseUrl}/`, maxBytes: 200_000, actions: [] });
    expect(outcome.error).toBeUndefined();
    expect(outcome.ok).toBe(true);
    expect(outcome.title).toBe("Hades Integration Fixture");
    expect(outcome.finalUrl).toBe(`${baseUrl}/`);
    expect(outcome.content).toContain("First paragraph");
    expect(outcome.passages.length).toBeGreaterThanOrEqual(2);
    for (const p of outcome.passages) {
      expect(sha256(p.text)).toBe(p.sha256); // independent recompute
      expect(p.sourceUrl).toBe(`${baseUrl}/`);
      expect(p.selectorPath.length).toBeGreaterThan(0);
    }
    // navigate + extract, chained from the STYX genesis
    expect(outcome.eventCount).toBe(2);
    expect(outcome.traceRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.traceRoot).not.toBe(TRACE_GENESIS);
    expect(outcome.truncated).toBe(false);
  }, 60_000);

  it("actions really execute: a click mutates the DOM before extraction", async () => {
    const outcome = await createBrowseRunner()({
      url: `${baseUrl}/`,
      maxBytes: 200_000,
      actions: [{ kind: "click", selector: "#reveal" }],
    });
    expect(outcome.ok).toBe(true);
    // The revealed paragraph does NOT exist in the served HTML — only a
    // real click in a real DOM can put it into the extracted content.
    expect(FIXTURE_HTML).not.toContain(`<p id="revealed">`);
    expect(outcome.content).toContain(REVEALED_TEXT);
    expect(outcome.passages.some((p) => p.text.includes(REVEALED_TEXT))).toBe(true);
    // navigate + act + extract
    expect(outcome.eventCount).toBe(3);
  }, 60_000);

  it("is honest about failure: connection refused yields ok:false, never content", async () => {
    // Grab a genuinely free port, then close it so nothing listens there.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const outcome = await createBrowseRunner()({
      url: `http://127.0.0.1:${deadPort}/`,
      maxBytes: 200_000,
      actions: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/^nav-(net-error|timeout):/);
    expect(outcome.content).toBe("");
    expect(outcome.passages).toEqual([]);
    expect(outcome.eventCount).toBe(1); // the failed navigate is still traced
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Real end-to-end THROUGH THE PRODUCT catalog + verifier
// ---------------------------------------------------------------------------

describe("the shipped catalog's browser tool, real mode, verified", () => {
  it("default (non-offline) catalog serves a REAL browse whose genuine output passes verify.browser at exactly its prior", async () => {
    // Product defaults: lazy real runner + the tool's own fs probe against
    // /opt/pw-browsers (present in this environment, same premise as every
    // other real-browser test in this directory).
    const catalog = defaultToolCatalog({ env: {} });
    const entry = catalog.get("browser")!;
    expect(entry.mode).toBe("real");

    const input = JSON.stringify({ op: "browse", url: `${baseUrl}/`, maxBytes: 50_000 });
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(true);
    const out = JSON.parse(result.output) as BrowserToolOutput;
    expect(out.mode).toBe("real");
    expect(out.url).toBe(`${baseUrl}/`);
    expect(out.title).toBe("Hades Integration Fixture");
    expect(out.eventCount).toBeGreaterThan(0);
    expect(result.output).not.toContain("[mock]");

    const verdict = toolVerifiers().get("verify.browser")!.verify(input, result);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(Math.abs(verdict.confidence - browserCalibration().prior)).toBeLessThan(1e-9);
  }, 60_000);

  it("a failed real browse maps to ok:false and the verifier flags it with certainty", async () => {
    const catalog = defaultToolCatalog({ env: {} });
    const entry = catalog.get("browser")!;
    // Port 1 on loopback: virtually guaranteed connection-refused.
    const input = JSON.stringify({ op: "browse", url: "http://127.0.0.1:1/" });
    const result = await entry.tool.run(input);
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toBe("browse-failed");

    const verdict = toolVerifiers().get("verify.browser")!.verify(input, result);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("TOOL_REPORTED_FAILURE");
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// CLI surface through HadesCli itself
// ---------------------------------------------------------------------------

describe("hades browser CLI routes", () => {
  it("hades help advertises the browser subcommand", async () => {
    const help = await new HadesCli({}).run(["help"]);
    expect(help.lines.join("\n")).toContain("browser <sub>");
  });

  it("`hades browser probe --json` reports the real Chromium/display state", async () => {
    const res = await new HadesCli({}).run(["browser", "probe", "--json"]);
    expect(res.code).toBe(0);
    const probe = JSON.parse(res.lines.join("\n")) as {
      chromiumFound: boolean;
      chromiumPath: string | null;
      headedOk: boolean;
    };
    // Same environmental premise as the rest of this suite.
    expect(probe.chromiumFound).toBe(true);
    expect(probe.chromiumPath).toMatch(/pw-browsers/);
    expect(typeof probe.headedOk).toBe("boolean");
  });

  it("`hades browser open <url> --json` performs a real browse end-to-end", async () => {
    const res = await new HadesCli({}).run(["browser", "open", `${baseUrl}/`, "--json"]);
    expect(res.code).toBe(0);
    const outer = JSON.parse(res.lines.join("\n")) as { ok: boolean; output: string };
    expect(outer.ok).toBe(true);
    const out = JSON.parse(outer.output) as BrowserToolOutput;
    expect(out.mode).toBe("real");
    expect(out.title).toBe("Hades Integration Fixture");
    for (const p of out.passages) expect(sha256(p.text)).toBe(p.sha256);
  }, 60_000);

  it("usage and typo handling exit 2 without touching a browser", async () => {
    const help = await new HadesCli({}).run(["browser", "help"]);
    expect(help.code).toBe(2);
    expect(help.lines.join("\n")).toContain("Usage: hades browser");

    const typo = await new HadesCli({}).run(["browser", "opne"]);
    expect(typo.code).toBe(2);
    expect(typo.lines.join("\n")).toContain('did you mean "open"');
  });
});
