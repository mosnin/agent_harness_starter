/**
 * Chat-brain resolution for `hades chat` — decides, *honestly*, whether the
 * REPL's {@link ConversationBrain} seam gets a real provider-backed model or
 * the self-announcing `[mock]` echo brain, and says WHY in a form that is
 * always safe to print.
 *
 * This module deliberately mirrors the decision-table / honesty pattern of
 * `../gateway/engine-select.ts` and `../../swarm-runtime/run-engine.ts`:
 *
 * - **Pure resolution**: environment is a parameter, nothing hits the network
 *   at resolve time, so the full decision table is unit-testable and the
 *   engine line can be printed before any request is made.
 * - **Names, never values**: every string this module produces for display
 *   ({@link describeChatEngine} / {@link formatChatEngineLine}, the mock
 *   notice) carries environment-variable NAMES and model/provider words only
 *   — never a key value — so it is always safe to log.
 * - **The mock never pretends to think**: with no provider key the brain is
 *   an echo that announces itself with a `[mock]` label on every reply and
 *   tells the user exactly which variables were checked and how to get real
 *   inference. There is no code path that fabricates a model answer.
 *
 * Decision table (anthropic first, mirroring `engine-select.ts`'s
 * `detectKey` and `run-engine.ts`'s auto-select order):
 *
 * | env                          | result |
 * |---|---|
 * | `ANTHROPIC_API_KEY` set      | real `anthropic`, model `HADES_CHAT_MODEL` ?? `claude-sonnet-5`, base `ANTHROPIC_BASE_URL` ?? `https://api.anthropic.com/v1` |
 * | else `OPENAI_API_KEY` set    | real `openai`, model `HADES_CHAT_MODEL` ?? `gpt-4o-mini`, base `OPENAI_BASE_URL` ?? `https://api.openai.com/v1` |
 * | neither                      | `[mock]` echo brain |
 *
 * Both real paths speak the OpenAI chat-completions dialect through the
 * existing {@link HttpModelClient} (`../models/client.ts`, `kind: "openai"`).
 * That is the same approach `engine-select.ts` documents for its Anthropic
 * branch: Anthropic's native wire dialect is `/v1/messages`, but Anthropic
 * also serves a real OpenAI-SDK compatibility endpoint at exactly
 * `https://api.anthropic.com/v1` (https://docs.anthropic.com/en/api/openai-sdk),
 * which accepts the key as a `Authorization: Bearer` header the way any
 * OpenAI-compatible endpoint does — so one wire path serves both providers,
 * and `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` can point either at a proxy or
 * a local OpenAI-compatible server.
 *
 * @module hades/chat/brain
 */

import { HttpModelClient, type ChatMessage, type ModelCallObservation } from "../models/client";
import type { ConversationBrain, ConversationTurnContext } from "../repl/agent";

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/** Providers `hades chat` can auto-select. Keyed strictly by real env keys. */
export type ChatProvider = "anthropic" | "openai";

/** The env var NAMES the resolver checks, in priority order (anthropic first). */
export const CHAT_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** Per-provider default models — the same two defaults `engine-select.ts`'s
 *  `detectKey` and `run-engine.ts`'s `DEFAULT_MODELS` use. */
export const CHAT_DEFAULT_MODELS: Record<ChatProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
};

/** Per-provider default OpenAI-compatible base URLs (see module docs for why
 *  the Anthropic entry is the OpenAI-compat endpoint, not `/v1/messages`). */
export const CHAT_DEFAULT_BASE_URLS: Record<ChatProvider, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

/**
 * Minimal chat transport: OpenAI-dialect messages in, final assistant text
 * out. Model/key/endpoint are baked in by the resolver. Injectable so unit
 * tests exercise the real brain without HTTP (same seam shape as
 * `swarm-runtime/worker/llm-executor.ts`'s `ChatFn`).
 */
export type ChatTransport = (messages: ChatMessage[]) => Promise<string>;

export interface ResolveChatBrainDeps {
  /** Injected transport — bypasses the real {@link HttpModelClient}. Tests only. */
  chat?: ChatTransport;
  /** Injected fetch for the real {@link HttpModelClient}. Tests only. */
  fetchImpl?: typeof fetch;
  /**
   * Cost-measurement seam: called once per REAL provider round trip with the
   * tokens the provider itself reported and the measured latency (see
   * `../models/client.ts`'s {@link ModelCallObservation}). `hades chat` feeds
   * this straight into a `CostMeter`, which is how a chat turn can report
   * what it actually cost.
   *
   * It is deliberately only wired on the REAL path: the `[mock]` brain makes
   * no provider call, so it emits no observation and therefore contributes
   * nothing to any spend total. A mock run costing "$0.00" and a real run
   * costing $0.00 would otherwise be indistinguishable in the ledger.
   */
  onCall?: (obs: ModelCallObservation) => void;
  /** Clock for call latency/timestamps. Injectable so tests are deterministic. */
  now?: () => number;
}

/**
 * What {@link resolveChatBrain} decided. `keyVar` is the exact env variable
 * NAME that supplied the key — never the value — so the whole object is safe
 * to render into the startup engine line.
 */
export type ResolvedChatBrain =
  | {
      kind: "real";
      provider: ChatProvider;
      model: string;
      keyVar: (typeof CHAT_KEY_VARS)[number];
      /** Effective OpenAI-compatible base URL (default or env override). */
      baseUrl: string;
      brain: ConversationBrain;
    }
  | { kind: "mock"; brain: ConversationBrain };

// ---------------------------------------------------------------------------
// The mock brain — honest, self-announcing echo
// ---------------------------------------------------------------------------

/**
 * The first line of every mock reply. Names the exact variables that were
 * checked (names only) and how to get real inference — never pretends the
 * echo is a model thinking.
 */
export const MOCK_CHAT_NOTICE =
  "[mock] no provider key detected (checked ANTHROPIC_API_KEY, OPENAI_API_KEY) — " +
  "echoing your input. Export a key for real inference.";

/**
 * Build the `[mock]` echo brain: streams the self-announcing notice plus the
 * user's own input, verbatim. Memories/profile/history are received (the REPL
 * hands them over identically in both modes) but deliberately not woven into
 * fake prose — an echo that dressed retrieved memories up as reasoning would
 * be the exact dishonesty this label exists to prevent.
 */
export function mockChatBrain(): ConversationBrain {
  return async (ctx, stream, signal) => {
    if (signal.aborted) return "";
    const reply = `${MOCK_CHAT_NOTICE}\n${ctx.input}`;
    stream(reply);
    return reply;
  };
}

// ---------------------------------------------------------------------------
// Prompt composition — the REPL contract, verbatim
// ---------------------------------------------------------------------------

/** Identity + honesty preamble for the real brain's system message. */
const CHAT_SYSTEM_PROMPT =
  "You are Hades, a terminal-native personal agent with long-term memory. " +
  "Answer the user directly and concisely. Use the CONTEXT, USER MODEL, " +
  "RELEVANT MEMORIES and conversation history below when they are relevant; " +
  "never invent memories or user facts that are not listed there.";

/**
 * Compose one turn's OpenAI-dialect message list from exactly what
 * `repl/agent.ts` hands the brain (`{input, memories, userProfile, history,
 * contextPrompt}`):
 *
 * - one system message: identity, then the injection-fenced MEMORY.md/USER.md
 *   `contextPrompt` (already fenced by `memory/context-files.ts` — not
 *   re-wrapped here), then the user-model prose, then the retrieved memories
 *   best-first — each section present only when the REPL supplied it;
 * - the recent session `history` as real user/assistant turns, in order
 *   (`system`-role session entries are dropped rather than letting stored
 *   text smuggle in a second system prompt);
 * - the current `input` as the final user turn. `history` never contains the
 *   current input — the REPL captures history before appending it.
 *
 * Pure and exported so tests can pin the contract without a transport.
 */
export function composeChatMessages(ctx: ConversationTurnContext): ChatMessage[] {
  const systemParts: string[] = [CHAT_SYSTEM_PROMPT];
  if (ctx.contextPrompt) systemParts.push(ctx.contextPrompt);
  if (ctx.userProfile) systemParts.push(`USER MODEL (evidence-backed beliefs about the user):\n${ctx.userProfile}`);
  if (ctx.memories.length > 0) {
    const lines = ctx.memories.map((m) => `- ${m.fact}`).join("\n");
    systemParts.push(`RELEVANT MEMORIES (best first):\n${lines}`);
  }

  const history: ChatMessage[] = ctx.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  return [
    { role: "system", content: systemParts.join("\n\n") },
    ...history,
    { role: "user", content: ctx.input },
  ];
}

// ---------------------------------------------------------------------------
// The real brain
// ---------------------------------------------------------------------------

/**
 * Reply-length cap forwarded as `max_tokens`. Matches `models/client.ts`'s
 * Anthropic-path default; sent explicitly on the OpenAI dialect too so both
 * providers behave identically.
 */
const CHAT_MAX_TOKENS = 1024;

/**
 * Wrap a {@link ChatTransport} as a {@link ConversationBrain}. The transport
 * is a single non-streaming HTTP round-trip ({@link HttpModelClient} has no
 * SSE support), so — per the REPL contract "stream deltas when the transport
 * supports it, else deliver the final text once" — the final text is
 * delivered through `stream` exactly once, then returned. An abort observed
 * before or after the round-trip yields `""` (the REPL treats an empty reply
 * as "nothing to persist"); mid-flight HTTP cancellation is NOT implemented
 * (the transport seam takes no signal), which this comment states rather
 * than hides.
 */
export function transportChatBrain(transport: ChatTransport): ConversationBrain {
  return async (ctx, stream, signal) => {
    if (signal.aborted) return "";
    const text = await transport(composeChatMessages(ctx));
    if (signal.aborted) return "";
    if (text) stream(text);
    return text;
  };
}

// ---------------------------------------------------------------------------
// resolveChatBrain
// ---------------------------------------------------------------------------

/**
 * Resolve the chat brain from environment, per the module-level decision
 * table. Resolution is pure (no network, nothing constructed but the client
 * object); the first request happens on the first turn.
 *
 * Env honored: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (key detection,
 * anthropic first), `HADES_CHAT_MODEL` (model override for whichever
 * provider won), `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` (endpoint override
 * for the winning provider — each applies only to its own provider).
 */
export function resolveChatBrain(
  env: Record<string, string | undefined>,
  deps?: ResolveChatBrainDeps,
): ResolvedChatBrain {
  const detected = detectChatKey(env);
  if (!detected) return { kind: "mock", brain: mockChatBrain() };

  const { provider, keyVar, apiKey } = detected;
  const model = env.HADES_CHAT_MODEL ?? CHAT_DEFAULT_MODELS[provider];
  const baseUrlOverride = provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  const baseUrl = baseUrlOverride ?? CHAT_DEFAULT_BASE_URLS[provider];

  const transport =
    deps?.chat ??
    httpChatTransport({
      provider,
      model,
      baseUrl,
      apiKey,
      ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps?.onCall ? { onCall: deps.onCall } : {}),
      ...(deps?.now ? { now: deps.now } : {}),
    });

  return { kind: "real", provider, model, keyVar, baseUrl, brain: transportChatBrain(transport) };
}

interface DetectedChatKey {
  provider: ChatProvider;
  /** The env variable NAME that supplied the key — never the value. */
  keyVar: (typeof CHAT_KEY_VARS)[number];
  apiKey: string;
}

/** Anthropic first, then OpenAI — the same order as `engine-select.ts`. */
function detectChatKey(env: Record<string, string | undefined>): DetectedChatKey | undefined {
  if (env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", keyVar: "ANTHROPIC_API_KEY", apiKey: env.ANTHROPIC_API_KEY };
  }
  if (env.OPENAI_API_KEY) {
    return { provider: "openai", keyVar: "OPENAI_API_KEY", apiKey: env.OPENAI_API_KEY };
  }
  return undefined;
}

/** The real transport: one {@link HttpModelClient} (OpenAI dialect —
 *  `POST <baseUrl>/chat/completions`, `Authorization: Bearer`) with the
 *  resolved model baked in. */
function httpChatTransport(opts: {
  provider: ChatProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  onCall?: (obs: ModelCallObservation) => void;
  now?: () => number;
}): ChatTransport {
  const client = new HttpModelClient(
    { name: opts.provider, kind: "openai", baseUrl: opts.baseUrl, apiKey: opts.apiKey, models: [opts.model] },
    {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.onCall ? { onCall: opts.onCall } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    },
  );
  return async (messages) => (await client.chat({ model: opts.model, messages, maxTokens: CHAT_MAX_TOKENS })).text;
}

// ---------------------------------------------------------------------------
// The one honest engine line
// ---------------------------------------------------------------------------

/** Human description of a resolution — the part after `chat engine: `.
 *  Contains env variable NAMES only, never values. */
export function describeChatEngine(resolved: ResolvedChatBrain): string {
  if (resolved.kind === "mock") return "[mock] echo (no provider key)";
  return `real (provider=${resolved.provider} model=${resolved.model} via ${resolved.keyVar})`;
}

/** The single engine line `hades chat` prints at startup. */
export function formatChatEngineLine(resolved: ResolvedChatBrain): string {
  return `chat engine: ${describeChatEngine(resolved)}`;
}
