import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { InMemorySessionStore, FileSessionStore, scoreSession } from "../memory/session-store";
import type { SessionRecord } from "../memory/session-store";

function session(partial: Partial<SessionRecord>): SessionRecord {
  return { id: "s", messages: [], tags: [], startedAt: 0, ...partial };
}

describe("scoreSession", () => {
  it("ranks by term overlap and returns the best snippet", () => {
    const s = session({
      title: "Deploy planning",
      messages: [
        { role: "user", content: "how do we roll back a bad deploy?", at: 0 },
        { role: "assistant", content: "use the blue-green switch", at: 1 },
      ],
    });
    const { score, snippet } = scoreSession(s, ["roll", "back", "deploy"]);
    expect(score).toBeGreaterThan(0);
    expect(snippet).toContain("roll back");
  });
});

describe("InMemorySessionStore", () => {
  it("creates, appends, ends, and searches sessions", () => {
    const store = new InMemorySessionStore();
    const s = store.create({ title: "Auth work", tags: ["proj"] });
    store.append(s.id, { role: "user", content: "we chose JWT with refresh tokens" });
    store.append(s.id, { role: "assistant", content: "noted the refresh rotation strategy" });
    store.end(s.id);
    expect(store.get(s.id)?.endedAt).toBeGreaterThan(0);

    const results = store.search("refresh token rotation");
    expect(results).toHaveLength(1);
    expect(results[0].session.id).toBe(s.id);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("summarizes a session via an injectable summarizer", async () => {
    const store = new InMemorySessionStore();
    const s = store.create();
    store.append(s.id, { role: "user", content: "long discussion about caching" });
    const summary = await store.summarize(s.id, async (t) => `SUMMARY(${t.length} chars)`);
    expect(summary).toContain("SUMMARY");
    // summary is searchable too
    expect(store.search("summary").length).toBe(1);
  });
});

describe("FileSessionStore", () => {
  it("persists sessions across instances", () => {
    const path = join(tmpdir(), `hades-sessions-${process.pid}-${Math.floor(performance.now())}.json`);
    try {
      const a = new FileSessionStore(path);
      const s = a.create({ title: "Kickoff" });
      a.append(s.id, { role: "user", content: "project uses Postgres and Redis" });
      const b = new FileSessionStore(path);
      expect(b.size()).toBe(1);
      expect(b.search("postgres")[0].session.title).toBe("Kickoff");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
