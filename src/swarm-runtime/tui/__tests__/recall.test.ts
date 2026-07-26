import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecallStore,
  recallInit,
  recallKey,
  filterRecall,
  renderRecallBar,
  type RecallEntry,
  type RecallState,
} from "../recall";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "recall-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function entry(text: string, at: number, kind: RecallEntry["kind"] = "goal"): RecallEntry {
  return { text, at, kind };
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

/** Feed a sequence of keys through recallKey, returning the final state + effects seen. */
function feed(
  state: RecallState,
  keys: string[],
  entries: readonly RecallEntry[],
  currentBuffer = ""
): { state: RecallState; effects: Array<ReturnType<typeof recallKey>["effect"]> } {
  const effects: Array<ReturnType<typeof recallKey>["effect"]> = [];
  let s = state;
  for (const k of keys) {
    const r = recallKey(deepFreeze({ ...s }), k, entries, currentBuffer);
    s = r.state;
    effects.push(r.effect);
  }
  return { state: s, effects };
}

// ===========================================================================
// RecallStore — real filesystem
// ===========================================================================

describe("RecallStore", () => {
  it("round-trips entries through append + load", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });

    store.append(entry("first goal", 1000));
    store.append(entry("/status", 2000, "slash"));
    store.append(entry("third goal", 3000));

    const { entries, skippedCorrupt } = store.load();
    expect(skippedCorrupt).toBe(0);
    expect(entries).toEqual([
      entry("first goal", 1000),
      entry("/status", 2000, "slash"),
      entry("third goal", 3000),
    ]);
  });

  it("returns an empty, non-corrupt result when the file does not exist", () => {
    const dir = freshDir();
    const store = new RecallStore({ filePath: join(dir, "nope", "recall.jsonl") });
    const { entries, skippedCorrupt } = store.load();
    expect(entries).toEqual([]);
    expect(skippedCorrupt).toBe(0);
  });

  it("auto-creates the parent directory on first append", () => {
    const dir = freshDir();
    const filePath = join(dir, "a", "b", "c", "recall.jsonl");
    expect(existsSync(join(dir, "a"))).toBe(false);
    const store = new RecallStore({ filePath });
    store.append(entry("hello", 1));
    expect(existsSync(filePath)).toBe(true);
    expect(store.load().entries).toEqual([entry("hello", 1)]);
  });

  it("writes a version header line and skips gracefully on an unknown version", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });
    store.append(entry("a", 1));

    const raw = readFileSync(filePath, "utf8");
    const firstLine = raw.split("\n")[0];
    expect(JSON.parse(firstLine!)).toEqual({ v: 1 });

    // Rewrite with an unknown future version header.
    const rest = raw.split("\n").slice(1).join("\n");
    writeFileSync(filePath, `${JSON.stringify({ v: 2 })}\n${rest}`);

    const result = store.load();
    expect(result.entries).toEqual([]);
    expect(result.skippedCorrupt).toBeGreaterThan(0);
  });

  it("skips corrupt/partial lines in the middle and counts them honestly, keeping the valid ones", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const lines = [
      JSON.stringify({ v: 1 }),
      JSON.stringify(entry("good one", 1)),
      "{not valid json at all",
      JSON.stringify({ text: "missing kind", at: 2 }), // structurally invalid: no `kind`
      JSON.stringify(entry("good two", 3)),
      "",
    ];
    writeFileSync(filePath, lines.join("\n"));

    const store = new RecallStore({ filePath });
    const result = store.load();
    expect(result.entries).toEqual([entry("good one", 1), entry("good two", 3)]);
    expect(result.skippedCorrupt).toBe(2);
  });

  it("evicts oldest entries beyond maxEntries, keeping the newest", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath, maxEntries: 3 });

    for (let i = 0; i < 6; i++) {
      store.append(entry(`goal-${i}`, i));
    }

    const { entries } = store.load();
    expect(entries.map((e) => e.text)).toEqual(["goal-3", "goal-4", "goal-5"]);
  });

  it("dedupes an adjacent duplicate text on append instead of piling up repeats", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });

    store.append(entry("same text", 1));
    store.append(entry("same text", 2));
    store.append(entry("same text", 3));
    store.append(entry("different", 4));
    store.append(entry("same text", 5)); // not adjacent to the first run: not deduped away

    const { entries } = store.load();
    expect(entries.map((e) => `${e.text}@${e.at}`)).toEqual(["same text@3", "different@4", "same text@5"]);
  });

  it("leaves a fully parseable file after back-to-back double appends", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });

    store.append(entry("one", 1));
    store.append(entry("two", 2));

    // No leftover atomic-write temp artifact should remain in the directory.
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);

    const raw = readFileSync(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const { entries, skippedCorrupt } = store.load();
    expect(skippedCorrupt).toBe(0);
    expect(entries.map((e) => e.text)).toEqual(["one", "two"]);
  });

  it("a leftover .tmp file from a simulated crash never affects a load of the real file", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });
    store.append(entry("safe and sound", 1));

    // Simulate a crash between writeFileSync(tmp) and renameSync(tmp, real):
    // a garbage .tmp file exists alongside a complete, untouched real file.
    writeFileSync(`${filePath}.tmp`, "garbage not even json\n{{{");

    const { entries, skippedCorrupt } = store.load();
    expect(entries).toEqual([entry("safe and sound", 1)]);
    expect(skippedCorrupt).toBe(0);

    // A subsequent append still succeeds and overwrites/cleans the stray tmp.
    store.append(entry("after crash", 2));
    expect(store.load().entries.map((e) => e.text)).toEqual(["safe and sound", "after crash"]);
  });

  it("round-trips unicode and embedded-newline text exactly", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    const store = new RecallStore({ filePath });

    const unicodeText = "セット目標 🚀 café — naïve";
    const multilineText = "line one\nline two\r\nline three";
    store.append(entry(unicodeText, 1));
    store.append(entry(multilineText, 2));

    const raw = readFileSync(filePath, "utf8");
    // The JSONL format must escape embedded newlines: no bare \n or \r inside
    // a data line's JSON string content should split it into extra lines.
    const dataLines = raw.split("\n").filter((l) => l.length > 0);
    expect(dataLines.length).toBe(3); // header + 2 entries, newlines escaped

    const { entries, skippedCorrupt } = store.load();
    expect(skippedCorrupt).toBe(0);
    expect(entries[0]!.text).toBe(unicodeText);
    expect(entries[1]!.text).toBe(multilineText);
  });

  it("throws on a non-positive maxEntries rather than silently misbehaving", () => {
    const dir = freshDir();
    expect(() => new RecallStore({ filePath: join(dir, "recall.jsonl"), maxEntries: 0 })).toThrow();
    expect(() => new RecallStore({ filePath: join(dir, "recall.jsonl"), maxEntries: -5 })).toThrow();
  });

  it("skips a fully blank/empty file honestly rather than crashing", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    writeFileSync(filePath, "");
    const store = new RecallStore({ filePath });
    const result = store.load();
    expect(result).toEqual({ entries: [], skippedCorrupt: 0 });
  });

  it("skips an unparseable header line honestly", () => {
    const dir = freshDir();
    const filePath = join(dir, "recall.jsonl");
    writeFileSync(filePath, "not json at all\n{\"text\":\"x\",\"at\":1,\"kind\":\"goal\"}\n");
    const store = new RecallStore({ filePath });
    const result = store.load();
    expect(result.entries).toEqual([]);
    expect(result.skippedCorrupt).toBeGreaterThan(0);
  });
});

// ===========================================================================
// filterRecall — pure substring search
// ===========================================================================

describe("filterRecall", () => {
  const entries: RecallEntry[] = [
    entry("build the swarm runtime", 1),
    entry("/skills list", 2, "slash"),
    entry("fix the STYX verification gate", 3),
    entry("Build a desktop TUI", 4),
  ];

  it("matches case-insensitively and returns newest-first indices", () => {
    expect(filterRecall(entries, "build")).toEqual([3, 0]);
  });

  it("an empty query matches everything, newest first", () => {
    expect(filterRecall(entries, "")).toEqual([3, 2, 1, 0]);
  });

  it("returns an empty array on no matches", () => {
    expect(filterRecall(entries, "nonexistent-xyz")).toEqual([]);
  });

  it("handles an empty entries list without throwing", () => {
    expect(filterRecall([], "anything")).toEqual([]);
  });
});

// ===========================================================================
// recallKey — pure reducer state machine
// ===========================================================================

describe("recallKey — Up/Down cycling", () => {
  const entries: RecallEntry[] = [entry("oldest", 1), entry("middle", 2), entry("newest", 3)];

  it("Up from idle stashes the draft and shows the newest entry", () => {
    const { state, effects } = feed(recallInit(), ["\x1b[A"], entries, "my in-progress draft");
    expect(state.mode).toBe("cycling");
    expect(state.draft).toBe("my in-progress draft");
    expect(effects[0]).toEqual({ kind: "replace-buffer", text: "newest" });
  });

  it("repeated Up walks older and clamps at the oldest entry", () => {
    const { state, effects } = feed(recallInit(), ["\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A"], entries, "draft");
    expect(effects.map((e) => (e && e.kind === "replace-buffer" ? e.text : e))).toEqual([
      "newest",
      "middle",
      "oldest",
      "oldest",
      "oldest",
    ]);
    expect(state.index).toBe(0);
  });

  it("Down after Up walks back toward newest", () => {
    const { effects } = feed(recallInit(), ["\x1b[A", "\x1b[A", "\x1b[B"], entries, "draft");
    // newest -> middle -> newest
    expect(effects[2]).toEqual({ kind: "replace-buffer", text: "newest" });
  });

  it("Down past the newest entry restores the original draft (byte-exact, including multiline)", () => {
    const multilineDraft = "line 1\nline 2\n  indented line 3";
    const { state, effects } = feed(recallInit(), ["\x1b[A", "\x1b[B"], entries, multilineDraft);
    expect(effects[1]).toEqual({ kind: "restore-draft", text: multilineDraft });
    expect(state.mode).toBe("idle");
  });

  it("Down while idle (never cycled) is a no-op", () => {
    const { state, effects } = feed(recallInit(), ["\x1b[B"], entries, "draft");
    expect(state).toEqual(recallInit());
    expect(effects[0]).toBeNull();
  });

  it("Up with an empty entries list is an honest no-op", () => {
    const initial = recallInit();
    const { state, effects } = feed(initial, ["\x1b[A"], [], "draft");
    expect(state).toEqual(initial);
    expect(effects[0]).toBeNull();
  });

  it("any other key while cycling exits recall without an effect, leaving the shown text as-is", () => {
    const { state, effects } = feed(recallInit(), ["\x1b[A", "x"], entries, "draft");
    expect(state.mode).toBe("idle");
    expect(effects[1]).toBeNull();
  });

  it("does not mutate its input state (purity)", () => {
    const initial = deepFreeze(recallInit());
    expect(() => recallKey(initial, "\x1b[A", entries, "draft")).not.toThrow();
  });
});

describe("recallKey — Ctrl-R incremental reverse search", () => {
  const entries: RecallEntry[] = [
    entry("deploy the cli", 1),
    entry("/skills list", 2, "slash"),
    entry("deploy the tui", 3),
    entry("fix a bug", 4),
  ];

  it("Ctrl-R enters search mode and shows the newest entry for an empty query", () => {
    const { state, effects } = feed(recallInit(), ["\x12"], entries, "draft text");
    expect(state.mode).toBe("search");
    expect(state.draft).toBe("draft text");
    expect(effects[0]).toEqual({ kind: "replace-buffer", text: "fix a bug" });
  });

  it("each printable character narrows the match and updates the buffer", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "d", "e", "p"], entries, "draft");
    expect(state.query).toBe("dep");
    // newest match for "dep" is "deploy the tui" (index 2), ahead of "deploy the cli" (index 0)
    expect(effects[3]).toEqual({ kind: "replace-buffer", text: "deploy the tui" });
  });

  it("repeated Ctrl-R jumps to the next OLDER match and clamps at the oldest", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "d", "e", "p", "\x12", "\x12", "\x12"], entries, "draft");
    // matches for "dep" newest-first: "deploy the tui"(2), "deploy the cli"(0)
    expect(effects[4]).toEqual({ kind: "replace-buffer", text: "deploy the cli" });
    expect(effects[5]).toEqual({ kind: "replace-buffer", text: "deploy the cli" }); // clamped, no third match
    expect(effects[6]).toEqual({ kind: "replace-buffer", text: "deploy the cli" });
    expect(state.matchIndex).toBe(1);
  });

  it("Backspace widens the query and re-searches", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "d", "e", "p", "l", "\x7f"], entries, "draft");
    expect(state.query).toBe("dep");
    expect(effects[5]).toEqual({ kind: "replace-buffer", text: "deploy the tui" });
  });

  it("Backspace on an empty query is a no-op", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "\x7f"], entries, "draft");
    expect(state.mode).toBe("search");
    expect(effects[1]).toBeNull();
  });

  it("a query with zero matches renders honestly and matchIndex/index clamp to -1", () => {
    const { state } = feed(recallInit(), ["\x12", "z", "z", "z", "z"], entries, "draft");
    expect(state.matchIndex).toBe(-1);
    expect(state.index).toBe(-1);
  });

  it("Enter accepts the current match as a buffer replacement and exits search", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "b", "u", "g", "\r"], entries, "draft");
    expect(state.mode).toBe("idle");
    expect(effects[4]).toEqual({ kind: "replace-buffer", text: "fix a bug" });
  });

  it("Enter with zero matches restores the draft instead of accepting garbage", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "z", "z", "z", "\r"], entries, "original draft");
    expect(state.mode).toBe("idle");
    expect(effects[4]).toEqual({ kind: "restore-draft", text: "original draft" });
  });

  it("Esc restores the draft and exits search", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "d", "e", "p", "\x1b"], entries, "the draft");
    expect(state.mode).toBe("idle");
    expect(effects[4]).toEqual({ kind: "restore-draft", text: "the draft" });
  });

  it("printable input during search never leaks into the compose buffer directly — only via replace-buffer effects", () => {
    const { effects } = feed(recallInit(), ["\x12", "x", "y", "z"], entries, "draft");
    for (const e of effects) {
      if (e !== null) {
        expect(["replace-buffer", "restore-draft"]).toContain(e.kind);
      }
    }
  });

  it("arrow keys are swallowed (not passed through) while searching", () => {
    const { state, effects } = feed(recallInit(), ["\x12", "d", "\x1b[A", "\x1b[B"], entries, "draft");
    expect(state.mode).toBe("search");
    expect(effects[2]).toBeNull();
    expect(effects[3]).toBeNull();
  });

  it("Ctrl-R with an empty entries list does not throw and yields no match", () => {
    const { state, effects } = feed(recallInit(), ["\x12"], [], "draft");
    expect(state.mode).toBe("search");
    expect(state.matchIndex).toBe(-1);
    expect(effects[0]).toBeNull();
  });

  it("does not mutate its input state (purity)", () => {
    const initial = deepFreeze(recallInit());
    expect(() => recallKey(initial, "\x12", entries, "draft")).not.toThrow();
    const cycling = deepFreeze({ mode: "cycling" as const, index: 1, draft: "d", query: "", matchIndex: -1 });
    expect(() => recallKey(cycling, "\x1b[A", entries, "draft")).not.toThrow();
  });

  it("all indices stay within bounds across a long, mixed key sequence", () => {
    const keys = ["\x12", "d", "\x12", "\x12", "\x12", "\x12", "\x7f", "\x7f", "\x7f", "\x1b[A", "\x1b[A"];
    const { state } = feed(recallInit(), keys, entries, "draft");
    expect(state.index).toBeGreaterThanOrEqual(-1);
    expect(state.index).toBeLessThan(entries.length);
    expect(state.matchIndex).toBeGreaterThanOrEqual(-1);
  });
});

// ===========================================================================
// renderRecallBar
// ===========================================================================

describe("renderRecallBar", () => {
  const entries: RecallEntry[] = [entry("oldest", 1), entry("newest", 2)];

  it("renders an empty string when idle (integrator hides the row)", () => {
    expect(renderRecallBar(recallInit(), entries, 80)).toBe("");
  });

  it("renders a reverse-i-search bar with the query and matched text", () => {
    const { state } = feed(recallInit(), ["\x12", "n", "e", "w"], entries, "draft");
    const bar = renderRecallBar(state, entries, 80);
    expect(bar).toContain("reverse-i-search");
    expect(bar).toContain("new");
    expect(bar).toContain("newest");
  });

  it("renders an honest failed reverse-i-search bar when nothing matches", () => {
    const { state } = feed(recallInit(), ["\x12", "z", "z", "z"], entries, "draft");
    const bar = renderRecallBar(state, entries, 80);
    expect(bar).toContain("failed reverse-i-search");
  });

  it("truncates to the given code-point width", () => {
    const longEntries: RecallEntry[] = [entry("x".repeat(200), 1)];
    const { state } = feed(recallInit(), ["\x1b[A"], longEntries, "draft");
    const bar = renderRecallBar(state, longEntries, 20);
    expect([...bar].length).toBe(20);
  });

  it("sanitizes control characters (ANSI escapes, \\r) as U+FFFD so a hostile entry cannot corrupt the terminal", () => {
    const hostile: RecallEntry[] = [entry("\x1b[31mFAKE\x1b[0m\rprompt$ rm -rf /", 1)];
    const { state } = feed(recallInit(), ["\x1b[A"], hostile, "draft");
    const bar = renderRecallBar(state, hostile, 200);
    expect(bar).not.toContain("\x1b");
    expect(bar).not.toContain("\r");
    expect(bar).toContain("�");
  });

  it("passes through printable box-drawing characters unchanged (they are not control chars)", () => {
    const boxy: RecallEntry[] = [entry("╭─ not a real pane ─╮", 1)];
    const { state } = feed(recallInit(), ["\x1b[A"], boxy, "draft");
    const bar = renderRecallBar(state, boxy, 200);
    expect(bar).toContain("╭─ not a real pane ─╮");
  });

  it("renders a cycling bar with a position indicator", () => {
    const { state } = feed(recallInit(), ["\x1b[A"], entries, "draft");
    const bar = renderRecallBar(state, entries, 80);
    expect(bar).toMatch(/\d+\/\d+/);
    expect(bar).toContain("newest");
  });
});
