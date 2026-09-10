/**
 * Agent identity for the Hades governance stack — REAL ed25519 keypairs, a
 * self-signed identity document, an issuer -> delegate chain with hostile
 * path validation, and key rotation with a signed continuity record.
 *
 * This module is the ONE place the rest of the governance stack imports its
 * canonical-serialization and signing primitives from
 * (`govCanonicalize` / `govDigest` / `signGov` / `verifyGovSignature`), so
 * every governance document in the system signs exactly one canonical byte
 * string. It deliberately reuses the engine's own crypto primitives rather
 * than re-implementing them: `sha256Hex` and `generatePrivateKeyHex` come
 * from `../styx/certificate`, and ed25519 sign/verify go straight through
 * `@noble/ed25519` with its synchronous SHA-512 hook wired to `node:crypto`,
 * exactly as `certificate.ts` does. No home-rolled crypto anywhere in here.
 *
 * No ambient `Date.now()` inside any pure function in this module — every
 * timestamp is caller-provided (`issuedAt`, `now`, etc). The one place that
 * DOES read the system clock is `../gov/keystore.ts`'s injectable `now`
 * option, never this file.
 */

import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";

import { sha256Hex, generatePrivateKeyHex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// @noble/ed25519 v3 requires a SHA-512 implementation for its synchronous API
// (`ed.hashes.sha512`). Wire it to node:crypto once at module load — the
// exact same guard `certificate.ts` uses, so both modules share one wiring
// discipline and never race to set it twice with different implementations.
// ---------------------------------------------------------------------------
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (message: Uint8Array): Uint8Array<ArrayBuffer> =>
    new Uint8Array(createHash("sha512").update(message).digest());
}

// ---------------------------------------------------------------------------
// Hex helpers (strict — reject odd length / non-hex / wrong size rather than
// mis-decode; every caller that must never throw wraps these in try/catch).
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-fA-F]*$/;

function hexToBytes(hex: string, expectedBytes?: number): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new TypeError("invalid hex string");
  }
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) {
    throw new RangeError(`expected ${expectedBytes} bytes of hex, got ${hex.length / 2}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization for governance documents.
 *
 *  - Object keys are sorted lexicographically at EVERY depth.
 *  - Array element order is preserved (order is semantic for arrays).
 *  - `undefined`, functions, symbols, and `bigint` are REJECTED with a
 *    thrown `TypeError` naming the exact path (e.g. `$.roles[2]`) — they are
 *    silently droppable in plain `JSON.stringify`, which would let two
 *    logically different documents canonicalize to the same bytes (or the
 *    same document canonicalize differently across engines). This module
 *    signs bytes; anything that cannot be represented losslessly must fail
 *    loudly, not vanish.
 *  - `NaN` and `Infinity`/`-Infinity` are rejected for the same reason:
 *    `JSON.stringify` silently turns them into `null`.
 *  - Circular references are rejected rather than looping forever.
 *  - A `"__proto__"` own key anywhere is rejected: an attacker-controlled
 *    payload run through `JSON.parse` can carry `"__proto__"` as an
 *    ordinary own-enumerable string key (JSON.parse does not special-case
 *    it), and silently canonicalizing it would let a governance document
 *    smuggle a prototype-pollution payload through this module's own
 *    serializer.
 *
 * Two structurally equal values ALWAYS canonicalize to identical bytes
 * regardless of original key insertion order; two structurally different
 * values never collide.
 */
export function govCanonicalize(value: unknown): string {
  return walkCanonical(value, "$", new Set<unknown>());
}

function walkCanonical(value: unknown, path: string, seen: Set<unknown>): string {
  if (value === null) return "null";
  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`govCanonicalize: non-finite number (${String(value)}) at ${path}`);
    }
    return JSON.stringify(value);
  }

  if (t === "string") return JSON.stringify(value);

  if (t === "undefined") {
    throw new TypeError(`govCanonicalize: undefined value at ${path}`);
  }
  if (t === "function") {
    throw new TypeError(`govCanonicalize: function value at ${path}`);
  }
  if (t === "symbol") {
    throw new TypeError(`govCanonicalize: symbol value at ${path}`);
  }
  if (t === "bigint") {
    throw new TypeError(`govCanonicalize: bigint value at ${path} is not representable`);
  }

  // t === "object" from here on.
  if (seen.has(value)) {
    throw new TypeError(`govCanonicalize: circular reference at ${path}`);
  }

  if (Array.isArray(value)) {
    seen.add(value);
    const parts = value.map((el, i) => walkCanonical(el, `${path}[${i}]`, seen));
    seen.delete(value);
    return "[" + parts.join(",") + "]";
  }

  // A plain object (or object-shaped value, e.g. one from JSON.parse).
  seen.add(value);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (k === "__proto__") {
      throw new TypeError(`govCanonicalize: forbidden key "__proto__" at ${path} (prototype pollution guard)`);
    }
  }
  const sorted = [...keys].sort();
  const parts = sorted.map((k) => JSON.stringify(k) + ":" + walkCanonical(obj[k], `${path}.${k}`, seen));
  seen.delete(value);
  return "{" + parts.join(",") + "}";
}

/** `sha256Hex(govCanonicalize(value))` — the content-address of a governance value. */
export function govDigest(value: unknown): string {
  return sha256Hex(govCanonicalize(value));
}

// ---------------------------------------------------------------------------
// Raw sign / verify
// ---------------------------------------------------------------------------

/** Sign the UTF-8 bytes of an already-canonicalized string. Throws on a malformed key. */
export function signGov(privateKeyHex: string, canonical: string): string {
  const seed = hexToBytes(privateKeyHex, 32);
  const signature = ed.sign(utf8Bytes(canonical), seed);
  return bytesToHex(signature);
}

/**
 * Verify a hex signature over an already-canonicalized string. Returns
 * `false` on ANY problem — malformed hex, wrong lengths, a signature from a
 * different key, a tampered message, or a non-canonical/malleable
 * signature (`zip215: false` enforces RFC 8032's strict scalar/point
 * canonicality rather than the permissive ZIP-215 batch-verification
 * semantics) — and NEVER throws.
 */
export function verifyGovSignature(publicKeyHex: string, canonical: string, signatureHex: string): boolean {
  try {
    const publicKey = hexToBytes(publicKeyHex, 32);
    const signature = hexToBytes(signatureHex, 64);
    const message = utf8Bytes(canonical);
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

/** `"agent:" + sha256Hex(publicKeyHex).slice(0, 32)` — pure string hash, never throws. */
export function agentIdFromPublicKey(publicKeyHex: string): string {
  return "agent:" + sha256Hex(publicKeyHex).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Identity documents
// ---------------------------------------------------------------------------

export interface AgentIdentityDoc {
  schema: "hades.gov.identity.v1";
  agentId: string;
  publicKey: string;
  displayName?: string;
  roles: string[];
  issuer: string;
  issuedAt: number;
  notBefore: number;
  notAfter?: number;
  parentPublicKey?: string;
}

export interface SignedIdentityDoc {
  doc: AgentIdentityDoc;
  signature: string;
  signerPublicKey: string;
}

/** Runtime structural check for a value claiming to be a `SignedIdentityDoc` — never throws. */
export function isSignedIdentityDocShape(v: unknown): v is SignedIdentityDoc {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.signature !== "string" || typeof o.signerPublicKey !== "string") return false;
  const d = o.doc;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return false;
  const doc = d as Record<string, unknown>;
  // Schema VALUE is deliberately not checked here — a wrong schema string
  // is a well-formed-but-wrong document, and callers (verifyIdentityChain)
  // must be able to distinguish that ("schema-mismatch") from a
  // structurally broken one ("malformed"). Only the TYPE is checked.
  if (typeof doc.schema !== "string") return false;
  if (typeof doc.agentId !== "string" || typeof doc.publicKey !== "string") return false;
  if (!Array.isArray(doc.roles) || !doc.roles.every((r) => typeof r === "string")) return false;
  if (typeof doc.issuer !== "string") return false;
  if (typeof doc.issuedAt !== "number" || !Number.isFinite(doc.issuedAt)) return false;
  if (typeof doc.notBefore !== "number" || !Number.isFinite(doc.notBefore)) return false;
  if (doc.notAfter !== undefined && (typeof doc.notAfter !== "number" || !Number.isFinite(doc.notAfter))) return false;
  if (doc.parentPublicKey !== undefined && typeof doc.parentPublicKey !== "string") return false;
  if (doc.displayName !== undefined && typeof doc.displayName !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// GovIdentity — a live ed25519 keypair that can issue and delegate documents
// ---------------------------------------------------------------------------

export class GovIdentity {
  private readonly seed: Uint8Array;
  private readonly pubHex: string;

  private constructor(seedHex: string) {
    this.seed = hexToBytes(seedHex, 32);
    this.pubHex = bytesToHex(ed.getPublicKey(this.seed));
  }

  /** Generate a fresh identity. `rng` defaults to `node:crypto` randomness (see `generatePrivateKeyHex`). */
  static generate(rng?: (n: number) => Uint8Array): GovIdentity {
    return new GovIdentity(generatePrivateKeyHex(rng));
  }

  /** Reconstitute an identity from a 32-byte hex seed. Throws on malformed hex. */
  static fromPrivateKey(hex: string): GovIdentity {
    return new GovIdentity(hex);
  }

  /** The 32-byte private key seed, normalized to lowercase hex. */
  privateKeyHex(): string {
    return bytesToHex(this.seed);
  }

  /** The 32-byte ed25519 public key, lowercase hex. */
  publicKeyHex(): string {
    return this.pubHex;
  }

  agentId(): string {
    return agentIdFromPublicKey(this.pubHex);
  }

  /** Sign an already-canonicalized string. */
  sign(canonical: string): string {
    const signature = ed.sign(utf8Bytes(canonical), this.seed);
    return bytesToHex(signature);
  }

  /** Canonicalize then sign an arbitrary governance value in one step. */
  signValue(value: unknown): string {
    return this.sign(govCanonicalize(value));
  }

  /**
   * Issue a SELF-SIGNED root identity document: `issuer === agentId`,
   * `publicKey === this.publicKeyHex()`, no `parentPublicKey`.
   */
  issueSelf(input: { roles: string[]; displayName?: string; issuedAt: number; notBefore?: number; notAfter?: number }): SignedIdentityDoc {
    const agentId = this.agentId();
    const doc: AgentIdentityDoc = {
      schema: "hades.gov.identity.v1",
      agentId,
      publicKey: this.pubHex,
      roles: [...input.roles],
      issuer: agentId,
      issuedAt: input.issuedAt,
      notBefore: input.notBefore ?? input.issuedAt,
      ...(input.notAfter !== undefined ? { notAfter: input.notAfter } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    };
    return {
      doc,
      signature: this.signValue(doc),
      signerPublicKey: this.pubHex,
    };
  }

  /**
   * Delegate a role set to a child key. THIS identity is the issuer and
   * signs the child's document with its OWN key (`signerPublicKey` is the
   * PARENT's public key) — the child never signs its own delegate doc.
   */
  delegate(input: { childPublicKey: string; roles: string[]; issuedAt: number; notBefore?: number; notAfter?: number }): SignedIdentityDoc {
    const doc: AgentIdentityDoc = {
      schema: "hades.gov.identity.v1",
      agentId: agentIdFromPublicKey(input.childPublicKey),
      publicKey: input.childPublicKey,
      roles: [...input.roles],
      issuer: this.agentId(),
      issuedAt: input.issuedAt,
      notBefore: input.notBefore ?? input.issuedAt,
      ...(input.notAfter !== undefined ? { notAfter: input.notAfter } : {}),
      parentPublicKey: this.pubHex,
    };
    return {
      doc,
      signature: this.signValue(doc),
      signerPublicKey: this.pubHex,
    };
  }
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export type IdentityFailureCode =
  | "malformed"
  | "signature-invalid"
  | "unknown-root"
  | "expired"
  | "not-yet-valid"
  | "revoked"
  | "depth-exceeded"
  | "broken-link"
  | "self-signed-non-root"
  | "role-escalation"
  | "agent-id-mismatch"
  | "schema-mismatch";

export interface IdentityFailure {
  code: IdentityFailureCode;
  at: number;
  detail: string;
}

export interface IdentityChainVerification {
  ok: boolean;
  agentId?: string;
  publicKey?: string;
  effectiveRoles: string[];
  depth: number;
  failures: IdentityFailure[];
}

const DEFAULT_MAX_DEPTH = 16;

/**
 * Validate an issuer -> delegate identity chain against a trust root,
 * hostilely: an attacker-controlled re-signature, a role escalation, a
 * loop back to an earlier key, a depth overrun, an expired or not-yet-valid
 * intermediate, or a revoked key anywhere in the path all fail with the
 * SPECIFIC {@link IdentityFailureCode} that names the problem — never a
 * generic "invalid" and never a silent pass.
 *
 * `chain[0]` must be the self-signed root and its `publicKey` must equal
 * `opts.trustRootPublicKey` (an untrusted root fails fast with
 * `"unknown-root"` before anything downstream is even inspected — an
 * untrusted CA invalidates the whole chain, not just itself). Each
 * subsequent document must be signed by the PREVIOUS document's public key,
 * and its `roles` must be a subset of the parent's effective roles — a
 * delegate that widens its own roles fails `"role-escalation"`, never a
 * warning.
 */
export function verifyIdentityChain(
  chain: readonly SignedIdentityDoc[],
  opts: { trustRootPublicKey: string; now: number; revokedPublicKeys?: ReadonlySet<string>; maxDepth?: number },
): IdentityChainVerification {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const revoked = opts.revokedPublicKeys ?? new Set<string>();

  if (!Array.isArray(chain) || chain.length === 0) {
    return {
      ok: false,
      effectiveRoles: [],
      depth: 0,
      failures: [{ code: "malformed", at: opts.now, detail: "identity chain is empty" }],
    };
  }

  const failures: IdentityFailure[] = [];
  let effectiveRoles: string[] = [];
  let lastAgentId: string | undefined;
  let lastPublicKey: string | undefined;
  let depth = 0;
  const seenKeys = new Set<string>();

  const fail = (code: IdentityFailureCode, detail: string): IdentityChainVerification => {
    failures.push({ code, at: opts.now, detail });
    return { ok: false, agentId: lastAgentId, publicKey: lastPublicKey, effectiveRoles, depth, failures };
  };

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    if (!isSignedIdentityDocShape(entry)) {
      return fail("malformed", `chain[${i}] is not a well-formed SignedIdentityDoc`);
    }
    const { doc, signature, signerPublicKey } = entry;

    if (doc.schema !== "hades.gov.identity.v1") {
      return fail("schema-mismatch", `chain[${i}].doc.schema is "${String((doc as { schema?: unknown }).schema)}", expected "hades.gov.identity.v1"`);
    }
    if (doc.agentId !== agentIdFromPublicKey(doc.publicKey)) {
      return fail("agent-id-mismatch", `chain[${i}].doc.agentId does not equal agentIdFromPublicKey(chain[${i}].doc.publicKey)`);
    }

    if (i === 0) {
      if (doc.publicKey !== opts.trustRootPublicKey) {
        failures.push({ code: "unknown-root", at: opts.now, detail: "chain[0].doc.publicKey does not match opts.trustRootPublicKey" });
        return { ok: false, effectiveRoles: [], depth: 0, failures };
      }
      if (signerPublicKey !== doc.publicKey || doc.issuer !== doc.agentId || doc.parentPublicKey !== undefined) {
        return fail("malformed", "chain[0] must be self-signed (signerPublicKey === publicKey, issuer === agentId, no parentPublicKey)");
      }
    } else {
      if (i > maxDepth) {
        return fail("depth-exceeded", `chain depth ${i} exceeds maxDepth ${maxDepth}`);
      }
      if (signerPublicKey === doc.publicKey) {
        return fail("self-signed-non-root", `chain[${i}] is self-signed but is not the chain root — a delegate may never self-issue`);
      }
      if (signerPublicKey !== lastPublicKey || doc.parentPublicKey !== lastPublicKey || doc.issuer !== lastAgentId) {
        return fail("broken-link", `chain[${i}] is not correctly linked to chain[${i - 1}] (signerPublicKey/parentPublicKey/issuer must match the previous document)`);
      }
      if (seenKeys.has(doc.publicKey)) {
        return fail("broken-link", `chain[${i}].doc.publicKey reuses a key already present earlier in the chain (loop)`);
      }
    }

    const canonical = govCanonicalize(doc);
    if (!verifyGovSignature(signerPublicKey, canonical, signature)) {
      return fail("signature-invalid", `chain[${i}] signature does not verify under signerPublicKey`);
    }

    if (revoked.has(doc.publicKey) || revoked.has(signerPublicKey)) {
      return fail("revoked", `chain[${i}] involves a revoked public key`);
    }

    if (opts.now < doc.notBefore) {
      return fail("not-yet-valid", `chain[${i}] is not valid until ${doc.notBefore}, now is ${opts.now}`);
    }
    if (doc.notAfter !== undefined && opts.now > doc.notAfter) {
      return fail("expired", `chain[${i}] expired at ${doc.notAfter}, now is ${opts.now}`);
    }

    if (i > 0) {
      const parentRoles = new Set(effectiveRoles);
      for (const r of doc.roles) {
        if (!parentRoles.has(r)) {
          return fail("role-escalation", `chain[${i}] claims role "${r}" which its issuer (chain[${i - 1}]) does not hold`);
        }
      }
    }

    seenKeys.add(doc.publicKey);
    effectiveRoles = [...doc.roles];
    lastAgentId = doc.agentId;
    lastPublicKey = doc.publicKey;
    depth = i;
  }

  return { ok: true, agentId: lastAgentId, publicKey: lastPublicKey, effectiveRoles, depth, failures: [] };
}

// ---------------------------------------------------------------------------
// Key rotation — signed continuity records
// ---------------------------------------------------------------------------

export interface RotationRecord {
  schema: "hades.gov.rotation.v1";
  oldPublicKey: string;
  newPublicKey: string;
  at: number;
  reason: string;
  sequence: number;
}

export interface SignedRotationRecord {
  record: RotationRecord;
  /** Proof the OLD key authorized handing off to the new one. */
  oldKeySignature: string;
  /** Proof the NEW key exists and possesses its own private key. */
  newKeySignature: string;
}

/** Runtime structural check for a value claiming to be a `SignedRotationRecord` — never throws. */
export function isSignedRotationRecordShape(v: unknown): v is SignedRotationRecord {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.oldKeySignature !== "string" || typeof o.newKeySignature !== "string") return false;
  const r = o.record;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
  const rec = r as Record<string, unknown>;
  if (rec.schema !== "hades.gov.rotation.v1") return false;
  if (typeof rec.oldPublicKey !== "string" || typeof rec.newPublicKey !== "string") return false;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return false;
  if (typeof rec.reason !== "string") return false;
  if (typeof rec.sequence !== "number" || !Number.isInteger(rec.sequence) || rec.sequence < 0) return false;
  return true;
}

/**
 * Sign a rotation record with BOTH the old and the new key — the old key's
 * signature is proof of continuity (the outgoing identity authorized the
 * handoff), the new key's signature is proof of possession (the incoming
 * identity is not just a named public key but a key someone actually
 * controls the private half of).
 */
export function signRotation(
  oldKey: GovIdentity,
  newKey: GovIdentity,
  input: Omit<RotationRecord, "oldPublicKey" | "newPublicKey">,
): SignedRotationRecord {
  const record: RotationRecord = {
    ...input,
    oldPublicKey: oldKey.publicKeyHex(),
    newPublicKey: newKey.publicKeyHex(),
  };
  const canonical = govCanonicalize(record);
  return {
    record,
    oldKeySignature: oldKey.sign(canonical),
    newKeySignature: newKey.sign(canonical),
  };
}

/**
 * Verify a rotation history as a proof of continuity from `genesisPublicKey`
 * to whatever key is current: sequence must be dense starting at 0, each
 * record's `oldPublicKey` must equal the PRIOR record's `newPublicKey` (or
 * the genesis key for record 0), and BOTH signatures must verify. A record
 * signed by only one of the two keys, a spliced record that skips a
 * generation, or a reordered history all fail.
 */
export function verifyRotationHistory(
  records: readonly SignedRotationRecord[],
  opts: { genesisPublicKey: string },
): { ok: boolean; currentPublicKey: string; failures: IdentityFailure[] } {
  const failures: IdentityFailure[] = [];
  let current = opts.genesisPublicKey;

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: true, currentPublicKey: current, failures: [] };
  }

  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (!isSignedRotationRecordShape(entry)) {
      failures.push({ code: "malformed", at: 0, detail: `rotations[${i}] is not a well-formed SignedRotationRecord` });
      return { ok: false, currentPublicKey: current, failures };
    }
    const { record, oldKeySignature, newKeySignature } = entry;

    if (record.sequence !== i) {
      failures.push({ code: "broken-link", at: record.at, detail: `rotations[${i}].record.sequence is ${record.sequence}, expected dense sequence value ${i}` });
      return { ok: false, currentPublicKey: current, failures };
    }
    if (record.oldPublicKey !== current) {
      failures.push({ code: "broken-link", at: record.at, detail: `rotations[${i}].record.oldPublicKey does not equal the key the history was at before this record (skipped or reordered generation)` });
      return { ok: false, currentPublicKey: current, failures };
    }

    const canonical = govCanonicalize(record);
    if (!verifyGovSignature(record.oldPublicKey, canonical, oldKeySignature)) {
      failures.push({ code: "signature-invalid", at: record.at, detail: `rotations[${i}].oldKeySignature does not verify under record.oldPublicKey` });
      return { ok: false, currentPublicKey: current, failures };
    }
    if (!verifyGovSignature(record.newPublicKey, canonical, newKeySignature)) {
      failures.push({ code: "signature-invalid", at: record.at, detail: `rotations[${i}].newKeySignature does not verify under record.newPublicKey` });
      return { ok: false, currentPublicKey: current, failures };
    }

    current = record.newPublicKey;
  }

  return { ok: true, currentPublicKey: current, failures: [] };
}
