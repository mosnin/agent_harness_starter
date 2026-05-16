/**
 * JWKS (JSON Web Key Set) support for RS256 capability token verification.
 *
 * Exposes the current public key in JWKS format so distributed verifiers
 * can rotate keys without redeploying. Use createJwksHandler() to mount
 * a /.well-known/jwks.json endpoint in your Next.js app.
 *
 * Usage — add to src/app/api/jwks/route.ts:
 *   import { createJwksHandler } from "@/agents/security/jwks";
 *   export const GET = createJwksHandler();
 *
 * Verifying in another service:
 *   import { createRemoteJWKSet, jwtVerify } from "jose";
 *   const JWKS = createRemoteJWKSet(new URL("https://yourapp.com/api/jwks"));
 *   const { payload } = await jwtVerify(token, JWKS, { algorithms: ["RS256"] });
 */

import { importSPKI, exportJWK } from "jose";

export interface JwksKey {
  kty: string;
  use: string;
  alg: string;
  kid: string;
  [key: string]: unknown;
}

export interface JwksDocument {
  keys: JwksKey[];
}

/**
 * Build the JWKS document from the current AGENT_CAPABILITY_PUBLIC_KEY env var.
 * Returns null if RS256 is not configured (HS256 mode).
 */
export async function buildJwks(): Promise<JwksDocument | null> {
  const pemPublicKey = process.env.AGENT_CAPABILITY_PUBLIC_KEY;
  if (!pemPublicKey) return null;

  try {
    const key = await importSPKI(pemPublicKey, "RS256");
    const jwk = await exportJWK(key);
    return {
      keys: [{
        ...jwk,
        kty: jwk.kty ?? "RSA",
        use: "sig",
        alg: "RS256",
        kid: process.env.AGENT_CAPABILITY_KEY_ID ?? "default",
      } as JwksKey],
    };
  } catch {
    return null;
  }
}

/**
 * Create a Next.js route handler that serves the JWKS document.
 * Mount at src/app/api/jwks/route.ts as: export const GET = createJwksHandler();
 */
export function createJwksHandler() {
  return async function GET(): Promise<Response> {
    const jwks = await buildJwks();
    if (!jwks) {
      return new Response(
        JSON.stringify({ error: "RS256 not configured. Set AGENT_CAPABILITY_PUBLIC_KEY." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify(jwks), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600", // keys rotate infrequently
      },
    });
  };
}
