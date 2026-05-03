/**
 * Unit tests for the core harness plugin lifecycle.
 *
 * We mock @openai/agents so tests run without a real API key and focus purely
 * on whether the plugin hooks fire in the right order with the right arguments.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { run as mockRun } from "@openai/agents";
import type { HarnessPlugin, AgentEvent, PluginRunContext } from "../types";
import { createCoreHarness } from "../core";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@openai/agents", () => ({
  Agent: class Agent {
    constructor(public readonly config: unknown) {}
  },
  run: vi.fn(),
}));

vi.mock("../skills/index", () => ({
  resolveAgentTools: vi.fn(() => []),
}));

vi.mock("../utils", () => ({
  toOpenAITool: vi.fn((def: unknown) => def),
}));

vi.mock("../lib/config", () => ({
  config: { openai: { model: "gpt-4o-test" } },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const runMock = vi.mocked(mockRun);

/** Build a fake streaming run result. */
function setupRun(events: object[] = [], finalOutput = "final answer") {
  const iterable = {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    finalOutput,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  };
  // run() returns a promise-like that resolves to the iterable
  runMock.mockResolvedValue(iterable as never);
}

/** Collect all events from a harness stream. */
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const baseInput = {
  messages: [{ role: "user" as const, content: "hello" }],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("core harness — plugin lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
  });

  it("runs with no plugins and emits done", async () => {
    const harness = createCoreHarness({ name: "Test", instructions: "be helpful" });
    const events = await collect(harness.stream(baseInput));
    expect(events.at(-1)?.type).toBe("done");
  });

  it("calls onBeforeRun and transforms userMessage", async () => {
    const plugin: HarnessPlugin = {
      name: "transform",
      onBeforeRun: vi.fn(async (msg) => msg.toUpperCase()),
    };

    const harness = createCoreHarness({
      name: "Test",
      instructions: "be helpful",
      plugins: [plugin],
    });

    await collect(harness.stream(baseInput));

    expect(runMock).toHaveBeenCalledWith(expect.anything(), "HELLO", expect.anything());
    expect(plugin.onBeforeRun).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ agentName: "Test" }),
      baseInput
    );
  });

  it("calls onBeforeRun plugins in array order, chaining output", async () => {
    const order: string[] = [];

    const plugins: HarnessPlugin[] = [
      {
        name: "first",
        onBeforeRun: async (msg) => { order.push("first"); return msg + " A"; },
      },
      {
        name: "second",
        onBeforeRun: async (msg) => { order.push("second"); return msg + " B"; },
      },
    ];

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins });
    await collect(harness.stream(baseInput));

    expect(order).toEqual(["first", "second"]);
    expect(runMock).toHaveBeenCalledWith(expect.anything(), "hello A B", expect.anything());
  });

  it("blocks the run and emits error+done when onBeforeRun throws", async () => {
    const plugin: HarnessPlugin = {
      name: "blocker",
      onBeforeRun: async () => { throw new Error("too long"); },
    };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    const events = await collect(harness.stream(baseInput));

    expect(events.find((e) => e.type === "error")).toMatchObject({ error: "too long" });
    expect(events.at(-1)).toMatchObject({ type: "done", finalOutput: "" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("calls onComplete even when onBeforeRun throws", async () => {
    const onComplete = vi.fn();

    const plugins: HarnessPlugin[] = [
      { name: "blocker", onBeforeRun: async () => { throw new Error("blocked"); } },
      { name: "cleanup", onComplete },
    ];

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins });
    await collect(harness.stream(baseInput));

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "Test" }),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("calls onResolveInstructions with base instructions and userMessage", async () => {
    const plugin: HarnessPlugin = {
      name: "inject",
      onResolveInstructions: vi.fn(async (inst, msg) => `${inst}\n[context: ${msg}]`),
    };

    const harness = createCoreHarness({
      name: "Test",
      instructions: "base instructions",
      plugins: [plugin],
    });
    await collect(harness.stream(baseInput));

    expect(plugin.onResolveInstructions).toHaveBeenCalledWith(
      "base instructions",
      "hello",
      expect.objectContaining({ agentName: "Test" })
    );
  });

  it("filters stream events through onEvent plugins", async () => {
    setupRun([
      { type: "raw_model_stream_event", data: { delta: { content: "hello" } } },
      {
        type: "run_item_stream_event",
        item: { type: "message_output_item", content: [{ type: "output_text", text: "done" }] },
      },
    ], "done");

    const seen: string[] = [];
    const plugin: HarnessPlugin = {
      name: "observer",
      onEvent: async (event) => { seen.push(event.type); return event; },
    };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    await collect(harness.stream(baseInput));

    expect(seen).toContain("message_delta");
    expect(seen).toContain("message_done");
  });

  it("suppresses events when onEvent returns null", async () => {
    setupRun([
      { type: "raw_model_stream_event", data: { delta: { content: "secret" } } },
    ], "secret");

    const plugin: HarnessPlugin = {
      name: "suppressor",
      onEvent: async (event) => event.type === "message_delta" ? null : event,
    };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    const events = await collect(harness.stream(baseInput));

    expect(events.find((e) => e.type === "message_delta")).toBeUndefined();
  });

  it("calls onAfterRun and transforms finalOutput", async () => {
    setupRun([], "raw output");

    const plugin: HarnessPlugin = {
      name: "transformer",
      onAfterRun: async (output) => output.toUpperCase(),
    };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    const events = await collect(harness.stream(baseInput));

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    expect(done?.finalOutput).toBe("RAW OUTPUT");
  });

  it("blocks output and emits error when onAfterRun throws", async () => {
    setupRun([], "bad output");

    const plugin: HarnessPlugin = {
      name: "output-blocker",
      onAfterRun: async () => { throw new Error("output blocked"); },
    };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    const events = await collect(harness.stream(baseInput));

    expect(events.find((e) => e.type === "error")).toMatchObject({ error: "output blocked" });
  });

  it("calls onError when SDK run throws", async () => {
    runMock.mockRejectedValue(new Error("SDK exploded") as never);

    const onError = vi.fn();
    const plugin: HarnessPlugin = { name: "err-handler", onError };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    const events = await collect(harness.stream(baseInput));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "SDK exploded" }),
      expect.objectContaining({ agentName: "Test" })
    );
    expect(events.find((e) => e.type === "error")).toMatchObject({ error: "SDK exploded" });
  });

  it("always calls onComplete via finally — even on SDK error", async () => {
    runMock.mockRejectedValue(new Error("boom") as never);

    const onComplete = vi.fn();
    const plugin: HarnessPlugin = { name: "cleanup", onComplete };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    await collect(harness.stream(baseInput));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("onComplete receives finalOutput and durationMs on success", async () => {
    setupRun([], "the answer");

    const onComplete = vi.fn();
    const plugin: HarnessPlugin = { name: "recorder", onComplete };

    const harness = createCoreHarness({ name: "Test", instructions: "x", plugins: [plugin] });
    await collect(harness.stream(baseInput));

    expect(onComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ finalOutput: "the answer", durationMs: expect.any(Number) })
    );
  });

  it("PluginRunContext has correct fields", async () => {
    const capturedCtx: PluginRunContext[] = [];
    const plugin: HarnessPlugin = {
      name: "spy",
      onBeforeRun: async (msg, ctx) => { capturedCtx.push(ctx); return msg; },
    };

    const harness = createCoreHarness({ name: "MyAgent", instructions: "x", plugins: [plugin] });
    await collect(harness.stream({ ...baseInput, context: { userId: "u123" } }));

    expect(capturedCtx[0]).toMatchObject({
      agentName: "MyAgent",
      model: "gpt-4o-test",
      userId: "u123",
      context: { userId: "u123" },
    });
    expect(typeof capturedCtx[0].runId).toBe("string");
    expect(typeof capturedCtx[0].startedAt).toBe("number");
  });

  it("emits usage event when SDK reports usage", async () => {
    setupRun([], "answer");

    const harness = createCoreHarness({ name: "Test", instructions: "x" });
    const events = await collect(harness.stream(baseInput));

    const usage = events.find((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });
});

describe("core harness — run() method", () => {
  it("returns finalOutput, messages, and toolCalls", async () => {
    vi.clearAllMocks();
    setupRun([], "summary result");

    const harness = createCoreHarness({ name: "Test", instructions: "x" });
    const result = await harness.run(baseInput);

    expect(result.finalOutput).toBe("summary result");
    expect(result.messages).toEqual(baseInput.messages);
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20 });
  });
});
