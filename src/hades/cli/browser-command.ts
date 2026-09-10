/* ------------------------------------------------------------------ *
 * browser-command.ts — `hades browser <sub>` CLI surface.
 *
 * Terminal-free (`{name, description, run(argv): Promise<number>}`, in
 * the "catalog command" shape locked for this checkpoint) so it
 * unit-tests without a shell and mounts into `cli.ts` at central
 * integration.
 *
 *   hades browser open <url> [--json] [--max-bytes N]   Fetch+render one
 *                                                        URL via the real
 *                                                        browser tool
 *   hades browser bench [--json]                        Run the real
 *                                                        browse-bench
 *                                                        checkpoint
 *   hades browser probe [--json]                        Honest chromium /
 *                                                        display state,
 *                                                        never fails
 *   hades browser help                                  Usage
 *
 * Locked import boundary: node built-ins ONLY. Every capability this
 * command needs — fetching a URL through the real browser tool,
 * running the real browse-bench checkpoint, probing Chromium/display —
 * arrives through the injected `BrowserCliDeps` seam, not an import.
 * At central integration the caller wires `deps.browse` to the catalog
 * browser tool's `run`, `deps.bench` to `runBrowseBench`
 * (`../browser/browse-bench`), and `deps.probe` to driver-core's
 * `resolveChromiumExecutable`/`probeDisplaySupport`. `BrowseBenchReport`
 * is restated below structurally (`BrowserBenchReportLike`) rather than
 * imported, so this file stays decoupled from that build team's file
 * for this phase.
 *
 * REAL-VS-MOCK POLICY for this file's own tests: `browser-command.test.ts`
 * exercises this module with fully injected fake `deps` (pure
 * argv-parsing / exit-code / stdout-stderr unit tests) — mocking the
 * seam here is the honest choice, since this file's job is dispatch and
 * formatting, not browsing; the real end-to-end browsing behavior is
 * proven separately in `browse-bench.test.ts`.
 * ------------------------------------------------------------------ */

// ===========================================================================
// Structural restatement of BrowseBenchReport (locked contract — kept
// byte-for-byte field-compatible with `../browser/browse-bench`'s
// `BrowseBenchReport` without importing that file).
// ===========================================================================

export interface BrowserBenchReportLike {
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

export interface BrowserProbeResult {
  chromiumFound: boolean;
  chromiumPath?: string;
  headedOk: boolean;
  reason?: string;
}

export interface BrowserOpenRequest {
  url: string;
  maxBytes?: number;
}

export interface BrowserOpenResult {
  ok: boolean;
  output: string;
}

/** Injected capability seam. Nothing in this file reaches a real browser,
 *  a real network, or the filesystem directly — every effectful
 *  operation comes through here. */
export interface BrowserCliDeps {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  browse: (req: BrowserOpenRequest) => Promise<BrowserOpenResult>;
  bench: () => Promise<BrowserBenchReportLike>;
  probe: () => BrowserProbeResult;
}

export interface BrowserCliCommand {
  name: "browser";
  description: string;
  run(argv: string[]): Promise<number>;
}

// ===========================================================================
// Small helpers
// ===========================================================================

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const SUBCOMMANDS = ["open", "bench", "probe", "help"] as const;

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

function suggestSubcommand(typo: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const s of SUBCOMMANDS) {
    const d = levenshtein(typo.toLowerCase(), s);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

const USAGE = [
  "Usage: hades browser <command>",
  "",
  "Commands:",
  "  open <url> [--json] [--max-bytes N]   Fetch and render one URL",
  "  bench [--json]                        Run the real browse-bench checkpoint",
  "  probe [--json]                        Report Chromium/display availability",
  "  help                                  Show this help",
];

function printUsage(deps: BrowserCliDeps): void {
  for (const line of USAGE) deps.stderr(line);
}

// ===========================================================================
// `open` argv parsing
// ===========================================================================

type ParsedOpen = { url: string; json: boolean; maxBytes?: number };
type ParseError = { error: string };

function parseOpenArgs(args: string[]): ParsedOpen | ParseError {
  let url: string | undefined;
  let json = false;
  let maxBytes: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--max-bytes") {
      const v = args[++i];
      if (v === undefined) return { error: "--max-bytes requires a value" };
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return { error: `--max-bytes must be a positive integer, got "${v}"` };
      }
      maxBytes = n;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    if (url !== undefined) return { error: `unexpected extra argument: ${a}` };
    url = a;
  }

  if (url === undefined) return { error: "missing <url>" };
  return maxBytes === undefined ? { url, json } : { url, json, maxBytes };
}

function parseJsonOnlyFlags(args: string[]): { json: boolean } | ParseError {
  let json = false;
  for (const a of args) {
    if (a === "--json") {
      json = true;
      continue;
    }
    return { error: `unknown flag: ${a}` };
  }
  return { json };
}

// ===========================================================================
// Human-readable formatting (local — does NOT import browse-bench.ts's
// formatBrowseBenchReport; a documented structural twin, per the locked
// node-built-ins-only import boundary for this file).
// ===========================================================================

function formatBenchHuman(r: BrowserBenchReportLike): string[] {
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
  return lines;
}

function formatProbeHuman(p: BrowserProbeResult): string[] {
  return [
    `chromium:        ${p.chromiumFound ? `found (${p.chromiumPath ?? "?"})` : "NOT FOUND"}`,
    `headed display:  ${p.headedOk ? "available" : `unavailable${p.reason ? ` (${p.reason})` : ""}`}`,
  ];
}

// Stable, fixed-key-order JSON objects, independent of whatever property
// order the injected deps happen to return in — so `--json` output is
// byte-stable and safely parseable/diffable across runs.
function benchToStableJson(r: BrowserBenchReportLike): string {
  return JSON.stringify({
    ok: r.ok,
    chromium: { found: r.chromium.found, path: r.chromium.path ?? null },
    pagesVisited: r.pagesVisited,
    linksFollowed: r.linksFollowed,
    passages: r.passages,
    citedAll: r.citedAll,
    traceVerified: r.traceVerified,
    traceRoot: r.traceRoot,
    eventCount: r.eventCount,
    elapsedMs: r.elapsedMs,
    failures: r.failures,
  });
}

function probeToStableJson(p: BrowserProbeResult): string {
  return JSON.stringify({
    chromiumFound: p.chromiumFound,
    chromiumPath: p.chromiumPath ?? null,
    headedOk: p.headedOk,
    reason: p.reason ?? null,
  });
}

function openToStableJson(r: BrowserOpenResult): string {
  return JSON.stringify({ ok: r.ok, output: r.output });
}

// ===========================================================================
// Subcommand handlers
// ===========================================================================

async function runOpen(deps: BrowserCliDeps, args: string[]): Promise<number> {
  const parsed = parseOpenArgs(args);
  if ("error" in parsed) {
    deps.stderr(`browser open: ${parsed.error}`);
    printUsage(deps);
    return 2;
  }

  try {
    const req: BrowserOpenRequest = parsed.maxBytes === undefined ? { url: parsed.url } : { url: parsed.url, maxBytes: parsed.maxBytes };
    const result = await deps.browse(req);
    if (parsed.json) {
      deps.stdout(openToStableJson(result));
    } else {
      deps.stdout(result.output);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    deps.stderr(`browser open: ${messageOf(err)}`);
    return 1;
  }
}

async function runBench(deps: BrowserCliDeps, args: string[]): Promise<number> {
  const parsed = parseJsonOnlyFlags(args);
  if ("error" in parsed) {
    deps.stderr(`browser bench: ${parsed.error}`);
    printUsage(deps);
    return 2;
  }

  try {
    const report = await deps.bench();
    if (parsed.json) {
      deps.stdout(benchToStableJson(report));
    } else {
      for (const line of formatBenchHuman(report)) deps.stdout(line);
    }
    return report.ok ? 0 : 1;
  } catch (err) {
    deps.stderr(`browser bench: ${messageOf(err)}`);
    return 1;
  }
}

function runProbe(deps: BrowserCliDeps, args: string[]): number {
  const parsed = parseJsonOnlyFlags(args);
  if ("error" in parsed) {
    deps.stderr(`browser probe: ${parsed.error}`);
    printUsage(deps);
    return 2;
  }

  try {
    const result = deps.probe();
    if (parsed.json) {
      deps.stdout(probeToStableJson(result));
    } else {
      for (const line of formatProbeHuman(result)) deps.stdout(line);
    }
    return 0;
  } catch (err) {
    deps.stderr(`browser probe: ${messageOf(err)}`);
    return 1;
  }
}

// ===========================================================================
// Public factory (locked)
// ===========================================================================

/**
 * Build the `hades browser <sub>` command from an injected `BrowserCliDeps`.
 * Never throws: every `deps` call is wrapped so a rejected promise or a
 * synchronous throw maps to exit code 1 with the error printed to
 * `deps.stderr`, instead of propagating out of `run`.
 */
export function buildBrowserCommand(deps: BrowserCliDeps): BrowserCliCommand {
  return {
    name: "browser",
    description: "Real headless-browser CLI: open a URL, run the browse-bench checkpoint, or probe Chromium/display availability.",
    async run(argv: string[]): Promise<number> {
      const [sub, ...rest] = argv;

      if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
        printUsage(deps);
        return 2;
      }

      if (sub === "open") return runOpen(deps, rest);
      if (sub === "bench") return runBench(deps, rest);
      if (sub === "probe") return runProbe(deps, rest);

      const suggestion = suggestSubcommand(sub);
      deps.stderr(`Unknown browser command: ${sub}${suggestion ? ` (did you mean "${suggestion}"?)` : ""}`);
      printUsage(deps);
      return 2;
    },
  };
}
