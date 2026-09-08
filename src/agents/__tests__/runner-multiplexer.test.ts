import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PROTOCOL_VERSION,
	type Envelope,
	type RunnerInfo,
	type Scope,
} from "@/agents/runner/protocol";
import { RunnerTransportError, SessionMultiplexer } from "@/agents/transport/multiplexer";
import type { RunnerSocket } from "@/agents/transport/types";

class FakeSocket implements RunnerSocket {
	readonly sent: Envelope[] = [];
	closed: { code?: number; reason?: string } | null = null;
	failNextSend = false;

	send(frame: string): void {
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("socket write failed");
		}
		this.sent.push(JSON.parse(frame) as Envelope);
	}

	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}

	lastCommandId(): string {
		const last = this.sent.at(-1);
		if (!last || last.kind !== "command") throw new Error("no command sent");
		return last.id;
	}
}

function runnerInfo(overrides: Partial<RunnerInfo> = {}): RunnerInfo {
	return {
		runnerId: "runner-a",
		protocolVersion: PROTOCOL_VERSION,
		capVersion: "0.3.0",
		os: "macOS",
		osVersion: "15.4",
		arch: "arm64",
		permissions: { screenRecording: true, accessibility: true, microphone: false, camera: false },
		...overrides,
	};
}

async function connect(
	mux: SessionMultiplexer,
	info: RunnerInfo = runnerInfo(),
): Promise<{ socket: FakeSocket; attached: ReturnType<SessionMultiplexer["attach"]> }> {
	const socket = new FakeSocket();
	const attached = mux.attach(socket);
	attached.receive(
		JSON.stringify({ kind: "reply", id: socket.lastCommandId(), result: { type: "handshake", runner: info } }),
	);
	await attached.ready;
	return { socket, attached };
}

const OBSERVE = {
	type: "observe" as const,
	request: { displayId: null, includeElements: false, maxDimension: 1024 },
};

const SCOPES: Scope[] = ["observe_screen"];

describe("SessionMultiplexer handshake", () => {
	it("sends a handshake command on attach and resolves with the runner id", async () => {
		const mux = new SessionMultiplexer();
		const socket = new FakeSocket();
		const attached = mux.attach(socket);

		expect(socket.sent).toHaveLength(1);
		const first = socket.sent[0];
		expect(first.kind).toBe("command");
		if (first.kind === "command") {
			expect(first.command).toEqual({ type: "handshake", protocolVersion: PROTOCOL_VERSION });
		}

		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: socket.lastCommandId(),
				result: { type: "handshake", runner: runnerInfo() },
			}),
		);

		await expect(attached.ready).resolves.toBe("runner-a");
		expect(mux.isConnected("runner-a")).toBe(true);
		expect(mux.listConnections()).toHaveLength(1);
	});

	it("refuses a runner on a different protocol major", async () => {
		const mux = new SessionMultiplexer();
		const socket = new FakeSocket();
		const attached = mux.attach(socket);
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: socket.lastCommandId(),
				result: { type: "handshake", runner: runnerInfo({ protocolVersion: "2.0.0" }) },
			}),
		);

		await expect(attached.ready).rejects.toThrow(/protocol 2\.0\.0/);
		expect(mux.isConnected("runner-a")).toBe(false);
		expect(socket.closed).not.toBeNull();
	});

	it("times out a runner that never answers the handshake", async () => {
		vi.useFakeTimers();
		const mux = new SessionMultiplexer({ handshakeTimeoutMs: 1_000 });
		const socket = new FakeSocket();
		const attached = mux.attach(socket);
		const ready = expect(attached.ready).rejects.toThrow(/handshake within 1000ms/);
		vi.advanceTimersByTime(1_001);
		await ready;
		expect(socket.closed).not.toBeNull();
		vi.useRealTimers();
	});

	it("closes a connection that sends a malformed frame", async () => {
		const mux = new SessionMultiplexer();
		const { socket, attached } = await connect(mux);
		attached.receive('{"kind":"reply","id":"x"}');
		expect(mux.isConnected("runner-a")).toBe(false);
		expect(socket.closed).not.toBeNull();
	});

	it("refuses a runner that tries to send commands to the control plane", async () => {
		const mux = new SessionMultiplexer();
		const { attached } = await connect(mux);
		attached.receive(
			JSON.stringify({
				kind: "command",
				id: "evil",
				token: "",
				command: { type: "handshake", protocolVersion: PROTOCOL_VERSION },
			}),
		);
		expect(mux.isConnected("runner-a")).toBe(false);
	});
});

describe("SessionMultiplexer correlation", () => {
	it("resolves each command with the reply carrying its envelope id", async () => {
		const mux = new SessionMultiplexer();
		const { socket, attached } = await connect(mux);

		const first = mux.send("runner-a", OBSERVE, "tok");
		const firstId = socket.lastCommandId();
		const second = mux.send("runner-a", { type: "listWindows" }, "tok");
		const secondId = socket.lastCommandId();

		expect(firstId).not.toBe(secondId);

		// Reply out of order — correlation is by id, not arrival order.
		attached.receive(
			JSON.stringify({ kind: "reply", id: secondId, result: { type: "windows", windows: [] } }),
		);
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: firstId,
				result: {
					type: "observed",
					frame: {
						frameId: "f1",
						imageRef: "blob://1",
						width: 100,
						height: 50,
						capturedAtUnixMs: 1,
						display: { displayId: "d1", width: 100, height: 50, scaleFactor: 2, isPrimary: true },
						focusedWindow: null,
						elements: [],
						redactedWindows: [],
					},
				},
			}),
		);

		await expect(second).resolves.toMatchObject({ type: "windows" });
		await expect(first).resolves.toMatchObject({ type: "observed" });
	});

	it("rejects with the runner's ProtocolError on a failure envelope", async () => {
		const mux = new SessionMultiplexer();
		const { socket, attached } = await connect(mux);
		const pending = mux.send("runner-a", OBSERVE, "tok");
		attached.receive(
			JSON.stringify({
				kind: "failure",
				id: socket.lastCommandId(),
				error: { code: "permission_missing", message: "Screen recording is off", remediation: "Open Settings" },
			}),
		);

		await expect(pending).rejects.toThrow(/Screen recording is off/);
		await pending.catch((err: unknown) => {
			expect(err).toBeInstanceOf(RunnerTransportError);
			if (err instanceof RunnerTransportError) {
				expect(err.protocol.code).toBe("permission_missing");
				expect(err.protocol.remediation).toBe("Open Settings");
			}
		});
	});

	it("refuses to send to a runner that is not connected", async () => {
		const mux = new SessionMultiplexer();
		await expect(mux.send("ghost", OBSERVE, "tok")).rejects.toThrow(/not connected/);
	});

	it("ignores a reply for an unknown id instead of crashing", async () => {
		const mux = new SessionMultiplexer();
		const { attached } = await connect(mux);
		attached.receive(JSON.stringify({ kind: "reply", id: "nope", result: { type: "windows", windows: [] } }));
		expect(mux.isConnected("runner-a")).toBe(true);
	});
});

describe("SessionMultiplexer timeouts", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("fails a command the runner never answers", async () => {
		const mux = new SessionMultiplexer({ commandTimeoutMs: 5_000 });
		const socket = new FakeSocket();
		const attached = mux.attach(socket);
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: socket.lastCommandId(),
				result: { type: "handshake", runner: runnerInfo() },
			}),
		);
		await attached.ready;

		const pending = mux.send("runner-a", OBSERVE, "tok");
		const assertion = expect(pending).rejects.toThrow(/did not reply to "observe" within 5000ms/);
		vi.advanceTimersByTime(5_001);
		await assertion;
	});

	it("honours a per-command timeout override", async () => {
		const mux = new SessionMultiplexer({ commandTimeoutMs: 60_000 });
		const socket = new FakeSocket();
		const attached = mux.attach(socket);
		attached.receive(
			JSON.stringify({
				kind: "reply",
				id: socket.lastCommandId(),
				result: { type: "handshake", runner: runnerInfo() },
			}),
		);
		await attached.ready;

		const pending = mux.send("runner-a", OBSERVE, "tok", { timeoutMs: 100 });
		const assertion = expect(pending).rejects.toThrow(/within 100ms/);
		vi.advanceTimersByTime(101);
		await assertion;
	});
});

describe("SessionMultiplexer disconnection", () => {
	it("fails every in-flight command when the runner vanishes mid-command", async () => {
		const mux = new SessionMultiplexer();
		const { attached } = await connect(mux);

		const a = mux.send("runner-a", OBSERVE, "tok");
		const b = mux.send("runner-a", { type: "listWindows" }, "tok");

		attached.disconnected("Runner process exited.");

		await expect(a).rejects.toThrow(/Runner process exited/);
		await expect(b).rejects.toThrow(/Runner process exited/);
		expect(mux.isConnected("runner-a")).toBe(false);
	});

	it("emits a disconnect event exactly once", async () => {
		const mux = new SessionMultiplexer();
		const seen: string[] = [];
		mux.onDisconnect(({ runnerId }) => seen.push(runnerId));
		const { attached } = await connect(mux);

		attached.disconnected("gone");
		attached.disconnected("gone again");

		expect(seen).toEqual(["runner-a"]);
	});

	it("fails in-flight commands when a send throws", async () => {
		const mux = new SessionMultiplexer();
		const { socket } = await connect(mux);
		socket.failNextSend = true;
		await expect(mux.send("runner-a", OBSERVE, "tok")).rejects.toThrow(/Send failed/);
		expect(mux.isConnected("runner-a")).toBe(false);
	});

	it("replaces a runner's connection on reconnect and fails the old one's work", async () => {
		const mux = new SessionMultiplexer();
		const first = await connect(mux);
		const pending = mux.send("runner-a", OBSERVE, "tok");

		const second = await connect(mux);

		await expect(pending).rejects.toThrow(/Replaced by a newer connection/);
		expect(first.socket.closed).not.toBeNull();
		expect(mux.isConnected("runner-a")).toBe(true);
		expect(mux.listConnections()).toHaveLength(1);

		const live = mux.send("runner-a", { type: "listWindows" }, "tok");
		second.attached.receive(
			JSON.stringify({ kind: "reply", id: second.socket.lastCommandId(), result: { type: "windows", windows: [] } }),
		);
		await expect(live).resolves.toMatchObject({ type: "windows" });
	});
});

describe("SessionMultiplexer heartbeat liveness", () => {
	it("closes a connection that stops sending frames", async () => {
		let clock = 1_000;
		const mux = new SessionMultiplexer({ heartbeatTimeoutMs: 10_000, now: () => clock });
		const { socket, attached } = await connect(mux);

		clock = 5_000;
		expect(mux.sweepIdle()).toBe(0);
		expect(mux.isConnected("runner-a")).toBe(true);

		attached.receive(JSON.stringify({ kind: "event", event: { type: "heartbeat", unixMs: 5_000 } }));

		clock = 14_000;
		expect(mux.sweepIdle()).toBe(0);

		clock = 16_000;
		expect(mux.sweepIdle()).toBe(1);
		expect(mux.isConnected("runner-a")).toBe(false);
		expect(socket.closed?.reason).toContain("missed heartbeats");
	});

	it("fans runner events out to every listener with the runner id", async () => {
		const mux = new SessionMultiplexer();
		const seen: string[] = [];
		mux.onEvent(({ runnerId, event }) => seen.push(`${runnerId}:${event.type}`));
		mux.onEvent(({ event }) => seen.push(`second:${event.type}`));
		const { attached } = await connect(mux);

		attached.receive(
			JSON.stringify({
				kind: "event",
				event: { type: "progress", sessionId: "s1", stage: "export", fraction: 0.25, detail: null },
			}),
		);

		expect(seen).toEqual(["runner-a:progress", "second:progress"]);
	});

	it("keeps serving other listeners when one throws", async () => {
		const mux = new SessionMultiplexer();
		const seen: string[] = [];
		mux.onEvent(() => {
			throw new Error("bad listener");
		});
		mux.onEvent(({ event }) => seen.push(event.type));
		const { attached } = await connect(mux);
		attached.receive(JSON.stringify({ kind: "event", event: { type: "heartbeat", unixMs: 1 } }));
		expect(seen).toEqual(["heartbeat"]);
	});

	it("closeAll drops every connection", async () => {
		const mux = new SessionMultiplexer();
		await connect(mux, runnerInfo({ runnerId: "a" }));
		await connect(mux, runnerInfo({ runnerId: "b" }));
		expect(mux.listConnections()).toHaveLength(2);
		mux.closeAll();
		expect(mux.listConnections()).toHaveLength(0);
	});

	it("forwards the granted scopes verbatim in a sessionStart command", async () => {
		const mux = new SessionMultiplexer();
		const { socket, attached } = await connect(mux);
		const pending = mux.send(
			"runner-a",
			{
				type: "sessionStart",
				runId: "run-1",
				requestedScopes: { scopes: SCOPES },
				guard: {
					allowedBundleIds: ["com.apple.Safari"],
					redactedTitlePatterns: ["1Password"],
					idleTimeoutMs: 60_000,
					maxDurationMs: 900_000,
					requireStepApproval: false,
				},
			},
			"tok-123",
		);

		const sent = socket.sent.at(-1);
		expect(sent?.kind).toBe("command");
		if (sent?.kind === "command") {
			expect(sent.token).toBe("tok-123");
			expect(sent.command).toMatchObject({ type: "sessionStart", requestedScopes: { scopes: SCOPES } });
		}

		attached.disconnected("done");
		await expect(pending).rejects.toThrow();
	});
});
