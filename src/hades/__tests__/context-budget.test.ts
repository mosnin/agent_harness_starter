import { describe, expect, it } from "vitest";
import { ContextBudget, contextView } from "../agent/context-budget";
import { AgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
import type { ChatMessage, ModelClient } from "../models/client";

describe("agent context boundaries", () => {
  it("deduplicates only known observations, preserving user text and original evidence", () => {
    const output = "TOOL_RESULT: " + "retained output ".repeat(100);
    const messages: ChatMessage[] = [ { role: "user", content: output }, { role: "user", content: output }, { role: "user", content: output } ];
    const view = contextView(messages, new Set([1, 2]));
    expect(view[0].content).toBe(output);
    expect(view[1].content).toContain("message 3");
    expect(view[2].content).toBe(output);
    expect(messages[1].content).toBe(output);
  });
  it("retains measured usage and charges replacements without guessing removed token savings", () => {
    const budget = new ContextBudget(), messages: ChatMessage[] = [{ role: "user", content: "a".repeat(1000) }];
    budget.observe(messages, 250);
    expect(budget.estimate([...messages, { role: "assistant", content: "hi" }])).toBe(284);
    expect(budget.estimate([{ role: "user", content: "changed" }])).toBe(289);
    expect(budget.estimate([{ role: "user", content: "🙂" }])).toBe(286);
    expect(budget.estimate([])).toBe(250);
    budget.observe([{ role: "user", content: "changed" }], 4);
    expect(budget.estimate([{ role: "user", content: "changed" }])).toBe(4);
  });
  it("stops before dispatch when the serving budget cannot hold the request", async () => {
    let calls = 0;
    const client: ModelClient = { chat: async () => { calls++; throw new Error("must not call"); } };
    const result = await new AgentLoop(client, new ToolRegistry(), { model: "test", contextWindow: async () => 1024 }).run("Preserve this full task");
    expect(calls).toBe(0); expect(result.error).toContain("Context budget");
    expect(result.transcript.at(-1)?.content).toBe("Preserve this full task");
    expect(result.hitStepLimit).toBe(false);
  });
  it("never dispatches a length-limited tool call even if its partial text parses", async () => {
    let ran = false;
    const tools = new ToolRegistry(); tools.register({ name: "write", description: "write", run: () => { ran = true; return { ok: true, output: "written" }; } });
    const client: ModelClient = { chat: async () => ({ text: "TOOL: write\nINPUT: partial", finishReason: "length", tokensIn: 1, tokensOut: 50, usd: 0, model: "test", provider: "fixture" }) };
    const result = await new AgentLoop(client, tools, { model: "test" }).run("Write a complete file");
    expect(ran).toBe(false); expect(result.error).toContain("cut off"); expect(result.tokensOut).toBe(50);
  });
});
