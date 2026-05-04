/**
 * Capability tokens — scoped, short-lived credentials for agent tool access.
 *
 * A capability token grants an agent permission to use a specific set of tools
 * for a limited duration and optionally a specific run. Tokens are signed JWTs
 * and verified on each tool call.
 *
 * This implements the NHI (Non-Human Identity) principle: every agent run gets
 * its own token with the minimum tools needed — not a long-lived shared secret.
 *
 * Security note: HS256 uses a symmetric secret — anyone with AGENT_CAPABILITY_SECRET
 * can forge tokens. For production deployments where the issuer and verifier are
 * separate services, use RS256 by setting AGENT_CAPABILITY_PRIVATE_KEY and
 * AGENT_CAPABILITY_PUBLIC_KEY instead.
 *
 * Env:
 *   AGENT_CAPABILITY_SECRET        — required for HS256 signing/verifying (min 32 chars)
 *   AGENT_CAPABILITY_PRIVATE_KEY   — PEM private key; enables RS256 when set with PUBLIC_KEY
 *   AGENT_CAPABILITY_PUBLIC_KEY    — PEM public key; enables RS256 when set with PRIVATE_KEY
 *   AGENT_CAPABILITY_DEFAULT_TTL   — optional, e.g. "15m" (default: "15m")
 *
 * Usage:
 *   const token = await issueCapabilityToken({
 *     sub: userId,
 *     runId,
 *     tools: ["web_search", "browser_scrape"],
 *     ttl: "10m",
 *   });
 *
 *   const caps = await verifyCapabilityToken(token);
 *   if (!caps.tools.includes("shell_exec")) throw new Error("not authorized");
 */

import { parseTtlMs } from "../memory/anchors";
import { SecurityError } from "../errors";

export interface CapabilityTokenPayload {
  /** Subject — typically userId or serviceAccountId. */
  sub: string;
  /** Run that this token is scoped to (optional but recommended). */
  runId?: string;
  /** Agent name this token is scoped to (optional). */
  agentName?: string;
  /** Organisation/tenant ID — scopes the token to a specific org. */
  orgId?: string;
  /** Exact tool names allowed. Wildcard "*" means all tools (use with care). */
  tools: string[];
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Not-before (seconds since epoch) — token is invalid before this time. */
  nbf?: number;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Audience — typically the agentName or service name. */
  aud?: string;
  /** Issuer — typically "agent-harness" or custom. */
  iss?: string;
  /** JWT ID — unique token identifier for replay prevention. */
  jti?: string;
}

export interface IssueTokenOptions {
  sub: string;
  runId?: string;
  agentName?: string;
  /** Organisation/tenant ID — included in the token payload when provided. */
  orgId?: string;
  tools: string[];
  /** Duration: "5m", "1h", etc. Default: AGENT_CAPABILITY_DEFAULT_TTL or "15m". */
  ttl?: string;
  /** Audience — if omitted, defaults to agentName if set, else "agent-harness". */
  aud?: string;
  /** Issuer — if omitted, defaults to "agent-harness". */
  iss?: string;
}

export class CapabilityError extends SecurityError {
  constructor(message: string) {
    super(message, "SECURITY_CAPABILITY_ERROR", "Verify the capability token is valid, not expired, and issued for this agent.");
    this.name = "CapabilityError";
  }
}

// ── Algorithm detection ───────────────────────────────────────────────────────

type TokenAlgorithm = "HS256" | "RS256";

function detectAlgorithm(): TokenAlgorithm {
  if (process.env.AGENT_CAPABILITY_PRIVATE_KEY && process.env.AGENT_CAPABILITY_PUBLIC_KEY) {
    return "RS256";
  }
  return "HS256";
}

function getSecret(): string {
  const secret = process.env.AGENT_CAPABILITY_SECRET;
  if (!secret || secret.length < 32) {
    throw new CapabilityError(
      "AGENT_CAPABILITY_SECRET must be set and at least 32 characters long. " +
      "Alternatively, set AGENT_CAPABILITY_PRIVATE_KEY + AGENT_CAPABILITY_PUBLIC_KEY for RS256 (recommended for production)."
    );
  }
  return secret;
}

// ── Minimal JWT crypto without a heavy dependency ────────────────────────────

function b64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function fromB64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

async function sign(payload: string, secret: string): Promise<string> {
  const { createHmac } = await import("crypto");
  return b64url(createHmac("sha256", secret).update(payload).digest().toString("binary"));
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const { timingSafeEqual: tse } = await import("crypto");
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return tse(aBytes, bBytes);
}

async function signRS256(payload: string): Promise<string> {
  const privateKeyPem = process.env.AGENT_CAPABILITY_PRIVATE_KEY!;
  const { createSign } = await import("crypto");
  const sig = createSign("RSA-SHA256").update(payload).sign(privateKeyPem);
  return sig.toString("base64url");
}

async function verifyRS256(payload: string, sig: string): Promise<boolean> {
  const publicKeyPem = process.env.AGENT_CAPABILITY_PUBLIC_KEY!;
  const { createVerify } = await import("crypto");
  const sigBuf = Buffer.from(sig, "base64url");
  return createVerify("RSA-SHA256").update(payload).verify(publicKeyPem, sigBuf);
}

// ── Issue ─────────────────────────────────────────────────────────────────────

export async function issueCapabilityToken(opts: IssueTokenOptions): Promise<string> {
  const alg = detectAlgorithm();
  const ttl = opts.ttl ?? process.env.AGENT_CAPABILITY_DEFAULT_TTL ?? "15m";
  const ttlMs = parseTtlMs(ttl);

  const nowSec = Math.floor(Date.now() / 1000);
  const payload: CapabilityTokenPayload = {
    sub: opts.sub,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
    tools: opts.tools,
    iat: nowSec,
    nbf: nowSec,
    exp: ttlMs === Infinity ? nowSec + 86400 * 365 * 10 : nowSec + Math.floor(ttlMs / 1000),
    aud: opts.aud ?? opts.agentName ?? "agent-harness",
    iss: opts.iss ?? "agent-harness",
    jti: crypto.randomUUID(),
  };

  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = alg === "RS256"
    ? await signRS256(`${header}.${body}`)
    : await sign(`${header}.${body}`, getSecret());
  return `${header}.${body}.${sig}`;
}

// ── JTI revocation store ──────────────────────────────────────────────────────

// Simple in-process jti store. Replace with Redis in production.
const usedJtis = new Set<string>();

export function revokeToken(jti: string): void {
  usedJtis.add(jti);
}

export function isTokenRevoked(jti: string): boolean {
  return usedJtis.has(jti);
}

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifyCapabilityToken(
  token: string,
  options?: { expectedAud?: string; expectedIss?: string; expectedOrgId?: string }
): Promise<CapabilityTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new CapabilityError("Malformed capability token.");

  const [header, body, sig] = parts;

  let parsedHeader: { alg?: string; typ?: string };
  try {
    parsedHeader = JSON.parse(fromB64url(header));
  } catch {
    throw new CapabilityError("Capability token header is not valid JSON.");
  }

  const expectedAlg = detectAlgorithm();
  if (parsedHeader.alg !== expectedAlg) {
    throw new CapabilityError("Token algorithm mismatch");
  }

  const alg = expectedAlg;

  if (alg === "RS256") {
    const valid = await verifyRS256(`${header}.${body}`, sig);
    if (!valid) throw new CapabilityError("Capability token signature invalid.");
  } else {
    const expectedSig = await sign(`${header}.${body}`, getSecret());
    if (!await timingSafeEqual(sig, expectedSig)) throw new CapabilityError("Capability token signature invalid.");
  }

  let payload: CapabilityTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body));
  } catch {
    throw new CapabilityError("Capability token payload is not valid JSON.");
  }

  if (payload.jti && isTokenRevoked(payload.jti)) {
    throw new CapabilityError("Token has been revoked");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    throw new CapabilityError(
      `Capability token expired at ${new Date(payload.exp * 1000).toISOString()}.`
    );
  }

  if (payload.nbf !== undefined && payload.nbf > nowSec) {
    throw new CapabilityError("Token not yet valid");
  }

  if (options?.expectedAud !== undefined && payload.aud !== options.expectedAud) {
    throw new CapabilityError(
      `Capability token audience "${payload.aud}" does not match expected "${options.expectedAud}".`
    );
  }

  if (options?.expectedIss !== undefined && payload.iss !== options.expectedIss) {
    throw new CapabilityError(
      `Capability token issuer "${payload.iss}" does not match expected "${options.expectedIss}".`
    );
  }

  if (options?.expectedOrgId !== undefined && payload.orgId !== options.expectedOrgId) {
    throw new CapabilityError("Token org mismatch");
  }

  return payload;
}

// ── Plugin-compatible capability checker ─────────────────────────────────────

/**
 * Verify a capability token and return an allow-list policy context.
 * Throws CapabilityError if the token is invalid/expired.
 */
export async function resolveToolsFromToken(
  token: string,
  runId?: string,
  options?: { expectedAud?: string; expectedIss?: string }
): Promise<{ sub: string; tools: string[] }> {
  const payload = await verifyCapabilityToken(token, options);

  if (runId && payload.runId && payload.runId !== runId) {
    throw new CapabilityError(
      `Capability token is scoped to run "${payload.runId}", not "${runId}".`
    );
  }

  return { sub: payload.sub, tools: payload.tools };
}
