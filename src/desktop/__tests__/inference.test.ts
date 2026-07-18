import { describe, it, expect } from "vitest";
import { detectInference, createExecutor } from "../core/inference";
import type { ModelClient, ChatRequest, ChatResponse } from "../../hades/models/client";

// ---------------------------------------------------------------------------
// A fake ModelClient — never touches the network, records calls made to it.
// ---------------------------------------------------------------------------

function fakeClient(text: string, usd: number): { client: ModelClient; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const client: ModelClient = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls.push(req);
      return { text, tokensIn: 10, tokensOut: 20, usd, model: req.model, provider: "fake" };
    },
  };
  return { client, calls };
}

const NO_KEYS: Record<string, string | undefined> = {};

describe("detectInference", () => {
  it("is real when ANTHROPIC_API_KEY is present", () => {
    const mode = detectInference({ ANTHROPIC_API_KEY: "sk-fake-anthropic" });
    expect(mode.kind).toBe("real");
    expect(mode.detail).toContain("anthropic");
  });

  it("is mock when no provider key is present", () => {
    const mode = detectInference(NO_KEYS);
    expect(mode.kind).toBe("mock");
    expect(mode.detail.toLowerCase()).toContain("no keys");
  });
});

describe("createExecutor — real path (injected client)", () => {
  it("uses the injected client and never touches the network", async () => {
    const { client, calls } = fakeClient("the real answer", 0.0042);
    const { mode, executor } = createExecutor({ env: NO_KEYS, client });

    expect(mode.kind).toBe("real");

    const result = await executor.run("what is 2+2?");
    expect(result.output).toBe("the real answer");
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(20);
    expect(result.usd).toBeCloseTo(0.0042);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toEqual([{ role: "user", content: "what is 2+2?" }]);
  });

  it("is real even with no env keys, because a client was injected", async () => {
    const { client } = fakeClient("ok", 0);
    const { mode } = createExecutor({ env: NO_KEYS, client });
    expect(mode.kind).toBe("real");
    expect(mode.detail).not.toContain("deterministic mock");
  });
});

describe("createExecutor — mock path (no client, no keys)", () => {
  it("returns mock mode with usd 0 and a clearly-labeled deterministic answer", async () => {
    const { mode, executor } = createExecutor({ env: NO_KEYS });
    expect(mode.kind).toBe("mock");
    expect(mode.detail.toLowerCase()).toContain("no keys");

    const result = await executor.run("summarize this document");
    expect(result.usd).toBe(0);
    expect(result.output.startsWith("[mock] ")).toBe(true);
  });

  it("is deterministic — same prompt in, same output out", async () => {
    const { executor } = createExecutor({ env: NO_KEYS });
    const a = await executor.run("the quick brown fox");
    const b = await executor.run("the quick brown fox");
    expect(a.output).toBe(b.output);
  });

  it("never calls a network client when running mock (no client/keys were ever given)", async () => {
    // No injected client and no env keys => createExecutor must not construct
    // or invoke any real ModelClient. We assert this indirectly: calling
    // `run` twice with different prompts produces different, purely local
    // output with zero cost every time — behaviour only explainable by a
    // fully offline path.
    const { executor } = createExecutor({ env: NO_KEYS });
    const a = await executor.run("prompt one");
    const b = await executor.run("prompt two entirely different");
    expect(a.output).not.toBe(b.output);
    expect(a.usd).toBe(0);
    expect(b.usd).toBe(0);
  });
});

describe("createExecutor — honesty of mode.detail", () => {
  it("mock detail never claims to be real", () => {
    const { mode } = createExecutor({ env: NO_KEYS });
    expect(mode.detail).not.toMatch(/anthropic|openai/i);
  });

  it("real (env-derived) detail names the provider found", () => {
    const { mode } = createExecutor({ env: { OPENAI_API_KEY: "sk-fake-openai" } });
    expect(mode.kind).toBe("real");
    expect(mode.detail).toContain("openai");
  });
});
