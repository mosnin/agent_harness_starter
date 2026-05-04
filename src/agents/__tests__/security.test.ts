import { describe, it, expect, beforeEach } from "vitest";
import { createPolicy, PolicyViolationError, applyPolicyToTools, DEFAULT_DENY_POLICY } from "../security/policy";
import { AuditLogger, InMemoryAuditAdapter, hashInput } from "../security/audit";
import { withSecurity } from "../security/plugin";
import type { PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginRunContext> = {}): PluginRunContext {
  return {
    runId: "run-1",
    agentName: "TestAgent",
    model: "claude-haiku-4-5-20251001",
    userId: "user-1",
    startedAt: Date.now(),
    context: {},
    ...overrides,
  };
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: {}, required: [] } as never,
    execute: async (_input: unknown, _ctx: import("../tools/types").ToolContext) => `result:${name}`,
  };
}

// ── Policy ────────────────────────────────────────────────────────────────────

describe("createPolicy", () => {
  it("allows tools on the allow list", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    const result = await policy.check("web_search");
    expect(result.allowed).toBe(true);
  });

  it("blocks tools on the deny list", async () => {
    const policy = createPolicy({ allow: ["web_search"], deny: ["web_search"] });
    const result = await policy.check("web_search");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("deny list");
  });

  it("deny takes precedence over allow", async () => {
    const policy = createPolicy({ allow: ["shell_exec"], deny: ["shell_exec"] });
    const result = await policy.check("shell_exec");
    expect(result.allowed).toBe(false);
  });

  it("default-deny blocks unknown tools", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    const result = await policy.check("unknown_tool");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("default-deny");
  });

  it("default-allow passes unknown tools when configured", async () => {
    const policy = createPolicy({ defaultAction: "allow" });
    const result = await policy.check("any_tool");
    expect(result.allowed).toBe(true);
  });

  it("dynamic rules override allow/deny (first match wins)", async () => {
    const policy = createPolicy({
      rules: [
        (toolName, ctx) => toolName === "dynamic_tool" && ctx.userId === "admin",
      ],
    });
    const result = await policy.check("dynamic_tool", { userId: "admin" });
    expect(result.allowed).toBe(true);
  });

  it("enforce throws PolicyViolationError when blocked", async () => {
    const policy = createPolicy({ allow: [] });
    await expect(policy.enforce("shell_exec")).rejects.toThrow(PolicyViolationError);
  });

  it("enforce resolves silently when allowed", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    await expect(policy.enforce("web_search")).resolves.toBeUndefined();
  });
});

describe("DEFAULT_DENY_POLICY", () => {
  it("blocks every tool", async () => {
    const result = await DEFAULT_DENY_POLICY.check("anything");
    expect(result.allowed).toBe(false);
  });
});

describe("applyPolicyToTools", () => {
  it("blocks a tool call that violates policy", async () => {
    const policy = createPolicy({ allow: [] });
    const wrapped = applyPolicyToTools([makeTool("shell_exec")], policy, { userId: "u1" });
    await expect(wrapped[0].execute({}, {} as never)).rejects.toThrow(PolicyViolationError);
  });

  it("passes through an allowed tool call", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    const wrapped = applyPolicyToTools([makeTool("web_search")], policy, {});
    const result = await wrapped[0].execute({}, {} as never);
    expect(result).toBe("result:web_search");
  });
});

// ── AuditLogger ───────────────────────────────────────────────────────────────

describe("AuditLogger", () => {
  it("writes records to the adapter", () => {
    const adapter = new InMemoryAuditAdapter();
    const logger = new AuditLogger(adapter);
    logger.log({
      runId: "r1",
      agentName: "Agent",
      toolName: "tool",
      outcome: "allowed",
    });
    expect(adapter.records).toHaveLength(1);
    expect(adapter.records[0].outcome).toBe("allowed");
  });

  it("logBlocked sets correct outcome and policyName", () => {
    const adapter = new InMemoryAuditAdapter();
    const logger = new AuditLogger(adapter);
    logger.logBlocked({ runId: "r1", agentName: "A", toolName: "t" }, "policy-x", "not on allow list");
    expect(adapter.records[0].outcome).toBe("blocked");
    expect(adapter.records[0].policyName).toBe("policy-x");
  });

  it("logAllowed sets correct outcome", () => {
    const adapter = new InMemoryAuditAdapter();
    const logger = new AuditLogger(adapter);
    logger.logAllowed({ runId: "r1", agentName: "A", toolName: "t" });
    expect(adapter.records[0].outcome).toBe("allowed");
  });

  it("never throws even if adapter.write throws", () => {
    const logger = new AuditLogger({
      write: () => { throw new Error("adapter failure"); },
    });
    expect(() => logger.log({ runId: "r", agentName: "A", toolName: "t", outcome: "allowed" })).not.toThrow();
  });
});

describe("hashInput", () => {
  it("returns a 16-char hex string", () => {
    const h = hashInput({ key: "value" });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for same input", () => {
    expect(hashInput("hello")).toBe(hashInput("hello"));
  });

  it("differs for different inputs", () => {
    expect(hashInput("a")).not.toBe(hashInput("b"));
  });
});

// ── withSecurity plugin ───────────────────────────────────────────────────────

describe("withSecurity plugin", () => {
  let adapter: InMemoryAuditAdapter;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    adapter = new InMemoryAuditAdapter();
    auditLogger = new AuditLogger(adapter);
  });

  it("has name 'security'", () => {
    const plugin = withSecurity({ auditLogger });
    expect(plugin.name).toBe("security");
  });

  it("blocks and logs when policy denies", async () => {
    const policy = createPolicy({ allow: [] });
    const plugin = withSecurity({ policy, auditLogger });
    const ctx = makeCtx();
    const [wrapped] = plugin.wrapTools!([makeTool("shell_exec")], ctx, new Map());
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow(PolicyViolationError);
    expect(adapter.records[0].outcome).toBe("blocked");
  });

  it("allows and logs when policy permits", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    const plugin = withSecurity({ policy, auditLogger });
    const ctx = makeCtx();
    const [wrapped] = plugin.wrapTools!([makeTool("web_search")], ctx, new Map());
    await wrapped.execute({}, {} as never);
    expect(adapter.records[0].outcome).toBe("allowed");
    expect(adapter.records[0].toolName).toBe("web_search");
  });

  it("logs tool errors with error outcome", async () => {
    const errorTool: ToolDefinition = {
      name: "broken_tool",
      description: "breaks",
      parameters: { type: "object", properties: {}, required: [] } as never,
      execute: async () => { throw new Error("tool crashed"); },
    };
    const policy = createPolicy({ allow: ["broken_tool"] });
    const plugin = withSecurity({ policy, auditLogger });
    const ctx = makeCtx();
    const [wrapped] = plugin.wrapTools!([errorTool], ctx, new Map());
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow("tool crashed");
    expect(adapter.records[0].outcome).toBe("error");
    expect(adapter.records[0].error).toBe("tool crashed");
  });

  it("auditOnly mode allows blocked tools but still logs", async () => {
    const policy = createPolicy({ allow: [] });
    const plugin = withSecurity({ policy, auditLogger, auditOnly: true });
    const ctx = makeCtx();
    const [wrapped] = plugin.wrapTools!([makeTool("shell_exec")], ctx, new Map());
    const result = await wrapped.execute({}, {} as never);
    expect(result).toBe("result:shell_exec");
    expect(adapter.records[0].outcome).toBe("blocked");
  });
});
