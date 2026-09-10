import { describe, it, expect } from "vitest";
import { NudgeEngine, evaluateNudges } from "../learning/nudge";
import type { SessionRecord } from "../memory/session-store";

function session(turns: number, opts: { summary?: string; lastAt?: number } = {}): SessionRecord {
  return {
    id: "s1",
    messages: Array.from({ length: turns }, (_v, i) => ({ role: "user" as const, content: `m${i}`, at: opts.lastAt ?? i })),
    tags: [],
    startedAt: 0,
    summary: opts.summary,
  };
}

const cfg = { minTurnsSinceCurated: 8, summarizeIdleMs: 600_000, minTurnsToSummarize: 4 };

describe("evaluateNudges", () => {
  it("nudges to persist after enough new turns", () => {
    const n = evaluateNudges(session(10), { lastCuratedTurnCount: 0 }, 1000, cfg);
    expect(n.some((x) => x.type === "persist")).toBe(true);
  });

  it("does not persist-nudge when recently curated", () => {
    const n = evaluateNudges(session(10), { lastCuratedTurnCount: 9 }, 1000, cfg);
    expect(n.some((x) => x.type === "persist")).toBe(false);
  });

  it("nudges to summarize an idle, unsummarized session", () => {
    const s = session(6, { lastAt: 0 });
    const n = evaluateNudges(s, { lastCuratedTurnCount: 6 }, 700_000, cfg); // idle > 600s
    expect(n.some((x) => x.type === "summarize")).toBe(true);
  });

  it("does not summarize-nudge an already-summarized session", () => {
    const s = session(6, { lastAt: 0, summary: "done" });
    const n = evaluateNudges(s, { lastCuratedTurnCount: 6 }, 700_000, cfg);
    expect(n.some((x) => x.type === "summarize")).toBe(false);
  });
});

describe("NudgeEngine", () => {
  it("emits nudges and stops persist-nudging after markCurated", () => {
    let t = 1000;
    const engine = new NudgeEngine({ minTurnsSinceCurated: 8 }, () => t);
    const got: string[] = [];
    engine.onNudge((n) => got.push(n.type));

    const s = session(10);
    expect(engine.check(s).some((n) => n.type === "persist")).toBe(true);
    engine.markCurated(s);
    expect(engine.check(s).some((n) => n.type === "persist")).toBe(false);
    expect(got).toContain("persist");
  });
});
