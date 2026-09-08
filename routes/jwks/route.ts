/**
 * DROP THIS FILE INTO: your-app/src/app/api/jwks/route.ts
 *
 * Publishes the RS256 public key used to sign capability tokens.
 *
 * This is load-bearing, not decorative: `cap-runner` verifies every command's capability
 * token against this endpoint rather than trusting the WebSocket it arrived on, so a
 * compromised transport still cannot exceed the granted scopes. Without it the runner has no
 * way to check a token and must refuse every command.
 *
 * Returns 404 in HS256 mode (no AGENT_CAPABILITY_PUBLIC_KEY) — a symmetric secret has no
 * public half to publish. Set AGENT_CAPABILITY_PRIVATE_KEY + AGENT_CAPABILITY_PUBLIC_KEY for
 * any deployment where the issuer and the verifier are different processes.
 */

import { createJwksHandler } from "@/agents/security/jwks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createJwksHandler();
