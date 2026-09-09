import { describe, expect, it } from "vitest";
import {
	InMemoryRunnerStore,
	PAIRING_TTL_MS,
	PairingError,
	approvePairing,
	claimPairing,
	denyPairing,
	normalizeUserCode,
	revokeRunner,
	startPairing,
	touchRunner,
} from "@/agents/runner/registry";
import type { RunnerIdentity } from "@/agents/runner/registry";

const identity: RunnerIdentity = {
	runnerId: "runner-a",
	publicKey: "base64-ed25519",
	os: "macOS",
	osVersion: "15.4",
	arch: "arm64",
	capVersion: "0.3.0",
	protocolVersion: "1.0.0",
};

describe("device-code pairing", () => {
	it("issues a transcribable code and pairs on approval", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["observe_screen", "record"], store);

		expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		expect(started.deviceCode.length).toBeGreaterThan(32);
		expect(started.deviceCode).not.toContain(started.userCode);

		expect(await claimPairing(started.deviceCode, store)).toEqual({
			status: "pending",
			pollIntervalSec: started.pollIntervalSec,
		});

		const runner = await approvePairing(started.userCode, "user-1", ["observe_screen"], store);
		expect(runner.userId).toBe("user-1");
		expect(runner.grantedScopes).toEqual(["observe_screen"]);

		const claimed = await claimPairing(started.deviceCode, store);
		expect(claimed.status).toBe("approved");
		if (claimed.status === "approved") {
			expect(claimed.runner.grantedScopes).toEqual(["observe_screen"]);
		}
	});

	it("accepts a user code typed with any casing or spacing", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store);
		const messy = ` ${started.userCode.toLowerCase().replace("-", " ")} `;
		expect(normalizeUserCode(messy)).toBe(started.userCode);
		await expect(approvePairing(messy, "user-1", ["record"], store)).resolves.toBeTruthy();
	});

	it("refuses to grant a scope the runner never requested", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["observe_screen"], store);

		await expect(
			approvePairing(started.userCode, "user-1", ["observe_screen", "control_keyboard"], store),
		).rejects.toMatchObject({ code: "PAIRING_SCOPE_WIDENED" });
	});

	it("refuses to redeem a device code twice", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store);
		await approvePairing(started.userCode, "user-1", ["record"], store);
		await claimPairing(started.deviceCode, store);

		await expect(claimPairing(started.deviceCode, store)).rejects.toMatchObject({
			code: "PAIRING_ALREADY_CLAIMED",
		});
	});

	it("expires a code that is approved too late", async () => {
		const store = new InMemoryRunnerStore();
		const t0 = 1_000_000;
		const started = await startPairing(identity, ["record"], store, t0);

		await expect(
			approvePairing(started.userCode, "user-1", ["record"], store, t0 + PAIRING_TTL_MS + 1),
		).rejects.toMatchObject({ code: "PAIRING_EXPIRED" });

		expect(await claimPairing(started.deviceCode, store, t0 + PAIRING_TTL_MS + 2)).toEqual({
			status: "expired",
		});
	});

	it("reports a denied request to the polling runner", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store);
		await denyPairing(started.userCode, store);
		expect(await claimPairing(started.deviceCode, store)).toEqual({ status: "denied" });
	});

	it("refuses to let a second user re-pair a runner id that another user owns", async () => {
		const store = new InMemoryRunnerStore();
		const victim = await startPairing(identity, ["record"], store);
		await approvePairing(victim.userCode, "user-1", ["record"], store);

		const hijack = await startPairing(identity, ["record", "control_keyboard"], store);
		await expect(
			approvePairing(hijack.userCode, "user-2", ["record", "control_keyboard"], store),
		).rejects.toMatchObject({ code: "PAIRING_RUNNER_OWNED" });

		const runner = await store.getRunner("runner-a");
		expect(runner?.userId).toBe("user-1");
		expect(runner?.grantedScopes).toEqual(["record"]);
		await expect(claimPairing(hijack.deviceCode, store)).resolves.toMatchObject({ status: "pending" });
	});

	it("lets the owning user re-pair their own runner to change its scopes", async () => {
		const store = new InMemoryRunnerStore();
		const first = await startPairing(identity, ["record"], store);
		await approvePairing(first.userCode, "user-1", ["record"], store);

		const again = await startPairing(identity, ["record", "observe_screen"], store);
		const runner = await approvePairing(again.userCode, "user-1", ["observe_screen", "record"], store);
		expect(runner.grantedScopes).toEqual(["observe_screen", "record"]);
	});

	it("rejects an unknown user code and an unknown device code", async () => {
		const store = new InMemoryRunnerStore();
		await expect(approvePairing("AAAA-BBBB", "u", [], store)).rejects.toBeInstanceOf(PairingError);
		await expect(claimPairing("nope", store)).rejects.toMatchObject({ code: "PAIRING_NOT_FOUND" });
	});
});

describe("runner records", () => {
	it("revokes by zeroing granted scopes so later sessions fail closed", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store);
		await approvePairing(started.userCode, "user-1", ["record"], store);

		await revokeRunner("runner-a", store, 5_000);
		const runner = await store.getRunner("runner-a");
		expect(runner?.revokedAt).toBe(5_000);
		expect(runner?.grantedScopes).toEqual([]);
	});

	it("scopes listings to the owning user", async () => {
		const store = new InMemoryRunnerStore();
		const a = await startPairing(identity, ["record"], store);
		await approvePairing(a.userCode, "user-1", ["record"], store);

		const b = await startPairing({ ...identity, runnerId: "runner-b" }, ["record"], store);
		await approvePairing(b.userCode, "user-2", ["record"], store);

		expect((await store.listRunners("user-1")).map((r) => r.runnerId)).toEqual(["runner-a"]);
		expect(await store.listRunners()).toHaveLength(2);
	});

	it("touches last-seen without disturbing other fields", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store, 1_000);
		await approvePairing(started.userCode, "user-1", ["record"], store, 1_000);

		await touchRunner("runner-a", store, 9_999);
		const runner = await store.getRunner("runner-a");
		expect(runner?.lastSeenAt).toBe(9_999);
		expect(runner?.pairedAt).toBe(1_000);
		await expect(touchRunner("ghost", store)).resolves.toBeUndefined();
	});

	it("stores sessions and filters them", async () => {
		const store = new InMemoryRunnerStore();
		await store.saveSession({
			sessionId: "s1",
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			state: "active",
			grantedScopes: ["record"],
			guard: {
				allowedBundleIds: [],
				redactedTitlePatterns: [],
				idleTimeoutMs: 1,
				maxDurationMs: 2,
				requireStepApproval: true,
			},
			startedAt: 1,
			expiresAt: 2,
		});

		expect(await store.listSessions({ runId: "run-1" })).toHaveLength(1);
		expect(await store.listSessions({ runId: "run-2" })).toHaveLength(0);
		expect(await store.getSession("missing")).toBeNull();
	});

	it("returns copies so callers cannot mutate stored state in place", async () => {
		const store = new InMemoryRunnerStore();
		const started = await startPairing(identity, ["record"], store);
		await approvePairing(started.userCode, "user-1", ["record"], store);

		const runner = await store.getRunner("runner-a");
		if (runner) runner.grantedScopes.push("upload");

		expect((await store.getRunner("runner-a"))?.grantedScopes).toEqual(["record"]);
	});
});
