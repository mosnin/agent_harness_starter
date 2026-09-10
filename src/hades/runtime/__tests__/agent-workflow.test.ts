import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLoop } from "../../agent/loop";
import { workspaceTools } from "../tools";
import { ConversationalAgent } from "../../repl/agent";
import { FileSessionStore } from "../../memory/session-store";
import { resolveModel } from "../model";
import type { ModelClient, ChatRequest } from "../../models/client";

function client(reply: (req: ChatRequest, n: number) => string): ModelClient {
  let n = 0;
  return { async chat(req) { return { text: reply(req, n++), tokensIn: 10, tokensOut: 5, usd: 0.01, model: req.model, provider: "test" }; } };
}
describe("real agent workflow with deterministic model transport", () => {
  it("never forwards a cloud provider key to a local endpoint", async () => {
    let authorization: string | null = null;
    const selected = resolveModel({ HADES_PROVIDER: "local", HADES_BASE_URL: "http://127.0.0.1:1234/v1", HADES_MODEL: "test", OPENAI_API_KEY: "cloud-key-canary" }, {
      fetchImpl: (async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as typeof fetch,
    });
    await selected.client.chat({ model: selected.model, messages: [{ role: "user", content: "hello" }] });
    expect(authorization).toBeNull();
  });
  it("reads, edits and reads back a real file before answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-workflow-"));
    try {
      writeFileSync(join(dir, "source.txt"), "17");
      const c = client((req, n) => {
        if (n === 0) return 'TOOL: file_ops\nINPUT: {"op":"read","path":"source.txt"}';
        if (n === 1) { expect(req.messages.at(-1)?.content).toContain('17'); return 'TOOL: file_ops\nINPUT: {"op":"write","path":"answer.txt","content":"34"}'; }
        if (n === 2) return 'TOOL: file_ops\nINPUT: {"op":"read","path":"answer.txt"}';
        expect(req.messages.at(-1)?.content).toContain('34'); return 'ANSWER: Saved 34 to answer.txt.';
      });
      const result = await new AgentLoop(c, workspaceTools(dir), { model: "test" }).run("Double the number in source.txt into answer.txt");
      expect(readFileSync(join(dir, "answer.txt"), "utf8")).toBe("34");
      expect(result.toolCalls).toHaveLength(3); expect(result.usd).toBe(0.04);
      expect(result.hitStepLimit).toBe(false);
      expect((await workspaceTools(dir).run({ tool: "file_ops", input: '{"op":"read","path":"../outside"}' })).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("resumes history from disk in a new agent instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-session-workflow-"));
    try {
      const path = join(dir, "sessions.json");
      const first = new ConversationalAgent({ sessions: new FileSessionStore(path), brain: async () => "I saved answer.txt." });
      await first.handler("Save answer.txt", () => {}, new AbortController().signal);
      const resumed = new ConversationalAgent({ sessions: new FileSessionStore(path), sessionId: first.sessionId, brain: async (ctx) => {
        expect(ctx.history.map((m) => m.content)).toEqual(["Save answer.txt", "I saved answer.txt."]); return "answer.txt";
      } });
      expect(await resumed.handler("What file?", () => {}, new AbortController().signal)).toBe("answer.txt");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("stops before any side effect when cancelled and preserves spent usage on model failure", async () => {
    const abort = new AbortController(); abort.abort();
    const c = client(() => { throw new Error("must not call"); });
    expect((await new AgentLoop(c, workspaceTools(tmpdir()), { model: "test", signal: abort.signal }).run("task")).error).toBe("Run cancelled");
    const failing = client((_req, n) => { if (n) throw new Error("offline"); return "TOOL: calc\nINPUT: 2+2"; });
    const result = await new AgentLoop(failing, workspaceTools(tmpdir()), { model: "test" }).run("task");
    expect(result.usd).toBe(0.01); expect(result.error).toContain("offline"); expect(result.answer).not.toContain("TOOL:");
  });
  it("requires setup and isolates provider selection", () => {
    expect(() => resolveModel({})).toThrow("OPENAI_API_KEY");
    expect(() => resolveModel({ OPENAI_API_KEY: "test" }, { provider: "anthropic", model: "test" })).toThrow("ANTHROPIC_API_KEY");
    expect(resolveModel({ HADES_PROVIDER: "local", HADES_BASE_URL: "http://127.0.0.1:1234/v1", HADES_MODEL: "test" }).model).toBe("test");
  });
});
