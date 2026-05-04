import { describe, it, expect, vi } from "vitest";
import {
  createGovernancePolicy,
  evaluate,
  blockTools,
  blockContentPatterns,
  DEFAULT_GOVERNANCE_POLICY,
  GovernancePolicyViolationError,
} from "../governance/policy";
import {
  createEthicsPolicy,
  STANDARD_ETHICS_RULES,
  STANDARD_ETHICS_POLICY,
} from "../governance/ethics";
import { createComplianceTracker } from "../governance/compliance";
import { withGovernance } from "../governance/plugin";
import type { GovernanceContext } from "../governance/types";
import { CapabilityError } from "../security/capabilities";
import { GuardrailBlockError } from "../guardrails/types";
import { WorkflowError } from "../errors/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<GovernanceContext> = {}): GovernanceContext {
  return {
    agentId: "test-agent",
    userId: "user-1",
    action: "output",
    content: "This is a benign response.",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── createGovernancePolicy ────────────────────────────────────────────────────

describe("createGovernancePolicy", () => {
  it("creates a policy with the provided rules", () => {
    const rule = blockTools(["shell_exec"]);
    const policy = createGovernancePolicy({ name: "test", rules: [rule] });
    expect(policy.rules).toHaveLength(1);
    expect(policy.name).toBe("test");
  });

  it("creates a policy with no rules when rules array is empty", () => {
    const policy = createGovernancePolicy({ name: "empty", rules: [] });
    expect(policy.rules).toHaveLength(0);
  });

  it("uses default outcome 'allowed' when not specified", () => {
    const policy = createGovernancePolicy({ name: "default-test", rules: [] });
    expect(policy.config.defaultOutcome).toBe("allowed");
  });
});

// ── evaluate ─────────────────────────────────────────────────────────────────

describe("evaluate", () => {
  it("returns 'allowed' when no rules match", async () => {
    const policy = createGovernancePolicy({ name: "empty", rules: [] });
    const decision = await evaluate(policy, makeCtx());
    expect(decision.outcome).toBe("allowed");
  });

  it("returns 'blocked' when a blocking tool rule matches", async () => {
    const policy = createGovernancePolicy({
      name: "tool-block",
      rules: [blockTools(["dangerous_tool"])],
    });
    const ctx = makeCtx({ action: "tool:dangerous_tool" });
    const decision = await evaluate(policy, ctx);
    expect(decision.outcome).toBe("blocked");
  });

  it("allows a tool not in the blocked list", async () => {
    const policy = createGovernancePolicy({
      name: "tool-block",
      rules: [blockTools(["dangerous_tool"])],
    });
    const ctx = makeCtx({ action: "tool:web_search" });
    const decision = await evaluate(policy, ctx);
    expect(decision.outcome).toBe("allowed");
  });

  it("blocks content matching a blocked pattern", async () => {
    const policy = createGovernancePolicy({
      name: "content-block",
      rules: [blockContentPatterns("no-passwords", [/password/i])],
    });
    const ctx = makeCtx({ content: "Your password is 12345." });
    const decision = await evaluate(policy, ctx);
    expect(decision.outcome).toBe("blocked");
  });

  it("allows content that does not match any pattern", async () => {
    const policy = createGovernancePolicy({
      name: "content-block",
      rules: [blockContentPatterns("no-passwords", [/password/i])],
    });
    const ctx = makeCtx({ content: "Here is the weather forecast." });
    const decision = await evaluate(policy, ctx);
    expect(decision.outcome).toBe("allowed");
  });
});

// ── DEFAULT_GOVERNANCE_POLICY ─────────────────────────────────────────────────

describe("DEFAULT_GOVERNANCE_POLICY", () => {
  it("has at least one rule", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.rules.length).toBeGreaterThan(0);
  });

  it("is named 'default'", () => {
    expect(DEFAULT_GOVERNANCE_POLICY.name).toBe("default");
  });
});

// ── Ethics ────────────────────────────────────────────────────────────────────

describe("STANDARD_ETHICS_RULES", () => {
  it("is a non-empty array of GovernanceRules", () => {
    expect(Array.isArray(STANDARD_ETHICS_RULES)).toBe(true);
    expect(STANDARD_ETHICS_RULES.length).toBeGreaterThan(0);
  });

  it("each rule has id, description, risk, and check function", () => {
    for (const rule of STANDARD_ETHICS_RULES) {
      expect(typeof rule.id).toBe("string");
      expect(typeof rule.description).toBe("string");
      expect(typeof rule.risk).toBe("string");
      expect(typeof rule.check).toBe("function");
    }
  });
});

describe("STANDARD_ETHICS_POLICY.evaluate", () => {
  it("allows benign output", async () => {
    const ctx = makeCtx({ content: "Paris is the capital of France." });
    const decision = await STANDARD_ETHICS_POLICY.evaluate(ctx);
    expect(decision.outcome).toBe("allowed");
  });
});

describe("createEthicsPolicy", () => {
  it("wraps rules in a GovernancePolicy accessible via .policy", () => {
    const ethics = createEthicsPolicy({ rules: STANDARD_ETHICS_RULES });
    expect(ethics.policy.rules.length).toBe(STANDARD_ETHICS_RULES.length);
  });

  it("evaluate() is callable and returns a decision", async () => {
    const ethics = createEthicsPolicy({ rules: [] });
    const decision = await ethics.evaluate(makeCtx());
    expect(decision.outcome).toBe("allowed");
  });
});

// ── ComplianceTracker ─────────────────────────────────────────────────────────

describe("createComplianceTracker", () => {
  it("records entries and returns them via query", () => {
    const tracker = createComplianceTracker({});

    const ctx = makeCtx({ agentId: "agent-99" });
    tracker.record(ctx, {
      outcome: "allowed",
      risk: "low",
      reason: "test",
      timestamp: Date.now(),
    });

    const records = tracker.query({ agentId: "agent-99" });
    expect(records).toHaveLength(1);
    expect(records[0].agentId).toBe("agent-99");
  });

  it("stats() counts totals across outcomes", () => {
    const tracker = createComplianceTracker({});
    const ctx = makeCtx({ agentId: "agent-stats" });

    tracker.record(ctx, { outcome: "allowed", risk: "low", reason: "ok", timestamp: Date.now() });
    tracker.record(ctx, { outcome: "blocked", risk: "high", reason: "bad", timestamp: Date.now() });

    const stats = tracker.stats({ agentId: "agent-stats" });
    expect(stats.total).toBe(2);
    expect(stats.byOutcome["blocked"]).toBe(1);
    expect(stats.byOutcome["allowed"]).toBe(1);
  });
});

// ── withGovernance plugin ─────────────────────────────────────────────────────

describe("withGovernance", () => {
  it("returns a HarnessPlugin with the required shape", () => {
    const plugin = withGovernance({
      policy: DEFAULT_GOVERNANCE_POLICY,
      ethics: STANDARD_ETHICS_POLICY,
    });
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(typeof plugin.wrapTools).toBe("function");
    expect(typeof plugin.onAfterRun).toBe("function");
  });

  it("wrapTools passes through tools when policy allows", async () => {
    const plugin = withGovernance({
      policy: createGovernancePolicy({ name: "permissive", rules: [] }),
    });
    const tool = {
      name: "safe_tool",
      description: "A safe tool",
      parameters: { type: "object", properties: {}, required: [] } as never,
      execute: vi.fn(async () => "ok"),
    };

    const ctx = {
      runId: "r1",
      agentName: "A",
      model: "claude-haiku-4-5-20251001",
      userId: "u1",
      startedAt: Date.now(),
      context: {},
    };

    const result = plugin.wrapTools!([tool], ctx, new Map());
    const wrapped = Array.isArray(result) ? result : await result;
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].name).toBe("safe_tool");
  });
});

// ── Structured error codes ────────────────────────────────────────────────────

describe("structured error codes", () => {
  it("GovernancePolicyViolationError has code GOVERNANCE_POLICY_VIOLATION", () => {
    const decision = { outcome: "blocked" as const, risk: "high" as const, reason: "test", timestamp: Date.now() };
    const err = new GovernancePolicyViolationError(decision);
    expect(err.code).toBe("GOVERNANCE_POLICY_VIOLATION");
  });

  it("CapabilityError has code SECURITY_CAPABILITY_ERROR", () => {
    const err = new CapabilityError("token invalid");
    expect(err.code).toBe("SECURITY_CAPABILITY_ERROR");
  });

  it("GuardrailBlockError has code GUARDRAIL_BLOCK", () => {
    const err = new GuardrailBlockError("blocked", "profanity detected");
    expect(err.code).toBe("GUARDRAIL_BLOCK");
  });

  it("WorkflowError base class has code WORKFLOW_ERROR", () => {
    const err = new WorkflowError("something failed");
    expect(err.code).toBe("WORKFLOW_ERROR");
  });
});
