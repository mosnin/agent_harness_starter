/**
 * Next.js middleware — guards /chat and /api/agent routes.
 *
 * Swap auth providers by changing AUTH_PROVIDER:
 *   "clerk"  → Clerk's clerkMiddleware
 *   "auth0"  → Auth0 session check
 *   "none"   → passes through (local dev)
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_PATTERNS = [/^\/chat/, /^\/api\/agent/, /^\/api\/threads/];

function isProtected(pathname: string) {
  return PROTECTED_PATTERNS.some((p) => p.test(pathname));
}

// Clerk middleware (tree-shaken if not installed)
async function clerkMiddleware(req: NextRequest): Promise<NextResponse> {
  try {
    const { clerkMiddleware: clerk, createRouteMatcher } = await import(
      "@clerk/nextjs/server"
    );
    const isProtectedRoute = createRouteMatcher(["/chat(.*)", "/api/agent(.*)"]);
    return (await clerk((auth, req) => {
      if (isProtectedRoute(req)) auth.protect();
    })(req, {} as never)) as NextResponse;
  } catch {
    return NextResponse.next();
  }
}

export async function middleware(req: NextRequest) {
  const provider = process.env.AUTH_PROVIDER ?? "none";

  if (provider === "clerk") {
    return clerkMiddleware(req);
  }

  if (provider === "auth0" && isProtected(req.nextUrl.pathname)) {
    // Auth0 session validation happens in the route handler via auth.requireAuth()
    // Middleware just redirects to login if no session cookie present
    const sessionCookie = req.cookies.get("appSession");
    if (!sessionCookie) {
      const loginUrl = new URL("/api/auth/login", req.url);
      loginUrl.searchParams.set("returnTo", req.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"],
};
