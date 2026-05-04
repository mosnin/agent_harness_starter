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

import { SignJWT, jwtVerify, importPKCS8, importSPKI, errors as joseErrors } from "jose";
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
  constructor(message: string, code = "SECURITY_CAPABILITY_ERROR") {
    super(message, code, "Verify the capability token is valid, not expired, and issued for this agent.");
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

// ── Issue ─────────────────────────────────────────────────────────────────────

export async function issueCapabilityToken(opts: IssueTokenOptions): Promise<string> {
  const alg = detectAlgorithm();
  const ttl = opts.ttl ?? process.env.AGENT_CAPABILITY_DEFAULT_TTL ?? "15m";
  const ttlMs = parseTtlMs(ttl);

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = ttlMs === Infinity ? nowSec + 86400 * 365 * 10 : nowSec + Math.floor(ttlMs / 1000);

  // Custom claims to embed in the payload
  const customClaims: Record<string, unknown> = {
    tools: opts.tools,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.agentName ? { agentName: opts.agentName } : {}),
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
  };

  const aud = opts.aud ?? opts.agentName ?? "agent-harness";
  const iss = opts.iss ?? "agent-harness";

  const builder = new SignJWT(customClaims)
    .setProtectedHeader({ alg, typ: "JWT" })
    .setSubject(opts.sub)
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(expSec)
    .setAudience(aud)
    .setIssuer(iss)
    .setJti(crypto.randomUUID());

  if (alg === "RS256") {
    const privateKey = await importPKCS8(process.env.AGENT_CAPABILITY_PRIVATE_KEY!, "RS256");
    return builder.sign(privateKey);
  } else {
    const secret = new TextEncoder().encode(getSecret());
    return builder.sign(secret);
  }
}

// ── JTI revocation store ──────────────────────────────────────────────────────

// In-process JTI revocation store. Works for single-instance deployments.
// For multi-instance or serverless deployments, replace with a shared store:
//   Redis: await redis.setex(`jti:${jti}`, ttlSeconds, "1")
//   or use short-lived tokens (ttl ≤ 5 min) and skip revocation entirely.
const usedJtis = new Map<string, number>(); // jti → expiry epoch ms

export function revokeToken(jti: string, expiresAt?: number): void {
  // Default TTL: 1 hour from now if no expiry given
  usedJtis.set(jti, expiresAt ?? Date.now() + 3600_000);
}

export function isTokenRevoked(jti: string): boolean {
  const exp = usedJtis.get(jti);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    usedJtis.delete(jti); // evict expired entry
    return false;
  }
  return true;
}

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifyCapabilityToken(
  token: string,
  options?: { expectedAud?: string; expectedIss?: string; expectedOrgId?: string }
): Promise<CapabilityTokenPayload> {
  // Peek at the header to enforce algorithm expectations before jose verifies.
  const parts = token.split(".");
  if (parts.length !== 3) throw new CapabilityError("Malformed capability token.", "CAPABILITY_MALFORMED_TOKEN");

  let parsedHeader: { alg?: string; typ?: string };
  try {
    parsedHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new CapabilityError("Capability token header is not valid JSON.", "CAPABILITY_MALFORMED_TOKEN");
  }

  const expectedAlg = detectAlgorithm();
  if (parsedHeader.alg !== expectedAlg) {
    throw new CapabilityError("Token algorithm mismatch", "CAPABILITY_ALGORITHM_MISMATCH");
  }

  // Build jose verify options — jose natively validates exp, nbf, aud, iss.
  // Passing audience/issuer here causes jose to enforce them (algorithm confusion impossible).
  const verifyOpts: Parameters<typeof jwtVerify>[2] = {
    algorithms: [expectedAlg],
    ...(options?.expectedAud !== undefined ? { audience: options.expectedAud } : {}),
    ...(options?.expectedIss !== undefined ? { issuer: options.expectedIss } : {}),
  };

  let rawPayload: Record<string, unknown>;
  try {
    if (expectedAlg === "RS256") {
      const publicKey = await importSPKI(process.env.AGENT_CAPABILITY_PUBLIC_KEY!, "RS256");
      const { payload } = await jwtVerify(token, publicKey, verifyOpts);
      rawPayload = payload as Record<string, unknown>;
    } else {
      const secret = new TextEncoder().encode(getSecret());
      const { payload } = await jwtVerify(token, secret, verifyOpts);
      rawPayload = payload as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof CapabilityError) throw err;

    if (err instanceof joseErrors.JWTExpired) {
      const expSec = (err as unknown as { payload?: { exp?: number } }).payload?.exp;
      const expDate = expSec ? new Date(expSec * 1000).toISOString() : "unknown";
      throw new CapabilityError(
        `Capability token expired at ${expDate}.`,
        "CAPABILITY_TOKEN_EXPIRED"
      );
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("nbf")) {
        throw new CapabilityError(
          `Token not yet valid: "nbf" claim timestamp check failed`,
          "CAPABILITY_TOKEN_NOT_YET_VALID"
        );
      }
      if (msg.includes("aud") || msg.includes("audience")) {
        let actualAud: string | undefined;
        try {
          const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
          actualAud = Array.isArray(p.aud) ? p.aud[0] : p.aud;
        } catch { /* ignore */ }
        throw new CapabilityError(
          `Token audience mismatch: expected "${options?.expectedAud}", got "${actualAud ?? "none"}"`,
          "CAPABILITY_AUDIENCE_MISMATCH"
        );
      }
      if (msg.includes("iss") || msg.includes("issuer")) {
        let actualIss: string | undefined;
        try {
          const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
          actualIss = p.iss;
        } catch { /* ignore */ }
        throw new CapabilityError(
          `Capability token issuer "${actualIss}" does not match expected "${options?.expectedIss}".`,
          "CAPABILITY_ISSUER_MISMATCH"
        );
      }
      throw new CapabilityError(
        `Capability token claim validation failed: ${msg}`,
        "CAPABILITY_CLAIM_VALIDATION_FAILED"
      );
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed || err instanceof joseErrors.JWSInvalid) {
      throw new CapabilityError("Capability token signature invalid.", "CAPABILITY_INVALID_SIGNATURE");
    }
    if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JOSEError) {
      throw new CapabilityError(`Capability token invalid: ${(err as Error).message}`, "CAPABILITY_MALFORMED_TOKEN");
    }
    throw new CapabilityError(`Capability token verification failed: ${(err as Error).message}`, "CAPABILITY_MALFORMED_TOKEN");
  }

  // Reconstruct the typed payload from the verified jose payload.
  // jose normalises aud to string[] — unwrap single-element arrays.
  const audValue = rawPayload.aud !== undefined
    ? (Array.isArray(rawPayload.aud) ? (rawPayload.aud as string[])[0] : rawPayload.aud as string)
    : undefined;

  const payload: CapabilityTokenPayload = {
    sub: rawPayload.sub as string,
    tools: rawPayload.tools as string[],
    iat: rawPayload.iat as number,
    exp: rawPayload.exp as number,
    ...(rawPayload.nbf !== undefined ? { nbf: rawPayload.nbf as number } : {}),
    ...(rawPayload.runId !== undefined ? { runId: rawPayload.runId as string } : {}),
    ...(rawPayload.agentName !== undefined ? { agentName: rawPayload.agentName as string } : {}),
    ...(rawPayload.orgId !== undefined ? { orgId: rawPayload.orgId as string } : {}),
    ...(audValue !== undefined ? { aud: audValue } : {}),
    ...(rawPayload.iss !== undefined ? { iss: rawPayload.iss as string } : {}),
    ...(rawPayload.jti !== undefined ? { jti: rawPayload.jti as string } : {}),
  };

  // Explicit-revocation model: tokens are valid until expiry unless explicitly revoked
  // via revokeToken(jti). This does NOT prevent replay of live tokens — it only blocks
  // tokens that were deliberately invalidated (e.g. on logout or key rotation).
  if (payload.jti && isTokenRevoked(payload.jti)) {
    throw new CapabilityError(`Token has been revoked (jti: ${payload.jti})`, "CAPABILITY_TOKEN_REVOKED");
  }

  if (options?.expectedOrgId !== undefined && payload.orgId !== options.expectedOrgId) {
    throw new CapabilityError(
      `Token org mismatch: expected "${options.expectedOrgId}", got "${payload.orgId ?? "none"}"`,
      "CAPABILITY_ORG_MISMATCH"
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
  options?: { expectedAud?: string; expectedIss?: string; expectedOrgId?: string }
): Promise<{ sub: string; tools: string[] }> {
  const payload = await verifyCapabilityToken(token, options);

  if (runId && payload.runId && payload.runId !== runId) {
    throw new CapabilityError(
      `Capability token is scoped to run "${payload.runId}", not "${runId}".`
    );
  }

  if (payload.tools.length === 0) {
    throw new CapabilityError("Capability token grants no tools.", "CAPABILITY_NO_TOOLS");
  }

  return { sub: payload.sub, tools: payload.tools };
}

/**
 * Assert that a resolved tools list contains the requested tool.
 * Throws CapabilityError with CAPABILITY_TOOL_NOT_ALLOWED if not found.
 */
export function assertToolAllowed(tools: string[], toolName: string): void {
  if (tools[0] !== "*" && !tools.includes(toolName)) {
    throw new CapabilityError(
      `Tool "${toolName}" is not in the capability token scope.`,
      "CAPABILITY_TOOL_NOT_ALLOWED"
    );
  }
}
