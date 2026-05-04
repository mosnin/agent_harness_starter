/**
 * Extended SkillDefinition types.
 *
 * A Skill is a named, typed, composable capability. Beyond being a tool bundle,
 * a Skill carries:
 *   - typed I/O contracts (what goes in, what comes out)
 *   - internal logic description (how the skill reasons)
 *   - boundaries (what it cannot do, when to defer)
 *   - prerequisites (what must be ready before it can run)
 *   - combinations (how it composes with other skills)
 *   - adaptability (how it improves over time)
 *   - evaluation (how to measure its performance)
 */

import type { z } from "zod";

// ── Typed I/O ────────────────────────────────────────────────────────────────

export interface SkillInput {
  /** Name of the input field. */
  name: string;
  /** Human-readable description (injected into the agent's tool description). */
  description: string;
  /** Whether this field is required. Default: true. */
  required?: boolean;
  /** Example values (shown to the model as hints). */
  examples?: string[];
  /** Zod schema for validation. Optional — use for programmatic chains. */
  schema?: z.ZodTypeAny;
}

export interface SkillOutput {
  /** Name of the output field. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Type hint for the model. E.g. "string", "array of URLs", "JSON object". */
  type: string;
  /** Example output values. */
  examples?: string[];
}

// ── Skill boundaries ──────────────────────────────────────────────────────────

export interface SkillBoundaries {
  /**
   * What this skill cannot do. Injected as negative constraints in the prompt.
   * Example: ["Cannot access real-time data", "Cannot modify files"]
   */
  cannotDo?: string[];
  /**
   * When to defer to a different skill or human.
   * Example: ["Defer to the 'code' skill for execution tasks"]
   */
  deferWhen?: string[];
  /**
   * Maximum input size (in tokens/characters) this skill can handle.
   * If input exceeds this, the skill should split or defer.
   */
  maxInputSize?: number;
  /**
   * Confidence threshold below which the skill should flag uncertainty.
   * 0.0–1.0. Default: 0.7.
   */
  confidenceThreshold?: number;
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

export interface SkillPrerequisite {
  /** What must be available before this skill can run. */
  type: "skill" | "tool" | "context" | "data";
  /** Name of the required skill, tool, or context key. */
  name: string;
  /** Human-readable reason why this prerequisite is needed. */
  reason: string;
  /** Whether missing this prerequisite is a hard blocker (vs. a warning). Default: true. */
  required?: boolean;
}

// ── Combinations ──────────────────────────────────────────────────────────────

export type SkillCompositionMode = "sequential" | "parallel" | "conditional";

export interface SkillCombination {
  /** The other skill(s) to combine with. */
  with: string[];
  /** How they combine. Default: "sequential". */
  mode?: SkillCompositionMode;
  /** Human-readable description of what the combination achieves. */
  description: string;
  /**
   * Optional: the order in which to run them (for sequential mode).
   * If omitted, the skills run in the `with` array order.
   */
  order?: string[];
}

// ── Adaptability ──────────────────────────────────────────────────────────────

export interface SkillAdaptability {
  /**
   * Whether this skill records outcomes for future improvement. Default: false.
   * When true, the evaluation score and outputs are persisted.
   */
  learningEnabled?: boolean;
  /**
   * Strategy for improvement:
   *   "prompt-tuning" — adjust prompt based on failure patterns
   *   "tool-selection" — switch tool choices based on success rates
   *   "parameter-tuning" — adjust temperature/k/topK based on quality
   */
  adaptationStrategy?: "prompt-tuning" | "tool-selection" | "parameter-tuning";
  /**
   * Minimum number of runs before adaptation kicks in. Default: 10.
   */
  minRunsBeforeAdapting?: number;
  /**
   * Score improvement threshold that triggers adaptation. Default: 0.1 (10%).
   */
  adaptationThreshold?: number;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface SkillMetric {
  /** Metric name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /**
   * Type of metric:
   *   "score"    — 0.0–1.0 numeric score
   *   "boolean"  — pass/fail
   *   "duration" — time in ms
   *   "count"    — integer count
   */
  type: "score" | "boolean" | "duration" | "count";
  /** Target value (for SLA / alerting). */
  target?: number;
}

export interface SkillEvaluationConfig {
  /** Metrics to track on every run. */
  metrics: SkillMetric[];
  /**
   * Custom evaluation function. Receives the output and returns a score 0–1.
   * Used to compute an overall quality score for this skill run.
   */
  evaluate?: (output: string, input: Record<string, unknown>) => number | Promise<number>;
  /** Minimum acceptable overall score. Runs below this are flagged. Default: 0.7. */
  minScore?: number;
}

export interface SkillRunRecord {
  skillName: string;
  runId: string;
  score?: number;
  metrics: Record<string, number | boolean>;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  timestamp: number;
  flagged: boolean;
}

// ── SkillDefinition ──────────────────────────────────────────────────────────

export interface SkillDefinition {
  /** Unique name — used in AgentConfig.skills[]. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Tool names in this skill bundle. */
  tools: string[];

  // ── Optional extended fields ───────────────────────────────────────────────

  /** Typed inputs this skill accepts. */
  inputs?: SkillInput[];
  /** Typed outputs this skill produces. */
  outputs?: SkillOutput[];
  /**
   * Internal reasoning process description. Injected into the skill's
   * system prompt to guide how the agent uses this skill.
   */
  logic?: string;
  /** What this skill cannot do and when to defer. */
  boundaries?: SkillBoundaries;
  /** Conditions that must be met before this skill can run. */
  prerequisites?: SkillPrerequisite[];
  /** How this skill can combine with other skills. */
  combinations?: SkillCombination[];
  /** How this skill improves over time. */
  adaptability?: SkillAdaptability;
  /** How to measure if this skill performed well. */
  evaluation?: SkillEvaluationConfig;
  /**
   * Tags for skill selection and categorization.
   * Examples: ["read-only", "async", "high-cost", "fast"]
   */
  tags?: string[];
  /**
   * Estimated cost tier per invocation.
   */
  cost?: "free" | "cheap" | "moderate" | "expensive";
  /**
   * Human-readable prompt addendum that gets appended to the agent's system prompt
   * when this skill is active. Use to inject skill-specific guidance.
   */
  promptAddendum?: string;
}

/** @deprecated Use SkillDefinition directly — extended fields are now optional on the base type. */
export type ExtendedSkillDefinition = SkillDefinition;
