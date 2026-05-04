/**
 * Integration tests: security + governance plugins composing correctly.
 *
 * These tests verify that withControlPlane, capability tokens, and
 * composePlugins wire together as documented — without a real OpenAI call.
 *
 * Mocking strategy mirrors core.test.ts: @openai/agents is stubbed so no
 * network I/O occurs. The plugin hooks (wrapTools, onBeforeRun, etc.) are
 * exercised directly against real plugin implementations so the composition
 * logic is tested end-to-end inside this process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { run as mockRun } from "@openai/agents";
import { z } from "zod";

import type { HarnessPlugin, AgentEvent, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";
import { createCustomHarness } from "../core";
import { withControlPlane } from "../plugins/control-plane";
import { composePlugins } from "../plugins/compose";
import {
  issueCapabilityToken,
  verifyCapabilityToken,
  assertToolAllowed,
  CapabilityError,
} from "../security/capabilities";
import {
  createGovernancePolicy,
  blockTools,
  GovernancePolicyViolationError,
} from "../governance/policy";
import { withGovernance } from "../governance/plugin";

// ── Mocks (same as core.test.ts) ─────────────────────────────────────────────

vi.mock("@openai/agents", () => ({
  Agent: class Agent {
    constructor(public readonly config: unknown) {}
  },
  run: vi.fn(),
}));

vi.mock("../skills/index", () => ({
  resolveAgentTools: vi.fn(() => []),
}));

vi.mock("../utils", () => ({
  toOpenAITool: vi.fn((def: unknown) => def),
}));

vi.mock("../lib/config", () => ({
  config: { openai: { model: "gpt-4o-test" } },
}));

// ── Shared helpers ────────────────────────────────────────────────────────────

const runMock = vi.mocked(mockRun);

function setupRun(events: object[] = [], finalOutput = "ok") {
  const iterable = {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    finalOutput,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  runMock.mockResolvedValue(iterable as never);
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Minimal PluginRunContext for wrapTools / hook tests. */
function makeCtx(overrides: Partial<PluginRunContext> = {}): PluginRunContext {
  return {
    runId: "test-run-id",
    agentName: "IntegrationTestAgent",
    model: "gpt-4o-test",
    startedAt: Date.now(),
    context: {},
    ...overrides,
  };
}

/** Build a minimal ToolDefinition that records whether it was called. */
function makeTool(name: string, execute = vi.fn(async () => "result")): ToolDefinition {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: z.object({}),
    execute,
  };
}

const baseInput = {
  messages: [{ role: "user" as const, content: "run a command" }],
};

// ── Test 1: withControlPlane blocks a denied tool ─────────────────────────────

describe("withControlPlane — blocks a denied tool via wrapTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
  });

  it("throws when a denied tool's execute is called", async () => {
    // Build a control-plane plugin that explicitly denies shell_exec.
    const plugin = withControlPlane({ denyTools: ["shell_exec"] });

    const shellTool = makeTool("shell_exec");
    const ctx = makeCtx();
    const pendingEvents = new Map<string, AgentEvent>();

    // wrapTools returns a list of re-wrapped ToolDefinitions.
    const wrapped = await plugin.wrapTools!(
      [shellTool],
      ctx,
      pendingEvents
    );

    expect(wrapped).toHaveLength(1);

    // Calling the wrapped tool should be rejected by the security policy.
    await expect(wrapped[0].execute({}, {})).rejects.toThrow();

    // Verify the error code starts with SECURITY or GOVERNANCE.
    await expect(wrapped[0].execute({}, {})).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; message?: string };
      return (
        typeof e.code === "string" &&
        (e.code.startsWith("SECURITY") || e.code.startsWith("GOVERNANCE"))
      );
    });
  });

  it("allows an explicitly-allowed tool through when allowTools + denyTools are both set", async () => {
    // When allowTools and denyTools are both set, the security policy becomes
    // default-deny with an explicit allowlist. Tools in allowTools are permitted;
    // those in denyTools (or not listed) are blocked.
    const plugin = withControlPlane({
      allowTools: ["web_search"],
      denyTools: ["shell_exec"],
    });
    const webTool = makeTool("web_search");
    const ctx = makeCtx();

    const wrapped = await plugin.wrapTools!(
      [webTool],
      ctx,
      new Map<string, AgentEvent>()
    );

    // Executing web_search must not throw — it is on the allowlist.
    await expect(wrapped[0].execute({}, {})).resolves.toBe("result");
    expect(webTool.execute).toHaveBeenCalledOnce();
  });

  it("emits an error event (code starts with SECURITY) when the agent run encounters a blocked tool", async () => {
    // The SDK run itself throws a PolicyViolationError to simulate what would
    // happen after the model requested a denied tool.
    const { PolicyViolationError } = await import("../security/policy");
    runMock.mockRejectedValue(
      new PolicyViolationError("shell_exec", "Tool is on the deny list.", "policy") as never
    );

    const harness = createCustomHarness({
      name: "SecureAgent",
      instructions: "be helpful",
      plugins: [withControlPlane({ denyTools: ["shell_exec"] })],
    });

    const events = await collect(harness.stream(baseInput));

    const errorEvent = events.find((e) => e.type === "error") as
      | Extract<AgentEvent, { type: "error" }>
      | undefined;

    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toMatch(/^SECURITY/);
  });
});

// ── Test 2: capability token gates tool access ────────────────────────────────

describe("capability token — gates tool access", () => {
  const SECRET = "a-test-secret-that-is-at-least-32-chars!!";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_CAPABILITY_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.AGENT_CAPABILITY_SECRET;
  });

  it("verifyCapabilityToken resolves the correct tool list", async () => {
    const token = await issueCapabilityToken({
      sub: "user-123",
      tools: ["web_search"],
      ttl: "5m",
    });

    const payload = await verifyCapabilityToken(token);

    expect(payload.sub).toBe("user-123");
    expect(payload.tools).toEqual(["web_search"]);
  });

  it("assertToolAllowed permits a tool in the capability list", async () => {
    const token = await issueCapabilityToken({
      sub: "user-123",
      tools: ["web_search"],
    });

    const payload = await verifyCapabilityToken(token);

    // web_search is in the token — should not throw.
    expect(() => assertToolAllowed(payload.tools, "web_search")).not.toThrow();
  });

  it("assertToolAllowed throws CapabilityError for a tool not in the token", async () => {
    const token = await issueCapabilityToken({
      sub: "user-123",
      tools: ["web_search"],
    });

    const payload = await verifyCapabilityToken(token);

    // shell_exec is NOT in the token — must throw.
    expect(() => assertToolAllowed(payload.tools, "shell_exec")).toThrow(CapabilityError);
    expect(() => assertToolAllowed(payload.tools, "shell_exec")).toThrow(
      /not in the capability token scope/
    );
  });

  it("assertToolAllowed throws with CAPABILITY_TOOL_NOT_ALLOWED code", async () => {
    const token = await issueCapabilityToken({
      sub: "user-456",
      tools: ["web_search"],
    });

    const payload = await verifyCapabilityToken(token);

    let caught: CapabilityError | null = null;
    try {
      assertToolAllowed(payload.tools, "shell_exec");
    } catch (err) {
      caught = err as CapabilityError;
    }

    expect(caught).toBeInstanceOf(CapabilityError);
    expect(caught?.code).toBe("CAPABILITY_TOOL_NOT_ALLOWED");
  });

  it("wildcard token (*) allows any tool", async () => {
    const token = await issueCapabilityToken({
      sub: "super-user",
      tools: ["*"],
    });

    const payload = await verifyCapabilityToken(token);

    // Wildcard should allow anything without throwing.
    expect(() => assertToolAllowed(payload.tools, "shell_exec")).not.toThrow();
    expect(() => assertToolAllowed(payload.tools, "drop_database")).not.toThrow();
  });

  it("verifyCapabilityToken throws CapabilityError for an expired token", async () => {
    // Issue with a very-short ttl, then wait for it to lapse by using
    // jose's internal mechanisms — we forge a token with a past exp.
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(SECRET);
    const nowSec = Math.floor(Date.now() / 1000);

    const expiredToken = await new SignJWT({ tools: ["web_search"] })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("user-expired")
      .setIssuedAt(nowSec - 120)
      .setNotBefore(nowSec - 120)
      .setExpirationTime(nowSec - 60) // already expired 60 s ago
      .setAudience("agent-harness")
      .setIssuer("agent-harness")
      .setJti(crypto.randomUUID())
      .sign(secret);

    await expect(verifyCapabilityToken(expiredToken)).rejects.toThrow(CapabilityError);
    await expect(verifyCapabilityToken(expiredToken)).rejects.toMatchObject({
      code: "CAPABILITY_TOKEN_EXPIRED",
    });
  });
});

// ── Test 3: composePlugins chains hooks in order ──────────────────────────────

describe("composePlugins — chains hooks in order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRun();
  });

  it("fires onBeforeRun hooks in plugin array order", async () => {
    const order: string[] = [];

    const pluginA: HarnessPlugin = {
      name: "plugin-a",
      onBeforeRun: async (msg) => {
        order.push("A");
        return msg + ":A";
      },
    };

    const pluginB: HarnessPlugin = {
      name: "plugin-b",
      onBeforeRun: async (msg) => {
        order.push("B");
        return msg + ":B";
      },
    };

    const composed = composePlugins("test-composed", [pluginA, pluginB]);
    const ctx = makeCtx();
    const input = {
      messages: [{ role: "user" as const, content: "start" }],
    };

    const result = await composed.onBeforeRun!("start", ctx, input);

    expect(order).toEqual(["A", "B"]);
    expect(result).toBe("start:A:B");
  });

  it("plugin B's onBeforeRun sees the output of plugin A", async () => {
    const seenInB: string[] = [];

    const pluginA: HarnessPlugin = {
      name: "plugin-a",
      onBeforeRun: async (msg) => msg.toUpperCase(),
    };

    const pluginB: HarnessPlugin = {
      name: "plugin-b",
      onBeforeRun: async (msg) => {
        seenInB.push(msg);
        return msg;
      },
    };

    const composed = composePlugins("test-chain", [pluginA, pluginB]);
    const ctx = makeCtx();

    await composed.onBeforeRun!("hello", ctx, {
      messages: [{ role: "user", content: "hello" }],
    });

    // plugin B should have received the uppercased output from plugin A.
    expect(seenInB).toEqual(["HELLO"]);
  });

  it("runs both security and governance plugins in order via withControlPlane", async () => {
    // withControlPlane composes security + governance + observability.
    // We verify both hook chains fire during a real harness.stream() call
    // by confirming the run completes without errors when no tools are blocked.
    const harness = createCustomHarness({
      name: "ComposedAgent",
      instructions: "help",
      plugins: [withControlPlane({})],
    });

    const events = await collect(harness.stream(baseInput));

    // The run should complete without errors.
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("composePlugins wrapTools calls each plugin's wrapTools in order, accumulating wraps", async () => {
    const wrapOrder: string[] = [];

    const pluginA: HarnessPlugin = {
      name: "plugin-a",
      wrapTools: async (tools, _ctx, _pending) => {
        wrapOrder.push("A-wrap");
        return tools.map((t) => ({
          ...t,
          description: t.description + " [A]",
        }));
      },
    };

    const pluginB: HarnessPlugin = {
      name: "plugin-b",
      wrapTools: async (tools, _ctx, _pending) => {
        wrapOrder.push("B-wrap");
        return tools.map((t) => ({
          ...t,
          description: t.description + " [B]",
        }));
      },
    };

    const composed = composePlugins("double-wrap", [pluginA, pluginB]);
    const ctx = makeCtx();
    const tools = [makeTool("web_search")];

    const result = await composed.wrapTools!(tools, ctx, new Map());

    expect(wrapOrder).toEqual(["A-wrap", "B-wrap"]);
    expect(result[0].description).toBe("Mock tool: web_search [A] [B]");
  });

  it("composePlugins onComplete fires all plugins in order", async () => {
    const completionOrder: string[] = [];

    const pluginA: HarnessPlugin = {
      name: "plugin-a",
      onComplete: async () => { completionOrder.push("A"); },
    };

    const pluginB: HarnessPlugin = {
      name: "plugin-b",
      onComplete: async () => { completionOrder.push("B"); },
    };

    const composed = composePlugins("complete-chain", [pluginA, pluginB]);
    const ctx = makeCtx();

    await composed.onComplete!(ctx, { finalOutput: "done", durationMs: 100 });

    expect(completionOrder).toEqual(["A", "B"]);
  });
});

// ── Test 4: governance policy blockTools rule ─────────────────────────────────

describe("governance policy — blockTools rule blocks via wrapTools", () => {
  it("blocks a tool that matches a blockTools rule", async () => {
    const policy = createGovernancePolicy({
      name: "strict",
      rules: [blockTools(["shell_exec"])],
      defaultOutcome: "allowed",
      onViolation: "block",
    });

    const govPlugin = withGovernance({ policy });
    const shellTool = makeTool("shell_exec");
    const ctx = makeCtx();

    const wrapped = await govPlugin.wrapTools!(
      [shellTool],
      ctx,
      new Map<string, AgentEvent>()
    );

    await expect(wrapped[0].execute({}, {})).rejects.toThrow(GovernancePolicyViolationError);
    await expect(wrapped[0].execute({}, {})).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string };
      return typeof e.code === "string" && e.code.startsWith("GOVERNANCE");
    });
  });

  it("allows a tool that is not on the block list", async () => {
    const policy = createGovernancePolicy({
      name: "strict",
      rules: [blockTools(["shell_exec"])],
      defaultOutcome: "allowed",
      onViolation: "block",
    });

    const govPlugin = withGovernance({ policy });
    const webTool = makeTool("web_search");
    const ctx = makeCtx();

    const wrapped = await govPlugin.wrapTools!(
      [webTool],
      ctx,
      new Map<string, AgentEvent>()
    );

    await expect(wrapped[0].execute({}, {})).resolves.toBe("result");
  });
});
