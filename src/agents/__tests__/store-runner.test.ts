import { beforeEach, describe, expect, it } from "vitest";
import {
	InMemoryRunnerStore,
	PairingError,
	type RunnerIdentity,
	type RunnerSessionRecord,
	type RunnerStore,
	approvePairing,
	claimPairing,
	denyPairing,
	revokeRunner,
	startPairing,
} from "../runner/registry";
import {
	type IoRedisLikeClient,
	type RunnerRedisClient,
	type UpstashRedisLikeClient,
	createRedisRunnerStore,
	fromIoRedis,
	fromUpstashRedis,
} from "../runner/stores";
import type { SessionGuard } from "../runner/protocol";

/**
 * A Redis stand-in with real key expiry and real `NX` semantics, driven by a virtual clock so a
 * TTL test does not have to sleep. Everything the store relies on for correctness — atomic
 * set-if-absent, per-key TTL, set membership — is modelled here; nothing else is.
 */
class FakeRedis {
	private readonly values = new Map<string, { value: string; expiresAt: number | null }>();
	private readonly sets = new Map<string, Set<string>>();
	nowUnixMs = 1_700_000_000_000;

	advanceMs(ms: number): void {
		this.nowUnixMs += ms;
	}

	private live(key: string): { value: string; expiresAt: number | null } | null {
		const entry = this.values.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== null && this.nowUnixMs >= entry.expiresAt) {
			this.values.delete(key);
			return null;
		}
		return entry;
	}

	ttlMsOf(key: string): number | null {
		const entry = this.live(key);
		if (!entry || entry.expiresAt === null) return null;
		return entry.expiresAt - this.nowUnixMs;
	}

	keys(): string[] {
		return [...this.values.keys()].filter((key) => this.live(key) !== null);
	}

	client(): RunnerRedisClient {
		return {
			get: async (key) => this.live(key)?.value ?? null,
			set: async (key, value, options) => {
				if (options?.ifNotExists && this.live(key) !== null) return false;
				this.values.set(key, {
					value,
					expiresAt:
						options?.ttlSeconds === undefined
							? null
							: this.nowUnixMs + options.ttlSeconds * 1000,
				});
				return true;
			},
			del: async (key) => {
				this.values.delete(key);
			},
			sadd: async (key, member) => {
				const set = this.sets.get(key) ?? new Set<string>();
				set.add(member);
				this.sets.set(key, set);
			},
			srem: async (key, member) => {
				this.sets.get(key)?.delete(member);
			},
			smembers: async (key) => [...(this.sets.get(key) ?? [])],
		};
	}
}

const IDENTITY: RunnerIdentity = {
	runnerId: "runner-1",
	publicKey: "cHVia2V5",
	os: "macOS",
	osVersion: "15.2",
	arch: "arm64",
	capVersion: "0.3.0",
	protocolVersion: "1",
};

const GUARD: SessionGuard = {
	allowedBundleIds: ["com.apple.Safari"],
	redactedTitlePatterns: ["1Password"],
	idleTimeoutMs: 30_000,
	maxDurationMs: 600_000,
	requireStepApproval: true,
};

function sessionRecord(overrides: Partial<RunnerSessionRecord> = {}): RunnerSessionRecord {
	return {
		sessionId: "sess-1",
		runnerId: "runner-1",
		runId: "run-1",
		userId: "user-1",
		state: "active",
		grantedScopes: ["observe_screen"],
		guard: GUARD,
		startedAt: 1_700_000_000_000,
		expiresAt: 1_700_000_600_000,
		...overrides,
	};
}

/** Every guarantee below must hold for whichever store a deployment installs. */
const IMPLEMENTATIONS: Array<{ name: string; create: () => RunnerStore }> = [
	{ name: "InMemoryRunnerStore", create: () => new InMemoryRunnerStore() },
	{
		name: "createRedisRunnerStore",
		create: () => {
			const redis = new FakeRedis();
			return createRedisRunnerStore(redis.client(), { now: () => redis.nowUnixMs });
		},
	},
];

for (const { name, create } of IMPLEMENTATIONS) {
	describe(`RunnerStore contract — ${name}`, () => {
		let store: RunnerStore;

		beforeEach(() => {
			store = create();
		});

		it("issues a pairing code that a user can approve and the runner can then claim", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen", "record"], store);
			await approvePairing(started.userCode, "user-1", ["observe_screen"], store);

			const claimed = await claimPairing(started.deviceCode, store);
			expect(claimed.status).toBe("approved");
			if (claimed.status !== "approved") throw new Error("unreachable");
			expect(claimed.runner.userId).toBe("user-1");
			expect(claimed.runner.grantedScopes).toEqual(["observe_screen"]);
		});

		it("refuses a second claim of the same device code", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen"], store);
			await approvePairing(started.userCode, "user-1", ["observe_screen"], store);

			expect((await claimPairing(started.deviceCode, store)).status).toBe("approved");
			await expect(claimPairing(started.deviceCode, store)).rejects.toMatchObject({
				code: "PAIRING_ALREADY_CLAIMED",
			});
		});

		it("hands the runner record to exactly one of two racing pollers", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen"], store);
			await approvePairing(started.userCode, "user-1", ["observe_screen"], store);

			const results = await Promise.allSettled([
				claimPairing(started.deviceCode, store),
				claimPairing(started.deviceCode, store),
				claimPairing(started.deviceCode, store),
			]);
			const approved = results.filter(
				(r) => r.status === "fulfilled" && r.value.status === "approved",
			);
			expect(approved).toHaveLength(1);
			for (const rejected of results.filter((r) => r.status === "rejected")) {
				expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(PairingError);
			}
		});

		it("expires a pairing code that is never claimed", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen"], store, 1_000);
			await approvePairing(started.userCode, "user-1", ["observe_screen"], store, 2_000);

			const late = started.expiresAt + 1_000;
			expect((await claimPairing(started.deviceCode, store, late)).status).toBe("expired");
			await expect(
				approvePairing(started.userCode, "user-1", ["observe_screen"], store, late),
			).rejects.toMatchObject({ code: "PAIRING_NOT_PENDING" });
		});

		it("cannot grant a scope the runner never asked for", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen"], store);
			await expect(
				approvePairing(started.userCode, "user-1", ["control_keyboard"], store),
			).rejects.toMatchObject({ code: "PAIRING_SCOPE_WIDENED" });
		});

		it("refuses to hand a runner id owned by one user to a second user", async () => {
			const owner = await startPairing(IDENTITY, ["observe_screen"], store);
			await approvePairing(owner.userCode, "user-1", ["observe_screen"], store);

			const hijack = await startPairing(IDENTITY, ["observe_screen", "control_keyboard"], store);
			await expect(
				approvePairing(hijack.userCode, "user-2", ["observe_screen", "control_keyboard"], store),
			).rejects.toMatchObject({ code: "PAIRING_RUNNER_OWNED" });
			expect((await store.getRunner(IDENTITY.runnerId))?.userId).toBe("user-1");
		});

		it("treats a code as valid at exactly its expiry instant and expired one ms later", async () => {
			const t0 = 1_700_000_000_000;
			const started = await startPairing(IDENTITY, ["observe_screen"], store, t0);
			await approvePairing(started.userCode, "user-1", ["observe_screen"], store, started.expiresAt);
			expect((await claimPairing(started.deviceCode, store, started.expiresAt)).status).toBe("approved");

			const again = await startPairing(
				{ ...IDENTITY, runnerId: "runner-late" },
				["observe_screen"],
				store,
				t0,
			);
			await expect(
				approvePairing(again.userCode, "user-1", ["observe_screen"], store, again.expiresAt + 1),
			).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });
			expect((await claimPairing(again.deviceCode, store, again.expiresAt + 1)).status).toBe("expired");
		});

		it("reports a denied code to the runner without minting a record", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen"], store);
			await denyPairing(started.userCode, store);
			expect((await claimPairing(started.deviceCode, store)).status).toBe("denied");
			expect(await store.getRunner(IDENTITY.runnerId)).toBeNull();
		});

		it("revokes a runner by stripping every scope and stamping revokedAt", async () => {
			const started = await startPairing(IDENTITY, ["observe_screen", "record"], store);
			await approvePairing(started.userCode, "user-1", ["observe_screen", "record"], store);

			await revokeRunner(IDENTITY.runnerId, store, 9_999);
			const runner = await store.getRunner(IDENTITY.runnerId);
			expect(runner?.grantedScopes).toEqual([]);
			expect(runner?.revokedAt).toBe(9_999);
		});

		it("lists runners for one owner only", async () => {
			const a = await startPairing(IDENTITY, ["observe_screen"], store);
			await approvePairing(a.userCode, "user-1", ["observe_screen"], store);
			const b = await startPairing(
				{ ...IDENTITY, runnerId: "runner-2" },
				["observe_screen"],
				store,
			);
			await approvePairing(b.userCode, "user-2", ["observe_screen"], store);

			expect((await store.listRunners("user-1")).map((r) => r.runnerId)).toEqual(["runner-1"]);
			expect(await store.listRunners()).toHaveLength(2);
		});

		it("round-trips a session record and filters the list by runner, run and user", async () => {
			await store.saveSession(sessionRecord());
			await store.saveSession(
				sessionRecord({ sessionId: "sess-2", runId: "run-2", userId: "user-2" }),
			);

			expect((await store.getSession("sess-1"))?.guard.allowedBundleIds).toEqual([
				"com.apple.Safari",
			]);
			expect(await store.listSessions({ runId: "run-2" })).toHaveLength(1);
			expect(await store.listSessions({ userId: "user-1" })).toHaveLength(1);
			expect(await store.listSessions({ runnerId: "runner-1" })).toHaveLength(2);
			expect(await store.listSessions()).toHaveLength(2);
		});

		it("records the end of a session so a later reader sees why it stopped", async () => {
			await store.saveSession(sessionRecord());
			await store.saveSession(
				sessionRecord({ state: "ended", endedAt: 1_700_000_300_000, endReason: "user_kill_switch" }),
			);
			const ended = await store.getSession("sess-1");
			expect(ended?.state).toBe("ended");
			expect(ended?.endReason).toBe("user_kill_switch");
		});

		it("never hands out a reference a caller can mutate in place", async () => {
			await store.saveSession(sessionRecord());
			const first = await store.getSession("sess-1");
			first?.grantedScopes.push("control_keyboard");
			expect((await store.getSession("sess-1"))?.grantedScopes).toEqual(["observe_screen"]);
		});
	});
}

describe("createRedisRunnerStore — durability details", () => {
	it("gives a pairing record a TTL, so an unclaimed code disappears without a sweeper", async () => {
		const redis = new FakeRedis();
		const store = createRedisRunnerStore(redis.client(), {
			now: () => redis.nowUnixMs,
			pairingGraceSeconds: 60,
		});

		const started = await startPairing(IDENTITY, ["observe_screen"], store, redis.nowUnixMs);
		const key = redis.keys().find((k) => k.includes("pairing:device:"));
		expect(key).toBeDefined();
		const ttlMs = redis.ttlMsOf(key as string);
		expect(ttlMs).not.toBeNull();
		expect(ttlMs).toBeGreaterThan(started.expiresAt - redis.nowUnixMs);

		redis.advanceMs(started.expiresAt - redis.nowUnixMs + 61_000);
		expect(await store.getPairingByDeviceCode(started.deviceCode)).toBeNull();
	});

	it("keeps the single-use marker alive past the pairing's own expiry", async () => {
		const redis = new FakeRedis();
		const store = createRedisRunnerStore(redis.client(), {
			now: () => redis.nowUnixMs,
			pairingGraceSeconds: 300,
		});

		const started = await startPairing(IDENTITY, ["observe_screen"], store, redis.nowUnixMs);
		await approvePairing(started.userCode, "user-1", ["observe_screen"], store, redis.nowUnixMs);
		expect(await store.markPairingClaimed?.(started.deviceCode)).toBe(true);

		redis.advanceMs(started.expiresAt - redis.nowUnixMs + 1_000);
		expect(await store.markPairingClaimed?.(started.deviceCode)).toBe(false);
	});

	it("returns false when asked to claim a device code it has never seen", async () => {
		const redis = new FakeRedis();
		const store = createRedisRunnerStore(redis.client(), { now: () => redis.nowUnixMs });
		expect(await store.markPairingClaimed?.("no-such-code")).toBe(false);
	});

	it("prunes index entries whose record has expired instead of returning holes", async () => {
		const redis = new FakeRedis();
		const store = createRedisRunnerStore(redis.client(), {
			now: () => redis.nowUnixMs,
			sessionRetentionSeconds: 10,
		});

		await store.saveSession(sessionRecord({ expiresAt: redis.nowUnixMs + 1_000 }));
		expect(await store.listSessions()).toHaveLength(1);

		redis.advanceMs(60_000);
		expect(await store.listSessions()).toEqual([]);
	});

	it("drops a deleted runner out of both the global and the per-user index", async () => {
		const redis = new FakeRedis();
		const store = createRedisRunnerStore(redis.client(), { now: () => redis.nowUnixMs });
		const started = await startPairing(IDENTITY, ["observe_screen"], store, redis.nowUnixMs);
		await approvePairing(started.userCode, "user-1", ["observe_screen"], store, redis.nowUnixMs);

		await store.deleteRunner(IDENTITY.runnerId);
		expect(await store.listRunners()).toEqual([]);
		expect(await store.listRunners("user-1")).toEqual([]);
	});
});

describe("redis client adapters", () => {
	it("maps ttl and set-if-absent onto the ioredis variadic signature", async () => {
		const calls: Array<(string | number)[]> = [];
		const ioredis: IoRedisLikeClient = {
			get: async () => null,
			set: async (key, value, ...args) => {
				calls.push([key, value, ...args]);
				return args.includes("NX") && calls.length > 1 ? null : "OK";
			},
			del: async () => 1,
			sadd: async () => 1,
			srem: async () => 1,
			smembers: async () => [],
		};
		const client = fromIoRedis(ioredis);

		expect(await client.set("k", "v", { ttlSeconds: 30, ifNotExists: true })).toBe(true);
		expect(calls[0]).toEqual(["k", "v", "EX", 30, "NX"]);
		expect(await client.set("k", "v", { ifNotExists: true })).toBe(false);
		expect(calls[1]).toEqual(["k", "v", "NX"]);
	});

	it("maps ttl and set-if-absent onto the upstash options object", async () => {
		let seen: { ex?: number; nx?: true } | undefined;
		const upstash: UpstashRedisLikeClient = {
			get: async () => ({ runnerId: "runner-1" }),
			set: async (_key, _value, options) => {
				seen = options;
				return "OK";
			},
			del: async () => 1,
			sadd: async () => 1,
			srem: async () => 1,
			smembers: async () => [],
		};
		const client = fromUpstashRedis(upstash);

		expect(await client.set("k", "v", { ttlSeconds: 45, ifNotExists: true })).toBe(true);
		expect(seen).toEqual({ ex: 45, nx: true });
	});

	it("re-encodes the object upstash hands back so callers always parse a string", async () => {
		const upstash: UpstashRedisLikeClient = {
			get: async () => ({ runnerId: "runner-1", userId: "user-1" }),
			set: async () => "OK",
			del: async () => 1,
			sadd: async () => 1,
			srem: async () => 1,
			smembers: async () => [],
		};
		const store = createRedisRunnerStore(fromUpstashRedis(upstash));
		expect((await store.getRunner("runner-1"))?.userId).toBe("user-1");
	});
});

describe("two Next.js instances sharing one Redis", () => {
	/** The failure this store exists to remove: a code issued by A that B cannot see. */
	function twoInstances() {
		const redis = new FakeRedis();
		const client = redis.client();
		return {
			redis,
			instanceA: createRedisRunnerStore(client, { now: () => redis.nowUnixMs }),
			instanceB: createRedisRunnerStore(client, { now: () => redis.nowUnixMs }),
		};
	}

	it("lets instance B approve and claim a code instance A issued", async () => {
		const { redis, instanceA, instanceB } = twoInstances();
		const started = await startPairing(IDENTITY, ["observe_screen"], instanceA, redis.nowUnixMs);

		await approvePairing(
			started.userCode,
			"user-1",
			["observe_screen"],
			instanceB,
			redis.nowUnixMs,
		);
		const claimed = await claimPairing(started.deviceCode, instanceB, redis.nowUnixMs);
		expect(claimed.status).toBe("approved");
	});

	it("burns a device code for every instance at once", async () => {
		const { redis, instanceA, instanceB } = twoInstances();
		const started = await startPairing(IDENTITY, ["observe_screen"], instanceA, redis.nowUnixMs);
		await approvePairing(
			started.userCode,
			"user-1",
			["observe_screen"],
			instanceA,
			redis.nowUnixMs,
		);

		expect((await claimPairing(started.deviceCode, instanceA, redis.nowUnixMs)).status).toBe(
			"approved",
		);
		await expect(
			claimPairing(started.deviceCode, instanceB, redis.nowUnixMs),
		).rejects.toMatchObject({ code: "PAIRING_ALREADY_CLAIMED" });
	});

	it("makes a revocation on instance A visible to instance B immediately", async () => {
		const { redis, instanceA, instanceB } = twoInstances();
		const started = await startPairing(IDENTITY, ["observe_screen"], instanceA, redis.nowUnixMs);
		await approvePairing(
			started.userCode,
			"user-1",
			["observe_screen"],
			instanceA,
			redis.nowUnixMs,
		);

		await revokeRunner(IDENTITY.runnerId, instanceA, redis.nowUnixMs);
		const seenByB = await instanceB.getRunner(IDENTITY.runnerId);
		expect(seenByB?.revokedAt).toBe(redis.nowUnixMs);
		expect(seenByB?.grantedScopes).toEqual([]);
	});

	it("shows a session opened on instance A to a kill switch pressed against instance B", async () => {
		const { redis, instanceA, instanceB } = twoInstances();
		await instanceA.saveSession(sessionRecord({ expiresAt: redis.nowUnixMs + 600_000 }));

		const seenByB = await instanceB.getSession("sess-1");
		expect(seenByB?.state).toBe("active");

		await instanceB.saveSession({
			...(seenByB as RunnerSessionRecord),
			state: "ended",
			endedAt: redis.nowUnixMs,
			endReason: "user_kill_switch",
		});
		expect((await instanceA.getSession("sess-1"))?.endReason).toBe("user_kill_switch");
	});
});
