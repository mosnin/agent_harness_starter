/**
 * The seam where measurement starts: `HttpModelClient`'s `onCall` observer.
 *
 * Before this seam existed, the client read the provider's `usage` block and
 * threw the provenance away: an absent block became `tokensIn: 0`, which is
 * the exact shape of "this call was free". These tests pin that an
 * observation carries `null` for an unreported count, that the observer sees
 * real latency, and that a failed request produces NO observation at all —
 * inventing a row for a call that never returned would put a fabricated
 * entry in the ledger.
 */
import { describe, expect, it } from "vitest";
import { HttpModelClient, type ModelCallObservation } from "../../models/client";
import { CostMeter } from "../meter";

/** A fetch double returning one canned JSON body. */
function fakeFetch(json: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => json,
      text: async () => JSON.stringify(json),
    }) as unknown as Response) as unknown as typeof fetch;
}

/** A monotonic fake clock: every read advances by `step` ms. */
function fakeClock(step = 7): () => number {
  let t = 1_000;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

function client(json: unknown, seen: ModelCallObservation[], opts: { ok?: boolean; kind?: "openai" | "anthropic" } = {}) {
  return new HttpModelClient(
    {
      name: "openai",
      kind: opts.kind ?? "openai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "sk-test",
      models: ["gpt-4o-mini"],
    },
    { fetchImpl: fakeFetch(json, opts.ok ?? true), onCall: (o) => void seen.push(o), now: fakeClock() },
  );
}

describe("openai dialect", () => {
  it("observes the provider's reported usage and a real latency", async () => {
    const seen: ModelCallObservation[] = [];
    const res = await client(
      { choices: [{ message: { content: "hi" } }], model: "gpt-4o-mini", usage: { prompt_tokens: 50, completion_tokens: 10 } },
      seen,
    ).chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      servedModel: "gpt-4o-mini",
      tokensIn: 50,
      tokensOut: 10,
      latencyMs: 7,
    });
    expect(res.usageReported).toBe(true);
    expect(res.latencyMs).toBe(7);
  });

  it("reports NULL — not 0 — when the response carries no usage block", async () => {
    const seen: ModelCallObservation[] = [];
    const res = await client({ choices: [{ message: { content: "hi" } }] }, seen).chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seen[0].tokensIn).toBeNull();
    expect(seen[0].tokensOut).toBeNull();
    // The legacy numeric contract on ChatResponse is preserved…
    expect(res.tokensIn).toBe(0);
    // …but the flag says that 0 means "not reported", not "none consumed".
    expect(res.usageReported).toBe(false);

    // And the meter refuses to call it a $0 run.
    const report = new CostMeter().record({ ...seen[0] }).report();
    expect(report.usageMissingCalls).toBe(1);
    expect(report.complete).toBe(false);
  });

  it("records the model the provider says it served, without re-pricing on it", async () => {
    const seen: ModelCallObservation[] = [];
    const res = await client(
      { choices: [{ message: { content: "hi" } }], model: "stub-model", usage: { prompt_tokens: 50, completion_tokens: 10 } },
      seen,
    ).chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });

    expect(seen[0].servedModel).toBe("stub-model");
    expect(seen[0].model).toBe("gpt-4o-mini");
    // Priced against the REQUESTED id: a provider must not be able to move
    // the bill by naming a different (or unpriced) model in its response.
    expect(res.usd).toBeCloseTo(0.0000135, 12);
  });

  it("emits NO observation for a failed request", async () => {
    const seen: ModelCallObservation[] = [];
    await expect(
      client({ error: "boom" }, seen, { ok: false }).chat({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("never lets an observer error break the call", async () => {
    const c = new HttpModelClient(
      { name: "openai", kind: "openai", baseUrl: "https://example.invalid/v1", models: ["gpt-4o-mini"] },
      {
        fetchImpl: fakeFetch({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        onCall: () => {
          throw new Error("bookkeeping blew up");
        },
      },
    );
    await expect(c.chat({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      text: "hi",
    });
  });
});

describe("anthropic dialect", () => {
  it("observes input_tokens/output_tokens the same way", async () => {
    const seen: ModelCallObservation[] = [];
    await client(
      { content: [{ type: "text", text: "hi" }], model: "claude-sonnet-5", usage: { input_tokens: 2000, output_tokens: 1000 } },
      seen,
      { kind: "anthropic" },
    ).chat({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });

    expect(seen[0]).toMatchObject({ tokensIn: 2000, tokensOut: 1000, servedModel: "claude-sonnet-5" });
  });

  it("reports NULL when anthropic returns no usage block", async () => {
    const seen: ModelCallObservation[] = [];
    await client({ content: [{ type: "text", text: "hi" }] }, seen, { kind: "anthropic" }).chat({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen[0].tokensIn).toBeNull();
  });
});

describe("backwards compatibility", () => {
  it("works with no observer at all (the pre-existing constructor shape)", async () => {
    const c = new HttpModelClient(
      { name: "openai", kind: "openai", baseUrl: "https://example.invalid/v1", models: ["gpt-4o"] },
      { fetchImpl: fakeFetch({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) },
    );
    const res = await c.chat({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("ok");
    expect(res.tokensIn).toBe(10);
  });
});
