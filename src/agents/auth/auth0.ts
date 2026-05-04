/**
 * Auth0 adapter.
 *
 * Works in two modes:
 *   1. Bearer token  — decodes the JWT from the Authorization header.
 *                      Works in any Node.js environment (recommended for APIs).
 *                      For production, add full JWKS verification — see comment below.
 *   2. Session cookie — reads the session set by Auth0's Next.js middleware.
 *                      Next.js only. Falls back automatically when no Bearer
 *                      token is present.
 *
 * Required env vars: AUTH0_ISSUER_BASE_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET
 * Install: npm install @auth0/nextjs-auth0
 *
 * Production JWKS verification (recommended — add jose):
 *   import { createRemoteJWKSet, jwtVerify } from "jose";
 *   const JWKS = createRemoteJWKSet(new URL(`${process.env.AUTH0_ISSUER_BASE_URL}/.well-known/jwks.json`));
 *   const { payload } = await jwtVerify(token, JWKS, { issuer: process.env.AUTH0_ISSUER_BASE_URL });
 */

import type { AuthAdapter, AuthUser } from "./types";

async function extractAuth0User(req: Request): Promise<AuthUser | null> {
  try {
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";

    if (authHeader.startsWith("Bearer ")) {
      // Mode 1: Bearer token — decode JWT payload (works in any Node.js environment).
      // This does NOT cryptographically verify the signature. For production APIs,
      // replace with JWKS verification using the `jose` package (see file header).
      const token = authHeader.slice(7);
      const [, payloadB64] = token.split(".");
      if (!payloadB64) return null;
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as Record<string, unknown>;
      if (!payload.sub) return null;
      return {
        id: payload.sub as string,
        email: (payload.email as string) ?? "",
        name: (payload.name as string) || undefined,
        imageUrl: (payload.picture as string) || undefined,
      };
    }

    // Mode 2: Session cookie — Next.js only. Gracefully skipped outside Next.js.
    try {
      const { Auth0Client } = await import("@auth0/nextjs-auth0/server");
      const client = new Auth0Client();
      const session = await client.getSession();
      if (!session?.user) return null;
      const u = session.user;
      return {
        id: (u.sub as string) ?? "",
        email: (u.email as string) ?? "",
        name: (u.name as string) || undefined,
        imageUrl: (u.picture as string) || undefined,
      };
    } catch {
      // Not in Next.js server context — no session cookie available.
      return null;
    }
  } catch {
    return null;
  }
}

export const auth0Adapter: AuthAdapter = {
  async getUser(req) {
    return extractAuth0User(req);
  },

  async requireAuth(req) {
    const user = await extractAuth0User(req);
    if (!user) {
      throw new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return user;
  },
};
