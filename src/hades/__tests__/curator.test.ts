import { describe, it, expect } from "vitest";
import { MemoryCurator } from "../learning/curator";
import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";

function makeSession(lines: Array<[string, string]>) {
  const store = new InMemorySessionStore();
  const s = store.create();
  for (const [role, content] of lines) store.append(s.id, { role: role as "user", content });
  return store.get(s.id)!;
}

describe("MemoryCurator — offline extraction", () => {
  it("extracts salient facts from a session and persists them", async () => {
    const mem = new InMemoryMemoryStore();
    const curator = new MemoryCurator(mem);
    const session = makeSession([
      ["user", "My name is Sam and I prefer TypeScript over Python."],
      ["assistant", "Got it."],
      ["user", "We decided to deploy on Fridays."],
      ["user", "The weather is nice today."], // not salient → ignored
    ]);

    const added = await curator.curateSession(session);
    const facts = added.map((r) => r.fact.toLowerCase());
    expect(facts.some((f) => f.includes("sam"))).toBe(true);
    expect(facts.some((f) => f.includes("typescript"))).toBe(true);
    expect(facts.some((f) => f.includes("fridays"))).toBe(true);
    expect(added.every((r) => r.tags.includes("curated"))).toBe(true);
    expect(mem.size()).toBe(added.length);
  });

  it("dedupes against existing memories", async () => {
    const mem = new InMemoryMemoryStore();
    mem.add({ fact: "The user prefers TypeScript over Python", salience: 0.8 });
    const curator = new MemoryCurator(mem);
    const session = makeSession([["user", "I prefer TypeScript over Python"]]);
    const added = await curator.curateSession(session);
    expect(added).toHaveLength(0); // near-duplicate not re-added
  });

  it("uses an injected LLM extractor when provided", async () => {
    const mem = new InMemoryMemoryStore();
    const curator = new MemoryCurator(mem, {
      extractor: async () => [{ fact: "The user manages a fleet of GPUs", salience: 0.9, tags: ["infra"] }],
    });
    const session = makeSession([["user", "anything"]]);
    const added = await curator.curateSession(session);
    expect(added).toHaveLength(1);
    expect(added[0].fact).toContain("GPUs");
    expect(added[0].tags).toContain("infra");
  });
});
