// Development-only auth adapter — returns a fake user. Never use in production.
import type { AuthAdapter } from "./types";

export const devAuth: AuthAdapter = {
  async getUser(_req: Request) {
    return { id: "dev-user", email: "dev@localhost", name: "Dev User" };
  },
  async requireAuth(_req: Request) {
    return { id: "dev-user", email: "dev@localhost", name: "Dev User" };
  },
};
