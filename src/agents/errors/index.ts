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
  readonly code: string;
  readonly remediation?: string;
  constructor(message: string, code = "AGENT_ERROR", remediation?: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.remediation = remediation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for governance policy violations and escalation events. */
export class GovernanceError extends AgentError {
  constructor(message: string, code = "GOVERNANCE_ERROR", remediation = "Review the agent's governance policy configuration.") {
    super(message, code, remediation);
    this.name = "GovernanceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for capability token failures and tool-level policy denials. */
export class SecurityError extends AgentError {
  constructor(message: string, code = "SECURITY_ERROR", remediation = "Check capability token configuration and permissions.") {
    super(message, code, remediation);
    this.name = "SecurityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for guardrail blocks and human-review gates. */
export class GuardrailError extends AgentError {
  constructor(message: string, code = "GUARDRAIL_ERROR", remediation = "Review guardrail rules or adjust the input/output.") {
    super(message, code, remediation);
    this.name = "GuardrailError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Base for workflow timeouts and circuit-breaker open states. */
export class WorkflowError extends AgentError {
  constructor(message: string, code = "WORKFLOW_ERROR", remediation = "Check workflow step configuration and retry settings.") {
    super(message, code, remediation);
    this.name = "WorkflowError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
