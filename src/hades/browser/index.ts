/**
 * @module hades/browser
 *
 * Phase 3 browser automation backend: real Playwright-Chromium driving
 * (`driver.ts`), pure hash-cited content extraction (`extract.ts`), the
 * hash-chained STYX trace ledger (`trace.ts`), the `browser` CatalogEntry
 * + its locked execution seam (`tool.ts`), the independent `verify.browser`
 * STYX verifier (`verifier.ts`), the central-integration `BrowseRunner`
 * composition (`runner.ts`), and the real browse-bench checkpoint
 * (`browse-bench.ts`).
 */

// Driver — real Chromium sessions
export { BrowserDriver, resolveChromiumExecutable, probeDisplaySupport } from "./driver";
export type {
  ResolvedExecutable,
  UnresolvedExecutable,
  ResolveExecutableResult,
  DisplaySupport,
  BrowserActionKind,
  BrowserAction,
  NavErrorCode,
  NavResult,
  ActErrorCode,
  ActResult,
  DriverPageOptions,
  BrowserDriverOptions,
  ScreenshotResult,
  DriverPage,
} from "./driver";

// Extraction — pure HTML -> cited passages
export { extractFromHtml, extractFromPage } from "./extract";
export type { CitedPassage, ExtractResult, ExtractOptions, ExtractablePage } from "./extract";

// Trace — hash-chained DOM-action ledger
export {
  TRACE_GENESIS,
  canonicalizeTraceEvent,
  BrowserTraceLedger,
  verifyTraceChain,
  traceCertificateFields,
} from "./trace";
export type {
  BrowserTraceKind,
  BrowserTraceEvent,
  TracedEventRecord,
  TraceVerifyResult,
  TraceCertificateFields,
} from "./trace";

// The `browser` catalog tool + its locked execution seam
export { createBrowserTool, defaultProbeChromium, validateBrowseInput, BROWSER_TOOL_ID, BROWSER_VERIFIER_ID } from "./tool";
export type {
  BrowseAction,
  BrowseRequest,
  BrowsePassage,
  BrowseOutcome,
  BrowseRunner,
  BrowserToolOptions,
  BrowseErrorCode,
  BrowserToolOutput,
} from "./tool";

// STYX verifier for the browser tool
export { browserToolVerifier, browserCalibration } from "./verifier";

// Central-integration runner composition (driver + extract + trace)
export { createBrowseRunner } from "./runner";
export type { BrowseRunnerOptions } from "./runner";

// The Phase 3 checkpoint
export { runBrowseBench, runBrowseBenchDetailed, formatBrowseBenchReport, verifyBenchChain, verifyBenchCitations, BENCH_GENESIS } from "./browse-bench";
export type { BrowseBenchOptions, BrowseBenchReport, BrowseBenchDetail, BenchPassage, BenchTraceEvent, BenchTraceRecord, BenchChainVerifyResult } from "./browse-bench";
