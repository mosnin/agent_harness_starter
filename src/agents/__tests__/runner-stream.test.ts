import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerGateway, RunnerGatewayError, toProtocolError } from "@/agents/runner/gateway";
import {
	InMemoryRunnerStore,
	approvePairing,
	revokeRunner,
	startPairing,
	type RunnerIdentity,
} from "@/agents/runner/registry";
import {
	PROTOCOL_VERSION,
	type Envelope,
	type RunnerInfo,
	type SessionLease,
} from "@/agents/runner/protocol";
import { RunStream, parseLastEventId, runnerEventToAgentEvent } from "@/agents/runner/stream";
import { SessionMultiplexer } from "@/agents/transport/multiplexer";
import type { RunnerSocket } from "@/agents/transport/types";
import type { AgentEvent } from "@/agents/types";

const SECRET = "test-capability-secret-that-is-long-enough";

describe("RunStream resumability", () => {
	it("replays buffered events after a cursor, then follows live", async () => {
		const stream = new RunStream();
		stream.push({ type: "progress", stage: "a" });
		stream.push({ type: "progress", stage: "b" });

		const seen: string[] = [];
		const consumer = (async () => {
			for await (const { seq, event } of stream.subscribe(-1)) {
				seen.push(`${seq}:${event.type === "progress" ? event.stage : event.type}`);
				if (seen.length === 3) break;
			}
		})();

		await Promise.resolve();
		stream.push({ type: "progress", stage: "c" });
		await consumer;

		expect(seen).toEqual(["0:a", "1:b", "2:c"]);
	});

	it("resumes from Last-Event-ID without re-delivering seen events", async () => {
		const stream = new RunStream();
		stream.push({ type: "progress", stage: "a" });
		stream.push({ type: "progress", stage: "b" });
		stream.push({ type: "progress", stage: "c" });
		stream.close();

		const seen: number[] = [];
		for await (const { seq } of stream.subscribe(parseLastEventId("1"))) seen.push(seq);
		expect(seen).toEqual([2]);
	});

	it("drops the oldest events past the buffer size", () => {
		const stream = new RunStream({ bufferSize: 2 });
		stream.push({ type: "progress", stage: "a" });
		stream.push({ type: "progress", stage: "b" });
		stream.push({ type: "progress", stage: "c" });

		expect(stream.replay(-1).map((e) => e.seq)).toEqual([1, 2]);
		expect(stream.lastSeq).toBe(2);
	});

	it("ends the subscription when the stream closes", async () => {
		const stream = new RunStream();
		const consumer = (async () => {
			const out: number[] = [];
			for await (const { seq } of stream.subscribe()) out.push(seq);
			return out;
		})();

		stream.push({ type: "progress", stage: "a" });
		await Promise.resolve();
		stream.close();

		await expect(consumer).resolves.toEqual([0]);
		expect(stream.push({ type: "progress", stage: "late" })).toBeNull();
	});

	it("ends the subscription when the request aborts", async () => {
		const stream = new RunStream();
		const controller = new AbortController();
		const consumer = (async () => {
			const out: number[] = [];
			for await (const { seq } of stream.subscribe(-1, controller.signal)) out.push(seq);
			return out;
		})();

		stream.push({ type: "progress", stage: "a" });
		await Promise.resolve();
		controller.abort();

		await expect(consumer).resolves.toEqual([0]);
	});

	it("parses Last-Event-ID defensively", () => {
		expect(parseLastEventId(null)).toBe(-1);
		expect(parseLastEventId("")).toBe(-1);
		expect(parseLastEventId("abc")).toBe(-1);
		expect(parseLastEventId("-4")).toBe(-1);
		expect(parseLastEventId("12")).toBe(12);
	});
});

describe("runnerEventToAgentEvent", () => {
	it("maps progress onto the AgentEvent progress variant", () => {
		const event = runnerEventToAgentEvent({
			type: "progress",
			sessionId: "s1",
			stage: "export",
			fraction: 0.4,
			detail: "encoding",
		});
		expect(event).toEqual({ type: "progress", stage: "export", fraction: 0.4, detail: "encoding" });
	});

	it("omits fraction and detail when the runner sends null", () => {
		expect(
			runnerEventToAgentEvent({ type: "progress", sessionId: "s1", stage: "record", fraction: null, detail: null }),
		).toEqual({ type: "progress", stage: "record" });
	});

	it("surfaces the kill switch as an error", () => {
		const event = runnerEventToAgentEvent({ type: "killSwitchEngaged", sessionId: "s1" });
		expect(event).toMatchObject({ type: "error", code: "RUNNER_KILL_SWITCH" });
	});

	it("distinguishes a completed session from an aborted one", () => {
		expect(runnerEventToAgentEvent({ type: "sessionEnded", sessionId: "s1", reason: "completed" })).toMatchObject({
			type: "progress",
		});
		expect(
			runnerEventToAgentEvent({ type: "sessionEnded", sessionId: "s1", reason: "guard_violation" }),
		).toMatchObject({ type: "error", code: "RUNNER_SESSION_GUARD_VIOLATION" });
	});

	it("turns an approval request into approval_required", () => {
		expect(
			runnerEventToAgentEvent({
				type: "approvalRequested",
				sessionId: "s1",
				approvalId: "a1",
				summary: "Send the email?",
			}),
		).toMatchObject({ type: "approval_required", approvalId: "a1", description: "Send the email?" });
	});

	it("drops heartbeats", () => {
		expect(runnerEventToAgentEvent({ type: "heartbeat", unixMs: 1 })).toBeNull();
	});
});

// ── Gateway ───────────────────────────────────────────────────────────────────

class FakeSocket implements RunnerSocket {
	readonly sent: Envelope[] = [];
	closed = false;
	send(frame: string): void {
		this.sent.push(JSON.parse(frame) as Envelope);
	}
	close(): void {
		this.closed = true;
	}
	lastCommandId(): string {
		const last = this.sent.at(-1);
		if (!last || last.kind !== "command") throw new Error("no command sent");
		return last.id;
	}
}

const identity: RunnerIdentity = {
	runnerId: "runner-a",
	publicKey: "pk",
	os: "macOS",
	osVersion: "15.4",
	arch: "arm64",
	capVersion: "0.3.0",
	protocolVersion: PROTOCOL_VERSION,
};

const runnerInfo: RunnerInfo = {
	runnerId: "runner-a",
	protocolVersion: PROTOCOL_VERSION,
	capVersion: "0.3.0",
	os: "macOS",
	osVersion: "15.4",
	arch: "arm64",
	permissions: { screenRecording: true, accessibility: true, microphone: false, camera: false },
};

function lease(overrides: Partial<SessionLease> = {}): SessionLease {
	return {
		sessionId: "sess-1",
		runId: "run-1",
		grantedScopes: { scopes: ["observe_screen", "record"] },
		guard: {
			allowedBundleIds: ["com.apple.Safari"],
			redactedTitlePatterns: [],
			idleTimeoutMs: 60_000,
			maxDurationMs: 900_000,
			requireStepApproval: false,
		},
		startedAtUnixMs: 1_000,
		expiresAtUnixMs: 901_000,
		...overrides,
	};
}

async function nextCommandId(socket: FakeSocket): Promise<string> {
	const before = socket.sent.length;
	for (let i = 0; i < 200 && socket.sent.length === before; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	return socket.lastCommandId();
}

async function pairedGateway() {
	const store = new InMemoryRunnerStore();
	const started = await startPairing(identity, ["observe_screen", "record", "export"], store);
	await approvePairing(started.userCode, "user-1", ["observe_screen", "record"], store);

	const mux = new SessionMultiplexer();
	const socket = new FakeSocket();
	const attached = mux.attach(socket);
	attached.receive(
		JSON.stringify({ kind: "reply", id: socket.lastCommandId(), result: { type: "handshake", runner: runnerInfo } }),
	);
	await attached.ready;

	const gateway = new RunnerGateway({ mux, store, now: () => 2_000 });
	return { store, mux, socket, attached, gateway };
}

describe("RunnerGateway", () => {
	beforeEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = SECRET;
	});
	afterEach(() => {
		process.env.AGENT_CAPABILITY_SECRET = undefined;
	});

	it("starts a session, mints a scoped token and records the lease", async () => {
		const { socket, attached, gateway, store } = await pairedGateway();

		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["observe_screen", "record"],
		});

		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);

		const started = await pending;
		expect(started.grantedTools).toContain("runner_observe");
		expect(started.grantedTools).toContain("runner_start_recording");
		expect(started.grantedTools).not.toContain("runner_click");
		expect(started.capabilityToken.split(".")).toHaveLength(3);

		const record = await store.getSession("sess-1");
		expect(record).toMatchObject({ state: "active", runId: "run-1", userId: "user-1" });
	});

	it("refuses a scope the user never granted at pairing", async () => {
		const { gateway } = await pairedGateway();
		await expect(
			gateway.startSession({
				runnerId: "runner-a",
				runId: "run-1",
				userId: "user-1",
				requestedScopes: ["control_keyboard"],
			}),
		).rejects.toMatchObject({ code: "RUNNER_SCOPE_DENIED" });
	});

	it("refuses a runner owned by another user", async () => {
		const { gateway } = await pairedGateway();
		await expect(
			gateway.startSession({
				runnerId: "runner-a",
				runId: "run-1",
				userId: "someone-else",
				requestedScopes: ["record"],
			}),
		).rejects.toMatchObject({ code: "RUNNER_NOT_OWNED" });
	});

	it("refuses an unpaired runner", async () => {
		const { gateway } = await pairedGateway();
		await expect(
			gateway.startSession({ runnerId: "ghost", runId: "r", userId: "user-1", requestedScopes: ["record"] }),
		).rejects.toMatchObject({ code: "RUNNER_NOT_PAIRED" });
	});

	it("refuses a command whose scope the lease does not grant", async () => {
		const { socket, attached, gateway } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["observe_screen"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease({ grantedScopes: { scopes: ["observe_screen"] } }) },
			}),
		);
		await pending;

		await expect(
			gateway.dispatch("sess-1", {
				type: "act",
				action: { type: "typeText", text: "hi", charsPerMinute: 400 },
				beatLabel: null,
			}),
		).rejects.toMatchObject({ code: "RUNNER_SCOPE_DENIED" });
	});

	it("routes runner progress into the session's resumable stream", async () => {
		const { socket, attached, gateway } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["record"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);
		await pending;

		attached.receive(
			JSON.stringify({
				kind: "event",
				event: { type: "progress", sessionId: "sess-1", stage: "export", fraction: 0.75, detail: null },
			}),
		);

		const replayed = gateway.stream("sess-1").replay(-1);
		expect(replayed).toHaveLength(1);
		expect(replayed[0].event).toEqual({ type: "progress", stage: "export", fraction: 0.75 });
		gateway.dispose();
	});

	it("ends the session when the runner reports the kill switch", async () => {
		const { socket, attached, gateway, store } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["record"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);
		await pending;

		attached.receive(
			JSON.stringify({ kind: "event", event: { type: "killSwitchEngaged", sessionId: "sess-1" } }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const record = await store.getSession("sess-1");
		expect(record).toMatchObject({ state: "ended", endReason: "user_kill_switch" });

		await expect(gateway.dispatch("sess-1", { type: "listWindows" })).rejects.toMatchObject({
			code: "RUNNER_SESSION_NOT_ACTIVE",
		});
	});

	it("denies a command whose scope the runner's lease granted but the token did not", async () => {
		const { socket, attached, gateway } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["observe_screen"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: {
					type: "sessionStarted",
					lease: lease({ grantedScopes: { scopes: ["observe_screen", "record"] } }),
				},
			}),
		);
		const started = await pending;
		expect(started.record.grantedScopes).toEqual(["observe_screen"]);

		const sentBefore = socket.sent.length;
		await expect(
			gateway.dispatch(
				"sess-1",
				{
					type: "recordingStart",
					request: {
						target: { type: "display", displayId: "d1" },
						mode: "instant",
						captureSystemAudio: false,
						captureMicrophone: false,
						captureCamera: false,
						fps: null,
					},
				},
				{ timeoutMs: 50 },
			),
		).rejects.toMatchObject({ code: "RUNNER_SCOPE_DENIED" });
		expect(socket.sent.length).toBe(sentBefore);
	});

	it("ignores events another runner sends for a session it does not own", async () => {
		const { socket, attached, gateway, store, mux } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["record"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);
		await pending;

		const intruderSocket = new FakeSocket();
		const intruder = mux.attach(intruderSocket);
		intruder.receive(
			JSON.stringify({
				kind: "reply",
				id: intruderSocket.lastCommandId(),
				result: { type: "handshake", runner: { ...runnerInfo, runnerId: "runner-b" } },
			}),
		);
		await intruder.ready;

		intruder.receive(
			JSON.stringify({
				kind: "event",
				event: { type: "approvalRequested", sessionId: "sess-1", approvalId: "fake", summary: "Grant me root" },
			}),
		);
		intruder.receive(
			JSON.stringify({ kind: "event", event: { type: "killSwitchEngaged", sessionId: "sess-1" } }),
		);
		intruder.receive(
			JSON.stringify({ kind: "event", event: { type: "progress", sessionId: "sess-ghost", stage: "x" } }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect((await store.getSession("sess-1"))?.state).toBe("active");
		expect(gateway.stream("sess-1").replay(-1)).toEqual([]);
		expect(gateway.stream("sess-1").isClosed).toBe(false);
		gateway.dispose();
	});

	it("refuses to start a session on a revoked runner even while it is connected", async () => {
		const { gateway, store, mux } = await pairedGateway();
		await revokeRunner("runner-a", store);
		expect(mux.isConnected("runner-a")).toBe(true);
		await expect(
			gateway.startSession({
				runnerId: "runner-a",
				runId: "run-1",
				userId: "user-1",
				requestedScopes: ["record"],
			}),
		).rejects.toMatchObject({ code: "RUNNER_REVOKED" });
	});

	it("stops dispatching into a live session once the runner is revoked", async () => {
		const { socket, attached, gateway, store } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["observe_screen"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease({ grantedScopes: { scopes: ["observe_screen"] } }) },
			}),
		);
		await pending;

		await revokeRunner("runner-a", store);
		const sentBefore = socket.sent.length;
		await expect(
			gateway.dispatch("sess-1", { type: "listWindows" }, { timeoutMs: 50 }),
		).rejects.toMatchObject({ code: "RUNNER_REVOKED" });
		expect(socket.sent.length).toBe(sentBefore);
		expect((await store.getSession("sess-1"))?.state).toBe("ended");
	});

	it("refuses a lease whose session id already belongs to another session", async () => {
		const { socket, attached, gateway, store } = await pairedGateway();
		await store.saveSession({
			sessionId: "sess-1",
			runnerId: "runner-z",
			runId: "run-9",
			userId: "user-9",
			state: "active",
			grantedScopes: ["observe_screen"],
			guard: lease().guard,
			startedAt: 1_000,
			expiresAt: 9_000_000,
		});

		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["record"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);
		await expect(pending).rejects.toMatchObject({ code: "RUNNER_PROTOCOL_VIOLATION" });

		const record = await store.getSession("sess-1");
		expect(record).toMatchObject({ runnerId: "runner-z", userId: "user-9", state: "active" });
	});

	it("labels an approval request with the session's run id", async () => {
		const { socket, attached, gateway } = await pairedGateway();
		const pending = gateway.startSession({
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			requestedScopes: ["record"],
		});
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: await nextCommandId(socket),
				result: { type: "sessionStarted", lease: lease() },
			}),
		);
		await pending;

		attached.receive(
			JSON.stringify({
				kind: "event",
				event: { type: "approvalRequested", sessionId: "sess-1", approvalId: "a1", summary: "Click Send?" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const [item] = gateway.stream("sess-1").replay(-1);
		expect(item?.event).toMatchObject({ type: "approval_required", runId: "run-1", approvalId: "a1" });
		gateway.dispose();
	});

	it("maps gateway failures onto the protocol code the Studio labels correctly", () => {
		expect(toProtocolError(new RunnerGatewayError("x", "RUNNER_SESSION_EXPIRED")).code).toBe(
			"session_expired",
		);
		expect(toProtocolError(new RunnerGatewayError("x", "RUNNER_SESSION_NOT_FOUND")).code).toBe(
			"no_active_session",
		);
		expect(toProtocolError(new RunnerGatewayError("x", "RUNNER_SESSION_NOT_ACTIVE")).code).toBe(
			"no_active_session",
		);
		expect(toProtocolError(new RunnerGatewayError("x", "RUNNER_SCOPE_DENIED")).code).toBe(
			"scope_denied",
		);
		expect(toProtocolError(new RunnerGatewayError("x", "RUNNER_REVOKED")).code).toBe(
			"unauthenticated",
		);
	});

	it("refuses to dispatch into an unknown session", async () => {
		const { gateway } = await pairedGateway();
		await expect(gateway.dispatch("nope", { type: "listWindows" })).rejects.toMatchObject({
			code: "RUNNER_SESSION_NOT_FOUND",
		});
	});

	it("expires a session past its lease", async () => {
		const store = new InMemoryRunnerStore();
		const mux = new SessionMultiplexer();
		let clock = 1_000;
		const gateway = new RunnerGateway({ mux, store, now: () => clock });

		await store.saveSession({
			sessionId: "sess-old",
			runnerId: "runner-a",
			runId: "run-1",
			userId: "user-1",
			state: "active",
			grantedScopes: ["observe_screen"],
			guard: lease().guard,
			startedAt: 1_000,
			expiresAt: 2_000,
		});

		clock = 3_000;
		await expect(gateway.dispatch("sess-old", { type: "listWindows" })).rejects.toMatchObject({
			code: "RUNNER_SESSION_EXPIRED",
		});
		expect((await store.getSession("sess-old"))?.state).toBe("ended");
	});
});

describe("progress reaches the SSE wire", () => {
	it("carries stage and fraction through as a typed AgentEvent", () => {
		const event: AgentEvent = { type: "progress", stage: "recording", fraction: 0.25, detail: "3 of 12" };
		const round = JSON.parse(JSON.stringify(event)) as AgentEvent;
		expect(round).toEqual(event);
		expect(round.type).toBe("progress");
	});
});
