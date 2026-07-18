/**
 * The inference factory — decides whether the desktop/sidecar swarm gets a
 * REAL brain (a live model client, when provider keys are present) or a
 * clearly-labeled MOCK (deterministic, offline, zero-cost) otherwise.
 *
 * This module owns exactly one decision: real vs mock, and building the
 * {@link WorkerExecutor} the swarm calls to actually run a worker task. It
 * does NOT wire itself into `sidecar.ts` or `index.ts` — the main loop does
 * that centrally; this file only needs to be correct and honest in isolation.
 *
 * Key detection reuses `buildClientFromEnv` from
 * `src/hades/cli/bench-command.ts` (ANTHROPIC_API_KEY / OPENAI_API_KEY, with
 * OpenAI-dialect OPENAI_BASE_URL support) rather than re-implementing it, so
 * the desktop app and the `hades bench` CLI never disagree about what counts
 * as "a real brain is available."
 *
 * Honesty rule: {@link InferenceMode.detail} must always truthfully say
 * whether the swarm is running on a real model or the offline mock, and
 * mock output is always prefixed `"[mock] "` — it must never be mistaken for
 * a real model's answer.
 */

import { buildClientFromEnv } from "../../hades/cli/bench-command";
import type { ModelClient } from "../../hades/models/client";

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

export interface InferenceMode {
  kind: "real" | "mock";
  /** Human-readable, truthful summary, e.g. "anthropic+openai" or "no keys — deterministic mock". */
  detail: string;
}

/** Default worker model used for a directly-injected client with no model override. */
const DEFAULT_WORKER_MODEL = "claude-haiku-4-5-20251001";

/**
 * Real iff ANTHROPIC_API_KEY or OPENAI_API_KEY is present — reusing
 * `buildClientFromEnv`'s own detection (it returns `null` exactly when
 * neither key is set) so this never drifts from the CLI's notion of "keys
 * present." `detail` lists which provider(s) were found, in a stable order.
 */
export function detectInference(
  env: Record<string, string | undefined> = process.env,
): InferenceMode {
  const built = buildClientFromEnv(env);
  if (!built) {
    return { kind: "mock", detail: "no keys — deterministic mock" };
  }
  const providers: string[] = [];
  if (env.ANTHROPIC_API_KEY) providers.push("anthropic");
  if (env.OPENAI_API_KEY) providers.push("openai");
  return { kind: "real", detail: providers.join("+") };
}

// ---------------------------------------------------------------------------
// WorkerExecutor — what the swarm actually calls
// ---------------------------------------------------------------------------

/**
 * A worker executor the swarm can call: given a task prompt, produce an
 * answer + cost. The real path uses a {@link ModelClient}; the mock path is
 * deterministic and fully offline (no network, no randomness, no clock).
 */
export interface WorkerExecutor {
  run(prompt: string): Promise<{ output: string; tokensIn: number; tokensOut: number; usd: number }>;
}

/** Real executor: one `client.chat` call per prompt, real usage passed through. */
function realExecutor(client: ModelClient, model: string): WorkerExecutor {
  return {
    async run(prompt: string) {
      const res = await client.chat({ model, messages: [{ role: "user", content: prompt }] });
      return {
        output: res.text,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        usd: res.usd,
      };
    },
  };
}

/**
 * Deterministic, offline transform of a prompt into a mock "answer." Same
 * prompt in -> same string out, always. Carries no claim of correctness —
 * it is a structural echo (word/char counts), not a generated response.
 */
function deterministicMockAnswer(prompt: string): string {
  const trimmed = prompt.trim();
  const words = trimmed.length ? trimmed.split(/\s+/).length : 0;
  return `deterministic offline response (words=${words}, chars=${trimmed.length}) — no provider keys set, this is NOT a real model output.`;
}

/** Mock executor: no network, no keys, no cost. Output is always `"[mock] " + ...`. */
function mockExecutor(): WorkerExecutor {
  return {
    async run(prompt: string) {
      return {
        output: `[mock] ${deterministicMockAnswer(prompt)}`,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createExecutor — the factory
// ---------------------------------------------------------------------------

export interface CreateExecutorOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injected client (tests, or a caller that already built one) — forces the real path. */
  client?: ModelClient;
  /** Model id for the real path. Defaults to `buildClientFromEnv`'s worker model, or {@link DEFAULT_WORKER_MODEL} when a bare client is injected with no env-derived model. */
  model?: string;
}

/**
 * Build the executor the swarm will call, plus the {@link InferenceMode}
 * describing what it actually got. Real iff a `client` is injected OR
 * provider keys exist in `env`; otherwise the deterministic mock — this
 * mirrors `detectInference`, but an injected client always wins (it is
 * real inference by construction, whatever the env says), and NEVER makes a
 * network call for either the decision or (in the mock case) the answer.
 */
export function createExecutor(
  opts?: CreateExecutorOptions,
): { mode: InferenceMode; executor: WorkerExecutor } {
  const env = opts?.env ?? process.env;
  const envMode = detectInference(env);

  if (opts?.client) {
    // Injected client -> real path regardless of env. Detail still reports
    // the truth: which provider keys (if any) back this decision.
    const detail = envMode.kind === "real" ? envMode.detail : "injected client (no keys in env)";
    return {
      mode: { kind: "real", detail },
      executor: realExecutor(opts.client, opts.model ?? DEFAULT_WORKER_MODEL),
    };
  }

  if (envMode.kind === "real") {
    const built = buildClientFromEnv(env);
    // envMode.kind === "real" implies buildClientFromEnv(env) is non-null —
    // both derive from the exact same key check.
    if (!built) {
      // Unreachable in practice; fail honestly to mock rather than throw.
      return { mode: { kind: "mock", detail: "no keys — deterministic mock" }, executor: mockExecutor() };
    }
    return {
      mode: envMode,
      executor: realExecutor(built.client, opts?.model ?? built.workerModel),
    };
  }

  return { mode: envMode, executor: mockExecutor() };
}
