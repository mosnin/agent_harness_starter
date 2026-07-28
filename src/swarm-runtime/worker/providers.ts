import { chatTransportError, createOpenAICompatibleChat, type ChatFn, type ChatMessage } from "./llm-executor";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "nous"
  | "openrouter"
  | "together"
  | "groq"
  | "local";

export type ProviderStyle = "openai" | "anthropic";

export interface ProviderConfig {
  baseUrl: string;
  apiKeyEnv?: string;
  style: ProviderStyle;
}

/**
 * Built-in provider directory. Most inference endpoints speak the OpenAI
 * chat-completions dialect, so they share one code path; Anthropic uses its own
 * messages API. Point `local` at Ollama/vLLM (both expose an OpenAI-compatible
 * surface). This is the "bring any model, switch with one setting" layer.
 */
export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", style: "openai" },
  anthropic: { baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", style: "anthropic" },
  nous: { baseUrl: "https://inference-api.nousresearch.com/v1", apiKeyEnv: "NOUS_API_KEY", style: "openai" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", style: "openai" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", style: "openai" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", style: "openai" },
  local: { baseUrl: "http://localhost:11434/v1", apiKeyEnv: undefined, style: "openai" },
};

export interface CreateChatOptions {
  provider: ProviderName;
  model: string;
  /** API key; falls back to the provider's env var. */
  apiKey?: string;
  /** Override the base URL (e.g. a custom vLLM host). */
  baseUrl?: string;
  temperature?: number;
  /** Max tokens (Anthropic requires this; OpenAI-style ignores it here). */
  maxTokens?: number;
  /**
   * Abort the HTTP request after this many ms so a dead endpoint fails fast
   * with a clear error instead of hanging. Unset = no timeout.
   */
  timeoutMs?: number;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a {@link ChatFn} for any supported provider. OpenAI-style providers go
 * through the shared chat-completions client; Anthropic gets a native messages
 * request. Provider-agnostic to the caller — swap `provider` and everything else
 * stays the same.
 */
export function createChat(opts: CreateChatOptions): ChatFn {
  const cfg = PROVIDERS[opts.provider];
  if (!cfg) throw new Error(`unknown provider: ${opts.provider}`);
  const apiKey = opts.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? "";
  const baseUrl = (opts.baseUrl ?? cfg.baseUrl).replace(/\/$/, "");

  if (cfg.style === "anthropic") {
    return anthropicChat({ ...opts, apiKey, baseUrl });
  }
  return createOpenAICompatibleChat({
    apiKey,
    model: opts.model,
    baseUrl,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
  });
}

/** Resolve which env var holds a provider's key (for setup/doctor UX). */
export function providerKeyEnv(provider: ProviderName): string | undefined {
  return PROVIDERS[provider]?.apiKeyEnv;
}

function anthropicChat(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): ChatFn {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (messages: ChatMessage[]) => {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: opts.temperature ?? 0.2,
          ...(system ? { system } : {}),
          messages: turns,
        }),
        ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (e) {
      throw chatTransportError(e, `${opts.baseUrl}/v1/messages`, opts.timeoutMs);
    }
    if (!res.ok) throw new Error(`anthropic messages failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  };
}
