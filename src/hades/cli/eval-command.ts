/**
 * `hades eval <sub>` — the terminal surface over the real continuous-eval
 * engine (`../eval/continuous`, `../eval/regression-gate`, `../eval/bisect`,
 * `../eval/compare`, `../eval/history`).
 *
 *   hades eval status  [--root R] [--branch B] [--trend N] [--json]
 *   hades eval run     [--label L] [--note N]
 *                      [--baseline latest|rolling-median|best-of-window|<sha>]
 *                      [--window N] [--epsilon E] [--no-record] [--gate]
 *                      [--bisect] [--json]
 *   hades eval gate    [--sha S] [--baseline latest|rolling-median|best-of-window|<sha>]
 *                      [--policy <file>] [--set key=value ...] [--show-policy]
 *                      [--json]
 *   hades eval bisect  [--good S] [--bad S]
 *                      [--signal verified|vtph|silent-wrong|silent-wrong-rate|task:<id>]
 *                      [--max-probes N] [--active] [--json]
 *   hades eval history [--limit N] [--branch B] [--sha S] [--verify] [--json]
 *   hades eval help
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a shell
 * or real stdout, matching the rest of `src/hades/cli/*`. Plain aligned
 * ASCII only — this product's front end is the terminal (CLI/TUI) and the
 * native desktop app, never a browser.
 *
 * ## Exit codes (the CI contract)
 *
 *   0  allow / clean.
 *   1  usage error, or an operation that could not run (bad flag, an
 *      unreadable policy file, a corrupt ledger, a rejected
 *      measure/bisect/runContinuous).
 *   2  gate BLOCK — a real regression was refused. Both `hades eval gate`
 *      and `hades eval run --gate` use this, so either can literally be a
 *      CI merge gate.
 *   3  history chain verification failed (`hades eval history --verify`).
 *
 * ## Division of labor with the real engine
 *
 * This module never re-derives a metric, a significance test, a gate rule,
 * or a bisection strategy — every number printed here traces back to a real
 * `EvalScorecard`/`GateVerdict`/`BisectReport` produced by the real engine
 * modules. Stateful/environment-dependent operations (opening the ledger,
 * running a measurement, resolving the current revision, reading/writing the
 * policy file) go through the injected {@link EvalCliDeps} seam so this
 * module stays terminal-free and fully testable without touching a shell or
 * real disk; the PURE, deterministic parts of the engine (`selectBaseline`,
 * `evaluateNeverRegressGate`, `normalizePolicy`, `policyHash`,
 * `predicateFromBaseline`/`taskRegressionPredicate`, and every `format*`
 * reporter) are called directly, per this module's locked import list.
 *
 * `hades eval bisect --active` is refused rather than silently downgraded to
 * history-only mode: active bisection needs to check out arbitrary
 * historical git revisions and re-run the eval suite against each one, which
 * is out of scope for this CLI's deps binding (see `../eval/continuous`'s
 * own module docs for the identical scoping decision at the engine layer).
 */

import { existsSync, readFileSync } from "node:fs";

import type { CliResult } from "./cli";

import { EvalHistoryLedger, type EvalHistoryEntry, type HistoryChainVerification, type HistoryQuery } from "../eval/history";
import type { EvalScorecard, ScorecardRevision } from "../eval/scorecard";
import { selectBaseline, type BaselineSelector, type BaselineSelection } from "../eval/compare";
import {
  evaluateNeverRegressGate,
  normalizePolicy,
  policyHash,
  formatGateVerdict,
  type NeverRegressPolicy,
  type GateVerdict,
} from "../eval/regression-gate";
import {
  taskRegressionPredicate,
  predicateFromBaseline,
  formatBisectReport,
  type RegressionPredicate,
  type BisectRequest,
  type BisectReport,
} from "../eval/bisect";
import {
  formatContinuousResult,
  formatEvalStatus,
  type ContinuousEvalOptions,
  type ContinuousEvalResult,
  type EvalStatusReport,
} from "../eval/continuous";

// ===========================================================================
// Locked deps seam
// ===========================================================================

export interface EvalCliDeps {
  root: string;
  ledger: () => EvalHistoryLedger;
  runContinuous: (opts: ContinuousEvalOptions) => Promise<ContinuousEvalResult>;
  status: (opts: { root: string; branch?: string | null; trendLimit?: number }) => EvalStatusReport;
  bisect: (req: BisectRequest) => Promise<BisectReport>;
  /** The real measurement port. `cmdRun` threads it into
   *  `ContinuousEvalOptions.measure`, passing through the `label`/`now` the
   *  engine's own default closure would otherwise have applied — so binding
   *  a real measurement here (e.g. one with a real `AdmitFn` driving the risk
   *  lane, which `defaultEvalCliDeps` does) never silently makes `--label`
   *  inert. Absent -> the engine uses its own real default measurement. */
  measure?: (revision: ScorecardRevision, opts?: { label?: string; now?: () => number }) => Promise<EvalScorecard>;
  resolveRevision: () => ScorecardRevision;
  loadPolicy: () => { policy: NeverRegressPolicy; source: "file" | "default"; warnings: string[] };
  savePolicy: (p: NeverRegressPolicy) => void;
  readFile?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  now?: () => number;
}

// ===========================================================================
// Small local helpers (own copies — see trust-command.ts's note on this
// convention: each CLI command module keeps its own tiny formatting/parsing
// helpers rather than sharing a grab-bag utility module).
// ===========================================================================

function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usageError(sub: string, message: string): CliResult {
  return { code: 1, lines: [`eval ${sub}: ${message}`, "", ...evalHelpLines()] };
}

function errOut(sub: string, message: string, code: number): CliResult {
  return { code, lines: [`eval ${sub}: ${message}`] };
}

function jsonResult(payload: Record<string, unknown>, code: number): CliResult {
  const body = { ...payload, code };
  return { code, lines: JSON.stringify(body, null, 2).split("\n") };
}

// ---------------------------------------------------------------------------
// Flag parsing — a real, hostile-input-safe parser. Every token is either a
// recognized boolean flag, a recognized valued flag (consuming the NEXT
// token as its value — an error, never a silent drop, if there isn't one),
// a recognized repeatable valued flag, or a positional. An unrecognized
// `-`-prefixed token is always an error; nothing is ever silently ignored.
// ---------------------------------------------------------------------------

interface FlagSpec {
  valued: ReadonlySet<string>;
  boolean: ReadonlySet<string>;
  repeatable?: ReadonlySet<string>;
}

interface ParsedFlags {
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  set: Set<string>;
}

type ParseFlagsResult = { ok: true; parsed: ParsedFlags; positionals: string[] } | { ok: false; error: string };

function parseFlags(args: readonly string[], spec: FlagSpec): ParseFlagsResult {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const set = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (spec.boolean.has(tok)) {
      set.add(tok);
      continue;
    }
    if (spec.valued.has(tok)) {
      const val = args[i + 1];
      if (val === undefined) return { ok: false, error: `${tok} requires a value` };
      values.set(tok, val);
      i++;
      continue;
    }
    if (spec.repeatable?.has(tok)) {
      const val = args[i + 1];
      if (val === undefined) return { ok: false, error: `${tok} requires a value` };
      const list = repeated.get(tok) ?? [];
      list.push(val);
      repeated.set(tok, list);
      i++;
      continue;
    }
    if (tok.startsWith("-")) {
      return { ok: false, error: `unknown flag: ${tok}` };
    }
    positionals.push(tok);
  }

  return { ok: true, parsed: { values, repeated, set }, positionals };
}

interface NumFlagOpts {
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
}

type NumFlagResult = { ok: true; value: number | undefined } | { ok: false; error: string };

function numFlag(values: Map<string, string>, name: string, opts: NumFlagOpts = {}): NumFlagResult {
  const raw = values.get(name);
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw.trim().length === 0) return { ok: false, error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${name} must be a finite number; got ${JSON.stringify(raw)}` };
  if (opts.integer === true && !Number.isInteger(n)) {
    return { ok: false, error: `${name} must be an integer; got ${JSON.stringify(raw)}` };
  }
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `${name} must be >= ${opts.min}; got ${n}` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `${name} must be <= ${opts.max}; got ${n}` };
  if (opts.exclusiveMin !== undefined && n <= opts.exclusiveMin) {
    return { ok: false, error: `${name} must be strictly greater than ${opts.exclusiveMin}; got ${n}` };
  }
  if (opts.exclusiveMax !== undefined && n >= opts.exclusiveMax) {
    return { ok: false, error: `${name} must be strictly less than ${opts.exclusiveMax}; got ${n}` };
  }
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// Baseline selector — shared grammar for `--baseline` on `run` and `gate`:
// one of the three named strategies, or else the argument IS a sha
// (`specific-sha`). `--window` only matters for the two windowed strategies.
// ---------------------------------------------------------------------------

function buildBaselineSelector(raw: string | undefined, opts: { window?: number; candidateSha: string }): BaselineSelector {
  const excludeSha = opts.candidateSha;
  const excludeDirty = true;
  if (raw === undefined || raw === "rolling-median") {
    const sel: BaselineSelector = { strategy: "rolling-median", excludeSha, excludeDirty };
    if (opts.window !== undefined) sel.window = opts.window;
    return sel;
  }
  if (raw === "latest") {
    return { strategy: "latest", excludeSha, excludeDirty };
  }
  if (raw === "best-of-window") {
    const sel: BaselineSelector = { strategy: "best-of-window", excludeSha, excludeDirty };
    if (opts.window !== undefined) sel.window = opts.window;
    return sel;
  }
  return { strategy: "specific-sha", sha: raw, excludeDirty };
}

// ---------------------------------------------------------------------------
// Policy `--set key=value` application — reuses the REAL `normalizePolicy`
// as the sole source of truth for "is this key known, is this value
// well-typed". A `--set` that would have to silently fall back inside
// `normalizePolicy` is instead a hard CLI error (nothing is ever silently
// downgraded into an accepted-but-different policy).
// ---------------------------------------------------------------------------

function applySetOverrides(
  base: NeverRegressPolicy,
  pairs: readonly string[],
): { ok: true; policy: NeverRegressPolicy } | { ok: false; error: string } {
  const draft: Record<string, unknown> = { ...base, waivers: base.waivers.map((w) => ({ ...w })) };
  const keys: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `invalid --set argument "${pair}": expected key=value` };
    }
    const key = pair.slice(0, eq);
    const rawValue = pair.slice(eq + 1);
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    draft[key] = value;
    keys.push(key);
  }

  const { policy: normalized, warnings } = normalizePolicy(draft);
  const offending = warnings.filter((w) =>
    keys.some((k) => new RegExp(`^policy\\.${escapeRegExp(k)}[ =]`).test(w) || w.includes(`unrecognized key "${k}"`)),
  );
  if (offending.length > 0) {
    return { ok: false, error: offending.join(" | ") };
  }
  return { ok: true, policy: normalized };
}

function formatPolicyReport(policy: NeverRegressPolicy, meta: { source: string; warnings: string[] }): string[] {
  const lines: string[] = [];
  lines.push("HADES EVAL GATE POLICY");
  lines.push("=".repeat(72));
  lines.push(`source                      : ${meta.source}`);
  lines.push(`policyHash                  : ${policyHash(policy)}`);
  lines.push(`version                     : ${policy.version}`);
  lines.push(`maxVerifiedCorrectDrop      : ${policy.maxVerifiedCorrectDrop}`);
  lines.push(`maxVtphRelativeDrop         : ${policy.maxVtphRelativeDrop}`);
  lines.push(`maxSilentWrongIncrease      : ${policy.maxSilentWrongIncrease}`);
  lines.push(`maxSilentWrongRateIncrease  : ${policy.maxSilentWrongRateIncrease}`);
  lines.push(`riskEpsilonCeiling          : ${policy.riskEpsilonCeiling ?? "(none)"}`);
  lines.push(`requireRiskLaneMeasured     : ${policy.requireRiskLaneMeasured}`);
  lines.push(`requireSignificance         : ${policy.requireSignificance}`);
  lines.push(`alpha                       : ${policy.alpha}`);
  lines.push(`blockOnTaskRegression       : ${policy.blockOnTaskRegression}`);
  lines.push(`minBaselinePoolSize         : ${policy.minBaselinePoolSize}`);
  lines.push(`onMissingBaseline           : ${policy.onMissingBaseline}`);
  lines.push(`onIncomparable              : ${policy.onIncomparable}`);
  lines.push(`onInvalidScorecard          : ${policy.onInvalidScorecard}`);
  lines.push(`onChainBroken               : ${policy.onChainBroken}`);
  lines.push(`waivers                     : ${policy.waivers.length}`);
  for (const w of policy.waivers) {
    lines.push(`  - rule=${w.rule} taskId=${w.taskId ?? "(any)"} expiresAtMs=${w.expiresAtMs ?? "(never)"} author=${w.author ?? "(none)"}`);
  }
  if (meta.warnings.length > 0) {
    lines.push("");
    lines.push(`WARNINGS (${meta.warnings.length})`);
    for (const w of meta.warnings) lines.push(`  - ${w}`);
  }
  return lines;
}

// ===========================================================================
// status
// ===========================================================================

function cmdStatus(args: string[], deps: EvalCliDeps): CliResult {
  const parsed = parseFlags(args, { valued: new Set(["--root", "--branch", "--trend"]), boolean: new Set(["--json"]) });
  if (!parsed.ok) return usageError("status", parsed.error);
  if (parsed.positionals.length > 0) return usageError("status", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;

  const trend = numFlag(values, "--trend", { integer: true, min: 0 });
  if (!trend.ok) return usageError("status", trend.error);

  const root = values.get("--root") ?? deps.root;
  const branch = values.get("--branch");

  let report: EvalStatusReport;
  try {
    report = deps.status({ root, branch, trendLimit: trend.value });
  } catch (err) {
    return errOut("status", `status() threw: ${describeErr(err)}`, 1);
  }

  if (set.has("--json")) return jsonResult({ report }, 0);
  return { code: 0, lines: formatEvalStatus(report) };
}

// ===========================================================================
// run
// ===========================================================================

async function cmdRun(args: string[], deps: EvalCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, {
    valued: new Set(["--label", "--note", "--baseline", "--window", "--epsilon"]),
    boolean: new Set(["--no-record", "--gate", "--bisect", "--json"]),
  });
  if (!parsed.ok) return usageError("run", parsed.error);
  if (parsed.positionals.length > 0) return usageError("run", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  const windowFlag = numFlag(values, "--window", { integer: true, min: 0 });
  if (!windowFlag.ok) return usageError("run", windowFlag.error);
  const epsilonFlag = numFlag(values, "--epsilon", { exclusiveMin: 0, max: 1 });
  if (!epsilonFlag.ok) return usageError("run", epsilonFlag.error);

  const baselineRaw = values.get("--baseline");
  let baselineSelector: BaselineSelector | undefined;
  let pinnedRevision: ScorecardRevision | undefined;
  if (baselineRaw !== undefined || windowFlag.value !== undefined) {
    try {
      pinnedRevision = deps.resolveRevision();
    } catch (err) {
      return errOut("run", `resolveRevision threw: ${describeErr(err)}`, 1);
    }
    baselineSelector = buildBaselineSelector(baselineRaw, { window: windowFlag.value, candidateSha: pinnedRevision.sha });
  }

  // `--epsilon` sets a TRANSIENT `policy.riskEpsilonCeiling` for this run
  // only (never persisted) — the real `evaluateNeverRegressGate` already
  // enforces `riskEpsilonCeiling` whenever the candidate's risk lane is
  // measured; this just lets one invocation tighten/loosen that bound
  // without touching the on-disk policy file.
  let policyOverride: NeverRegressPolicy | undefined;
  if (epsilonFlag.value !== undefined) {
    try {
      const loaded = deps.loadPolicy();
      policyOverride = { ...loaded.policy, riskEpsilonCeiling: epsilonFlag.value };
    } catch (err) {
      return errOut("run", `loadPolicy threw: ${describeErr(err)}`, 1);
    }
  }

  const opts: ContinuousEvalOptions = {
    root: deps.root,
    record: !set.has("--no-record"),
    bisectOnBlock: set.has("--bisect"),
    now: deps.now,
    label: values.get("--label"),
    note: values.get("--note"),
  };
  if (baselineSelector !== undefined) opts.baseline = baselineSelector;
  if (policyOverride !== undefined) opts.policy = policyOverride;
  // Use the injected measurement port when one is bound. `label`/`now` are
  // passed through explicitly because `runContinuousEval` only threads them
  // into its OWN default closure — forwarding them here is what keeps
  // `--label` meaningful while still measuring through the real port (which,
  // for `defaultEvalCliDeps`, is the one carrying the real trust-gate
  // `AdmitFn` that makes the risk lane genuinely measured).
  const measureFn = deps.measure;
  if (measureFn !== undefined) {
    const label = values.get("--label");
    opts.measure = (rev: ScorecardRevision): Promise<EvalScorecard> =>
      measureFn(rev, { label, now: deps.now });
  }
  if (pinnedRevision !== undefined) {
    const rev = pinnedRevision;
    opts.resolve = () => rev;
  }

  let result: ContinuousEvalResult;
  try {
    result = await deps.runContinuous(opts);
  } catch (err) {
    return errOut("run", `runContinuous rejected: ${describeErr(err)}`, 1);
  }

  const gateRequested = set.has("--gate");
  let code: number;
  if (result.scorecard === null) {
    // No candidate scorecard was ever obtained (ledger open failed, or
    // measure() itself failed) -- this is an operational failure, not a
    // real gate evaluation, regardless of the synthetic engine-failure
    // verdict's `decision` (always "block" by construction; see
    // `../eval/continuous`'s `buildEngineFailureVerdict`).
    code = 1;
  } else if (gateRequested && result.verdict.decision === "block") {
    code = 2;
  } else {
    code = 0;
  }

  if (wantJson) return jsonResult({ gateEnforced: gateRequested, result }, code);

  const lines = [...formatContinuousResult(result)];
  if (result.bisect !== null) {
    lines.push("");
    lines.push(`BISECT CULPRIT (short) : ${result.bisect.culpritShortSha ?? "(none)"}`);
  }
  lines.push("");
  const codeNote = code === 1 ? "operation failed" : code === 2 ? "gate BLOCK" : "allow/clean";
  const gateNote = gateRequested ? "" : " -- gate not enforced (pass --gate to enforce)";
  lines.push(`EXIT CODE: ${code} (${codeNote}${gateNote})`);
  return { code, lines };
}

// ===========================================================================
// gate
// ===========================================================================

async function cmdGate(args: string[], deps: EvalCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, {
    valued: new Set(["--sha", "--baseline", "--policy"]),
    boolean: new Set(["--show-policy", "--json"]),
    repeatable: new Set(["--set"]),
  });
  if (!parsed.ok) return usageError("gate", parsed.error);
  if (parsed.positionals.length > 0) return usageError("gate", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, repeated, set } = parsed.parsed;
  const wantJson = set.has("--json");

  // 0. Pre-validate `--set` SYNTAX (key=value) before touching any deps/IO
  //    -- this is a pure usage error, independent of any engine state, so
  //    it must never depend on `deps.loadPolicy()` succeeding first.
  const setPairs = repeated.get("--set") ?? [];
  for (const pair of setPairs) {
    if (pair.indexOf("=") <= 0) return usageError("gate", `invalid --set argument "${pair}": expected key=value`);
  }

  // 1. Resolve the base policy: a `--policy <file>` override, else the
  //    real `deps.loadPolicy()`.
  let policy: NeverRegressPolicy;
  let policySource: string;
  let loadWarnings: string[];
  const policyFile = values.get("--policy");
  if (policyFile !== undefined) {
    const exists = deps.fileExists ?? existsSync;
    const read = deps.readFile ?? ((p: string): string => readFileSync(p, "utf8"));
    let fileExists: boolean;
    try {
      fileExists = exists(policyFile);
    } catch {
      fileExists = false;
    }
    if (!fileExists) return errOut("gate", `policy file not found: ${policyFile}`, 1);
    let raw: string;
    try {
      raw = read(policyFile);
    } catch (err) {
      return errOut("gate", `cannot read policy file "${policyFile}": ${describeErr(err)}`, 1);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      return errOut("gate", `policy file "${policyFile}" is not valid JSON: ${describeErr(err)}`, 1);
    }
    const norm = normalizePolicy(parsedJson);
    policy = norm.policy;
    loadWarnings = norm.warnings;
    policySource = `file:${policyFile}`;
  } else {
    let loaded: { policy: NeverRegressPolicy; source: "file" | "default"; warnings: string[] };
    try {
      loaded = deps.loadPolicy();
    } catch (err) {
      return errOut("gate", `loadPolicy threw: ${describeErr(err)}`, 1);
    }
    policy = loaded.policy;
    loadWarnings = loaded.warnings;
    policySource = loaded.source;
  }

  // 2. Apply + persist `--set` overrides (atomic real `savePolicy`).
  if (setPairs.length > 0) {
    const applied = applySetOverrides(policy, setPairs);
    if (!applied.ok) return errOut("gate", `--set rejected: ${applied.error}`, 1);
    policy = applied.policy;
    try {
      deps.savePolicy(policy);
    } catch (err) {
      return errOut("gate", `failed to save policy: ${describeErr(err)}`, 1);
    }
  }

  const warnings = loadWarnings;

  // 3. `--show-policy` short-circuits before evaluating anything.
  if (set.has("--show-policy")) {
    if (wantJson) {
      return jsonResult({ policy, policyHash: policyHash(policy), source: policySource, warnings, setApplied: setPairs.length }, 0);
    }
    return { code: 0, lines: formatPolicyReport(policy, { source: policySource, warnings }) };
  }

  // 4. Open the ledger + pick the candidate entry (`--sha`, default: latest).
  let ledger: EvalHistoryLedger;
  try {
    ledger = deps.ledger();
  } catch (err) {
    return errOut("gate", `could not open eval history ledger: ${describeErr(err)}`, 1);
  }
  let entries: EvalHistoryEntry[];
  try {
    entries = ledger.entries();
  } catch (err) {
    return errOut("gate", `ledger.entries() failed: ${describeErr(err)}`, 1);
  }

  const shaFlag = values.get("--sha");
  let candidateEntry: EvalHistoryEntry;
  if (shaFlag !== undefined) {
    const exact = entries.filter((e) => e.sha === shaFlag);
    let matches = exact;
    if (matches.length === 0) matches = entries.filter((e) => e.sha.startsWith(shaFlag));
    if (matches.length === 0) return errOut("gate", `no recorded scorecard found for sha "${shaFlag}"`, 1);
    if (exact.length === 0) {
      const distinct = new Set(matches.map((e) => e.sha));
      if (distinct.size > 1) {
        return errOut("gate", `sha prefix "${shaFlag}" is ambiguous (matches ${distinct.size} distinct recorded shas)`, 1);
      }
    }
    candidateEntry = matches[matches.length - 1];
  } else {
    if (entries.length === 0) return errOut("gate", `no eval history entries recorded at "${deps.root}" -- nothing to gate`, 1);
    candidateEntry = entries[entries.length - 1];
  }

  // 5. Chain + baseline + verdict — the REAL, unmodified engine calls.
  let chain: HistoryChainVerification;
  try {
    chain = ledger.verifyChain();
  } catch (err) {
    return errOut("gate", `ledger.verifyChain() threw: ${describeErr(err)}`, 1);
  }

  const baselineSelector = buildBaselineSelector(values.get("--baseline"), { candidateSha: candidateEntry.sha });
  let baseline: BaselineSelection;
  try {
    baseline = selectBaseline(entries, baselineSelector);
  } catch (err) {
    return errOut("gate", `selectBaseline threw: ${describeErr(err)}`, 1);
  }

  let verdict: GateVerdict;
  try {
    verdict = evaluateNeverRegressGate({ candidate: candidateEntry.scorecard, baseline, policy, chainOk: chain.ok, now: deps.now });
  } catch (err) {
    return errOut("gate", `evaluateNeverRegressGate threw: ${describeErr(err)}`, 1);
  }

  const code = verdict.decision === "block" ? 2 : 0;

  if (wantJson) {
    return jsonResult(
      {
        candidateSha: candidateEntry.sha,
        candidateSeq: candidateEntry.seq,
        chain,
        baseline: { ok: baseline.ok, strategy: baseline.strategy, entrySha: baseline.entry?.sha ?? null, reason: baseline.reason },
        policySource,
        warnings,
        verdict,
      },
      code,
    );
  }

  const lines: string[] = [];
  lines.push("HADES EVAL GATE");
  lines.push("=".repeat(72));
  lines.push(`root         : ${deps.root}`);
  lines.push(`candidateSha : ${candidateEntry.sha} (seq ${candidateEntry.seq})`);
  lines.push(`policySource : ${policySource}`);
  lines.push(
    chain.ok
      ? `chain ok     : true (${chain.entries} entries)`
      : `chain ok     : false (broken at seq ${String(chain.brokenAtSeq)}: ${chain.reason ?? "unknown"})`,
  );
  if (warnings.length > 0) {
    lines.push(`policy warnings (${warnings.length}):`);
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  lines.push(...formatGateVerdict(verdict));
  lines.push("");
  lines.push(`EXIT CODE: ${code} (${code === 2 ? "gate BLOCK" : "allow/clean"})`);
  return { code, lines };
}

// ===========================================================================
// bisect
// ===========================================================================

function metricForSignal(
  signal: "verified" | "vtph" | "silent-wrong" | "silent-wrong-rate",
): "verifiedCorrect" | "vtph" | "silentWrong" | "silentWrongRate" {
  switch (signal) {
    case "verified":
      return "verifiedCorrect";
    case "vtph":
      return "vtph";
    case "silent-wrong":
      return "silentWrong";
    case "silent-wrong-rate":
      return "silentWrongRate";
  }
}

const SIGNAL_PATTERN = /^(verified|vtph|silent-wrong|silent-wrong-rate|task:.+)$/;

async function cmdBisect(args: string[], deps: EvalCliDeps): Promise<CliResult> {
  const parsed = parseFlags(args, {
    valued: new Set(["--good", "--bad", "--signal", "--max-probes"]),
    boolean: new Set(["--active", "--json"]),
  });
  if (!parsed.ok) return usageError("bisect", parsed.error);
  if (parsed.positionals.length > 0) return usageError("bisect", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  if (set.has("--active")) {
    return errOut(
      "bisect",
      "--active requires a real revision-checkout measurement capability this wiring does not provide " +
        "(active bisection would need to check out arbitrary historical git revisions and re-run the eval " +
        "suite against each one, which is out of scope for this deps binding -- see ../eval/continuous's " +
        "own module docs for the identical scoping decision at the engine layer). Omit --active to bisect " +
        "over already-recorded history.",
      1,
    );
  }

  const maxProbes = numFlag(values, "--max-probes", { integer: true, min: 1 });
  if (!maxProbes.ok) return usageError("bisect", maxProbes.error);

  const signalRaw = values.get("--signal") ?? "verified";
  if (!SIGNAL_PATTERN.test(signalRaw)) {
    return usageError(
      "bisect",
      `unknown --signal "${signalRaw}"; expected one of verified|vtph|silent-wrong|silent-wrong-rate|task:<id>`,
    );
  }

  let ledger: EvalHistoryLedger;
  try {
    ledger = deps.ledger();
  } catch (err) {
    return errOut("bisect", `could not open eval history ledger: ${describeErr(err)}`, 1);
  }
  let entries: EvalHistoryEntry[];
  try {
    entries = ledger.entries();
  } catch (err) {
    return errOut("bisect", `ledger.entries() failed: ${describeErr(err)}`, 1);
  }
  if (entries.length === 0) return errOut("bisect", `no eval history entries recorded at "${deps.root}" -- nothing to bisect`, 1);

  const goodSha = values.get("--good");
  const badSha = values.get("--bad") ?? entries[entries.length - 1].sha;

  let predicate: RegressionPredicate;
  if (signalRaw.startsWith("task:")) {
    predicate = taskRegressionPredicate(signalRaw.slice("task:".length));
  } else {
    const metric = metricForSignal(signalRaw as "verified" | "vtph" | "silent-wrong" | "silent-wrong-rate");
    let referenceEntry: EvalHistoryEntry;
    if (goodSha !== undefined) {
      const matches = entries.filter((e) => e.sha === goodSha);
      if (matches.length === 0) return errOut("bisect", `no recorded scorecard found for --good sha "${goodSha}"`, 1);
      referenceEntry = matches[matches.length - 1];
    } else {
      let sel: BaselineSelection;
      try {
        sel = selectBaseline(entries, { strategy: "rolling-median", excludeSha: badSha, excludeDirty: true });
      } catch (err) {
        return errOut("bisect", `selectBaseline threw while building a reference baseline: ${describeErr(err)}`, 1);
      }
      if (!sel.ok || sel.entry === null) {
        return errOut(
          "bisect",
          `cannot build a bisect predicate for signal "${signalRaw}": no baseline scorecard available ` +
            `(${sel.reason ?? "unknown"}); pass --good <sha> explicitly`,
          1,
        );
      }
      referenceEntry = sel.entry;
    }
    predicate = predicateFromBaseline(referenceEntry.scorecard, { metric });
  }

  const badEntries = entries.filter((e) => e.sha === badSha);
  const requireSuiteMatch = badEntries.length > 0;
  const suiteHash = badEntries.length > 0 ? badEntries[badEntries.length - 1].suiteHash : undefined;

  const req: BisectRequest = {
    entries,
    predicate,
    badSha,
    goodSha,
    maxProbes: maxProbes.value,
    requireSuiteMatch,
    suiteHash,
    skipDirty: true,
    now: deps.now,
  };

  let report: BisectReport;
  try {
    report = await deps.bisect(req);
  } catch (err) {
    return errOut("bisect", `bisect rejected: ${describeErr(err)}`, 1);
  }

  const code = report.ok ? 0 : 1;
  if (wantJson) return jsonResult({ report }, code);

  const lines = [...formatBisectReport(report), "", `EXIT CODE: ${code} (${report.ok ? "completed" : "could not complete"})`];
  return { code, lines };
}

// ===========================================================================
// history
// ===========================================================================

function summarizeHistoryEntry(e: EvalHistoryEntry): Record<string, unknown> {
  return {
    seq: e.seq,
    sha: e.sha,
    branch: e.branch,
    mode: e.mode,
    suiteHash: e.suiteHash,
    recordedAtMs: e.recordedAtMs,
    note: e.note,
    prevHash: e.prevHash,
    hash: e.hash,
    verifiedCorrect: e.scorecard.throughput.verifiedCorrect,
    silentWrong: e.scorecard.throughput.silentWrong,
    vtph: e.scorecard.throughput.vtph,
    scorecardId: e.scorecard.scorecardId,
    scorecardContentHash: e.scorecard.contentHash,
  };
}

function cmdHistory(args: string[], deps: EvalCliDeps): CliResult {
  const parsed = parseFlags(args, {
    valued: new Set(["--limit", "--branch", "--sha"]),
    boolean: new Set(["--verify", "--json"]),
  });
  if (!parsed.ok) return usageError("history", parsed.error);
  if (parsed.positionals.length > 0) return usageError("history", `unexpected argument: ${parsed.positionals[0]}`);
  const { values, set } = parsed.parsed;
  const wantJson = set.has("--json");

  const limit = numFlag(values, "--limit", { integer: true, min: 0 });
  if (!limit.ok) return usageError("history", limit.error);

  let ledger: EvalHistoryLedger;
  try {
    ledger = deps.ledger();
  } catch (err) {
    return errOut("history", `could not open eval history ledger: ${describeErr(err)}`, 1);
  }

  const query: HistoryQuery = {};
  const branch = values.get("--branch");
  const sha = values.get("--sha");
  if (branch !== undefined) query.branch = branch;
  if (sha !== undefined) query.sha = sha;
  if (limit.value !== undefined) query.limit = limit.value;

  let entries: EvalHistoryEntry[];
  try {
    entries = ledger.entries(query);
  } catch (err) {
    return errOut("history", `ledger.entries() failed: ${describeErr(err)}`, 1);
  }

  let chain: HistoryChainVerification | null = null;
  if (set.has("--verify")) {
    try {
      chain = ledger.verifyChain();
    } catch (err) {
      return errOut("history", `ledger.verifyChain() threw: ${describeErr(err)}`, 1);
    }
  }

  const code = chain !== null && !chain.ok ? 3 : 0;

  if (wantJson) {
    return jsonResult({ root: deps.root, count: entries.length, entries: entries.map(summarizeHistoryEntry), chain }, code);
  }

  const lines: string[] = [];
  lines.push("HADES EVAL HISTORY");
  lines.push("=".repeat(72));
  lines.push(`root  : ${deps.root}`);
  lines.push(`count : ${entries.length}`);
  lines.push("");
  if (entries.length === 0) {
    lines.push("(no entries)");
  } else {
    const headers = ["SEQ", "SHA", "BRANCH", "MODE", "VERIFIED", "SILENT-WRONG", "VTPH", "NOTE"];
    const rows = entries.map((e) => [
      String(e.seq),
      e.sha.slice(0, 12),
      e.branch ?? "(none)",
      e.mode,
      String(e.scorecard.throughput.verifiedCorrect),
      String(e.scorecard.throughput.silentWrong),
      e.scorecard.throughput.vtph.toFixed(3),
      e.note ?? "",
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) lines.push(row.map((c, i) => padRight(c, widths[i])).join("  "));
  }
  if (chain !== null) {
    lines.push("");
    lines.push(
      chain.ok
        ? `chain verified : true (${chain.entries} entries)`
        : `chain verified : false (brokenAtSeq=${String(chain.brokenAtSeq)} reason=${chain.reason ?? "unknown"})`,
    );
  }
  lines.push("");
  lines.push(`EXIT CODE: ${code}`);
  return { code, lines };
}

// ===========================================================================
// help
// ===========================================================================

export function evalHelpLines(): string[] {
  return [
    "Usage: hades eval <command>",
    "",
    "Commands:",
    "  hades eval status  [--root R] [--branch B] [--trend N] [--json]",
    "                      Read-only ledger/gate summary: latest entry, chain",
    "                      verification, latest verdict, V-TPH$ trend + changepoint.",
    "",
    "  hades eval run      [--label L] [--note N]",
    "                      [--baseline latest|rolling-median|best-of-window|<sha>]",
    "                      [--window N] [--epsilon E] [--no-record] [--gate]",
    "                      [--bisect] [--json]",
    "                      Resolve the current revision, measure it against the",
    "                      real eval suite, record it to the hash-chained history,",
    "                      and evaluate the never-regress gate. --gate makes a",
    "                      BLOCK verdict exit non-zero (2); without --gate the",
    "                      verdict is still computed and printed but never fails",
    "                      the command. --bisect auto-localizes the culprit",
    "                      revision when the gate blocks. --epsilon sets a",
    "                      transient policy.riskEpsilonCeiling for this run only.",
    "",
    "  hades eval gate     [--sha S] [--baseline latest|rolling-median|best-of-window|<sha>]",
    "                      [--policy <file>] [--set key=value ...] [--show-policy]",
    "                      [--json]",
    "                      Evaluate the never-regress gate for a RECORDED",
    "                      scorecard (--sha, default: latest recorded entry)",
    "                      against a baseline, without measuring anything new.",
    "                      This is the merge-gate entry point: exits 2 on BLOCK.",
    "                      --set persists a policy field to the real policy file",
    "                      (atomic write); --show-policy prints the effective",
    "                      policy (after any --set) instead of evaluating.",
    "",
    "  hades eval bisect   [--good S] [--bad S]",
    "                      [--signal verified|vtph|silent-wrong|silent-wrong-rate|task:<id>]",
    "                      [--max-probes N] [--active] [--json]",
    "                      Localize the earliest recorded revision that flips",
    "                      --signal from good to bad, over already-recorded",
    "                      history (history-only mode). --active is refused:",
    "                      this CLI wiring never checks out arbitrary historical",
    "                      revisions to re-measure them.",
    "",
    "  hades eval history  [--limit N] [--branch B] [--sha S] [--verify] [--json]",
    "                      List recorded scorecards. --verify independently",
    "                      recomputes the hash chain and exits 3 if broken.",
    "",
    "  hades eval help                     Show this help",
    "",
    "Exit codes:",
    "  0  allow / clean -- the command completed and (if it evaluated a gate)",
    "     the verdict was ALLOW or WARN, or gate enforcement was not requested.",
    "  1  usage error, or an operation that could not run (bad flag, unreadable",
    "     policy file, corrupt ledger, a rejected measure/bisect/runContinuous).",
    "  2  gate BLOCK -- a real regression was refused. `hades eval gate` and",
    "     `hades eval run --gate` both use this so either can be a CI merge gate.",
    "  3  history chain verification failed (`hades eval history --verify`).",
  ];
}

// ===========================================================================
// Router
// ===========================================================================

export async function runEvalCommand(argv: string[], deps: EvalCliDeps): Promise<CliResult> {
  try {
    const [sub, ...rest] = argv;
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return { code: 0, lines: evalHelpLines() };
      case "status":
        return cmdStatus(rest, deps);
      case "run":
        return await cmdRun(rest, deps);
      case "gate":
        return await cmdGate(rest, deps);
      case "bisect":
        return await cmdBisect(rest, deps);
      case "history":
        return cmdHistory(rest, deps);
      default:
        return { code: 1, lines: [`eval: unknown subcommand "${sub}"`, "", ...evalHelpLines()] };
    }
  } catch (err) {
    return { code: 1, lines: [`eval: unexpected error: ${describeErr(err)}`] };
  }
}
