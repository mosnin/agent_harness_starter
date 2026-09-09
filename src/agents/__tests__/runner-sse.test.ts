import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sseEventStream, sseFrame } from "@/agents/transport/sse";
import { sseStream } from "@/agents/lib/utils";
import type { AgentEvent } from "@/agents/types";

const REPO_ROOT = join(__dirname, "..", "..", "..");

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let out = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out;
}

/** Exactly what components/AgentChat/index.tsx does: split lines, strip "data: ", JSON.parse once. */
function parseLikeTheClient(wire: string): unknown[] {
	const out: unknown[] = [];
	for (const line of wire.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const raw = line.slice(6);
		if (raw === "[DONE]") continue;
		out.push(JSON.parse(raw));
	}
	return out;
}

async function* events(): AsyncGenerator<AgentEvent & { threadId: string; runId: string }> {
	yield { threadId: "t1", runId: "r1", type: "message_delta", delta: "hel" };
	yield { threadId: "t1", runId: "r1", type: "tool_call", name: "web_search", input: {}, callId: "c1" };
	yield { threadId: "t1", runId: "r1", type: "progress", stage: "recording", fraction: 0.5 };
	yield { threadId: "t1", runId: "r1", type: "done", finalOutput: "hello" };
}

describe("SSE wire format", () => {
	it("parses to an OBJECT with a .type after a single JSON.parse", async () => {
		const wire = await drain(sseEventStream(events()));
		const parsed = parseLikeTheClient(wire);

		expect(parsed).toHaveLength(4);
		for (const event of parsed) {
			expect(typeof event).toBe("object");
			expect(event).not.toBeTypeOf("string");
			expect((event as { type?: unknown }).type).toBeTypeOf("string");
		}
		expect((parsed[0] as { type: string; delta: string }).delta).toBe("hel");
		expect((parsed[2] as { type: string; stage: string }).stage).toBe("recording");
	});

	it("terminates with the [DONE] sentinel", async () => {
		const wire = await drain(sseEventStream(events()));
		expect(wire.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("demonstrates the double-encode defect this test guards against", async () => {
		// The old shape: a route yielding JSON strings into sseStream, which stringifies again.
		async function* preStringified(): AsyncGenerator<string> {
			yield JSON.stringify({ type: "message_delta", delta: "hel" });
		}
		const wire = await drain(sseStream(preStringified()));
		const [first] = parseLikeTheClient(wire);

		expect(typeof first).toBe("string");
		expect((first as { type?: unknown }).type).toBeUndefined();
	});

	it("emits resumable id lines when asked", async () => {
		const wire = await drain(sseEventStream(events(), { withIds: true, startSeq: 7 }));
		expect(wire).toContain("id: 7\n");
		expect(wire).toContain("id: 10\n");
	});

	it("encodes a single frame without an id when none is given", () => {
		expect(sseFrame({ type: "progress", stage: "x" })).toBe('data: {"type":"progress","stage":"x"}\n\n');
		expect(sseFrame({ type: "progress", stage: "x" }, 3)).toBe(
			'id: 3\ndata: {"type":"progress","stage":"x"}\n\n',
		);
	});

	it("reports a generator failure as an error event, not a broken frame", async () => {
		async function* boom(): AsyncGenerator<AgentEvent> {
			yield { type: "message_delta", delta: "a" };
			throw new Error("upstream exploded");
		}
		const parsed = parseLikeTheClient(await drain(sseEventStream(boom())));
		expect(parsed.at(-1)).toEqual({ type: "error", error: "upstream exploded" });
	});
});

describe("agent routes no longer pre-stringify", () => {
	// Source-level lock: sseEventStream encodes once, so a route that stringifies first
	// reintroduces the defect. Both routes must yield event objects.
	const routes = ["routes/agent/route.ts", "routes/anthropic-agent/route.ts"];

	for (const route of routes) {
		it(`${route} yields event objects into sseEventStream`, () => {
			const source = readFileSync(join(REPO_ROOT, route), "utf8");
			expect(source).toContain("sseEventStream(eventGenerator())");
			expect(source).not.toContain("sseStream(");
			expect(source).not.toMatch(/yield\s+JSON\.stringify\(/);
		});
	}
});
