import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../session-store";
import type { SessionStore } from "../session-store";
import { buildSessionIndex, searchSessionsFts } from "../session-search";
import type { SessionFtsHit } from "../session-search";
import type { MemorySessionHit } from "../../cli/memory-command";

function seededStore(): SessionStore {
  const store = new InMemorySessionStore();
  const a = store.create({ title: "Zephyr rollout planning" });
  store.append(a.id, { role: "user", content: "How is the Zephyr database migration going?" });
  store.append(a.id, { role: "assistant", content: "The Zephyr migration rollout is on track for Friday." });

  const b = store.create({ title: "Vacation schedule" });
  store.append(b.id, { role: "user", content: "Remind me about the vacation approvals for the team." });
  store.append(b.id, { role: "assistant", content: "Vacation requests are approved through the portal." });

  const c = store.create({ title: "Standup notes" });
  store.append(c.id, { role: "user", content: "Nothing new today, mostly routine updates." });
  return store;
}

describe("buildSessionIndex", () => {
  it("indexes every session exactly once", () => {
    const store = seededStore();
    const index = buildSessionIndex(store.all());
    expect(index.size()).toBe(3);
    for (const s of store.all()) expect(index.has(s.id)).toBe(true);
  });

  it("indexes the summary field when present", () => {
    const store = new InMemorySessionStore();
    const s = store.create({ title: "untagged" });
    store.get(s.id)!.summary = "quarterly kudzu remediation plan";
    const hits = searchSessionsFts(store, "kudzu remediation");
    expect(hits.map((h) => h.id)).toEqual([s.id]);
  });
});

describe("searchSessionsFts", () => {
  it("returns the genuinely relevant session first", () => {
    const store = seededStore();
    const hits = searchSessionsFts(store, "zephyr migration rollout");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe("Zephyr rollout planning");
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it("hit shape carries the session's own title/startedAt and a real snippet", () => {
    const store = seededStore();
    const [hit] = searchSessionsFts(store, "vacation approvals");
    const session = store.get(hit.id)!;
    expect(hit.title).toBe(session.title);
    expect(hit.startedAt).toBe(session.startedAt);
    // Snippet text is the FTS engine's normalized (lowercased) field text.
    expect(hit.snippet.toLowerCase()).toContain("vacation");
  });

  it("empty store and empty/whitespace queries return []", () => {
    expect(searchSessionsFts(new InMemorySessionStore(), "anything")).toEqual([]);
    expect(searchSessionsFts(seededStore(), "")).toEqual([]);
    expect(searchSessionsFts(seededStore(), "   ")).toEqual([]);
  });

  it("respects the limit option", () => {
    const store = new InMemorySessionStore();
    for (let i = 0; i < 7; i++) {
      const s = store.create({ title: `meeting ${i}` });
      store.append(s.id, { role: "user", content: "we discussed the shared budget forecast" });
    }
    expect(searchSessionsFts(store, "budget forecast", { limit: 3 })).toHaveLength(3);
    expect(searchSessionsFts(store, "budget forecast").length).toBeLessThanOrEqual(10);
  });

  it("reflects sessions appended after a previous search (no stale cache)", () => {
    const store = seededStore();
    expect(searchSessionsFts(store, "xylophone rehearsal")).toEqual([]);
    const s = store.create({ title: "music" });
    store.append(s.id, { role: "user", content: "book the xylophone rehearsal room" });
    const hits = searchSessionsFts(store, "xylophone rehearsal");
    expect(hits.map((h) => h.id)).toEqual([s.id]);
  });

  it("is structurally assignable to the CLI's MemorySessionHit seam", () => {
    const hits: SessionFtsHit[] = searchSessionsFts(seededStore(), "zephyr");
    const cliHits: MemorySessionHit[] = hits; // compile-time structural check
    expect(cliHits.length).toBeGreaterThan(0);
  });
});
