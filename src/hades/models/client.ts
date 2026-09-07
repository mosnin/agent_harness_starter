/**
 * Multi-provider LLM client with real wire formats, accurate cost accounting,
 * and rate-limit-aware fan-out concurrency.
 *
 * This is the inference layer the V-TPH$ benchmark and the real worker brain
 * use. HTTP is real (OpenAI-dialect chat-completions + Anthropic-native
 * messages) but goes through an INJECTABLE `fetch`, so it unit-tests without
 * keys. Swap in `globalThis.fetch` + a real API key and the same code hits the
 * live endpoints.
 */

// ---------------------------------------------------------------------------
// Public message / request / response contracts
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Validated image data URLs for multimodal providers. */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Receives provider text deltas when streaming is supported. */
  onText?: (chunk: string) => void;
}

export interface ChatResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  model: string;
  provider: string;
  /** False when token usage or model pricing was unavailable. */
  costMeasured?: boolean;
}

export interface ModelClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  close?(): void;
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
 */
export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  prices: PriceEntry[],
): number {
  const entry = prices.find((p) => p.model === model);
  if (!entry) return 0; // unknown model → 0 cost (documented)
  return (
    (tokensIn / 1e6) * entry.inPerMTok + (tokensOut / 1e6) * entry.outPerMTok
  );
}

/**
 * Sensible published list prices (USD per 1e6 tokens) for a handful of Claude
 * and OpenAI-dialect models. Sources are the vendors' standard (non-batch,
 * non-cached) list pricing:
 *   - Claude Opus tier:   $15 in / $75 out
 *   - Claude Sonnet tier: $3 in  / $15 out
 *   - Claude Haiku 4.5:   $1 in  / $5 out
 *   - Claude Fable 5:     creative tier, priced at the Haiku point ($1 / $5)
 *   - OpenAI gpt-4o:      $2.50 in / $10 out
 *   - OpenAI gpt-4o-mini: $0.15 in / $0.60 out
 *   - OpenAI gpt-4.1:     $2 in / $8 out
 *   - OpenAI gpt-4.1-mini:$0.40 in / $1.60 out
 * These are defaults only; a deployment can inject its own PriceEntry[].
 */
export const DEFAULT_PRICES: PriceEntry[] = [
  // Anthropic / Claude (ids match src/hades/models/defaults.ts)
  { model: "claude-opus-4-1", inPerMTok: 15, outPerMTok: 75 },
  { model: "claude-sonnet-5", inPerMTok: 3, outPerMTok: 15 },
  { model: "claude-haiku-4-5-20251001", inPerMTok: 1, outPerMTok: 5 },
  { model: "claude-fable-5", inPerMTok: 1, outPerMTok: 5 },
  // OpenAI-dialect
  { model: "gpt-4o", inPerMTok: 2.5, outPerMTok: 10 },
  { model: "gpt-4o-mini", inPerMTok: 0.15, outPerMTok: 0.6 },
  { model: "gpt-4.1", inPerMTok: 2, outPerMTok: 8 },
  { model: "gpt-4.1-mini", inPerMTok: 0.4, outPerMTok: 1.6 },
];

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class HttpModelClient implements ModelClient {
  private readonly provider: ProviderConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly prices: PriceEntry[];

  constructor(
    provider: ProviderConfig,
    opts?: { fetchImpl?: typeof fetch; prices?: PriceEntry[] },
  ) {
    this.provider = provider;
    // Bind to preserve the correct `this` for a real global fetch.
    const impl = opts?.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = opts?.fetchImpl ?? (impl ? impl.bind(globalThis) : impl);
    this.prices = opts?.prices ?? DEFAULT_PRICES;
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
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [
              { type: "text", text: m.content },
              ...m.images.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ]
          : m.content,
      })),
    };
    if (req.onText) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.provider.apiKey) {
      headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
    }

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal
        ? AbortSignal.any([req.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await this.safeText(res);
      throw new Error(
        `[${this.provider.name}] openai chat/completions failed: ${res.status} ${detail}`,
      );
    }
    if (res.headers?.get?.("content-type")?.includes("text/event-stream"))
      return this.readStream(res, req);
    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices?.[0]?.message?.content ?? "";
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    return this.finalize(
      req.model,
      text,
      tokensIn,
      tokensOut,
      data.usage !== undefined,
      data.usage?.cost,
    );
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
        content: m.images?.length
          ? [
              { type: "text", text: m.content },
              ...m.images.map((url) => {
                const match =
                  /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url);
                if (!match) throw new Error("Invalid image attachment");
                return {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: match[1],
                    data: match[2],
                  },
                };
              }),
            ]
          : m.content,
      }));

    const body: Record<string, unknown> = {
      model: req.model,
      // Anthropic requires max_tokens; default to a safe non-zero value.
      max_tokens: req.maxTokens ?? 1024,
      messages: turns,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (system) body.system = system;
    if (req.onText) body.stream = true;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.provider.apiKey) headers["x-api-key"] = this.provider.apiKey;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal
        ? AbortSignal.any([req.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await this.safeText(res);
      throw new Error(
        `[${this.provider.name}] anthropic messages failed: ${res.status} ${detail}`,
      );
    }
    if (res.headers?.get?.("content-type")?.includes("text/event-stream"))
      return this.readStream(res, req);
    const data = (await res.json()) as AnthropicMessagesResponse;
    const text = (data.content ?? [])
      .filter((b) => (b.type ?? "text") === "text")
      .map((b) => b.text ?? "")
      .join("");
    const tokensIn = data.usage?.input_tokens ?? 0;
    const tokensOut = data.usage?.output_tokens ?? 0;
    return this.finalize(
      req.model,
      text,
      tokensIn,
      tokensOut,
      data.usage !== undefined,
    );
  }

  private async readStream(
    res: Response,
    req: ChatRequest,
  ): Promise<ChatResponse> {
    if (!res.body) throw new Error("Provider returned no stream");
    const reader = res.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      output = "",
      tokensIn = 0,
      tokensOut = 0,
      hasUsage = false,
      reportedCost: number | undefined,
      complete = false;
    let data: string[] = [];
    const consume = () => {
      const raw = data.join("\n").trim();
      data = [];
      if (!raw) return;
      if (raw === "[DONE]") {
        complete = true;
        return;
      }
      const event = JSON.parse(raw);
      if (event.error)
        throw new Error(event.error.message ?? "Provider stream error");
      if (
        event.type === "message_stop" ||
        event.choices?.some((c: { finish_reason?: string }) => c.finish_reason)
      )
        complete = true;
      const delta =
        event.choices?.[0]?.delta?.content ??
        (event.type === "content_block_delta" ? event.delta?.text : "");
      if (typeof delta === "string" && delta) {
        if (output.length + delta.length > 4_000_000)
          throw new Error("Provider stream exceeded size limit");
        output += delta;
        req.onText?.(delta);
      }
      const usage = event.usage ?? event.message?.usage;
      if (usage) {
        hasUsage = true;
        reportedCost = usage.cost ?? reportedCost;
        tokensIn = usage.prompt_tokens ?? usage.input_tokens ?? tokensIn;
        tokensOut = usage.completion_tokens ?? usage.output_tokens ?? tokensOut;
      }
    };
    const line = (value: string) => {
      if (!value) consume();
      else if (value.startsWith("data:")) data.push(value.slice(5).trimStart());
    };
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    req.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        req.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        req.signal?.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length + data.join("").length > 2_000_000)
          throw new Error("Provider stream exceeded size limit");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, index).replace(/\r$/, ""));
          buffer = buffer.slice(index + 1);
        }
        if (done) {
          if (buffer.trim()) line(buffer);
          consume();
          break;
        }
      }
      if (!complete)
        throw new Error(
          "Provider stream ended before completion. Please retry.",
        );
    } finally {
      req.signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return this.finalize(req.model, output, tokensIn, tokensOut, hasUsage, reportedCost);
  }

  private finalize(
    model: string,
    text: string,
    tokensIn: number,
    tokensOut: number,
    hasUsage: boolean,
    reportedCost?: number,
  ): ChatResponse {
    const providerCost = this.provider.name === "openrouter" && typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0;
    return {
      text,
      tokensIn,
      tokensOut,
      usd: providerCost ? reportedCost! : computeCost(model, tokensIn, tokensOut, this.prices),
      model,
      provider: this.provider.name,
      costMeasured: providerCost || (hasUsage && this.prices.some((p) => p.model === model)),
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

// ---------------------------------------------------------------------------
// MultiProviderClient — routing, load balancing, bounded concurrency, stats
// ---------------------------------------------------------------------------

export interface MultiProviderStats {
  calls: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  totalUsd: number;
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
    s.totalUsd += res.usd;
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
