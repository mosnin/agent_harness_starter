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

/** Context available to guardrail functions. */
export interface GuardrailContext {
  agentName: string;
  userId?: string;
  runId?: string;
  meta?: Record<string, unknown>;
}

/** Throw this from an input/output guardrail to stop the run immediately. */
export class GuardrailBlockError extends Error {
  constructor(
    message: string,
    public readonly reason: string
  ) {
    super(message);
    this.name = "GuardrailBlockError";
  }
}

/** Throw this to pause the run and require human review before continuing. */
export class GuardrailHumanReviewError extends Error {
  constructor(
    message: string,
    public readonly reviewReason: string,
    public readonly payload?: unknown
  ) {
    super(message);
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
