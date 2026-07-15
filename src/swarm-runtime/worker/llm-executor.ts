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
 * Build a {@link ChatFn} that calls any OpenAI-compatible /chat/completions
 * endpoint using global fetch (no SDK dependency — safe for the lean worker
 * bundle).
 */
export function createOpenAICompatibleChat(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
}): ChatFn {
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  return async (messages) => {
    const res = await fetch(`${base}/chat/completions`, {
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
    });
    if (!res.ok) throw new Error(`chat completion failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  };
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
