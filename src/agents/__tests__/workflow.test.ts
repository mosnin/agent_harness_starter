import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@openai/agents", () => {
  class Agent { constructor(public opts: Record<string, unknown>) {} }
  const run = vi.fn();
  return { Agent, run };
});
vi.mock("../skills/index", () => ({ resolveAgentTools: vi.fn(() => []) }));
vi.mock("../utils", () => ({ toOpenAITool: vi.fn((d: unknown) => d) }));
vi.mock("../lib/config", () => ({ config: { openai: { model: "test-model" } } }));

import { run as mockRunImport } from "@openai/agents";
import { createWorkflow } from "../workflow/builder";
import { agentStep, sequential, parallel, branch, loop, delegate, transform, customStep } from "../workflow/steps";
import {
  withRetry,
  withTimeout,
  withFallback,
  withErrorHandler,
  createCircuitBreaker,
  ConcurrencyLimiter,
  TimeoutError,
  CircuitBreakerOpenError,
} from "../workflow/resilience";
import { InMemoryStateStore, InMemoryWorkflowLogger } from "../workflow/state";
import type { AgentConfig } from "../types";
import type { WorkflowContext } from "../workflow/types";

const mockRun = vi.mocked(mockRunImport);

function makeAgent(name: string): AgentConfig {
  return { name, instructions: `You are ${name}`, tools: [], skills: [] };
}

function setupRun(output: string) {
  mockRun.mockResolvedValue({ finalOutput: output } as never);
}

function makeCtx(message = "hello"): WorkflowContext {
  return {
    originalMessage: message,
    agentContext: { userId: "u1" },
    stepOutputs: {},
    currentMessage: message,
    log: [],
  };
}

beforeEach(() => { mockRun.mockReset(); });

// ── agentStep ─────────────────────────────────────────────────────────────────

describe("agentStep", () => {
  it("calls run and updates ctx.currentMessage", async () => {
    setupRun("agent output");
    const step = agentStep("search", makeAgent("Searcher"));
    const ctx = makeCtx("question");
    const result = await step.execute(ctx);
    expect(result.currentMessage).toBe("agent output");
    expect(result.stepOutputs.search?.output).toBe("agent output");
    expect(result.log[0].status).toBe("ok");
  });
});

// ── sequential ────────────────────────────────────────────────────────────────

describe("sequential step", () => {
  it("threads currentMessage through each child step", async () => {
    const outputs = ["first", "second", "third"];
    let i = 0;
    mockRun.mockImplementation(async () => ({ finalOutput: outputs[i++] }) as never);
    const step = sequential("pipeline", [
      agentStep("a", makeAgent("A")),
      agentStep("b", makeAgent("B")),
      agentStep("c", makeAgent("C")),
    ]);
    const ctx = makeCtx("start");
    const result = await step.execute(ctx);
    expect(result.currentMessage).toBe("third");
  });
});

// ── parallel ──────────────────────────────────────────────────────────────────

describe("parallel step", () => {
  it("runs all children and stores outputs", async () => {
    let call = 0;
    const outs = ["legal-out", "market-out"];
    mockRun.mockImplementation(async () => ({ finalOutput: outs[call++] }) as never);
    const step = parallel("gather", [
      agentStep("legal", makeAgent("Legal")),
      agentStep("market", makeAgent("Market")),
    ]);
    const ctx = makeCtx("analyze");
    const result = await step.execute(ctx);
    const parsed = JSON.parse(result.currentMessage);
    expect(Object.values(parsed)).toEqual(expect.arrayContaining(["legal-out", "market-out"]));
  });
});

// ── branch ────────────────────────────────────────────────────────────────────

describe("branch step", () => {
  it("runs first matching branch", async () => {
    setupRun("escalated");
    const step = branch("gate", [
      { when: (ctx) => ctx.currentMessage.includes("urgent"), step: agentStep("urgent", makeAgent("Urgent")) },
      { when: () => true, step: agentStep("general", makeAgent("General")) },
    ], agentStep("fallback", makeAgent("Fallback")));
    const ctx = makeCtx("urgent request");
    const result = await step.execute(ctx);
    expect(result.currentMessage).toBe("escalated");
    expect(result.stepOutputs.gate?.metadata?.branch).toBe("urgent");
  });

  it("runs fallback when no branch matches", async () => {
    setupRun("fallback output");
    const step = branch("gate", [
      { when: () => false, step: agentStep("never", makeAgent("Never")) },
    ], agentStep("fallback", makeAgent("Fallback")));
    const result = await step.execute(makeCtx("hello"));
    expect(result.stepOutputs.gate?.metadata?.branch).toBe("fallback");
  });
});

// ── loop ──────────────────────────────────────────────────────────────────────

describe("loop step", () => {
  it("stops when condition is met", async () => {
    let iter = 0;
    mockRun.mockImplementation(async () => ({ finalOutput: iter++ >= 1 ? "done" : "not-done" }) as never);
    const step = loop("refine", agentStep("drafter", makeAgent("Drafter")), {
      until: (ctx) => ctx.currentMessage === "done",
      maxIterations: 5,
    });
    const result = await step.execute(makeCtx("start"));
    expect(result.currentMessage).toBe("done");
  });

  it("stops at maxIterations when condition never met", async () => {
    setupRun("still-draft");
    const calls: number[] = [];
    const inner = { name: "counter", type: "agent" as const, execute: async (ctx: WorkflowContext) => {
      calls.push(1);
      ctx.currentMessage = "still-draft";
      return ctx;
    }};
    const step = loop("refine", inner, { until: () => false, maxIterations: 3 });
    await step.execute(makeCtx("start"));
    expect(calls).toHaveLength(3);
  });
});

// ── delegate ──────────────────────────────────────────────────────────────────

describe("delegate step", () => {
  it("fans out to all targets and concatenates without coordinator", async () => {
    let c = 0;
    const outs = ["legal-view", "tech-view"];
    mockRun.mockImplementation(async () => ({ finalOutput: outs[c++] }) as never);
    const step = delegate("analyze", {
      targets: [
        { name: "legal", agent: makeAgent("Legal") },
        { name: "tech",  agent: makeAgent("Tech") },
      ],
      mode: "parallel",
    });
    const result = await step.execute(makeCtx("analyze this"));
    expect(result.currentMessage).toContain("legal-view");
    expect(result.currentMessage).toContain("tech-view");
  });

  it("skips targets whose when predicate is false", async () => {
    setupRun("result");
    const step = delegate("analyze", {
      targets: [
        { name: "active", agent: makeAgent("Active") },
        { name: "skipped", agent: makeAgent("Skipped"), when: () => false },
      ],
    });
    const result = await step.execute(makeCtx("go"));
    expect(result.stepOutputs["analyze.active"]).toBeDefined();
    expect(result.stepOutputs["analyze.skipped"]).toBeUndefined();
  });
});

// ── transform ─────────────────────────────────────────────────────────────────

describe("transform step", () => {
  it("applies pure function without LLM call", async () => {
    const step = transform("upper", (ctx) => ctx.currentMessage.toUpperCase());
    const result = await step.execute(makeCtx("hello world"));
    expect(result.currentMessage).toBe("HELLO WORLD");
    expect(mockRun).not.toHaveBeenCalled();
  });
});

// ── customStep ────────────────────────────────────────────────────────────────

describe("customStep", () => {
  it("executes user-provided function", async () => {
    const step = customStep("inject", async (ctx) => {
      ctx.currentMessage = "injected";
      return ctx;
    });
    const result = await step.execute(makeCtx("original"));
    expect(result.currentMessage).toBe("injected");
  });
});

// ── createWorkflow builder ────────────────────────────────────────────────────

describe("createWorkflow builder", () => {
  it("chains steps and returns final output", async () => {
    const outs = ["researched", "analyzed"];
    let i = 0;
    mockRun.mockImplementation(async () => ({ finalOutput: outs[i++] }) as never);
    const wf = createWorkflow("test-workflow")
      .agent("research", makeAgent("Researcher"))
      .agent("analyze", makeAgent("Analyzer"))
      .build();
    const result = await wf.run("question");
    expect(result.finalOutput).toBe("analyzed");
    expect(result.stepOutputs.research?.output).toBe("researched");
  });

  it("saves state to stateStore on completion", async () => {
    setupRun("done");
    const store = new InMemoryStateStore();
    const wf = createWorkflow("state-test", { stateStore: store })
      .agent("step1", makeAgent("A"))
      .build();
    await wf.run("go");
    const states = await store.list("state-test");
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)?.status).toBe("completed");
  });

  it("logs workflow lifecycle events", async () => {
    setupRun("output");
    const logger = new InMemoryWorkflowLogger();
    const wf = createWorkflow("log-test", { logger })
      .agent("step1", makeAgent("A"))
      .build();
    await wf.run("hello");
    const msgs = logger.entries.map((e) => e.message);
    expect(msgs.some((m) => m.includes("started"))).toBe(true);
    expect(msgs.some((m) => m.includes("completed"))).toBe(true);
  });

  it("respects workflow-level timeout", async () => {
    mockRun.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ finalOutput: "late" } as never), 500))
    );
    const wf = createWorkflow("timeout-test", { timeoutMs: 50 })
      .agent("slow", makeAgent("Slow"))
      .build();
    await expect(wf.run("go")).rejects.toThrow("timed out");
  });

  it("fluent API: supports all step types", () => {
    const wf = createWorkflow("full-api")
      .agent("a", makeAgent("A"))
      .sequential("seq", [agentStep("b", makeAgent("B"))])
      .parallel("par", [agentStep("c", makeAgent("C"))])
      .branch("br", [{ when: () => true, step: agentStep("d", makeAgent("D")) }], agentStep("fb", makeAgent("FB")))
      .loop("lp", agentStep("e", makeAgent("E")), { until: () => true })
      .transform("tr", () => "transformed")
      .custom("cu", async (ctx) => ctx)
      .build();
    expect(wf.name).toBe("full-api");
  });
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("retries on failure and succeeds", async () => {
    let calls = 0;
    const inner = {
      name: "flaky",
      type: "agent" as const,
      execute: async (ctx: WorkflowContext) => {
        calls++;
        if (calls < 3) throw new Error("transient");
        ctx.currentMessage = "success";
        return ctx;
      },
    };
    const step = withRetry(inner, { maxAttempts: 3, baseDelayMs: 1 });
    const result = await step.execute(makeCtx());
    expect(result.currentMessage).toBe("success");
    expect(calls).toBe(3);
  });

  it("throws after maxAttempts exhausted", async () => {
    const inner = {
      name: "always-fails",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => { throw new Error("permanent"); },
    };
    const step = withRetry(inner, { maxAttempts: 2, baseDelayMs: 1 });
    await expect(step.execute(makeCtx())).rejects.toThrow("permanent");
  });

  it("respects retryWhen predicate", async () => {
    let calls = 0;
    const inner = {
      name: "selective",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => {
        calls++;
        throw new Error("not-retryable");
      },
    };
    const step = withRetry(inner, {
      maxAttempts: 5,
      baseDelayMs: 1,
      retryWhen: (err) => err.message !== "not-retryable",
    });
    await expect(step.execute(makeCtx())).rejects.toThrow("not-retryable");
    expect(calls).toBe(1);
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("resolves within timeout", async () => {
    const inner = {
      name: "fast",
      type: "agent" as const,
      execute: async (ctx: WorkflowContext) => { ctx.currentMessage = "fast"; return ctx; },
    };
    const step = withTimeout(inner, 5000);
    const result = await step.execute(makeCtx());
    expect(result.currentMessage).toBe("fast");
  });

  it("throws TimeoutError when step is too slow", async () => {
    const inner = {
      name: "slow",
      type: "agent" as const,
      execute: (ctx: WorkflowContext): Promise<WorkflowContext> =>
        new Promise((r) => setTimeout(() => r(ctx), 500)),
    };
    const step = withTimeout(inner, 10);
    await expect(step.execute(makeCtx())).rejects.toThrow(TimeoutError);
  });
});

// ── withFallback ──────────────────────────────────────────────────────────────

describe("withFallback", () => {
  it("runs fallback when primary fails", async () => {
    const primary = {
      name: "primary",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => { throw new Error("primary down"); },
    };
    const fallback = {
      name: "fallback",
      type: "agent" as const,
      execute: async (ctx: WorkflowContext) => { ctx.currentMessage = "fallback output"; return ctx; },
    };
    const step = withFallback(primary, fallback);
    const result = await step.execute(makeCtx());
    expect(result.currentMessage).toBe("fallback output");
    expect(result.stepOutputs["primary.__error"]?.output).toContain("primary down");
  });

  it("returns primary result when successful", async () => {
    const primary = {
      name: "primary",
      type: "agent" as const,
      execute: async (ctx: WorkflowContext) => { ctx.currentMessage = "primary output"; return ctx; },
    };
    const fallback = {
      name: "fallback",
      type: "agent" as const,
      execute: async (ctx: WorkflowContext) => { ctx.currentMessage = "should-not-run"; return ctx; },
    };
    const step = withFallback(primary, fallback);
    const result = await step.execute(makeCtx());
    expect(result.currentMessage).toBe("primary output");
  });
});

// ── withErrorHandler ──────────────────────────────────────────────────────────

describe("withErrorHandler", () => {
  it("substitutes fallback message on error", async () => {
    const inner = {
      name: "fail",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => { throw new Error("oops"); },
    };
    const step = withErrorHandler(inner, {
      handle: (err) => `Handled: ${err.message}`,
    });
    const result = await step.execute(makeCtx());
    expect(result.currentMessage).toBe("Handled: oops");
    expect(result.log[0].status).toBe("error");
  });
});

// ── createCircuitBreaker ──────────────────────────────────────────────────────

describe("createCircuitBreaker", () => {
  it("opens after failureThreshold failures", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const failing = {
      name: "fail",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => { throw new Error("fail"); },
    };
    const wrapped = cb.wrap(failing);
    await expect(wrapped.execute(makeCtx())).rejects.toThrow("fail");
    await expect(wrapped.execute(makeCtx())).rejects.toThrow("fail");
    // Now circuit should be open
    expect(cb.state).toBe("open");
    await expect(wrapped.execute(makeCtx())).rejects.toThrow(CircuitBreakerOpenError);
  });

  it("resets on successful call", async () => {
    const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1 });
    const fail = {
      name: "f",
      type: "agent" as const,
      execute: async (_ctx: WorkflowContext): Promise<WorkflowContext> => { throw new Error("fail"); },
    };
    const wrapped = cb.wrap(fail);
    await expect(wrapped.execute(makeCtx())).rejects.toThrow();
    cb.reset();
    expect(cb.state).toBe("closed");
  });
});

// ── ConcurrencyLimiter ────────────────────────────────────────────────────────

describe("ConcurrencyLimiter", () => {
  it("limits concurrent executions", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let running = 0;
    let maxRunning = 0;
    const tasks = Array.from({ length: 5 }, (_, i) =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return i;
      })
    );
    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });
});

// ── InMemoryStateStore ────────────────────────────────────────────────────────

describe("InMemoryStateStore", () => {
  it("saves and retrieves workflow state", async () => {
    const store = new InMemoryStateStore();
    const state = {
      runId: "run-1",
      workflowName: "test",
      status: "completed" as const,
      currentStep: null,
      startedAt: Date.now(),
      contextSnapshot: { currentMessage: "done", stepOutputs: {}, log: [] },
    };
    await store.save(state);
    const retrieved = await store.get("run-1");
    expect(retrieved?.status).toBe("completed");
  });

  it("lists by workflow name", async () => {
    const store = new InMemoryStateStore();
    for (const name of ["wf-a", "wf-a", "wf-b"]) {
      await store.save({
        runId: Math.random().toString(),
        workflowName: name,
        status: "completed",
        currentStep: null,
        startedAt: Date.now(),
        contextSnapshot: { currentMessage: "", stepOutputs: {}, log: [] },
      });
    }
    const aStates = await store.list("wf-a");
    expect(aStates).toHaveLength(2);
  });
});
