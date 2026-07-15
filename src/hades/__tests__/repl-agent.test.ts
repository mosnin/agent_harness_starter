import { describe, it, expect } from "vitest";
import { ConversationalAgent } from "../repl/agent";
import type { ConversationBrain } from "../repl/agent";
import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";
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
});
