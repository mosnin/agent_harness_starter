import type { Claim, ToolCallRecord, WorkerTask } from "../types";
import type { ExecutionOutput, TaskExecutor, WorkerContext } from "./executor";

/**
 * Minimal chat interface. Injectable so the executor is testable with a mock
 * and provider-agnostic: any OpenAI-compatible endpoint (Nous Portal,
 * OpenRouter, OpenAI, a local vLLM/Ollama server) works by pointing
 * {@link createOpenAICompatibleChat} at its base URL — mirroring Hermes'
 * "bring any model" philosophy.
 */
export type ChatFn = (messages: ChatMessage[]) => Promise<string>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `You are a worker agent in a verified swarm. You must ground every claim.
Return ONLY a JSON object of the form:
{
  "answer": "<your final answer>",
  "claims": [
    { "statement": "<a specific factual assertion>",
      "evidence": ["<exact quote or fact you are relying on>"],
      "confidence": 0.0-1.0 }
  ]
}
Rules:
- Never assert anything you cannot ground in the task input or provided dependencies.
- If you are unsure, say so and lower confidence — do not fabricate evidence.
- Evidence must be quotable text actually present in the task input/dependencies.`;

/**
 * LLM-backed worker executor. Prompts the model for a grounded, JSON-structured
 * answer and records the exact prompt + raw completion as a tool-trace entry, so
 * the claims the model emits are traceable to what it was actually given and
 * actually said — the verification gate can then confirm the evidence appears in
 * that trace rather than trusting the model's word.
 *
 * This is intentionally tool-free: a bare LLM worker should not be trusted with
 * unsupported factual claims, and the gate enforces exactly that (no external
 * tool calls ⇒ multi-claim outputs are held to a stricter bar). To give a worker
 * real grounding power, supply an executor backed by the full agent harness and
 * its tool registry.
 */
export class LLMExecutor implements TaskExecutor {
  constructor(private readonly chat: ChatFn) {}

  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    const deps = (task.input as { _dependencies?: Array<{ output: unknown }> })._dependencies ?? [];
    const feedback = (task.input as { _revisionFeedback?: string })._revisionFeedback;
    const revision = (task.input as { _revision?: { attempt: number; failedChecks: string[] } })._revision;
    const failedChecks = revision?.failedChecks?.length
      ? `The verifier failed these checks last time: ${revision.failedChecks.join(", ")}. Fix each specifically.`
      : "";

    const userContent = [
      `TASK: ${task.description}`,
      `INPUT: ${JSON.stringify(task.input)}`,
      deps.length ? `VERIFIED DEPENDENCIES:\n${JSON.stringify(deps, null, 2)}` : "",
      feedback ? `PRIOR ATTEMPT WAS REJECTED (attempt ${revision?.attempt ?? "?"}). Address this feedback:\n${feedback}\n${failedChecks}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    ctx.log(`calling model for task ${task.id.slice(0, 8)}`);
    const raw = await this.chat(messages);

    // The traceable evidence is only what the worker was *given* (task input +
    // verified dependencies) — never the model's own generated answer.
    // Otherwise a model could cite its own fabrication as evidence and the
    // grounding check would be meaningless. The gate verifies claims against
    // this observed material, not against the output being judged.
    const trace: ToolCallRecord[] = [
      {
        tool: "context.provided",
        args: { promptChars: userContent.length },
        ok: true,
        output: userContent.slice(0, 4000),
        at: Date.now(),
      },
    ];

    const parsed = safeParse(raw);
    if (parsed) {
      const claims: Claim[] = Array.isArray(parsed.claims)
        ? parsed.claims.map(normalizeClaim)
        : [];
      return { output: parsed.answer ?? raw, claims, toolTrace: trace };
    }

    // Model didn't return valid JSON — degrade to a single low-confidence claim
    // grounded in its own output, which the gate will treat conservatively.
    return {
      output: raw,
      claims: [{ statement: "Model produced a free-text answer.", evidence: [raw.slice(0, 200)], confidence: 0.4 }],
      toolTrace: trace,
    };
  }
}

/**
 * Turn a pre-response `fetch` rejection (DNS failure, connection refused,
 * abort/timeout) into an actionable error naming the endpoint and the
 * underlying cause code, instead of undici's bare "fetch failed". Used by both
 * chat transports so a run against a dead endpoint (e.g. `--provider local`
 * with no Ollama running) fails fast with a message a user can act on. Never
 * includes headers or request bodies, so nothing secret can leak into logs.
 */
export function chatTransportError(e: unknown, url: string, timeoutMs?: number): Error {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return new Error(`chat request to ${url} timed out after ${timeoutMs}ms with no response`);
  }
  const cause = (e as { cause?: { code?: string; errors?: Array<{ code?: string }>; message?: string } }).cause;
  const code =
    cause?.code ??
    cause?.errors?.find((err) => err?.code)?.code ??
    cause?.message ??
    (e instanceof Error ? e.message : String(e));
  return new Error(`chat request to ${url} failed before any response: ${code}`);
}

/**
 * What one real round trip through {@link createOpenAICompatibleChat} cost,
 * as reported by the provider itself.
 *
 * This transport used to parse the response and keep only the message text,
 * discarding the `usage` block the endpoint had already sent — which is why
 * a swarm run could never say what it cost. The seam is deliberately shaped
 * so an UNREPORTED count is `null`, never `0`: a call that consumed tokens
 * but whose usage block was missing must not be recorded as free. The
 * consumer (`src/hades/cost/`) turns these into a measured total, or an
 * explicit UNKNOWN.
 */
export interface ChatUsageObservation {
  /** Model REQUESTED (what a price table keys on). */
  model: string;
  /** Model the provider REPORTED serving, when it named one. */
  servedModel?: string;
  provider: string;
  /** Prompt tokens as reported, or `null` when the response had no usage block. */
  tokensIn: number | null;
  /** Completion tokens as reported, or `null` when absent. */
  tokensOut: number | null;
  /** Measured round-trip wall clock, ms. */
  latencyMs: number;
  /** Epoch ms at completion. */
  at: number;
}

/**
 * Build a {@link ChatFn} that calls any OpenAI-compatible /chat/completions
 * endpoint using global fetch (no SDK dependency — safe for the lean worker
 * bundle).
 */
export function createOpenAICompatibleChat(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  /**
   * Abort the whole HTTP request (connect + response) after this many ms so a
   * dead endpoint fails fast instead of hanging a worker. Unset = no timeout
   * (previous behaviour, preserved for existing callers).
   */
  timeoutMs?: number;
  /** Logical provider name for the observation. Default `"openai-compatible"`. */
  providerName?: string;
  /**
   * Called once per SUCCESSFUL round trip with the provider's own usage
   * counts and the measured latency. Never called for a failed request: a
   * call that produced no response reported no tokens, and inventing a row
   * for it would put a fabricated entry in the cost ledger. Observer
   * exceptions are swallowed — bookkeeping must not fail a worker's task.
   */
  onUsage?: (obs: ChatUsageObservation) => void;
  /** Clock for latency/timestamps. Injectable so tests stay deterministic. */
  now?: () => number;
}): ChatFn {
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const now = opts.now ?? Date.now;
  return async (messages) => {
    let res: Response;
    const startedAt = now();
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          temperature: opts.temperature ?? 0.2,
          response_format: { type: "json_object" },
        }),
        ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (e) {
      throw chatTransportError(e, base, opts.timeoutMs);
    }
    if (!res.ok) throw new Error(`chat completion failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    if (opts.onUsage) {
      const at = now();
      try {
        opts.onUsage({
          model: opts.model,
          ...(typeof data.model === "string" && data.model ? { servedModel: data.model } : {}),
          provider: opts.providerName ?? "openai-compatible",
          tokensIn: finiteOrNull(data.usage?.prompt_tokens),
          tokensOut: finiteOrNull(data.usage?.completion_tokens),
          latencyMs: Math.max(0, at - startedAt),
          at,
        });
      } catch {
        // Cost bookkeeping must never break the worker's actual work.
      }
    }

    return data.choices?.[0]?.message?.content ?? "";
  };
}

/** A reported token count, or `null` when the provider reported nothing. */
function finiteOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** LLM-backed planner completion function from the same chat interface. */
export function chatToPlannerComplete(chat: ChatFn): (prompt: string) => Promise<string> {
  return (prompt) => chat([{ role: "user", content: prompt }]);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safeParse(raw: string): { answer?: string; claims?: unknown[] } | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeClaim(c: unknown): Claim {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return {
    statement: String(o.statement ?? ""),
    evidence: Array.isArray(o.evidence) ? o.evidence.map(String) : [],
    confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
  };
}
