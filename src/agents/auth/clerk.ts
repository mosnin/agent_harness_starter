/**
 * Clerk auth adapter.
 *
 * Works in two modes:
 *   1. Bearer token  — reads the JWT from the Authorization header.
 *                      Works in any Node.js environment (recommended for APIs).
 *   2. Session cookie — reads the session set by Clerk's middleware.
 *                      Next.js only. Falls back automatically when no Bearer
 *                      token is present.
 *
 * Required env vars: CLERK_SECRET_KEY
 * Optional:          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (Next.js middleware only)
 *
 * Install: npm install @clerk/nextjs
 */

import type { AuthAdapter, AuthUser } from "./types";

async function extractClerkUser(req: Request): Promise<AuthUser | null> {
  try {
    const { createClerkClient, verifyToken } = await import("@clerk/nextjs/server");
    const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    let userId: string | null = null;

    // Mode 1: Authorization: Bearer <token> — works in any Node.js environment.
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      userId = payload.sub ?? null;
    } else {
      // Mode 2: Session cookie — Next.js only. Gracefully skipped outside Next.js.
      try {
        const { auth } = await import("@clerk/nextjs/server");
        const authObj = await auth();
        userId = authObj?.userId ?? null;
      } catch {
        // Not in Next.js server context — no session cookie available.
      }
    }

    if (!userId) return null;

    const user = await clerkClient.users.getUser(userId);
    const email = user.emailAddresses[0]?.emailAddress ?? "";
    return {
      id: userId,
      email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
      imageUrl: user.imageUrl || undefined,
    };
  } catch {
    return null;
  }
}

export const clerkAdapter: AuthAdapter = {
  async getUser(req) {
    return extractClerkUser(req);
  },

  async requireAuth(req) {
    const user = await extractClerkUser(req);
    if (!user) {
      throw new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return user;
  },
};
