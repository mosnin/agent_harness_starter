/* ------------------------------------------------------------------ *
 * swarm-attribution.test.ts
 *
 * REAL-VS-MOCK POLICY: this module is pure logic with no I/O, so every
 * test here exercises the real implementation directly — no mocks, no
 * fakes. Several tests replicate the *exact* shallow-spread mutation
 * `SwarmManager.dispatch()` performs on `task.input`
 * (`task.input = { ...task.input, _dependencies }`, see
 * `src/swarm-runtime/manager/manager.ts:728`) and the real
 * `WorkerTask` type, so the survives-dispatch claim in the module docs is
 * proven against the real contract, not an idealized stand-in.
 * ------------------------------------------------------------------ */
import { describe, it, expect, beforeEach } from "vitest";

import {
  SKILL_ATTRIBUTION_KEY,
  SkillAttributionError,
  SkillAttributionLedger,
  attributeInput,
  attributionIssue,
  skillsForTask,
} from "../swarm-attribution";
import type { WorkerTask } from "../../../swarm-runtime/types";

// ===========================================================================
// helpers
// ===========================================================================

/** Minimal, otherwise-valid WorkerTask for tests that need the real shape. */
function makeTask(input: Record<string, unknown>, id = "task-1"): WorkerTask {
  return {
    id,
    goalId: "goal-1",
    description: "test task",
    requiredCapabilities: [],
    input,
    dependsOn: [],
    priority: 0,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    createdAt: 0,
  };
}

/** Replicates manager.ts:728's exact dispatch-time mutation. */
function dispatchSpread(task: WorkerTask, dependencyResults: unknown[] = []): void {
  task.input = { ...task.input, _dependencies: dependencyResults };
}

// ===========================================================================
// attributeInput — write path
// ===========================================================================

describe("attributeInput", () => {
  it("returns a new object and does not mutate its argument", () => {
    const input = { foo: "bar" };
    const result = attributeInput(input, ["writer"]);
    expect(input).toEqual({ foo: "bar" }); // unchanged
    expect(result).not.toBe(input);
    expect(result).toEqual({ foo: "bar", [SKILL_ATTRIBUTION_KEY]: ["writer"] });
  });

  it("preserves unrelated keys already on input", () => {
    const result = attributeInput({ a: 1, b: [1, 2, 3] }, ["x"]);
    expect(result.a).toBe(1);
    expect(result.b).toEqual([1, 2, 3]);
  });

  it("dedupes exact-duplicate names", () => {
    const result = attributeInput({}, ["writer", "writer", "writer"]);
    expect(result[SKILL_ATTRIBUTION_KEY]).toEqual(["writer"]);
  });

  it("dedupes names that differ only by leading/trailing whitespace, after trimming", () => {
    const result = attributeInput({}, ["writer", "writer ", " writer", "\twriter\n"]);
    expect(result[SKILL_ATTRIBUTION_KEY]).toEqual(["writer"]);
  });

  it("does NOT case-fold names — 'Writer' and 'writer' are distinct skills", () => {
    // Skill names are opaque identifiers chosen by whoever registers the
    // skill (see src/hades/skills/skill-file.ts / library.ts); case-folding
    // them here would silently merge two distinct, independently-registered
    // skills that happen to differ only in case, which is a correctness bug
    // (wrong attribution), not a normalization nicety.
    const result = attributeInput({}, ["Writer", "writer"]);
    expect(result[SKILL_ATTRIBUTION_KEY]).toEqual(["Writer", "writer"]);
  });

  it("sorts names lexicographically for a deterministic representation", () => {
    const result = attributeInput({}, ["zeta", "alpha", "mu"]);
    expect(result[SKILL_ATTRIBUTION_KEY]).toEqual(["alpha", "mu", "zeta"]);
  });

  it("accepts exactly 32 names", () => {
    const names = Array.from({ length: 32 }, (_, i) => `skill-${i}`);
    const result = attributeInput({}, names);
    expect((result[SKILL_ATTRIBUTION_KEY] as string[])).toHaveLength(32);
  });

  it("throws SkillAttributionError for 33 names", () => {
    const names = Array.from({ length: 33 }, (_, i) => `skill-${i}`);
    expect(() => attributeInput({}, names)).toThrow(SkillAttributionError);
    try {
      attributeInput({}, names);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SkillAttributionError);
      expect((err as SkillAttributionError).reason).toBe("too-many-names");
    }
  });

  it("throws on a non-string entry", () => {
    expect(() => attributeInput({}, [123 as unknown as string])).toThrow(SkillAttributionError);
    try {
      attributeInput({}, [123 as unknown as string]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("non-string-entry");
    }
  });

  it("throws on an empty string entry", () => {
    expect(() => attributeInput({}, [""])).toThrow(SkillAttributionError);
    expect(() => attributeInput({}, [""])).toThrowError(/empty/);
  });

  it("throws on a whitespace-only entry", () => {
    try {
      attributeInput({}, ["   \t\n  "]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("empty-name");
    }
  });

  it("throws on a name over 128 characters", () => {
    const tooLong = "a".repeat(129);
    try {
      attributeInput({}, [tooLong]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("name-too-long");
    }
  });

  it("accepts a name of exactly 128 characters", () => {
    const exact = "a".repeat(128);
    const result = attributeInput({}, [exact]);
    expect(result[SKILL_ATTRIBUTION_KEY]).toEqual([exact]);
  });

  it("throws on control characters (NUL)", () => {
    try {
      attributeInput({}, ["writer\x00"]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("control-characters");
    }
  });

  it("throws on control characters (embedded newline)", () => {
    try {
      attributeInput({}, ["writer\nmalicious"]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("control-characters");
    }
  });

  it("throws on control characters (ANSI escape / terminal injection)", () => {
    try {
      attributeInput({}, ["writer\x1b[31mFAKE\x1b[0m"]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("control-characters");
    }
  });

  it("throws when skillNames is not an array", () => {
    try {
      attributeInput({}, "writer" as unknown as string[]);
      expect.unreachable();
    } catch (err) {
      expect((err as SkillAttributionError).reason).toBe("not-an-array");
    }
  });

  it("SkillAttributionError carries name, message, and reason and is a real Error", () => {
    try {
      attributeInput({}, [""]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SkillAttributionError);
      expect((err as SkillAttributionError).name).toBe("SkillAttributionError");
      expect(typeof (err as SkillAttributionError).message).toBe("string");
    }
  });
});

// ===========================================================================
// skillsForTask — read path, fail-safe
// ===========================================================================

describe("skillsForTask", () => {
  it("returns [] when the key is absent", () => {
    expect(skillsForTask(makeTask({}))).toEqual([]);
  });

  it("returns the validated names when well-formed", () => {
    const input = attributeInput({}, ["writer", "researcher"]);
    expect(skillsForTask(makeTask(input))).toEqual(["researcher", "writer"]);
  });

  it("round-trips through attributeInput", () => {
    const input = attributeInput({ mode: "synthesize" }, ["b", "a", "a"]);
    expect(skillsForTask(makeTask(input))).toEqual(["a", "b"]);
  });

  // -- malformed shapes: never throw, always [] --------------------------

  const malformedCases: Array<[string, unknown]> = [
    ["a bare string", "writer"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["a plain object", { writer: true }],
    ["a nested array", [["writer"], ["researcher"]]],
    ["an array with mixed types", ["writer", 42, null, {}]],
    ["an array of non-strings only", [1, 2, 3]],
    ["an array containing NUL", ["writer\x00evil"]],
    ["an array containing a newline", ["writer\nrm -rf /"]],
    ["an array containing an ANSI escape", ["\x1b[2J\x1b[H"]],
    [
      "a forged prototype-pollution-style object",
      { __proto__: ["writer"], constructor: { prototype: {} } },
    ],
    ["an array-like object (not a real array)", { 0: "writer", length: 1 }],
  ];

  for (const [label, value] of malformedCases) {
    it(`returns [] for a forged _skills value: ${label}`, () => {
      const task = makeTask({ [SKILL_ATTRIBUTION_KEY]: value });
      expect(() => skillsForTask(task)).not.toThrow();
      expect(skillsForTask(task)).toEqual([]);
    });
  }

  it("returns [] for an array of 10,000 valid-looking entries (exceeds MAX_NAMES)", () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => `skill-${i}`);
    const task = makeTask({ [SKILL_ATTRIBUTION_KEY]: huge });
    expect(skillsForTask(task)).toEqual([]);
  });

  it("returns [] for a single oversize entry among otherwise-valid entries", () => {
    const task = makeTask({
      [SKILL_ATTRIBUTION_KEY]: ["writer", "a".repeat(200)],
    });
    expect(skillsForTask(task)).toEqual([]);
  });

  it("never returns attacker-controlled data even if array entries look like valid strings mixed with an invalid one", () => {
    const task = makeTask({
      [SKILL_ATTRIBUTION_KEY]: ["writer", "researcher", "bad\x07bell"],
    });
    // The whole payload is rejected, not partially accepted — no
    // attacker-shaped partial success.
    expect(skillsForTask(task)).toEqual([]);
  });

  it("does not throw even if task.input is missing entirely (defensive Pick usage)", () => {
    const task = { id: "t1", input: undefined as unknown as Record<string, unknown> };
    expect(() => skillsForTask(task)).not.toThrow();
    expect(skillsForTask(task)).toEqual([]);
  });

  it("does not throw if input access itself throws (pathological getter)", () => {
    const hostile = {
      id: "t1",
      get input(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    expect(() => skillsForTask(hostile)).not.toThrow();
    expect(skillsForTask(hostile)).toEqual([]);
  });
});

// ===========================================================================
// attributionIssue — explains rejections distinctly
// ===========================================================================

describe("attributionIssue", () => {
  it("returns null when the key is absent", () => {
    expect(attributionIssue(makeTask({}))).toBeNull();
  });

  it("returns null when the key is well-formed", () => {
    const input = attributeInput({}, ["writer"]);
    expect(attributionIssue(makeTask(input))).toBeNull();
  });

  it("distinguishes: not an array", () => {
    const msg = attributionIssue(makeTask({ [SKILL_ATTRIBUTION_KEY]: "writer" }));
    expect(msg).toMatch(/not an array/);
  });

  it("distinguishes: too many entries", () => {
    const huge = Array.from({ length: 33 }, (_, i) => `skill-${i}`);
    const msg = attributionIssue(makeTask({ [SKILL_ATTRIBUTION_KEY]: huge }));
    expect(msg).toMatch(/33 entries/);
    expect(msg).toMatch(/exceeding/);
  });

  it("distinguishes: non-string entry, with index", () => {
    const msg = attributionIssue(
      makeTask({ [SKILL_ATTRIBUTION_KEY]: ["writer", 42] }),
    );
    expect(msg).toMatch(/\[1\]/);
    expect(msg).toMatch(/not a string/);
  });

  it("distinguishes: empty/whitespace entry, with index", () => {
    const msg = attributionIssue(
      makeTask({ [SKILL_ATTRIBUTION_KEY]: ["writer", "   "] }),
    );
    expect(msg).toMatch(/\[1\]/);
    expect(msg).toMatch(/empty or whitespace/);
  });

  it("distinguishes: oversize entry, with index", () => {
    const msg = attributionIssue(
      makeTask({ [SKILL_ATTRIBUTION_KEY]: ["writer", "a".repeat(200)] }),
    );
    expect(msg).toMatch(/\[1\]/);
    expect(msg).toMatch(/maximum length/);
  });

  it("distinguishes: control characters, with index", () => {
    const msg = attributionIssue(
      makeTask({ [SKILL_ATTRIBUTION_KEY]: ["writer", "bad\x1b[0m"] }),
    );
    expect(msg).toMatch(/\[1\]/);
    expect(msg).toMatch(/control characters/);
  });

  it("all distinct rejection classes produce distinct message text", () => {
    const inputs: Record<string, unknown>[] = [
      { [SKILL_ATTRIBUTION_KEY]: "not-array" },
      { [SKILL_ATTRIBUTION_KEY]: Array.from({ length: 40 }, (_, i) => `s${i}`) },
      { [SKILL_ATTRIBUTION_KEY]: [1] },
      { [SKILL_ATTRIBUTION_KEY]: [""] },
      { [SKILL_ATTRIBUTION_KEY]: ["a".repeat(200)] },
      { [SKILL_ATTRIBUTION_KEY]: ["a\x00b"] },
    ];
    const messages = inputs.map((i) => attributionIssue(makeTask(i)));
    expect(messages.every((m) => typeof m === "string")).toBe(true);
    // Every message must be unique — proving each rejection class is
    // explained distinctly, not collapsed into one generic string.
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("never throws, even on a hostile getter", () => {
    const hostile = {
      id: "t1",
      get input(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    expect(() => attributionIssue(hostile)).not.toThrow();
    expect(typeof attributionIssue(hostile)).toBe("string");
  });
});

// ===========================================================================
// Survives dispatch mutation (manager.ts:728's exact shallow spread)
// ===========================================================================

describe("survives SwarmManager.dispatch()'s shallow-spread mutation", () => {
  it("_skills is preserved across task.input = { ...task.input, _dependencies }", () => {
    const task = makeTask(attributeInput({ mode: "analyze" }, ["writer", "researcher"]));
    dispatchSpread(task, [{ output: "upstream result" }]);

    expect(task.input._dependencies).toEqual([{ output: "upstream result" }]);
    expect(skillsForTask(task)).toEqual(["researcher", "writer"]);
    expect(attributionIssue(task)).toBeNull();
  });

  it("survives a requeue simulation: attribute -> dispatch spread -> requeue spread", () => {
    const task = makeTask(attributeInput({}, ["planner"]));

    // First dispatch.
    dispatchSpread(task, [{ output: "first pass" }]);
    expect(skillsForTask(task)).toEqual(["planner"]);

    // Simulate a hang/death -> requeue -> re-dispatch: manager.ts performs
    // the identical shallow-spread mutation again on redispatch.
    dispatchSpread(task, [{ output: "first pass" }, { output: "second pass" }]);
    expect(skillsForTask(task)).toEqual(["planner"]);
    expect(task.input._dependencies).toEqual([
      { output: "first pass" },
      { output: "second pass" },
    ]);
  });

  it("round-trips through JSON.stringify/parse (bus serialization) and then survives dispatch", () => {
    const original = makeTask(attributeInput({ objective: "research X" }, ["researcher", "writer"]));

    const wireForm = JSON.parse(JSON.stringify(original)) as WorkerTask;
    expect(skillsForTask(wireForm)).toEqual(["researcher", "writer"]);

    dispatchSpread(wireForm, [{ output: "dep" }]);
    expect(skillsForTask(wireForm)).toEqual(["researcher", "writer"]);
  });

  it("attributing AFTER a prior dispatch spread still composes correctly (order-independence)", () => {
    const task = makeTask({ objective: "x" });
    dispatchSpread(task, [{ output: "dep" }]);
    task.input = attributeInput(task.input, ["late-bound-skill"]);

    expect(skillsForTask(task)).toEqual(["late-bound-skill"]);
    expect(task.input._dependencies).toEqual([{ output: "dep" }]);
  });
});

// ===========================================================================
// SkillAttributionLedger
// ===========================================================================

describe("SkillAttributionLedger", () => {
  let ledger: SkillAttributionLedger;

  beforeEach(() => {
    ledger = new SkillAttributionLedger();
  });

  it("forTask returns [] for an unknown task id", () => {
    expect(ledger.forTask(makeTask({}, "unknown"))).toEqual([]);
  });

  it("note() then forTask() resolves the noted names, sorted+deduped", () => {
    ledger.note("t1", ["writer", "writer", "researcher"]);
    expect(ledger.forTask(makeTask({}, "t1"))).toEqual(["researcher", "writer"]);
  });

  it("note() validates the same way as attributeInput and throws SkillAttributionError", () => {
    expect(() => ledger.note("t1", [""])).toThrow(SkillAttributionError);
    expect(() => ledger.note("t1", Array.from({ length: 33 }, (_, i) => `s${i}`))).toThrow(
      SkillAttributionError,
    );
  });

  it("note() throws on empty taskId", () => {
    expect(() => ledger.note("", ["writer"])).toThrow(SkillAttributionError);
  });

  it("re-note()-ing a taskId overwrites its names", () => {
    ledger.note("t1", ["writer"]);
    ledger.note("t1", ["researcher"]);
    expect(ledger.forTask(makeTask({}, "t1"))).toEqual(["researcher"]);
    expect(ledger.size).toBe(1);
  });

  it("clear() empties the ledger", () => {
    ledger.note("t1", ["writer"]);
    ledger.note("t2", ["researcher"]);
    ledger.clear();
    expect(ledger.size).toBe(0);
    expect(ledger.forTask(makeTask({}, "t1"))).toEqual([]);
  });

  // -- precedence: embedded wins ------------------------------------------

  it("embedded key wins over the ledger when embedded is non-empty", () => {
    ledger.note("t1", ["ledger-skill"]);
    const input = attributeInput({}, ["embedded-skill"]);
    expect(ledger.forTask(makeTask(input, "t1"))).toEqual(["embedded-skill"]);
  });

  it("falls through to the ledger when the embedded key is absent", () => {
    ledger.note("t1", ["ledger-skill"]);
    expect(ledger.forTask(makeTask({}, "t1"))).toEqual(["ledger-skill"]);
  });

  it("falls through to the ledger when the embedded key is present but empty", () => {
    ledger.note("t1", ["ledger-skill"]);
    const input = attributeInput({}, []);
    expect(ledger.forTask(makeTask(input, "t1"))).toEqual(["ledger-skill"]);
  });

  it("falls through to the ledger when the embedded key is present but malformed, and attributionIssue still reports the malformation", () => {
    ledger.note("t1", ["ledger-skill"]);
    const task = makeTask({ [SKILL_ATTRIBUTION_KEY]: "not-an-array" }, "t1");

    expect(ledger.forTask(task)).toEqual(["ledger-skill"]);
    expect(attributionIssue(task)).toMatch(/not an array/);
  });

  it("returns [] when both embedded is malformed and no ledger entry exists", () => {
    const task = makeTask({ [SKILL_ATTRIBUTION_KEY]: 999 }, "unknown-task");
    expect(ledger.forTask(task)).toEqual([]);
    expect(attributionIssue(task)).not.toBeNull();
  });

  it("forTask never throws even on a hostile input getter", () => {
    ledger.note("t1", ["ledger-skill"]);
    const hostile = {
      id: "t1",
      get input(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    expect(() => ledger.forTask(hostile)).not.toThrow();
    expect(ledger.forTask(hostile)).toEqual(["ledger-skill"]);
  });

  // -- constructor validation ----------------------------------------------

  it("rejects a non-positive-integer maxEntries", () => {
    expect(() => new SkillAttributionLedger({ maxEntries: 0 })).toThrow(SkillAttributionError);
    expect(() => new SkillAttributionLedger({ maxEntries: -1 })).toThrow(SkillAttributionError);
    expect(() => new SkillAttributionLedger({ maxEntries: 1.5 })).toThrow(SkillAttributionError);
  });

  it("defaults maxEntries to 10_000", () => {
    const l = new SkillAttributionLedger();
    for (let i = 0; i < 10_000; i++) {
      l.note(`t${i}`, ["writer"]);
    }
    expect(l.size).toBe(10_000);
    expect(l.forTask(makeTask({}, "t0"))).toEqual(["writer"]); // not yet evicted
    l.note("t10000", ["writer"]); // 10,001st distinct id -> evicts oldest (t0)
    expect(l.size).toBe(10_000);
    expect(l.forTask(makeTask({}, "t0"))).toEqual([]); // evicted
    expect(l.forTask(makeTask({}, "t10000"))).toEqual(["writer"]);
  });

  // -- FIFO eviction: exact and deterministic ------------------------------

  describe("FIFO eviction at a small bound", () => {
    it("evicts the oldest-inserted entry, exactly, when at capacity", () => {
      const small = new SkillAttributionLedger({ maxEntries: 3 });
      small.note("t1", ["a"]);
      small.note("t2", ["b"]);
      small.note("t3", ["c"]);
      expect(small.size).toBe(3);

      small.note("t4", ["d"]); // t1 was oldest -> evicted
      expect(small.size).toBe(3);
      expect(small.forTask(makeTask({}, "t1"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t2"))).toEqual(["b"]);
      expect(small.forTask(makeTask({}, "t3"))).toEqual(["c"]);
      expect(small.forTask(makeTask({}, "t4"))).toEqual(["d"]);
    });

    it("eviction order continues correctly across multiple evictions", () => {
      const small = new SkillAttributionLedger({ maxEntries: 2 });
      small.note("t1", ["a"]);
      small.note("t2", ["b"]);
      small.note("t3", ["c"]); // evicts t1
      small.note("t4", ["d"]); // evicts t2

      expect(small.forTask(makeTask({}, "t1"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t2"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t3"))).toEqual(["c"]);
      expect(small.forTask(makeTask({}, "t4"))).toEqual(["d"]);
    });

    it("re-note()-ing an existing id does NOT refresh its position in eviction order", () => {
      const small = new SkillAttributionLedger({ maxEntries: 3 });
      small.note("t1", ["a"]);
      small.note("t2", ["b"]);
      small.note("t3", ["c"]);

      // t1 is updated but should remain "oldest" for eviction purposes.
      small.note("t1", ["a-updated"]);
      small.note("t4", ["d"]); // must evict t1 (oldest by insertion), not t2

      expect(small.forTask(makeTask({}, "t1"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t2"))).toEqual(["b"]);
      expect(small.forTask(makeTask({}, "t3"))).toEqual(["c"]);
      expect(small.forTask(makeTask({}, "t4"))).toEqual(["d"]);
    });

    it("note() after eviction re-adds a fresh entry and can itself be evicted later", () => {
      const small = new SkillAttributionLedger({ maxEntries: 2 });
      small.note("t1", ["a"]);
      small.note("t2", ["b"]);
      small.note("t3", ["c"]); // evicts t1
      expect(small.forTask(makeTask({}, "t1"))).toEqual([]);

      // Re-inserting the previously-evicted t1 counts as a fresh insertion.
      small.note("t1", ["a-again"]);
      expect(small.forTask(makeTask({}, "t1"))).toEqual(["a-again"]);
      expect(small.size).toBe(2);
      // t2 was oldest of {t2, t3} before this insert -> evicted.
      expect(small.forTask(makeTask({}, "t2"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t3"))).toEqual(["c"]);

      small.note("t4", ["d"]); // evicts t3 (oldest of {t3, t1})
      expect(small.forTask(makeTask({}, "t3"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t1"))).toEqual(["a-again"]);
      expect(small.forTask(makeTask({}, "t4"))).toEqual(["d"]);
    });

    it("maxEntries of 1 keeps only the most-recently-inserted id", () => {
      const small = new SkillAttributionLedger({ maxEntries: 1 });
      small.note("t1", ["a"]);
      small.note("t2", ["b"]);
      expect(small.forTask(makeTask({}, "t1"))).toEqual([]);
      expect(small.forTask(makeTask({}, "t2"))).toEqual(["b"]);
      expect(small.size).toBe(1);
    });
  });
});
