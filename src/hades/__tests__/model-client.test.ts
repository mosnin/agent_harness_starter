import { describe, it, expect } from "vitest";
import {
  computeCost,
  DEFAULT_PRICES,
  HttpModelClient,
  MultiProviderClient,
  type ChatRequest,
  type ChatResponse,
  type ModelClient,
  type PriceEntry,
} from "../models/client";

// --- fake fetch helpers -----------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: any;
}

/** Build a fake fetch that returns canned JSON and records the request. */
function fakeFetch(
  responder: (call: CapturedCall) => {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
  },
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call: CapturedCall = { url: String(url), init, headers, body };
    calls.push(call);
    const r = responder(call);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// --- computeCost ------------------------------------------------------------

describe("computeCost", () => {
  const prices: PriceEntry[] = [
    { model: "m-a", inPerMTok: 10, outPerMTok: 30 },
  ];

  it("is exact for known model / tokens / prices", () => {
    // 1_000_000 in @ $10, 500_000 out @ $30 → 10 + 15 = 25
    expect(computeCost("m-a", 1_000_000, 500_000, prices)).toBeCloseTo(25, 10);
    // small counts
    expect(computeCost("m-a", 1000, 500, prices)).toBeCloseTo(
      1000 / 1e6 * 10 + 500 / 1e6 * 30,
      12,
    );
  });

  it("returns 0 for an unknown model (documented)", () => {
    expect(computeCost("does-not-exist", 5000, 5000, prices)).toBe(0);
  });

  it("uses DEFAULT_PRICES for a known Claude id", () => {
    // claude-sonnet-5: $3 in / $15 out
    expect(
      computeCost("claude-sonnet-5", 2_000_000, 1_000_000, DEFAULT_PRICES),
    ).toBeCloseTo(2 * 3 + 1 * 15, 10);
  });
});

// --- HttpModelClient: openai dialect ---------------------------------------

describe("HttpModelClient openai dialect", () => {
  it("posts chat/completions with bearer auth and parses usage", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      json: {
        choices: [{ message: { content: "hello there" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
    }));
    const client = new HttpModelClient(
      {
        name: "openai",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: ["gpt-4o"],
      },
      { fetchImpl },
    );
    const res: ChatResponse = await client.chat({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 256,
      temperature: 0.4,
    });

    // wire assertions
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers["Authorization"]).toBe("Bearer sk-test");
    expect(calls[0].body.model).toBe("gpt-4o");
    expect(calls[0].body.max_tokens).toBe(256);
    expect(calls[0].body.temperature).toBe(0.4);
    expect(calls[0].body.messages).toHaveLength(2);

    // parsed response + cost (gpt-4o: 2.5/10)
    expect(res.text).toBe("hello there");
    expect(res.tokensIn).toBe(1000);
    expect(res.tokensOut).toBe(500);
    expect(res.provider).toBe("openai");
    expect(res.usd).toBeCloseTo(1000 / 1e6 * 2.5 + 500 / 1e6 * 10, 12);
  });

  it("throws with status + provider on non-2xx", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      ok: false,
      status: 429,
      text: "rate limited",
    }));
    const client = new HttpModelClient(
      {
        name: "openai",
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: ["gpt-4o"],
      },
      { fetchImpl },
    );
    await expect(
      client.chat({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/429/);
    await expect(
      client.chat({ model: "gpt-4o", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/openai/);
  });
});

// --- HttpModelClient: anthropic dialect ------------------------------------

describe("HttpModelClient anthropic dialect", () => {
  it("hoists system, sends x-api-key to /v1/messages, parses input/output tokens", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      json: {
        content: [{ type: "text", text: "claude says hi" }],
        usage: { input_tokens: 2000, output_tokens: 1000 },
      },
    }));
    const client = new HttpModelClient(
      {
        name: "anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "ant-key",
        models: ["claude-sonnet-5"],
      },
      { fetchImpl },
    );
    const res = await client.chat({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "you are terse" },
        { role: "user", content: "hello" },
      ],
      maxTokens: 512,
      temperature: 0.1,
    });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("ant-key");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    // system hoisted; only the user turn stays in messages
    expect(calls[0].body.system).toBe("you are terse");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(calls[0].body.max_tokens).toBe(512);

    expect(res.text).toBe("claude says hi");
    expect(res.tokensIn).toBe(2000);
    expect(res.tokensOut).toBe(1000);
    // claude-sonnet-5: 3/15
    expect(res.usd).toBeCloseTo(2000 / 1e6 * 3 + 1000 / 1e6 * 15, 12);
  });
});

// --- MultiProviderClient: routing & load balancing -------------------------

/** A trivial in-memory client for routing/concurrency tests. */
class StubClient implements ModelClient {
  constructor(
    public provider: string,
    public usd = 0,
    public tin = 1,
    public tout = 1,
  ) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    return {
      text: `${this.provider}:${req.model}`,
      tokensIn: this.tin,
      tokensOut: this.tout,
      usd: this.usd,
      model: req.model,
      provider: this.provider,
    };
  }
}

describe("MultiProviderClient routing", () => {
  it("routes a model to the client that serves it", async () => {
    const a = new StubClient("prov-a");
    const b = new StubClient("prov-b");
    const mc = new MultiProviderClient([
      { client: a, models: ["model-x"] },
      { client: b, models: ["model-y"] },
    ]);
    expect((await mc.chat({ model: "model-x", messages: [] })).provider).toBe(
      "prov-a",
    );
    expect((await mc.chat({ model: "model-y", messages: [] })).provider).toBe(
      "prov-b",
    );
  });

  it("throws when no client serves the model", async () => {
    const mc = new MultiProviderClient([
      { client: new StubClient("prov-a"), models: ["model-x"] },
    ]);
    await expect(
      mc.chat({ model: "unknown", messages: [] }),
    ).rejects.toThrow(/no client serves/);
  });

  it("round-robins across two providers serving the same model", async () => {
    const a = new StubClient("prov-a");
    const b = new StubClient("prov-b");
    const mc = new MultiProviderClient([
      { client: a, models: ["shared"] },
      { client: b, models: ["shared"] },
    ]);
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) {
      seq.push((await mc.chat({ model: "shared", messages: [] })).provider);
    }
    expect(seq).toEqual(["prov-a", "prov-b", "prov-a", "prov-b"]);
  });

  it("honors weight when load-balancing (deterministic)", async () => {
    const a = new StubClient("prov-a");
    const b = new StubClient("prov-b");
    const mc = new MultiProviderClient([
      { client: a, models: ["shared"], weight: 2 },
      { client: b, models: ["shared"], weight: 1 },
    ]);
    const seq: string[] = [];
    for (let i = 0; i < 6; i++) {
      seq.push((await mc.chat({ model: "shared", messages: [] })).provider);
    }
    expect(seq).toEqual([
      "prov-a",
      "prov-a",
      "prov-b",
      "prov-a",
      "prov-a",
      "prov-b",
    ]);
  });
});

// --- MultiProviderClient: concurrency & stats ------------------------------

/** A client whose calls block on a manual gate; tracks its OWN live counter. */
class GatedClient implements ModelClient {
  live = 0;
  maxLive = 0;
  private resolvers: Array<() => void> = [];
  constructor(public provider: string) {}
  chat(req: ChatRequest): Promise<ChatResponse> {
    this.live++;
    if (this.live > this.maxLive) this.maxLive = this.live;
    return new Promise<ChatResponse>((resolve) => {
      this.resolvers.push(() => {
        this.live--;
        resolve({
          text: "ok",
          tokensIn: 1,
          tokensOut: 1,
          usd: 0,
          model: req.model,
          provider: this.provider,
        });
      });
    });
  }
  releaseOne() {
    const fn = this.resolvers.shift();
    if (fn) fn();
  }
  pending() {
    return this.resolvers.length;
  }
}

describe("MultiProviderClient concurrency", () => {
  it("never exceeds maxConcurrency under a burst (independent live counter)", async () => {
    const gated = new GatedClient("g");
    const mc = new MultiProviderClient(
      [{ client: gated, models: ["m"] }],
      { maxConcurrency: 3 },
    );

    // fire a burst of 10 without awaiting
    const burst = Array.from({ length: 10 }, () =>
      mc.chat({ model: "m", messages: [] }),
    );

    await flush();
    // only the cap should be in flight
    expect(gated.live).toBe(3);
    expect(gated.maxLive).toBeLessThanOrEqual(3);

    // drain, checking the invariant at every step
    while (gated.pending() > 0 || gated.live > 0) {
      gated.releaseOne();
      await flush();
      expect(gated.live).toBeLessThanOrEqual(3);
    }

    await Promise.all(burst);
    expect(gated.maxLive).toBe(3);
    expect(mc.stats().maxObservedConcurrency).toBeLessThanOrEqual(3);
    expect(mc.stats().maxObservedConcurrency).toBe(3);
  });

  it("accumulates stats totals equal to the sum, and reset zeroes them", async () => {
    const a = new StubClient("prov-a", 0.01, 10, 5);
    const b = new StubClient("prov-b", 0.02, 20, 7);
    const mc = new MultiProviderClient([
      { client: a, models: ["mx"] },
      { client: b, models: ["my"] },
    ]);

    await mc.chat({ model: "mx", messages: [] });
    await mc.chat({ model: "mx", messages: [] });
    await mc.chat({ model: "my", messages: [] });

    const s = mc.stats();
    expect(s.calls).toBe(3);
    expect(s.byProvider).toEqual({ "prov-a": 2, "prov-b": 1 });
    expect(s.byModel).toEqual({ mx: 2, my: 1 });
    expect(s.totalUsd).toBeCloseTo(0.01 * 2 + 0.02, 12);
    expect(s.totalTokensIn).toBe(10 * 2 + 20);
    expect(s.totalTokensOut).toBe(5 * 2 + 7);

    mc.reset();
    const z = mc.stats();
    expect(z).toEqual({
      calls: 0,
      byProvider: {},
      byModel: {},
      totalUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      maxObservedConcurrency: 0,
    });
  });
});
