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

/**
 * Base for governance policy violations and escalation events.
 * Subclasses set more specific codes:
 *   GovernancePolicyViolationError → "GOVERNANCE_POLICY_VIOLATION"
 *   EscalationError                → "GOVERNANCE_ERROR" (inherits default)
 * Catch this class when you want to handle any governance failure;
 * switch on .code for specific handling.
 */
export class GovernanceError extends AgentError {
  constructor(message: string, code = "GOVERNANCE_ERROR", remediation = "Review the agent's governance policy configuration.") {
    super(message, code, remediation);
    this.name = "GovernanceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base for capability token failures and tool-level policy denials.
 * Subclasses set more specific codes:
 *   CapabilityError      → "SECURITY_CAPABILITY_ERROR" (default), plus specific variants:
 *                           "CAPABILITY_TOKEN_EXPIRED", "CAPABILITY_TOKEN_REVOKED",
 *                           "CAPABILITY_TOOL_NOT_ALLOWED", "CAPABILITY_MALFORMED_TOKEN",
 *                           "CAPABILITY_INVALID_SIGNATURE", "CAPABILITY_ALGORITHM_MISMATCH",
 *                           "CAPABILITY_AUDIENCE_MISMATCH", "CAPABILITY_ISSUER_MISMATCH",
 *                           "CAPABILITY_ORG_MISMATCH", "CAPABILITY_NO_TOOLS",
 *                           "CAPABILITY_TOKEN_NOT_YET_VALID", "CAPABILITY_CLAIM_VALIDATION_FAILED"
 *   PolicyViolationError → "SECURITY_ERROR" (inherits default)
 * Catch this class when you want to handle any security failure;
 * switch on .code for specific handling.
 */
export class SecurityError extends AgentError {
  constructor(message: string, code = "SECURITY_ERROR", remediation = "Check capability token configuration and permissions.") {
    super(message, code, remediation);
    this.name = "SecurityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base for guardrail blocks and human-review gates.
 * Subclasses set more specific codes:
 *   GuardrailBlockError       → "GUARDRAIL_BLOCK"
 *   GuardrailHumanReviewError → "GUARDRAIL_HUMAN_REVIEW"
 * Catch this class when you want to handle any guardrail failure;
 * switch on .code for specific handling.
 */
export class GuardrailError extends AgentError {
  constructor(message: string, code = "GUARDRAIL_ERROR", remediation = "Review guardrail rules or adjust the input/output.") {
    super(message, code, remediation);
    this.name = "GuardrailError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base for workflow timeouts and circuit-breaker open states.
 * Subclasses set more specific codes:
 *   TimeoutError            → "WORKFLOW_TIMEOUT"
 *   CircuitBreakerOpenError → "WORKFLOW_CIRCUIT_OPEN"
 * Catch this class when you want to handle any workflow failure;
 * switch on .code for specific handling.
 */
export class WorkflowError extends AgentError {
  constructor(message: string, code = "WORKFLOW_ERROR", remediation = "Check workflow step configuration and retry settings.") {
    super(message, code, remediation);
    this.name = "WorkflowError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
