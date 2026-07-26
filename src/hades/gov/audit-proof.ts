/**
 * Merkle proofs for the governance audit chain — RFC 6962-style ("Certificate
 * Transparency") domain-separated hashing, so a leaf hash can never be
 * replayed as an interior node hash (and vice versa): second-preimage
 * resistance across the tree shape, not just within a single hash chain.
 *
 * This module is deliberately storage-agnostic and crypto-minimal: it takes
 * an ordered list of leaf digests (the per-entry `entrySha256` values from
 * `audit-chain.ts`) and produces/verifies inclusion and consistency proofs
 * over them, plus ed25519-signed checkpoints that pin a `(treeSize, root,
 * headSha256)` triple in time. It imports its hashing from `../styx/certificate`
 * (`sha256Hex` — the one hash implementation in the codebase) and its signing
 * primitives from `./identity` (`GovIdentity`, `govCanonicalize`,
 * `verifyGovSignature`) — no home-rolled crypto anywhere in here.
 *
 * Every exported function here is TOTAL: out-of-range indices, empty trees,
 * `fromSize > toSize`, malformed proofs, and any other adversarial input
 * return `false` / a typed failure — never throw, never produce an
 * out-of-bounds access. That totality is what lets `audit-chain.ts` treat
 * this module as safe to call directly against untrusted, tampered,
 * attacker-controlled byte streams.
 */

import { sha256Hex } from "../styx/certificate";
import { GovIdentity, govCanonicalize, verifyGovSignature } from "./identity";
import type { AuditFailure } from "./audit-chain";

// ---------------------------------------------------------------------------
// Genesis root. Recomputed here (rather than importing the value binding
// from `./audit-chain`) so this module has NO runtime dependency on
// `audit-chain.ts` — only `audit-chain.ts` depends on `audit-proof.ts`,
// never the other way around, avoiding a circular module-init order
// entirely. `audit-chain.ts`'s `GOV_AUDIT_GENESIS` is computed with the
// identical `sha256Hex("hades.gov.audit.v1")` call and the two are asserted
// equal in the test suite, so there is exactly one logical genesis value
// even though it is computed in two places.
// ---------------------------------------------------------------------------
const EMPTY_TREE_ROOT = sha256Hex("hades.gov.audit.v1");

// ---------------------------------------------------------------------------
// RFC 6962 domain separation
// ---------------------------------------------------------------------------

/** `sha256Hex("\x00" + h)` — a LEAF hash. The 0x00 prefix defeats leaf/node confusion. */
export function leafHash(h: string): string {
  return sha256Hex("\x00" + h);
}

/** `sha256Hex("\x01" + l + r)` — an interior NODE hash. The 0x01 prefix defeats leaf/node confusion. */
export function nodeHash(l: string, r: string): string {
  return sha256Hex("\x01" + l + r);
}

// ---------------------------------------------------------------------------
// Merkle root (RFC 6962 "MTH" — Merkle Tree Hash), non-power-of-two sizes
// via the standard left-subtree-is-the-largest-power-of-two-strictly-less-
// than-n split.
// ---------------------------------------------------------------------------

/**
 * The Merkle Tree Hash of `leaves` (raw, un-domain-separated digests — this
 * function applies {@link leafHash} internally). Empty tree hashes to
 * `sha256Hex("hades.gov.audit.v1")` — the same value `audit-chain.ts`
 * exports as `GOV_AUDIT_GENESIS` — matching the chain's own genesis-as-root
 * convention so an empty audit log and an empty Merkle tree agree on what
 * "nothing has happened yet" hashes to.
 */
export function merkleRoot(leaves: readonly string[]): string {
  return mth(leaves.map(leafHash));
}

/** RFC 6962 MTH over already-leaf-hashed values. Total: n=0 -> genesis, n=1 -> the single leaf hash. */
function mth(leafHashes: readonly string[]): string {
  const n = leafHashes.length;
  if (n === 0) return EMPTY_TREE_ROOT;
  if (n === 1) return leafHashes[0];
  const k = largestPowerOfTwoLessThan(n);
  const left = mth(leafHashes.slice(0, k));
  const right = mth(leafHashes.slice(k));
  return nodeHash(left, right);
}

/** Largest power of two strictly less than n (n >= 2). */
function largestPowerOfTwoLessThan(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// ---------------------------------------------------------------------------
// Inclusion proofs (RFC 6962 "PATH")
// ---------------------------------------------------------------------------

export interface InclusionProof {
  index: number;
  treeSize: number;
  path: string[];
}

/**
 * Build an inclusion proof for `leaves[index]` against the tree formed by
 * ALL of `leaves`. Total: an out-of-range `index` (negative, >= length,
 * non-integer) or an empty `leaves` array returns a proof with an empty
 * `path` and `treeSize` reflecting the input length — verification of such
 * a degenerate proof will fail in {@link verifyInclusion} rather than this
 * function throwing.
 */
export function inclusionProof(leaves: readonly string[], index: number): InclusionProof {
  const treeSize = leaves.length;
  if (!Number.isInteger(index) || index < 0 || index >= treeSize) {
    return { index, treeSize, path: [] };
  }
  const hashes = leaves.map(leafHash);
  const path: string[] = [];
  pathRec(hashes, index, path);
  return { index, treeSize, path };
}

/** Recursively accumulate the RFC 6962 audit path for `index` within `hashes`. */
function pathRec(hashes: readonly string[], index: number, out: string[]): void {
  const n = hashes.length;
  if (n <= 1) return;
  const k = largestPowerOfTwoLessThan(n);
  if (index < k) {
    out.push(mth(hashes.slice(k)));
    pathRec(hashes.slice(0, k), index, out);
  } else {
    out.push(mth(hashes.slice(0, k)));
    pathRec(hashes.slice(k), index - k, out);
  }
}

/**
 * Verify that `leafSha256` (the RAW, un-domain-separated digest — this
 * function applies {@link leafHash} internally, matching {@link merkleRoot})
 * is included at `proof.index` in a tree of `proof.treeSize` leaves whose
 * root is `root`. Total: never throws. Returns `false` for an out-of-range
 * index, a proof whose reconstructed root does not match, a path of the
 * wrong length, or any other malformed input.
 */
export function verifyInclusion(leafSha256: string, proof: InclusionProof, root: string): boolean {
  try {
    if (proof === null || typeof proof !== "object") return false;
    const { index, treeSize, path } = proof;
    if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
    if (treeSize <= 0 || index < 0 || index >= treeSize) return false;
    if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) return false;
    if (treeSize === 1) {
      return path.length === 0 && leafHash(leafSha256) === root;
    }
    const computed = reconstructRoot(leafHash(leafSha256), index, treeSize, path, 0);
    return computed !== null && computed === root;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the root implied by an audit path, mirroring the recursive
 * split {@link pathRec} used to build it. Returns `null` (never throws) if
 * the path is the wrong length for the claimed tree shape.
 */
function reconstructRoot(leaf: string, index: number, treeSize: number, path: readonly string[], pos: number): string | null {
  if (treeSize <= 1) {
    return pos === path.length ? leaf : null;
  }
  const k = largestPowerOfTwoLessThan(treeSize);
  if (index < k) {
    if (pos >= path.length) return null;
    const left = reconstructRoot(leaf, index, k, path, pos + 1);
    if (left === null) return null;
    return nodeHash(left, path[pos]);
  } else {
    if (pos >= path.length) return null;
    const right = reconstructRoot(leaf, index - k, treeSize - k, path, pos + 1);
    if (right === null) return null;
    return nodeHash(path[pos], right);
  }
}

// ---------------------------------------------------------------------------
// Consistency proofs (RFC 6962 "PROOF") — proves tree(fromSize) is a strict
// left-hand prefix of tree(toSize), i.e. append-only.
// ---------------------------------------------------------------------------

export interface ConsistencyProof {
  fromSize: number;
  toSize: number;
  path: string[];
}

/**
 * Build a consistency proof that the first `fromSize` leaves of `leaves`
 * (whose overall length is `toSize`) are an unaltered, un-reordered prefix
 * of the full tree. Total: `fromSize <= 0`, `fromSize > leaves.length`, or a
 * non-integer `fromSize` yields an empty-path proof that will fail
 * verification rather than throwing.
 */
export function consistencyProof(leaves: readonly string[], fromSize: number): ConsistencyProof {
  const toSize = leaves.length;
  if (!Number.isInteger(fromSize) || fromSize <= 0 || fromSize > toSize) {
    return { fromSize, toSize, path: [] };
  }
  if (fromSize === toSize) {
    // Degenerate but well-formed: proof against oneself is the empty path.
    return { fromSize, toSize, path: [] };
  }
  const hashes = leaves.map(leafHash);
  const path: string[] = [];
  subProof(hashes, fromSize, toSize, true, path);
  return { fromSize, toSize, path };
}

/**
 * RFC 6962 SUBPROOF(m, D[n], b): b tracks whether we're still on the
 * "complete subtree" boundary that lets a single MTH substitute for a full
 * recursive descent.
 */
function subProof(hashes: readonly string[], m: number, n: number, b: boolean, out: string[]): void {
  if (m === n) {
    if (!b) out.push(mth(hashes.slice(0, n)));
    return;
  }
  const k = largestPowerOfTwoLessThan(n);
  if (m <= k) {
    subProof(hashes.slice(0, k), m, k, b, out);
    out.push(mth(hashes.slice(k)));
  } else {
    subProof(hashes.slice(k), m - k, n - k, false, out);
    out.push(mth(hashes.slice(0, k)));
  }
}

/**
 * Verify that `newRoot` (a tree of `proof.toSize` leaves) is a strict
 * append-only extension of `oldRoot` (a tree of `proof.fromSize` leaves).
 * Total: never throws. Rejects `fromSize <= 0`, `fromSize > toSize`, a
 * malformed path, or a path that reconstructs to the wrong pair of roots —
 * in particular this is what catches a fully-rewritten-but-internally-
 * consistent chain: the rewritten tree's `oldRoot`-shaped prefix no longer
 * hashes to the ORIGINAL `oldRoot`, so no valid proof exists.
 */
export function verifyConsistency(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean {
  try {
    if (proof === null || typeof proof !== "object") return false;
    const { fromSize, toSize, path } = proof;
    if (!Number.isInteger(fromSize) || !Number.isInteger(toSize)) return false;
    if (fromSize <= 0 || fromSize > toSize) return false;
    if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) return false;

    if (fromSize === toSize) {
      return path.length === 0 && oldRoot === newRoot;
    }

    // Iterative bit-trick reconstruction (the standard, widely-implemented
    // RFC 6962 consistency-proof verification algorithm — see e.g. Google's
    // certificate-transparency reference implementations): walk the binary
    // representations of `fromSize-1` and `toSize-1` in lockstep from the
    // leaf level upward, accumulating an "old root" candidate (`fn`) and a
    // "new root" candidate (`sn`) from the proof's sibling hashes. `fn`
    // MUST end up equal to `oldRoot` and `sn` MUST end up equal to
    // `newRoot` — a rewritten-but-internally-consistent tree fails here
    // because its recomputed prefix hash no longer matches the ORIGINAL
    // `oldRoot` that was signed before the rewrite.
    let idx = 0;
    let node = fromSize - 1;
    let lastNode = toSize - 1;
    while (node % 2 === 1) {
      node = Math.floor(node / 2);
      lastNode = Math.floor(lastNode / 2);
    }

    let fn: string;
    let sn: string;
    if (node > 0) {
      if (idx >= path.length) return false;
      fn = path[idx];
      sn = path[idx];
      idx++;
    } else {
      // fromSize is a power of two: the old root is not separately encoded
      // in the path — it equals the first node on the accumulation path.
      fn = oldRoot;
      sn = oldRoot;
    }

    while (node > 0) {
      if (node % 2 === 1) {
        if (idx >= path.length) return false;
        fn = nodeHash(path[idx], fn);
        sn = nodeHash(path[idx], sn);
        idx++;
      } else if (node < lastNode) {
        if (idx >= path.length) return false;
        sn = nodeHash(sn, path[idx]);
        idx++;
      }
      node = Math.floor(node / 2);
      lastNode = Math.floor(lastNode / 2);
    }

    if (fn !== oldRoot) return false;

    while (lastNode > 0) {
      if (idx >= path.length) return false;
      sn = nodeHash(sn, path[idx]);
      idx++;
      lastNode = Math.floor(lastNode / 2);
    }

    if (sn !== newRoot) return false;
    if (idx !== path.length) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signed checkpoints
// ---------------------------------------------------------------------------

export interface SignedCheckpoint {
  schema: "hades.gov.checkpoint.v1";
  treeSize: number;
  root: string;
  headSha256: string;
  at: number;
  signature: string;
  signerPublicKey: string;
}

/** Sign a checkpoint over its canonical fields (everything but schema/signature/signerPublicKey). */
export function signCheckpoint(identity: GovIdentity, input: Omit<SignedCheckpoint, "schema" | "signature" | "signerPublicKey">): SignedCheckpoint {
  const unsigned: Omit<SignedCheckpoint, "signature" | "signerPublicKey"> = {
    schema: "hades.gov.checkpoint.v1",
    treeSize: input.treeSize,
    root: input.root,
    headSha256: input.headSha256,
    at: input.at,
  };
  const signature = identity.signValue(unsigned);
  return {
    ...unsigned,
    signature,
    signerPublicKey: identity.publicKeyHex(),
  };
}

/**
 * Verify a checkpoint's signature against a set of trusted public keys.
 * Total: never throws. A wrong `schema` value on an otherwise well-shaped
 * object is reported specifically as `schema-mismatch` (distinct from a
 * structurally broken object or a bad signature) so callers can tell "this
 * is a checkpoint from an incompatible/future format" apart from "this is
 * garbage" or "this is a forgery". `trustedPublicKeys` is a closed
 * allowlist — a cryptographically valid signature from a key NOT in the
 * list still fails with `checkpoint-signature-invalid` (an attacker who
 * forges their own keypair and signs a fabricated checkpoint must not be
 * trusted merely because their own signature is internally consistent).
 */
export function verifyCheckpoint(cp: SignedCheckpoint, trustedPublicKeys: readonly string[]): { ok: boolean; failures: AuditFailure[] } {
  if (cp === null || typeof cp !== "object") {
    return { ok: false, failures: [{ code: "checkpoint-signature-invalid", detail: "checkpoint is not an object" }] };
  }
  const o = cp as unknown as Record<string, unknown>;

  if (o.schema !== "hades.gov.checkpoint.v1") {
    return { ok: false, failures: [{ code: "schema-mismatch", detail: `checkpoint schema is "${String(o.schema)}", expected "hades.gov.checkpoint.v1"` }] };
  }
  const wellFormed =
    typeof o.treeSize === "number" &&
    Number.isInteger(o.treeSize) &&
    o.treeSize >= 0 &&
    typeof o.root === "string" &&
    typeof o.headSha256 === "string" &&
    typeof o.at === "number" &&
    Number.isFinite(o.at) &&
    typeof o.signature === "string" &&
    typeof o.signerPublicKey === "string";
  if (!wellFormed) {
    return { ok: false, failures: [{ code: "checkpoint-signature-invalid", detail: "checkpoint is not a well-formed SignedCheckpoint" }] };
  }

  const typedCp = cp as SignedCheckpoint;
  if (!trustedPublicKeys.includes(typedCp.signerPublicKey)) {
    return { ok: false, failures: [{ code: "checkpoint-signature-invalid", detail: `checkpoint signerPublicKey ${typedCp.signerPublicKey} is not in the trusted set` }] };
  }
  const unsigned = { schema: typedCp.schema, treeSize: typedCp.treeSize, root: typedCp.root, headSha256: typedCp.headSha256, at: typedCp.at };
  let canonical: string;
  try {
    canonical = govCanonicalize(unsigned);
  } catch {
    return { ok: false, failures: [{ code: "checkpoint-signature-invalid", detail: "checkpoint fields are not canonicalizable" }] };
  }
  if (!verifyGovSignature(typedCp.signerPublicKey, canonical, typedCp.signature)) {
    return { ok: false, failures: [{ code: "checkpoint-signature-invalid", detail: "checkpoint signature does not verify under signerPublicKey" }] };
  }
  return { ok: true, failures: [] };
}
