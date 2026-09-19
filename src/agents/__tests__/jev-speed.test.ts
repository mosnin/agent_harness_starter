import { describe, it, expect, beforeEach } from "vitest";
import {
  createJevAsker,
  createMockJevClient,
  recordJevFailure,
  resetJevCircuit,
  isJevCircuitOpen,
  isSafeReadTool,
  runPreflight,
  runPostflight,
  screenBrowserPage,
  CANNED_REPLIES,
} from "../jev/index";
import { withJev } from "../plugins/jev";
import { createCustomHarness } from "../core";
import type { JevAnswer } from "../jev/types";
import type { PluginRunContext } from "../types";
import { vi } from "vitest";

vi.mock("@openai/agents", () => ({
  Agent: class Agent {
    constructor(public readonly config: unknown) {}
  },
  run: vi.fn(() => {
    throw new Error("Qwen must not run on a skipped greeting");
  }),
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

function noulAns(value: number): JevAnswer {
  return { type: "noul", noul: value };
}

function ctx(): PluginRunContext {
  return {
    runId: "r1",
    agentName: "Hades",
    model: "qwen/qwen-2.5-72b-instruct",
    startedAt: Date.now(),
    context: {},
  };
}

describe("Jev speed: one RTT", () => {
  beforeEach(() => {
    resetJevCircuit();
  });

  it("preflight makes a single System One call for screen + route + skip", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) {
        answers[id] = noulAns(0.1);
      }
      return { model: "jev-latest", answers };
    });
    const result = await runPreflight({
      message: "Summarize yesterday's incidents.",
      asker: createJevAsker(client),
    });
    expect(calls).toBe(1);
    expect(result.asks).toBe(1);
    expect(result.screen.node).toBe("screen_external");
    expect(result.routed.node).toBe("model_router");
    expect(result.skipGeneration).toBe(false);
  });

  it("skips Jev and Qwen on a greeting when screening is off (zero RTT)", async () => {
    let calls = 0;
    const client = createMockJevClient(() => {
      calls += 1;
      return { model: "jev-latest", answers: {} };
    });
    const result = await runPreflight({
      message: "hey",
      asker: createJevAsker(client),
      requireScreen: false,
    });
    expect(calls).toBe(0);
    expect(result.asks).toBe(0);
    expect(result.skipGeneration).toBe(true);
    expect(result.directReply).toBe(CANNED_REPLIES.greeting);
  });

  it("still screens greetings when requireScreen is on", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.05);
      return { model: "jev-latest", answers };
    });
    const result = await runPreflight({
      message: "hello",
      asker: createJevAsker(client),
      requireScreen: true,
    });
    expect(calls).toBe(1);
    expect(result.asks).toBe(1);
    expect(result.screen.action).toBe("auto");
    expect(result.skipGeneration).toBe(true);
    expect(result.directReply).toBe(CANNED_REPLIES.greeting);
  });

  it("reuses a cached System One result on the second identical ask", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.05);
      return { model: "jev-latest", answers };
    });
    const asker = createJevAsker(client);
    await runPreflight({ message: "Summarize yesterday's incidents.", asker, requireScreen: true });
    const second = await runPreflight({ message: "Summarize yesterday's incidents.", asker, requireScreen: true });
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.asks).toBe(1);
  });

  it("postflight makes a single System One call for output + quality + completion", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const pick = id === "recommendation" && keys.includes("ship") ? "ship" : keys[0]!;
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]));
          answers[id] = { type: "choice", choice: pick, probabilities, confidence: 0.92 };
        } else if (q.type === "score") {
          answers[id] = {
            type: "score",
            score: 0,
            legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level])),
            probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 0.8 : 0.2 / Math.max(1, q.criteria.length - 1)])),
            confidence: 0.9,
          };
        } else {
          answers[id] = noulAns(0.1);
        }
      }
      return { model: "jev-latest", answers };
    });
    const result = await runPostflight({
      draft: "The invoice is unpaid.",
      userRequest: "Status?",
      evidence: "Invoice 12 is unpaid.",
      asker: createJevAsker(client),
    });
    expect(calls).toBe(1);
    expect(result.asks).toBe(1);
    expect(result.screen.node).toBe("screen_output");
    expect(result.quality?.decision.node).toBe("quality");
    expect(result.completion?.node).toBe("task_complete");
    expect(result.citation?.node).toBe("citation_verify");
  });

  it("withJev records one preflight ask on a real task", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.05);
      return { model: "jev-latest", answers };
    });
    const plugin = withJev({
      asker: createJevAsker(client),
      screenOutput: false,
      autoMode: false,
      stopHook: false,
      compact: false,
    });
    await plugin.onBeforeRun!("How do I paginate?", ctx(), {
      messages: [{ role: "user", content: "How do I paginate?" }],
    });
    expect(calls).toBe(1);
  });

  it("core never calls the generator when Jev skips the LLM", async () => {
    const harness = createCustomHarness({
      name: "Hades",
      instructions: "unused",
      plugins: [
        withJev({
          asker: createJevAsker(createMockJevClient(() => ({ model: "jev-latest", answers: {} }))),
          autoMode: false,
          screenOutput: false,
        }),
      ],
    });
    const events: string[] = [];
    let final = "";
    for await (const event of harness.stream({ messages: [{ role: "user", content: "thanks" }] })) {
      events.push(event.type);
      if (event.type === "done") final = event.finalOutput;
    }
    expect(final).toBe(CANNED_REPLIES.thanks);
    expect(events).toContain("message_done");
    expect(events).not.toContain("error");
  });

  it("screens a browser page and picks the next step in one ask", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      expect(req.questions.injection).toBeDefined();
      expect(req.questions.action).toBeDefined();
      expect(req.questions.target).toBeDefined();
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const pick = id === "action" && keys.includes("CLICK")
            ? "CLICK"
            : id === "target" && keys.includes("submit")
              ? "submit"
              : keys[0]!;
          const probabilities = Object.fromEntries(
            keys.map((k) => [k, k === pick ? 0.92 : 0.08 / Math.max(1, keys.length - 1)])
          );
          const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
          for (const k of Object.keys(probabilities)) probabilities[k] = (probabilities[k] ?? 0) / sum;
          answers[id] = { type: "choice", choice: pick, probabilities, confidence: 0.94 };
        } else if (q.type === "score") {
          const levels = q.criteria;
          const pick = 2;
          const probabilities: Record<string, number> = {};
          levels.forEach((_, i) => {
            probabilities[String(i)] = i === pick ? 0.8 : 0.2 / Math.max(1, levels.length - 1);
          });
          const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
          for (const key of Object.keys(probabilities)) probabilities[key] = (probabilities[key] ?? 0) / sum;
          answers[id] = {
            type: "score",
            score: pick,
            legend: Object.fromEntries(levels.map((level, i) => [String(i), level])),
            probabilities,
            confidence: 0.9,
          };
        } else {
          answers[id] = noulAns(id === "substance" ? 0.85 : 0.08);
        }
      }
      return { model: "jev-latest", answers };
    });
    const browsed = await screenBrowserPage({
      task: "Submit the form",
      text: "Checkout form with a Submit button.",
      url: "https://shop.example/checkout",
      elements: [{ id: "submit", type: "button", label: "Submit" }],
      asker: createJevAsker(client),
    });
    expect(calls).toBe(1);
    expect(browsed.asks).toBe(1);
    expect(browsed.screen.node).toBe("screen_external");
    expect(browsed.screen.action).toBe("auto");
    expect(browsed.step.node).toBe("browser_step");
    expect(browsed.step.value).toBe("CLICK");
    expect(browsed.target).toBe("submit");
    expect(browsed.page?.node).toBe("pagegrade");
    expect(browsed.page?.action).toBe("auto");
  });
});

describe("Jev reliability: circuit breaker", () => {
  beforeEach(() => {
    resetJevCircuit();
  });

  it("opens after repeated failures and fail-fasts", () => {
    expect(isJevCircuitOpen()).toBe(false);
    recordJevFailure();
    recordJevFailure();
    recordJevFailure();
    expect(isJevCircuitOpen()).toBe(true);
    const asker = createJevAsker();
    return expect(asker.ask({ state: { x: 1 }, questions: { a: { type: "noul", instructions: "x" } } })).resolves.toMatchObject({
      ok: false,
      reason: "jev-circuit-open",
    });
  });

  it("skips System One for read-only tools", () => {
    expect(isSafeReadTool("web_search")).toBe(true);
    expect(isSafeReadTool("file_read")).toBe(true);
    expect(isSafeReadTool("bash")).toBe(false);
    expect(isSafeReadTool("get_secrets")).toBe(false);
  });
});
