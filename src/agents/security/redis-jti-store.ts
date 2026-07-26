/**
 * Redis JTI (JWT ID) store — durable token revocation for serverless environments.
 *
 * The default in-memory JTI store loses revocations on process restart.
 * This adapter persists revocations in Redis, surviving cold starts.
 *
 * Usage:
 *   import { createRedisJtiStore, setJtiStore } from "@/agents/security/redis-jti-store";
 *   import Redis from "ioredis"; // or @upstash/redis
 *
 *   const redis = new Redis(process.env.REDIS_URL);
 *   setJtiStore(createRedisJtiStore(redis));
 *
 * The store is compatible with any Redis client that implements the
 * minimal RedisClient interface (set with EX, get, del).
 */

/** Minimal Redis client interface — compatible with ioredis and @upstash/redis. */
export interface RedisClient {
  set(key: string, value: string, expiryMode: "EX", time: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface JtiStore {
  /** Mark a JTI as revoked. ttlSeconds: how long to keep the entry (matches token expiry). */
  revoke(jti: string, ttlSeconds: number): Promise<void>;
  /** Return true if the JTI has been explicitly revoked. */
  isRevoked(jti: string): Promise<boolean>;
}

const JTI_KEY_PREFIX = "agent-harness:jti-revoked:";

/**
 * Create a Redis-backed JTI store.
 * Token revocations are stored with TTL matching the token expiry,
 * so the store self-cleans without a background sweep.
 */
export function createRedisJtiStore(redis: RedisClient): JtiStore {
  return {
    async revoke(jti: string, ttlSeconds: number): Promise<void> {
      await redis.set(`${JTI_KEY_PREFIX}${jti}`, "1", "EX", ttlSeconds);
    },
    async isRevoked(jti: string): Promise<boolean> {
      const val = await redis.get(`${JTI_KEY_PREFIX}${jti}`);
      return val !== null;
    },
  };
}

// ── Module-level store (defaults to undefined = in-memory fallback) ──────────

let _jtiStore: JtiStore | undefined;

/**
 * Replace the global JTI store used by revokeToken / isTokenRevoked.
 * Call once at application startup before any tokens are issued.
 *
 * @example
 *   setJtiStore(createRedisJtiStore(new Redis(process.env.REDIS_URL)));
 */
export function setJtiStore(store: JtiStore): void {
  _jtiStore = store;
}

/** Get the current JTI store (undefined = in-memory Map is used). */
export function getJtiStore(): JtiStore | undefined {
  return _jtiStore;
}
