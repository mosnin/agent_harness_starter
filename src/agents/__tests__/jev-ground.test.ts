import { describe, it, expect, beforeEach } from "vitest";
import {
  createJevAsker,
  createMockJevClient,
  resetJevCircuit,
  runPreflight,
  runPostflight,
  runToolGate,
  harvestToolEvidence,
  splitSentences,
  abstainReply,
  CLARIFY_REPLY,
} from "../jev/index";
import { withJev } from "../plugins/jev";
import type { JevAnswer } from "../jev/types";
import type { PluginRunContext } from "../types";

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

describe("grounding + quiet-ask + tool gate", () => {
  beforeEach(() => {
    resetJevCircuit();
  });

  it("splits drafts into scoreable sentences", () => {
    const parts = splitSentences(
      "Revenue was $4.2M in Q3. We should look at the invoice next. Okay."
    );
    expect(parts[0]).toMatch(/Revenue/);
    expect(parts.some((part) => part.length < 24)).toBe(false);
  });

  it("skips Qwen with a clarify when the request is too vague", async () => {
    const client = createMockJevClient((req) => {
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) {
        answers[id] = noulAns(id === "needs_clarify" ? 0.92 : 0.05);
      }
      return { model: "jev-latest", answers };
    });
    const result = await runPreflight({
      message: "fix it",
      asker: createJevAsker(client),
      requireScreen: true,
    });
    expect(result.skipGeneration).toBe(true);
    expect(result.directReply).toBe(CLARIFY_REPLY);
  });

  it("replaces an ungrounded draft with an abstain in one postflight ask", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) {
        answers[id] = noulAns(id.startsWith("g") || id === "needs_abstain" || id === "invented_numbers" ? 0.88 : 0.05);
      }
      return { model: "jev-latest", answers };
    });
    const result = await runPostflight({
      draft: "Acme posted $12.4 million in Q3 and the SEC filing confirms it.",
      userRequest: "What was Q3 revenue?",
      evidence: "The inbox has no filings attached.",
      asker: createJevAsker(client),
    });
    expect(calls).toBe(1);
    expect(result.abstain).toContain("don't have enough grounded evidence");
    expect(result.grounding?.decision.value).toBe("abstain");
  });

  it("withJev returns the abstain instead of the hallucinated draft", async () => {
    const client = createMockJevClient((req) => {
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) {
        answers[id] = noulAns(id === "needs_abstain" || id === "invented_numbers" ? 0.9 : 0.04);
      }
      return { model: "jev-latest", answers };
    });
    const plugin = withJev({
      asker: createJevAsker(client),
      screenInput: false,
      screenOutput: false,
      routeModel: false,
      autoMode: false,
      stopHook: false,
      compact: false,
      scoreQuality: false,
      decideCompletion: false,
      heedPolicy: false,
      verifyCitations: false,
    });
    const runCtx = ctx();
    const rewritten = await plugin.onAfterRun!(
      "The board voted 9-0 to acquire Northwind for $480 million yesterday.",
      runCtx
    );
    expect(rewritten).toContain("don't have enough grounded evidence");
    expect(runCtx.context.jevAbstained).toBe(true);
  });

  it("batches auto-mode and malware into one System One call", async () => {
    let calls = 0;
    const client = createMockJevClient((req) => {
      calls += 1;
      expect(req.questions.destructive).toBeDefined();
      expect(req.questions.mal_hostile).toBeDefined();
      const answers: Record<string, JevAnswer> = {};
      for (const id of Object.keys(req.questions)) answers[id] = noulAns(0.05);
      return { model: "jev-latest", answers };
    });
    const gate = await runToolGate({
      userRequest: "run the snippet",
      toolName: "sandbox_run",
      toolArguments: { code: "console.log(1)" },
      code: "console.log(1)",
      asker: createJevAsker(client),
    });
    expect(calls).toBe(1);
    expect(gate.asks).toBe(1);
    expect(gate.decisions.map((d) => d.node)).toEqual(["auto_mode", "is_malicious"]);
  });

  it("harvests tool output into an evidence card without calling Jev", () => {
    const card = harvestToolEvidence("file_read", { content: "Invoice 12 is unpaid." });
    expect(card).toContain("file_read");
    expect(card).toContain("Invoice 12 is unpaid.");
  });

  it("builds a deterministic abstain that includes evidence", () => {
    expect(abstainReply("Invoice 12 is unpaid.")).toContain("Invoice 12 is unpaid.");
  });
});
