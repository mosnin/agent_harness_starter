/* ------------------------------------------------------------------ *
 * runner.ts — CENTRAL INTEGRATION of the Phase 3 browser stack.
 *
 * The build teams shipped four decoupled modules with a locked seam:
 *   driver.ts   — real Playwright-Chromium navigation/actions
 *   extract.ts  — pure HTML -> hash-cited passages
 *   trace.ts    — hash-chained, STYX-rooted event ledger
 *   tool.ts     — the `browser` CatalogEntry, which only *defines* the
 *                 `BrowseRunner` seam and demands it be injected.
 *
 * This file is the one place allowed to import all of them: it composes
 * a real `BrowseRunner` that
 *   1. launches a real headless Chromium (`BrowserDriver.launch`),
 *   2. navigates to the requested URL (policy-checked by the driver),
 *   3. replays the request's scripted actions through `DriverPage.act`
 *      (the driver's own runtime validation rejects unknown kinds —
 *      the seam's open `kind: string` is narrowed here by the engine
 *      that owns the vocabulary, not by a duplicate check),
 *   4. extracts hash-cited passages from the final rendered DOM
 *      (`extractFromPage` — passages carry recomputable sha256s), and
 *   5. appends every step to a `BrowserTraceLedger`, returning the
 *      chain's verified root + event count via `traceCertificateFields`
 *      (which re-verifies the whole chain and throws on any break —
 *      a corrupted ledger can never be summarized into a certificate).
 *
 * Failure honesty: every failure path returns `ok: false` with a
 * machine-readable `error` prefix (`launch-failed:`, `nav-<code>:`,
 * `act-<code>:`, `browse-crashed:`) and the ledger's honest root/count
 * at the moment of failure. Nothing is fabricated; the browser is
 * always closed in `finally`.
 * ------------------------------------------------------------------ */

import { BrowserDriver, type BrowserAction as DriverAction } from "./driver";
import { extractFromPage } from "./extract";
import { BrowserTraceLedger, traceCertificateFields } from "./trace";
import type { BrowseRunner, BrowseRequest, BrowseOutcome, BrowsePassage, BrowseAction } from "./tool";

export interface BrowseRunnerOptions {
  /** Playwright browsers cache dir (default: PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers). */
  browsersPath?: string;
  /** Explicit Chromium executable; wins over `browsersPath` scanning. */
  executablePath?: string;
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** Hosts (exact or subdomain, case-insensitive) navigation must refuse. */
  blockHosts?: string[];
  /** Extraction knobs forwarded to `extractFromPage`. */
  maxPassages?: number;
  minPassageChars?: number;
  maxLinks?: number;
  /** Injected clock for the trace ledger (tests). Default: Date.now. */
  now?: () => number;
  env?: Record<string, string | undefined>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow a seam action (open `kind: string`) into the driver's action
 *  shape. Purely structural — semantic validation (unknown kind ->
 *  `bad-action`, missing selector -> `no-selector`, ...) belongs to and
 *  happens inside `DriverPage.act`, the module that owns the vocabulary. */
function toDriverAction(a: BrowseAction): DriverAction {
  const action = { kind: a.kind } as DriverAction;
  if (a.selector !== undefined) action.selector = a.selector;
  if (a.text !== undefined) action.text = a.text;
  if (a.value !== undefined) action.value = a.value;
  if (a.key !== undefined) action.key = a.key;
  if (a.deltaY !== undefined) action.deltaY = a.deltaY;
  return action;
}

/**
 * Compose the real `BrowseRunner` from the driver, extractor, and trace
 * ledger. One browser launch per request (launched lazily inside the
 * returned function, closed in `finally` — a runner value is inert until
 * called and never leaks a Chromium process).
 */
export function createBrowseRunner(opts: BrowseRunnerOptions = {}): BrowseRunner {
  return async (req: BrowseRequest): Promise<BrowseOutcome> => {
    const ledger = new BrowserTraceLedger(opts.now !== undefined ? { now: opts.now } : undefined);

    const fail = (error: string, finalUrl = ""): BrowseOutcome => ({
      ok: false,
      url: req.url,
      finalUrl,
      title: "",
      content: "",
      passages: [],
      traceRoot: ledger.rootHash(),
      eventCount: ledger.length,
      truncated: false,
      error,
    });

    let driver: BrowserDriver;
    try {
      driver = await BrowserDriver.launch({
        headless: true,
        ...(opts.browsersPath !== undefined ? { browsersPath: opts.browsersPath } : {}),
        ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
        ...(opts.navTimeoutMs !== undefined ? { navTimeoutMs: opts.navTimeoutMs } : {}),
        ...(opts.actionTimeoutMs !== undefined ? { actionTimeoutMs: opts.actionTimeoutMs } : {}),
        ...(opts.blockHosts !== undefined ? { blockHosts: opts.blockHosts } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
    } catch (err) {
      return fail(`launch-failed: ${messageOf(err)}`);
    }

    try {
      const page = await driver.newPage();

      const nav = await page.goto(req.url);
      ledger.append("navigate", {
        url: req.url,
        ok: nav.ok,
        finalUrl: nav.finalUrl ?? null,
        status: nav.status ?? null,
        redirects: nav.redirects,
        ...(nav.error !== undefined ? { errorCode: nav.error.code } : {}),
      });
      if (!nav.ok) {
        return fail(
          `nav-${nav.error?.code ?? "failed"}: ${nav.error?.message ?? "navigation failed"}`,
          nav.finalUrl ?? ""
        );
      }

      for (const seamAction of req.actions) {
        const result = await page.act(toDriverAction(seamAction));
        ledger.append("act", {
          kind: seamAction.kind,
          selector: seamAction.selector ?? null,
          ok: result.ok,
          ...(result.error !== undefined ? { errorCode: result.error.code } : {}),
        });
        if (!result.ok) {
          return fail(
            `act-${result.error?.code ?? "failed"}: ${result.error?.message ?? "action failed"}`,
            page.url()
          );
        }
      }

      const extracted = await extractFromPage(page, {
        maxBytes: req.maxBytes,
        ...(opts.maxPassages !== undefined ? { maxPassages: opts.maxPassages } : {}),
        ...(opts.minPassageChars !== undefined ? { minPassageChars: opts.minPassageChars } : {}),
        ...(opts.maxLinks !== undefined ? { maxLinks: opts.maxLinks } : {}),
      });
      // The extracted text itself rides along as the event's hashed
      // payload — the ledger stores only its sha256, so the trace commits
      // to the exact content without bloating the chain.
      ledger.append(
        "extract",
        {
          url: extracted.url,
          passages: extracted.passages.length,
          bytes: extracted.bytes,
          truncated: extracted.truncated,
          contentType: extracted.contentType,
        },
        extracted.text
      );

      // Re-verifies the entire hash chain; throws (-> browse-crashed)
      // rather than ever summarizing a broken ledger into a root.
      const cert = traceCertificateFields(ledger.records());

      const passages: BrowsePassage[] = extracted.passages.map((p) => ({
        text: p.text,
        sourceUrl: p.sourceUrl,
        selectorPath: p.selectorPath,
        sha256: p.sha256,
      }));

      return {
        ok: true,
        url: req.url,
        finalUrl: page.url(),
        title: extracted.title,
        content: extracted.text,
        passages,
        traceRoot: cert.traceRoot,
        eventCount: cert.eventCount,
        truncated: extracted.truncated,
      };
    } catch (err) {
      return fail(`browse-crashed: ${messageOf(err)}`);
    } finally {
      await driver.close();
    }
  };
}
