import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerGateway, setRunnerGateway } from "@/agents/runner/gateway";
import {
	InMemoryRunnerStore,
	type RunnerSessionRecord,
	setRunnerStore,
} from "@/agents/runner/registry";
import { SessionMultiplexer } from "@/agents/transport/multiplexer";

vi.mock("@/agents/auth", () => ({
	auth: { requireAuth: async () => ({ id: "user-1", email: "user@example.test", name: "U" }) },
}));

const { GET } = await import("../../../routes/runner/events/route");

function session(overrides: Partial<RunnerSessionRecord> = {}): RunnerSessionRecord {
	return {
		sessionId: "sess-1",
		runnerId: "runner-a",
		runId: "run-1",
		userId: "user-1",
		state: "active",
		grantedScopes: ["observe_screen"],
		guard: {
			allowedBundleIds: [],
			redactedTitlePatterns: [],
			idleTimeoutMs: 60_000,
			maxDurationMs: 900_000,
			requireStepApproval: true,
		},
		startedAt: 1_000,
		expiresAt: 9_000_000,
		...overrides,
	};
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let out = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out;
}

/** Parses the wire the way an EventSource client sees it: one `id`/`data` pair per frame. */
function frames(wire: string): Array<{ id: number | null; data: string }> {
	return wire
		.split("\n\n")
		.filter((frame) => frame.trim() !== "")
		.map((frame) => {
			const idLine = frame.split("\n").find((line) => line.startsWith("id: "));
			const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
			return {
				id: idLine ? Number.parseInt(idLine.slice(4), 10) : null,
				data: dataLine ? dataLine.slice(6) : "",
			};
		});
}

function request(lastEventId?: string, sessionId = "sess-1"): Request {
	const headers = new Headers();
	if (lastEventId !== undefined) headers.set("Last-Event-ID", lastEventId);
	return new Request(`http://hades.test/api/runner/events?sessionId=${sessionId}`, { headers });
}

describe("GET /api/runner/events", () => {
	let store: InMemoryRunnerStore;
	let gateway: RunnerGateway;

	beforeEach(() => {
		store = new InMemoryRunnerStore();
		setRunnerStore(store);
		gateway = new RunnerGateway({ mux: new SessionMultiplexer(), store });
		setRunnerGateway(gateway);
	});

	afterEach(() => {
		gateway.dispose();
	});

	it("stamps each frame with the event's own sequence number, even after the buffer dropped events", async () => {
		await store.saveSession(session());
		const stream = gateway.stream("sess-1");
		const total = 600;
		for (let i = 0; i < total; i++) stream.push({ type: "progress", stage: `s${i}` });
		stream.close();

		const response = await GET(request("10"));
		expect(response.status).toBe(200);
		const delivered = frames(await drain(response.body)).filter((f) => f.id !== null);

		expect(delivered.length).toBeGreaterThan(0);
		expect(delivered.at(-1)?.id).toBe(total - 1);
		for (const frame of delivered) {
			const parsed = JSON.parse(frame.data) as { seq: number; stage: string };
			expect(frame.id).toBe(parsed.seq);
			expect(parsed.stage).toBe(`s${parsed.seq}`);
		}
	});

	it("resumes from Last-Event-ID N at N+1 without replaying N or skipping N+1", async () => {
		await store.saveSession(session());
		const stream = gateway.stream("sess-1");
		for (let i = 0; i < 5; i++) stream.push({ type: "progress", stage: `s${i}` });
		stream.close();

		const response = await GET(request("2"));
		const ids = frames(await drain(response.body))
			.filter((f) => f.id !== null)
			.map((f) => f.id);
		expect(ids).toEqual([3, 4]);
	});

	it("emits only frames an EventSource consumer can JSON.parse", async () => {
		await store.saveSession(session());
		const stream = gateway.stream("sess-1");
		stream.push({ type: "progress", stage: "a" });
		stream.close();

		const wire = await drain((await GET(request())).body);
		for (const frame of frames(wire)) {
			expect(() => JSON.parse(frame.data)).not.toThrow();
			expect(JSON.parse(frame.data)).toMatchObject({ sessionId: "sess-1", runId: "run-1" });
		}
	});

	it("tells a reconnecting client to stop once an ended session has nothing left to replay", async () => {
		await store.saveSession(session({ state: "ended", endReason: "completed" }));
		const stream = gateway.stream("sess-1");
		stream.push({ type: "progress", stage: "a" });
		stream.push({ type: "progress", stage: "b" });
		stream.close();

		const caughtUp = await GET(request("1"));
		expect(caughtUp.status).toBe(204);

		const behind = await GET(request("0"));
		expect(behind.status).toBe(200);
		const ids = frames(await drain(behind.body))
			.filter((f) => f.id !== null)
			.map((f) => f.id);
		expect(ids).toEqual([1]);
	});

	it("hides another user's session", async () => {
		await store.saveSession(session({ userId: "user-2" }));
		expect((await GET(request())).status).toBe(404);
	});
});
