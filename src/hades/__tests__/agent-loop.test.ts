import { describe, it, expect } from "vitest";
import { AgentLoop } from "../agent/loop";
import type { AgentLoopOptions } from "../agent/loop";
import { builtinRegistry, ToolRegistry } from "../agent/tools";
import type { ModelClient, ChatMessage, ChatResponse } from "../models/client";

/**
 * A fully-scripted fake ModelClient. The `script` function receives the
 * conversation so far plus the 0-based call index and returns the model's
 * text for this turn (plus optional token/cost accounting). Deterministic:
 * no network, no keys, no randomness.
 */
type Turn = { text: string; tokensIn?: number; tokensOut?: number; usd?: number };

class FakeClient implements ModelClient {
  public calls = 0;
  constructor(
    private readonly script: (messages: ChatMessage[], call: number) => Turn,
  ) {}
  async chat(req: {
    model: string;
    messages: ChatMessage[];
  }): Promise<ChatResponse> {
    const turn = this.script(req.messages, this.calls);
    this.calls++;
    return {
      text: turn.text,
      tokensIn: turn.tokensIn ?? 0,
      tokensOut: turn.tokensOut ?? 0,
      usd: turn.usd ?? 0,
      model: req.model,
      provider: "fake",
    };
  }
}

/** Fixed script by turn index. */
function scripted(turns: Turn[]): FakeClient {
  return new FakeClient((_m, i) => turns[i] ?? { text: "ANSWER: (exhausted)" });
}

const baseOpts: AgentLoopOptions = { model: "claude-fable-5" };

describe("AgentLoop", () => {
  it("direct-answer path: ANSWER on turn 1, no tools", async () => {
    const client = scripted([{ text: "ANSWER: 42" }]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("what is the answer?");

    expect(r.answer).toBe("42");
    expect(r.steps).toBe(1);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.hitStepLimit).toBe(false);
    expect(client.calls).toBe(1);
  });

  it("tool path: calls calc via the real builtin registry, then answers", async () => {
    const client = scripted([
      { text: "reasoning...\nTOOL: calc\nINPUT: 2+3" },
      { text: "ANSWER: 5" },
    ]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("add two and three");

    expect(r.answer).toBe("5");
    expect(r.steps).toBe(2);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].call).toEqual({ tool: "calc", input: "2+3" });
    expect(r.toolCalls[0].result).toBe("5");
    // The observation was fed back into the transcript.
    expect(r.transcript.some((m) => m.content === "TOOL_RESULT: 5")).toBe(true);
    expect(r.hitStepLimit).toBe(false);
  });

  it("accumulates tokens and usd across every turn", async () => {
    const client = scripted([
      { text: "TOOL: calc\nINPUT: 10*10", tokensIn: 100, tokensOut: 20, usd: 0.001 },
      { text: "ANSWER: 100", tokensIn: 40, tokensOut: 8, usd: 0.0004 },
    ]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("multiply");

    expect(r.answer).toBe("100");
    expect(r.tokensIn).toBe(140);
    expect(r.tokensOut).toBe(28);
    expect(r.usd).toBeCloseTo(0.0014, 10);
  });

  it("terminates on maxSteps when the model never answers", async () => {
    // A model that only ever emits tool calls.
    const client = new FakeClient(() => ({ text: "TOOL: calc\nINPUT: 1+1" }));
    const loop = new AgentLoop(client, builtinRegistry(), {
      ...baseOpts,
      maxSteps: 3,
    });
    const r = await loop.run("loop forever");

    expect(r.hitStepLimit).toBe(true);
    expect(r.steps).toBe(3);
    expect(client.calls).toBe(3);
    // It kept executing the tool each bounded turn.
    expect(r.toolCalls).toHaveLength(3);
  });

  it("defaults maxSteps to 6", async () => {
    const client = new FakeClient(() => ({ text: "TOOL: calc\nINPUT: 1+1" }));
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("never ends");
    expect(r.steps).toBe(6);
    expect(r.hitStepLimit).toBe(true);
  });

  it("malformed reply (no tags) is treated as the final answer", async () => {
    const client = scripted([{ text: "The sky is blue because of Rayleigh scattering." }]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("why is the sky blue?");

    expect(r.answer).toBe("The sky is blue because of Rayleigh scattering.");
    expect(r.steps).toBe(1);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.hitStepLimit).toBe(false);
  });

  it("tool error path: unknown tool becomes a TOOL_ERROR the model recovers from", async () => {
    const client = scripted([
      { text: "TOOL: nonexistent\nINPUT: whatever" },
      { text: "ANSWER: recovered" },
    ]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("try a bad tool");

    expect(r.answer).toBe("recovered");
    expect(r.steps).toBe(2);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].result).toBe("unknown tool: nonexistent");
    expect(
      r.transcript.some((m) => m.content === "TOOL_ERROR: unknown tool: nonexistent"),
    ).toBe(true);
    expect(r.hitStepLimit).toBe(false);
  });

  it("parses tags case-insensitively and ignores markdown fences", async () => {
    const client = scripted([
      { text: "```\ntool: calc\ninput: 6*7\n```" },
      { text: "answer: 42" },
    ]);
    const loop = new AgentLoop(client, builtinRegistry(), baseOpts);
    const r = await loop.run("case insensitive");

    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].call.tool).toBe("calc");
    expect(r.toolCalls[0].result).toBe("42");
    expect(r.answer).toBe("42");
  });

  it("injects the tool protocol + extra system guidance and the task into the transcript", async () => {
    const client = scripted([{ text: "ANSWER: ok" }]);
    const loop = new AgentLoop(client, builtinRegistry(), {
      ...baseOpts,
      system: "Always be concise.",
    });
    const r = await loop.run("hello");

    expect(r.transcript[0].role).toBe("system");
    expect(r.transcript[0].content).toContain("- calc:");
    expect(r.transcript[0].content).toContain("Always be concise.");
    expect(r.transcript[1]).toEqual({ role: "user", content: "hello" });
  });

  it("never throws even if a tool registry surfaces an error result", async () => {
    // calc with a hostile, unparseable input -> ok:false, but the loop must
    // keep going and let the model answer.
    const registry: ToolRegistry = builtinRegistry();
    const client = scripted([
      { text: "TOOL: calc\nINPUT: process.exit(1)" },
      { text: "ANSWER: safe" },
    ]);
    const loop = new AgentLoop(client, registry, baseOpts);
    const r = await loop.run("hostile input");

    expect(r.answer).toBe("safe");
    expect(r.toolCalls[0].result).toMatch(/^error:/);
    expect(r.transcript.some((m) => m.content.startsWith("TOOL_ERROR:"))).toBe(true);
  });
});
