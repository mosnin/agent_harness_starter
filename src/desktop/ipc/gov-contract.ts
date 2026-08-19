/**
 * Hades desktop governance wire protocol (`gov.*`).
 *
 * Extension of the desktop IPC contract (`./contract.ts`) for the governance
 * stack (`src/hades/gov/**`) — the same stack `hades gov` drives from a
 * terminal, opened over the same `<dataDir>/gov` root, so the desktop app,
 * the TUI and the CLI report one ed25519 identity, one hash-chained audit
 * log, one policy document and one air-gap verdict.
 *
 *  - `gov.identity` -> `gov.identity` — this agent's PUBLIC key, its rotation
 *    generation and the self-signed document's own verdict.
 *  - `gov.audit`    -> `gov.audit`    — length, head hash and the INDEPENDENT
 *    re-verification verdict of the tamper-evident chain (with the index of
 *    the first broken entry when it is broken).
 *  - `gov.policy`   -> `gov.policy`   — the active policy's rules and digest.
 *  - `gov.tokens`   -> `gov.tokens`   — capability tokens by id/subject/grant
 *    summary and expiry. Never the token secret itself (see below).
 *  - `gov.airgap`   -> `gov.airgap`   — whether egress is currently blocked,
 *    and by what.
 *  - any failure    -> `gov.error` (never silence, never a fabricated "ok").
 *
 * ## This lane is deliberately READ-ONLY
 *
 * Every command here is a query. Minting a capability token, rotating or
 * revoking an identity key, and editing policy are **not** on this wire and
 * are not reachable from the desktop app or the TUI — they stay on `hades
 * gov`, at a terminal, where the operator is unambiguously present.
 *
 * That is a deliberate security boundary rather than an unfinished one: those
 * operations mint or invalidate long-lived authority, and a stray click in a
 * GUI is a much cheaper accident than a typed command. A renderer therefore
 * cannot escalate its own privileges through this lane no matter what it
 * sends — there is no command that grants anything.
 *
 * ## What deliberately never crosses this wire
 *
 * The ed25519 PRIVATE key, and capability token SECRETS. `GovIdentityView`
 * carries the public half only; `GovTokenView` carries a token's id, subject,
 * grant summary and expiry so a human can recognise and audit it, but never
 * the bearer material that would let a holder of this event USE it. Policy
 * is reported by rule and digest, not as a signed artifact to be replayed.
 *
 * ## What this lane will never claim
 *
 * `GovAuditView.verified` is the result of actually re-walking the hash chain,
 * not a cached flag, and `brokenAtIndex` travels with it so a renderer cannot
 * draw "audit ok" over a chain that failed at entry 12. `GovAirgapView.egressBlocked`
 * likewise reports the measured verdict; when it cannot be determined the
 * command fails with `gov.error` rather than reporting a comfortable `false`.
 *
 * This module mirrors `./trust-contract.ts`'s conventions exactly (same guard
 * shapes, same exhaustiveness assertions) and is intentionally standalone — it
 * imports nothing, so merging it into `./contract.ts`'s unions introduces no
 * coupling in either direction.
 */

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface GovIdentityView {
  /** PUBLIC key, hex. The private half never crosses this wire. */
  publicKeyHex: string;
  /** Rotation generation; 0 for an identity that has never been rotated. */
  generation: number;
  /** Where the key came from — a label, never a path and never key material. */
  keySource: "persisted" | "generated" | "env" | "ephemeral";
  /** Result of re-verifying the self-signed identity document + rotation history. */
  documentVerified: boolean;
  /** Count of public keys on the durable revocation list. */
  revokedCount: number;
  createdAt?: number;
}

export interface GovAuditView {
  /** Number of entries in the hash-chained audit log. */
  length: number;
  /** Head hash, hex. Empty string for an empty chain. */
  headHash: string;
  /** Independent re-walk of the chain — recomputed, never a cached flag. */
  verified: boolean;
  /** Index of the first entry that failed verification; absent when verified. */
  brokenAtIndex?: number;
}

export interface GovPolicyRuleView {
  id: string;
  effect: "allow" | "deny";
  /** Mirrors the engine's `PolicyRule.resources` — a rule may cover several. */
  resources: string[];
  actions: string[];
}

export interface GovPolicyView {
  rules: GovPolicyRuleView[];
  /** Digest of the active policy document, so two surfaces can be compared. */
  digest: string;
  /** True when no policy has been written and the built-in default is in force. */
  isDefault: boolean;
}

export interface GovTokenView {
  id: string;
  subject: string;
  /** Human-readable grant summary, e.g. "fs=read,write". Never bearer material. */
  grants: string[];
  /** Epoch ms; absent means the token does not expire. */
  expiresAt?: number;
  /** True when the token is past its expiry or its use budget is spent. */
  spent: boolean;
  /** True when this token only functions with egress blocked. */
  airgapOnly: boolean;
}

export interface GovAirgapView {
  /** Measured verdict: is outbound network egress currently refused? */
  egressBlocked: boolean;
  /** What enforces it, e.g. "HADES_AIRGAP=1" or "no enforcement detected". */
  enforcedBy: string;
}

// ---------------------------------------------------------------------------
// Wire unions
// ---------------------------------------------------------------------------

/**
 * Every governance command. All five are QUERIES — see the module header:
 * mint/rotate/revoke/policy-edit are intentionally absent and stay on the CLI.
 */
export type GovCommand =
  | { kind: "gov.identity" }
  | { kind: "gov.audit"; verify?: boolean }
  | { kind: "gov.policy" }
  | { kind: "gov.tokens"; subject?: string }
  | { kind: "gov.airgap" };

export type GovEvent =
  | { kind: "gov.identity"; identity: GovIdentityView; at: number }
  | { kind: "gov.audit"; audit: GovAuditView; at: number }
  | { kind: "gov.policy"; policy: GovPolicyView; at: number }
  | { kind: "gov.tokens"; tokens: GovTokenView[]; at: number }
  | { kind: "gov.airgap"; airgap: GovAirgapView; at: number }
  | { kind: "gov.error"; op: string; message: string; at: number };

export const GOV_COMMAND_KINDS = [
  "gov.identity",
  "gov.audit",
  "gov.policy",
  "gov.tokens",
  "gov.airgap",
] as const satisfies readonly GovCommand["kind"][];

export const GOV_EVENT_KINDS = [
  "gov.identity",
  "gov.audit",
  "gov.policy",
  "gov.tokens",
  "gov.airgap",
  "gov.error",
] as const satisfies readonly GovEvent["kind"][];

// Compile-time exhaustiveness in BOTH directions: a kind added to a union
// without being added to its tuple (or vice versa) fails to type-check.
type ExactlyKindsOf<Union extends string, Tuple extends readonly string[]> = [Union] extends [Tuple[number]]
  ? [Tuple[number]] extends [Union]
    ? true
    : never
  : never;

const _govCommandKindsExhaustive: ExactlyKindsOf<GovCommand["kind"], typeof GOV_COMMAND_KINDS> = true;
const _govEventKindsExhaustive: ExactlyKindsOf<GovEvent["kind"], typeof GOV_EVENT_KINDS> = true;
void _govCommandKindsExhaustive;
void _govEventKindsExhaustive;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  for (const k of Object.keys(x as object)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return false;
  }
  return true;
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isBoolean(x: unknown): x is boolean {
  return typeof x === "boolean";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || isString(x);
}

function isOptionalNumber(x: unknown): x is number | undefined {
  return x === undefined || isNumber(x);
}

function isOptionalBoolean(x: unknown): x is boolean | undefined {
  return x === undefined || isBoolean(x);
}

function isArrayOf<T>(x: unknown, guard: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every(guard);
}

export function isGovIdentityView(x: unknown): x is GovIdentityView {
  if (!isPlainObject(x)) return false;
  const src = x.keySource;
  const sourceOk = src === "persisted" || src === "generated" || src === "env" || src === "ephemeral";
  return (
    isString(x.publicKeyHex) &&
    isNumber(x.generation) &&
    sourceOk &&
    isBoolean(x.documentVerified) &&
    isNumber(x.revokedCount) &&
    isOptionalNumber(x.createdAt)
  );
}

export function isGovAuditView(x: unknown): x is GovAuditView {
  if (!isPlainObject(x)) return false;
  // A verified chain must NOT carry a break index: the two together are
  // contradictory, and letting that through would let a renderer show a
  // reassuring verdict beside a real failure.
  if (x.verified === true && x.brokenAtIndex !== undefined) return false;
  return isNumber(x.length) && isString(x.headHash) && isBoolean(x.verified) && isOptionalNumber(x.brokenAtIndex);
}

export function isGovPolicyRuleView(x: unknown): x is GovPolicyRuleView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.id) &&
    (x.effect === "allow" || x.effect === "deny") &&
    isArrayOf(x.resources, isString) &&
    isArrayOf(x.actions, isString)
  );
}

export function isGovPolicyView(x: unknown): x is GovPolicyView {
  if (!isPlainObject(x)) return false;
  return isArrayOf(x.rules, isGovPolicyRuleView) && isString(x.digest) && isBoolean(x.isDefault);
}

export function isGovTokenView(x: unknown): x is GovTokenView {
  if (!isPlainObject(x)) return false;
  return (
    isString(x.id) &&
    isString(x.subject) &&
    isArrayOf(x.grants, isString) &&
    isOptionalNumber(x.expiresAt) &&
    isBoolean(x.spent) &&
    isBoolean(x.airgapOnly)
  );
}

export function isGovAirgapView(x: unknown): x is GovAirgapView {
  if (!isPlainObject(x)) return false;
  return isBoolean(x.egressBlocked) && isString(x.enforcedBy);
}

export function isGovCommand(x: unknown): x is GovCommand {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "gov.identity":
    case "gov.policy":
    case "gov.airgap":
      return true;
    case "gov.audit":
      return isOptionalBoolean(x.verify);
    case "gov.tokens":
      return isOptionalString(x.subject);
    default:
      return false;
  }
}

export function isGovEvent(x: unknown): x is GovEvent {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "gov.identity":
      return isGovIdentityView(x.identity) && isNumber(x.at);
    case "gov.audit":
      return isGovAuditView(x.audit) && isNumber(x.at);
    case "gov.policy":
      return isGovPolicyView(x.policy) && isNumber(x.at);
    case "gov.tokens":
      return isArrayOf(x.tokens, isGovTokenView) && isNumber(x.at);
    case "gov.airgap":
      return isGovAirgapView(x.airgap) && isNumber(x.at);
    case "gov.error":
      return isString(x.op) && isString(x.message) && isNumber(x.at);
    default:
      return false;
  }
}
