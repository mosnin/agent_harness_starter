/**
 * Multi-provider LLM client with real wire formats, accurate cost accounting,
 * and rate-limit-aware fan-out concurrency.
 *
 * This is the inference layer the V-TPH$ benchmark and the real worker brain
 * use. HTTP is real (OpenAI-dialect chat-completions + Anthropic-native
 * messages) but goes through an INJECTABLE `fetch`, so it unit-tests without
 * keys. Swap in `globalThis.fetch` + a real API key and the same code hits the
 * live endpoints.
 *
 * Cost accounting here is REAL: token counts come off the provider's own
 * `usage` block, never from an estimator. The one thing the wire cannot tell
 * us is what a provider charges, so prices come from the single cited table
 * in `../cost/prices.ts` — and a model that table does not know is reported
 * UNKNOWN by `../cost/meter.ts` rather than billed at $0.
 */

import { toPriceEntries } from "../cost/prices";

// ---------------------------------------------------------------------------
// Public message / request / response contracts
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /**
   * Measured spend for this call, or `null` when the model carries NO price
   * entry. `null` is deliberately not `0`: every metric in `../bench/vtph.ts`
   * divides by spend, so an unpriced call reported as free silently flatters
   * the headline. A consumer must decide what to do with "unknown" rather
   * than have that decision made for it by a zero it cannot detect.
   */
  usd: number | null;
  model: string;
  provider: string;
  /**
   * Did the provider's response actually carry a `usage` block?
   *
   * When `false`, `tokensIn`/`tokensOut` are `0` because NOTHING WAS
   * REPORTED — not because nothing was consumed. The two are
   * indistinguishable in the numbers alone, which is why this flag exists:
   * `../cost/meter.ts` turns `usageReported: false` into `tokensIn: null` so
   * an unreported call is excluded from a total instead of dragging it down
   * toward a flattering zero.
   *
   * Optional so every pre-existing hand-built `ChatResponse` still compiles;
   * a consumer that cares must treat `undefined` as "unknown", not "true".
   */
  usageReported?: boolean;
  /**
   * The model id the provider REPORTED serving, when the response named one.
   * `usd` is priced against the REQUESTED id (`model`) regardless — silently
   * re-pricing on a response field would let a provider move the bill — so a
   * mismatch between the two is surfaced as a caveat by the cost surfaces.
   */
  servedModel?: string;
  /** Measured wall clock for this round trip, in ms (injected clock). */
  latencyMs?: number;
}

export interface ModelClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

/** Published price for a model, in USD per 1e6 (one million) tokens. */
export interface PriceEntry {
  model: string;
  inPerMTok: number;
  outPerMTok: number;
}

/**
 * Cost in USD for a single call:
 *
 *   tokensIn / 1e6 * inPerMTok + tokensOut / 1e6 * outPerMTok
 *
 * Looked up by EXACT model id. An unknown model yields 0 (so accounting never
 * throws mid-run); the caller is free to warn when a live model is missing a
 * price. Pure — no I/O, no mutation.
 *
 * ⚠ That documented `0` is a LIE-SHAPED value: it is indistinguishable from a
 * genuinely free call, and every metric in `../bench/vtph.ts` divides by
 * spend, so a `0` that should have been "unknown" inflates the headline. Two
 * consumers already guard it (`../routing/arms.ts` marks such an arm
 * `unpriced`), and NEW code should call `../cost/prices.ts`'s
 * {@link import("../cost/prices").priceCall} instead: it returns
 * `{ priced: false, usd: null }`, which cannot be summed into a total by
 * accident. This function stays as-is only because existing callers depend on
 * its non-throwing numeric contract.
 */
/**
 * {@link computeCost}'s honest sibling: returns `null` — never a lie-shaped
 * `0` — when the model has no price entry. New code should prefer this;
 * `computeCost` survives only because existing callers depend on its
 * non-throwing numeric contract.
 */
export function priceOrNull(
  model: string,
  tokensIn: number,
  tokensOut: number,
  prices: PriceEntry[],
): number | null {
  const entry = prices.find((p) => p.model === model);
  if (!entry) return null;
  return (tokensIn / 1e6) * entry.inPerMTok + (tokensOut / 1e6) * entry.outPerMTok;
}

export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  prices: PriceEntry[],
): number {
  const entry = prices.find((p) => p.model === model);
  if (!entry) return 0; // unknown model → 0 cost (documented; see the warning above)
  return (
    (tokensIn / 1e6) * entry.inPerMTok + (tokensOut / 1e6) * entry.outPerMTok
  );
}

/**
 * Published list prices (USD per 1e6 tokens) for the models this build knows.
 *
 * This is a *view* of the single price table in `../cost/prices.ts` — the
 * numbers are NOT duplicated here. That table carries, per entry, the vendor
 * page each figure was transcribed from and the date the line was last edited
 * in this repo, and it is what `hades cost prices` prints. Keeping one table
 * is the point: two lists of dollar figures drift, and a drifted price is a
 * fabricated number wearing a citation.
 *
 * These remain defaults only; a deployment can inject its own `PriceEntry[]`,
 * or point `HADES_PRICES_FILE` at its own table (see `../cost/prices.ts`).
 */
export const DEFAULT_PRICES: PriceEntry[] = toPriceEntries();

// ---------------------------------------------------------------------------
// HttpModelClient — a single provider endpoint
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  /** Logical provider name, surfaced on ChatResponse.provider and in stats. */
  name: string; // "anthropic" | "openai" | "openrouter" | "local" | ...
  /** Wire dialect. */
  kind: "openai" | "anthropic";
  /**
   * Base URL. For "openai" it MUST already include the version path segment
   * when the provider needs one (e.g. https://api.openai.com/v1); the request
   * goes to `${baseUrl}/chat/completions`. For "anthropic" pass the host root
   * (e.g. https://api.anthropic.com); the request goes to `${baseUrl}/v1/messages`.
   */
  baseUrl: string;
  apiKey?: string;
  /** Model ids this provider serves. */
  models: string[];
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * What the client observed on ONE round trip, handed to
 * {@link HttpModelClientOptions.onCall} the moment the response is parsed.
 *
 * This is the seam that makes measured cost possible without threading a
 * meter through every call site: whatever built the client (the chat brain,
 * a bench harness, a worker) subscribes once and receives every real call.
 * `tokensIn`/`tokensOut` are `null` — not 0 — when the provider returned no
 * usage block, so a downstream total can exclude the call instead of
 * understating itself. Nothing here contains a key or a credentialed URL, so
 * an observation is always safe to log.
 */
export interface ModelCallObservation {
  provider: string;
  /** Model REQUESTED (what pricing keys on). */
  model: string;
  /** Model the provider REPORTED serving, when it named one. */
  servedModel?: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Measured round-trip wall clock in ms, from the injected clock. */
  latencyMs: number;
  /** Epoch ms at completion, from the injected clock. */
  at: number;
}

export interface HttpModelClientOptions {
  fetchImpl?: typeof fetch;
  prices?: PriceEntry[];
  /**
   * Called once per SUCCESSFUL round trip with what was really observed.
   * Never called for a failed request — a call that produced no response
   * consumed no reported tokens, and inventing an observation for it would
   * put a fabricated row in the cost ledger. Exceptions thrown by the
   * observer are swallowed: bookkeeping must not fail an agent's work.
   */
  onCall?: (obs: ModelCallObservation) => void;
  /** Clock for latency/timestamps. Injectable so tests are deterministic. */
  now?: () => number;
}

export class HttpModelClient implements ModelClient {
  private readonly provider: ProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly prices: PriceEntry[];
  private readonly onCall?: (obs: ModelCallObservation) => void;
  private readonly now: () => number;

  constructor(provider: ProviderConfig, opts?: HttpModelClientOptions) {
    this.provider = provider;
    // Bind to preserve the correct `this` for a real global fetch.
    const impl = opts?.fetchImpl ?? globalThis.fetch;
    this.fetchImpl =
      opts?.fetchImpl ?? (impl ? impl.bind(globalThis) : impl);
    this.prices = opts?.prices ?? DEFAULT_PRICES;
    if (opts?.onCall) this.onCall = opts.onCall;
    this.now = opts?.now ?? Date.now;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.provider.kind === "anthropic"
      ? this.chatAnthropic(req)
      : this.chatOpenAI(req);
  }

  private stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, "");
  }

  private async chatOpenAI(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.stripTrailingSlash(this.provider.baseUrl)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.provider.apiKey) {
      headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
    }

    const startedAt = this.now();
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await this.safeText(res);
      throw new Error(
        `[${this.provider.name}] openai chat/completions failed: ${res.status} ${detail}`,
      );
    }
    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    // Usage counts as REPORTED only when both fields are really numbers. A
    // response with no usage block (or half of one) yields `null`, which the
    // cost layer excludes — as opposed to `?? 0`, which would have silently
    // recorded a real call as having consumed nothing.
    const tokensIn = numberOrNull(data.usage?.prompt_tokens);
    const tokensOut = numberOrNull(data.usage?.completion_tokens);
    return this.finalize(req.model, text, tokensIn, tokensOut, startedAt, data.model);
  }

  private async chatAnthropic(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.stripTrailingSlash(this.provider.baseUrl)}/v1/messages`;

    // Hoist system messages to the top-level `system` field; the rest become
    // user/assistant turns (tool → user for wire compatibility here).
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: req.model,
      // Anthropic requires max_tokens; default to a safe non-zero value.
      max_tokens: req.maxTokens ?? 1024,
      messages: turns,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (system) body.system = system;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.provider.apiKey) headers["x-api-key"] = this.provider.apiKey;

    const startedAt = this.now();
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await this.safeText(res);
      throw new Error(
        `[${this.provider.name}] anthropic messages failed: ${res.status} ${detail}`,
      );
    }
    const data = (await res.json()) as AnthropicMessagesResponse;
    const text = (data.content ?? [])
      .filter((b) => (b.type ?? "text") === "text")
      .map((b) => b.text ?? "")
      .join("");
    const tokensIn = numberOrNull(data.usage?.input_tokens);
    const tokensOut = numberOrNull(data.usage?.output_tokens);
    return this.finalize(req.model, text, tokensIn, tokensOut, startedAt, data.model);
  }

  /**
   * Build the response and emit the cost observation.
   *
   * `tokensIn`/`tokensOut` arrive as `number | null`. The public
   * {@link ChatResponse} keeps its long-standing numeric contract (unreported
   * → `0`, as before), but `usageReported` records which of the two it was,
   * and the {@link ModelCallObservation} handed to `onCall` carries the
   * honest `null` — so nothing that measures spend has to guess.
   */
  private finalize(
    model: string,
    text: string,
    tokensIn: number | null,
    tokensOut: number | null,
    startedAt: number,
    servedModel?: string,
  ): ChatResponse {
    const at = this.now();
    const latencyMs = Math.max(0, at - startedAt);
    const usageReported = tokensIn !== null && tokensOut !== null;
    const inTok = tokensIn ?? 0;
    const outTok = tokensOut ?? 0;

    if (this.onCall) {
      try {
        this.onCall({
          provider: this.provider.name,
          model,
          ...(servedModel ? { servedModel } : {}),
          tokensIn,
          tokensOut,
          latencyMs,
          at,
        });
      } catch {
        // Bookkeeping must never fail the agent's actual work.
      }
    }

    return {
      text,
      tokensIn: inTok,
      tokensOut: outTok,
      // Uses the nullable path deliberately: computeCost() returns a
      // lie-shaped 0 for an unpriced model (see its JSDoc). This is the
      // production meter, so it must be able to say "unknown".
      usd: priceOrNull(model, inTok, outTok, this.prices),
      model,
      provider: this.provider.name,
      usageReported,
      ...(servedModel ? { servedModel } : {}),
      latencyMs,
    };
  }

  private async safeText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
}

/**
 * A provider-reported token count, or `null` when the field was absent or
 * not a finite number. The `null` is load-bearing: it is what keeps an
 * unreported call out of a spend total instead of coercing it to `0`.
 */
function numberOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// MultiProviderClient — routing, load balancing, bounded concurrency, stats
// ---------------------------------------------------------------------------

export interface MultiProviderStats {
  calls: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  /** Money actually measured. EXCLUDES unpriced calls — see `unpricedCalls`. */
  totalUsd: number;
  /**
   * Calls whose model had no price entry. `totalUsd` is therefore a LOWER
   * BOUND whenever this is non-zero, and any surface reporting spend must say
   * so rather than presenting the total as complete.
   */
  unpricedCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  maxObservedConcurrency: number;
}

interface Registered {
  client: ModelClient;
  models: string[];
  weight: number;
}

/**
 * A fair round-robin (weight-expanded) semaphore over one model's serving
 * clients. Deterministic: no Math.random, index advances by call order.
 */
class ModelRing {
  private readonly slots: ModelClient[] = [];
  private cursor = 0;

  add(client: ModelClient, weight: number): void {
    const w = Math.max(1, Math.floor(weight));
    for (let i = 0; i < w; i++) this.slots.push(client);
  }

  next(): ModelClient {
    const client = this.slots[this.cursor % this.slots.length];
    this.cursor = (this.cursor + 1) % this.slots.length;
    return client;
  }

  get size(): number {
    return this.slots.length;
  }
}

export class MultiProviderClient implements ModelClient {
  private readonly rings = new Map<string, ModelRing>();
  private readonly maxConcurrency: number;

  // Live concurrency accounting.
  private inFlight = 0;
  private observedMax = 0;
  private readonly waiters: Array<() => void> = [];

  private statsData: MultiProviderStats = MultiProviderClient.emptyStats();

  constructor(
    clients: Array<{ client: ModelClient; models: string[]; weight?: number }>,
    opts?: { maxConcurrency?: number },
  ) {
    const cap = opts?.maxConcurrency ?? Infinity;
    this.maxConcurrency = cap > 0 ? cap : Infinity;

    for (const reg of clients) {
      const entry: Registered = {
        client: reg.client,
        models: reg.models,
        weight: reg.weight ?? 1,
      };
      for (const model of reg.models) {
        let ring = this.rings.get(model);
        if (!ring) {
          ring = new ModelRing();
          this.rings.set(model, ring);
        }
        ring.add(entry.client, entry.weight);
      }
    }
  }

  private static emptyStats(): MultiProviderStats {
    return {
      calls: 0,
      byProvider: {},
      byModel: {},
      totalUsd: 0,
      unpricedCalls: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      maxObservedConcurrency: 0,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const ring = this.rings.get(req.model);
    if (!ring || ring.size === 0) {
      throw new Error(`no client serves model: ${req.model}`);
    }
    const client = ring.next();

    await this.acquire();
    try {
      const res = await client.chat(req);
      this.record(res);
      return res;
    } finally {
      this.release();
    }
  }

  // --- semaphore -----------------------------------------------------------

  private async acquire(): Promise<void> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
    if (this.inFlight > this.observedMax) this.observedMax = this.inFlight;
    if (this.observedMax > this.statsData.maxObservedConcurrency) {
      this.statsData.maxObservedConcurrency = this.observedMax;
    }
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  // --- stats ---------------------------------------------------------------

  private record(res: ChatResponse): void {
    const s = this.statsData;
    s.calls++;
    s.byProvider[res.provider] = (s.byProvider[res.provider] ?? 0) + 1;
    s.byModel[res.model] = (s.byModel[res.model] ?? 0) + 1;
    // An unpriced call contributes nothing to the money total — but it is
    // COUNTED, so a reader can tell "cheap" from "unmeasured". Adding a
    // silent 0 here is what made every spend-derived metric flattering.
    if (res.usd === null) s.unpricedCalls++;
    else s.totalUsd += res.usd;
    s.totalTokensIn += res.tokensIn;
    s.totalTokensOut += res.tokensOut;
  }

  stats(): MultiProviderStats {
    // Return a defensive copy so callers can't mutate internal accounting.
    return {
      calls: this.statsData.calls,
      byProvider: { ...this.statsData.byProvider },
      byModel: { ...this.statsData.byModel },
      totalUsd: this.statsData.totalUsd,
      unpricedCalls: this.statsData.unpricedCalls,
      totalTokensIn: this.statsData.totalTokensIn,
      totalTokensOut: this.statsData.totalTokensOut,
      maxObservedConcurrency: this.statsData.maxObservedConcurrency,
    };
  }

  reset(): void {
    this.statsData = MultiProviderClient.emptyStats();
    this.observedMax = 0;
  }
}
