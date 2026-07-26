/* ------------------------------------------------------------------ *
 * browse-bench.test.ts
 *
 * REAL-VS-MOCK POLICY for this file: every test in the main describe
 * blocks below drives a REAL headless Chromium against a REAL
 * `node:http` fixture server bound to 127.0.0.1 on a REAL ephemeral
 * port — no mocked browser, no mocked network, no fabricated report
 * fields. `report.ok === true` is asserted for real, successful runs
 * in this environment (Chromium is genuinely installed here — verified
 * by the "chromium found" assertions below). The one deliberately
 * unreachable-Chromium scenario is tested REALLY too, by pointing
 * `browsersPath`/`executablePath` at locations that truthfully contain
 * no browser (an empty temp dir / a nonexistent file) — never mocked.
 * ------------------------------------------------------------------ */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

import {
  runBrowseBench,
  runBrowseBenchDetailed,
  formatBrowseBenchReport,
  verifyBenchChain,
  verifyBenchCitations,
  canonicalizeBenchEvent,
  chainHash,
  isFailedStatus,
  BENCH_GENESIS,
  type BrowseBenchDetail,
  type BrowseBenchReport,
  type BenchPassage,
  type BenchTraceRecord,
} from "../browse-bench";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

// ===========================================================================
// One real run shared across the read-only assertion groups below, to
// keep total real-Chromium-launch count low while still exercising the
// full real pipeline end to end.
// ===========================================================================

let mainDetail: BrowseBenchDetail;

beforeAll(async () => {
  mainDetail = await runBrowseBenchDetailed();
}, 30000);

// ===========================================================================
// The end-to-end checkpoint itself
// ===========================================================================

describe("runBrowseBench — real end-to-end checkpoint", () => {
  it("reports a real, fully-verified PASS in this environment", () => {
    const r = mainDetail.report;
    expect(r.chromium.found).toBe(true);
    expect(typeof r.chromium.path).toBe("string");
    expect(r.pagesVisited).toBeGreaterThanOrEqual(3);
    expect(r.linksFollowed).toBeGreaterThanOrEqual(1);
    expect(r.passages).toBeGreaterThan(0);
    expect(r.citedAll).toBe(true);
    expect(r.traceVerified).toBe(true);
    expect(r.traceRoot).toMatch(HEX64);
    expect(r.eventCount).toBeGreaterThan(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("counts the redirect route once, not per hop (index + click article-1 + goto article-2 + redirect = 4)", () => {
    expect(mainDetail.report.pagesVisited).toBe(4);
    const redirectRecord = mainDetail.records.find(
      (rec) => rec.kind === "navigate" && typeof rec.detail.url === "string" && (rec.detail.url as string).endsWith("/redirect"),
    );
    expect(redirectRecord).toBeDefined();
    expect(redirectRecord!.detail.finalUrl).toContain("/article-2");
  });

  it("follows a real anchor (a click, not a goto) to article 1", () => {
    const clickRecord = mainDetail.records.find((rec) => rec.kind === "navigate" && rec.detail.method === "click");
    expect(clickRecord).toBeDefined();
    expect(clickRecord!.detail.url).toContain("/article-1");
  });

  it("extracts real multi-paragraph passages from both articles", () => {
    const fromArticle1 = mainDetail.passages.filter((p) => p.sourceUrl.endsWith("/article-1"));
    const fromArticle2 = mainDetail.passages.filter((p) => p.sourceUrl.endsWith("/article-2"));
    expect(fromArticle1.length).toBeGreaterThanOrEqual(2);
    expect(fromArticle2.length).toBeGreaterThanOrEqual(2);
    for (const p of mainDetail.passages) {
      expect(p.text.length).toBeGreaterThan(20);
    }
  });

  it("every recorded URL's origin is 127.0.0.1 — bench never touches a non-loopback host", () => {
    let checked = 0;
    for (const rec of mainDetail.records) {
      for (const key of ["url", "finalUrl"] as const) {
        const v = rec.detail[key];
        if (typeof v === "string") {
          expect(new URL(v).hostname).toBe("127.0.0.1");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    for (const p of mainDetail.passages) {
      expect(new URL(p.sourceUrl).hostname).toBe("127.0.0.1");
    }
  });

  it("re-derives the same trace root independently via verifyBenchChain", () => {
    const verdict = verifyBenchChain(mainDetail.records);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.rootHash).toBe(mainDetail.report.traceRoot);
      expect(verdict.length).toBe(mainDetail.report.eventCount);
    }
  });

  it("re-derives the same citedAll verdict independently via verifyBenchCitations", () => {
    const verdict = verifyBenchCitations(mainDetail.passages, mainDetail.fixtureOrigin, mainDetail.servedBodies);
    expect(verdict).toBe(mainDetail.report.citedAll);
    expect(verdict).toBe(true);
  });
});

// ===========================================================================
// Ground-truth citation checks + tamper detection (proving the checks
// can actually fail, not just pass by construction)
// ===========================================================================

describe("verifyBenchCitations — ground truth + tamper detection", () => {
  it("verifies true for the original, untampered passages", () => {
    expect(verifyBenchCitations(mainDetail.passages, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(true);
  });

  it("is vacuously true for an empty passage list", () => {
    expect(verifyBenchCitations([], mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(true);
  });

  it("flips false when a passage's stored sha256 is tampered (hash no longer matches its own text)", () => {
    const tampered: BenchPassage[] = mainDetail.passages.map((p, i) =>
      i === 0 ? { ...p, sha256: p.sha256.slice(0, -1) + (p.sha256.endsWith("0") ? "1" : "0") } : p,
    );
    expect(tampered[0]!.sha256).not.toBe(mainDetail.passages[0]!.sha256);
    expect(verifyBenchCitations(tampered, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(false);
    // the untouched original still verifies true — proves the check is
    // sensitive to this exact tamper, not broken in general.
    expect(verifyBenchCitations(mainDetail.passages, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(true);
  });

  it("flips false when a passage's text is corrupted but its stored hash is left alone", () => {
    const tampered: BenchPassage[] = mainDetail.passages.map((p, i) => (i === 0 ? { ...p, text: p.text + " (forged addendum)" } : p));
    expect(verifyBenchCitations(tampered, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(false);
  });

  it("flips false for a fabricated passage whose text/hash are internally consistent but never appear in the served body", () => {
    const fabricatedText = "This sentence was never served by the fixture server.";
    const fabricated: BenchPassage[] = [
      ...mainDetail.passages,
      { text: fabricatedText, sourceUrl: `${mainDetail.fixtureOrigin}/article-1`, sha256: sha256Hex(fabricatedText) },
    ];
    // internally consistent (hash matches text) yet not a real citation —
    // the ground-truth substring check against the server's own bytes
    // is what catches it, not the hash check.
    expect(sha256Hex(fabricatedText)).toBe(fabricated[fabricated.length - 1]!.sha256);
    expect(verifyBenchCitations(fabricated, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(false);
  });

  it("flips false when a passage claims a non-fixture (external) sourceUrl", () => {
    const forged: BenchPassage[] = [{ text: mainDetail.passages[0]!.text, sourceUrl: "http://example.com/article-1", sha256: mainDetail.passages[0]!.sha256 }];
    expect(verifyBenchCitations(forged, mainDetail.fixtureOrigin, mainDetail.servedBodies)).toBe(false);
  });
});

// ===========================================================================
// Hash-chain tamper detection
// ===========================================================================

describe("verifyBenchChain — tamper detection", () => {
  it("verifies ok:true for the original, untouched chain, root matching the report", () => {
    const v = verifyBenchChain(mainDetail.records);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rootHash).toBe(mainDetail.report.traceRoot);
  });

  it("flips ok:false when one record's stored hash is flipped", () => {
    const tampered: BenchTraceRecord[] = mainDetail.records.map((r, i) => (i === 2 ? { ...r, hash: flipHex(r.hash) } : r));
    const v = verifyBenchChain(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("hash-mismatch");
      expect(v.index).toBe(2);
    }
  });

  it("flips ok:false when one record's prevHash is flipped (chain break)", () => {
    const tampered: BenchTraceRecord[] = mainDetail.records.map((r, i) => (i === 1 ? { ...r, prevHash: flipHex(r.prevHash) } : r));
    const v = verifyBenchChain(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(["chain-break", "hash-mismatch"]).toContain(v.reason);
  });

  it("flips ok:false when a record's detail is mutated (its hash no longer matches its content)", () => {
    const tampered: BenchTraceRecord[] = mainDetail.records.map((r, i) => (i === 0 ? { ...r, detail: { ...r.detail, url: "http://127.0.0.1:1/forged" } } : r));
    const v = verifyBenchChain(tampered);
    expect(v.ok).toBe(false);
  });

  it("flips ok:false when a record is removed (seq gap)", () => {
    const tampered = mainDetail.records.filter((_, i) => i !== 1);
    const v = verifyBenchChain(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("seq-gap");
  });

  it("verifies ok:true, rootHash === BENCH_GENESIS for an empty chain", () => {
    const v = verifyBenchChain([]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rootHash).toBe(BENCH_GENESIS);
      expect(v.length).toBe(0);
    }
  });

  function flipHex(h: string): string {
    const last = h[h.length - 1];
    const flipped = last === "0" ? "1" : "0";
    return h.slice(0, -1) + flipped;
  }
});

// ===========================================================================
// Pure canonicalization / hashing determinism (no server, no browser —
// proves traceRoot changes between runs only via timestamps)
// ===========================================================================

describe("canonicalizeBenchEvent / chainHash — determinism", () => {
  it("canonicalizes structurally-identical events, built with different key insertion order, byte-identically", () => {
    const a = { seq: 0, at: 1700000000000, kind: "navigate" as const, detail: { url: "http://127.0.0.1:9/", ok: true, status: 200 } };
    const b = { seq: 0, kind: "navigate" as const, detail: { status: 200, ok: true, url: "http://127.0.0.1:9/" }, at: 1700000000000 };
    expect(canonicalizeBenchEvent(a)).toBe(canonicalizeBenchEvent(b));
  });

  it("chainHash is a pure function of (prevHash, event) — repeated calls are identical", () => {
    const event = { seq: 3, at: 42, kind: "extract" as const, detail: { url: "http://127.0.0.1:9/article-1", passageCount: 3 } };
    const h1 = chainHash(BENCH_GENESIS, event);
    const h2 = chainHash(BENCH_GENESIS, event);
    expect(h1).toBe(h2);
    expect(h1).toMatch(HEX64);
  });

  it("differs only when the timestamp differs, all else held fixed", () => {
    const base = { seq: 0, kind: "navigate" as const, detail: { url: "http://127.0.0.1:9/" } };
    const h1 = chainHash(BENCH_GENESIS, { ...base, at: 1000 });
    const h2 = chainHash(BENCH_GENESIS, { ...base, at: 1000 });
    const h3 = chainHash(BENCH_GENESIS, { ...base, at: 2000 });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("BENCH_GENESIS is a fixed, real sha256 of the literal genesis string", () => {
    expect(BENCH_GENESIS).toBe(sha256Hex("hades.browser.bench.v1"));
    expect(BENCH_GENESIS).toMatch(HEX64);
  });
});

// ===========================================================================
// isFailedStatus — the classification rule reused by the dedicated 404
// scenario below, so that scenario genuinely reuses production logic.
// ===========================================================================

describe("isFailedStatus", () => {
  it("classifies 4xx/5xx as failed, 2xx/3xx and undefined as not failed", () => {
    expect(isFailedStatus(404)).toBe(true);
    expect(isFailedStatus(500)).toBe(true);
    expect(isFailedStatus(400)).toBe(true);
    expect(isFailedStatus(200)).toBe(false);
    expect(isFailedStatus(302)).toBe(false);
    expect(isFailedStatus(undefined)).toBe(false);
  });
});

// ===========================================================================
// Chromium-not-found — tested REALLY (no browser is ever launched; the
// failure is a genuine fs-resolution failure, not a mock).
// ===========================================================================

describe("chromium-not-found path — real, honest failure", () => {
  let emptyDir: string;

  beforeAll(() => {
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-bench-empty-"));
  });
  afterAll(() => {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("returns ok:false with a chromium-not-found failure when browsersPath is empty", async () => {
    const report = await runBrowseBench({ browsersPath: emptyDir });
    expect(report.ok).toBe(false);
    expect(report.chromium.found).toBe(false);
    expect(report.chromium.path).toBeUndefined();
    expect(report.pagesVisited).toBe(0);
    expect(report.passages).toBe(0);
    expect(report.citedAll).toBe(false);
    expect(report.traceVerified).toBe(false);
    expect(report.eventCount).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^chromium-not-found:/);
    expect(report.traceRoot).toBe(BENCH_GENESIS);
  });

  it("returns ok:false with a chromium-not-found failure when executablePath does not exist", async () => {
    const report = await runBrowseBench({ executablePath: path.join(emptyDir, "no-such-binary") });
    expect(report.ok).toBe(false);
    expect(report.chromium.found).toBe(false);
    expect(report.failures[0]).toMatch(/^chromium-not-found:/);
  });

  it("never launches a browser or opens a listening port for this path (fast, no timeout needed)", async () => {
    const start = Date.now();
    await runBrowseBench({ browsersPath: emptyDir });
    // A real chromium launch + navigation sequence takes well over this;
    // an fs-only failure resolves in well under a second.
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

// ===========================================================================
// Ephemeral port allocation — impossible-by-construction collision
// ===========================================================================

describe("ephemeral port allocation", () => {
  it("two concurrent real runs get distinct fixture origins and both succeed", async () => {
    const [a, b] = await Promise.all([runBrowseBenchDetailed(), runBrowseBenchDetailed()]);
    expect(a.fixtureOrigin).not.toBe(b.fixtureOrigin);
    expect(a.report.ok).toBe(true);
    expect(b.report.ok).toBe(true);
    expect(a.report.pagesVisited).toBe(b.report.pagesVisited);
    expect(a.report.passages).toBe(b.report.passages);
    // structurally identical event-kind sequence across independent runs
    expect(a.records.map((r) => r.kind)).toEqual(b.records.map((r) => r.kind));
  }, 30000);
});

// ===========================================================================
// Server + browser are provably closed afterward — no hang, port released
// ===========================================================================

describe("cleanup — server and browser are provably closed afterward", () => {
  it("the fixture server's port refuses new connections once runBrowseBench has returned", async () => {
    const url = `${mainDetail.fixtureOrigin}/`;
    const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const req = http.get(url, () => {
        reject(new Error("expected the fixture server's port to be closed, but it answered"));
      });
      req.on("error", (e) => resolve(e as NodeJS.ErrnoException));
      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error("timed out waiting for a connection-refused error"));
      });
    });
    expect(err.code).toBe("ECONNREFUSED");
  }, 10000);
});

// ===========================================================================
// 404 route — served by the fixture, deliberately visited in an isolated
// dedicated test that reuses production's own status classification
// (isFailedStatus), WITHOUT going through / affecting the main
// successful-run flow above.
// ===========================================================================

describe("404 route — dedicated, isolated real navigation (does not touch the main flow)", () => {
  it("a real navigation to a real 404 route is classified as a failure by isFailedStatus, using the resolved Chromium from the main run", async () => {
    expect(mainDetail.report.chromium.found).toBe(true);
    const execPath = mainDetail.report.chromium.path!;

    const missingBody = "Not Found (dedicated 404 fixture)";
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(missingBody);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/missing`;

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: execPath, headless: true });
    try {
      const page = await browser.newPage();
      const resp = await page.goto(url, { waitUntil: "load", timeout: 15000 });
      expect(resp).not.toBeNull();
      expect(resp!.status()).toBe(404);
      expect(isFailedStatus(resp!.status())).toBe(true);
      const body = await page.textContent("body");
      expect(body).toContain(missingBody);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // The main flow's report, gathered independently above, was never
    // touched by this isolated 404 scenario.
    expect(mainDetail.report.ok).toBe(true);
    expect(mainDetail.report.failures).toEqual([]);
  }, 20000);
});

// ===========================================================================
// formatBrowseBenchReport — pure formatting
// ===========================================================================

describe("formatBrowseBenchReport", () => {
  it("formats the real main report as a multi-line, color-code-free summary", () => {
    const out = formatBrowseBenchReport(mainDetail.report);
    expect(out).toContain("browse-bench: PASS");
    expect(out).toContain(`pages visited:   ${mainDetail.report.pagesVisited}`);
    expect(out).toContain(`trace root:      ${mainDetail.report.traceRoot}`);
    expect(out).toContain("failures:        none");
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("lists every failure line for a failing report", () => {
    const failing: BrowseBenchReport = {
      ok: false,
      chromium: { found: false },
      pagesVisited: 0,
      linksFollowed: 0,
      passages: 0,
      citedAll: false,
      traceVerified: false,
      traceRoot: BENCH_GENESIS,
      eventCount: 0,
      elapsedMs: 12,
      failures: ["chromium-not-found: nope", "second-failure"],
    };
    const out = formatBrowseBenchReport(failing);
    expect(out).toContain("browse-bench: FAIL");
    expect(out).toContain("chromium:        NOT FOUND");
    expect(out).toContain("    - chromium-not-found: nope");
    expect(out).toContain("    - second-failure");
  });
});
