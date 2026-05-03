/**
 * Clerk auth adapter.
 * Requires @clerk/nextjs installed and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY set.
 * Docs: https://clerk.com/docs/references/nextjs
 */

import type { AuthAdapter, AuthUser } from "./types";

async function extractClerkUser(req: Request): Promise<AuthUser | null> {
  try {
    const { createClerkClient } = await import("@clerk/nextjs/server");
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    const { auth } = await import("@clerk/nextjs/server");
    const authObj = await auth();
    const userId = authObj?.userId;
    if (!userId) return null;

    const user = await clerk.users.getUser(userId);
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
