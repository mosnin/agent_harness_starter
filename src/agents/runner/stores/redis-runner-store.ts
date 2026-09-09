/**
 * Redis-backed `RunnerStore` — pairing codes, runner records and session state that survive a
 * process restart and are visible to every instance behind the load balancer.
 *
 * Follows the `security/redis-jti-store.ts` idiom: a narrow structural client interface plus a
 * `create…Store(client)` factory, so the harness never depends on a particular Redis package.
 * `@upstash/redis` and `ioredis` both fit through the adapters at the bottom of this file.
 *
 *   import { Redis } from "@upstash/redis";
 *   import { createRedisRunnerStore, fromUpstashRedis } from "@/agents/runner/stores";
 *   import { setRunnerStore } from "@/agents/runner/registry";
 *
 *   setRunnerStore(createRedisRunnerStore(fromUpstashRedis(Redis.fromEnv())));
 *
 * Guarantees this store adds over `InMemoryRunnerStore`:
 *   - pairing records carry a real key TTL, so a code expires even if nothing ever polls it;
 *   - a device code is single-use across instances — the claim is a `SET … NX`, which Redis
 *     resolves for exactly one caller no matter how many racing pollers there are;
 *   - session records outlive the process that opened them, so a kill switch pressed against
 *     instance B ends a session opened by instance A.
 */

import type {
	PairingRequest,
	RunnerRecord,
	RunnerSessionRecord,
	RunnerStore,
} from "../registry";

export interface RunnerRedisSetOptions {
	/** Expire the key after this many seconds. Omit for no expiry. */
	ttlSeconds?: number;
	/** Write only when the key is absent. The returned boolean reports whether the write happened. */
	ifNotExists?: boolean;
}

/**
 * The whole Redis surface this store needs. Implement it directly, or wrap a real client with
 * `fromUpstashRedis` / `fromIoRedis`. `set` MUST be atomic with respect to `ifNotExists`: the
 * single-use property of a device code rests on exactly one caller seeing `true`.
 */
export interface RunnerRedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, options?: RunnerRedisSetOptions): Promise<boolean>;
	del(key: string): Promise<void>;
	sadd(key: string, member: string): Promise<void>;
	srem(key: string, member: string): Promise<void>;
	smembers(key: string): Promise<string[]>;
}

export interface RedisRunnerStoreOptions {
	/** Namespace for every key this store writes. */
	keyPrefix?: string;
	/**
	 * Extra seconds a pairing record and its single-use marker are kept past `expiresAt`, so a
	 * runner that polls late is told "expired" rather than "unknown device code", and so a code
	 * cannot become claimable again merely by having expired.
	 */
	pairingGraceSeconds?: number;
	/** How long an ended or expired session record is kept for the audit trail. */
	sessionRetentionSeconds?: number;
	now?: () => number;
}

const DEFAULT_KEY_PREFIX = "agent-harness:runner:";
const DEFAULT_PAIRING_GRACE_SECONDS = 15 * 60;
const DEFAULT_SESSION_RETENTION_SECONDS = 24 * 60 * 60;

function ttlFrom(expiresAtUnixMs: number, nowUnixMs: number, graceSeconds: number): number {
	const remaining = Math.ceil((expiresAtUnixMs - nowUnixMs) / 1000);
	return Math.max(1, remaining + graceSeconds);
}

function parse<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export function createRedisRunnerStore(
	redis: RunnerRedisClient,
	options: RedisRunnerStoreOptions = {},
): RunnerStore {
	const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
	const pairingGraceSeconds = options.pairingGraceSeconds ?? DEFAULT_PAIRING_GRACE_SECONDS;
	const sessionRetentionSeconds =
		options.sessionRetentionSeconds ?? DEFAULT_SESSION_RETENTION_SECONDS;
	const now = options.now ?? (() => Date.now());

	const runnerKey = (runnerId: string) => `${prefix}runner:${runnerId}`;
	const runnerIndexKey = `${prefix}runners`;
	const runnerUserIndexKey = (userId: string) => `${prefix}runners:user:${userId}`;
	const pairingKey = (deviceCode: string) => `${prefix}pairing:device:${deviceCode}`;
	const userCodeKey = (userCode: string) => `${prefix}pairing:user:${userCode}`;
	const claimKey = (deviceCode: string) => `${prefix}pairing:claimed:${deviceCode}`;
	const sessionKey = (sessionId: string) => `${prefix}session:${sessionId}`;
	const sessionIndexKey = `${prefix}sessions`;
	const sessionRunnerIndexKey = (runnerId: string) => `${prefix}sessions:runner:${runnerId}`;
	const sessionRunIndexKey = (runId: string) => `${prefix}sessions:run:${runId}`;
	const sessionUserIndexKey = (userId: string) => `${prefix}sessions:user:${userId}`;

	/**
	 * Index sets outlive the TTL'd records they point at, so a read prunes ids that no longer
	 * resolve instead of returning holes. This is the only cleanup the store needs — everything
	 * else self-expires.
	 */
	async function readIndexed<T>(
		indexKey: string,
		keyFor: (id: string) => string,
	): Promise<T[]> {
		const ids = await redis.smembers(indexKey);
		const found: T[] = [];
		for (const id of ids) {
			const record = parse<T>(await redis.get(keyFor(id)));
			if (record === null) {
				await redis.srem(indexKey, id);
				continue;
			}
			found.push(record);
		}
		return found;
	}

	return {
		async saveRunner(record: RunnerRecord): Promise<void> {
			await redis.set(runnerKey(record.runnerId), JSON.stringify(record));
			await redis.sadd(runnerIndexKey, record.runnerId);
			await redis.sadd(runnerUserIndexKey(record.userId), record.runnerId);
		},

		async getRunner(runnerId: string): Promise<RunnerRecord | null> {
			return parse<RunnerRecord>(await redis.get(runnerKey(runnerId)));
		},

		async listRunners(userId?: string): Promise<RunnerRecord[]> {
			return readIndexed<RunnerRecord>(
				userId ? runnerUserIndexKey(userId) : runnerIndexKey,
				runnerKey,
			);
		},

		async deleteRunner(runnerId: string): Promise<void> {
			const existing = parse<RunnerRecord>(await redis.get(runnerKey(runnerId)));
			await redis.del(runnerKey(runnerId));
			await redis.srem(runnerIndexKey, runnerId);
			if (existing) await redis.srem(runnerUserIndexKey(existing.userId), runnerId);
		},

		async savePairing(request: PairingRequest): Promise<void> {
			const ttlSeconds = ttlFrom(request.expiresAt, now(), pairingGraceSeconds);
			await redis.set(pairingKey(request.deviceCode), JSON.stringify(request), { ttlSeconds });
			await redis.set(userCodeKey(request.userCode), request.deviceCode, { ttlSeconds });
		},

		async getPairingByUserCode(userCode: string): Promise<PairingRequest | null> {
			const deviceCode = await redis.get(userCodeKey(userCode));
			if (deviceCode === null) return null;
			return parse<PairingRequest>(await redis.get(pairingKey(deviceCode)));
		},

		async getPairingByDeviceCode(deviceCode: string): Promise<PairingRequest | null> {
			return parse<PairingRequest>(await redis.get(pairingKey(deviceCode)));
		},

		async deletePairing(deviceCode: string): Promise<void> {
			const existing = parse<PairingRequest>(await redis.get(pairingKey(deviceCode)));
			await redis.del(pairingKey(deviceCode));
			if (existing) await redis.del(userCodeKey(existing.userCode));
		},

		async markPairingClaimed(deviceCode: string): Promise<boolean> {
			const request = parse<PairingRequest>(await redis.get(pairingKey(deviceCode)));
			if (!request) return false;
			const ttlSeconds = ttlFrom(request.expiresAt, now(), pairingGraceSeconds);
			const won = await redis.set(claimKey(deviceCode), "1", {
				ttlSeconds,
				ifNotExists: true,
			});
			if (!won) return false;
			await redis.set(
				pairingKey(deviceCode),
				JSON.stringify({ ...request, status: "claimed" }),
				{ ttlSeconds },
			);
			return true;
		},

		async saveSession(record: RunnerSessionRecord): Promise<void> {
			const ttlSeconds = ttlFrom(record.expiresAt, now(), sessionRetentionSeconds);
			await redis.set(sessionKey(record.sessionId), JSON.stringify(record), { ttlSeconds });
			await redis.sadd(sessionIndexKey, record.sessionId);
			await redis.sadd(sessionRunnerIndexKey(record.runnerId), record.sessionId);
			await redis.sadd(sessionRunIndexKey(record.runId), record.sessionId);
			await redis.sadd(sessionUserIndexKey(record.userId), record.sessionId);
		},

		async getSession(sessionId: string): Promise<RunnerSessionRecord | null> {
			return parse<RunnerSessionRecord>(await redis.get(sessionKey(sessionId)));
		},

		async listSessions(filter?: {
			runnerId?: string;
			runId?: string;
			userId?: string;
		}): Promise<RunnerSessionRecord[]> {
			const indexKey = filter?.runnerId
				? sessionRunnerIndexKey(filter.runnerId)
				: filter?.runId
					? sessionRunIndexKey(filter.runId)
					: filter?.userId
						? sessionUserIndexKey(filter.userId)
						: sessionIndexKey;
			const records = await readIndexed<RunnerSessionRecord>(indexKey, sessionKey);
			return records.filter(
				(session) =>
					(!filter?.runnerId || session.runnerId === filter.runnerId) &&
					(!filter?.runId || session.runId === filter.runId) &&
					(!filter?.userId || session.userId === filter.userId),
			);
		},
	};
}

// ── Client adapters ───────────────────────────────────────────────────────────

/** `ioredis` / `node-redis` v3 shape: variadic `SET key value EX n NX`. */
export interface IoRedisLikeClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
	del(key: string): Promise<unknown>;
	sadd(key: string, member: string): Promise<unknown>;
	srem(key: string, member: string): Promise<unknown>;
	smembers(key: string): Promise<string[]>;
}

export function fromIoRedis(client: IoRedisLikeClient): RunnerRedisClient {
	return {
		get: (key) => client.get(key),
		async set(key, value, options) {
			const args: (string | number)[] = [];
			if (options?.ttlSeconds !== undefined) args.push("EX", options.ttlSeconds);
			if (options?.ifNotExists) args.push("NX");
			const reply = await client.set(key, value, ...args);
			return reply !== null;
		},
		async del(key) {
			await client.del(key);
		},
		async sadd(key, member) {
			await client.sadd(key, member);
		},
		async srem(key, member) {
			await client.srem(key, member);
		},
		smembers: (key) => client.smembers(key),
	};
}

/** `@upstash/redis` shape: options object, and `get` that may hand back parsed JSON. */
export interface UpstashRedisLikeClient {
	get(key: string): Promise<unknown>;
	set(
		key: string,
		value: string,
		options?: { ex?: number; nx?: true },
	): Promise<string | null>;
	del(key: string): Promise<unknown>;
	sadd(key: string, member: string): Promise<unknown>;
	srem(key: string, member: string): Promise<unknown>;
	smembers(key: string): Promise<string[]>;
}

export function fromUpstashRedis(client: UpstashRedisLikeClient): RunnerRedisClient {
	return {
		async get(key) {
			const value = await client.get(key);
			if (value === null || value === undefined) return null;
			// Upstash deserializes JSON responses; re-encode so callers always see the raw string.
			return typeof value === "string" ? value : JSON.stringify(value);
		},
		async set(key, value, options) {
			const opts: { ex?: number; nx?: true } = {};
			if (options?.ttlSeconds !== undefined) opts.ex = options.ttlSeconds;
			if (options?.ifNotExists) opts.nx = true;
			const reply = await client.set(key, value, opts);
			return reply !== null;
		},
		async del(key) {
			await client.del(key);
		},
		async sadd(key, member) {
			await client.sadd(key, member);
		},
		async srem(key, member) {
			await client.srem(key, member);
		},
		smembers: (key) => client.smembers(key),
	};
}
