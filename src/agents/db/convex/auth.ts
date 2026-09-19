/**
 * Identity helpers for the Convex adapter and unit tests.
 *
 * Convex public functions used to take a spoofable `userId` with no
 * `ctx.auth.getUserIdentity()` check. Anyone who knew CONVEX_URL could
 * create, list, or delete another user's threads. The HTTP adapter now
 * acts as the caller (`setAdminAuth` + subject) and Convex compares
 * `identity.subject` to the row owner.
 */

export const HADES_CONVEX_ISSUER = "hades";

export interface ConvexActingIdentity {
  issuer: string;
  subject: string;
}

export function convexActingIdentity(userId: string): ConvexActingIdentity {
  if (!userId.trim()) {
    throw new Error("Convex acting identity requires userId");
  }
  return { issuer: HADES_CONVEX_ISSUER, subject: userId };
}

export function assertAuthenticated(
  identity: { subject?: string } | null | undefined
): string {
  const subject = identity?.subject?.trim();
  if (!subject) {
    throw new Error("Not authenticated");
  }
  return subject;
}

export function assertSameUser(subject: string, userId: string): void {
  if (subject !== userId) {
    throw new Error("Unauthorized");
  }
}

export function isOwnedBy(
  ownerId: string | undefined,
  subject: string
): boolean {
  return Boolean(ownerId) && ownerId === subject;
}

export function requireOwnedSubject(
  ownerId: string | undefined,
  subject: string
): void {
  if (!isOwnedBy(ownerId, subject)) {
    throw new Error("Unauthorized");
  }
}

export function convexAdminKey(env: {
  CONVEX_ADMIN_KEY?: string;
  CONVEX_DEPLOY_KEY?: string;
} = process.env): string | undefined {
  const key = env.CONVEX_ADMIN_KEY || env.CONVEX_DEPLOY_KEY;
  return key?.trim() || undefined;
}
