// Development-only DB adapter — uses in-memory maps. Never use in production.
import { createMemoryAdapter } from "./memory";

export const devDb = createMemoryAdapter();
