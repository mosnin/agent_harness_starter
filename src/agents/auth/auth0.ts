/**
 * Auth0 adapter.
 * Requires @auth0/nextjs-auth0 installed and AUTH0_* env vars set.
 * Docs: https://auth0.github.io/nextjs-auth0
 */

import type { AuthAdapter, AuthUser } from "./types";

async function extractAuth0User(_req: Request): Promise<AuthUser | null> {
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
