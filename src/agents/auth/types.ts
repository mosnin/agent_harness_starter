/** Normalized user object returned by all auth adapters. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Auth adapter interface.
 * Every adapter provides these two methods:
 *
 *  - `getUser(req)` — returns the authenticated user or null (never throws)
 *  - `requireAuth(req)` — returns the user or throws a 401 Response
 */
export interface AuthAdapter {
  getUser(req: Request): Promise<AuthUser | null>;
  requireAuth(req: Request): Promise<AuthUser>;
}
