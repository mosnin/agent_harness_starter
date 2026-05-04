/**
 * Capability tokens — scoped, short-lived credentials for agent tool access.
 *
 * A capability token grants an agent permission to use a specific set of tools
 * for a limited duration and optionally a specific run. Tokens are signed JWTs
 * (HS256 using AGENT_CAPABILITY_SECRET) and verified on each tool call.
 *
 * This implements the NHI (Non-Human Identity) principle: every agent run gets
 * its own token with the minimum tools needed — not a long-lived shared secret.
 *
 * Env:
 *   AGENT_CAPABILITY_SECRET — required for signing/verifying (min 32 chars)
 *   AGENT_CAPABILITY_DEFAULT_TTL — optional, e.g. "15m" (default: "15m")
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
  /** Exact tool names allowed. Wildcard "*" means all tools (use with care). */
  tools: string[];
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Audience — typically the agentName or service name. */
  aud?: string;
  /** Issuer — typically "agent-harness" or custom. */
  iss?: string;
}

export interface IssueTokenOptions {
  sub: string;
  runId?: string;
  agentName?: string;
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
    super(message);
    this.name = "CapabilityError";
  }
}

function getSecret(): string {
  const secret = process.env.AGENT_CAPABILITY_SECRET;
  if (!secret || secret.length < 32) {
    throw new CapabilityError(
      "AGENT_CAPABILITY_SECRET must be set and at least 32 characters long."
    );
  }
  return secret;
}

// ── Minimal HS256 JWT without a heavy dependency ──────────────────────────────

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

// ── Issue ─────────────────────────────────────────────────────────────────────

export async function issueCapabilityToken(opts: IssueTokenOptions): Promise<string> {
  const secret = getSecret();
  const ttl = opts.ttl ?? process.env.AGENT_CAPABILITY_DEFAULT_TTL ?? "15m";
  const ttlMs = parseTtlMs(ttl);

  const nowSec = Math.floor(Date.now() / 1000);
  const payload: CapabilityTokenPayload = {
    sub: opts.sub,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    tools: opts.tools,
    iat: nowSec,
    exp: ttlMs === Infinity ? nowSec + 86400 * 365 * 10 : nowSec + Math.floor(ttlMs / 1000),
    aud: opts.aud ?? opts.agentName ?? "agent-harness",
    iss: opts.iss ?? "agent-harness",
  };

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await sign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifyCapabilityToken(
  token: string,
  options?: { expectedAud?: string; expectedIss?: string }
): Promise<CapabilityTokenPayload> {
  const secret = getSecret();
  const parts = token.split(".");
  if (parts.length !== 3) throw new CapabilityError("Malformed capability token.");

  const [header, body, sig] = parts;
  const expectedSig = await sign(`${header}.${body}`, secret);
  if (!await timingSafeEqual(sig, expectedSig)) throw new CapabilityError("Capability token signature invalid.");

  let payload: CapabilityTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body));
  } catch {
    throw new CapabilityError("Capability token payload is not valid JSON.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    throw new CapabilityError(
      `Capability token expired at ${new Date(payload.exp * 1000).toISOString()}.`
    );
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
