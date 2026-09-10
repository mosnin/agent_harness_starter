/* ------------------------------------------------------------------ *
 * memory-command.test.ts
 *
 * REAL-VS-MOCK POLICY: `memory-command.ts`'s job is argv parsing, dispatch,
 * and formatting over the structural `MemoryCommandDeps` seam — it never
 * imports the real FTS engine or memory guard (that's central integration's
 * job; the real engines are proven separately by their own teams' tests and
 * by recall-bench.test.ts). So these tests use real `InMemoryMemoryStore` /
 * `InMemorySessionStore` instances (exercising real add/search/get behavior)
 * plus tiny hand-written `searchSessions`/`guard`/`summarize` fakes that
 * honor the structural contracts declared in `MemoryCommandDeps`. Mocking
 * the seam here is the honest choice — it is exactly what this module is
 * responsible for.
 * ------------------------------------------------------------------ */
import { describe, expect, it, vi } from "vitest";
import { runMemoryCommand } from "../memory-command";
import type { MemoryCommandDeps, MemoryFlagRecord, MemorySessionHit } from "../memory-command";
import { InMemoryMemoryStore } from "../../memory/store";
import { InMemorySessionStore } from "../../memory/session-store";

const FIXED_NOW = Date.UTC(2026, 6, 19, 12, 0, 0); // 2026-07-19T12:00:00Z

function searchSessionsOver(store: InMemorySessionStore): MemoryCommandDeps["searchSessions"] {
  return (query, opts) =>
    store.search(query, opts).map((r): MemorySessionHit => ({
      id: r.session.id,
      score: r.score,
      snippet: r.snippet,
      title: r.session.title,
      startedAt: r.session.startedAt,
    }));
}

function makeDeps(overrides: Partial<MemoryCommandDeps> = {}): {
  deps: MemoryCommandDeps;
  memory: InMemoryMemoryStore;
  sessions: InMemorySessionStore;
} {
  const memory = new InMemoryMemoryStore();
  const sessions = new InMemorySessionStore();
  const deps: MemoryCommandDeps = {
    memory,
    sessions,
    searchSessions: searchSessionsOver(sessions),
    now: () => FIXED_NOW,
    ...overrides,
  };
  return { deps, memory, sessions };
}

function makeGuard(flags: MemoryFlagRecord[], resolveResult = true) {
  const resolve = vi.fn((_id: string, _r: string) => resolveResult);
  return { flags: () => flags, resolve };
}

// ===========================================================================
// help / no-args / unknown subcommand
// ===========================================================================

describe("help / no-args / unknown subcommand", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("argv %j -> usage, exit 0", async (argv) => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, argv);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Usage: hades memory <command>");
  });

  it("unknown subcommand -> code 1, names the subcommand, points to help", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["frobnicate"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Unknown memory command: frobnicate");
    expect(res.lines.join("\n")).toContain("Run `hades memory help` for usage.");
  });
});

// ===========================================================================
// search
// ===========================================================================

describe("memory search", () => {
  it("no query -> usage, code 1", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["search"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Usage: hades memory search <query>");
  });

  it("empty stores -> honest 'no matching' lines, code 0", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["search", "anything"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("(no matching sessions)");
    expect(res.lines.join("\n")).toContain("(no matching facts)");
  });

  it("finds a matching session and a matching fact, clearly separated", async () => {
    const { deps, memory, sessions } = makeDeps();
    const s = sessions.create({ title: "Planning the launch" });
    sessions.append(s.id, { role: "user", content: "we need a rollout plan for the launch" });
    memory.add({ fact: "the launch date is locked", salience: 0.9 });

    const res = await runMemoryCommand(deps, ["search", "launch"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    const sessionsHeaderIdx = res.lines.findIndex((l) => l.includes("Sessions matching"));
    const factsHeaderIdx = res.lines.findIndex((l) => l.includes("Facts matching"));
    expect(sessionsHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(factsHeaderIdx).toBeGreaterThan(sessionsHeaderIdx);
    expect(text).toContain(s.id);
    expect(text).toContain("the launch date is locked");
  });

  it("--json produces parseable output with a stable key set", async () => {
    const { deps, memory, sessions } = makeDeps();
    const s = sessions.create({ title: "Budget review" });
    sessions.append(s.id, { role: "user", content: "budget numbers for Q3" });
    memory.add({ fact: "budget approved for Q3", salience: 0.7 });

    const res = await runMemoryCommand(deps, ["search", "budget", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(parsed.query).toBe("budget");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(Array.isArray(parsed.facts)).toBe(true);
    expect(parsed.sessions.length).toBeGreaterThan(0);
    expect(parsed.facts.length).toBeGreaterThan(0);
    expect(Object.keys(parsed.sessions[0]).sort()).toEqual(["id", "score", "snippet", "startedAt", "title"].sort());
    expect(Object.keys(parsed.facts[0]).sort()).toEqual(["createdAt", "fact", "id", "salience", "score", "source", "tags"].sort());
    // startedAt/createdAt are ISO strings, not raw epoch numbers.
    expect(() => new Date(parsed.sessions[0].startedAt).toISOString()).not.toThrow();
    expect(parsed.sessions[0].startedAt).toBe(new Date(parsed.sessions[0].startedAt).toISOString());
  });

  it("--limit caps both session and fact hits", async () => {
    const { deps, memory, sessions } = makeDeps();
    for (let i = 0; i < 5; i++) {
      const s = sessions.create({ title: `Retro ${i}` });
      sessions.append(s.id, { role: "user", content: "widget retro notes widget widget" });
      memory.add({ fact: `widget fact number ${i}`, salience: 0.5 });
    }
    const res = await runMemoryCommand(deps, ["search", "widget", "--limit", "2", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(parsed.sessions.length).toBeLessThanOrEqual(2);
    expect(parsed.facts.length).toBeLessThanOrEqual(2);
  });

  it.each([
    ["--limit", "0"],
    ["--limit", "-1"],
    ["--limit", "abc"],
    ["--limit", "1.5"],
  ])("rejects a malformed %s %s value honestly (code 1, names the value, no NaN)", async (flag, value) => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["search", "foo", flag, value]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain(`Invalid --limit value: ${value}`);
    expect(res.lines.join("\n")).not.toContain("NaN");
  });

  it("rejects --limit with a missing value", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["search", "foo", "--limit"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("--limit requires a value");
  });

  it("parses a multi-word query with flags interspersed", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "Alpha Beta" });
    sessions.append(s.id, { role: "user", content: "alpha beta gamma" });
    const res = await runMemoryCommand(deps, ["search", "alpha", "--json", "beta"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(parsed.query).toBe("alpha beta");
  });
});

// ===========================================================================
// timeline
// ===========================================================================

describe("memory timeline", () => {
  it("empty store -> honest 'no sessions recorded' line, code 0", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["timeline"]);
    expect(res.code).toBe(0);
    expect(res.lines).toEqual(["No sessions recorded."]);
  });

  it("lists sessions chronologically with title/date/message-count in an aligned table", async () => {
    const { deps, sessions } = makeDeps();
    const s1 = sessions.create({ title: "First" });
    sessions.append(s1.id, { role: "user", content: "hi", at: FIXED_NOW - 3 * 86_400_000 });
    const s2 = sessions.create({ title: "Second" });
    sessions.append(s2.id, { role: "user", content: "hi", at: FIXED_NOW - 1 * 86_400_000 });
    sessions.append(s2.id, { role: "assistant", content: "hi back", at: FIXED_NOW - 1 * 86_400_000 });
    // Force deterministic startedAt ordering independent of wall-clock creation order.
    (s1 as { startedAt: number }).startedAt = FIXED_NOW - 5 * 86_400_000;
    (s2 as { startedAt: number }).startedAt = FIXED_NOW - 2 * 86_400_000;

    const res = await runMemoryCommand(deps, ["timeline"]);
    expect(res.code).toBe(0);
    const header = res.lines[0];
    expect(header).toMatch(/STARTED/);
    expect(header).toMatch(/MESSAGES/);
    expect(header).toMatch(/ID/);
    expect(header).toMatch(/TITLE/);
    const firstIdx = res.lines.findIndex((l) => l.includes(s1.id));
    const secondIdx = res.lines.findIndex((l) => l.includes(s2.id));
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx); // chronological: s1 started earlier
    expect(res.lines[secondIdx]).toContain("2"); // message count
  });

  it("--json produces a parseable array with a stable key set", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "Only" });
    sessions.append(s.id, { role: "user", content: "hi" });
    const res = await runMemoryCommand(deps, ["timeline", "--json"]);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]).sort()).toEqual(["endedAt", "id", "messageCount", "startedAt", "title"].sort());
    expect(parsed[0].startedAt).toBe(new Date(parsed[0].startedAt).toISOString());
  });

  it("--since '7d' filters out sessions older than 7 days from deps.now()", async () => {
    const { deps, sessions } = makeDeps();
    const old = sessions.create({ title: "Old" });
    sessions.append(old.id, { role: "user", content: "hi" });
    (old as { startedAt: number }).startedAt = FIXED_NOW - 10 * 86_400_000;
    const recent = sessions.create({ title: "Recent" });
    sessions.append(recent.id, { role: "user", content: "hi" });
    (recent as { startedAt: number }).startedAt = FIXED_NOW - 1 * 86_400_000;

    const res = await runMemoryCommand(deps, ["timeline", "--since", "7d", "--json"]);
    const parsed = JSON.parse(res.lines.join("\n"));
    const ids = parsed.map((p: { id: string }) => p.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it("--until '24h' filters out sessions newer than 24 hours ago", async () => {
    const { deps, sessions } = makeDeps();
    const old = sessions.create({ title: "Old" });
    sessions.append(old.id, { role: "user", content: "hi" });
    (old as { startedAt: number }).startedAt = FIXED_NOW - 10 * 86_400_000;
    const recent = sessions.create({ title: "Recent" });
    sessions.append(recent.id, { role: "user", content: "hi" });
    (recent as { startedAt: number }).startedAt = FIXED_NOW - 1 * 60 * 60 * 1000;

    const res = await runMemoryCommand(deps, ["timeline", "--until", "24h", "--json"]);
    const parsed = JSON.parse(res.lines.join("\n"));
    const ids = parsed.map((p: { id: string }) => p.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(recent.id);
  });

  it("--since accepts an ISO date", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "S" });
    sessions.append(s.id, { role: "user", content: "hi" });
    (s as { startedAt: number }).startedAt = Date.UTC(2026, 5, 1);
    const res = await runMemoryCommand(deps, ["timeline", "--since", "2026-01-01T00:00:00Z", "--json"]);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(parsed.map((p: { id: string }) => p.id)).toContain(s.id);
  });

  it.each([
    ["--since", "not-a-date"],
    ["--until", "not-a-date"],
    ["--since", "7x"],
    ["--since", "sevendays"],
  ])("rejects a malformed %s value honestly (code 1, no silent NaN)", async (flag, value) => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["timeline", flag, value]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain(`Invalid ${flag} value: ${value}`);
    expect(res.lines.join("\n")).not.toContain("NaN");
  });

  it("rejects --since with a missing value", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["timeline", "--since"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("--since requires a value");
  });

  it("rejects an unexpected positional argument", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["timeline", "bogus"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Unexpected argument: bogus");
  });
});

// ===========================================================================
// show
// ===========================================================================

describe("memory show", () => {
  it("missing id -> usage, code 1", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["show"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades memory show <session-id>");
  });

  it("unknown id -> code 1, names the id", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["show", "nope-123"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("No such session: nope-123");
  });

  it("prints the full role-prefixed transcript for a known session", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "Debug session", tags: ["debug"] });
    sessions.append(s.id, { role: "user", content: "why is it slow" });
    sessions.append(s.id, { role: "assistant", content: "checking the query plan" });
    const res = await runMemoryCommand(deps, ["show", s.id]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain(s.id);
    expect(text).toContain("Debug session");
    expect(text).toContain("debug");
    expect(text).toMatch(/user: why is it slow/);
    expect(text).toMatch(/assistant: checking the query plan/);
  });

  it("a session with no messages gets an honest 'no messages recorded' line", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "Empty" });
    const res = await runMemoryCommand(deps, ["show", s.id]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("(no messages recorded)");
  });
});

// ===========================================================================
// summarize
// ===========================================================================

describe("memory summarize", () => {
  it("missing id -> usage, code 1", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["summarize"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades memory summarize <session-id>");
  });

  it("deps.summarize absent -> honest error, code 1 (never fakes an LLM result)", async () => {
    const { deps, sessions } = makeDeps();
    const s = sessions.create({ title: "S" });
    const res = await runMemoryCommand(deps, ["summarize", s.id]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Summarization is not configured");
  });

  it("unknown session id -> code 1, names the id, even with summarize configured", async () => {
    const { deps } = makeDeps({ summarize: async () => ({ summary: "x", mode: "llm" }) });
    const res = await runMemoryCommand(deps, ["summarize", "missing-id"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("No such session: missing-id");
  });

  it("prints 'mode: llm' and the summary when the summarizer used a real LLM", async () => {
    const { deps, sessions } = makeDeps({ summarize: async () => ({ summary: "Decided to ship Friday.", mode: "llm" }) });
    const s = sessions.create({ title: "S" });
    const res = await runMemoryCommand(deps, ["summarize", s.id]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("mode: llm");
    expect(res.lines.join("\n")).toContain("Decided to ship Friday.");
  });

  it("prints 'mode: extractive' — never dressed up as llm output", async () => {
    const { deps, sessions } = makeDeps({ summarize: async () => ({ summary: "extractive summary text", mode: "extractive" }) });
    const s = sessions.create({ title: "S" });
    const res = await runMemoryCommand(deps, ["summarize", s.id]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("mode: extractive");
  });

  it("an empty summary string prints an honest placeholder, not a blank line masquerading as content", async () => {
    const { deps, sessions } = makeDeps({ summarize: async () => ({ summary: "", mode: "extractive" }) });
    const s = sessions.create({ title: "S" });
    const res = await runMemoryCommand(deps, ["summarize", s.id]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("(empty summary)");
  });

  it("a throwing summarizer surfaces its error message honestly, code 1", async () => {
    const { deps, sessions } = makeDeps({
      summarize: async () => {
        throw new Error("llm backend unreachable");
      },
    });
    const s = sessions.create({ title: "S" });
    const res = await runMemoryCommand(deps, ["summarize", s.id]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("llm backend unreachable");
  });
});

// ===========================================================================
// flags
// ===========================================================================

describe("memory flags", () => {
  it("deps.guard absent -> honest error, code 1", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["flags"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("memory guard is not configured");
  });

  it("flags / flags list with no pending flags -> honest 'nothing recorded' line", async () => {
    const { deps } = makeDeps({ guard: makeGuard([]) });
    const a = await runMemoryCommand(deps, ["flags"]);
    expect(a.code).toBe(0);
    expect(a.lines).toEqual(["No pending memory flags."]);
    const b = await runMemoryCommand(deps, ["flags", "list"]);
    expect(b.lines).toEqual(["No pending memory flags."]);
  });

  it("lists pending flags in an aligned table", async () => {
    const flags: MemoryFlagRecord[] = [
      { id: "f1", verdict: { reasons: ["duplicate of an existing fact"] }, candidate: { fact: "user prefers dark mode" }, at: FIXED_NOW - 1000 },
      { id: "f2", verdict: { reasons: ["contradicts prior fact", "low confidence"] }, candidate: { fact: "user lives in Berlin" }, at: FIXED_NOW - 2000, resolution: "accept-new" },
    ];
    const { deps } = makeDeps({ guard: makeGuard(flags) });
    const res = await runMemoryCommand(deps, ["flags", "list"]);
    expect(res.code).toBe(0);
    const header = res.lines[0];
    expect(header).toMatch(/ID/);
    expect(header).toMatch(/FACT/);
    expect(header).toMatch(/REASONS/);
    expect(header).toMatch(/RESOLUTION/);
    const text = res.lines.join("\n");
    expect(text).toContain("f1");
    expect(text).toContain("f2");
    expect(text).toContain("accept-new");
    expect(text).toContain("(pending)");
  });

  it("flags list --json is parseable with a stable key set", async () => {
    const flags: MemoryFlagRecord[] = [
      { id: "f1", verdict: { reasons: ["dup"] }, candidate: { fact: "some fact" }, at: FIXED_NOW },
    ];
    const { deps } = makeDeps({ guard: makeGuard(flags) });
    const res = await runMemoryCommand(deps, ["flags", "list", "--json"]);
    const parsed = JSON.parse(res.lines.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]).sort()).toEqual(["at", "fact", "id", "reasons", "resolution"].sort());
    expect(parsed[0].resolution).toBeNull();
  });

  it("flags resolve missing args -> usage, code 1", async () => {
    const { deps } = makeDeps({ guard: makeGuard([]) });
    const res = await runMemoryCommand(deps, ["flags", "resolve"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Usage: hades memory flags resolve");
    const res2 = await runMemoryCommand(deps, ["flags", "resolve", "f1"]);
    expect(res2.code).toBe(1);
  });

  it("flags resolve with an invalid resolution -> code 1, names the bad value", async () => {
    const { deps } = makeDeps({ guard: makeGuard([]) });
    const res = await runMemoryCommand(deps, ["flags", "resolve", "f1", "bogus-resolution"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Invalid resolution: bogus-resolution");
  });

  it("flags resolve for an unknown id -> code 1, names the id", async () => {
    const { deps } = makeDeps({ guard: makeGuard([], false) });
    const res = await runMemoryCommand(deps, ["flags", "resolve", "ghost", "accept-new"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("No such flag: ghost");
  });

  it.each(["accept-new", "keep-existing", "supersede"] as const)("flags resolve %s succeeds and calls guard.resolve with the right args", async (resolution) => {
    const guard = makeGuard([{ id: "f1", verdict: { reasons: [] }, candidate: { fact: "x" }, at: FIXED_NOW }]);
    const { deps } = makeDeps({ guard });
    const res = await runMemoryCommand(deps, ["flags", "resolve", "f1", resolution]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe(`Resolved f1 as ${resolution}.`);
    expect(guard.resolve).toHaveBeenCalledWith("f1", resolution);
  });

  it("unknown flags subcommand -> code 1, names it", async () => {
    const { deps } = makeDeps({ guard: makeGuard([]) });
    const res = await runMemoryCommand(deps, ["flags", "bogus"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown flags command: bogus");
  });
});

// ===========================================================================
// add
// ===========================================================================

describe("memory add", () => {
  it("no fact -> usage, code 1", async () => {
    const { deps } = makeDeps();
    const res = await runMemoryCommand(deps, ["add"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toBe("Usage: hades memory add <fact>");
  });

  it("adds a multi-word fact to the real store and confirms it", async () => {
    const { deps, memory } = makeDeps();
    const res = await runMemoryCommand(deps, ["add", "the", "sky", "is", "blue"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Remembered: the sky is blue");
    const all = memory.all();
    expect(all).toHaveLength(1);
    expect(all[0].fact).toBe("the sky is blue");
    expect(all[0].source).toBe("cli");
  });
});

// ===========================================================================
// add through the REAL write-guard (central-integration honesty checks)
// ===========================================================================

describe("memory add through the real GuardedMemoryStore", () => {
  async function guardedDeps() {
    const { GuardedMemoryStore } = await import("../../memory/guard");
    const { InMemoryMemoryStore: Store } = await import("../../memory/store");
    const inner = new Store();
    const guarded = new GuardedMemoryStore(inner, { now: () => FIXED_NOW });
    const sessions = new InMemorySessionStore();
    const deps: MemoryCommandDeps = {
      memory: guarded,
      sessions,
      searchSessions: searchSessionsOver(sessions),
      guard: guarded,
      now: () => FIXED_NOW,
    };
    return { deps, inner, guarded };
  }

  it("a clean fact writes through and reports Remembered", async () => {
    const { deps, inner } = await guardedDeps();
    const res = await runMemoryCommand(deps, ["add", "the", "user", "prefers", "tea"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Remembered: the user prefers tea");
    expect(inner.all().map((r) => r.fact)).toEqual(["the user prefers tea"]);
  });

  it("a contradicting fact is quarantined and NEVER reported as Remembered", async () => {
    const { deps, inner } = await guardedDeps();
    inner.add({ fact: "the user prefers tea", salience: 0.9 });
    const res = await runMemoryCommand(deps, ["add", "the", "user", "does", "not", "prefer", "tea"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Quarantined (not written)");
    expect(res.lines.join("\n")).not.toContain("Remembered");
    expect(res.lines.join("\n")).toContain("contradiction.negation");
    // The contradicting fact really never landed in durable memory.
    expect(inner.all().map((r) => r.fact)).toEqual(["the user prefers tea"]);
  });

  it("the quarantine output names a resolvable flag id, and resolving it works end-to-end", async () => {
    const { deps, inner } = await guardedDeps();
    inner.add({ fact: "notifications are enabled", salience: 0.9 });
    const add = await runMemoryCommand(deps, ["add", "notifications", "are", "disabled"]);
    expect(add.code).toBe(1);
    const idLine = add.lines.find((l) => l.trimStart().startsWith("flag id:"));
    expect(idLine).toBeDefined();
    const flagId = idLine!.split("flag id:")[1].trim();

    const listed = await runMemoryCommand(deps, ["flags", "--json"]);
    const flags = JSON.parse(listed.lines.join("\n")) as Array<{ id: string; resolution: string | null }>;
    expect(flags.map((f) => f.id)).toContain(flagId);

    const resolved = await runMemoryCommand(deps, ["flags", "resolve", flagId, "supersede"]);
    expect(resolved.code).toBe(0);
    // Supersede: the old contradicted fact is gone, the new one is in.
    expect(inner.all().map((r) => r.fact)).toEqual(["notifications are disabled"]);
  });
});
