/**
 * Guardrails — validate inputs/outputs before and after agent runs.
 *
 * Guardrails can:
 *   - Reject or sanitize incoming requests
 *   - Enforce output format/safety constraints
 *   - Trigger human review (by throwing GuardrailHumanReviewError)
 *   - Terminate the run early (by throwing GuardrailBlockError)
 *
 * Define guardrails per-agent in AgentConfig.guardrails, or share them
 * across multiple agents.
 *
 * Aligns with the OpenAI Agents SDK guardrail concept:
 *   https://openai.github.io/openai-agents-python/guardrails/
 */

import { GuardrailError } from "../errors";


export interface GuardrailContext {
  agentName: string;
  userId?: string;
  runId?: string;
  meta?: Record<string, unknown>;
}

/** Throw this from an input/output guardrail to stop the run immediately. */
export class GuardrailBlockError extends GuardrailError {
  /** The name of the guardrail that triggered the block (from InputGuardrail.name / OutputGuardrail.name). */
  readonly guardName?: string;
  constructor(
    message: string,
    public readonly reason: string,
    guardName?: string
  ) {
    super(message, "GUARDRAIL_BLOCK", "Input was blocked by a guardrail rule. Review input or adjust the guardrail configuration.");
    this.name = "GuardrailBlockError";
    this.guardName = guardName;
  }
}

/** Throw this to pause the run and require human review before continuing. */
export class GuardrailHumanReviewError extends GuardrailError {
  constructor(
    message: string,
    public readonly reviewReason: string,
    public readonly payload?: unknown
  ) {
    super(message, "GUARDRAIL_HUMAN_REVIEW", "Output requires human review before delivery. Implement an approval handler.");
    this.name = "GuardrailHumanReviewError";
  }
}

export interface InputGuardrail {
  name: string;
  /**
   * Validate the user's input message before the agent processes it.
   * Return the (possibly sanitized) input, or throw GuardrailBlockError /
   * GuardrailHumanReviewError.
   */
  check(input: string, ctx: GuardrailContext): string | Promise<string>;
}

export interface OutputGuardrail {
  name: string;
  /**
   * Validate the agent's final output before it is returned to the caller.
   * Return the (possibly transformed) output, or throw to block/escalate.
   */
  check(output: string, ctx: GuardrailContext): string | Promise<string>;
}

export interface GuardrailSet {
  input?: InputGuardrail[];
  output?: OutputGuardrail[];
}
