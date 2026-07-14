import { describe, it, expect } from "vitest";
import { LLMExecutor, chatToPlannerComplete } from "../worker/llm-executor";
import { VerificationGate } from "../verification/gate";
import type { WorkerTask } from "../types";
import type { WorkerContext } from "../worker/executor";

const ctx: WorkerContext = { workerId: "w1", log: () => {} };

function task(): WorkerTask {
  return {
    id: "t1",
    goalId: "g1",
    description: "What does the config say about retries?",
    requiredCapabilities: ["general"],
    input: { config: "retries=5, backoff=exponential" },
    dependsOn: [],
    priority: 5,
    status: "dispatched",
    attempts: 0,
    maxAttempts: 3,
    createdAt: 0,
  };
}

describe("LLMExecutor", () => {
  const gate = new VerificationGate();

  it("parses grounded JSON claims and passes the verification gate", async () => {
    const chat = async () =>
      JSON.stringify({
        answer: "The config sets retries=5 with exponential backoff.",
        claims: [
          { statement: "retries is 5", evidence: ["retries=5"], confidence: 0.9 },
          { statement: "backoff is exponential", evidence: ["backoff=exponential"], confidence: 0.9 },
        ],
      });
    const exec = new LLMExecutor(chat);
    const out = await exec.execute(task(), ctx);
    expect(out.claims.length).toBe(2);
    expect(out.toolTrace.length).toBe(1);

    const report = await gate.verify({
      taskId: "t1",
      workerId: "w1",
      output: out.output,
      claims: out.claims,
      toolTrace: out.toolTrace,
      startedAt: 0,
      finishedAt: 1,
    });
    // Evidence "retries=5" / "backoff=exponential" appears in the recorded prompt.
    expect(report.verdict).toBe("accept");
  });

  it("degrades gracefully when the model returns non-JSON", async () => {
    const exec = new LLMExecutor(async () => "here is a plain answer with no json");
    const out = await exec.execute(task(), ctx);
    expect(out.claims.length).toBe(1);
    expect(out.claims[0].confidence).toBeLessThan(0.5);
  });

  it("gets caught by the gate when it fabricates evidence absent from the prompt", async () => {
    const chat = async () =>
      JSON.stringify({
        answer: "Retries are 999.",
        claims: [{ statement: "retries is 999", evidence: ["retries=999 per the spec"], confidence: 0.99 }],
      });
    const out = await new LLMExecutor(chat).execute(task(), ctx);
    const report = await gate.verify({
      taskId: "t1",
      workerId: "w1",
      output: out.output,
      claims: out.claims,
      toolTrace: out.toolTrace,
      startedAt: 0,
      finishedAt: 1,
    });
    expect(report.verdict).toBe("reject");
  });

  it("adapts the chat interface into a planner completion fn", async () => {
    const complete = chatToPlannerComplete(async (msgs) => `echo:${msgs[0].content}`);
    expect(await complete("hello")).toBe("echo:hello");
  });
});
