/**
 * regression-gate.ts — the never-regress gate: a versioned, hostile-input-
 * safe POLICY, a fail-closed EVALUATOR that turns a candidate `EvalScorecard`
 * plus a `BaselineSelection` (from `./compare`) into a sealed `GateVerdict`,
 * and an append-only, hash-chained JOURNAL of every verdict ever issued.
 *
 * ## The one property this module exists to guarantee
 *
 * It must be impossible to buy an `"allow"` by deleting or degrading
 * evidence. Concretely, every one of the following degenerate inputs
 * resolves to the policy's configured NON-allow decision — never a silent
 * pass:
 *
 *   - no baseline at all (`onMissingBaseline`, strict default `"warn"` —
 *     still not a silent allow)
 *   - a baseline pool smaller than `policy.minBaselinePoolSize`
 *   - two scorecards that cannot be honestly diffed (`onIncomparable`)
 *   - a candidate that fails its own internal-consistency check
 *     (`onInvalidScorecard`)
 *   - an eval-history chain the caller reports as broken (`onChainBroken`)
 *   - a risk (silent-wrong epsilon) lane that was never measured, while
 *     `policy.requireRiskLaneMeasured` is on — always a hard block,
 *     regardless of `onX` configuration
 *
 * `normalizePolicy` is TOTAL: it never throws on hostile input, and every
 * unrecognized/out-of-range field falls back to `DEFAULT_NEVER_REGRESS_POLICY`
 * — a policy that is already maximally strict — never to a permissive
 * fallback invented on the spot.
 *
 * ## Division of labor with `./compare` (T1)
 *
 * This module NEVER re-derives a metric delta or a significance test. Every
 * number a `GateFinding` reports about `verifiedCorrect`/`vtph`/`silentWrong`
 * traces back to a `MetricDelta` produced by the real `compareToBaseline`
 * (`./compare`). This module's only job is policy: turning those deltas (and
 * the honest absence of a baseline, or an honest `comparable:false`) into
 * named, severity-ranked findings, applying governance (waivers), and
 * sealing the result.
 *
 * ## Sealing + the journal
 *
 * `GateVerdict.contentHash` is a canonical, key-sorted, non-finite-safe hash
 * over every field except itself (mirrors `scorecard.ts`'s `contentHash`
 * discipline). `GateVerdictJournal` chains every appended verdict the same
 * way `./history.ts` chains scorecards: `hash = sha256Hex(prevHash +
 * canonical({seq, recordedAtMs, prevHash, verdict}))`, tolerant of a
 * truncated final line, strict about anything else.
 *
 * Import policy (locked): `./scorecard` (`verifyScorecard` + types), `./compare`
 * (T1's real `BaselineSelection`, `ScorecardDelta`, `compareToBaseline`,
 * `MetricDelta` — never re-derived here), `../styx/certificate` (`sha256Hex`),
 * `node:path`, `node:fs`. Never `./measure`, `./bisect`, `./continuous`, or
 * any CLI module.
 */

import { join } from "node:path";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";

import { verifyScorecard, type EvalScorecard } from "./scorecard";
import { compareToBaseline, type BaselineSelection, type ScorecardDelta, type MetricDelta } from "./compare";
import { encodeJsonLine, tryDecodeJsonLine } from "./json-line";
import { sha256Hex } from "../styx/certificate";

// ===========================================================================
// Locked public surface — module version + core types
// ===========================================================================

export const EVAL_GATE_VERSION = 1;

/** `sha256Hex("hades.eval.gate.v1")` — the namespace root for every derived
 *  hash in this module (`policyHash`, `GateVerdict.contentHash`, the journal
 *  chain's genesis), so nothing here can ever collide with a hash minted by
 *  an unrelated hashing scheme over the same raw bytes. */
export const EVAL_GATE_GENESIS: string = sha256Hex("hades.eval.gate.v1");

export type GateDecision = "allow" | "warn" | "block";
export type GateSeverity = "block" | "warn" | "info";

export interface GateWaiver {
  rule: string;
  taskId: string | null;
  reason: string;
  expiresAtMs: number | null;
  author: string | null;
}

export interface NeverRegressPolicy {
  version: number;
  maxVerifiedCorrectDrop: number;
  maxVtphRelativeDrop: number;
  maxSilentWrongIncrease: number;
  maxSilentWrongRateIncrease: number;
  riskEpsilonCeiling: number | null;
  requireRiskLaneMeasured: boolean;
  requireSignificance: boolean;
  alpha: number;
  blockOnTaskRegression: boolean;
  minBaselinePoolSize: number;
  onMissingBaseline: GateDecision;
  onIncomparable: GateDecision;
  onInvalidScorecard: GateDecision;
  onChainBroken: GateDecision;
  waivers: GateWaiver[];
}

/**
 * The strict, zero-tolerance-on-the-trust-critical-metrics default: any drop
 * in `verifiedCorrect` and any increase in `silentWrong` (absolute or rate)
 * blocks outright. `onMissingBaseline` is `"warn"` (not `"block"`) — a
 * deliberately looser default so a brand-new suite's very first run is not
 * permanently unmergeable — but it is never `"allow"`: a missing baseline is
 * ALWAYS surfaced, never silently passed.
 */
export const DEFAULT_NEVER_REGRESS_POLICY: NeverRegressPolicy = {
  version: EVAL_GATE_VERSION,
  maxVerifiedCorrectDrop: 0,
  maxVtphRelativeDrop: 0.02,
  maxSilentWrongIncrease: 0,
  maxSilentWrongRateIncrease: 0,
  riskEpsilonCeiling: null,
  requireRiskLaneMeasured: true,
  requireSignificance: true,
  alpha: 0.05,
  blockOnTaskRegression: true,
  minBaselinePoolSize: 1,
  onMissingBaseline: "warn",
  onIncomparable: "block",
  onInvalidScorecard: "block",
  onChainBroken: "block",
  waivers: [],
};

export interface GateFinding {
  rule: string;
  severity: GateSeverity;
  message: string;
  observed: number;
  threshold: number;
  taskId: string | null;
  waived: boolean;
  waiverReason: string | null;
}

export interface GateVerdict {
  version: number;
  decision: GateDecision;
  evaluatedAtMs: number;
  candidateSha: string;
  candidateScorecardId: string;
  baselineSha: string | null;
  baselineScorecardId: string | null;
  baselineStrategy: string | null;
  policyHash: string;
  findings: GateFinding[];
  delta: ScorecardDelta | null;
  summary: string;
  contentHash: string;
}

export interface GateEvaluateInput {
  candidate: EvalScorecard;
  baseline: BaselineSelection | null;
  policy?: NeverRegressPolicy;
  alpha?: number;
  chainOk?: boolean;
  now?: () => number;
}

export interface GateFsDeps {
  readFileSync: typeof import("node:fs").readFileSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  mkdirSync: typeof import("node:fs").mkdirSync;
  existsSync: typeof import("node:fs").existsSync;
}

// ===========================================================================
// Generic helpers — plain-object guards, hostile-input describers, canonical
// (non-finite-safe, key-sorted) serialization shared by policyHash and
// GateVerdict.contentHash.
// ===========================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describeValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return `${t}(${JSON.stringify(v)})`;
  if (Array.isArray(v)) return `array(len=${v.length})`;
  return t;
}

function formatCanonNumber(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return '"Infinity"';
  if (n === Number.NEGATIVE_INFINITY) return '"-Infinity"';
  if (Number.isNaN(n)) return '"NaN"';
  const normalized = Object.is(n, -0) ? 0 : n;
  if (Number.isInteger(normalized) && Math.abs(normalized) < Number.MAX_SAFE_INTEGER) {
    return String(normalized);
  }
  const fixed = Number(normalized.toPrecision(12));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

/** Stable, key-sorted, insertion-order-independent, non-finite-safe
 *  serialization used for every hash this module computes (`policyHash`,
 *  `GateVerdict.contentHash`, the journal's chain hash). Mirrors
 *  `scorecard.ts`'s `stableStringifyValue` discipline exactly, reimplemented
 *  locally since it is not part of this module's locked import surface. */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return formatCanonNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  throw new TypeError(`regression-gate: unserializable value of type ${typeof value}`);
}

// ===========================================================================
// normalizePolicy — total, validating, never throws on hostile input.
// ===========================================================================

const KNOWN_POLICY_KEYS: ReadonlySet<string> = new Set([
  "version",
  "maxVerifiedCorrectDrop",
  "maxVtphRelativeDrop",
  "maxSilentWrongIncrease",
  "maxSilentWrongRateIncrease",
  "riskEpsilonCeiling",
  "requireRiskLaneMeasured",
  "requireSignificance",
  "alpha",
  "blockOnTaskRegression",
  "minBaselinePoolSize",
  "onMissingBaseline",
  "onIncomparable",
  "onInvalidScorecard",
  "onChainBroken",
  "waivers",
]);

const GATE_DECISIONS: ReadonlySet<string> = new Set(["allow", "warn", "block"]);

function isGateDecision(v: unknown): v is GateDecision {
  return typeof v === "string" && GATE_DECISIONS.has(v);
}

function clonePolicy(p: NeverRegressPolicy): NeverRegressPolicy {
  return { ...p, waivers: p.waivers.map((w) => ({ ...w })) };
}

function numOrDefault(
  raw: unknown,
  def: number,
  bounds: { min?: number; max?: number; exclusiveMin?: number; exclusiveMax?: number },
  warnings: string[],
  field: string,
): number {
  if (raw === undefined) return def;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push(`policy.${field} must be a finite number; got ${describeValue(raw)}. Using default ${def}.`);
    return def;
  }
  if (bounds.min !== undefined && raw < bounds.min) {
    warnings.push(`policy.${field}=${raw} is below minimum ${bounds.min}. Using default ${def}.`);
    return def;
  }
  if (bounds.max !== undefined && raw > bounds.max) {
    warnings.push(`policy.${field}=${raw} exceeds maximum ${bounds.max}. Using default ${def}.`);
    return def;
  }
  if (bounds.exclusiveMin !== undefined && raw <= bounds.exclusiveMin) {
    warnings.push(`policy.${field}=${raw} must be strictly greater than ${bounds.exclusiveMin}. Using default ${def}.`);
    return def;
  }
  if (bounds.exclusiveMax !== undefined && raw >= bounds.exclusiveMax) {
    warnings.push(`policy.${field}=${raw} must be strictly less than ${bounds.exclusiveMax}. Using default ${def}.`);
    return def;
  }
  return raw;
}

function boolOrDefault(raw: unknown, def: boolean, warnings: string[], field: string): boolean {
  if (raw === undefined) return def;
  if (typeof raw !== "boolean") {
    warnings.push(`policy.${field} must be a boolean; got ${describeValue(raw)}. Using default ${def}.`);
    return def;
  }
  return raw;
}

function decisionOrDefault(raw: unknown, def: GateDecision, warnings: string[], field: string): GateDecision {
  if (raw === undefined) return def;
  if (!isGateDecision(raw)) {
    warnings.push(`policy.${field} must be one of "allow"|"warn"|"block"; got ${describeValue(raw)}. Using default "${def}".`);
    return def;
  }
  return raw;
}

const MAX_WAIVERS = 500;

function normalizeWaivers(raw: unknown, warnings: string[]): GateWaiver[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`policy.waivers must be an array; got ${describeValue(raw)}. Using an empty waiver set.`);
    return [];
  }
  let items: unknown[] = raw;
  if (items.length > MAX_WAIVERS) {
    warnings.push(
      `policy.waivers has ${items.length} entries, exceeding the maximum of ${MAX_WAIVERS}; truncating to the first ${MAX_WAIVERS}.`,
    );
    items = items.slice(0, MAX_WAIVERS);
  }

  const out: GateWaiver[] = [];
  items.forEach((item, i) => {
    if (!isPlainObject(item)) {
      warnings.push(`policy.waivers[${i}] is not an object; dropped.`);
      return;
    }
    if (typeof item.rule !== "string" || item.rule.length === 0) {
      warnings.push(`policy.waivers[${i}].rule must be a non-empty string; dropped.`);
      return;
    }
    const rule = item.rule;

    let taskId: string | null;
    if (item.taskId === undefined || item.taskId === null) {
      taskId = null;
    } else if (typeof item.taskId === "string") {
      taskId = item.taskId;
    } else {
      warnings.push(
        `policy.waivers[${i}].taskId must be a string or null; dropped entirely rather than silently widening its scope to "any task".`,
      );
      return;
    }

    let reason: string;
    if (typeof item.reason === "string") {
      reason = item.reason;
    } else {
      warnings.push(`policy.waivers[${i}].reason must be a string; defaulting to empty (an empty reason never applies).`);
      reason = "";
    }

    let expiresAtMs: number | null;
    if (item.expiresAtMs === undefined || item.expiresAtMs === null) {
      expiresAtMs = null;
    } else if (typeof item.expiresAtMs === "number" && !Number.isNaN(item.expiresAtMs)) {
      expiresAtMs = item.expiresAtMs;
    } else {
      warnings.push(
        `policy.waivers[${i}].expiresAtMs must be a finite number or null; treating as already-expired (fail-closed) rather than "never expires".`,
      );
      expiresAtMs = Number.NEGATIVE_INFINITY;
    }

    let author: string | null;
    if (item.author === undefined || item.author === null) {
      author = null;
    } else if (typeof item.author === "string") {
      author = item.author;
    } else {
      warnings.push(`policy.waivers[${i}].author must be a string or null; defaulting to null.`);
      author = null;
    }

    out.push({ rule, taskId, reason, expiresAtMs, author });
  });

  return out;
}

/**
 * Total, validating, hostile-input-safe normalization: `raw` may be
 * anything (non-object, `null`, wrong field types, negative tolerances,
 * `NaN`/`Infinity` thresholds, an out-of-range `alpha`, a future `version`,
 * unknown extra keys, an oversized waiver array) — this function NEVER
 * throws and NEVER produces a silently-permissive policy: every rejected
 * field falls back to {@link DEFAULT_NEVER_REGRESS_POLICY}'s own (already
 * strict) value, with a human-readable warning recorded for each fallback.
 */
export function normalizePolicy(raw: unknown): { policy: NeverRegressPolicy; warnings: string[] } {
  const warnings: string[] = [];
  const base = DEFAULT_NEVER_REGRESS_POLICY;

  if (!isPlainObject(raw)) {
    warnings.push(`policy input is not an object (got ${describeValue(raw)}); using the strict default policy.`);
    return { policy: clonePolicy(base), warnings };
  }

  const r = raw;

  for (const key of Object.keys(r)) {
    if (!KNOWN_POLICY_KEYS.has(key)) {
      warnings.push(`policy has unrecognized key "${key}"; ignored.`);
    }
  }

  let version = base.version;
  if (r.version !== undefined) {
    if (typeof r.version !== "number" || !Number.isInteger(r.version) || r.version < 1) {
      warnings.push(`policy.version must be a positive integer; got ${describeValue(r.version)}. Using ${base.version}.`);
    } else if (r.version > EVAL_GATE_VERSION) {
      warnings.push(
        `policy.version=${r.version} is a future version this build (understands up to ${EVAL_GATE_VERSION}) does not recognize. Using ${base.version}.`,
      );
    } else {
      version = r.version;
    }
  }

  const policy: NeverRegressPolicy = {
    version,
    maxVerifiedCorrectDrop: numOrDefault(r.maxVerifiedCorrectDrop, base.maxVerifiedCorrectDrop, { min: 0 }, warnings, "maxVerifiedCorrectDrop"),
    maxVtphRelativeDrop: numOrDefault(r.maxVtphRelativeDrop, base.maxVtphRelativeDrop, { min: 0 }, warnings, "maxVtphRelativeDrop"),
    maxSilentWrongIncrease: numOrDefault(r.maxSilentWrongIncrease, base.maxSilentWrongIncrease, { min: 0 }, warnings, "maxSilentWrongIncrease"),
    maxSilentWrongRateIncrease: numOrDefault(
      r.maxSilentWrongRateIncrease,
      base.maxSilentWrongRateIncrease,
      { min: 0 },
      warnings,
      "maxSilentWrongRateIncrease",
    ),
    riskEpsilonCeiling: null,
    requireRiskLaneMeasured: boolOrDefault(r.requireRiskLaneMeasured, base.requireRiskLaneMeasured, warnings, "requireRiskLaneMeasured"),
    requireSignificance: boolOrDefault(r.requireSignificance, base.requireSignificance, warnings, "requireSignificance"),
    alpha: numOrDefault(r.alpha, base.alpha, { exclusiveMin: 0, exclusiveMax: 1 }, warnings, "alpha"),
    blockOnTaskRegression: boolOrDefault(r.blockOnTaskRegression, base.blockOnTaskRegression, warnings, "blockOnTaskRegression"),
    minBaselinePoolSize: numOrDefault(r.minBaselinePoolSize, base.minBaselinePoolSize, { min: 0 }, warnings, "minBaselinePoolSize"),
    onMissingBaseline: decisionOrDefault(r.onMissingBaseline, base.onMissingBaseline, warnings, "onMissingBaseline"),
    onIncomparable: decisionOrDefault(r.onIncomparable, base.onIncomparable, warnings, "onIncomparable"),
    onInvalidScorecard: decisionOrDefault(r.onInvalidScorecard, base.onInvalidScorecard, warnings, "onInvalidScorecard"),
    onChainBroken: decisionOrDefault(r.onChainBroken, base.onChainBroken, warnings, "onChainBroken"),
    waivers: normalizeWaivers(r.waivers, warnings),
  };

  if (typeof policy.minBaselinePoolSize === "number" && !Number.isInteger(policy.minBaselinePoolSize)) {
    warnings.push(`policy.minBaselinePoolSize must be an integer; got ${policy.minBaselinePoolSize}. Using ${base.minBaselinePoolSize}.`);
    policy.minBaselinePoolSize = base.minBaselinePoolSize;
  }

  if (r.riskEpsilonCeiling === undefined || r.riskEpsilonCeiling === null) {
    policy.riskEpsilonCeiling = null;
  } else if (typeof r.riskEpsilonCeiling === "number" && Number.isFinite(r.riskEpsilonCeiling) && r.riskEpsilonCeiling > 0 && r.riskEpsilonCeiling <= 1) {
    policy.riskEpsilonCeiling = r.riskEpsilonCeiling;
  } else {
    warnings.push(
      `policy.riskEpsilonCeiling must be null or a finite number in (0,1]; got ${describeValue(r.riskEpsilonCeiling)}. Using null (rule disabled).`,
    );
    policy.riskEpsilonCeiling = null;
  }

  return { policy, warnings };
}

// ===========================================================================
// policyHash
// ===========================================================================

export function policyHash(p: NeverRegressPolicy): string {
  return sha256Hex(`${EVAL_GATE_GENESIS}:policy.v${EVAL_GATE_VERSION}:${stableStringify(p)}`);
}

// ===========================================================================
// loadPolicy / savePolicy — atomic tmp+rename persistence at
// `<root>/gate-policy.json`.
// ===========================================================================

const POLICY_FILE_NAME = "gate-policy.json";

function defaultFsDeps(): GateFsDeps {
  return {
    readFileSync: nodeReadFileSync,
    writeFileSync: nodeWriteFileSync,
    renameSync: nodeRenameSync,
    mkdirSync: nodeMkdirSync,
    existsSync: nodeExistsSync,
  };
}

export function savePolicy(root: string, p: NeverRegressPolicy, deps?: GateFsDeps): void {
  const fs = deps ?? defaultFsDeps();
  fs.mkdirSync(root, { recursive: true });
  const target = join(root, POLICY_FILE_NAME);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

export function loadPolicy(
  root: string,
  deps?: GateFsDeps,
): { policy: NeverRegressPolicy; source: "file" | "default"; warnings: string[] } {
  const fs = deps ?? defaultFsDeps();
  const target = join(root, POLICY_FILE_NAME);

  let exists: boolean;
  try {
    exists = fs.existsSync(target);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { policy: clonePolicy(DEFAULT_NEVER_REGRESS_POLICY), source: "default", warnings: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8") as string;
  } catch (err) {
    return {
      policy: clonePolicy(DEFAULT_NEVER_REGRESS_POLICY),
      source: "default",
      warnings: [
        `failed to read policy file at "${target}": ${err instanceof Error ? err.message : String(err)}; using the strict default policy.`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      policy: clonePolicy(DEFAULT_NEVER_REGRESS_POLICY),
      source: "default",
      warnings: [
        `policy file at "${target}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}; using the strict default policy.`,
      ],
    };
  }

  const { policy, warnings } = normalizePolicy(parsed);
  return { policy, source: "file", warnings };
}

// ===========================================================================
// evaluateNeverRegressGate — the fail-closed decision engine.
// ===========================================================================

function decisionSeverity(d: GateDecision): GateSeverity {
  if (d === "block") return "block";
  if (d === "warn") return "warn";
  return "info";
}

function decisionFromSeverities(findings: readonly GateFinding[]): GateDecision {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "allow";
}

function buildFinding(
  rule: string,
  severity: GateSeverity,
  message: string,
  observed: number,
  threshold: number,
  taskId: string | null,
): GateFinding {
  return { rule, severity, message, observed, threshold, taskId, waived: false, waiverReason: null };
}

/** A waiver applies iff: same rule; `taskId` is `null` (blanket) or matches
 *  the finding's `taskId` exactly; `reason` is non-empty; and it has not
 *  expired (`expiresAtMs === null || expiresAtMs >= nowMs`). A waiver can
 *  never apply to a rule it does not name — matching is always by exact
 *  `rule` string, never by decision or severity. */
function findApplicableWaiver(finding: GateFinding, waivers: readonly GateWaiver[], nowMs: number): GateWaiver | null {
  for (const w of waivers) {
    if (w.rule !== finding.rule) continue;
    if (w.taskId !== null && w.taskId !== finding.taskId) continue;
    if (w.reason.trim().length === 0) continue;
    if (w.expiresAtMs !== null && w.expiresAtMs < nowMs) continue;
    return w;
  }
  return null;
}

function applyWaivers(findings: readonly GateFinding[], waivers: readonly GateWaiver[], nowMs: number): GateFinding[] {
  return findings.map((f) => {
    const w = findApplicableWaiver(f, waivers, nowMs);
    if (w === null) return f;
    return { ...f, severity: "info", waived: true, waiverReason: w.reason };
  });
}

function resolveAlpha(inputAlpha: number | undefined, policyAlpha: number): number {
  if (typeof inputAlpha === "number" && Number.isFinite(inputAlpha) && inputAlpha > 0 && inputAlpha < 1) return inputAlpha;
  return policyAlpha;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(3)}%`;
}

/**
 * Every metric+task rule this module enforces, each producing its own named
 * `GateFinding`. Called ONLY when `delta.comparable === true` — an
 * incomparable delta carries no honest metric to evaluate.
 */
function evaluateMetricRules(delta: ScorecardDelta, policy: NeverRegressPolicy): GateFinding[] {
  const findings: GateFinding[] = [];

  {
    const vc: MetricDelta = delta.verifiedCorrect;
    const drop = Math.max(0, -vc.absolute);
    const threshold = policy.maxVerifiedCorrectDrop;
    if (drop > threshold) {
      findings.push(
        buildFinding(
          "verified-correct-drop",
          "block",
          `verifiedCorrect dropped by ${drop} (baseline ${vc.baseline} -> candidate ${vc.candidate}), exceeding policy.maxVerifiedCorrectDrop=${threshold}`,
          drop,
          threshold,
          null,
        ),
      );
    }
  }

  {
    const v: MetricDelta = delta.vtph;
    const dropFrac = Math.max(0, -v.relative);
    const threshold = policy.maxVtphRelativeDrop;
    if (dropFrac > threshold) {
      let severity: GateSeverity = "block";
      let sigNote = "";
      if (policy.requireSignificance) {
        if (delta.paired !== null && delta.paired.significant === false) {
          severity = "warn";
          sigNote = ` [McNemar p=${delta.paired.pValue.toFixed(6)} > alpha=${delta.paired.alpha} -- not statistically significant, downgraded to WARN]`;
        } else if (delta.paired !== null && delta.paired.significant === true) {
          sigNote = ` [McNemar p=${delta.paired.pValue.toFixed(6)} <= alpha=${delta.paired.alpha} -- statistically significant]`;
        } else {
          sigNote = " [no paired task data to assess significance -- staying strict]";
        }
      }
      findings.push(
        buildFinding(
          "vtph-relative-drop",
          severity,
          `vtph dropped ${pct(dropFrac)} (baseline ${v.baseline.toFixed(4)} -> candidate ${v.candidate.toFixed(4)}), exceeding policy.maxVtphRelativeDrop=${pct(threshold)}${sigNote}`,
          dropFrac,
          threshold,
          null,
        ),
      );
    }
  }

  {
    const sw: MetricDelta = delta.silentWrong;
    const inc = Math.max(0, sw.absolute);
    const threshold = policy.maxSilentWrongIncrease;
    if (inc > threshold) {
      findings.push(
        buildFinding(
          "silent-wrong-increase",
          "block",
          `silentWrong increased by ${inc} (baseline ${sw.baseline} -> candidate ${sw.candidate}), exceeding policy.maxSilentWrongIncrease=${threshold}`,
          inc,
          threshold,
          null,
        ),
      );
    }
  }

  {
    const swr: MetricDelta = delta.silentWrongRate;
    if (!Number.isNaN(swr.absolute)) {
      const inc = Math.max(0, swr.absolute);
      const threshold = policy.maxSilentWrongRateIncrease;
      if (inc > threshold) {
        findings.push(
          buildFinding(
            "silent-wrong-rate-increase",
            "block",
            `silentWrongRate increased by ${pct(inc)} (baseline ${pct(swr.baseline)} -> candidate ${pct(swr.candidate)}), exceeding policy.maxSilentWrongRateIncrease=${pct(threshold)}`,
            inc,
            threshold,
            null,
          ),
        );
      }
    }
  }

  if (policy.blockOnTaskRegression) {
    for (const taskId of delta.regressedTaskIds) {
      const flip = delta.flips.find((f) => f.taskId === taskId && f.severity === "regression");
      findings.push(
        buildFinding(
          "task-regression",
          "block",
          `task "${taskId}" regressed${flip ? ` (${flip.from} -> ${flip.to})` : ""}`,
          1,
          0,
          taskId,
        ),
      );
    }
  }

  return findings;
}

function buildSummary(decision: GateDecision, findings: readonly GateFinding[]): string {
  const active = findings.filter((f) => f.severity !== "info");
  if (decision === "allow") {
    return active.length === 0
      ? "ALLOW: no policy violations detected"
      : `ALLOW: ${findings.length} finding(s) recorded, none block or warn (waived/informational only)`;
  }
  const worst = active.filter((f) => f.severity === decision);
  const names = worst.map((f) => f.rule + (f.taskId !== null ? `:${f.taskId}` : "")).join(", ");
  return `${decision.toUpperCase()}: ${worst.length} ${decision} finding(s) -- ${names}`;
}

function computeVerdictHash(v: GateVerdict | Omit<GateVerdict, "contentHash">): string {
  const rest: Partial<GateVerdict> = { ...(v as GateVerdict) };
  delete rest.contentHash;
  return sha256Hex(`${EVAL_GATE_GENESIS}:verdict.v${EVAL_GATE_VERSION}:${stableStringify(rest)}`);
}

function sealVerdict(parts: {
  policy: NeverRegressPolicy;
  findings: GateFinding[];
  evaluatedAtMs: number;
  candidateSha: string;
  candidateScorecardId: string;
  baselineSha: string | null;
  baselineScorecardId: string | null;
  baselineStrategy: string | null;
  delta: ScorecardDelta | null;
}): GateVerdict {
  const decision = decisionFromSeverities(parts.findings);
  const summary = buildSummary(decision, parts.findings);
  const draft: Omit<GateVerdict, "contentHash"> = {
    version: EVAL_GATE_VERSION,
    decision,
    evaluatedAtMs: parts.evaluatedAtMs,
    candidateSha: parts.candidateSha,
    candidateScorecardId: parts.candidateScorecardId,
    baselineSha: parts.baselineSha,
    baselineScorecardId: parts.baselineScorecardId,
    baselineStrategy: parts.baselineStrategy,
    policyHash: policyHash(parts.policy),
    findings: parts.findings,
    delta: parts.delta,
    summary,
  };
  return { ...draft, contentHash: computeVerdictHash(draft) };
}

/**
 * Turns a candidate `EvalScorecard` plus an (optional, possibly-failed)
 * `BaselineSelection` into a sealed `GateVerdict`. See module docs for the
 * full fail-closed philosophy; the pipeline, in order:
 *
 *  1. Candidate self-consistency (`verifyScorecard`) — a failure here is
 *     terminal: no further rule can be honestly evaluated over an
 *     internally-inconsistent scorecard, so this short-circuits to a
 *     verdict carrying ONLY the `scorecard-invalid` finding.
 *  2. History chain integrity (`chainOk`, caller-supplied — this module has
 *     no filesystem access to the ledger itself).
 *  3. Candidate-only risk-lane rules (`risk-lane-unmeasured`,
 *     `risk-epsilon-ceiling`) — independent of whether a baseline exists.
 *  4. Baseline usability (`baseline-missing`, folding in
 *     `minBaselinePoolSize`).
 *  5. `compareToBaseline` (T1's real comparator) -> `incomparable`, or every
 *     metric+task rule in {@link evaluateMetricRules}.
 *  6. Waivers applied to every finding; the decision is recomputed from the
 *     POST-waiver severities.
 */
export function evaluateNeverRegressGate(input: GateEvaluateInput): GateVerdict {
  const policy = input.policy ?? DEFAULT_NEVER_REGRESS_POLICY;
  const alpha = resolveAlpha(input.alpha, policy.alpha);
  const nowFn = input.now ?? Date.now;
  const evaluatedAtMs = nowFn();
  const candidate = input.candidate;

  const candidateVerify = verifyScorecard(candidate);
  if (!candidateVerify.ok) {
    const findings = [
      buildFinding(
        "scorecard-invalid",
        decisionSeverity(policy.onInvalidScorecard),
        `candidate scorecard failed verifyScorecard: ${candidateVerify.reason ?? "unknown"}`,
        1,
        0,
        null,
      ),
    ];
    return sealVerdict({
      policy,
      findings: applyWaivers(findings, policy.waivers, evaluatedAtMs),
      evaluatedAtMs,
      candidateSha: candidate.revision.sha,
      candidateScorecardId: candidate.scorecardId,
      baselineSha: null,
      baselineScorecardId: null,
      baselineStrategy: null,
      delta: null,
    });
  }

  const findings: GateFinding[] = [];

  const chainOk = input.chainOk ?? true;
  if (!chainOk) {
    findings.push(
      buildFinding(
        "history-chain-broken",
        decisionSeverity(policy.onChainBroken),
        "the eval history chain failed integrity verification (chainOk=false) -- the baseline this candidate would be compared against cannot be trusted",
        1,
        0,
        null,
      ),
    );
  }

  if (policy.requireRiskLaneMeasured && !candidate.risk.measured) {
    findings.push(
      buildFinding(
        "risk-lane-unmeasured",
        "block",
        `policy requires the risk lane to be measured but candidate.risk.measured=false (${candidate.risk.unmeasuredReason ?? "no reason given"})`,
        0,
        1,
        null,
      ),
    );
  }

  if (policy.riskEpsilonCeiling !== null && candidate.risk.measured) {
    const observed = candidate.risk.epsilon;
    const threshold = policy.riskEpsilonCeiling;
    if (observed > threshold) {
      findings.push(
        buildFinding(
          "risk-epsilon-ceiling",
          "block",
          `candidate risk-lane epsilon ${observed} exceeds policy.riskEpsilonCeiling=${threshold}`,
          observed,
          threshold,
          null,
        ),
      );
    }
  }

  const selection = input.baseline;
  const poolSize = selection !== null ? selection.pool.length : 0;
  const baselineUsable = selection !== null && selection.ok && selection.entry !== null && poolSize >= policy.minBaselinePoolSize;

  let delta: ScorecardDelta | null = null;
  let baselineSha: string | null = null;
  let baselineScorecardId: string | null = null;
  const baselineStrategy: string | null = selection !== null ? selection.strategy : null;

  if (!baselineUsable) {
    const reasons: string[] = [];
    if (selection === null) {
      reasons.push("no BaselineSelection supplied");
    } else if (!selection.ok || selection.entry === null) {
      reasons.push(`baseline selection failed: ${selection.reason ?? "unknown"}`);
    } else if (poolSize < policy.minBaselinePoolSize) {
      reasons.push(`baseline pool size ${poolSize} < policy.minBaselinePoolSize ${policy.minBaselinePoolSize}`);
    }
    findings.push(
      buildFinding(
        "baseline-missing",
        decisionSeverity(policy.onMissingBaseline),
        reasons.join("; ") || "baseline unusable for an unspecified reason",
        poolSize,
        policy.minBaselinePoolSize,
        null,
      ),
    );
  } else {
    const computed = compareToBaseline(selection as BaselineSelection, candidate, { alpha });
    if (computed === null) {
      // Defensive: `selection.ok` was true, so `compareToBaseline` should
      // never return null here -- but if it somehow does, fail toward
      // baseline-missing rather than silently skipping every metric rule.
      findings.push(
        buildFinding(
          "baseline-missing",
          decisionSeverity(policy.onMissingBaseline),
          "compareToBaseline returned null despite an ok baseline selection",
          poolSize,
          policy.minBaselinePoolSize,
          null,
        ),
      );
    } else {
      delta = computed;
      baselineSha = computed.baselineSha;
      baselineScorecardId = computed.baselineScorecardId;
      if (!computed.comparable) {
        findings.push(
          buildFinding(
            "incomparable",
            decisionSeverity(policy.onIncomparable),
            computed.incomparableReason ?? "unknown reason",
            1,
            0,
            null,
          ),
        );
      } else {
        findings.push(...evaluateMetricRules(computed, policy));
      }
    }
  }

  return sealVerdict({
    policy,
    findings: applyWaivers(findings, policy.waivers, evaluatedAtMs),
    evaluatedAtMs,
    candidateSha: candidate.revision.sha,
    candidateScorecardId: candidate.scorecardId,
    baselineSha,
    baselineScorecardId,
    baselineStrategy,
    delta,
  });
}

// ===========================================================================
// verifyGateVerdict
// ===========================================================================

/**
 * Independently verifies a `GateVerdict`'s internal consistency:
 *
 *  1. `version` this module doesn't understand -> `unsupported-version:<v>`.
 *  2. `decision` that disagrees with `decisionFromSeverities(v.findings)`
 *     (recomputed straight from the STORED findings' severities, which
 *     already reflect any waiver downgrade) -> `decision-mismatch`. Catches
 *     a flipped `decision` field directly.
 *  3. `contentHash` that doesn't match the recomputed hash -> the catch-all
 *     for any tampering not already caught above: an added/removed
 *     `finding`, a swapped `policyHash`, a mutated `summary`/`delta`/etc.
 */
export function verifyGateVerdict(v: GateVerdict): { ok: boolean; reason: string | null } {
  if (v.version !== EVAL_GATE_VERSION) {
    return { ok: false, reason: `unsupported-version:${String(v.version)}` };
  }

  const expectedDecision = decisionFromSeverities(v.findings);
  if (expectedDecision !== v.decision) {
    return { ok: false, reason: "decision-mismatch" };
  }

  const expectedHash = computeVerdictHash(v);
  if (expectedHash !== v.contentHash) {
    return { ok: false, reason: "content-hash-mismatch" };
  }

  return { ok: true, reason: null };
}

// ===========================================================================
// formatGateVerdict — aligned plain ASCII, CI-log-ready.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmtNum(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Number.POSITIVE_INFINITY) return "Infinity";
  if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

export function formatGateVerdict(v: GateVerdict): string[] {
  const lines: string[] = [];
  lines.push("HADES NEVER-REGRESS GATE VERDICT");
  lines.push("=".repeat(72));
  lines.push(`decision             : ${v.decision.toUpperCase()}`);
  lines.push(`evaluatedAtMs        : ${v.evaluatedAtMs}`);
  lines.push(`candidateSha         : ${v.candidateSha}`);
  lines.push(`candidateScorecardId : ${v.candidateScorecardId}`);
  lines.push(`baselineSha          : ${v.baselineSha ?? "(none)"}`);
  lines.push(`baselineScorecardId  : ${v.baselineScorecardId ?? "(none)"}`);
  lines.push(`baselineStrategy     : ${v.baselineStrategy ?? "(none)"}`);
  lines.push(`policyHash           : ${v.policyHash}`);
  lines.push("");
  lines.push(`SUMMARY: ${v.summary}`);
  lines.push("");

  if (v.findings.length === 0) {
    lines.push("FINDINGS: (none)");
  } else {
    lines.push(`FINDINGS (${v.findings.length})`);
    const headers = ["RULE", "SEVERITY", "TASK", "OBSERVED", "THRESHOLD", "WAIVED"];
    const rows = v.findings.map((f) => [
      f.rule,
      f.severity.toUpperCase(),
      f.taskId ?? "-",
      fmtNum(f.observed),
      fmtNum(f.threshold),
      f.waived ? "yes" : "no",
    ]);
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (let i = 0; i < rows.length; i++) {
      lines.push(rows[i].map((c, j) => padRight(c, widths[j])).join("  "));
      lines.push(`    ${v.findings[i].message}`);
      if (v.findings[i].waived) lines.push(`    waiverReason: ${v.findings[i].waiverReason}`);
    }
  }
  lines.push("");
  lines.push(`contentHash          : ${v.contentHash}`);

  return lines;
}

// ===========================================================================
// GateVerdictJournal — append-only, hash-chained, JSONL at
// `<root>/gate-verdicts.jsonl`.
// ===========================================================================

export class GateJournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateJournalCorruptionError";
  }
}

export class GateJournalVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateJournalVersionError";
  }
}

export class GateJournalVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateJournalVerdictError";
  }
}

interface GateJournalEntry {
  seq: number;
  recordedAtMs: number;
  prevHash: string;
  hash: string;
  verdict: GateVerdict;
}

type GateJournalEntryFields = Omit<GateJournalEntry, "hash">;

interface GateJournalHeader {
  version: number;
  checkpointHash: string | null;
}

const GATE_JOURNAL_VERSION = 1;

function isJournalHeaderShape(v: unknown): v is { version: number; checkpointHash?: unknown } {
  if (!isPlainObject(v)) return false;
  if ("seq" in v) return false;
  return typeof v.version === "number" && Number.isInteger(v.version) && v.version >= 0;
}

function isValidJournalEntryShape(v: unknown): v is GateJournalEntry {
  if (!isPlainObject(v)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.recordedAtMs !== "number" || !Number.isFinite(v.recordedAtMs)) return false;
  if (typeof v.prevHash !== "string") return false;
  if (typeof v.hash !== "string" || v.hash.length === 0) return false;
  if (!isPlainObject(v.verdict)) return false;
  const verdict = v.verdict;
  if (typeof verdict.contentHash !== "string" || verdict.contentHash.length === 0) return false;
  if (typeof verdict.version !== "number") return false;
  if (typeof verdict.decision !== "string") return false;
  if (!Array.isArray(verdict.findings)) return false;
  return true;
}

/** Tolerant JSONL parse. NaN-safe (see ./json-line): `stableStringify` — the
 *  serializer `GateVerdict.contentHash` and this journal's chain are both
 *  built from — is deliberately non-finite-safe, so a verdict carrying a
 *  `NaN` metric delta (routine: `./compare` reports an undefined rate as
 *  `NaN`, never a fabricated 0) must round-trip through disk verbatim or the
 *  journal would fail its own verification on the next read. */
function tryParseJson(line: string): unknown {
  return tryDecodeJsonLine(line);
}

function canonicalizeJournalEntryFields(e: GateJournalEntryFields): string {
  const parts = [
    '"seq":' + JSON.stringify(e.seq),
    '"recordedAtMs":' + JSON.stringify(e.recordedAtMs),
    '"prevHash":' + JSON.stringify(e.prevHash),
    '"verdict":' + JSON.stringify(stableStringify(e.verdict)),
  ];
  return "{" + parts.join(",") + "}";
}

function computeJournalEntryHash(e: GateJournalEntryFields): string {
  return sha256Hex(e.prevHash + canonicalizeJournalEntryFields(e));
}

export class GateVerdictJournal {
  private readonly root: string;
  private readonly retain: number | undefined;
  private readonly nowFn: () => number;
  private readonly fs: GateFsDeps;
  private readonly logPath: string;

  constructor(opts: { root: string; fs?: Partial<GateFsDeps>; now?: () => number; retain?: number }) {
    if (!opts || typeof opts.root !== "string" || opts.root.length === 0) {
      throw new RangeError("GateVerdictJournal: opts.root must be a non-empty path");
    }
    if (opts.retain !== undefined && (!Number.isInteger(opts.retain) || opts.retain < 0)) {
      throw new RangeError("GateVerdictJournal: opts.retain must be a non-negative integer");
    }

    this.root = opts.root;
    this.retain = opts.retain;
    this.nowFn = opts.now ?? Date.now;
    this.fs = {
      readFileSync: opts.fs?.readFileSync ?? nodeReadFileSync,
      writeFileSync: opts.fs?.writeFileSync ?? nodeWriteFileSync,
      renameSync: opts.fs?.renameSync ?? nodeRenameSync,
      mkdirSync: opts.fs?.mkdirSync ?? nodeMkdirSync,
      existsSync: opts.fs?.existsSync ?? nodeExistsSync,
    };

    this.logPath = join(this.root, "gate-verdicts.jsonl");

    this.fs.mkdirSync(this.root, { recursive: true });
    if (!this.fs.existsSync(this.logPath)) {
      this.atomicRewrite({ version: GATE_JOURNAL_VERSION, checkpointHash: null }, []);
    }
  }

  private atomicRewrite(header: GateJournalHeader, entries: readonly GateJournalEntry[]): void {
    const headerObj: { version: number; checkpointHash?: string } = { version: GATE_JOURNAL_VERSION };
    if (header.checkpointHash !== null) headerObj.checkpointHash = header.checkpointHash;
    const lines = [encodeJsonLine(headerObj), ...entries.map((e) => encodeJsonLine(e))];
    const body = lines.join("\n") + "\n";
    const tmp = `${this.logPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.fs.writeFileSync(tmp, body, "utf8");
    this.fs.renameSync(tmp, this.logPath);
  }

  private readState(): { header: GateJournalHeader; entries: GateJournalEntry[] } {
    if (!this.fs.existsSync(this.logPath)) {
      return { header: { version: GATE_JOURNAL_VERSION, checkpointHash: null }, entries: [] };
    }
    const raw = this.fs.readFileSync(this.logPath, "utf8") as string;
    const lines = raw.length === 0 ? [] : raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) {
      return { header: { version: GATE_JOURNAL_VERSION, checkpointHash: null }, entries: [] };
    }

    let header: GateJournalHeader;
    let entryLines: string[];
    const first = tryParseJson(lines[0]);
    if (first !== undefined && isJournalHeaderShape(first)) {
      if (first.version > GATE_JOURNAL_VERSION) {
        throw new GateJournalVersionError(
          `gate journal at "${this.logPath}" is version ${first.version}, which this build (understands up to version ${GATE_JOURNAL_VERSION}) refuses to read rather than silently misparse`,
        );
      }
      header = { version: GATE_JOURNAL_VERSION, checkpointHash: typeof first.checkpointHash === "string" ? first.checkpointHash : null };
      entryLines = lines.slice(1);
    } else {
      header = { version: GATE_JOURNAL_VERSION, checkpointHash: null };
      entryLines = lines;
    }

    const entries: GateJournalEntry[] = [];
    for (let i = 0; i < entryLines.length; i++) {
      const isLast = i === entryLines.length - 1;
      const parsed = tryParseJson(entryLines[i]);
      if (parsed === undefined || !isValidJournalEntryShape(parsed)) {
        if (isLast) break; // partially-written / truncated final record: recover the rest
        throw new GateJournalCorruptionError(
          `gate journal at "${this.logPath}" has an unparsable or malformed record before the final line -- this is mid-file corruption, not a recoverable crash-tail`,
        );
      }
      entries.push(parsed);
    }

    return { header, entries };
  }

  /** Refuses (throws, writes nothing) any verdict that fails
   *  `verifyGateVerdict` -- this journal never records a self-inconsistent
   *  verdict as if it were trustworthy. Re-reads the on-disk chain tail on
   *  EVERY call (never caches it in memory), which is what makes two
   *  `GateVerdictJournal` instances over the same root -- even alternating
   *  synchronous `append()` calls -- land a single contiguous, verifiable
   *  chain: JS never interleaves the body of one synchronous call with
   *  another. */
  append(v: GateVerdict): void {
    const check = verifyGateVerdict(v);
    if (!check.ok) {
      throw new GateJournalVerdictError(`refusing to append a verdict that fails verifyGateVerdict: ${check.reason ?? "unknown"}`);
    }

    const state = this.readState();
    const prevHash = state.entries.length > 0 ? state.entries[state.entries.length - 1].hash : (state.header.checkpointHash ?? EVAL_GATE_GENESIS);
    const seq = state.entries.length > 0 ? state.entries[state.entries.length - 1].seq + 1 : 0;
    const recordedAtMs = this.nowFn();

    const fields: GateJournalEntryFields = { seq, recordedAtMs, prevHash, verdict: v };
    const hash = computeJournalEntryHash(fields);
    const entry: GateJournalEntry = { ...fields, hash };

    // A full atomic rewrite (never a raw flag:"a" append) on every write:
    // `readState()` already recovered from any truncated dangling tail
    // in-memory, but the bytes of that tail are still sitting on disk
    // un-terminated by a newline. An `"a"`-flag append would concatenate the
    // new entry onto that dangling tail on the SAME line, corrupting both.
    // Rewriting the full (already-recovered) entry list + the new entry
    // keeps every write self-healing at the byte level, not just in memory.
    this.atomicRewrite(state.header, [...state.entries, entry]);

    if (this.retain !== undefined) {
      const totalNow = state.entries.length + 1;
      if (totalNow > this.retain) this.compact(this.retain);
    }
  }

  private compact(keep: number): void {
    const state = this.readState();
    if (keep >= state.entries.length) return;
    const cutIndex = state.entries.length - keep;
    const pruned = state.entries.slice(0, cutIndex);
    const retained = state.entries.slice(cutIndex);
    const checkpointHash = pruned[pruned.length - 1].hash;
    this.atomicRewrite({ version: GATE_JOURNAL_VERSION, checkpointHash }, retained);
  }

  list(q: { sha?: string; decision?: GateDecision; limit?: number } = {}): GateVerdict[] {
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 0)) {
      throw new RangeError("GateVerdictJournal.list: limit must be a non-negative integer");
    }
    const state = this.readState();
    let filtered = state.entries.filter((e) => {
      if (q.sha !== undefined && e.verdict.candidateSha !== q.sha) return false;
      if (q.decision !== undefined && e.verdict.decision !== q.decision) return false;
      return true;
    });
    if (q.limit !== undefined && q.limit < filtered.length) {
      filtered = filtered.slice(filtered.length - q.limit);
    }
    return filtered.map((e) => e.verdict);
  }

  latest(sha?: string): GateVerdict | null {
    const filtered = this.list({ sha });
    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }

  verify(): { ok: boolean; entries: number; brokenAtIndex: number | null; reason: string | null } {
    const state = this.readState();
    let expectedPrev = state.header.checkpointHash ?? EVAL_GATE_GENESIS;
    let expectedSeq: number | null = null;

    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];

      if (expectedSeq !== null && e.seq !== expectedSeq + 1) {
        return { ok: false, entries: i, brokenAtIndex: i, reason: "seq-gap" };
      }
      expectedSeq = e.seq;

      if (e.prevHash !== expectedPrev) {
        return { ok: false, entries: i, brokenAtIndex: i, reason: "prev-hash-mismatch" };
      }

      const { hash, ...rest } = e;
      if (computeJournalEntryHash(rest) !== hash) {
        return { ok: false, entries: i, brokenAtIndex: i, reason: "hash-mismatch" };
      }

      const verdictCheck = verifyGateVerdict(e.verdict);
      if (!verdictCheck.ok) {
        return { ok: false, entries: i, brokenAtIndex: i, reason: `embedded-verdict-invalid:${verdictCheck.reason ?? "unknown"}` };
      }

      expectedPrev = hash;
    }

    return { ok: true, entries: state.entries.length, brokenAtIndex: null, reason: null };
  }
}
