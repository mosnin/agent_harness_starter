/**
 * The worker transports' cost seam.
 *
 * `createOpenAICompatibleChat` is the client the swarm's workers actually run
 * on, and it already RECEIVED a `usage` block from every provider — it just
 * threw it away and returned the message text, which is why a swarm run could
 * never say what it cost. These tests pin the seam that fixed that, on both
 * dialects, with the same contract the rest of the cost stack relies on:
 *
 *   - a reported count is surfaced verbatim;
 *   - an ABSENT usage block yields `null`, never `0` (a call that consumed
 *     tokens must not be recorded as free);
 *   - a failed request emits NO observation at all;
 *   - the observation names the provider and model but never a key.
 */
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleChat, type ChatUsageObservation } from "../worker/llm-executor";
import { createChat } from "../worker/providers";
import { summarizeCalls } from "../../hades/cost/meter";

function fakeFetch(json: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Monotonic fake clock so latency is deterministic. */
function fakeClock(step = 5): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

describe("createOpenAICompatibleChat usage seam", () => {
  it("surfaces the provider's reported usage and measured latency", async () => {
    const seen: ChatUsageObservation[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch({
      choices: [{ message: { content: "ok" } }],
      model: "stub-model",
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    try {
      const chat = createOpenAICompatibleChat({
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        baseUrl: "http://127.0.0.1:1/v1",
        providerName: "openai",
        onUsage: (o) => void seen.push(o),
        now: fakeClock(),
      });
      await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("ok");
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      servedModel: "stub-model",
      tokensIn: 50,
      tokensOut: 10,
      latencyMs: 5,
    });
    // Nothing secret rides along on an observation.
    expect(JSON.stringify(seen[0])).not.toContain("sk-test");
  });

  it("reports null — not 0 — when the response omits the usage block", async () => {
    const seen: ChatUsageObservation[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch({ choices: [{ message: { content: "ok" } }] });
    try {
      const chat = createOpenAICompatibleChat({
        apiKey: "k",
        model: "gpt-4o-mini",
        baseUrl: "http://127.0.0.1:1/v1",
        onUsage: (o) => void seen.push(o),
      });
      await chat([{ role: "user", content: "hi" }]);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen[0].tokensIn).toBeNull();
    const report = summarizeCalls([seen[0]]);
    expect(report.usageMissingCalls).toBe(1);
    expect(report.complete).toBe(false);
  });

  it("emits no observation for a failed request", async () => {
    const seen: ChatUsageObservation[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch({ error: "nope" }, false);
    try {
      const chat = createOpenAICompatibleChat({
        apiKey: "k",
        model: "gpt-4o-mini",
        baseUrl: "http://127.0.0.1:1/v1",
        onUsage: (o) => void seen.push(o),
      });
      await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([]);
  });
});

describe("createChat threads the seam through the provider directory", () => {
  it("wires it on the anthropic dialect too, with the same null contract", async () => {
    const seen: ChatUsageObservation[] = [];
    const chat = createChat({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "k",
      fetchImpl: fakeFetch({
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-5",
        usage: { input_tokens: 2000, output_tokens: 1000 },
      }),
      onUsage: (o) => void seen.push(o),
      now: fakeClock(3),
    });
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("ok");

    expect(seen[0]).toMatchObject({ provider: "anthropic", tokensIn: 2000, tokensOut: 1000, latencyMs: 3 });
    // claude-sonnet-5 is priced, so this one really is a measured dollar figure.
    const report = summarizeCalls([seen[0]]);
    expect(report.usd).toBeCloseTo(2000 / 1e6 * 3 + 1000 / 1e6 * 15, 12);
    expect(report.complete).toBe(true);
  });

  it("stays entirely optional — a caller that passes no observer is unaffected", async () => {
    const chat = createChat({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "k",
      fetchImpl: fakeFetch({ content: [{ type: "text", text: "ok" }] }),
    });
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("ok");
  });
});
