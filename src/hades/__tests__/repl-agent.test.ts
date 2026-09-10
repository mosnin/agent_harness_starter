import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { ConversationalAgent } from "../repl/agent";
import type { ConversationBrain, ConversationTurnContext } from "../repl/agent";
import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";
import { GuardedMemoryStore } from "../memory/guard";
import { appendMemoryFact } from "../memory/context-files";
import { ModelRegistry } from "../models/registry";
import { InMemoryModelSelection } from "../models/selection";
import { ModelCommand } from "../models/command";
import type { ReplIO } from "../repl/core";

function fakeIO(): ReplIO & { chunks: string[]; lines: string[] } {
  const chunks: string[] = [];
  const lines: string[] = [];
  return { chunks, lines, write: (c) => chunks.push(c), writeLine: (l) => lines.push(l) };
}

// Brain that echoes how much context it received (and the top memory).
const contextBrain: ConversationBrain = async (ctx, stream) => {
  const top = ctx.memories[0]?.fact ?? "none";
  const reply = `mem=${ctx.memories.length} hist=${ctx.history.length} top=[${top}] :: ${ctx.input}`;
  stream(reply);
  return reply;
};

describe("ConversationalAgent", () => {
  it("injects relevant memories and persists the conversation", async () => {
    const memory = new InMemoryMemoryStore();
    memory.add({ fact: "the user prefers TypeScript", tags: ["pref"] });
    memory.add({ fact: "the user lives in Berlin" });
    const sessions = new InMemorySessionStore();

    const agent = new ConversationalAgent({ brain: contextBrain, memory, sessions });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("what language should I use for TypeScript work?");
    // The TypeScript memory should rank first for this query.
    expect(io.chunks.join("")).toContain("top=[the user prefers TypeScript]");

    // Both user + assistant turns persisted.
    const session = sessions.get(agent.sessionId)!;
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0].content).toContain("TypeScript work");
  });

  it("passes prior history to the brain on later turns", async () => {
    const sessions = new InMemorySessionStore();
    const agent = new ConversationalAgent({ brain: contextBrain, sessions });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("first");
    io.chunks.length = 0;
    await repl.feedLine("second");
    // History now holds the first user+assistant pair.
    expect(io.chunks.join("")).toContain("hist=2");
  });

  it("/remember persists a memory that later turns can retrieve", async () => {
    const memory = new InMemoryMemoryStore();
    const agent = new ConversationalAgent({ brain: contextBrain, memory });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("/remember I use pnpm not npm");
    expect(io.lines.join("\n")).toContain("Remembered: I use pnpm not npm");
    expect(memory.search("pnpm").length).toBe(1);
  });

  it("/recall searches memory", async () => {
    const memory = new InMemoryMemoryStore();
    memory.add({ fact: "deploys happen on Fridays" });
    const agent = new ConversationalAgent({ brain: contextBrain, memory });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("/recall deploy");
    expect(io.lines.join("\n")).toContain("• deploys happen on Fridays");
  });

  it("/model switches the active model through ModelCommand", async () => {
    const registry = new ModelRegistry()
      .register({ id: "opus", provider: "anthropic", displayName: "Opus" }, { default: true })
      .register({ id: "haiku", provider: "anthropic", displayName: "Haiku" });
    const selection = new InMemoryModelSelection();
    const models = new ModelCommand(registry, selection);
    const agent = new ConversationalAgent({ brain: contextBrain, models });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("/model use haiku");
    expect(selection.get()).toBe("haiku");
    expect(io.lines.join("\n")).toContain("Switched to haiku");
  });

  it("/history shows the conversation and /help lists commands", async () => {
    const sessions = new InMemorySessionStore();
    const agent = new ConversationalAgent({ brain: contextBrain, sessions });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("hello");
    io.lines.length = 0;
    await repl.feedLine("/history");
    expect(io.lines.join("\n")).toContain("user: hello");

    io.lines.length = 0;
    await repl.feedLine("/help");
    const help = io.lines.join("\n");
    expect(help).toContain("/remember");
    expect(help).toContain("/recall");
  });

  it("/remember through the real STYX guard reports quarantine honestly", async () => {
    const inner = new InMemoryMemoryStore();
    inner.add({ fact: "the user prefers tabs", salience: 0.9 });
    const memory = new GuardedMemoryStore(inner);
    const agent = new ConversationalAgent({ brain: contextBrain, memory });
    const io = fakeIO();
    const repl = agent.repl(io);

    await repl.feedLine("/remember the user does not prefer tabs");
    const out = io.lines.join("\n");
    expect(out).toContain("Quarantined");
    expect(out).not.toContain("Remembered");
    // The contradicting fact never landed in durable memory.
    expect(inner.all().map((r) => r.fact)).toEqual(["the user prefers tabs"]);

    io.lines.length = 0;
    await repl.feedLine("/remember the user enjoys code review");
    expect(io.lines.join("\n")).toContain("Remembered: the user enjoys code review");
    expect(inner.all().map((r) => r.fact)).toContain("the user enjoys code review");
  });
});

describe("ConversationalAgent context files (MEMORY.md / USER.md)", () => {
  const tmpDirs: string[] = [];
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hades-repl-ctx-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function capturingBrain(): { brain: ConversationBrain; turns: ConversationTurnContext[] } {
    const turns: ConversationTurnContext[] = [];
    const brain: ConversationBrain = async (ctx, stream) => {
      turns.push(ctx);
      stream("ok");
      return "ok";
    };
    return { brain, turns };
  }

  it("loads MEMORY.md/USER.md from disk and passes the fenced prompt to the brain", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "MEMORY.md"), "## Facts\n\n- the deploy day is Friday\n");
    writeFileSync(join(dataDir, "USER.md"), "# Profile\n\nPrefers terse answers.\n");

    const { brain, turns } = capturingBrain();
    const agent = new ConversationalAgent({ brain, contextFiles: { dataDir } });
    await agent.handler("hello", () => {}, new AbortController().signal);

    const prompt = turns[0].contextPrompt!;
    expect(prompt).toContain('<context-file kind="user"');
    expect(prompt).toContain('<context-file kind="memory"');
    expect(prompt).toContain("the deploy day is Friday");
    expect(prompt).toContain("Prefers terse answers.");
    // USER.md renders before MEMORY.md (the contract's fixed order).
    expect(prompt.indexOf('kind="user"')).toBeLessThan(prompt.indexOf('kind="memory"'));
  });

  it("projectDir wins over dataDir for the same file kind", async () => {
    const dataDir = tempDir();
    const projectDir = tempDir();
    writeFileSync(join(dataDir, "MEMORY.md"), "- global fact\n");
    writeFileSync(join(projectDir, "MEMORY.md"), "- project fact\n");

    const { brain, turns } = capturingBrain();
    const agent = new ConversationalAgent({ brain, contextFiles: { dataDir, projectDir } });
    await agent.handler("hello", () => {}, new AbortController().signal);

    expect(turns[0].contextPrompt).toContain("project fact");
    expect(turns[0].contextPrompt).not.toContain("global fact");
  });

  it("no context files configured, or none on disk -> contextPrompt is undefined", async () => {
    const { brain, turns } = capturingBrain();
    const agent = new ConversationalAgent({ brain });
    await agent.handler("hello", () => {}, new AbortController().signal);
    expect(turns[0].contextPrompt).toBeUndefined();

    const emptyDir = tempDir();
    mkdirSync(join(emptyDir, "nested"), { recursive: true });
    const agent2 = new ConversationalAgent({ brain, contextFiles: { dataDir: emptyDir } });
    await agent2.handler("again", () => {}, new AbortController().signal);
    expect(turns[1].contextPrompt).toBeUndefined();
  });

  it("re-reads per turn: an appendMemoryFact write-back shows up on the NEXT turn", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "MEMORY.md"), "## Facts\n\n- original fact\n");

    const { brain, turns } = capturingBrain();
    const agent = new ConversationalAgent({ brain, contextFiles: { dataDir } });
    await agent.handler("turn one", () => {}, new AbortController().signal);
    expect(turns[0].contextPrompt).not.toContain("freshly appended");

    const res = appendMemoryFact({ dataDir, fact: "freshly appended fact", source: "test" });
    expect(res.appended).toBe(true);

    await agent.handler("turn two", () => {}, new AbortController().signal);
    expect(turns[1].contextPrompt).toContain("freshly appended fact");
  });
});
