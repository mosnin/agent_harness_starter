/**
 * The durable, signed, fail-CLOSED policy store for `./policy.ts`.
 *
 * The one discipline this module exists to enforce: **a `load()` that is
 * anything other than `"ok"` NEVER returns an engine that can allow
 * anything**. An absent file, a JSON parse failure, an unsigned bundle, a
 * bundle whose signature does not verify (including a single flipped byte
 * anywhere in `doc`), a bundle signed by a key outside
 * `trustedSignerPublicKeys`, an inner document that fails
 * `parsePolicyDocument`'s strict schema validation, or an attempted
 * version rollback all return `PolicyEngine.denyAll(reason)` — a policy
 * engine with zero rules whose `evaluate()` denies literally everything,
 * with a `reason` string that names exactly which of those problems
 * occurred. There is no code path in `load()` that can hand back a
 * permissive engine without first passing every one of those checks.
 *
 * Anti-rollback (`save`'s version check, and `load`'s `downgrade-refused`
 * status) is keyed off `policy-history.jsonl`, an append-only log of every
 * version this store has ever durably saved, NOT off whatever happens to be
 * sitting in `policy.json` right now — so an attacker who replaces
 * `policy.json` with an older, validly-signed-by-a-trusted-key bundle
 * (a pure replay: the file is genuinely authentic, just stale) is still
 * caught, because the history log remembers a higher version was reached.
 *
 * Every write (`policy.json`, `policy-history.jsonl`) is tmp-file +
 * `renameSync` atomic, guarded by a directory-mkdir mutex identical in
 * spirit to `./keystore.ts`'s locking, so two `PolicyStore` instances
 * against the same `dir` cannot interleave a read-modify-write and corrupt
 * either file.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GovIdentity, govCanonicalize, govDigest, verifyGovSignature } from "./identity";
import { PolicyEngine, parsePolicyDocument, type PolicyAuditSink, type PolicyDocument } from "./policy";

// ---------------------------------------------------------------------------
// Locked public types
// ---------------------------------------------------------------------------

export interface SignedPolicyBundle {
  doc: PolicyDocument;
  signature: string;
  signerPublicKey: string;
  docSha256: string;
}

export type PolicyLoadStatus = "ok" | "absent" | "unsigned" | "signature-invalid" | "untrusted-signer" | "malformed" | "downgrade-refused" | "schema-mismatch";

export interface PolicyLoadResult {
  status: PolicyLoadStatus;
  engine: PolicyEngine;
  bundle?: SignedPolicyBundle;
  reason: string;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const POLICY_FILE = "policy.json";
const HISTORY_FILE = "policy-history.jsonl";
const LOCK_DIR = ".policy-lock";

interface HistoryEntry {
  version: number;
  docSha256: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

// ---------------------------------------------------------------------------
// PolicyStore
// ---------------------------------------------------------------------------

export class PolicyStore {
  private readonly dir: string;
  private readonly trustedSignerPublicKeys: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly audit: PolicyAuditSink | undefined;

  private constructor(dir: string, trustedSignerPublicKeys: ReadonlySet<string>, now: () => number, audit: PolicyAuditSink | undefined) {
    this.dir = dir;
    this.trustedSignerPublicKeys = trustedSignerPublicKeys;
    this.now = now;
    this.audit = audit;
  }

  static open(opts: { dir: string; trustedSignerPublicKeys: readonly string[]; now?: () => number; audit?: PolicyAuditSink }): PolicyStore {
    if (!opts || typeof opts.dir !== "string" || opts.dir.length === 0) {
      throw new RangeError("PolicyStore.open: dir must be a non-empty path");
    }
    return new PolicyStore(opts.dir, new Set(opts.trustedSignerPublicKeys), opts.now ?? (() => Date.now()), opts.audit);
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private policyPath(): string {
    return join(this.dir, POLICY_FILE);
  }
  private historyPath(): string {
    return join(this.dir, HISTORY_FILE);
  }
  private lockPath(): string {
    return join(this.dir, LOCK_DIR);
  }

  // -------------------------------------------------------------------------
  // Locking + atomic write (mirrors ./keystore.ts)
  // -------------------------------------------------------------------------

  private acquireLock(): () => void {
    const lockDir = this.lockPath();
    const timeoutMs = 5000;
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        mkdirSync(lockDir, { recursive: false });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`policy store: timed out acquiring lock at "${lockDir}" after ${timeoutMs}ms`);
        }
        attempt += 1;
        sleepSyncMs(Math.min(50 * attempt, 250));
      }
    }
  }

  private atomicWrite(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w", 0o644);
    try {
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  // -------------------------------------------------------------------------
  // History (append-only, but persisted as an atomically-rewritten whole
  // file rather than a raw fs-append — see ./keystore.ts's rotations.json
  // for the same discipline: a crash mid-write must never leave a
  // half-written line masquerading as a real entry)
  // -------------------------------------------------------------------------

  private readHistoryRaw(): HistoryEntry[] {
    const path = this.historyPath();
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed) && typeof parsed.version === "number" && typeof parsed.docSha256 === "string" && typeof parsed.at === "number") {
          out.push({ version: parsed.version, docSha256: parsed.docSha256, at: parsed.at });
        }
      } catch {
        // A single corrupt line is skipped rather than aborting the whole
        // read — but never fabricated into something that looks valid.
      }
    }
    return out;
  }

  private writeHistoryRaw(entries: readonly HistoryEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
    this.atomicWrite(this.historyPath(), body);
  }

  private maxKnownVersion(): number {
    return this.readHistoryRaw().reduce((max, e) => Math.max(max, e.version), 0);
  }

  history(): Array<{ version: number; docSha256: string; at: number }> {
    return this.readHistoryRaw();
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  private recordAudit(status: PolicyLoadStatus, reason: string, action: "policy.load" | "policy.save"): void {
    if (!this.audit) return;
    try {
      this.audit.record({
        at: this.now(),
        actor: "policy-store",
        action,
        resource: this.dir,
        outcome: status === "ok" ? "info" : "deny",
        code: status,
        payload: { reason },
      });
    } catch {
      // An audit sink must never be able to break the store's fail-closed guarantee.
    }
  }

  // -------------------------------------------------------------------------
  // load — fail CLOSED on anything other than a fully-verified "ok"
  // -------------------------------------------------------------------------

  load(): PolicyLoadResult {
    const path = this.policyPath();

    if (!existsSync(path)) {
      const reason = `no policy file at "${path}"`;
      this.recordAudit("absent", reason, "policy.load");
      return { status: "absent", engine: PolicyEngine.denyAll(`policy store: absent policy — ${reason}`), reason };
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      const reason = `cannot read "${path}": ${errMsg(err)}`;
      this.recordAudit("malformed", reason, "policy.load");
      return { status: "malformed", engine: PolicyEngine.denyAll(`policy store: malformed policy — ${reason}`), reason };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = `"${path}" is not valid JSON: ${errMsg(err)}`;
      this.recordAudit("malformed", reason, "policy.load");
      return { status: "malformed", engine: PolicyEngine.denyAll(`policy store: malformed policy — ${reason}`), reason };
    }

    if (!isPlainObject(parsed) || !isPlainObject(parsed.doc)) {
      const reason = `"${path}" does not have the shape of a SignedPolicyBundle (missing or invalid "doc")`;
      this.recordAudit("malformed", reason, "policy.load");
      return { status: "malformed", engine: PolicyEngine.denyAll(`policy store: malformed policy — ${reason}`), reason };
    }

    const hasSignature = typeof parsed.signature === "string" && parsed.signature.length > 0;
    const hasSignerKey = typeof parsed.signerPublicKey === "string" && parsed.signerPublicKey.length > 0;
    if (!hasSignature || !hasSignerKey) {
      const reason = `"${path}" carries no signature — an unsigned policy bundle is refused outright`;
      this.recordAudit("unsigned", reason, "policy.load");
      return { status: "unsigned", engine: PolicyEngine.denyAll(`policy store: unsigned policy — ${reason}`), reason };
    }
    if (typeof parsed.docSha256 !== "string" || parsed.docSha256.length === 0) {
      const reason = `"${path}" is missing a "docSha256" field`;
      this.recordAudit("malformed", reason, "policy.load");
      return { status: "malformed", engine: PolicyEngine.denyAll(`policy store: malformed policy — ${reason}`), reason };
    }

    const signature = parsed.signature as string;
    const signerPublicKey = parsed.signerPublicKey as string;
    const docSha256 = parsed.docSha256 as string;
    const rawDoc = parsed.doc;

    const parsedDoc = parsePolicyDocument(rawDoc);
    if (!parsedDoc.ok) {
      const reason = `policy document at "${path}" failed schema validation: ${parsedDoc.errors.join("; ")}`;
      this.recordAudit("schema-mismatch", reason, "policy.load");
      return {
        status: "schema-mismatch",
        engine: PolicyEngine.denyAll(`policy store: schema-mismatch — ${reason}`),
        bundle: { doc: rawDoc as unknown as PolicyDocument, signature, signerPublicKey, docSha256 },
        reason,
      };
    }

    const bundle: SignedPolicyBundle = { doc: parsedDoc.doc, signature, signerPublicKey, docSha256 };

    // Sign over the DOC exactly as `save()` produced it — this is what
    // catches a single flipped byte anywhere in `doc` (the canonicalized
    // bytes change, so the signature no longer verifies).
    const canonical = govCanonicalize(bundle.doc);
    if (!verifyGovSignature(bundle.signerPublicKey, canonical, bundle.signature)) {
      const reason = `signature on "${path}" does not verify under signerPublicKey ${bundle.signerPublicKey} — the document does not match what was signed`;
      this.recordAudit("signature-invalid", reason, "policy.load");
      return { status: "signature-invalid", engine: PolicyEngine.denyAll(`policy store: signature-invalid — ${reason}`), bundle, reason };
    }

    if (!this.trustedSignerPublicKeys.has(bundle.signerPublicKey)) {
      const reason = `signer ${bundle.signerPublicKey} is not in the trusted signer set`;
      this.recordAudit("untrusted-signer", reason, "policy.load");
      return { status: "untrusted-signer", engine: PolicyEngine.denyAll(`policy store: untrusted-signer — ${reason}`), bundle, reason };
    }

    const knownMax = this.maxKnownVersion();
    if (bundle.doc.version < knownMax) {
      const reason = `policy version ${bundle.doc.version} is lower than the highest previously recorded version ${knownMax} — refusing a possible rollback/replay`;
      this.recordAudit("downgrade-refused", reason, "policy.load");
      return { status: "downgrade-refused", engine: PolicyEngine.denyAll(`policy store: downgrade-refused — ${reason}`), bundle, reason };
    }

    const reason = `policy "${bundle.doc.name}" v${bundle.doc.version} loaded and verified (signer ${bundle.signerPublicKey})`;
    this.recordAudit("ok", reason, "policy.load");
    const engine = PolicyEngine.compile(bundle.doc, { now: this.now, audit: this.audit });
    return { status: "ok", engine, bundle, reason };
  }

  // -------------------------------------------------------------------------
  // save — real ed25519 signature, anti-rollback enforced against history
  // -------------------------------------------------------------------------

  save(doc: PolicyDocument, identity: GovIdentity): SignedPolicyBundle {
    const parsedDoc = parsePolicyDocument(doc);
    if (!parsedDoc.ok) {
      throw new Error(`PolicyStore.save: refusing to save an invalid policy document: ${parsedDoc.errors.join("; ")}`);
    }

    mkdirSync(this.dir, { recursive: true });
    const release = this.acquireLock();
    try {
      const knownMax = this.maxKnownVersion();
      if (parsedDoc.doc.version <= knownMax) {
        throw new Error(
          `PolicyStore.save: refusing to save version ${parsedDoc.doc.version}; must be strictly greater than the persisted version ${knownMax} (anti-rollback)`,
        );
      }

      const canonical = govCanonicalize(parsedDoc.doc);
      const signature = identity.sign(canonical);
      const docSha256 = govDigest(parsedDoc.doc);
      const bundle: SignedPolicyBundle = {
        doc: parsedDoc.doc,
        signature,
        signerPublicKey: identity.publicKeyHex(),
        docSha256,
      };

      this.atomicWrite(this.policyPath(), JSON.stringify(bundle, null, 2));

      const history = this.readHistoryRaw();
      history.push({ version: parsedDoc.doc.version, docSha256, at: this.now() });
      this.writeHistoryRaw(history);

      this.recordAudit("ok", `policy "${parsedDoc.doc.name}" v${parsedDoc.doc.version} saved (signer ${bundle.signerPublicKey})`, "policy.save");
      return bundle;
    } finally {
      release();
    }
  }
}
