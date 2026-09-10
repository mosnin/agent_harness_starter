/**
 * The durable, sealed keystore for one agent's governance identity.
 *
 * This is the ONE place an agent's ed25519 private key touches disk. Its
 * entire reason to exist is a single discipline: **never silently change
 * who the agent is**. Concretely that means:
 *
 *  - `HADES_GOV_KEY` (a 64-hex ed25519 seed) always wins over whatever is on
 *    disk, and a MALFORMED env key is a hard throw, never a silent fallback
 *    to a freshly minted (different!) identity — signing under an identity
 *    the operator did not ask for is worse than refusing to sign at all.
 *  - A persisted `identity.json` whose stored self-signature does not
 *    verify under its own stored key is a hard throw, never "heal" it by
 *    minting a new identity — that would be indistinguishable, from the
 *    outside, from an attacker quietly swapping the agent's identity.
 *  - Every write (`identity.json`, `rotations.json`, `revoked.json`) is
 *    tmp-file + `fsync` + `renameSync`, so a crash mid-write leaves either
 *    the old complete file or the new complete file, never a half-written
 *    one masquerading as state.
 *  - The private-key file is `chmod 0o600` best-effort; failure to do so on
 *    a platform without POSIX permissions is REPORTED via
 *    {@link GovKeystore.permissionWarning}, never silently assumed to have
 *    succeeded.
 *
 * No network I/O. No ambient `Date.now()` inside any pure function — the
 * only clock read here is the injectable `KeystoreOptions.now`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  GovIdentity,
  agentIdFromPublicKey,
  govCanonicalize,
  isSignedIdentityDocShape,
  isSignedRotationRecordShape,
  signRotation,
  verifyGovSignature,
  verifyRotationHistory,
  type SignedIdentityDoc,
  type SignedRotationRecord,
} from "./identity";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Every governance-identity artifact for an agent lives under `<dataDir>/gov`. */
export const GOV_DIR = "gov";

export function govRoot(dataDir: string): string {
  return join(dataDir, GOV_DIR);
}

const IDENTITY_FILE = "identity.json";
const ROTATIONS_FILE = "rotations.json";
const REVOKED_FILE = "revoked.json";
const LOCK_DIR = ".lock";

const IDENTITY_SCHEMA = "hades.gov.keystore.v1" as const;
const REVOKED_SCHEMA = "hades.gov.revoked.v1" as const;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Real wall-clock sleep for the lock backoff loop (never the injectable
// business clock — a caller who fast-forwards `now` must not also warp how
// long a lock wait actually takes).
// ---------------------------------------------------------------------------

const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fsyncPath(p: string): void {
  const fd = openSync(p, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Opening a directory for fsync is not supported on every platform;
    // this is best-effort durability, not correctness-critical.
  }
}

// ---------------------------------------------------------------------------
// Persisted file shapes
// ---------------------------------------------------------------------------

interface PersistedIdentityFile {
  schema: typeof IDENTITY_SCHEMA;
  privateKey: string;
  doc: SignedIdentityDoc;
}

interface RevokedEntry {
  publicKey: string;
  reason: string;
  at: number;
}

interface PersistedRevokedFile {
  schema: typeof REVOKED_SCHEMA;
  entries: RevokedEntry[];
}

function isPersistedIdentityFile(v: unknown): v is PersistedIdentityFile {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schema !== IDENTITY_SCHEMA) return false;
  if (typeof o.privateKey !== "string") return false;
  return isSignedIdentityDocShape(o.doc);
}

function isPersistedRevokedFile(v: unknown): v is PersistedRevokedFile {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schema !== REVOKED_SCHEMA) return false;
  if (!Array.isArray(o.entries)) return false;
  return o.entries.every(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as RevokedEntry).publicKey === "string" &&
      typeof (e as RevokedEntry).reason === "string" &&
      typeof (e as RevokedEntry).at === "number" &&
      Number.isFinite((e as RevokedEntry).at),
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KeystoreOptions {
  dir: string;
  now?: () => number;
  rng?: (n: number) => Uint8Array;
  env?: NodeJS.ProcessEnv;
}

export type IdentitySource = "env" | "persisted" | "generated";

export interface LoadedIdentity {
  identity: GovIdentity;
  source: IdentitySource;
  doc: SignedIdentityDoc;
  rotations: SignedRotationRecord[];
}

// ---------------------------------------------------------------------------
// GovKeystore
// ---------------------------------------------------------------------------

/**
 * The durable keystore. One instance per `dir`; `dir` is the directory
 * itself (callers pick it, typically via `govRoot(dataDir)`), never
 * `dataDir` directly.
 */
export class GovKeystore {
  private readonly dir: string;
  private readonly nowFn: () => number;
  private readonly rngFn: ((n: number) => Uint8Array) | undefined;
  private readonly env: NodeJS.ProcessEnv;

  private loaded: LoadedIdentity | null = null;
  private lastPermissionWarning: string | null = null;

  private constructor(dir: string, nowFn: () => number, rngFn: ((n: number) => Uint8Array) | undefined, env: NodeJS.ProcessEnv) {
    this.dir = dir;
    this.nowFn = nowFn;
    this.rngFn = rngFn;
    this.env = env;
  }

  static open(opts: KeystoreOptions): GovKeystore {
    if (!opts || typeof opts.dir !== "string" || opts.dir.length === 0) {
      throw new RangeError("KeystoreOptions.dir must be a non-empty path");
    }
    return new GovKeystore(opts.dir, opts.now ?? (() => Date.now()), opts.rng, opts.env ?? process.env);
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private identityPath(): string {
    return join(this.dir, IDENTITY_FILE);
  }
  private rotationsPath(): string {
    return join(this.dir, ROTATIONS_FILE);
  }
  private revokedPath(): string {
    return join(this.dir, REVOKED_FILE);
  }
  private lockPath(): string {
    return join(this.dir, LOCK_DIR);
  }

  /**
   * Non-null when the most recent attempt to `chmod 0o600` the private-key
   * file failed. Best-effort durability of the permission bit is not
   * silently assumed — a caller that cares checks this after `load()` or
   * `rotate()`.
   */
  permissionWarning(): string | null {
    return this.lastPermissionWarning;
  }

  // -------------------------------------------------------------------------
  // Locking — a directory-mkdir mutex around every write-bearing critical
  // section, so two `GovKeystore` instances against the same `dir` cannot
  // interleave a generate-then-write and corrupt `identity.json`.
  // -------------------------------------------------------------------------

  private acquireLock(): () => void {
    const lockDir = this.lockPath();
    const timeoutMs = 5000;
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        mkdirSync(lockDir);
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
          throw new Error(`gov keystore: timed out acquiring lock at "${lockDir}" after ${timeoutMs}ms`);
        }
        attempt += 1;
        sleepSyncMs(Math.min(50 * attempt, 250));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Atomic write helper
  // -------------------------------------------------------------------------

  private atomicWrite(path: string, body: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w", mode ?? 0o644);
    try {
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDir(dirname(path));
  }

  // -------------------------------------------------------------------------
  // Identity file read/write
  // -------------------------------------------------------------------------

  private writeIdentity(identity: GovIdentity, doc: SignedIdentityDoc): void {
    const payload: PersistedIdentityFile = {
      schema: IDENTITY_SCHEMA,
      privateKey: identity.privateKeyHex(),
      doc,
    };
    const path = this.identityPath();
    this.atomicWrite(path, JSON.stringify(payload, null, 2), 0o600);
    try {
      chmodSync(path, 0o600);
      this.lastPermissionWarning = null;
    } catch (err) {
      this.lastPermissionWarning = `failed to chmod 0o600 "${path}": ${errMsg(err)}`;
    }
  }

  /**
   * Read and STRICTLY validate `identity.json`. Any problem — unreadable
   * file, invalid JSON, wrong shape, a private key that doesn't produce the
   * stored public key, or a doc signature that doesn't verify under its own
   * stored key — is a hard throw. This function NEVER falls through to
   * minting a fresh identity: that is precisely the silent-identity-swap
   * failure mode this module exists to prevent.
   */
  private readPersistedIdentity(path: string): { identity: GovIdentity; doc: SignedIdentityDoc } {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`gov keystore: cannot read "${path}": ${errMsg(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `gov keystore: "${path}" is corrupt (invalid JSON) — refusing to regenerate a new identity silently: ${errMsg(err)}`,
      );
    }
    if (!isPersistedIdentityFile(parsed)) {
      throw new Error(`gov keystore: "${path}" has an unrecognized shape — refusing to regenerate a new identity silently`);
    }

    let identity: GovIdentity;
    try {
      identity = GovIdentity.fromPrivateKey(parsed.privateKey);
    } catch (err) {
      throw new Error(`gov keystore: "${path}" contains an invalid private key: ${errMsg(err)}`);
    }

    const signed = parsed.doc;
    if (signed.doc.publicKey !== identity.publicKeyHex() || signed.signerPublicKey !== identity.publicKeyHex()) {
      throw new Error(`gov keystore: "${path}" doc.publicKey / signerPublicKey does not match its own stored private key`);
    }
    const canonical = govCanonicalize(signed.doc);
    if (!verifyGovSignature(signed.signerPublicKey, canonical, signed.signature)) {
      throw new Error(
        `gov keystore: "${path}" identity document signature does not verify under its own stored key — refusing to regenerate a new identity silently`,
      );
    }

    return { identity, doc: signed };
  }

  /**
   * Best-effort read used ONLY on the `HADES_GOV_KEY` path: if a persisted
   * `identity.json` happens to already match the env-supplied public key,
   * its doc is reused (stable `issuedAt` across restarts); any other state
   * on disk — missing, unrelated, or even corrupt — is simply ignored,
   * since an env override does not depend on disk and must not be blocked
   * by disk state it does not own.
   */
  private tryReadMatchingDoc(publicKeyHex: string): SignedIdentityDoc | null {
    const path = this.identityPath();
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedIdentityFile(parsed)) return null;
      if (parsed.doc.doc.publicKey !== publicKeyHex || parsed.doc.signerPublicKey !== publicKeyHex) return null;
      const canonical = govCanonicalize(parsed.doc.doc);
      if (!verifyGovSignature(parsed.doc.signerPublicKey, canonical, parsed.doc.signature)) return null;
      return parsed.doc;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Rotations file read/write
  // -------------------------------------------------------------------------

  private readRotations(): SignedRotationRecord[] {
    const path = this.rotationsPath();
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`gov keystore: cannot read "${path}": ${errMsg(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`gov keystore: "${path}" is corrupt (invalid JSON): ${errMsg(err)}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isSignedRotationRecordShape)) {
      throw new Error(`gov keystore: "${path}" has an unrecognized shape (expected an array of SignedRotationRecord)`);
    }
    return parsed;
  }

  private writeRotations(records: readonly SignedRotationRecord[]): void {
    this.atomicWrite(this.rotationsPath(), JSON.stringify(records, null, 2));
  }

  // -------------------------------------------------------------------------
  // Revoked file read/write
  // -------------------------------------------------------------------------

  private readRevokedEntries(): RevokedEntry[] {
    const path = this.revokedPath();
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`gov keystore: cannot read "${path}": ${errMsg(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`gov keystore: "${path}" is corrupt (invalid JSON): ${errMsg(err)}`);
    }
    if (!isPersistedRevokedFile(parsed)) {
      throw new Error(`gov keystore: "${path}" has an unrecognized shape`);
    }
    return parsed.entries;
  }

  private writeRevokedEntries(entries: readonly RevokedEntry[]): void {
    const payload: PersistedRevokedFile = { schema: REVOKED_SCHEMA, entries: [...entries] };
    this.atomicWrite(this.revokedPath(), JSON.stringify(payload, null, 2));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve this agent's identity: `HADES_GOV_KEY` env (if set) wins over
   * disk and never touches disk; otherwise a persisted `identity.json` is
   * loaded (and strictly validated); otherwise a fresh identity is
   * generated, self-issued with an empty role set, and durably persisted.
   */
  load(): LoadedIdentity {
    const envKey = (this.env.HADES_GOV_KEY ?? "").trim();
    if (envKey.length > 0) {
      if (!HEX64_RE.test(envKey)) {
        throw new RangeError(
          "HADES_GOV_KEY must be a 64-character hex ed25519 seed; refusing to sign under a different agent identity.",
        );
      }
      const identity = GovIdentity.fromPrivateKey(envKey);
      const rotations = this.readRotationsSafe();
      const doc = this.tryReadMatchingDoc(identity.publicKeyHex()) ?? identity.issueSelf({ roles: [], issuedAt: this.nowFn() });
      this.loaded = { identity, source: "env", doc, rotations };
      return this.loaded;
    }

    mkdirSync(this.dir, { recursive: true });
    const release = this.acquireLock();
    try {
      const path = this.identityPath();
      if (existsSync(path)) {
        const { identity, doc } = this.readPersistedIdentity(path);
        const rotations = this.readRotations();
        this.loaded = { identity, source: "persisted", doc, rotations };
        return this.loaded;
      }
      const identity = GovIdentity.generate(this.rngFn);
      const doc = identity.issueSelf({ roles: [], issuedAt: this.nowFn() });
      this.writeIdentity(identity, doc);
      this.loaded = { identity, source: "generated", doc, rotations: [] };
      return this.loaded;
    } finally {
      release();
    }
  }

  /**
   * `readRotations()` used from the env-key path: rotation history is not
   * owned by which key wins for THIS session, so a corrupt rotations file
   * still throws (it is real durable state), but a MISSING one is simply
   * empty — identical behaviour to the persisted path, factored out only
   * because the env branch does not take the directory lock.
   */
  private readRotationsSafe(): SignedRotationRecord[] {
    return this.readRotations();
  }

  /**
   * Generate a new identity, sign a {@link SignedRotationRecord} proving
   * continuity from the CURRENT identity (whichever `load()` last
   * established — `env`, `persisted`, or `generated`), persist the new
   * identity and the appended rotation history, and return the new
   * `LoadedIdentity` (source `"generated"`).
   */
  rotate(reason: string): LoadedIdentity {
    const current = this.loaded ?? this.load();
    mkdirSync(this.dir, { recursive: true });
    const release = this.acquireLock();
    try {
      const genesisPublicKey = current.rotations.length > 0 ? current.rotations[0].record.oldPublicKey : current.identity.publicKeyHex();

      const newIdentity = GovIdentity.generate(this.rngFn);
      const signedRotation = signRotation(current.identity, newIdentity, {
        schema: "hades.gov.rotation.v1",
        at: this.nowFn(),
        reason,
        sequence: current.rotations.length,
      });
      const rotations = [...current.rotations, signedRotation];

      // Defense in depth: the history we are about to persist must itself
      // verify as a continuous chain from genesis to the new key before we
      // ever write it — a bug here must fail loudly, not persist garbage.
      const verification = verifyRotationHistory(rotations, { genesisPublicKey });
      if (!verification.ok || verification.currentPublicKey !== newIdentity.publicKeyHex()) {
        throw new Error(
          `gov keystore: internal error — freshly constructed rotation history failed self-verification: ${JSON.stringify(verification.failures)}`,
        );
      }

      const newDoc = newIdentity.issueSelf({ roles: [...current.doc.doc.roles], issuedAt: this.nowFn() });
      this.writeIdentity(newIdentity, newDoc);
      this.writeRotations(rotations);

      this.loaded = { identity: newIdentity, source: "generated", doc: newDoc, rotations };
      return this.loaded;
    } finally {
      release();
    }
  }

  /** Add a public key to the durable revocation list (idempotent). */
  revoke(publicKeyHex: string, reason: string): void {
    if (!HEX64_RE.test(publicKeyHex)) {
      throw new RangeError(`gov keystore revoke: "${publicKeyHex}" is not a 32-byte hex ed25519 public key`);
    }
    mkdirSync(this.dir, { recursive: true });
    const release = this.acquireLock();
    try {
      const entries = this.readRevokedEntries();
      if (entries.some((e) => e.publicKey === publicKeyHex)) return;
      entries.push({ publicKey: publicKeyHex, reason, at: this.nowFn() });
      this.writeRevokedEntries(entries);
    } finally {
      release();
    }
  }

  /** The current durable set of revoked public keys, read fresh from disk. */
  revoked(): ReadonlySet<string> {
    if (!existsSync(this.revokedPath())) return new Set();
    return new Set(this.readRevokedEntries().map((e) => e.publicKey));
  }

  /** A minimal, non-secret summary safe to print or ship over IPC. */
  publicRecord(): { agentId: string; publicKey: string; rotations: number } {
    const current = this.loaded ?? this.load();
    return {
      agentId: current.identity.agentId(),
      publicKey: current.identity.publicKeyHex(),
      rotations: current.rotations.length,
    };
  }
}

// Re-exported so a caller that only imports from `./keystore` can still
// resolve an agent's public identifier from a bare public key without a
// second import from `./identity`.
export { agentIdFromPublicKey };
