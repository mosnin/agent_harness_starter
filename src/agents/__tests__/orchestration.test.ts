import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@openai/agents", () => {
  class Agent {
    constructor(public opts: Record<string, unknown>) {}
  }
  const run = vi.fn();
  return { Agent, run };
});

import { run as mockRunImport } from "@openai/agents";
import {
  runConditional,
  runIterative,
  runHierarchical,
  runAgentsInParallel,
  runAgentChain,
} from "../orchestrator";
import type { AgentConfig } from "../types";

const mockRun = vi.mocked(mockRunImport);

function makeAgent(name: string): AgentConfig {
  return {
    name,
    instructions: `You are ${name}`,
    tools: [],
    skills: [],
  };
}

function setupRun(output: string) {
  mockRun.mockResolvedValue({ finalOutput: output } as never);
}

beforeEach(() => {
  mockRun.mockReset();
});

// ── runAgentChain (sequential) ────────────────────────────────────────────────

describe("runAgentChain (sequential)", () => {
  it("pipes output of each agent as input to the next", async () => {
    const outputs = ["step1-output", "step2-output", "step3-output"];
    let call = 0;
    mockRun.mockImplementation(async () => ({ finalOutput: outputs[call++] }) as never);

    const result = await runAgentChain(
      [makeAgent("A"), makeAgent("B"), makeAgent("C")],
      "initial"
    );

    expect(result.finalOutput).toBe("step3-output");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].output).toBe("step1-output");
    expect(result.steps[1].output).toBe("step2-output");
  });

  it("returns initial message as final output when no agents", async () => {
    const result = await runAgentChain([], "hello");
    expect(result.finalOutput).toBe("hello");
    expect(result.steps).toHaveLength(0);
  });
});

// ── runAgentsInParallel ───────────────────────────────────────────────────────

describe("runAgentsInParallel", () => {
  it("runs all agents and returns all outputs", async () => {
    let call = 0;
    const outputs = ["output-A", "output-B"];
    mockRun.mockImplementation(async () => ({ finalOutput: outputs[call++] }) as never);

    const results = await runAgentsInParallel(
      [makeAgent("A"), makeAgent("B")],
      "question"
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.output)).toEqual(expect.arrayContaining(["output-A", "output-B"]));
  });

  it("records error for a failing agent without crashing others", async () => {
    mockRun
      .mockResolvedValueOnce({ finalOutput: "good" } as never)
      .mockRejectedValueOnce(new Error("agent crashed") as never);

    const results = await runAgentsInParallel(
      [makeAgent("Good"), makeAgent("Bad")],
      "question"
    );
    const good = results.find((r) => r.agentName === "Good");
    const bad = results.find((r) => r.agentName === "Bad");
    expect(good?.output).toBe("good");
    expect(bad?.error).toBe("agent crashed");
  });
});

// ── runConditional ────────────────────────────────────────────────────────────

describe("runConditional", () => {
  it("selects the first matching branch", async () => {
    setupRun("urgent-response");
    const result = await runConditional(
      {
        branches: [
          { when: (msg) => msg.includes("urgent"), agent: makeAgent("UrgentAgent"), label: "urgent" },
          { when: () => true, agent: makeAgent("GeneralAgent"), label: "general" },
        ],
        fallback: makeAgent("FallbackAgent"),
      },
      "this is urgent"
    );
    expect(result.branch).toBe("urgent");
    expect(result.agentName).toBe("UrgentAgent");
    expect(result.output).toBe("urgent-response");
  });

  it("runs fallback when no branch matches", async () => {
    setupRun("fallback-response");
    const result = await runConditional(
      {
        branches: [
          { when: () => false, agent: makeAgent("Never"), label: "never" },
        ],
        fallback: makeAgent("FallbackAgent"),
      },
      "hello"
    );
    expect(result.branch).toBe("fallback");
    expect(result.agentName).toBe("FallbackAgent");
  });

  it("supports async predicates", async () => {
    setupRun("async-result");
    const result = await runConditional(
      {
        branches: [
          {
            when: async (msg) => {
              await Promise.resolve();
              return msg === "async-trigger";
            },
            agent: makeAgent("AsyncAgent"),
            label: "async",
          },
        ],
        fallback: makeAgent("FallbackAgent"),
      },
      "async-trigger"
    );
    expect(result.branch).toBe("async");
  });
});

// ── runIterative ──────────────────────────────────────────────────────────────

describe("runIterative", () => {
  it("stops when stop condition is met", async () => {
    let iteration = 0;
    mockRun.mockImplementation(async () => ({
      finalOutput: iteration++ >= 1 ? "good-enough" : "not-good",
    }) as never);

    const result = await runIterative(
      {
        agent: makeAgent("Drafter"),
        stopWhen: (output) => output === "good-enough",
        maxIterations: 5,
      },
      "initial"
    );
    expect(result.stoppedBy).toBe("condition");
    expect(result.finalOutput).toBe("good-enough");
    expect(result.iterations).toHaveLength(2);
  });

  it("stops at maxIterations when condition never met", async () => {
    setupRun("still-not-good");
    const result = await runIterative(
      {
        agent: makeAgent("Drafter"),
        stopWhen: () => false,
        maxIterations: 3,
      },
      "initial"
    );
    expect(result.stoppedBy).toBe("max_iterations");
    expect(result.iterations).toHaveLength(3);
  });

  it("uses buildNextInput to transform input between iterations", async () => {
    const inputs: string[] = [];
    const impl = async (_agent: unknown, msg: unknown) => {
      inputs.push(msg as string);
      return { finalOutput: "output" };
    };
    mockRun.mockImplementation(impl as never);

    await runIterative(
      {
        agent: makeAgent("A"),
        stopWhen: (_output, i) => i >= 1,
        maxIterations: 3,
        buildNextInput: (prev, iter) => `${prev}+iter${iter}`,
      },
      "start"
    );
    expect(inputs[0]).toBe("start");
    expect(inputs[1]).toBe("output+iter1");
  });
});

// ── runHierarchical ───────────────────────────────────────────────────────────

describe("runHierarchical", () => {
  it("fans out to all children and supervisor synthesizes", async () => {
    // Children return their outputs; supervisor gets synthesis prompt
    let supervisorInput = "";
    const impl = async (_agent: unknown, msg: unknown) => {
      supervisorInput = msg as string;
      return { finalOutput: "synthesized" };
    };
    mockRun.mockImplementation(impl as never);

    const result = await runHierarchical(
      {
        supervisor: makeAgent("Supervisor"),
        children: [
          { name: "legal", run: async () => "legal analysis" },
          { name: "market", run: async () => "market analysis" },
        ],
      },
      "analyze this"
    );

    expect(result.supervisorOutput).toBe("synthesized");
    expect(result.childResults).toHaveLength(2);
    expect(supervisorInput).toContain("legal analysis");
    expect(supervisorInput).toContain("market analysis");
  });

  it("skips children whose when predicate returns false", async () => {
    setupRun("synthesized");
    const result = await runHierarchical(
      {
        supervisor: makeAgent("Supervisor"),
        children: [
          { name: "active", run: async () => "active output" },
          { name: "skipped", run: async () => "should not run", when: () => false },
        ],
      },
      "message"
    );
    const skipped = result.childResults.find((r) => r.name === "skipped");
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.output).toBe("");
  });

  it("uses custom buildSynthesisPrompt", async () => {
    let capturedPrompt = "";
    const impl2 = async (_agent: unknown, msg: unknown) => {
      capturedPrompt = msg as string;
      return { finalOutput: "ok" };
    };
    mockRun.mockImplementation(impl2 as never);

    await runHierarchical(
      {
        supervisor: makeAgent("Supervisor"),
        children: [{ name: "child1", run: async () => "child output" }],
        buildSynthesisPrompt: (original, results) =>
          `CUSTOM: ${original} | ${results.map((r: { name: string; output: string }) => r.output).join(", ")}`,
      },
      "original message"
    );

    expect(capturedPrompt).toBe("CUSTOM: original message | child output");
  });
});
