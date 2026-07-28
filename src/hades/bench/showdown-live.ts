/* ------------------------------------------------------------------ *
 * showdown-live.ts — the LIVE, keyed, budgeted, manifested exit lane
 * around `hades showdown`'s `mode: "real"` engine.
 *
 * HONESTY CONTRACT (read this before touching anything below):
 *
 *   The numbers this module produces exist ONLY when:
 *     1. a real provider API key was present in the environment at
 *        preflight time, AND
 *     2. a real `runShowdown({ mode: "real" })` run actually happened
 *        against that provider.
 *
 *   There is no code path here that fabricates, estimates, or falls back
 *   to modeled/scripted numbers. If no key is configured, `runLiveShowdown`
 *   throws before doing any work — it never silently substitutes a
 *   deterministic demo for a live result (see `preflightLiveShowdown` and
 *   the refusal message it drives). If the engine ever hands back a result
 *   whose `mode` isn't `"real"`, or whose audit hash chain doesn't
 *   independently re-verify, this module refuses to publish it: no
 *   `manifest.json`, no artifacts, just an honest thrown error.
 *
 * This module is the "exit lane": it wraps the real `runShowdown` /
 * `writeShowdownArtifacts` / `compareVtph` engine (imported, never
 * reimplemented) with:
 *   - a local, key-material-free preflight check (`preflightLiveShowdown`),
 *   - a wall-clock spending guard (`maxWallMs`),
 *   - a sha256 manifest over the exact bytes of every published artifact
 *     (`manifest.json`, hashed via the same `sha256Hex` engine
 *     `src/hades/browser/trace.ts` uses), and
 *   - an independent re-verifier (`verifyLiveArtifacts`) that re-reads
 *     everything from disk and re-derives every claim rather than trusting
 *     any single file.
 *
 * Import boundary (locked): this module reaches into the real engine ONLY
 * through `runShowdown` / `verifyAuditChain` / `ShowdownResult` /
 * `ShowdownMode` (./showdown), `writeShowdownArtifacts` /
 * `renderShowdownMarkdown` / `ShowdownFsDeps` (./showdown-report),
 * `compareVtph` (./vtph), and `sha256Hex` (../styx/certificate — the same
 * relative path `src/hades/browser/trace.ts` uses, since both files live
 * two levels under `src/hades/`). No other project module is imported.
 * ------------------------------------------------------------------ */

import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { runShowdown, verifyAuditChain } from "./showdown";
import type { ShowdownResult, ShowdownMode } from "./showdown";
import { writeShowdownArtifacts, renderShowdownMarkdown } from "./showdown-report";
import type { ShowdownFsDeps } from "./showdown-report";
import { compareVtph } from "./vtph";
import { sha256Hex } from "../styx/certificate";

const execFileAsync = promisify(execFile);

// ===========================================================================
// Key preflight — reads env var NAMES only, never key material
// ===========================================================================

/**
 * Result of {@link preflightLiveShowdown}: whether a live-run-capable
 * provider key was found, which provider/model it points at, and a set of
 * human-readable reasons. `reasons` NEVER contains key material — only
 * literal env var names and fixed prose — so it is always safe to print
 * verbatim to a terminal, log, or thrown error message.
 */
export interface LivePreflight {
  ok: boolean;
  provider?: "anthropic" | "openai";
  model?: string;
  reasons: string[];
}

/**
 * Detects a usable live-inference provider key from `env`, checking
 * `ANTHROPIC_API_KEY` first, then `OPENAI_API_KEY` — mirroring
 * `showdown.ts`'s `detectProviderEnv` priority order exactly, but
 * reimplemented locally against env var NAMES only (this function never
 * imports, returns, echoes, or logs the key value itself; `reasons` is
 * built entirely from fixed prose and env var names).
 *
 * Model selection mirrors `showdown.ts`'s real-mode defaults exactly
 * (`claude-sonnet-5` for Anthropic, `gpt-4o-mini` for OpenAI) so a
 * manifest's `model` field always names the model the real engine will
 * actually invoke.
 */
export function preflightLiveShowdown(env: Record<string, string | undefined>): LivePreflight {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0) {
    return {
      ok: true,
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasons: ["ANTHROPIC_API_KEY is set (value not logged)."],
    };
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0) {
    return {
      ok: true,
      provider: "openai",
      model: "gpt-4o-mini",
      reasons: ["OPENAI_API_KEY is set (value not logged)."],
    };
  }
  return {
    ok: false,
    reasons: [
      "ANTHROPIC_API_KEY is not set.",
      "OPENAI_API_KEY is not set.",
      "A live showdown requires one of these two env vars to hold a real provider API key.",
    ],
  };
}

// ===========================================================================
// Manifest contract
// ===========================================================================

/** Bump this only on a breaking change to {@link LiveRunManifest}'s shape. */
export const LIVE_MANIFEST_VERSION = 1;

/**
 * The durable, independently-re-derivable record of one live showdown run.
 * Every number in here is copied straight from the real {@link ShowdownResult}
 * / `VtphReport` fields the engine produced — nothing here is computed by
 * this module's own arithmetic (the sha256 hashes are the one exception:
 * they are computed by this module, over the exact bytes each artifact file
 * contains on disk).
 */
export interface LiveRunManifest {
  version: 1;
  mode: "real";
  seed: number;
  taskCount: number;
  provider: string;
  model: string;
  nodeVersion: string;
  gitCommit?: string;
  startedAt: number;
  finishedAt: number;
  wallMs: number;
  files: Array<{ name: "report.md" | "audit.jsonl" | "result.json"; sha256: string }>;
  /** Headline figures copied verbatim from the run's `VtphReport`s. The
   *  `swarmVerifiedYield`/`baselineVerifiedYield` fields (trust-adjusted
   *  verified-yield, see `vtph.ts`) are OPTIONAL for backward compatibility:
   *  manifests published before the metric existed lack them, and a verifier
   *  must treat their absence as "not recorded", never as a failure. */
  vtph: {
    swarm: number;
    baseline: number;
    /** best/worst V-TPH$ ratio, or `null` when the comparison lane scored
     *  zero and the ratio is undefined. Never `Infinity`: that is not
     *  representable in JSON, so a manifest carrying it could never be
     *  re-verified against a fresh recomputation. */
    multiple: number | null;
    swarmVerified: number;
    baselineVerified: number;
    swarmVerifiedYield?: number;
    baselineVerifiedYield?: number;
  };
}

// ===========================================================================
// Deps / options
// ===========================================================================

/** Minimal fs surface this module needs — write/rename (via `ShowdownFsDeps`,
 *  reused unmodified from `writeShowdownArtifacts`'s own contract) plus
 *  `readFile`, needed both to read back what was just written (for hashing)
 *  and by {@link verifyLiveArtifacts} to re-read everything from disk. */
export type LiveShowdownFsDeps = ShowdownFsDeps & { readFile(path: string, enc: BufferEncoding): Promise<string> };

/**
 * Injectable dependencies for {@link runLiveShowdown}. Every field is
 * optional and defaults to the real thing (`runShowdown`, real
 * `node:fs/promises`, `process.env`, `Date.now`, `process.version`, a real
 * `git rev-parse HEAD`) — tests inject fakes/stubs here rather than this
 * module ever branching on "am I in a test".
 */
export interface LiveShowdownDeps {
  runShowdownFn?: typeof runShowdown;
  fs?: LiveShowdownFsDeps;
  env?: Record<string, string | undefined>;
  now?: () => number;
  nodeVersion?: string;
  gitCommit?: () => Promise<string | undefined>;
  onProgress?: (done: number, total: number) => void;
}

/** Options for one live run. `taskCount` defaults to 12 and is hard-capped
 *  at 50 (a live run spends real money per task — this cap is a spending
 *  guard, not a suggestion). `maxWallMs` defaults to 15 minutes. */
export interface LiveShowdownOptions {
  seed: number;
  taskCount?: number;
  outDir: string;
  maxWallMs?: number;
}

const DEFAULT_TASK_COUNT = 12;
const MAX_TASK_COUNT = 50;
const DEFAULT_MAX_WALL_MS = 15 * 60 * 1000;

function resolveTaskCount(taskCount: number | undefined): number {
  if (taskCount === undefined) return DEFAULT_TASK_COUNT;
  if (!Number.isInteger(taskCount) || taskCount <= 0) {
    throw new RangeError(`runLiveShowdown: taskCount must be a positive integer, got ${String(taskCount)}`);
  }
  if (taskCount > MAX_TASK_COUNT) {
    throw new RangeError(
      `runLiveShowdown: taskCount ${taskCount} exceeds the hard cap of ${MAX_TASK_COUNT} tasks for a live ` +
        "(keyed, billed) run — raise MAX_TASK_COUNT only if you mean to spend more real money per run."
    );
  }
  return taskCount;
}

function assertFiniteSeed(seed: number): void {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`runLiveShowdown: seed must be a finite number, got ${String(seed)}`);
  }
}

function resolveMaxWallMs(maxWallMs: number | undefined): number {
  if (maxWallMs === undefined) return DEFAULT_MAX_WALL_MS;
  if (!Number.isFinite(maxWallMs) || maxWallMs <= 0) {
    throw new RangeError(`runLiveShowdown: maxWallMs must be a positive finite number, got ${String(maxWallMs)}`);
  }
  return maxWallMs;
}

async function resolveDefaultLiveFs(): Promise<LiveShowdownFsDeps> {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  return { mkdir, writeFile, rename, readFile };
}

/** Real default: `git rev-parse HEAD` in the current working directory.
 *  Never throws — a missing/broken git checkout just means `gitCommit` is
 *  omitted from the manifest, never a reason to fail a live run. */
async function defaultGitCommit(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    const commit = stdout.trim();
    return commit.length > 0 ? commit : undefined;
  } catch {
    return undefined;
  }
}

// ===========================================================================
// runLiveShowdown
// ===========================================================================

/**
 * Run ONE live (real, keyed, billed) showdown and publish a manifested
 * artifact set, or throw before doing any work / writing anything.
 *
 * Order of operations (every gate below either passes cleanly or the
 * function throws with NOTHING written to disk):
 *   1. Validate `seed` (finite) and `taskCount` (positive integer ≤ 50).
 *   2. {@link preflightLiveShowdown} against `deps.env ?? process.env`. No
 *      key ⇒ throw naming the env vars, explicitly stating no modeled
 *      fallback occurred.
 *   3. Invoke `deps.runShowdownFn ?? runShowdown` with `mode: "real"` ONLY
 *      — this module never passes `mode: "modeled"` to the engine.
 *   4. Refuse (throw) if the result's `mode !== "real"` — a modeled result
 *      is never relabeled as live.
 *   5. Refuse (throw) if `verifyAuditChain(result.audit)` fails.
 *   6. Refuse (throw, naming elapsed vs. budget) if the wall-clock elapsed
 *      (measured with the same injected/real `now` the engine itself used)
 *      exceeds `maxWallMs`.
 *   7. Write `report.md` / `audit.jsonl` / `result.json` via the REAL
 *      `writeShowdownArtifacts`, read each one back, and hash the exact
 *      bytes on disk with `sha256Hex`.
 *   8. Write `manifest.json` atomically (tmp file + rename) through the
 *      injected fs.
 */
export async function runLiveShowdown(
  opts: LiveShowdownOptions,
  deps: LiveShowdownDeps = {}
): Promise<{ result: ShowdownResult; manifest: LiveRunManifest; files: string[] }> {
  assertFiniteSeed(opts.seed);
  const taskCount = resolveTaskCount(opts.taskCount);
  const maxWallMs = resolveMaxWallMs(opts.maxWallMs);
  if (!opts.outDir || opts.outDir.trim().length === 0) {
    throw new Error("runLiveShowdown: outDir must be a non-empty path.");
  }

  const env = deps.env ?? process.env;
  const preflight = preflightLiveShowdown(env);
  if (!preflight.ok || !preflight.provider || !preflight.model) {
    throw new Error(
      `runLiveShowdown: refusing to run a live showdown — ${preflight.reasons.join(" ")} ` +
        "No modeled fallback occurred: live V-TPH$ numbers are only ever produced by a real, keyed run. " +
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY and retry."
    );
  }

  const runShowdownFn = deps.runShowdownFn ?? runShowdown;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  let result: ShowdownResult;
  try {
    result = await runShowdownFn({
      mode: "real" as ShowdownMode,
      seed: opts.seed,
      taskCount,
      now,
      onProgress: deps.onProgress,
    });
  } catch (err) {
    throw new Error(
      `runLiveShowdown: the real showdown run failed before producing a result: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
  const finishedAt = now();
  const wallMs = Math.max(0, finishedAt - startedAt);

  if (result.mode !== "real") {
    throw new Error(
      `runLiveShowdown: refusing to publish — the run returned mode "${result.mode}", not "real". ` +
        "A modeled/scripted result is never relabeled as a live run."
    );
  }

  const chainCheck = verifyAuditChain(result.audit);
  if (!chainCheck.ok) {
    throw new Error(
      `runLiveShowdown: refusing to publish — audit chain verification failed at record index ` +
        `${chainCheck.brokenAt ?? "?"} (${result.audit.length} record(s)).`
    );
  }

  if (wallMs > maxWallMs) {
    throw new Error(
      `runLiveShowdown: wall-clock budget exceeded — elapsed ${wallMs}ms > budget ${maxWallMs}ms. ` +
        "Refusing to publish artifacts for a run that overran its time budget; nothing was written."
    );
  }

  const fs = deps.fs ?? (await resolveDefaultLiveFs());
  const { files } = await writeShowdownArtifacts(result, opts.outDir, fs);

  const expectedMarkdown = renderShowdownMarkdown(result);
  const fileHashes: LiveRunManifest["files"] = [];
  for (const filePath of files) {
    const name = basename(filePath) as "report.md" | "audit.jsonl" | "result.json";
    const content = await fs.readFile(filePath, "utf8");
    if (name === "report.md" && content !== expectedMarkdown) {
      throw new Error(
        "runLiveShowdown: internal consistency check failed — report.md on disk does not match a fresh " +
          "renderShowdownMarkdown(result); refusing to publish a manifest hashing an inconsistent artifact."
      );
    }
    fileHashes.push({ name, sha256: sha256Hex(content) });
  }

  const gitCommit = deps.gitCommit ? await deps.gitCommit() : await defaultGitCommit();
  const nodeVersion = deps.nodeVersion ?? process.version;

  const manifest: LiveRunManifest = {
    version: LIVE_MANIFEST_VERSION,
    mode: "real",
    seed: opts.seed,
    taskCount: result.taskCount,
    provider: preflight.provider,
    model: preflight.model,
    nodeVersion,
    gitCommit,
    startedAt,
    finishedAt,
    wallMs,
    files: fileHashes,
    vtph: {
      swarm: result.swarmReport.vtphPerDollar,
      baseline: result.baselineReport.vtphPerDollar,
      multiple: result.comparison.vtphPerDollarSpeedup,
      swarmVerified: result.swarmReport.verifiedCorrect,
      baselineVerified: result.baselineReport.verifiedCorrect,
      swarmVerifiedYield: result.swarmReport.verifiedYield,
      baselineVerifiedYield: result.baselineReport.verifiedYield,
    },
  };

  const manifestPath = join(opts.outDir, "manifest.json");
  const manifestTmpPath = `${manifestPath}.tmp`;
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  try {
    await fs.writeFile(manifestTmpPath, manifestJson, "utf8");
    await fs.rename(manifestTmpPath, manifestPath);
  } catch (err) {
    throw new Error(
      `runLiveShowdown: failed to write manifest.json atomically — ${err instanceof Error ? err.message : String(err)}. ` +
        "The report/audit/result artifacts were written, but no manifest.json exists; treat this output " +
        "directory as unpublished until manifest.json is present."
    );
  }

  return { result, manifest, files: [...files, manifestPath] };
}

// ===========================================================================
// verifyLiveArtifacts — independent, adversarial-grade re-verification
// ===========================================================================

/** A speedup/multiple cross-check tolerance: absorbs floating-point rounding
 *  from the double division chain in `vtph.ts`'s own formula and from the
 *  synthetic single-task replay below — NOT a leniency toward real
 *  discrepancies (real tamper deltas are always many orders of magnitude
 *  larger than this). */
const NUMERIC_TOLERANCE = 1e-6;

function numbersClose(a: number, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Plain unit conversion (ms per hour) — NOT a reimplementation of the
 *  V-TPH$ scoring/classification logic in `vtph.ts`, which this module
 *  never duplicates; used only to pick synthetic elapsed-time/spend inputs
 *  that make the REAL `compareVtph` reproduce a target `vtphPerDollar`. */
const MS_PER_HOUR = 3_600_000;

/** The (elapsedMs, usd) inputs a single always-verified synthetic task needs
 *  so that `runVtph`'s real formula (`verifiedCorrect / (max(wallClockMs, 1)
 *  / 3.6e6)`, divided by `max(usd, 1e-9)`) reproduces `targetVtphPerDollar`.
 *  The real engine FLOORS its time denominator at 1ms, so for targets at or
 *  below 3.6e6 the elapsed time carries the target with a fixed $1 spend,
 *  while for larger targets the elapsed time pins at the 1ms floor and the
 *  spend scales below $1 instead (exact for any target the engine's own
 *  floored-dollar formula can distinguish, i.e. up to 3.6e15). For a
 *  non-positive target, the synthetic runner is built to decline instead
 *  (see `buildSyntheticVtphRunner`), so the exact inputs here are moot —
 *  any positive placeholders work. */
function syntheticVtphInputs(targetVtphPerDollar: number): { wallMs: number; usd: number } {
  if (!(targetVtphPerDollar > 0)) return { wallMs: 1, usd: 1 };
  const idealMs = MS_PER_HOUR / targetVtphPerDollar;
  if (idealMs >= 1) return { wallMs: idealMs, usd: 1 };
  return { wallMs: 1, usd: idealMs };
}

/** A single-task runner engineered so that running it through the REAL
 *  `runVtph`/`compareVtph` (with the controlled spend and elapsed time from
 *  {@link syntheticVtphInputs}) reproduces `targetVtphPerDollar` as its
 *  lane's `vtphPerDollar`. */
function buildSyntheticVtphRunner(targetVtphPerDollar: number, usd: number) {
  const verified = targetVtphPerDollar > 0;
  return async () => ({
    output: "x",
    claimedVerified: verified,
    tokensIn: 0,
    tokensOut: 0,
    usd,
    provenance: verified ? (["synthetic-recomputation"] as string[]) : ([] as string[]),
  });
}

const SYNTHETIC_VERIFY_TASK = {
  id: "live-verify-synthetic",
  prompt: "",
  category: "synthetic",
  decomposable: false,
  grade: (_output: string) => true,
};

/**
 * Freshly recompute the swarm/baseline V-TPH$ "multiple" through the REAL
 * `compareVtph` — not by copying `result.comparison.vtphPerDollarSpeedup`,
 * and not by hand-reimplementing its best/worst formula. Two synthetic
 * single-task runners are engineered (via a controlled `now` sequence and a
 * fixed $1 spend) so that `compareVtph` derives, from each, exactly the
 * persisted per-lane `vtphPerDollar` — then the REAL function computes the
 * speedup from those. Because this only depends on the (hash-verified)
 * per-lane `vtphPerDollar` numbers, a manifest whose `vtph.multiple` was
 * hand-edited to a value inconsistent with those two numbers is caught
 * here even if every individual field otherwise "looks" internally
 * consistent.
 */
async function recomputeVtphMultiple(
  swarmVtphPerDollar: number,
  baselineVtphPerDollar: number
): Promise<number | null> {
  const swarmInputs = syntheticVtphInputs(swarmVtphPerDollar);
  const baselineInputs = syntheticVtphInputs(baselineVtphPerDollar);
  const sequence = [0, swarmInputs.wallMs, 0, baselineInputs.wallMs];
  let i = 0;
  const now = (): number => sequence[Math.min(i++, sequence.length - 1)];

  const comparison = await compareVtph(
    [
      { label: "swarm", runner: buildSyntheticVtphRunner(swarmVtphPerDollar, swarmInputs.usd) },
      { label: "baseline", runner: buildSyntheticVtphRunner(baselineVtphPerDollar, baselineInputs.usd) },
    ],
    [SYNTHETIC_VERIFY_TASK],
    { concurrency: 1, now }
  );
  return comparison.vtphPerDollarSpeedup;
}

function safeJsonParse<T>(raw: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Independently re-verify a live run's published artifact directory.
 * Re-reads all four files (`manifest.json`, `report.md`, `audit.jsonl`,
 * `result.json`) fresh from disk and re-derives every claim rather than
 * trusting any single file — no finding is "first-only"; every applicable
 * check runs and every mismatch is collected before returning. `ok` is
 * `true` iff `findings` is empty.
 */
export async function verifyLiveArtifacts(
  dir: string,
  fs?: LiveShowdownFsDeps
): Promise<{ ok: boolean; findings: string[] }> {
  const fsDeps = fs ?? (await resolveDefaultLiveFs());
  const findings: string[] = [];

  const manifestPath = join(dir, "manifest.json");
  const reportPath = join(dir, "report.md");
  const auditPath = join(dir, "audit.jsonl");
  const resultPath = join(dir, "result.json");

  const reads: Record<string, string | undefined> = {};
  for (const [label, path] of [
    ["manifest.json", manifestPath],
    ["report.md", reportPath],
    ["audit.jsonl", auditPath],
    ["result.json", resultPath],
  ] as const) {
    try {
      reads[label] = await fsDeps.readFile(path, "utf8");
    } catch (err) {
      findings.push(`could not read ${label} from ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const manifestRaw = reads["manifest.json"];
  const reportRaw = reads["report.md"];
  const auditRaw = reads["audit.jsonl"];
  const resultRaw = reads["result.json"];
  if (manifestRaw === undefined || reportRaw === undefined || auditRaw === undefined || resultRaw === undefined) {
    return { ok: false, findings };
  }

  const manifestParsed = safeJsonParse<LiveRunManifest>(manifestRaw);
  if (!manifestParsed.ok) findings.push("manifest.json is not valid JSON.");

  const resultParsed = safeJsonParse<ShowdownResult>(resultRaw);
  if (!resultParsed.ok) findings.push("result.json is not valid JSON.");

  const auditLines = auditRaw.split("\n").filter((l) => l.trim().length > 0);
  const auditRecords: ShowdownResult["audit"] = [];
  let auditParseOk = true;
  for (let i = 0; i < auditLines.length; i++) {
    const parsed = safeJsonParse<ShowdownResult["audit"][number]>(auditLines[i]);
    if (!parsed.ok) {
      findings.push(`audit.jsonl line ${i + 1} of ${auditLines.length} is not valid JSON.`);
      auditParseOk = false;
      continue;
    }
    auditRecords.push(parsed.value);
  }

  if (!manifestParsed.ok || !resultParsed.ok) {
    return { ok: false, findings };
  }
  const manifest = manifestParsed.value;
  const result = resultParsed.value;

  // -- version / mode guards -------------------------------------------------
  if (manifest.version !== LIVE_MANIFEST_VERSION) {
    findings.push(`manifest.json version is ${JSON.stringify(manifest.version)}, expected ${LIVE_MANIFEST_VERSION}.`);
  }
  if (manifest.mode !== "real") {
    findings.push(`manifest.json mode is ${JSON.stringify(manifest.mode)}, expected "real".`);
  }
  if (result.mode !== "real") {
    findings.push(
      `result.json mode is ${JSON.stringify(result.mode)}, expected "real" — a modeled result must never be ` +
        "published/relabeled as a live run."
    );
  }

  // -- audit chain re-verification -------------------------------------------
  if (auditParseOk) {
    const chainCheck = verifyAuditChain(auditRecords);
    if (!chainCheck.ok) {
      findings.push(
        `audit.jsonl hash chain verification failed at record index ${chainCheck.brokenAt ?? "?"} ` +
          `(${auditRecords.length} record(s) read).`
      );
    }
  }

  // -- audit.jsonl vs result.json's embedded audit array ---------------------
  if (auditParseOk && Array.isArray(result.audit)) {
    if (auditRecords.length !== result.audit.length) {
      findings.push(
        `audit.jsonl has ${auditRecords.length} record(s) but result.json's audit array has ` +
          `${result.audit.length} — likely truncation or a mismatched pairing of the two files.`
      );
    } else if (JSON.stringify(auditRecords) !== JSON.stringify(result.audit)) {
      findings.push("audit.jsonl records differ from result.json's embedded audit array.");
    }
  }

  // -- taskCount / seed cross-checks -----------------------------------------
  if (typeof manifest.taskCount === "number" && typeof result.taskCount === "number" && manifest.taskCount !== result.taskCount) {
    findings.push(
      `manifest.json taskCount (${manifest.taskCount}) does not match result.json taskCount (${result.taskCount}).`
    );
  }
  if (typeof manifest.seed === "number" && typeof result.seed === "number" && manifest.seed !== result.seed) {
    findings.push(`manifest.json seed (${manifest.seed}) does not match result.json seed (${result.seed}).`);
  }

  // -- per-file sha256 vs manifest --------------------------------------------
  const fileContents: Record<"report.md" | "audit.jsonl" | "result.json", string> = {
    "report.md": reportRaw,
    "audit.jsonl": auditRaw,
    "result.json": resultRaw,
  };
  if (Array.isArray(manifest.files)) {
    const seenNames = new Set<string>();
    for (const entry of manifest.files) {
      seenNames.add(entry.name);
      const content = fileContents[entry.name];
      if (content === undefined) {
        findings.push(`manifest.json references an unrecognized file name ${JSON.stringify(entry.name)}.`);
        continue;
      }
      const actual = sha256Hex(content);
      if (actual !== entry.sha256) {
        findings.push(
          `sha256 mismatch for ${entry.name}: manifest.json says ${entry.sha256}, actual file content hashes ` +
            `to ${actual} — the file was modified after the manifest was written (or vice versa).`
        );
      }
    }
    for (const required of ["report.md", "audit.jsonl", "result.json"] as const) {
      if (!seenNames.has(required)) findings.push(`manifest.json is missing a files[] entry for ${required}.`);
    }
  } else {
    findings.push("manifest.json is missing a valid files[] array.");
  }

  // -- vtph cross-checks: direct field copies, then a fresh recomputation ----
  const swarmVtphPerDollar = result.swarmReport?.vtphPerDollar;
  const baselineVtphPerDollar = result.baselineReport?.vtphPerDollar;
  const swarmVerified = result.swarmReport?.verifiedCorrect;
  const baselineVerified = result.baselineReport?.verifiedCorrect;
  // verifiedYield is OPTIONAL-ON-READ: artifact dirs published before the
  // trust-adjusted metric existed carry neither the report field nor the
  // manifest fields, and their absence must verify clean — only a dir whose
  // result.json DOES carry the field is held to the copy-consistency check.
  const swarmVerifiedYield = result.swarmReport?.verifiedYield;
  const baselineVerifiedYield = result.baselineReport?.verifiedYield;
  const comparisonMultiple = result.comparison?.vtphPerDollarSpeedup;

  if (!manifest.vtph || typeof manifest.vtph !== "object") {
    findings.push("manifest.json is missing a valid vtph object.");
  } else {
    if (typeof swarmVtphPerDollar === "number" && manifest.vtph.swarm !== swarmVtphPerDollar) {
      findings.push(
        `manifest.json vtph.swarm (${manifest.vtph.swarm}) does not match result.json swarmReport.vtphPerDollar ` +
          `(${swarmVtphPerDollar}).`
      );
    }
    if (typeof baselineVtphPerDollar === "number" && manifest.vtph.baseline !== baselineVtphPerDollar) {
      findings.push(
        `manifest.json vtph.baseline (${manifest.vtph.baseline}) does not match result.json ` +
          `baselineReport.vtphPerDollar (${baselineVtphPerDollar}).`
      );
    }
    if (typeof swarmVerified === "number" && manifest.vtph.swarmVerified !== swarmVerified) {
      findings.push(
        `manifest.json vtph.swarmVerified (${manifest.vtph.swarmVerified}) does not match result.json ` +
          `swarmReport.verifiedCorrect (${swarmVerified}).`
      );
    }
    if (typeof baselineVerified === "number" && manifest.vtph.baselineVerified !== baselineVerified) {
      findings.push(
        `manifest.json vtph.baselineVerified (${manifest.vtph.baselineVerified}) does not match result.json ` +
          `baselineReport.verifiedCorrect (${baselineVerified}).`
      );
    }
    if (typeof swarmVerifiedYield === "number" && manifest.vtph.swarmVerifiedYield !== swarmVerifiedYield) {
      findings.push(
        `manifest.json vtph.swarmVerifiedYield (${String(manifest.vtph.swarmVerifiedYield)}) does not match ` +
          `result.json swarmReport.verifiedYield (${swarmVerifiedYield}).`
      );
    }
    if (typeof baselineVerifiedYield === "number" && manifest.vtph.baselineVerifiedYield !== baselineVerifiedYield) {
      findings.push(
        `manifest.json vtph.baselineVerifiedYield (${String(manifest.vtph.baselineVerifiedYield)}) does not match ` +
          `result.json baselineReport.verifiedYield (${baselineVerifiedYield}).`
      );
    }

    if (typeof swarmVtphPerDollar === "number" && typeof baselineVtphPerDollar === "number") {
      if (!Number.isFinite(swarmVtphPerDollar) || !Number.isFinite(baselineVtphPerDollar)) {
        findings.push(
          "result.json's per-lane vtphPerDollar figures are not both finite numbers — cannot independently " +
            "recompute the V-TPH$ multiple."
        );
      } else {
        const freshMultiple = await recomputeVtphMultiple(swarmVtphPerDollar, baselineVtphPerDollar);
        // An undefined ratio (null) is a legitimate outcome — it means the
        // comparison lane verified nothing. It must match null-to-null; only
        // a defined ratio is compared numerically.
        const multipleMatches =
          freshMultiple === null
            ? manifest.vtph.multiple === null
            : typeof manifest.vtph.multiple === "number" && numbersClose(freshMultiple, manifest.vtph.multiple);
        if (!multipleMatches) {
          findings.push(
            `manifest.json vtph.multiple (${String(manifest.vtph.multiple)}) does not match a fresh compareVtph ` +
              `recomputation from the persisted per-lane V-TPH$ figures (${freshMultiple}).`
          );
        }
        // Same null-aware rule as the manifest check above: an undefined
        // ratio must agree as null-to-null, and only a defined ratio is
        // compared numerically.
        const resultMultipleMismatch =
          freshMultiple === null
            ? comparisonMultiple !== null && comparisonMultiple !== undefined
            : typeof comparisonMultiple === "number" && !numbersClose(freshMultiple, comparisonMultiple);
        if (resultMultipleMismatch) {
          findings.push(
            `result.json comparison.vtphPerDollarSpeedup (${String(comparisonMultiple)}) does not match a fresh ` +
              `compareVtph recomputation from the persisted per-lane V-TPH$ figures (${String(freshMultiple)}).`
          );
        }
      }
    }
  }

  return { ok: findings.length === 0, findings };
}
