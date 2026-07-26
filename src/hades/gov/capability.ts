/**
 * Macaroon-style ed25519 capability tokens for the Hades governance stack.
 *
 * A `GovCapabilityToken` grants a subject a set of `{resource, action}`
 * permissions, restricted by an explicit list of caveats (expiry, argument
 * constraints, host/path scoping, use counts, air-gap binding, audience).
 * Tokens delegate by *attenuation*: `CapabilityIssuer.attenuate` produces a
 * child token that is structurally guaranteed to be no more permissive than
 * its parent — `isAttenuation` is the pure predicate both `attenuate` (which
 * throws on any attempted widening) and `CapabilityEnforcer.authorize`
 * (which independently re-checks every link, so a hand-forged child that
 * skips `attenuate` entirely is still caught) are built on.
 *
 * `CapabilityEnforcer` is deny-by-default end to end: any structural
 * problem, untrusted issuer, broken chain link, expired/not-yet-valid
 * window, subject/audience mismatch, missing grant, failing caveat
 * (including one of an *unrecognized* kind — unknown caveats never pass
 * through unchecked), replayed nonce, or exhausted use-budget produces a
 * specific `CapabilityDenyCode` and never a silent allow. `authorize` never
 * throws; only `assert` does, embedding the deny code in its message.
 *
 * Crypto is entirely delegated to `./identity` — `GovIdentity`,
 * `govCanonicalize`, `govDigest`, `signGov`, `verifyGovSignature`, and
 * `agentIdFromPublicKey` are the ONLY primitives this module signs or
 * verifies with. No home-rolled crypto, no ambient `Date.now()` in any pure
 * path (every clock read here is the injected `now()`).
 *
 * Signing convention (mirrors `identity.ts`'s own `SignedIdentityDoc`
 * discipline): the signed message is `govCanonicalize(tokenBody)` where
 * `tokenBody` is every field of `GovCapabilityToken` EXCEPT `signature`
 * itself — critically, `signerPublicKey` IS part of the signed body, so an
 * attacker who swaps `signerPublicKey` to their own key without re-signing
 * invalidates the signature outright, and one who swaps it and re-signs
 * with their own key produces a token whose `signerPublicKey` no longer
 * matches its (unchanged) `issuer`/`issuerPublicKey` claim — caught by the
 * issuer-identity cross-check below, not by the raw signature check alone.
 */

import { randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";

import { GovIdentity, agentIdFromPublicKey, govCanonicalize, govDigest, signGov, verifyGovSignature } from "./identity";
import type { CapabilityToken as LegacyCapabilityToken } from "../security/tokens";
import type { ReplayGuard, UseCounter } from "./replay-guard";

// ---------------------------------------------------------------------------
// Locked types
// ---------------------------------------------------------------------------

export interface CapabilityGrant {
  resource: string;
  actions: string[];
}

export type CapabilityCaveat =
  | { kind: "expires-at"; at: number }
  | { kind: "not-before"; at: number }
  | { kind: "max-uses"; uses: number }
  | { kind: "audience"; audience: string }
  | { kind: "arg-equals"; arg: string; value: string | number | boolean }
  | { kind: "arg-prefix"; arg: string; prefix: string }
  | { kind: "arg-in"; arg: string; values: readonly (string | number)[] }
  | { kind: "host-allowlist"; hosts: readonly string[] }
  | { kind: "path-under"; root: string }
  | { kind: "airgap-only"; required: boolean }
  | { kind: "max-bytes"; arg: string; bytes: number };

export interface GovCapabilityToken {
  schema: "hades.gov.capability.v1";
  tokenId: string;
  issuer: string;
  issuerPublicKey: string;
  subject: string;
  audience?: string;
  grants: CapabilityGrant[];
  caveats: CapabilityCaveat[];
  issuedAt: number;
  expiresAt: number;
  depth: number;
  parentTokenId?: string;
  nonce: string;
  signature: string;
  signerPublicKey: string;
}

export interface CapabilityRequest {
  subject: string;
  action: string;
  resource: string;
  args?: Record<string, unknown>;
  at: number;
  airgapped?: boolean;
  nonce?: string;
}

export type CapabilityDenyCode =
  | "malformed"
  | "schema-mismatch"
  | "signature-invalid"
  | "untrusted-issuer"
  | "expired"
  | "not-yet-valid"
  | "subject-mismatch"
  | "audience-mismatch"
  | "no-matching-grant"
  | "action-not-granted"
  | "caveat-failed"
  | "replayed"
  | "revoked"
  | "chain-broken"
  | "attenuation-violation"
  | "depth-exceeded"
  | "use-limit-exceeded";

export interface CapabilityDecision {
  allow: boolean;
  code: "allow" | CapabilityDenyCode;
  reason: string;
  matchedGrant?: CapabilityGrant;
  failedCaveat?: CapabilityCaveat;
  tokenId?: string;
  depth?: number;
}

// ---------------------------------------------------------------------------
// Schema / constants
// ---------------------------------------------------------------------------

const SCHEMA = "hades.gov.capability.v1" as const;
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_DEPTH = 16;

// ---------------------------------------------------------------------------
// resourceMatches — segmented pattern matcher (pure)
// ---------------------------------------------------------------------------

/**
 * Split a `resource`/pattern string into match segments. Top-level segments
 * are `:`-delimited (`fs:read:/data/foo`); if the LAST top-level segment
 * looks like a filesystem path (starts with `/`), it is further split on
 * `/` into its own path segments so `fs:read:/data/foo/bar` and
 * `fs:read:/data/*` compare path component by path component rather than as
 * one opaque string. A `net:` host segment is left whole (hosts are matched
 * as a single token, case-insensitively — see below).
 */
function splitSegments(s: string): string[] {
  const top = s.split(":");
  const last = top[top.length - 1] ?? "";
  if (last.startsWith("/")) {
    const pathSegs = last.split("/").filter((seg) => seg.length > 0);
    return [...top.slice(0, -1), ...pathSegs];
  }
  return top;
}

/**
 * Is `childSegs` a subset of what `parentSegs` matches? Shared by
 * `resourceMatches` (where `childSegs` is a concrete, wildcard-free
 * resource) and grant-narrowing checks (where `childSegs` may itself carry
 * wildcards, and must be checked to be no broader than `parentSegs`).
 *
 *  - A literal parent segment requires an EQUAL literal child segment
 *    (case-insensitive only when the namespace, `parentSegs[0]`, is `net`
 *    — DNS hostnames are case-insensitive, so `net:API.EXAMPLE.COM` and
 *    `net:api.example.com` denote the same host and must match; nothing
 *    else in the resource grammar is case-folded).
 *  - `*` in the parent matches exactly one segment (never zero, never more
 *    than one) — a child segment of `**` there would be broader and is
 *    rejected; a literal or `*` child segment is accepted.
 *  - `**` in the parent (only meaningful as the FINAL parent segment) is a
 *    recursive wildcard: it matches everything remaining in `childSegs`,
 *    including zero further segments, regardless of what those segments
 *    contain — so once the walk reaches it, the match succeeds outright.
 *  - Segment counts must otherwise match exactly: a shorter or longer
 *    child than the parent requires (short of a `**` parent) denotes a
 *    genuinely different resource, not a subset, and is rejected. This is
 *    what stops `fs:read:/data/*` from matching `/data/a/b` — the `*`
 *    consumes exactly one segment (`a`), leaving `b` unaccounted for.
 */
function segmentsSubsetOf(parentSegs: readonly string[], childSegs: readonly string[]): boolean {
  const caseInsensitive = parentSegs[0] === "net";
  const norm = (x: string): string => (caseInsensitive ? x.toLowerCase() : x);

  let pi = 0;
  let ci = 0;
  while (pi < parentSegs.length) {
    const p = parentSegs[pi];
    if (p === "**") {
      return true;
    }
    if (ci >= childSegs.length) return false;
    const c = childSegs[ci];
    if (p === "*") {
      if (c === "**") return false; // broader than a single segment
      pi++;
      ci++;
      continue;
    }
    if (c === "*" || c === "**") return false; // wildcard child broader than a literal parent
    if (norm(p) !== norm(c)) return false;
    pi++;
    ci++;
  }
  return ci === childSegs.length;
}

/**
 * True iff every concrete resource matched by `resource` (a plain,
 * wildcard-free string in normal use — matched literally even if it
 * happens to contain `*`/`**` characters, since it denotes the request
 * being checked, not a pattern) is covered by `pattern`. Pure, exported.
 */
export function resourceMatches(pattern: string, resource: string): boolean {
  if (typeof pattern !== "string" || typeof resource !== "string") return false;
  return segmentsSubsetOf(splitSegments(pattern), splitSegments(resource));
}

/** Is `childPattern`'s match-set a subset of `parentPattern`'s? Used for grant narrowing. */
function patternSubsetOfPattern(parentPattern: string, childPattern: string): boolean {
  if (parentPattern === childPattern) return true;
  return segmentsSubsetOf(splitSegments(parentPattern), splitSegments(childPattern));
}

// ---------------------------------------------------------------------------
// Path normalization for the `path-under` caveat — hostile-input safe
// ---------------------------------------------------------------------------

/**
 * Repeatedly percent-decode `s` (bounded iterations, guarding against
 * double/triple URL-encoded traversal like `%252e%252e`) until it stops
 * changing or the bound is hit. Malformed escapes are left as-is rather
 * than thrown (decodeURIComponent throws on stray `%`) so a caveat check
 * never crashes the enforcer.
 */
function decodeRepeated(s: string, maxIterations = 5): string {
  let cur = s;
  for (let i = 0; i < maxIterations; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * True iff `candidatePath` (after percent-decoding and `.`/`..` resolution)
 * stays at or under `root`. Uses `node:path`'s POSIX resolver, which — like
 * every standards path resolver — treats an ABSOLUTE `candidatePath` as
 * overriding `root` entirely (so a raw absolute-path escape attempt like
 * `/etc/passwd` is correctly evaluated against `/`, not silently joined
 * under `root`, and denied unless it happens to literally be under it).
 */
function pathIsUnder(root: string, candidatePath: string): boolean {
  const decoded = decodeRepeated(candidatePath);
  const normalizedRoot = posixPath.resolve(root);
  const resolved = posixPath.resolve(normalizedRoot, decoded);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/");
}

// ---------------------------------------------------------------------------
// Structural validation (deny-by-default: anything not recognizably a
// GovCapabilityToken is "malformed", never silently coerced)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isCapabilityGrant(v: unknown): v is CapabilityGrant {
  if (!isPlainObject(v)) return false;
  if (typeof v.resource !== "string" || v.resource.length === 0) return false;
  if (!Array.isArray(v.actions) || v.actions.length === 0) return false;
  return v.actions.every((a) => typeof a === "string" && a.length > 0);
}

const KNOWN_CAVEAT_KINDS = new Set([
  "expires-at",
  "not-before",
  "max-uses",
  "audience",
  "arg-equals",
  "arg-prefix",
  "arg-in",
  "host-allowlist",
  "path-under",
  "airgap-only",
  "max-bytes",
]);

/** Structural shape check only — does NOT decide whether an unknown kind is legal (that's deny-by-default at enforcement time). */
function isCaveatShape(v: unknown): v is CapabilityCaveat {
  if (!isPlainObject(v) || typeof v.kind !== "string") return false;
  switch (v.kind) {
    case "expires-at":
    case "not-before":
      return typeof v.at === "number" && Number.isFinite(v.at);
    case "max-uses":
      return typeof v.uses === "number" && Number.isInteger(v.uses) && v.uses >= 0;
    case "audience":
      return typeof v.audience === "string" && v.audience.length > 0;
    case "arg-equals":
      return typeof v.arg === "string" && ["string", "number", "boolean"].includes(typeof v.value);
    case "arg-prefix":
      return typeof v.arg === "string" && typeof v.prefix === "string";
    case "arg-in":
      return typeof v.arg === "string" && Array.isArray(v.values) && v.values.every((x) => typeof x === "string" || typeof x === "number");
    case "host-allowlist":
      return Array.isArray(v.hosts) && v.hosts.every((h) => typeof h === "string" && h.length > 0);
    case "path-under":
      return typeof v.root === "string" && v.root.length > 0;
    case "airgap-only":
      return typeof v.required === "boolean";
    case "max-bytes":
      return typeof v.arg === "string" && typeof v.bytes === "number" && Number.isFinite(v.bytes) && v.bytes >= 0;
    default:
      // Structurally unrecognized kinds are still accepted at parse time —
      // deny-by-default happens at EVALUATION, not shape-checking, so a
      // forward-compatible-looking but unrecognized caveat doesn't get
      // rejected as "malformed" (which would look like a transport bug)
      // when it should be rejected as "caveat-failed" (a real refusal).
      return true;
  }
}

function validateTokenShape(v: unknown): CapabilityDenyCode | null {
  if (!isPlainObject(v)) return "malformed";
  if (v.schema !== SCHEMA) return "schema-mismatch";
  if (typeof v.tokenId !== "string" || v.tokenId.length === 0) return "malformed";
  if (typeof v.issuer !== "string" || v.issuer.length === 0) return "malformed";
  if (typeof v.issuerPublicKey !== "string" || v.issuerPublicKey.length === 0) return "malformed";
  if (typeof v.subject !== "string" || v.subject.length === 0) return "malformed";
  if (v.audience !== undefined && typeof v.audience !== "string") return "malformed";
  if (!Array.isArray(v.grants) || !v.grants.every(isCapabilityGrant)) return "malformed";
  if (!Array.isArray(v.caveats) || !v.caveats.every(isCaveatShape)) return "malformed";
  if (typeof v.issuedAt !== "number" || !Number.isFinite(v.issuedAt)) return "malformed";
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return "malformed";
  if (typeof v.depth !== "number" || !Number.isInteger(v.depth) || v.depth < 0) return "malformed";
  if (v.parentTokenId !== undefined && typeof v.parentTokenId !== "string") return "malformed";
  if (typeof v.nonce !== "string" || v.nonce.length === 0) return "malformed";
  if (typeof v.signature !== "string" || v.signature.length === 0) return "malformed";
  if (typeof v.signerPublicKey !== "string" || v.signerPublicKey.length === 0) return "malformed";
  return null;
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

type TokenBody = Omit<GovCapabilityToken, "signature">;

function signingMessage(body: TokenBody): string {
  return govCanonicalize(body);
}

function signBody(identity: GovIdentity, body: TokenBody): GovCapabilityToken {
  const signature = signGov(identity.privateKeyHex(), signingMessage(body));
  return { ...body, signature };
}

/**
 * Verify a single token's cryptographic + issuer-identity integrity:
 *  1. `issuerPublicKey === signerPublicKey` — the claimed issuer and the
 *     key that actually produced the signature must be the same key. This
 *     is what stops the "swap `signerPublicKey` to an attacker key and
 *     re-sign" forgery: the attacker's signature verifies fine under their
 *     OWN key, but that key no longer matches the (unchanged) `issuer` /
 *     `issuerPublicKey` claim.
 *  2. `issuer === agentIdFromPublicKey(issuerPublicKey)` — the claimed
 *     issuer id is actually derived from the claimed issuer key.
 *  3. The signature verifies over `govCanonicalize(body without signature)`
 *     under `signerPublicKey` — this also transitively protects every
 *     other field, INCLUDING `signerPublicKey` itself (it's part of the
 *     signed body), so swapping it without re-signing fails here directly.
 */
function verifyTokenIntegrity(t: GovCapabilityToken): boolean {
  if (t.issuerPublicKey !== t.signerPublicKey) return false;
  if (t.issuer !== agentIdFromPublicKey(t.issuerPublicKey)) return false;
  const { signature, ...body } = t;
  return verifyGovSignature(t.signerPublicKey, signingMessage(body), signature);
}

// ---------------------------------------------------------------------------
// isAttenuation — pure narrowing predicate
// ---------------------------------------------------------------------------

function actionsSubset(parentActions: readonly string[], childActions: readonly string[]): boolean {
  if (parentActions.includes("*")) return true;
  const parentSet = new Set(parentActions);
  return childActions.every((a) => parentSet.has(a));
}

function grantIsNarrowerOrEqual(parentGrants: readonly CapabilityGrant[], childGrant: CapabilityGrant): boolean {
  return parentGrants.some((pg) => patternSubsetOfPattern(pg.resource, childGrant.resource) && actionsSubset(pg.actions, childGrant.actions));
}

function caveatKey(c: CapabilityCaveat): string {
  return "arg" in c ? `${c.kind}:${c.arg}` : c.kind;
}

/**
 * Is `child`'s caveat at least as restrictive as `parent`'s (same kind,
 * same `arg` where applicable)? Kinds with no natural narrowing order
 * (`arg-equals`) require an identical value; the rest have an explicit
 * ordering documented per-case below. Assumes `parent.kind === child.kind`.
 */
function caveatIsNarrowerOrEqual(parent: CapabilityCaveat, child: CapabilityCaveat): boolean {
  switch (parent.kind) {
    case "expires-at":
      return child.kind === "expires-at" && child.at <= parent.at;
    case "not-before":
      return child.kind === "not-before" && child.at >= parent.at;
    case "max-uses":
      return child.kind === "max-uses" && child.uses <= parent.uses;
    case "audience":
      return child.kind === "audience" && child.audience === parent.audience;
    case "arg-equals":
      return child.kind === "arg-equals" && child.arg === parent.arg && child.value === parent.value;
    case "arg-prefix":
      return child.kind === "arg-prefix" && child.arg === parent.arg && child.prefix.startsWith(parent.prefix);
    case "arg-in": {
      if (child.kind !== "arg-in" || child.arg !== parent.arg) return false;
      const parentSet = new Set(parent.values);
      return child.values.every((v) => parentSet.has(v));
    }
    case "host-allowlist": {
      if (child.kind !== "host-allowlist") return false;
      const parentSet = new Set(parent.hosts.map((h) => h.toLowerCase()));
      return child.hosts.every((h) => parentSet.has(h.toLowerCase()));
    }
    case "path-under":
      return child.kind === "path-under" && pathIsUnder(parent.root, child.root);
    case "airgap-only":
      // Once a chain requires air-gap binding (true) or forbids it
      // (false), a child cannot relax back to "unconstrained" — but there
      // is nothing looser than a fixed boolean requirement to narrow TO,
      // so equality is the only valid "no widening" outcome.
      return child.kind === "airgap-only" && child.required === parent.required;
    case "max-bytes":
      return child.kind === "max-bytes" && child.arg === parent.arg && child.bytes <= parent.bytes;
    default:
      return false;
  }
}

/**
 * Pure structural predicate: is `child` a valid (possibly no-op)
 * attenuation of `parent`? Never throws, never touches a clock or the
 * network. Checked independently by `CapabilityEnforcer.authorize` for
 * EVERY link, so it also catches a hand-forged child that bypasses
 * `CapabilityIssuer.attenuate` entirely.
 */
export function isAttenuation(parent: GovCapabilityToken, child: GovCapabilityToken): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  if (child.depth !== parent.depth + 1) {
    violations.push(`depth: child.depth (${child.depth}) must equal parent.depth + 1 (${parent.depth + 1})`);
  }
  if (child.parentTokenId !== parent.tokenId) {
    violations.push(`parentTokenId: child.parentTokenId ("${String(child.parentTokenId)}") must equal parent.tokenId ("${parent.tokenId}")`);
  }
  if (child.issuer !== parent.subject) {
    violations.push(`issuer: child.issuer ("${child.issuer}") must equal parent.subject ("${parent.subject}") — the parent's holder becomes the child's issuer`);
  }
  if (child.expiresAt > parent.expiresAt) {
    violations.push(`expiresAt: child (${child.expiresAt}) is LATER than parent (${parent.expiresAt}) — expiry may only move earlier or stay equal`);
  }
  if (parent.audience !== undefined) {
    if (child.audience !== parent.audience) {
      violations.push(`audience: parent restricts audience to "${parent.audience}"; child has "${String(child.audience)}"`);
    }
  }

  for (const cg of child.grants) {
    if (!grantIsNarrowerOrEqual(parent.grants, cg)) {
      violations.push(`grant: child grant {resource:"${cg.resource}", actions:${JSON.stringify(cg.actions)}} is not covered by any parent grant`);
    }
  }

  for (const pc of parent.caveats) {
    const key = caveatKey(pc);
    const match = child.caveats.find((cc) => caveatKey(cc) === key);
    if (!match) {
      violations.push(`caveat: parent caveat "${key}" was dropped in the child`);
      continue;
    }
    if (!caveatIsNarrowerOrEqual(pc, match)) {
      violations.push(`caveat: child's "${key}" caveat (${JSON.stringify(match)}) is broader than the parent's (${JSON.stringify(pc)})`);
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// CapabilityIssuer
// ---------------------------------------------------------------------------

export interface CapabilityIssuerOptions {
  now?: () => number;
  nonceGen?: () => string;
  defaultTtlMs?: number;
}

export class CapabilityIssuer {
  private readonly identity: GovIdentity;
  private readonly now: () => number;
  private readonly nonceGen: () => string;
  private readonly defaultTtlMs: number;

  constructor(identity: GovIdentity, opts: CapabilityIssuerOptions = {}) {
    this.identity = identity;
    this.now = opts.now ?? (() => Date.now());
    this.nonceGen = opts.nonceGen ?? (() => randomUUID());
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Mint a brand-new root token: `depth: 0`, no `parentTokenId`, signed by this issuer's own key. */
  mint(input: { subject: string; grants: CapabilityGrant[]; caveats?: CapabilityCaveat[]; audience?: string; ttlMs?: number }): GovCapabilityToken {
    const issuedAt = this.now();
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    if (!(ttl > 0)) throw new RangeError(`CapabilityIssuer.mint: ttlMs must be > 0, got ${ttl}`);
    const nonce = this.nonceGen();
    const pub = this.identity.publicKeyHex();
    const issuer = this.identity.agentId();

    const preBody = {
      schema: SCHEMA,
      issuer,
      issuerPublicKey: pub,
      subject: input.subject,
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      grants: cloneGrants(input.grants),
      caveats: [...(input.caveats ?? [])],
      issuedAt,
      expiresAt: issuedAt + ttl,
      depth: 0,
      nonce,
      signerPublicKey: pub,
    };
    const tokenId = `cap:${govDigest(preBody)}`;
    const body: TokenBody = { ...preBody, tokenId };
    return signBody(this.identity, body);
  }

  /**
   * Delegate `parent` to a (possibly) narrower child, signed by THIS
   * identity acting as the parent's current holder. Throws (never returns
   * a widened token) unless `holder.agentId() === parent.subject` and the
   * requested `narrowing` produces a structural subset of `parent` per
   * {@link isAttenuation} — it is structurally impossible for this method
   * to hand back a token that widens permissions.
   */
  attenuate(parent: GovCapabilityToken, holder: GovIdentity, narrowing: { grants?: CapabilityGrant[]; caveats?: CapabilityCaveat[]; subject?: string; ttlMs?: number }): GovCapabilityToken {
    if (holder.agentId() !== parent.subject) {
      throw new Error(`CapabilityIssuer.attenuate: holder (${holder.agentId()}) is not the parent token's subject (${parent.subject})`);
    }
    const issuedAt = this.now();
    const requestedTtl = narrowing.ttlMs;
    const expiresAt = requestedTtl !== undefined ? issuedAt + requestedTtl : parent.expiresAt;
    if (expiresAt <= issuedAt) {
      throw new Error(`CapabilityIssuer.attenuate: resulting expiresAt (${expiresAt}) is not after issuedAt (${issuedAt})`);
    }
    if (expiresAt > parent.expiresAt) {
      throw new Error(`CapabilityIssuer.attenuate: requested ttlMs would WIDEN expiry to ${expiresAt}, which is later than the parent's expiresAt (${parent.expiresAt}) — refusing to mint`);
    }

    const nonce = this.nonceGen();
    const pub = holder.publicKeyHex();
    const issuer = holder.agentId();

    const preBody = {
      schema: SCHEMA,
      issuer,
      issuerPublicKey: pub,
      subject: narrowing.subject ?? parent.subject,
      ...(parent.audience !== undefined ? { audience: parent.audience } : {}),
      grants: cloneGrants(narrowing.grants ?? parent.grants),
      caveats: narrowing.caveats ?? [...parent.caveats],
      issuedAt,
      expiresAt,
      depth: parent.depth + 1,
      parentTokenId: parent.tokenId,
      nonce,
      signerPublicKey: pub,
    };
    const tokenId = `cap:${govDigest(preBody)}`;
    const candidateBody: TokenBody = { ...preBody, tokenId };
    const candidate = signBody(holder, candidateBody);

    const check = isAttenuation(parent, candidate);
    if (!check.ok) {
      throw new Error(`CapabilityIssuer.attenuate: requested narrowing would WIDEN the parent token — refusing to mint:\n  - ${check.violations.join("\n  - ")}`);
    }
    return candidate;
  }
}

function cloneGrants(grants: readonly CapabilityGrant[]): CapabilityGrant[] {
  return grants.map((g) => ({ resource: g.resource, actions: [...g.actions] }));
}

// ---------------------------------------------------------------------------
// Caveat evaluation (per-request, pure — excludes max-uses, which is
// stateful and handled directly by the enforcer)
// ---------------------------------------------------------------------------

function readArg(req: CapabilityRequest, name: string): unknown {
  return req.args ? req.args[name] : undefined;
}

/**
 * Evaluate one caveat against one request. Returns `{ok:true}` or
 * `{ok:false, reason}` — NEVER throws. An unrecognized `kind` (a caveat
 * shape this module doesn't know how to interpret) fails closed: it is
 * treated as `{ok:false}`, never silently passed through as satisfied.
 * `max-uses` always evaluates to `ok:true` here — its stateful check runs
 * separately in `CapabilityEnforcer` against the injected `UseCounter`.
 */
function evaluateCaveat(caveat: CapabilityCaveat, req: CapabilityRequest): { ok: boolean; reason: string } {
  switch (caveat.kind) {
    case "expires-at":
      return req.at < caveat.at ? { ok: true, reason: "" } : { ok: false, reason: `caveat expires-at: request time ${req.at} is at or after ${caveat.at}` };
    case "not-before":
      return req.at >= caveat.at ? { ok: true, reason: "" } : { ok: false, reason: `caveat not-before: request time ${req.at} is before ${caveat.at}` };
    case "max-uses":
      return { ok: true, reason: "" };
    case "audience": {
      const presented = readArg(req, "audience");
      return presented === caveat.audience
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat audience: expected "${caveat.audience}", got ${JSON.stringify(presented)}` };
    }
    case "arg-equals": {
      const v = readArg(req, caveat.arg);
      return v === caveat.value ? { ok: true, reason: "" } : { ok: false, reason: `caveat arg-equals: args.${caveat.arg} (${JSON.stringify(v)}) !== ${JSON.stringify(caveat.value)}` };
    }
    case "arg-prefix": {
      const v = readArg(req, caveat.arg);
      return typeof v === "string" && v.startsWith(caveat.prefix)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat arg-prefix: args.${caveat.arg} (${JSON.stringify(v)}) does not start with "${caveat.prefix}"` };
    }
    case "arg-in": {
      const v = readArg(req, caveat.arg);
      const values: readonly (string | number)[] = caveat.values;
      return (typeof v === "string" || typeof v === "number") && values.includes(v)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat arg-in: args.${caveat.arg} (${JSON.stringify(v)}) not in ${JSON.stringify(caveat.values)}` };
    }
    case "host-allowlist": {
      let host: unknown;
      if (req.resource.startsWith("net:")) host = req.resource.slice("net:".length);
      else host = readArg(req, "host");
      if (typeof host !== "string" || host.length === 0) return { ok: false, reason: "caveat host-allowlist: no host present on the request" };
      const lower = host.toLowerCase();
      return caveat.hosts.some((h) => h.toLowerCase() === lower)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat host-allowlist: host "${host}" is not in ${JSON.stringify(caveat.hosts)}` };
    }
    case "path-under": {
      const p = readArg(req, "path");
      if (typeof p !== "string" || p.length === 0) return { ok: false, reason: "caveat path-under: no path present on the request" };
      return pathIsUnder(caveat.root, p)
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat path-under: "${p}" escapes root "${caveat.root}"` };
    }
    case "airgap-only": {
      const isAirgapped = req.airgapped === true;
      if (caveat.required) {
        return isAirgapped ? { ok: true, reason: "" } : { ok: false, reason: "caveat airgap-only: request is not air-gapped" };
      }
      return !isAirgapped ? { ok: true, reason: "" } : { ok: false, reason: "caveat airgap-only: request must NOT be air-gapped" };
    }
    case "max-bytes": {
      const v = readArg(req, caveat.arg);
      return typeof v === "number" && Number.isFinite(v) && v <= caveat.bytes
        ? { ok: true, reason: "" }
        : { ok: false, reason: `caveat max-bytes: args.${caveat.arg} (${JSON.stringify(v)}) exceeds ${caveat.bytes}` };
    }
    default:
      return { ok: false, reason: `caveat of unrecognized kind "${(caveat as { kind: string }).kind}" — deny-by-default` };
  }
}

// ---------------------------------------------------------------------------
// CapabilityEnforcer
// ---------------------------------------------------------------------------

export interface CapabilityEnforcerOptions {
  trustedIssuerPublicKeys: readonly string[];
  replayGuard?: ReplayGuard;
  useCounter?: UseCounter;
  now?: () => number;
  maxDepth?: number;
  revokedTokenIds?: ReadonlySet<string>;
}

function deny(code: CapabilityDenyCode, reason: string, extra?: Partial<CapabilityDecision>): CapabilityDecision {
  return { allow: false, code, reason, ...extra };
}

export class CapabilityEnforcer {
  private readonly trustedIssuerPublicKeys: ReadonlySet<string>;
  private readonly replayGuard: ReplayGuard | undefined;
  private readonly useCounter: UseCounter | undefined;
  private readonly now: () => number;
  private readonly maxDepth: number;
  private readonly revokedTokenIds: ReadonlySet<string>;

  constructor(opts: CapabilityEnforcerOptions) {
    this.trustedIssuerPublicKeys = new Set(opts.trustedIssuerPublicKeys);
    this.replayGuard = opts.replayGuard;
    this.useCounter = opts.useCounter;
    this.now = opts.now ?? (() => Date.now());
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.revokedTokenIds = opts.revokedTokenIds ?? new Set();
  }

  /** Never throws — always returns a decision. */
  authorize(chain: readonly GovCapabilityToken[], req: CapabilityRequest): CapabilityDecision {
    try {
      return this.authorizeInner(chain, req);
    } catch (err) {
      return deny("malformed", `internal error during authorization: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Throws unless `authorize` returns `allow: true`; the thrown message embeds the deny code. */
  assert(chain: readonly GovCapabilityToken[], req: CapabilityRequest): void {
    const decision = this.authorize(chain, req);
    if (!decision.allow) {
      throw new Error(`capability denied [${decision.code}]: ${decision.reason}`);
    }
  }

  private authorizeInner(chain: readonly GovCapabilityToken[], req: CapabilityRequest): CapabilityDecision {
    if (!Array.isArray(chain) || chain.length === 0) {
      return deny("malformed", "authorize: chain must be a non-empty array of GovCapabilityToken");
    }
    if (req === null || typeof req !== "object" || typeof req.subject !== "string" || typeof req.action !== "string" || typeof req.resource !== "string" || typeof req.at !== "number") {
      return deny("malformed", "authorize: request is not a well-formed CapabilityRequest");
    }

    // --- structural + cryptographic validity of every link -----------------
    for (let i = 0; i < chain.length; i++) {
      const t = chain[i];
      const shapeProblem = validateTokenShape(t);
      if (shapeProblem) {
        return deny(shapeProblem, `chain[${i}] is not a well-formed GovCapabilityToken (${shapeProblem})`, { depth: i });
      }
    }
    const tokens = chain as readonly GovCapabilityToken[];

    for (let i = 0; i < tokens.length; i++) {
      if (!verifyTokenIntegrity(tokens[i])) {
        return deny("signature-invalid", `chain[${i}] (tokenId ${tokens[i].tokenId}) signature does not verify`, { tokenId: tokens[i].tokenId, depth: i });
      }
    }

    for (const t of tokens) {
      if (this.revokedTokenIds.has(t.tokenId)) {
        return deny("revoked", `token ${t.tokenId} is revoked`, { tokenId: t.tokenId });
      }
    }

    const root = tokens[0];
    if (!this.trustedIssuerPublicKeys.has(root.signerPublicKey)) {
      return deny("untrusted-issuer", `chain[0] is signed by an untrusted key (${root.signerPublicKey})`, { tokenId: root.tokenId, depth: 0 });
    }

    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      if (agentIdFromPublicKey(cur.signerPublicKey) !== prev.subject) {
        return deny("chain-broken", `chain[${i}] is signed by a key that does not belong to chain[${i - 1}]'s subject ("${prev.subject}")`, { tokenId: cur.tokenId, depth: i });
      }
      if (cur.parentTokenId !== prev.tokenId) {
        return deny("chain-broken", `chain[${i}].parentTokenId does not equal chain[${i - 1}].tokenId`, { tokenId: cur.tokenId, depth: i });
      }
      if (cur.issuer !== prev.subject) {
        return deny("chain-broken", `chain[${i}].issuer ("${cur.issuer}") does not equal chain[${i - 1}].subject ("${prev.subject}")`, { tokenId: cur.tokenId, depth: i });
      }
    }

    for (let i = 1; i < tokens.length; i++) {
      const check = isAttenuation(tokens[i - 1], tokens[i]);
      if (!check.ok) {
        return deny("attenuation-violation", `chain[${i}] widens chain[${i - 1}]: ${check.violations.join("; ")}`, { tokenId: tokens[i].tokenId, depth: i });
      }
    }

    const leaf = tokens[tokens.length - 1];
    if (leaf.depth > this.maxDepth) {
      return deny("depth-exceeded", `chain depth ${leaf.depth} exceeds maxDepth ${this.maxDepth}`, { tokenId: leaf.tokenId, depth: leaf.depth });
    }

    // --- temporal validity of every link ------------------------------------
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (req.at < t.issuedAt) {
        return deny("not-yet-valid", `chain[${i}] (tokenId ${t.tokenId}) is not valid until ${t.issuedAt}, request is at ${req.at}`, { tokenId: t.tokenId, depth: i });
      }
      if (req.at >= t.expiresAt) {
        return deny("expired", `chain[${i}] (tokenId ${t.tokenId}) expired at ${t.expiresAt}, request is at ${req.at}`, { tokenId: t.tokenId, depth: i });
      }
    }

    // --- identity ------------------------------------------------------------
    if (leaf.subject !== req.subject) {
      return deny("subject-mismatch", `token subject ("${leaf.subject}") does not match requesting subject ("${req.subject}")`, { tokenId: leaf.tokenId, depth: leaf.depth });
    }
    for (const t of tokens) {
      if (t.audience !== undefined) {
        const presented = req.args ? req.args["audience"] : undefined;
        if (presented !== t.audience) {
          return deny("audience-mismatch", `token audience ("${t.audience}") does not match presented audience (${JSON.stringify(presented)})`, { tokenId: t.tokenId });
        }
      }
    }

    // --- grants (INTERSECTION down the chain) --------------------------------
    //
    // A token may legitimately carry several grants whose resource patterns
    // overlap (e.g. a broad `fs:**` read grant alongside a narrow
    // `fs:/tmp/scratch/**` write grant). The link is satisfied if ANY of its
    // grants covers BOTH the resource and the action — never merely the
    // first one that happens to match the resource, which would deny a
    // request the token genuinely authorizes. `no-matching-grant` is
    // reserved for "no grant covers this resource at all" so the two deny
    // codes stay diagnostically distinct.
    let matchedGrant: CapabilityGrant | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const resourceMatchingGrants = t.grants.filter((g) => resourceMatches(g.resource, req.resource));
      if (resourceMatchingGrants.length === 0) {
        return deny("no-matching-grant", `chain[${i}] (tokenId ${t.tokenId}) has no grant covering resource "${req.resource}"`, { tokenId: t.tokenId, depth: i });
      }
      const actionMatch = resourceMatchingGrants.find((g) => g.actions.includes("*") || g.actions.includes(req.action));
      if (!actionMatch) {
        return deny("action-not-granted", `chain[${i}] (tokenId ${t.tokenId}) grant for "${req.resource}" does not include action "${req.action}"`, { tokenId: t.tokenId, depth: i, matchedGrant: resourceMatchingGrants[0] });
      }
      matchedGrant = actionMatch;
    }

    // --- caveats (every caveat of every link, dry-run) -----------------------
    for (let i = 0; i < tokens.length; i++) {
      for (const caveat of tokens[i].caveats) {
        if (caveat.kind === "max-uses") continue; // handled below, stateful
        const result = evaluateCaveat(caveat, req);
        if (!result.ok) {
          return deny("caveat-failed", result.reason, { tokenId: tokens[i].tokenId, depth: i, failedCaveat: caveat, matchedGrant });
        }
      }
    }

    // --- max-uses (stateful, dry-run against UseCounter.count) --------------
    const maxUsesChecks: Array<{ tokenId: string; depth: number; caveat: Extract<CapabilityCaveat, { kind: "max-uses" }> }> = [];
    for (let i = 0; i < tokens.length; i++) {
      for (const caveat of tokens[i].caveats) {
        if (caveat.kind !== "max-uses") continue;
        maxUsesChecks.push({ tokenId: tokens[i].tokenId, depth: i, caveat });
        if (this.useCounter) {
          const current = this.useCounter.count(tokens[i].tokenId);
          if (current + 1 > caveat.uses) {
            return deny("use-limit-exceeded", `token ${tokens[i].tokenId} has used ${current}/${caveat.uses} allowed uses`, { tokenId: tokens[i].tokenId, depth: i, failedCaveat: caveat, matchedGrant });
          }
        }
      }
    }

    // --- replay (stateful, dry-run against ReplayGuard.seen) ------------------
    const replayKey = req.nonce !== undefined ? `${leaf.tokenId}::${req.nonce}` : undefined;
    if (replayKey !== undefined && this.replayGuard) {
      if (this.replayGuard.seen(replayKey)) {
        return deny("replayed", `nonce "${req.nonce}" has already been consumed for token ${leaf.tokenId}`, { tokenId: leaf.tokenId, depth: leaf.depth });
      }
    }

    // --- everything passed: commit side effects, then allow -------------------
    if (replayKey !== undefined && this.replayGuard) {
      if (!this.replayGuard.consume(replayKey, req.at)) {
        return deny("replayed", `nonce "${req.nonce}" was consumed concurrently for token ${leaf.tokenId}`, { tokenId: leaf.tokenId, depth: leaf.depth });
      }
    }
    if (this.useCounter) {
      for (const { tokenId } of maxUsesChecks) {
        this.useCounter.increment(tokenId, req.at);
      }
    }

    return {
      allow: true,
      code: "allow",
      reason: "authorized",
      matchedGrant,
      tokenId: leaf.tokenId,
      depth: leaf.depth,
    };
  }
}

// ---------------------------------------------------------------------------
// Legacy adapter — one-way, structural only (no signature carried over: the
// legacy `CapabilityChecker` never inspects one). Existing A2A/spawn call
// sites built against `../security/tokens` can consume a gov token without
// re-implementing their own checks; caveats have no legacy representation
// and are intentionally NOT enforced by the legacy checker — that's the
// nature of a one-way adapter, not a gap in this module's own enforcement.
// ---------------------------------------------------------------------------

/** Flatten every `{resource, action}` pair in `grants` into `"resource#action"` legacy capability strings. */
function flattenGrantsToLegacyCapabilities(grants: readonly CapabilityGrant[]): string[] {
  const out: string[] = [];
  for (const g of grants) {
    for (const a of g.actions) {
      out.push(a === "*" && g.resource === "*" ? "*" : `${g.resource}#${a}`);
    }
  }
  return out;
}

export function toLegacyCapabilityToken(t: GovCapabilityToken): LegacyCapabilityToken {
  return {
    tokenId: t.tokenId,
    agentId: t.subject,
    team: t.issuer,
    capabilities: flattenGrantsToLegacyCapabilities(t.grants),
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
    signature: t.signature,
  };
}
