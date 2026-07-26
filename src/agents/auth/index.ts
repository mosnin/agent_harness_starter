/**
 * Auth factory — returns the configured auth adapter.
 * Set AUTH_PROVIDER to "clerk" or "auth0" in .env.local.
 * Defaults to a null adapter (no auth) for local dev.
 *
 * Usage:
 *   import { auth } from "@/auth";
 *   const user = await auth.requireAuth(req); // throws 401 if not authenticated
 */

import type { AuthAdapter, AuthUser } from "./types";
import { config } from "../lib/config";

const nullAdapter: AuthAdapter = {
  async getUser() {
    return { id: "dev-user", email: "dev@localhost", name: "Dev User" };
  },
  async requireAuth() {
    return { id: "dev-user", email: "dev@localhost", name: "Dev User" };
  },
};

const g = globalThis as typeof globalThis & { __auth?: AuthAdapter };

function createAdapter(): AuthAdapter {
  const provider = config.auth.provider;

  switch (provider) {
    case "clerk": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { clerkAdapter } = require("./clerk");
      return clerkAdapter as AuthAdapter;
    }
    case "auth0": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { auth0Adapter } = require("./auth0");
      return auth0Adapter as AuthAdapter;
    }
    default:
      console.info("[auth] No AUTH_PROVIDER set — using null adapter (dev-user for all requests)");
      return nullAdapter;
  }
}

export const auth: AuthAdapter = g.__auth ?? (g.__auth = createAdapter());

export type { AuthAdapter, AuthUser } from "./types";
