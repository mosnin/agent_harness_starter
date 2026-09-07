import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileContextArchive } from "../memory/context-archive";
import { ArchivedContext } from "../agent/context-budget";
import { AgentLoop } from "../agent/loop";
import { ToolRegistry } from "../agent/tools";
import type { ChatMessage, ModelClient } from "../models/client";
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "hades-context-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("durable context recall", () => {
  it("survives reopening, paginates exact content and detects corruption", () => {
    const path = directory(), archive = new FileContextArchive(path);
    const message: ChatMessage = { role: "user", content: "🙂 result\n".repeat(900) };
    const reference = archive.put(message);
    expect(archive.put(message)).toBe(reference);
    const reopened = new FileContextArchive(path);
    let body = "", offset = 0;
    for (;;) { const page = reopened.read(reference, offset, 87); body += page.content; if (page.nextOffset === undefined) break; offset = page.nextOffset; }
    expect(JSON.parse(body)).toEqual(message);
    expect(() => reopened.read("../secret", 0, 100)).toThrow();
    expect(() => reopened.read(reference, -1, 100)).toThrow();
    expect(() => reopened.read(reference, 0, 12001)).toThrow();
    writeFileSync(join(path, reference + ".json"), "changed");
    expect(() => reopened.read(reference, 0, 100)).toThrow(/integrity/);
  });

  it("preserves instructions, failures and recent pairs while replacing older settled evidence", () => {
    const archive = new FileContextArchive(directory()), context = new ArchivedContext(archive);
    const messages: ChatMessage[] = [{ role: "system", content: "Keep the boundary" }, { role: "user", content: "TOOL_RESULT: User requirements must stay exact" }];
    const settled = [];
    for (let i = 0; i < 5; i++) {
      const callIndex = messages.length;
      messages.push({ role: "assistant", content: "TOOL: file_ops\nINPUT: " + "x".repeat(3000) });
      messages.push({ role: "user", content: i === 1 ? "TOOL_ERROR: Permission denied" : "TOOL_RESULT: " + "data".repeat(1000) });
      settled.push({ callIndex, resultIndex: callIndex + 1, tool: "file_ops", ok: i !== 1 });
    }
    const original = structuredClone(messages), view = context.view(messages, settled);
    expect(messages).toEqual(original);
    expect(view.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(view.slice(4)).toEqual(messages.slice(4));
    expect(view[2].content).toContain("do not repeat");
    const reference = view[3].content.match(/[a-f0-9]{64}/)![0];
    expect(JSON.parse(JSON.parse(context.read(JSON.stringify({ reference }))).content)).toEqual(messages[3]);
    const unrelated = archive.put({ role: "user", content: "another scope" });
    expect(() => context.read(JSON.stringify({ reference: unrelated }))).toThrow(/Unknown/);
  });

  it("fails closed when evidence cannot be persisted", () => {
    const context = new ArchivedContext({ put: () => { throw new Error("disk full"); }, read: () => { throw new Error("unused"); } });
    const messages: ChatMessage[] = [{ role: "assistant", content: "x".repeat(3000) }, { role: "user", content: "result" }];
    const pair = { callIndex: 0, resultIndex: 1, tool: "write", ok: true };
    expect(() => context.view(messages, [pair, pair, pair, pair])).toThrow("disk full");
    expect(messages[0].content.length).toBe(3000);
  });

  it("recalls archived output in the agent loop without replaying the original tool", async () => {
    let executed = 0, modelCalls = 0;
    const tools = new ToolRegistry();
    tools.register({ name: "read", description: "Read source", run: () => ({ ok: true, output: "original data ".repeat(400) + ++executed }) });
    const client: ModelClient = { chat: async ({ messages }) => {
      modelCalls++;
      let text = "TOOL: read\nINPUT: source";
      if (modelCalls === 5) {
        const reference = messages.find(m => m.content.startsWith("TOOL_RESULT: [Archived"))!.content.match(/[a-f0-9]{64}/)![0];
        text = `TOOL: context_read\nINPUT: ${JSON.stringify({ reference })}`;
      }
      if (modelCalls === 6) { expect(messages.at(-1)!.content).toContain("original data"); text = "ANSWER: Recalled"; }
      return { text, tokensIn: 100, tokensOut: 100, usd: 0, model: "fixture", provider: "fixture" };
    } };
    const result = await new AgentLoop(client, tools, { model: "fixture", maxSteps: 8, contextWindow: async () => 10000, maxOutputTokens: 512, contextArchive: new FileContextArchive(directory()) }).run("Inspect the source");
    expect(result.answer).toBe("Recalled"); expect(executed).toBe(4);
    expect(result.transcript.filter(m => m.content.startsWith("TOOL_RESULT: original data"))).toHaveLength(4);
    expect(result.toolCalls.at(-1)?.call.tool).toBe("context_read");
  });
});

it("passes tool screenshots to the model and retains only the latest in the working archive view", async () => {
  const seen: ChatMessage[][] = [];
  const client: ModelClient = { chat: async request => {
    seen.push(structuredClone(request.messages));
    return {text:seen.length <= 3 ? 'TOOL: computer_observe\nINPUT: {}' : 'ANSWER: Done',tokensIn:100,tokensOut:10,usd:0,model:"vision",provider:"fixture"};
  }};
  let observations = 0; const tools = new ToolRegistry();
  tools.register({name:"computer_observe",description:"screenshot",run:() => ({ok:true,output:"Small AX tree",images:[`data:image/png;base64,image-${++observations}`]})});
  const result = await new AgentLoop(client,tools,{model:"vision",contextArchive:new FileContextArchive(directory())}).run("Inspect the window");
  expect(result.answer).toBe("Done");
  expect(seen.at(-1)!.flatMap(m => m.images ?? [])).toEqual(["data:image/png;base64,image-3"]);
  expect(result.transcript.flatMap(m => m.images ?? [])).toHaveLength(3);
  expect(seen.at(-1)!.filter(m => m.content.includes("Earlier screenshot omitted"))).toHaveLength(2);
});
