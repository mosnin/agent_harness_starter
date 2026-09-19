/**
 * TypeSafe Jev / System One types.
 *
 * Jev is not an LLM. It evaluates a `state` against typed questions and
 * returns calibrated answers your code can branch on:
 *   - noul   — P(yes) in [0, 1]
 *   - choice — one option + full distribution + confidence
 *   - score  — expected level + distribution + confidence
 *
 * See https://docs.typesafe.ai and
 * https://www.langchain.com/blog/building-a-harness-with-jev
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Evidence Jev evaluates. Prefer named fields; treat contents as untrusted data. */
export type JevState = string | { [key: string]: JsonValue };

export interface NoulCriteria {
  true?: string | null;
  false?: string | null;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: NoulCriteria;
}

export type ChoiceCriterion =
  | string
  | null
  | {
      description?: string;
      what?: string;
      not_for?: string;
      examples?: string;
      [key: string]: JsonValue | undefined;
    };

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, ChoiceCriterion>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest → highest. At least two. */
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface SystemOneRequest {
  model?: string;
  state: JevState;
  questions: JevQuestions;
}

export interface SystemOneResult {
  model: string;
  answers: JevAnswers;
  usage?: JevUsage;
}

export type PolicyAction = "auto" | "review" | "block" | "fallback";

export interface PolicyDecision<T = string> {
  /** What the harness should do with this judgment. */
  action: PolicyAction;
  /** Selected value (route id, tool name, yes/no, score bucket, …). */
  value: T;
  /** Stable machine-readable reason. */
  reason: string;
  /** Decision node id (e.g. "model_router", "auto_mode"). */
  node: string;
  confidence?: number;
  probability?: number;
  answers?: JevAnswers;
  /** Wall time of the System One call that produced this decision. */
  latencyMs?: number;
  /** True when the answers came from the process-local ask cache. */
  cached?: boolean;
}

export type JevFailMode = "open" | "closed" | "review";

export interface JevClientConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** Fire a second request if the first has not settled. 0 disables. Default 200. */
  hedgeMs?: number;
}

export interface JevClient {
  systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult>;
}

export type JevAskResult =
  | { ok: true; result: SystemOneResult; cached?: boolean; latencyMs?: number }
  | { ok: false; reason: string; error?: Error };

export interface JevAsker {
  ask(request: SystemOneRequest, signal?: AbortSignal): Promise<JevAskResult>;
}

export interface JevAskerOptions {
  /** Cache + coalesce identical asks. Default true. */
  cache?: boolean;
}

export interface JevAuditEntry {
  node: string;
  decision: string;
  reason: string;
  action: PolicyAction;
  confidence?: number;
  probability?: number;
  model?: string;
  durationMs: number;
  ts: number;
  answers?: JevAnswers;
}

export interface ModelRoute {
  id: string;
  /** OpenRouter / provider model id used for generation. */
  model: string;
  /** Rubric Jev reads when choosing this route. */
  criteria: string;
  what?: string;
  notFor?: string;
}

export interface SkillRoute {
  id: string;
  description: string;
}

export type VoiceChannel = "text" | "voice";
