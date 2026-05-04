import { describe, it, expect, beforeEach } from "vitest";
import { createPolicy, createAuditedPolicy, PolicyViolationError, applyPolicyToTools, DEFAULT_DENY_POLICY } from "../security/policy";
import { AuditLogger, InMemoryAuditAdapter, hashInput } from "../security/audit";
import { withSecurity } from "../security/plugin";
import { issueCapabilityToken, verifyCapabilityToken, CapabilityError, revokeToken } from "../security/capabilities";
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
    const [wrapped] = await Promise.resolve(plugin.wrapTools!([makeTool("shell_exec")], ctx, new Map()));
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow(PolicyViolationError);
    expect(adapter.records[0].outcome).toBe("blocked");
  });

  it("allows and logs when policy permits", async () => {
    const policy = createPolicy({ allow: ["web_search"] });
    const plugin = withSecurity({ policy, auditLogger });
    const ctx = makeCtx();
    const [wrapped] = await Promise.resolve(plugin.wrapTools!([makeTool("web_search")], ctx, new Map()));
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
    const [wrapped] = await Promise.resolve(plugin.wrapTools!([errorTool], ctx, new Map()));
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow("tool crashed");
    expect(adapter.records[0].outcome).toBe("error");
    expect(adapter.records[0].error).toBe("tool crashed");
  });

  it("auditOnly mode allows blocked tools but still logs", async () => {
    const policy = createPolicy({ allow: [] });
    const plugin = withSecurity({ policy, auditLogger, auditOnly: true });
    const ctx = makeCtx();
    const [wrapped] = await Promise.resolve(plugin.wrapTools!([makeTool("shell_exec")], ctx, new Map()));
    const result = await wrapped.execute({}, {} as never);
    expect(result).toBe("result:shell_exec");
    expect(adapter.records[0].outcome).toBe("blocked");
  });
});

// ── Capability tokens ─────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-that-is-at-least-32-characters-long";

describe("issueCapabilityToken — aud/iss claims", () => {
  beforeEach(() => {
    process.env.AGENT_CAPABILITY_SECRET = TEST_SECRET;
  });

  it("includes aud and iss in issued token payload", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      aud: "support-agent",
      iss: "acme-platform",
    });

    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.aud).toBe("support-agent");
    expect(payload.iss).toBe("acme-platform");
  });

  it("defaults aud to 'agent-harness' when omitted", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
    });

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.aud).toBe("agent-harness");
  });

  it("defaults aud to agentName when agentName is set and aud omitted", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      agentName: "my-agent",
    });

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.aud).toBe("my-agent");
  });

  it("defaults iss to 'agent-harness' when omitted", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
    });

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.iss).toBe("agent-harness");
  });

  it("aud and iss appear in verified payload", async () => {
    const token = await issueCapabilityToken({
      sub: "user-2",
      tools: ["lookup_order"],
      aud: "order-agent",
      iss: "shop-platform",
    });

    const payload = await verifyCapabilityToken(token);
    expect(payload.aud).toBe("order-agent");
    expect(payload.iss).toBe("shop-platform");
  });
});

describe("verifyCapabilityToken — expectedAud option", () => {
  beforeEach(() => {
    process.env.AGENT_CAPABILITY_SECRET = TEST_SECRET;
  });

  it("accepts token when aud matches expectedAud", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      aud: "support-agent",
    });

    const payload = await verifyCapabilityToken(token, { expectedAud: "support-agent" });
    expect(payload.aud).toBe("support-agent");
    expect(payload.sub).toBe("user-1");
  });

  it("rejects token when aud does not match expectedAud", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      aud: "support-agent",
    });

    await expect(
      verifyCapabilityToken(token, { expectedAud: "billing-agent" })
    ).rejects.toThrow(CapabilityError);
  });

  it("rejection error message contains both actual and expected aud", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      aud: "support-agent",
    });

    await expect(
      verifyCapabilityToken(token, { expectedAud: "billing-agent" })
    ).rejects.toThrow(/support-agent.*billing-agent|billing-agent.*support-agent/);
  });

  it("skips aud check when expectedAud is not provided", async () => {
    const token = await issueCapabilityToken({
      sub: "user-1",
      tools: ["web_search"],
      aud: "any-agent",
    });

    await expect(verifyCapabilityToken(token)).resolves.toBeDefined();
  });
});

// ── issueCapabilityToken — algorithm detection ────────────────────────────────

describe("issueCapabilityToken — algorithm detection", () => {
  it("uses HS256 when only AGENT_CAPABILITY_SECRET is set", async () => {
    process.env.AGENT_CAPABILITY_SECRET = "a".repeat(32);
    delete process.env.AGENT_CAPABILITY_PRIVATE_KEY;
    delete process.env.AGENT_CAPABILITY_PUBLIC_KEY;
    const token = await issueCapabilityToken({ sub: "u1", tools: ["web_search"] });
    const [headerB64] = token.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    expect(header.alg).toBe("HS256");
  });
});

// ── JWT security ──────────────────────────────────────────────────────────────

describe("JWT security", () => {
  beforeEach(() => {
    process.env.AGENT_CAPABILITY_SECRET = TEST_SECRET;
    delete process.env.AGENT_CAPABILITY_PRIVATE_KEY;
    delete process.env.AGENT_CAPABILITY_PUBLIC_KEY;
  });

  it("rejects token with algorithm mismatch (RS256 header on HS256 verifier)", async () => {
    // Issue a valid HS256 token
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"] });

    // Split token parts
    const parts = token.split(".");
    const [, body, sig] = parts;

    // Decode header and replace alg with RS256
    const originalHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const tamperedHeader = { ...originalHeader, alg: "RS256" };
    const tamperedHeaderB64 = Buffer.from(JSON.stringify(tamperedHeader)).toString("base64url");

    // Reassemble token with tampered header but original signature
    const tamperedToken = `${tamperedHeaderB64}.${body}.${sig}`;

    await expect(verifyCapabilityToken(tamperedToken)).rejects.toThrow(CapabilityError);
    await expect(verifyCapabilityToken(tamperedToken)).rejects.toThrow(/mismatch|algorithm/i);
  });

  it("issued tokens include jti claim", async () => {
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"] });

    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

    expect(payload.jti).toBeDefined();
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti.length).toBeGreaterThan(0);
  });

  it("rejects token with wrong orgId", async () => {
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"], orgId: "org-a" });
    await expect(
      verifyCapabilityToken(token, { expectedOrgId: "org-b" })
    ).rejects.toThrow(CapabilityError);
  });

  it("accepts token with correct orgId", async () => {
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"], orgId: "org-a" });
    const payload = await verifyCapabilityToken(token, { expectedOrgId: "org-a" });
    expect(payload.orgId).toBe("org-a");
  });

  it("rejects revoked token", async () => {
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"] });
    const parts = token.split(".");
    const { jti } = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    revokeToken(jti);
    await expect(verifyCapabilityToken(token)).rejects.toThrow(/revoked/i);
  });

  it("rejects token with future nbf", async () => {
    // Issue a valid token, then tamper with nbf to be 1 hour in the future
    const token = await issueCapabilityToken({ sub: "user-1", tools: ["web_search"] });
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));

    // Replace nbf with a timestamp 1 hour in the future
    const tamperedPayload = { ...payload, nbf: Math.floor(Date.now() / 1000) + 3600 };
    const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url");

    // Re-sign with the test secret
    const { createHmac } = await import("crypto");
    const signingInput = `${parts[0]}.${tamperedBody}`;
    const newSig = Buffer.from(
      createHmac("sha256", TEST_SECRET).update(signingInput).digest().toString("binary")
    ).toString("base64url");

    const tamperedToken = `${parts[0]}.${tamperedBody}.${newSig}`;

    await expect(verifyCapabilityToken(tamperedToken)).rejects.toThrow(CapabilityError);
    await expect(verifyCapabilityToken(tamperedToken)).rejects.toThrow(/not yet valid/i);
  });

  it("issued tokens have unique jti values", async () => {
    const tokens = await Promise.all([
      issueCapabilityToken({ sub: "user-1", tools: ["web_search"] }),
      issueCapabilityToken({ sub: "user-1", tools: ["web_search"] }),
      issueCapabilityToken({ sub: "user-1", tools: ["web_search"] }),
    ]);
    const jtis = tokens.map(t => {
      const parts = t.split(".");
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).jti as string;
    });
    expect(new Set(jtis).size).toBe(3);
    jtis.forEach(jti => expect(typeof jti).toBe("string"));
  });
});

// ── createAuditedPolicy ───────────────────────────────────────────────────────

describe("createAuditedPolicy", () => {
  it("calls audit sink with 'allowed' outcome when tool is permitted", async () => {
    const adapter = new InMemoryAuditAdapter();
    const policy = createAuditedPolicy(
      { allow: ["web_search"], name: "test-policy" },
      adapter
    );

    const result = await policy.check("web_search", { runId: "r1", userId: "u1" });
    expect(result.allowed).toBe(true);
    expect(adapter.records).toHaveLength(1);
    expect(adapter.records[0].outcome).toBe("allowed");
    expect(adapter.records[0].toolName).toBe("web_search");
  });

  it("calls audit sink with 'blocked' outcome when tool is denied", async () => {
    const adapter = new InMemoryAuditAdapter();
    const policy = createAuditedPolicy(
      { allow: ["web_search"], name: "test-policy" },
      adapter
    );

    const result = await policy.check("shell_exec", { runId: "r1", userId: "u1" });
    expect(result.allowed).toBe(false);
    expect(adapter.records).toHaveLength(1);
    expect(adapter.records[0].outcome).toBe("blocked");
    expect(adapter.records[0].toolName).toBe("shell_exec");
  });

  it("audit record contains policyName on blocked outcome", async () => {
    const adapter = new InMemoryAuditAdapter();
    const policy = createAuditedPolicy(
      { allow: [], name: "strict-policy" },
      adapter
    );

    await policy.check("any_tool", { runId: "r1" });
    expect(adapter.records[0].policyName).toBe("strict-policy");
  });

  it("audit records correct toolName and userId for each check", async () => {
    const adapter = new InMemoryAuditAdapter();
    const policy = createAuditedPolicy(
      { allow: ["tool_a", "tool_b"], name: "multi-policy" },
      adapter
    );

    await policy.check("tool_a", { runId: "r1", userId: "alice" });
    await policy.check("tool_b", { runId: "r1", userId: "bob" });

    expect(adapter.records).toHaveLength(2);
    expect(adapter.records[0].toolName).toBe("tool_a");
    expect(adapter.records[0].userId).toBe("alice");
    expect(adapter.records[1].toolName).toBe("tool_b");
    expect(adapter.records[1].userId).toBe("bob");
  });
});
