/**
 * Unified error hierarchy for the agent framework.
 *
 * All framework errors extend AgentError, enabling a single top-level catch:
 *
 *   import { AgentError } from "@/agents/errors";
 *   try { await agent.run(msg); }
 *   catch (e) {
 *     if (e instanceof AgentError) { ... }
 *   }
 *
 * Domain subclasses:
 *   AgentError
 *   ├── GovernanceError  — policy violations, escalations
 *   ├── SecurityError    — capability tokens, tool policy denials
 *   ├── GuardrailError   — input/output blocks, human review gates
 *   └── WorkflowError    — timeouts, circuit breaker open
 */

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for governance policy violations and escalation events. */
export class GovernanceError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for capability token failures and tool-level policy denials. */
export class SecurityError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for guardrail blocks and human-review gates. */
export class GuardrailError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for workflow timeouts and circuit-breaker open states. */
export class WorkflowError extends AgentError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
