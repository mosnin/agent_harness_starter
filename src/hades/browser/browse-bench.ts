/* ------------------------------------------------------------------ *
 * browse-bench.ts — the Phase 3 real-browsing checkpoint.
 *
 * This is not a simulation. `runBrowseBench` starts a genuine
 * `node:http` fixture site bound to 127.0.0.1 on an ephemeral port,
 * launches a real headless Chromium via `playwright-core`, drives it
 * through a real multi-page navigation (index -> click a real anchor
 * to article 1 -> goto article 2 -> follow a real 302 redirect),
 * extracts cited passages from the pages Chromium actually rendered,
 * and verifies two independent things by RECOMPUTATION rather than by
 * trusting anything the browsing pass claimed:
 *
 *   1. citedAll — every extracted passage's sha256 is recomputed from
 *      its stored text, its `sourceUrl` is checked to be a
 *      fixture-origin URL (127.0.0.1, never any other host), and its
 *      text is checked to actually be a substring of the exact bytes
 *      the fixture server sent for that URL (captured at serve time —
 *      the server's own ground truth, not a copy of the same source
 *      constant used to build the page).
 *   2. traceVerified — the whole hash-chained action trace (genesis ->
 *      every navigate/extract event) is re-derived from scratch and
 *      checked to match the stored `hash`/`prevHash` fields.
 *
 * On a missing Chromium install this returns `ok:false` with an
 * honest `chromium-not-found:` failure — never a fabricated success.
 * Every number in the report is measured (byte counts, page counts,
 * elapsed ms via the injected clock) — nothing is invented.
 *
 * Locked import boundary: `playwright-core`, `sha256Hex` from
 * `../styx/certificate`, and node built-ins ONLY. This module does
 * NOT import driver.ts / extract.ts / trace.ts / tool.ts (other build
 * teams' files for this phase) — it carries its own minimal internal
 * chain-hasher (a structural twin of trace.ts's
 * `BrowserTraceLedger`/`verifyTraceChain`) and its own minimal
 * `<p>`-tag text extractor (a structural twin of extract.ts's cited
 * passage extraction, scoped to exactly what this fixture site needs)
 * so the two build teams' files stay decoupled until central
 * integration reconciles them onto the shared driver/extract/trace
 * primitives.
 * ------------------------------------------------------------------ */

import { chromium, type Page, type Response as PwResponse } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Public contract (locked)
// ===========================================================================

export interface BrowseBenchOptions {
  /** Playwright browsers cache root. Default: env PLAYWRIGHT_BROWSERS_PATH,
   *  else "/opt/pw-browsers". */
  browsersPath?: string;
  /** Explicit Chromium/headless-shell executable, bypassing directory scan. */
  executablePath?: string;
  /** Injectable clock (defaults to Date.now). Drives every trace timestamp
   *  and the measured `elapsedMs`. */
  now?: () => number;
  /** How long (ms) to keep the fixture server listening after the browsing
   *  pass finishes, before shutting it down. Default 0 (close immediately).
   *  The function still always returns only after the server is closed. */
  keepServerMs?: number;
}

export interface BrowseBenchReport {
  ok: boolean;
  chromium: { found: boolean; path?: string };
  pagesVisited: number;
  linksFollowed: number;
  passages: number;
  citedAll: boolean;
  traceVerified: boolean;
  traceRoot: string;
  eventCount: number;
  elapsedMs: number;
  failures: string[];
}

// ===========================================================================
// Additional exports — not part of the locked 4, but the pure
// primitives `runBrowseBench` is built on. Exported so the checkpoint's
// own honesty claims (ground-truth citation checks, tamper-evident
// chain verification, deterministic canonicalization) can be exercised
// and proven to actually fail on tampered input, not just asserted.
// ===========================================================================

export interface BenchPassage {
  text: string;
  sourceUrl: string;
  /** Lowercase hex sha256 of the UTF-8 bytes of `text` exactly as stored. */
  sha256: string;
}

export type BenchTraceKind = "navigate" | "extract";

export interface BenchTraceEvent {
  seq: number;
  at: number;
  kind: BenchTraceKind;
  detail: Record<string, unknown>;
}

export interface BenchTraceRecord extends BenchTraceEvent {
  prevHash: string;
  hash: string;
}

export type BenchChainVerifyResult =
  | { ok: true; rootHash: string; length: number }
  | { ok: false; index: number; reason: "malformed" | "seq-gap" | "genesis-mismatch" | "chain-break" | "hash-mismatch" };

/** Full internal detail behind a report: the report itself plus the raw
 *  passages/records/ground-truth the report's booleans were derived
 *  from. `runBrowseBench` is just `(await runBrowseBenchDetailed(opts)).report`. */
export interface BrowseBenchDetail {
  report: BrowseBenchReport;
  passages: BenchPassage[];
  records: BenchTraceRecord[];
  /** e.g. "http://127.0.0.1:54321" — the fixture server's own origin
   *  (already closed by the time this is returned; see `runBrowseBenchDetailed`). */
  fixtureOrigin: string;
  /** Ground truth: exact bytes served for each URL, captured at serve
   *  time inside the fixture's own request handler — not a copy of the
   *  source constant used to build the page. */
  servedBodies: Record<string, string>;
}

/**
 * Genesis `prevHash` for the very first record in a bench trace chain.
 * `sha256Hex("hades.browser.bench.v1")`.
 */
export const BENCH_GENESIS: string = sha256Hex("hades.browser.bench.v1");

// ===========================================================================
// Small helpers
// ===========================================================================

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A navigation/extract step counts as a failure when the server responded
 *  with an HTTP error status. Exported so both the internal flow and the
 *  test suite's deliberately-isolated 404 scenario classify statuses the
 *  same way. */
export function isFailedStatus(status: number | undefined): boolean {
  return typeof status === "number" && status >= 400;
}

// ===========================================================================
// Pure canonicalization + chain hashing (structural twin of trace.ts)
// ===========================================================================

function canonicalizeValue(value: unknown, path_: string): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalizeBenchEvent: non-finite number at ${path_}`);
    }
    return JSON.stringify(value);
  }
  if (t === "undefined") throw new TypeError(`canonicalizeBenchEvent: undefined value at ${path_}`);
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonicalizeValue(v, `${path_}[${i}]`)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeValue(obj[k], `${path_}.${k}`)).join(",") + "}";
  }
  throw new TypeError(`canonicalizeBenchEvent: unsupported value type "${t}" at ${path_}`);
}

/**
 * Deterministic JSON serialization of a `BenchTraceEvent`: object keys
 * sorted lexicographically at every level of `detail`, top-level field
 * order fixed as `[seq, at, kind, detail]`. Two structurally-equal
 * events — including freshly-built objects with keys inserted in a
 * different order — canonicalize byte-identically.
 */
export function canonicalizeBenchEvent(e: BenchTraceEvent): string {
  return (
    '{"seq":' +
    canonicalizeValue(e.seq, "seq") +
    ',"at":' +
    canonicalizeValue(e.at, "at") +
    ',"kind":' +
    canonicalizeValue(e.kind, "kind") +
    ',"detail":' +
    canonicalizeValue(e.detail, "detail") +
    "}"
  );
}

/** `sha256Hex(prevHash + "\n" + canonicalizeBenchEvent(event))` — exactly
 *  the linking rule every record in the chain is built and re-verified with. */
export function chainHash(prevHash: string, event: BenchTraceEvent): string {
  return sha256Hex(prevHash + "\n" + canonicalizeBenchEvent(event));
}

/** Append-only in-memory ledger used while driving the browsing pass. */
class BenchLedger {
  private readonly clock: () => number;
  private readonly _records: BenchTraceRecord[] = [];

  constructor(clock: () => number) {
    this.clock = clock;
  }

  append(kind: BenchTraceKind, detail: Record<string, unknown>): BenchTraceRecord {
    const seq = this._records.length;
    const at = this.clock();
    const prevHash = this._records.length === 0 ? BENCH_GENESIS : this._records[this._records.length - 1]!.hash;
    const event: BenchTraceEvent = { seq, at, kind, detail };
    const hash = chainHash(prevHash, event);
    const record: BenchTraceRecord = { seq, at, kind, detail, prevHash, hash };
    this._records.push(record);
    return record;
  }

  records(): BenchTraceRecord[] {
    return this._records.slice();
  }

  rootHash(): string {
    return this._records.length === 0 ? BENCH_GENESIS : this._records[this._records.length - 1]!.hash;
  }
}

function isMalformedRecord(r: unknown): boolean {
  if (r === null || typeof r !== "object") return true;
  const o = r as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return true;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return true;
  if (o.kind !== "navigate" && o.kind !== "extract") return true;
  if (o.detail === null || typeof o.detail !== "object" || Array.isArray(o.detail)) return true;
  if (typeof o.prevHash !== "string") return true;
  if (typeof o.hash !== "string") return true;
  return false;
}

/**
 * Pure re-verification of an entire bench trace chain: re-derives every
 * record's hash from scratch (never trusts the stored `hash`/`prevHash`
 * fields beyond what gets recomputed), checks dense `seq` numbering from
 * 0, and checks genesis/`prevHash` linkage. The first failure wins. This
 * is what makes tamper detection real: flip one byte of one stored
 * `hash` (or `prevHash`, or any `detail` field) in a *copy* of a chain
 * and this function will report `ok:false` for it, while the original,
 * untouched chain still verifies `ok:true`.
 */
export function verifyBenchChain(records: readonly BenchTraceRecord[]): BenchChainVerifyResult {
  let prevHash = BENCH_GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (isMalformedRecord(r)) return { ok: false, index: i, reason: "malformed" };
    if (r.seq !== i) return { ok: false, index: i, reason: "seq-gap" };
    if (i === 0) {
      if (r.prevHash !== BENCH_GENESIS) return { ok: false, index: i, reason: "genesis-mismatch" };
    } else if (r.prevHash !== prevHash) {
      return { ok: false, index: i, reason: "chain-break" };
    }
    let expected: string;
    try {
      expected = chainHash(r.prevHash, { seq: r.seq, at: r.at, kind: r.kind, detail: r.detail });
    } catch {
      return { ok: false, index: i, reason: "malformed" };
    }
    if (expected !== r.hash) return { ok: false, index: i, reason: "hash-mismatch" };
    prevHash = r.hash;
  }
  return { ok: true, rootHash: records.length === 0 ? BENCH_GENESIS : prevHash, length: records.length };
}

/**
 * The ground-truth citation check: every passage must (1) be sourced
 * from a fixture-origin URL, (2) have a `sha256` that matches
 * recomputing sha256 over its own stored `text`, and (3) have `text`
 * that is an actual substring of `servedBodies[sourceUrl]` — the exact
 * bytes the fixture server sent for that URL. All three must hold for
 * every passage (vacuously true for an empty passage list). Flipping
 * any single stored `sha256`, corrupting `text`, or forging a
 * non-fixture `sourceUrl` in a *copy* of the passages flips this to
 * `false`, while the original, untampered passages still verify `true`.
 */
export function verifyBenchCitations(
  passages: readonly BenchPassage[],
  fixtureOrigin: string,
  servedBodies: Readonly<Record<string, string>>,
): boolean {
  return passages.every((p) => {
    if (typeof p.sourceUrl !== "string" || !p.sourceUrl.startsWith(fixtureOrigin)) return false;
    if (typeof p.text !== "string" || typeof p.sha256 !== "string") return false;
    if (sha256Hex(p.text) !== p.sha256.toLowerCase()) return false;
    const body = servedBodies[p.sourceUrl];
    if (typeof body !== "string") return false;
    return body.includes(p.text);
  });
}

// ===========================================================================
// Chromium executable resolution (structural twin of driver.ts's
// resolveChromiumExecutable — reconcile with driver-core at central
// integration).
// ===========================================================================

const HEADLESS_SHELL_DIR_RE = /^chromium_headless_shell-(.+)$/;
const CHROMIUM_DIR_RE = /^chromium-(.+)$/;
const HEADLESS_SHELL_RELATIVE = ["chrome-linux", "headless_shell"];
const CHROMIUM_RELATIVE = ["chrome-linux", "chrome"];

interface ExecCandidate {
  version: string;
  execPath: string;
}

function compareVersions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function findExecCandidates(entries: fs.Dirent[], base: string, dirRe: RegExp, relativeParts: string[]): ExecCandidate[] {
  const out: ExecCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const match = dirRe.exec(entry.name);
    if (!match) continue;
    const execPath = path.join(base, entry.name, ...relativeParts);
    try {
      if (!fs.statSync(execPath).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ version: match[1]!, execPath });
  }
  return out;
}

function pickHighestExec(candidates: ExecCandidate[]): ExecCandidate | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, cur) => (compareVersions(cur.version, best.version) > 0 ? cur : best));
}

/** Pure fs scan for an installed Chromium/headless-shell executable under a
 *  Playwright browsers cache directory. No network, never downloads. */
function resolveBenchChromium(browsersPath: string): { ok: true; execPath: string } | { ok: false; reason: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(browsersPath, { withFileTypes: true });
  } catch (err) {
    return { ok: false, reason: `cannot read Playwright browsers directory "${browsersPath}": ${messageOf(err)}` };
  }
  const headlessShell = pickHighestExec(findExecCandidates(entries, browsersPath, HEADLESS_SHELL_DIR_RE, HEADLESS_SHELL_RELATIVE));
  if (headlessShell) return { ok: true, execPath: headlessShell.execPath };
  const full = pickHighestExec(findExecCandidates(entries, browsersPath, CHROMIUM_DIR_RE, CHROMIUM_RELATIVE));
  if (full) return { ok: true, execPath: full.execPath };
  return {
    ok: false,
    reason: `no Chromium executable found under "${browsersPath}" (looked for chromium_headless_shell-*/chrome-linux/headless_shell, then chromium-*/chrome-linux/chrome)`,
  };
}

// ===========================================================================
// Fixture site: real node:http, real 127.0.0.1, real ephemeral port
// ===========================================================================

const INDEX_HTML = `<!doctype html>
<html>
<head><title>Bench Fixture Index</title></head>
<body>
  <h1>hades browse-bench fixture</h1>
  <p>This is the real local-loopback fixture site the browse-bench checkpoint navigates.</p>
  <ul>
    <li><a href="/article-1">Read Article One</a></li>
    <li><a href="/article-2">Read Article Two</a></li>
    <li><a href="/redirect">Follow a redirect</a></li>
    <li><a href="/missing">A page that does not exist</a></li>
  </ul>
</body>
</html>`;

const ARTICLE_1_HTML = `<!doctype html>
<html>
<head><title>Article One</title></head>
<body>
  <h1>Article One</h1>
  <p>Paragraph one of article one explains that the hades browse-bench checkpoint drives a real headless Chromium against a real fixture server, never a canned or simulated response.</p>
  <p>Paragraph two of article one notes that every extracted passage carries a sha256 citation hash computed over its exact stored text, so a verifier can recompute it independently rather than trust it.</p>
  <p>Paragraph three of article one closes by linking back conceptually to the fixture index, completing a small real navigable link graph for this checkpoint.</p>
</body>
</html>`;

const ARTICLE_2_HTML = `<!doctype html>
<html>
<head><title>Article Two</title></head>
<body>
  <h1>Article Two</h1>
  <p>Paragraph one of article two describes the second stop in the browse-bench flow, reached by a direct navigation rather than a clicked anchor, to exercise both navigation styles.</p>
  <p>Paragraph two of article two is also the landing page for the fixture's 302 redirect route, so this same content is reachable two different ways in one bench run.</p>
  <p>Paragraph three of article two records that the whole action trace, this paragraph included, is hash-chained back to a fixed genesis value for later re-verification.</p>
</body>
</html>`;

const MISSING_BODY = "Not Found";

interface FixtureSite {
  baseUrl: string;
  servedBodies: Record<string, string>;
  close: () => Promise<void>;
}

function startFixtureSite(): Promise<FixtureSite> {
  const servedBodies: Record<string, string> = {};
  const sockets = new Set<Socket>();
  let baseUrl = "";

  const server = http.createServer((req, res) => {
    const reqPath = (req.url ?? "/").split("?")[0] ?? "/";

    const respond = (status: number, body: string, contentType: string) => {
      servedBodies[baseUrl + reqPath] = body;
      res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };

    switch (reqPath) {
      case "/":
        respond(200, INDEX_HTML, "text/html; charset=utf-8");
        return;
      case "/article-1":
        respond(200, ARTICLE_1_HTML, "text/html; charset=utf-8");
        return;
      case "/article-2":
        respond(200, ARTICLE_2_HTML, "text/html; charset=utf-8");
        return;
      case "/redirect":
        servedBodies[baseUrl + reqPath] = "";
        res.writeHead(302, { Location: "/article-2" });
        res.end();
        return;
      case "/missing":
        respond(404, MISSING_BODY, "text/plain; charset=utf-8");
        return;
      default:
        respond(404, "Not Found", "text/plain; charset=utf-8");
        return;
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        servedBodies,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

// ===========================================================================
// Minimal <p>-tag text extraction (structural twin of extract.ts, scoped
// to exactly what this fixture site's markup needs — reconcile with
// extract-core at central integration).
// ===========================================================================

const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, _all, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (name && ENTITY_MAP[name]) return ENTITY_MAP[name];
    return whole;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Extract one `BenchPassage` per `<p>...</p>` block whose normalized text
 *  is non-empty. Sufficient for this fixture's controlled markup only. */
function extractPassages(html: string, sourceUrl: string): BenchPassage[] {
  const out: BenchPassage[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = decodeEntities(stripTags(m[1]!))
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) continue;
    out.push({ text, sourceUrl, sha256: sha256Hex(text) });
  }
  return out;
}

// ===========================================================================
// The checkpoint itself
// ===========================================================================

const NAV_TIMEOUT_MS = 15000;

function emptyDetailReport(clock: () => number, startedAt: number, chromium: { found: boolean; path?: string }, failures: string[]): BrowseBenchDetail {
  return {
    report: {
      ok: false,
      chromium,
      pagesVisited: 0,
      linksFollowed: 0,
      passages: 0,
      citedAll: false,
      traceVerified: false,
      traceRoot: BENCH_GENESIS,
      eventCount: 0,
      elapsedMs: clock() - startedAt,
      failures,
    },
    passages: [],
    records: [],
    fixtureOrigin: "",
    servedBodies: {},
  };
}

/**
 * The real, non-simulated Phase 3 checkpoint, WITH the raw passages,
 * hash-chain records, and ground-truth server bodies the returned
 * report's booleans were computed from. `runBrowseBench` (below) is
 * just this function's `.report`.
 */
export async function runBrowseBenchDetailed(opts: BrowseBenchOptions = {}): Promise<BrowseBenchDetail> {
  const clock = opts.now ?? Date.now;
  const startedAt = clock();
  const failures: string[] = [];

  // -- 1. Resolve Chromium. Never fabricate a success. -----------------
  let execPath: string;
  if (opts.executablePath) {
    if (!fs.existsSync(opts.executablePath)) {
      failures.push(`chromium-not-found: executablePath "${opts.executablePath}" does not exist`);
      return emptyDetailReport(clock, startedAt, { found: false }, failures);
    }
    execPath = opts.executablePath;
  } else {
    const browsersPath = opts.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
    const resolved = resolveBenchChromium(browsersPath);
    if (!resolved.ok) {
      failures.push(`chromium-not-found: ${resolved.reason}`);
      return emptyDetailReport(clock, startedAt, { found: false }, failures);
    }
    execPath = resolved.execPath;
  }

  const chromiumInfo = { found: true, path: execPath };

  // -- 2. Real fixture site + real browser. Always cleaned up. ---------
  const ledger = new BenchLedger(clock);
  const passages: BenchPassage[] = [];
  let pagesVisited = 0;
  let linksFollowed = 0;

  const site = await startFixtureSite();
  const fixtureOrigin = site.baseUrl;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    try {
      browser = await chromium.launch({ executablePath: execPath, headless: true });
    } catch (err) {
      failures.push(`chromium-launch-failed: ${messageOf(err)}`);
      return finalize();
    }

    let page: Page;
    try {
      page = await browser.newPage();
    } catch (err) {
      failures.push(`page-open-failed: ${messageOf(err)}`);
      return finalize();
    }

    try {
      await driveBrowsing(page);
    } catch (err) {
      failures.push(`unexpected-error: ${messageOf(err)}`);
    }

    return finalize();

    // -----------------------------------------------------------------
    async function driveBrowsing(p: Page): Promise<void> {
      // Step 1: goto index.
      const indexUrl = `${fixtureOrigin}/`;
      const navIndex = await gotoAndRecord(p, indexUrl, "goto");
      if (navIndex) pagesVisited++;

      // Step 2: click a real anchor to article 1.
      const article1Url = `${fixtureOrigin}/article-1`;
      const anchorSelector = 'a[href="/article-1"]';
      const anchorCount = await p.locator(anchorSelector).count();
      if (anchorCount === 0) {
        failures.push(`anchor-not-found: ${anchorSelector} on ${indexUrl}`);
      } else {
        try {
          await Promise.all([
            p.waitForURL((u) => u.pathname === "/article-1", { timeout: NAV_TIMEOUT_MS }),
            p.click(anchorSelector, { timeout: NAV_TIMEOUT_MS }),
          ]);
          linksFollowed++;
          pagesVisited++;
          ledger.append("navigate", { method: "click", url: article1Url, ok: true });
          await extractAndRecord(p, article1Url);
        } catch (err) {
          failures.push(`anchor-click-failed: ${messageOf(err)}`);
        }
      }

      // Step 3: goto article 2 directly.
      const article2Url = `${fixtureOrigin}/article-2`;
      const navArticle2 = await gotoAndRecord(p, article2Url, "goto");
      if (navArticle2) {
        pagesVisited++;
        await extractAndRecord(p, article2Url);
      }

      // Step 4: follow the 302 redirect — counted once, not per hop.
      const redirectUrl = `${fixtureOrigin}/redirect`;
      await gotoAndRecordRedirect(p, redirectUrl);
      pagesVisited++;
    }

    async function gotoAndRecord(p: Page, url: string, method: "goto"): Promise<boolean> {
      let resp: PwResponse | null;
      try {
        resp = await p.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        failures.push(`navigate-failed: ${url} -> ${messageOf(err)}`);
        return false;
      }
      const status = resp?.status();
      if (isFailedStatus(status)) {
        failures.push(`navigate-failed: ${url} -> HTTP ${status}`);
        ledger.append("navigate", { method, url, status: status ?? null, ok: false });
        return false;
      }
      ledger.append("navigate", { method, url, status: status ?? null, ok: true });
      return true;
    }

    async function gotoAndRecordRedirect(p: Page, url: string): Promise<void> {
      let resp: PwResponse | null;
      try {
        resp = await p.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        failures.push(`navigate-failed: ${url} -> ${messageOf(err)}`);
        return;
      }
      const redirectedFrom: string[] = [];
      if (resp) {
        let req = resp.request().redirectedFrom();
        while (req) {
          redirectedFrom.unshift(req.url());
          req = req.redirectedFrom();
        }
      }
      const finalUrl = p.url();
      if (!finalUrl.startsWith(fixtureOrigin)) {
        failures.push(`redirect-left-fixture-origin: ${url} -> ${finalUrl}`);
      }
      const status = resp?.status();
      if (isFailedStatus(status)) {
        failures.push(`navigate-failed: ${url} -> HTTP ${status}`);
      }
      ledger.append("navigate", { method: "goto", url, finalUrl, redirectedFrom, status: status ?? null, ok: !isFailedStatus(status) });
    }

    async function extractAndRecord(p: Page, url: string): Promise<void> {
      let html: string;
      try {
        html = await p.content();
      } catch (err) {
        failures.push(`content-read-failed: ${url} -> ${messageOf(err)}`);
        return;
      }
      const found = extractPassages(html, url);
      if (found.length === 0) {
        failures.push(`no-passages-extracted: ${url}`);
      }
      passages.push(...found);
      ledger.append("extract", { url, passageCount: found.length });
    }

    function finalize(): BrowseBenchDetail {
      const records = ledger.records();
      const chainResult = verifyBenchChain(records);
      const traceVerified = chainResult.ok;
      const traceRoot = chainResult.ok ? chainResult.rootHash : BENCH_GENESIS;
      const citedAll = verifyBenchCitations(passages, fixtureOrigin, site.servedBodies);
      const ok = citedAll && traceVerified && pagesVisited >= 3 && failures.length === 0;
      return {
        report: {
          ok,
          chromium: chromiumInfo,
          pagesVisited,
          linksFollowed,
          passages: passages.length,
          citedAll,
          traceVerified,
          traceRoot,
          eventCount: records.length,
          elapsedMs: clock() - startedAt,
          failures,
        },
        passages,
        records,
        fixtureOrigin,
        servedBodies: { ...site.servedBodies },
      };
    }
  } finally {
    if (opts.keepServerMs && opts.keepServerMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.keepServerMs));
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await site.close();
  }
}

/**
 * `runBrowseBench(opts)` = `(await runBrowseBenchDetailed(opts)).report`.
 * The real, non-simulated Phase 3 checkpoint: starts a real local fixture
 * site, drives a real headless Chromium through it, extracts and
 * ground-truth-verifies cited passages, and re-derives the hash-chained
 * action trace from genesis. Always closes the browser and fixture
 * server before returning (see the `finally` inside
 * `runBrowseBenchDetailed`).
 */
export async function runBrowseBench(opts: BrowseBenchOptions = {}): Promise<BrowseBenchReport> {
  return (await runBrowseBenchDetailed(opts)).report;
}

// ===========================================================================
// Human-readable formatting
// ===========================================================================

/** Multi-line, color-free human-readable summary of a `BrowseBenchReport`.
 *  Every value printed traces directly to a measured field on `r`. */
export function formatBrowseBenchReport(r: BrowseBenchReport): string {
  const lines = [
    `browse-bench: ${r.ok ? "PASS" : "FAIL"}`,
    `  chromium:        ${r.chromium.found ? `found (${r.chromium.path ?? "?"})` : "NOT FOUND"}`,
    `  pages visited:   ${r.pagesVisited}`,
    `  links followed:  ${r.linksFollowed}`,
    `  passages:        ${r.passages}`,
    `  citations cited: ${r.citedAll}`,
    `  trace verified:  ${r.traceVerified}`,
    `  trace root:      ${r.traceRoot}`,
    `  events:          ${r.eventCount}`,
    `  elapsed:         ${r.elapsedMs}ms`,
  ];
  if (r.failures.length > 0) {
    lines.push("  failures:");
    for (const f of r.failures) lines.push(`    - ${f}`);
  } else {
    lines.push("  failures:        none");
  }
  return lines.join("\n");
}
