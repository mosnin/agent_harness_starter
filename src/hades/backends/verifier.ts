/**
 * STYX verifier `verify.backends` — independently re-audits a
 * `BackendFleetReport` (the JSON a fleet-status tool would emit) against
 * `../backends/provenance.ts`'s hash-chained lifecycle ledger contract.
 *
 * Independent by construction, per the `../tools/verifiers.ts` /
 * `../browser/verifier.ts` convention: this file imports ONLY `type
 * {ToolResult}` from `../agent/tools`, `type {ToolVerdict,
 * ToolOutputVerifier}` from `../tools/verifiers`, `type {TierId}` from
 * `../styx/tiers`, and `node:crypto`. It DOES import the real
 * `BackendProvenanceLedger` (a runtime value) from `./provenance` — but
 * only to CORROBORATE, never to REPLACE, this file's own independent
 * recompute: `BACKEND_TRACE_ROOT_PREIMAGE`'s literal value and the entire
 * hash-chain canonicalization algorithm are duplicated here, byte-for-byte,
 * using this file's OWN local `sha256Hex` (`node:crypto`, never imported
 * from `../styx` or from `./provenance`) — exactly the "structurally
 * duplicate the contract, never import the implementation" convention
 * `../tools/verifiers.ts`'s header documents for the other eight tools. A
 * bug or backdoor in `provenance.ts`'s own `canonicalRecordBytes` /
 * `verifyChain` would therefore NOT be silently trusted: the
 * `chain-recompute` check below re-derives the chain from scratch with
 * independently-written code, while the separate `ledger-verifychain`
 * check additionally calls the real `BackendProvenanceLedger.fromRecords`
 * as a second, corroborating signal — so a genuine chain must satisfy BOTH
 * an independent reimplementation AND the shipped ledger code.
 *
 * ---------------------------------------------------------------------------
 * Report contract checked here (LOCKED)
 * ---------------------------------------------------------------------------
 *   BackendFleetReport {
 *     backends:    Array<{ name: string; kind: string; available: boolean }>
 *     handles:     Array<{ workerId: string; backend: string; state: string }>
 *     certificate: { traceRoot: string; head: string; length: number }
 *     records:     BackendLifecycleRecord[]
 *   }
 * Delivered, like every other catalog tool this build verifies, as
 * `result.output` — a single JSON-serialized `BackendFleetReport` object.
 *
 * ---------------------------------------------------------------------------
 * Calibration math (identical shape to `../tools/verifiers.ts` / `../browser/verifier.ts`)
 * ---------------------------------------------------------------------------
 * `result.ok === false`, or `result.output` that fails to parse as a single
 * JSON object, is a CERTAIN failure — pinned at `FAILURE_DETECTION_CONFIDENCE`
 * with `passed:false`. Otherwise this verifier runs a FIXED eleven-check
 * checklist (`CHECK_CODES` below) against the parsed report. Every check is
 * always evaluated (individually exception-guarded — a hostile/malformed
 * report, however mangled, can only make checks fail, never throw), so:
 *
 *     confidence = clamp01( (passedChecks / 11) * prior )
 *
 * `prior` is the calibrated ceiling (see `backendsFleetCalibration()`):
 * every check here proves the report's INTERNAL cryptographic and
 * structural self-consistency (hashes recompute across the whole chain,
 * seq/prevHash linkage holds, handle states match their most recent
 * lifecycle record) — it does NOT prove the underlying backends genuinely
 * exist or that the events genuinely happened on real infrastructure (a
 * fully fabricated report, self-consistently hashed, passes every check
 * here). That is why the tier is T4-consistency, never higher, exactly like
 * every other Phase 2/3 verifier in this build — but the prior sits at the
 * top of the locked [0.6, 0.75] T4 band (`0.72`) because this checklist's
 * central evidence (a full cryptographic hash-chain recompute over
 * potentially dozens of records, cross-checked by two independent code
 * paths) is materially more decisive, harder to game by construction, than
 * a shape/format check on a single output (`browser`'s 0.68, `file_ops`'s
 * 0.65): forging a chain that passes both `chain-recompute` AND
 * `ledger-verifychain` requires reproducing the exact sha256 hash chain
 * end-to-end, not merely emitting well-shaped JSON.
 */

import type { ToolResult } from "../agent/tools";
import type { ToolVerdict, ToolOutputVerifier } from "../tools/verifiers";
import type { TierId } from "../styx/tiers";
import { createHash } from "node:crypto";
import { BackendProvenanceLedger } from "./provenance";
import type { BackendLifecycleRecord } from "./provenance";

/**
 * The JSON shape a fleet-status report is expected to carry (delivered as
 * `result.output`, like every other catalog tool this build verifies).
 * `records` reuses the LOCKED `BackendLifecycleRecord` shape from
 * `./provenance.ts` — the same type the ledger itself emits — so a report
 * built directly from `BackendProvenanceLedger.records()` is, by
 * construction, already shaped correctly.
 */
export interface BackendFleetReport {
  backends: Array<{ name: string; kind: string; available: boolean }>;
  handles: Array<{ workerId: string; backend: string; state: string }>;
  certificate: { traceRoot: string; head: string; length: number };
  records: BackendLifecycleRecord[];
}

const VERIFIER_ID = "verify.backends";

/** Detecting `ok:false` or unparsable output needs no calibration — pin high,
 *  matching the shipped `../tools/verifiers.ts` / `../browser/verifier.ts` convention. */
const FAILURE_DETECTION_CONFIDENCE = 0.99;

// Duplicated LOCKED literal — see `./provenance.ts`'s `BACKEND_TRACE_ROOT_PREIMAGE`.
// Kept independent on purpose (see file header): this verifier must never
// merely trust that module's exported constant.
const BACKENDS_TRACE_ROOT_PREIMAGE = "hades.backends.trace.v1";

const BACKEND_EVENT_TYPES: ReadonlySet<string> = new Set([
  "provision",
  "provision-failed",
  "hibernate",
  "wake",
  "wake-failed",
  "terminate",
  "sweep",
  "probe",
]);

/** LOCKED mapping: a handle's reported `state` must be consistent with the
 *  event `type` of its own most-recent lifecycle record. `sweep`/`probe`
 *  are fleet-scoped events, not worker-state-defining, so they are never
 *  treated as a handle's "most recent" record (see `mostRecentWorkerRecordType`). */
const EVENT_TYPE_TO_EXPECTED_STATES: Readonly<Record<string, readonly string[]>> = {
  provision: ["running"],
  "provision-failed": ["failed"],
  hibernate: ["hibernated"],
  wake: ["running"],
  "wake-failed": ["failed"],
  terminate: ["stopped"],
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** This verifier's own local sha256 (node:crypto) — never imported from
 *  `../styx` or `./provenance`; see file header for why. */
function localSha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

type ParsedOutput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

function parseJsonObject(output: string): ParsedOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, reason: "JSON_PARSE_ERROR" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "JSON_NOT_OBJECT" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Independent (own-code-path) canonicalization + hash-chain recompute
// ---------------------------------------------------------------------------

/** Structurally identical to `provenance.ts#canonicalizeDetail`, reimplemented
 *  independently. Returns `null` for anything not scalar-only (or not a
 *  plain object at all) instead of throwing — this file's checks must never
 *  throw uncaught on hostile input. */
function canonicalizeDetailIndependent(detail: unknown): string | null {
  if (!isPlainObject(detail)) return null;
  const keys = Object.keys(detail).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = detail[k];
    const t = typeof v;
    if (t === "string") {
      parts.push(JSON.stringify(k) + ":" + JSON.stringify(v));
    } else if (t === "number") {
      if (!Number.isFinite(v as number)) return null;
      parts.push(JSON.stringify(k) + ":" + JSON.stringify(v));
    } else if (t === "boolean") {
      parts.push(JSON.stringify(k) + ":" + (v ? "true" : "false"));
    } else {
      return null;
    }
  }
  return "{" + parts.join(",") + "}";
}

/** Structurally identical to `provenance.ts#canonicalRecordBytes` + its hash
 *  step, reimplemented independently (own local sha256Hex). Returns `null`
 *  (never throws) for a structurally unsound record. Deliberately walks the
 *  record using its OWN declared `seq`/`prevHash` values as-given (not
 *  assuming `seq === index`) — seq-position validity is `seq-strictly-
 *  increasing`'s job, kept orthogonal from pure hash/prevHash-chain
 *  integrity here. */
function recomputeRecordHash(r: Record<string, unknown>, prevHash: string): string | null {
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  if (typeof r.type !== "string" || !BACKEND_EVENT_TYPES.has(r.type)) return null;
  if (typeof r.backend !== "string") return null;
  if (typeof r.workerId !== "string") return null;
  if (r.nativeId !== undefined && typeof r.nativeId !== "string") return null;

  const parts: string[] = [];
  parts.push('"seq":' + JSON.stringify(r.seq));
  parts.push('"at":' + JSON.stringify(r.at));
  parts.push('"type":' + JSON.stringify(r.type));
  parts.push('"backend":' + JSON.stringify(r.backend));
  parts.push('"workerId":' + JSON.stringify(r.workerId));
  if (r.nativeId !== undefined) parts.push('"nativeId":' + JSON.stringify(r.nativeId));
  if (r.detail !== undefined) {
    const encodedDetail = canonicalizeDetailIndependent(r.detail);
    if (encodedDetail === null) return null;
    parts.push('"detail":' + encodedDetail);
  }
  parts.push('"prevHash":' + JSON.stringify(prevHash));

  return localSha256Hex("{" + parts.join(",") + "}");
}

interface ChainRecomputeResult {
  ok: boolean;
  /** The independently-recomputed chain head; `null` when `ok` is false. */
  head: string | null;
}

/** Walk `records` in array order from `genesis`, recomputing every hash and
 *  checking prevHash linkage — the "own code path" full independent
 *  recompute the file header describes. Never throws. */
function recomputeChainIndependently(records: unknown, genesis: string): ChainRecomputeResult {
  if (!Array.isArray(records)) return { ok: false, head: null };
  let prevHash = genesis;
  for (const raw of records) {
    if (!isPlainObject(raw)) return { ok: false, head: null };
    if (typeof raw.prevHash !== "string" || raw.prevHash !== prevHash) return { ok: false, head: null };
    if (typeof raw.hash !== "string") return { ok: false, head: null };
    const recomputed = recomputeRecordHash(raw, prevHash);
    if (recomputed === null || recomputed !== raw.hash) return { ok: false, head: null };
    prevHash = raw.hash;
  }
  return { ok: true, head: prevHash };
}

// ---------------------------------------------------------------------------
// Per-check implementations — every one individually exception-guarded by
// `safe()` at the call site, so a wildly hostile report can only fail
// checks, never throw uncaught.
// ---------------------------------------------------------------------------

function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

function checkShapeValid(report: Record<string, unknown>): boolean {
  const backends = report.backends;
  if (!Array.isArray(backends)) return false;
  for (const b of backends) {
    if (!isPlainObject(b)) return false;
    if (typeof b.name !== "string" || b.name.length === 0) return false;
    if (typeof b.kind !== "string" || b.kind.length === 0) return false;
    if (typeof b.available !== "boolean") return false;
  }
  const handles = report.handles;
  if (!Array.isArray(handles)) return false;
  for (const h of handles) {
    if (!isPlainObject(h)) return false;
    if (typeof h.workerId !== "string") return false;
    if (typeof h.backend !== "string") return false;
    if (typeof h.state !== "string") return false;
  }
  const cert = report.certificate;
  if (!isPlainObject(cert)) return false;
  if (typeof cert.traceRoot !== "string") return false;
  if (typeof cert.head !== "string") return false;
  if (typeof cert.length !== "number" || !Number.isFinite(cert.length)) return false;
  if (!Array.isArray(report.records)) return false;
  return true;
}

function checkTraceRootMatchesPreimage(report: Record<string, unknown>): boolean {
  const cert = report.certificate;
  if (!isPlainObject(cert) || typeof cert.traceRoot !== "string") return false;
  return cert.traceRoot === localSha256Hex(BACKENDS_TRACE_ROOT_PREIMAGE);
}

function checkLedgerVerifyChain(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  try {
    BackendProvenanceLedger.fromRecords(records as BackendLifecycleRecord[]);
    return true;
  } catch {
    return false;
  }
}

function checkCertificateLengthConsistent(report: Record<string, unknown>): boolean {
  const cert = report.certificate;
  if (!isPlainObject(cert) || typeof cert.length !== "number" || !Number.isFinite(cert.length)) return false;
  if (!Array.isArray(report.records)) return false;
  return cert.length === report.records.length;
}

function checkCertificateHeadConsistent(
  report: Record<string, unknown>,
  chain: ChainRecomputeResult,
  genesis: string,
): boolean {
  const cert = report.certificate;
  if (!isPlainObject(cert) || typeof cert.head !== "string") return false;
  const records = report.records;
  if (!Array.isArray(records)) return false;
  if (records.length === 0) return cert.head === genesis;
  if (!chain.ok || chain.head === null) return false;
  return cert.head === chain.head;
}

function checkSeqStrictlyIncreasing(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!isPlainObject(r)) return false;
    if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq !== i) return false;
  }
  return true;
}

function checkHandlesBackendExists(report: Record<string, unknown>): boolean {
  const backends = report.backends;
  const handles = report.handles;
  if (!Array.isArray(backends) || !Array.isArray(handles)) return false;
  const names = new Set<string>();
  for (const b of backends) {
    if (isPlainObject(b) && typeof b.name === "string") names.add(b.name);
  }
  for (const h of handles) {
    if (!isPlainObject(h) || typeof h.backend !== "string") return false;
    if (!names.has(h.backend)) return false;
  }
  return true;
}

/** The most recent (highest `seq`) record for `workerId`, skipping fleet-scoped
 *  (`sweep`/`probe`) records — `null` when there is no evidence at all. */
function mostRecentWorkerRecordType(records: unknown[], workerId: string): string | null {
  let best: { seq: number; type: string } | null = null;
  for (const raw of records) {
    if (!isPlainObject(raw)) continue;
    if (raw.workerId !== workerId) continue;
    if (typeof raw.type !== "string" || typeof raw.seq !== "number") continue;
    if (raw.type === "sweep" || raw.type === "probe") continue;
    if (best === null || raw.seq > best.seq) best = { seq: raw.seq, type: raw.type };
  }
  return best?.type ?? null;
}

function checkHandlesStateConsistent(report: Record<string, unknown>): boolean {
  const handles = report.handles;
  const records = report.records;
  if (!Array.isArray(handles) || !Array.isArray(records)) return false;
  for (const h of handles) {
    if (!isPlainObject(h) || typeof h.workerId !== "string" || typeof h.state !== "string") return false;
    const lastType = mostRecentWorkerRecordType(records, h.workerId);
    if (lastType === null) return false;
    const expected = EVENT_TYPE_TO_EXPECTED_STATES[lastType];
    if (!expected || !expected.includes(h.state)) return false;
  }
  return true;
}

function checkTimestampsNonDecreasing(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  let prevAt = -Infinity;
  for (const raw of records) {
    if (!isPlainObject(raw)) return false;
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return false;
    if (raw.at < prevAt) return false;
    prevAt = raw.at;
  }
  return true;
}

function checkDetailScalarOnly(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  for (const raw of records) {
    if (!isPlainObject(raw)) return false;
    if (raw.detail === undefined) continue;
    if (!isPlainObject(raw.detail)) return false;
    for (const v of Object.values(raw.detail)) {
      const t = typeof v;
      if (t === "string" || t === "boolean") continue;
      if (t === "number" && Number.isFinite(v as number)) continue;
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The fixed, LOCKED eleven-code checklist, in check order.
// ---------------------------------------------------------------------------

const CHECK_CODES = [
  "shape-valid",
  "traceroot-matches-preimage",
  "chain-recompute",
  "ledger-verifychain",
  "certificate-length-consistent",
  "certificate-head-consistent",
  "seq-strictly-increasing",
  "handles-backend-exists",
  "handles-state-consistent",
  "timestamps-non-decreasing",
  "detail-scalar-only",
] as const;

type CheckCode = (typeof CHECK_CODES)[number];

function runChecklist(report: Record<string, unknown>): Record<CheckCode, boolean> {
  const genesis = localSha256Hex(BACKENDS_TRACE_ROOT_PREIMAGE);
  let chain: ChainRecomputeResult;
  try {
    chain = recomputeChainIndependently(report.records, genesis);
  } catch {
    chain = { ok: false, head: null };
  }

  return {
    "shape-valid": safe(() => checkShapeValid(report)),
    "traceroot-matches-preimage": safe(() => checkTraceRootMatchesPreimage(report)),
    "chain-recompute": chain.ok,
    "ledger-verifychain": safe(() => checkLedgerVerifyChain(report.records)),
    "certificate-length-consistent": safe(() => checkCertificateLengthConsistent(report)),
    "certificate-head-consistent": safe(() => checkCertificateHeadConsistent(report, chain, genesis)),
    "seq-strictly-increasing": safe(() => checkSeqStrictlyIncreasing(report.records)),
    "handles-backend-exists": safe(() => checkHandlesBackendExists(report)),
    "handles-state-consistent": safe(() => checkHandlesStateConsistent(report)),
    "timestamps-non-decreasing": safe(() => checkTimestampsNonDecreasing(report.records)),
    "detail-scalar-only": safe(() => checkDetailScalarOnly(report.records)),
  };
}

// ---------------------------------------------------------------------------
// Verifier factory
// ---------------------------------------------------------------------------

/**
 * Build the `verify.backends` output verifier. `verify` never throws: every
 * branch (tool failure, unparsable output, well-formed-or-hostile report)
 * returns a complete `ToolVerdict`.
 */
export function backendsFleetVerifier(): ToolOutputVerifier {
  const verifierId = VERIFIER_ID;
  return {
    verifierId,
    toolName: "backends",
    verify(_input: string, result: ToolResult): ToolVerdict {
      if (!result.ok) {
        return {
          verifierId,
          passed: false,
          confidence: FAILURE_DETECTION_CONFIDENCE,
          reasons: ["TOOL_REPORTED_FAILURE"],
        };
      }

      const parsed = parseJsonObject(result.output);
      if (!parsed.ok) {
        return {
          verifierId,
          passed: false,
          confidence: FAILURE_DETECTION_CONFIDENCE,
          reasons: [parsed.reason],
        };
      }

      const checklist = runChecklist(parsed.value);
      const failedCodes = CHECK_CODES.filter((code) => !checklist[code]);
      const passed = failedCodes.length === 0;
      const prior = backendsFleetCalibration().prior;
      const fraction = (CHECK_CODES.length - failedCodes.length) / CHECK_CODES.length;
      const confidence = clamp01(fraction * prior);

      return { verifierId, passed, confidence, reasons: [...failedCodes] };
    },
  };
}

/**
 * `verify.backends`'s honest tier + calibrated prior. See the file header's
 * "Calibration math" section for the full rationale; short version: tier is
 * T4-consistency (self-consistency only, no oracle over whether the fleet
 * events genuinely happened), prior is `0.72` — the top of the locked
 * [0.6, 0.75] T4 band, because a full hash-chain recompute cross-checked by
 * two independent code paths is more decisive, harder-to-game evidence than
 * a single-output shape/format check.
 */
export function backendsFleetCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.72 };
}
