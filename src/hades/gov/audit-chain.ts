/**
 * The durable, tamper-evident governance audit log.
 *
 * A hash-chained, append-only JSONL store: every entry embeds the sha256 of
 * the previous entry (`prevSha256`) and its own recomputable self-hash
 * (`entrySha256`), so flipping a single byte anywhere in history breaks the
 * chain from that point forward. On top of the raw hash chain,
 * `./audit-proof.ts` provides RFC 6962-style Merkle inclusion/consistency
 * proofs and ed25519-signed checkpoints — the mechanism that catches an
 * attacker who rewrites the ENTIRE file so it is internally
 * hash-consistent again (a pure hash chain alone cannot detect that; a
 * checkpoint signed before the rewrite can, because the rewritten content
 * hashes to a different Merkle root than the one that was signed).
 *
 * Design discipline, matching the rest of the `gov/` module:
 *  - Hashing goes through the ONE hash implementation in the codebase,
 *    `sha256Hex` from `../styx/certificate` (the same discipline
 *    `../trust/budget.ts` and `../browser/trace.ts` follow).
 *  - Signing goes through `./identity`'s `GovIdentity` / `govCanonicalize` /
 *    `govDigest` / `verifyGovSignature` — the one canonical-serialization
 *    and signing surface for every governance document in the system.
 *  - No ambient `Date.now()` inside any pure function — `GovAuditChain.open`
 *    takes an injectable `now`, used only as the default for callers who
 *    don't pass an explicit `at` to `append`/`checkpoint`.
 *  - Every write is `appendFileSync` immediately followed by an explicit
 *    `fsync` on the file, mirroring `./keystore.ts`'s durability discipline
 *    — a crash right after `append()` returns can lose at most nothing;
 *    a crash DURING the write leaves a torn final line, which `verify()`
 *    reports as `"truncated-record"` rather than silently dropping or
 *    "healing" it by rewriting history.
 *
 * Storage layout: `<dir>/audit/seg-000000.jsonl`, `seg-000001.jsonl`, ...
 * (rolling at `segmentBytes`, default 4 MiB) plus `<dir>/audit/checkpoints.jsonl`.
 * `seq` is dense and strictly monotonic starting at 0 across every segment
 * roll — segments are purely a file-size concern, never a numbering reset.
 *
 * Two independent knowledge sources are kept deliberately: an in-memory
 * cache (`knownEntries`, `nextSeq`, `headHash`) that this process's OWN
 * appends maintain incrementally for O(1) amortized `append()`/cheap
 * `head()`/`size()`/`entries()`, and a from-BYTES rescan (`freshScan()`)
 * that `verify()` and `verifyAgainstCheckpoint()` always perform instead of
 * trusting the cache — because the entire point of this module is to catch
 * an attacker who modified the file out from under the process, and a
 * verification routine that trusted its own cache could never see that.
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../styx/certificate";
import { GovIdentity, govDigest } from "./identity";
import {
  merkleRoot,
  signCheckpoint,
  verifyCheckpoint,
  type SignedCheckpoint,
} from "./audit-proof";

// ---------------------------------------------------------------------------
// Schema / genesis
// ---------------------------------------------------------------------------

export const GOV_AUDIT_SCHEMA = "hades.gov.audit.v1" as const;

/** `sha256Hex(GOV_AUDIT_SCHEMA)` — the fixed root for an empty chain and the `prevSha256` of entry 0. */
export const GOV_AUDIT_GENESIS: string = sha256Hex(GOV_AUDIT_SCHEMA);

// ---------------------------------------------------------------------------
// Entry / input types
// ---------------------------------------------------------------------------

export type AuditOutcome = "allow" | "deny" | "abstain" | "info" | "error";

const AUDIT_OUTCOMES: readonly AuditOutcome[] = ["allow", "deny", "abstain", "info", "error"];

export interface GovAuditEntry {
  seq: number;
  at: number;
  actor: string;
  action: string;
  resource: string;
  outcome: AuditOutcome;
  code?: string;
  payloadSha256: string;
  meta?: Record<string, string | number | boolean | null>;
  prevSha256: string;
  entrySha256: string;
}

export interface AppendInput {
  at: number;
  actor: string;
  action: string;
  resource: string;
  outcome: AuditOutcome;
  code?: string;
  /** Hashed via `govDigest` and never stored — the log binds secrets without leaking them. */
  payload?: unknown;
  meta?: GovAuditEntry["meta"];
}

// ---------------------------------------------------------------------------
// Failure / verification types
// ---------------------------------------------------------------------------

export type AuditFailureCode =
  | "genesis-mismatch"
  | "hash-mismatch"
  | "link-broken"
  | "seq-gap"
  | "seq-duplicate"
  | "truncated-record"
  | "malformed-json"
  | "schema-mismatch"
  | "missing-segment"
  | "checkpoint-signature-invalid"
  | "checkpoint-root-mismatch"
  | "checkpoint-regression";

export interface AuditFailure {
  code: AuditFailureCode;
  seq?: number;
  detail: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  head?: { seq: number; sha256: string };
  brokenAt?: number;
  failures: AuditFailure[];
}

// ---------------------------------------------------------------------------
// Canonical per-entry serialization — LOCKED fixed field order:
// seq, at, actor, action, resource, outcome, code, payloadSha256, meta, prevSha256
// ---------------------------------------------------------------------------

function canonicalMetaString(meta: GovAuditEntry["meta"]): string {
  if (meta === undefined) return "null";
  const keys = Object.keys(meta).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(meta[k]));
  return "{" + parts.join(",") + "}";
}

interface CanonicalFields {
  seq: number;
  at: number;
  actor: string;
  action: string;
  resource: string;
  outcome: AuditOutcome;
  code?: string;
  payloadSha256: string;
  meta?: GovAuditEntry["meta"];
  prevSha256: string;
}

/**
 * The fixed-field-order canonical string this chain hashes. Deliberately
 * NOT `govCanonicalize` (which sorts keys alphabetically) — the field
 * order here is locked and explicit so the on-disk hash is stable and
 * human-auditable without depending on a generic canonicalizer's sort
 * behavior. `meta`'s own keys ARE sorted (it is the one nested object) so
 * two logically-identical `meta` values always hash identically regardless
 * of property insertion order.
 */
function canonicalEntryString(e: CanonicalFields): string {
  return (
    "{" +
    `"seq":${JSON.stringify(e.seq)},` +
    `"at":${JSON.stringify(e.at)},` +
    `"actor":${JSON.stringify(e.actor)},` +
    `"action":${JSON.stringify(e.action)},` +
    `"resource":${JSON.stringify(e.resource)},` +
    `"outcome":${JSON.stringify(e.outcome)},` +
    `"code":${e.code !== undefined ? JSON.stringify(e.code) : "null"},` +
    `"payloadSha256":${JSON.stringify(e.payloadSha256)},` +
    `"meta":${canonicalMetaString(e.meta)},` +
    `"prevSha256":${JSON.stringify(e.prevSha256)}` +
    "}"
  );
}

// ---------------------------------------------------------------------------
// Runtime shape checks — never throw, used while parsing untrusted bytes.
// ---------------------------------------------------------------------------

function isAuditOutcome(x: unknown): x is AuditOutcome {
  return typeof x === "string" && (AUDIT_OUTCOMES as readonly string[]).includes(x);
}

function isMetaShape(x: unknown): x is GovAuditEntry["meta"] {
  if (x === undefined) return true;
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  return Object.values(x as Record<string, unknown>).every(
    (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null,
  );
}

function isGovAuditEntryShape(v: unknown): v is GovAuditEntry {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return false;
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return false;
  if (typeof o.actor !== "string" || typeof o.action !== "string" || typeof o.resource !== "string") return false;
  if (!isAuditOutcome(o.outcome)) return false;
  if (o.code !== undefined && typeof o.code !== "string") return false;
  if (typeof o.payloadSha256 !== "string") return false;
  if (!isMetaShape(o.meta)) return false;
  if (typeof o.prevSha256 !== "string" || typeof o.entrySha256 !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const SEGMENT_RE = /^seg-(\d{6})\.jsonl$/;
const CHECKPOINTS_FILE = "checkpoints.jsonl";
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;

function segmentFileName(index: number): string {
  return `seg-${String(index).padStart(6, "0")}.jsonl`;
}

interface SegmentRef {
  index: number;
  path: string;
}

// ---------------------------------------------------------------------------
// GovAuditChain
// ---------------------------------------------------------------------------

interface ScanResult {
  entries: GovAuditEntry[];
  failures: AuditFailure[];
}

export class GovAuditChain {
  private readonly dir: string; // "<opts.dir>/audit"
  private readonly nowFn: () => number;
  private readonly segmentBytes: number;

  // In-memory cache, maintained incrementally by THIS process's own appends.
  private knownEntries: GovAuditEntry[] = [];
  private nextSeq = 0;
  private headHash: string = GOV_AUDIT_GENESIS;
  private headSeq: number | undefined = undefined;

  // Physical write position.
  private currentSegmentIndex = 0;
  private currentSegmentSize = 0;

  private poisoned: AuditFailure | undefined;
  private closed = false;

  private constructor(dir: string, nowFn: () => number, segmentBytes: number) {
    this.dir = dir;
    this.nowFn = nowFn;
    this.segmentBytes = segmentBytes;
  }

  static open(opts: { dir: string; now?: () => number; segmentBytes?: number; verifyOnOpen?: boolean }): GovAuditChain {
    if (!opts || typeof opts.dir !== "string" || opts.dir.length === 0) {
      throw new RangeError("GovAuditChain.open: opts.dir must be a non-empty path");
    }
    const segmentBytes = opts.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    if (!Number.isInteger(segmentBytes) || segmentBytes <= 0) {
      throw new RangeError("GovAuditChain.open: opts.segmentBytes must be a positive integer");
    }
    const nowFn = opts.now ?? (() => Date.now());
    const verifyOnOpen = opts.verifyOnOpen ?? true;

    const auditDir = join(opts.dir, "audit");
    mkdirSync(auditDir, { recursive: true });

    const chain = new GovAuditChain(auditDir, nowFn, segmentBytes);

    const { entries, failures } = chain.freshScan();
    chain.knownEntries = entries;
    chain.nextSeq = entries.length;
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      chain.headHash = last.entrySha256;
      chain.headSeq = last.seq;
    }
    const pos = chain.locateWritePosition();
    chain.currentSegmentIndex = pos.index;
    chain.currentSegmentSize = pos.size;

    if (verifyOnOpen && failures.length > 0) {
      chain.poisoned = failures[0];
    }

    return chain;
  }

  // -------------------------------------------------------------------------
  // Segment discovery
  // -------------------------------------------------------------------------

  private listSegments(): SegmentRef[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SegmentRef[] = [];
    for (const name of names) {
      const m = SEGMENT_RE.exec(name);
      if (m) out.push({ index: Number(m[1]), path: join(this.dir, name) });
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  private locateWritePosition(): { index: number; size: number } {
    const segs = this.listSegments();
    if (segs.length === 0) return { index: 0, size: 0 };
    const last = segs[segs.length - 1];
    let size = 0;
    try {
      size = statSync(last.path).size;
    } catch {
      size = 0;
    }
    return { index: last.index, size };
  }

  // -------------------------------------------------------------------------
  // From-bytes scan — the single source of truth `verify()` and
  // `verifyAgainstCheckpoint()` use. Total: never throws, always returns a
  // best-effort prefix of good entries plus the failures found scanning it.
  // -------------------------------------------------------------------------

  private freshScan(): ScanResult {
    const failures: AuditFailure[] = [];
    const entries: GovAuditEntry[] = [];
    let expectedSeq = 0;
    let prevHash = GOV_AUDIT_GENESIS;

    const segs = this.listSegments();
    const byIndex = new Map(segs.map((s) => [s.index, s.path]));
    const maxIndex = segs.length > 0 ? segs[segs.length - 1].index : -1;

    scanLoop: for (let idx = 0; idx <= maxIndex; idx++) {
      const path = byIndex.get(idx);
      if (path === undefined) {
        failures.push({
          code: "missing-segment",
          seq: expectedSeq,
          detail: `segment index ${idx} (${segmentFileName(idx)}) is missing from ${this.dir}; chain was at seq ${expectedSeq} when it should have continued there`,
        });
        break;
      }

      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (e) {
        failures.push({
          code: "missing-segment",
          seq: expectedSeq,
          detail: `segment ${segmentFileName(idx)} could not be read: ${e instanceof Error ? e.message : String(e)}`,
        });
        break;
      }

      const isLastSegment = idx === maxIndex;
      const hasTrailingNewline = raw.endsWith("\n");
      const lines = raw.length === 0 ? [] : raw.split("\n");
      if (hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const isFinalLineOfFinalSegment = isLastSegment && li === lines.length - 1;
        const looksTorn = isFinalLineOfFinalSegment && !hasTrailingNewline;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          failures.push({
            code: looksTorn ? "truncated-record" : "malformed-json",
            seq: expectedSeq,
            detail: looksTorn
              ? `final line of ${segmentFileName(idx)} is not valid JSON (no trailing newline — likely a crash mid-write)`
              : `line ${li + 1} of ${segmentFileName(idx)} is not valid JSON`,
          });
          break scanLoop;
        }
        if (!isGovAuditEntryShape(parsed)) {
          failures.push({
            code: looksTorn ? "truncated-record" : "malformed-json",
            seq: expectedSeq,
            detail: looksTorn
              ? `final line of ${segmentFileName(idx)} did not parse to a well-formed audit entry (likely a crash mid-write)`
              : `line ${li + 1} of ${segmentFileName(idx)} is not a well-formed GovAuditEntry`,
          });
          break scanLoop;
        }

        const entry = parsed;

        if (entry.seq !== expectedSeq) {
          const code: AuditFailureCode = entry.seq === expectedSeq - 1 ? "seq-duplicate" : "seq-gap";
          failures.push({
            code,
            seq: expectedSeq,
            detail: `expected seq ${expectedSeq} at ${segmentFileName(idx)}:${li + 1}, found ${entry.seq}`,
          });
          break scanLoop;
        }

        const recomputed = sha256Hex(canonicalEntryString(entry));
        if (recomputed !== entry.entrySha256) {
          failures.push({
            code: "hash-mismatch",
            seq: entry.seq,
            detail: `stored entrySha256 for seq ${entry.seq} does not match the recomputed hash of its canonical fields`,
          });
          break scanLoop;
        }

        if (entry.seq === 0) {
          if (entry.prevSha256 !== GOV_AUDIT_GENESIS) {
            failures.push({
              code: "genesis-mismatch",
              seq: 0,
              detail: `entry 0's prevSha256 does not equal GOV_AUDIT_GENESIS`,
            });
            break scanLoop;
          }
        } else if (entry.prevSha256 !== prevHash) {
          failures.push({
            code: "link-broken",
            seq: entry.seq,
            detail: `entry ${entry.seq}'s prevSha256 does not match the previous entry's entrySha256`,
          });
          break scanLoop;
        }

        entries.push(entry);
        prevHash = entry.entrySha256;
        expectedSeq++;
      }
    }

    return { entries, failures };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  append(input: AppendInput): GovAuditEntry {
    if (this.closed) {
      throw new Error("GovAuditChain: chain is closed");
    }
    if (this.poisoned) {
      throw new Error(
        `GovAuditChain: refusing to append — chain failed verification on open (${this.poisoned.code}${this.poisoned.seq !== undefined ? ` at seq ${this.poisoned.seq}` : ""}: ${this.poisoned.detail})`,
      );
    }
    if (typeof input.at !== "number" || !Number.isFinite(input.at)) {
      throw new TypeError("GovAuditChain.append: input.at must be a finite number");
    }
    if (typeof input.actor !== "string" || typeof input.action !== "string" || typeof input.resource !== "string") {
      throw new TypeError("GovAuditChain.append: actor, action, and resource must be strings");
    }
    if (!isAuditOutcome(input.outcome)) {
      throw new TypeError(`GovAuditChain.append: invalid outcome "${String(input.outcome)}"`);
    }
    if (input.code !== undefined && typeof input.code !== "string") {
      throw new TypeError("GovAuditChain.append: code must be a string when provided");
    }
    if (!isMetaShape(input.meta)) {
      throw new TypeError("GovAuditChain.append: meta must be a flat record of string/number/boolean/null");
    }

    const seq = this.nextSeq;
    const prevSha256 = this.headHash;
    const payloadSha256 = govDigest(input.payload === undefined ? null : input.payload);
    const meta = input.meta !== undefined ? { ...input.meta } : undefined;

    const fields: CanonicalFields = {
      seq,
      at: input.at,
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      outcome: input.outcome,
      code: input.code,
      payloadSha256,
      meta,
      prevSha256,
    };
    const entrySha256 = sha256Hex(canonicalEntryString(fields));

    const entry: GovAuditEntry = {
      seq,
      at: input.at,
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      outcome: input.outcome,
      ...(input.code !== undefined ? { code: input.code } : {}),
      payloadSha256,
      ...(meta !== undefined ? { meta } : {}),
      prevSha256,
      entrySha256,
    };

    const line = JSON.stringify(entry) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (this.currentSegmentSize > 0 && this.currentSegmentSize + lineBytes > this.segmentBytes) {
      this.currentSegmentIndex++;
      this.currentSegmentSize = 0;
    }
    const path = join(this.dir, segmentFileName(this.currentSegmentIndex));
    appendFileSync(path, line, "utf8");
    fsyncFile(path);
    this.currentSegmentSize += lineBytes;

    this.knownEntries.push(entry);
    this.nextSeq = seq + 1;
    this.headHash = entrySha256;
    this.headSeq = seq;

    return entry;
  }

  /**
   * Sign and persist a checkpoint over the CURRENT cached state (this
   * process's own view — the same state `head()`/`size()`/`leafHashes()`
   * report). Appends one line to `<dir>/audit/checkpoints.jsonl`, fsynced
   * like every other write in this module.
   */
  checkpoint(identity: GovIdentity, at: number): SignedCheckpoint {
    if (this.closed) {
      throw new Error("GovAuditChain: chain is closed");
    }
    const leaves = this.leafHashes();
    const cp = signCheckpoint(identity, {
      treeSize: leaves.length,
      root: merkleRoot(leaves),
      headSha256: this.headHash,
      at,
    });
    const path = join(this.dir, CHECKPOINTS_FILE);
    const line = JSON.stringify(cp) + "\n";
    appendFileSync(path, line, "utf8");
    fsyncFile(path);
    return cp;
  }

  // -------------------------------------------------------------------------
  // Reads (from the in-memory cache — accurate for this process's own view
  // as of the last `open()`/`append()`; use `verify()` for a from-bytes
  // check against external tampering).
  // -------------------------------------------------------------------------

  entries(opts: { fromSeq?: number; limit?: number; actor?: string; action?: string; outcome?: AuditOutcome } = {}): GovAuditEntry[] {
    let result: GovAuditEntry[] = this.knownEntries;
    if (opts.fromSeq !== undefined) {
      const fromSeq = opts.fromSeq;
      result = result.filter((e) => e.seq >= fromSeq);
    }
    if (opts.actor !== undefined) {
      const actor = opts.actor;
      result = result.filter((e) => e.actor === actor);
    }
    if (opts.action !== undefined) {
      const action = opts.action;
      result = result.filter((e) => e.action === action);
    }
    if (opts.outcome !== undefined) {
      const outcome = opts.outcome;
      result = result.filter((e) => e.outcome === outcome);
    }
    if (opts.limit !== undefined) {
      result = result.slice(0, opts.limit);
    }
    return result.map((e) => ({ ...e, ...(e.meta !== undefined ? { meta: { ...e.meta } } : {}) }));
  }

  head(): { seq: number; sha256: string } | undefined {
    return this.headSeq !== undefined ? { seq: this.headSeq, sha256: this.headHash } : undefined;
  }

  size(): number {
    return this.knownEntries.length;
  }

  /** Raw (un-domain-separated) leaf digests in seq order — `entrySha256` values — for `audit-proof.ts`. */
  leafHashes(): string[] {
    return this.knownEntries.map((e) => e.entrySha256);
  }

  // -------------------------------------------------------------------------
  // Verification — ALWAYS re-reads from disk, never the cache.
  // -------------------------------------------------------------------------

  verify(): AuditVerification {
    const { entries, failures } = this.freshScan();
    const head = entries.length > 0 ? { seq: entries[entries.length - 1].seq, sha256: entries[entries.length - 1].entrySha256 } : undefined;
    return {
      ok: failures.length === 0,
      entries: entries.length,
      head,
      brokenAt: failures.length > 0 ? failures[0].seq : undefined,
      failures,
    };
  }

  /**
   * Verify the from-bytes chain AND cross-check it against a previously
   * issued signed checkpoint: a rewritten-but-internally-consistent chain
   * passes the raw hash-chain scan (nothing wrong there — that is exactly
   * the limitation checkpoints exist to cover) but fails HERE, because the
   * recomputed Merkle root over the checkpointed prefix no longer matches
   * the root that was signed.
   */
  verifyAgainstCheckpoint(cp: SignedCheckpoint, trustedPublicKeys: readonly string[]): AuditVerification {
    const { entries, failures: chainFailures } = this.freshScan();
    const failures: AuditFailure[] = [...chainFailures];

    const sig = verifyCheckpoint(cp, trustedPublicKeys);
    if (!sig.ok) {
      failures.push(...sig.failures);
    } else {
      const currentSize = entries.length;
      if (currentSize < cp.treeSize) {
        failures.push({
          code: "checkpoint-regression",
          seq: currentSize > 0 ? currentSize - 1 : undefined,
          detail: `chain currently has ${currentSize} entries, fewer than the ${cp.treeSize} certified by the checkpoint issued at ${cp.at} — history has been truncated since the checkpoint was signed`,
        });
      } else {
        const leaves = entries.map((e) => e.entrySha256);
        const prefixRoot = merkleRoot(leaves.slice(0, cp.treeSize));
        if (prefixRoot !== cp.root) {
          failures.push({
            code: "checkpoint-root-mismatch",
            seq: cp.treeSize > 0 ? cp.treeSize - 1 : undefined,
            detail: `recomputed Merkle root over the first ${cp.treeSize} entries does not match the checkpoint's certified root — history at or before the checkpoint has been altered`,
          });
        } else if (cp.treeSize > 0) {
          const boundary = entries[cp.treeSize - 1];
          if (boundary === undefined || boundary.entrySha256 !== cp.headSha256) {
            failures.push({
              code: "checkpoint-root-mismatch",
              seq: cp.treeSize - 1,
              detail: `entry at the checkpoint boundary does not match the checkpoint's certified headSha256`,
            });
          }
        }
      }
    }

    const head = entries.length > 0 ? { seq: entries[entries.length - 1].seq, sha256: entries[entries.length - 1].entrySha256 } : undefined;
    const brokenAt = chainFailures.length > 0 ? chainFailures[0].seq : failures.find((f) => f.seq !== undefined)?.seq;

    return {
      ok: failures.length === 0,
      entries: entries.length,
      head,
      brokenAt,
      failures,
    };
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Adapter for the legacy in-memory recorder (`../security/audit.ts`) — piped
// into the durable chain without editing that file. Type-only import: this
// module has zero runtime dependency on `../security/audit.ts`.
// ---------------------------------------------------------------------------

/**
 * Map a legacy `AuditEvent` (from `../security/audit.ts`'s in-memory
 * `AuditLog`) onto an `AppendInput` for the durable chain. `authorize`
 * events map their `detail.granted` boolean onto `"allow"`/`"deny"`;
 * `reject` events are always `"deny"`; everything else (`a2a`, `spawn`,
 * `terminate`) is informational (`"info"`) — none of those legacy event
 * types encode an allow/deny decision. The full `detail` object (if any)
 * becomes the hashed `payload`; it is never stored verbatim.
 */
export function fromLegacyAuditEvent(e: import("../security/audit").AuditEvent): AppendInput {
  let outcome: AuditOutcome;
  switch (e.type) {
    case "authorize": {
      const granted = e.detail !== undefined && (e.detail as { granted?: unknown }).granted === true;
      outcome = granted ? "allow" : "deny";
      break;
    }
    case "reject":
      outcome = "deny";
      break;
    case "a2a":
    case "spawn":
    case "terminate":
    default:
      outcome = "info";
      break;
  }

  const actor = e.actor ?? e.team ?? "unknown";
  const resource = e.target ?? e.team ?? e.type;
  const meta = e.team !== undefined ? { team: e.team } : undefined;

  return {
    at: e.at,
    actor,
    action: e.type,
    resource,
    outcome,
    payload: e.detail,
    meta,
  };
}
