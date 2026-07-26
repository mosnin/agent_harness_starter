import { describe, expect, it } from "vitest";

import {
  composeRedirectObjective,
  interruptInit,
  interruptKey,
  interruptOpen,
  renderInterruptOverlay,
  type InterruptIntent,
  type InterruptState,
} from "../interrupt";

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

const GOAL = { goalId: "goal-1", objective: "ship the feature" };

function openedMenu(): InterruptState {
  return interruptOpen(interruptInit(), GOAL);
}

// ---------------------------------------------------------------------------
// interruptInit / interruptOpen
// ---------------------------------------------------------------------------

describe("interruptInit", () => {
  it("starts idle with no goal and empty text", () => {
    const s = interruptInit();
    expect(s).toEqual({ phase: "idle", goalId: null, objective: "", instruction: "" });
  });
});

describe("interruptOpen", () => {
  it("opening with a goal enters the menu phase carrying goalId/objective", () => {
    const s = interruptOpen(interruptInit(), GOAL);
    expect(s.phase).toBe("menu");
    expect(s.goalId).toBe("goal-1");
    expect(s.objective).toBe("ship the feature");
    expect(s.instruction).toBe("");
  });

  it("opening with null goal stays idle regardless of prior state (inert: nothing running to interrupt)", () => {
    const fromIdle = interruptOpen(interruptInit(), null);
    expect(fromIdle.phase).toBe("idle");

    // Even opening null from an already-open (non-idle) state resets to idle.
    const menu = openedMenu();
    const fromMenu = interruptOpen(menu, null);
    expect(fromMenu).toEqual({ phase: "idle", goalId: null, objective: "", instruction: "" });
  });

  it("re-opening on a different goal clears any leftover redirect draft", () => {
    let s = openedMenu();
    s = interruptKey(s, "d").state;
    s = interruptKey(s, "h").state;
    s = interruptKey(s, "i").state;
    expect(s.instruction).toBe("hi");

    const reopened = interruptOpen(s, { goalId: "goal-2", objective: "new objective" });
    expect(reopened).toEqual({ phase: "menu", goalId: "goal-2", objective: "new objective", instruction: "" });
  });

  it("does not mutate the state argument passed in", () => {
    const s = deepFreeze(interruptInit());
    expect(() => interruptOpen(s, GOAL)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderInterruptOverlay — idle renders nothing
// ---------------------------------------------------------------------------

describe("renderInterruptOverlay", () => {
  it("renders [] while idle", () => {
    expect(renderInterruptOverlay(interruptInit(), 60)).toEqual([]);
  });

  it("renders a boxed menu naming the goal and objective", () => {
    const lines = renderInterruptOverlay(openedMenu(), 60);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toMatch(/INTERRUPT/);
    const joined = lines.join("\n");
    expect(joined).toContain("goal-1");
    expect(joined).toContain("ship the feature");
    expect(joined).toMatch(/resume/);
    expect(joined).toMatch(/abort/);
    expect(joined).toMatch(/redirect/);
  });

  it("renders a confirm-abort warning that names the goalId", () => {
    const s = interruptKey(openedMenu(), "a").state;
    expect(s.phase).toBe("confirm-abort");
    const lines = renderInterruptOverlay(s, 60);
    const joined = lines.join("\n");
    expect(joined).toContain("goal-1");
    expect(joined.toLowerCase()).toContain("abort");
  });

  it("renders the redirect editor with a cursor mark reflecting typed instruction", () => {
    let s = interruptKey(openedMenu(), "d").state;
    s = interruptKey(s, "h").state;
    s = interruptKey(s, "i").state;
    const lines = renderInterruptOverlay(s, 60);
    const joined = lines.join("\n");
    expect(joined).toContain("hi▏");
  });

  it("every row is exactly the requested width in code points", () => {
    for (const s of [openedMenu(), interruptKey(openedMenu(), "a").state, interruptKey(openedMenu(), "d").state]) {
      const lines = renderInterruptOverlay(s, 50);
      for (const l of lines) {
        expect([...l].length).toBe(50);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// composeRedirectObjective — golden byte-stable format
// ---------------------------------------------------------------------------

describe("composeRedirectObjective", () => {
  it("matches the locked deterministic format exactly (golden assertion)", () => {
    const out = composeRedirectObjective("build the widget", "focus on the API first");
    expect(out).toBe(
      "REDIRECT: focus on the API first\n\nOriginal objective (superseded, preserve completed work): build the widget"
    );
  });

  it("is byte-stable with a multiline original objective", () => {
    const original = "line one\nline two\nline three";
    const out = composeRedirectObjective(original, "stop and pivot");
    expect(out).toBe(
      "REDIRECT: stop and pivot\n\nOriginal objective (superseded, preserve completed work): line one\nline two\nline three"
    );
  });

  it("is byte-stable with unicode in both instruction and objective", () => {
    const out = composeRedirectObjective("目標: 出荷する 🚀", "変更してください — 日本語で");
    expect(out).toBe(
      "REDIRECT: 変更してください — 日本語で\n\nOriginal objective (superseded, preserve completed work): 目標: 出荷する 🚀"
    );
  });

  it("handles empty strings without throwing and preserves the exact template", () => {
    expect(composeRedirectObjective("", "")).toBe(
      "REDIRECT: \n\nOriginal objective (superseded, preserve completed work): "
    );
  });
});

// ---------------------------------------------------------------------------
// interruptKey — full phase x key transition matrix
// ---------------------------------------------------------------------------

describe("interruptKey: idle phase", () => {
  it("every key is a no-op while idle", () => {
    const s = interruptInit();
    for (const key of ["r", "a", "d", "i", "y", "n", "\r", "\x1b", "x", "1"]) {
      const { state, intent } = interruptKey(s, key);
      expect(state).toBe(s);
      expect(intent).toBeNull();
    }
  });
});

describe("interruptKey: menu phase", () => {
  it("'r' emits resume and resets to idle", () => {
    const { state, intent } = interruptKey(openedMenu(), "r");
    expect(intent).toEqual<InterruptIntent>({ kind: "resume" });
    expect(state).toEqual({ phase: "idle", goalId: null, objective: "", instruction: "" });
  });

  it("'a' transitions to confirm-abort without emitting an intent", () => {
    const { state, intent } = interruptKey(openedMenu(), "a");
    expect(intent).toBeNull();
    expect(state.phase).toBe("confirm-abort");
    expect(state.goalId).toBe("goal-1");
  });

  it("'d' transitions to redirect with a cleared instruction, no intent", () => {
    const { state, intent } = interruptKey(openedMenu(), "d");
    expect(intent).toBeNull();
    expect(state.phase).toBe("redirect");
    expect(state.instruction).toBe("");
  });

  it("'i' also transitions to redirect (alias of 'd')", () => {
    const { state, intent } = interruptKey(openedMenu(), "i");
    expect(intent).toBeNull();
    expect(state.phase).toBe("redirect");
  });

  it("unrecognized keys in the menu are no-ops (same reference, null intent)", () => {
    const s = openedMenu();
    for (const key of ["x", "1", "\r", "\x1b", "escape", "y", "n", " "]) {
      const { state, intent } = interruptKey(s, key);
      expect(state).toBe(s);
      expect(intent).toBeNull();
    }
  });
});

describe("interruptKey: confirm-abort phase", () => {
  function confirmAbortState(): InterruptState {
    return interruptKey(openedMenu(), "a").state;
  }

  it("'y' emits abort with the goalId and resets to idle", () => {
    const { state, intent } = interruptKey(confirmAbortState(), "y");
    expect(intent).toEqual<InterruptIntent>({ kind: "abort", goalId: "goal-1" });
    expect(state).toEqual({ phase: "idle", goalId: null, objective: "", instruction: "" });
  });

  it("Enter also confirms abort (alias of 'y')", () => {
    const { state, intent } = interruptKey(confirmAbortState(), "\r");
    expect(intent).toEqual<InterruptIntent>({ kind: "abort", goalId: "goal-1" });
    expect(state.phase).toBe("idle");
  });

  it("'n' returns to the menu without emitting an intent", () => {
    const { state, intent } = interruptKey(confirmAbortState(), "n");
    expect(intent).toBeNull();
    expect(state.phase).toBe("menu");
    expect(state.goalId).toBe("goal-1");
    expect(state.objective).toBe("ship the feature");
  });

  it("Esc also returns to the menu (alias of 'n')", () => {
    const { state, intent } = interruptKey(confirmAbortState(), "\x1b");
    expect(intent).toBeNull();
    expect(state.phase).toBe("menu");
  });

  it("no single keystroke can kill the goal directly from the menu — 'a' alone never emits abort", () => {
    const { intent } = interruptKey(openedMenu(), "a");
    expect(intent).toBeNull();
  });

  it("unrecognized keys in confirm-abort are no-ops", () => {
    const s = confirmAbortState();
    for (const key of ["x", "1", "d", "i", "r", " "]) {
      const { state, intent } = interruptKey(s, key);
      expect(state).toBe(s);
      expect(intent).toBeNull();
    }
  });
});

describe("interruptKey: redirect phase", () => {
  function redirectState(): InterruptState {
    return interruptKey(openedMenu(), "d").state;
  }

  it("printable characters append to the instruction one code point at a time", () => {
    let s = redirectState();
    for (const ch of "focus on tests") {
      s = interruptKey(s, ch).state;
    }
    expect(s.instruction).toBe("focus on tests");
    expect(s.phase).toBe("redirect");
  });

  it("Backspace removes the last code point", () => {
    let s = redirectState();
    s = interruptKey(s, "a").state;
    s = interruptKey(s, "b").state;
    s = interruptKey(s, "c").state;
    s = interruptKey(s, "\x7f").state;
    expect(s.instruction).toBe("ab");
  });

  it("Backspace on an empty instruction is a no-op", () => {
    const s = redirectState();
    const { state, intent } = interruptKey(s, "\x7f");
    expect(state).toBe(s);
    expect(intent).toBeNull();
  });

  it("Backspace is unicode-safe (removes one code point, not one UTF-16 unit)", () => {
    let s = redirectState();
    s = interruptKey(s, "a").state;
    s = interruptKey(s, "🚀").state;
    expect(s.instruction).toBe("a🚀");
    s = interruptKey(s, "\x7f").state;
    expect(s.instruction).toBe("a");
  });

  it("Enter with an empty instruction never emits an intent and stays in redirect", () => {
    const s = redirectState();
    const { state, intent } = interruptKey(s, "\r");
    expect(intent).toBeNull();
    expect(state.phase).toBe("redirect");
  });

  it("Enter with a non-empty instruction emits redirect using composeRedirectObjective, then resets to idle", () => {
    let s = redirectState();
    for (const ch of "pivot now") s = interruptKey(s, ch).state;
    const { state, intent } = interruptKey(s, "\r");
    expect(intent).toEqual<InterruptIntent>({
      kind: "redirect",
      goalId: "goal-1",
      objective: composeRedirectObjective("ship the feature", "pivot now"),
    });
    expect(state).toEqual({ phase: "idle", goalId: null, objective: "", instruction: "" });
  });

  it("Esc discards the draft instruction and returns to the menu", () => {
    let s = redirectState();
    for (const ch of "abandoned draft") s = interruptKey(s, ch).state;
    const { state, intent } = interruptKey(s, "\x1b");
    expect(intent).toBeNull();
    expect(state.phase).toBe("menu");
    expect(state.instruction).toBe("");
    expect(state.goalId).toBe("goal-1");
  });

  it("control characters and multi-char garbage are rejected, never appended", () => {
    let s = redirectState();
    for (const bad of ["\x01", "\x07", "\x1b[31m", "ab"]) {
      const before = s;
      s = interruptKey(s, bad).state;
      expect(s).toBe(before);
    }
    expect(s.instruction).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Purity / no shared mutation across the reducer surface
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("interruptKey never mutates its input state object", () => {
    const s = deepFreeze(openedMenu());
    expect(() => interruptKey(s, "d")).not.toThrow();
    expect(() => interruptKey(s, "a")).not.toThrow();
    expect(() => interruptKey(s, "r")).not.toThrow();
  });

  it("repeated calls with the same input produce equal (not identical mutated) output", () => {
    const s = openedMenu();
    const a = interruptKey(s, "d").state;
    const b = interruptKey(s, "d").state;
    expect(a).toEqual(b);
    expect(a).not.toBe(s);
  });
});

// ---------------------------------------------------------------------------
// Fuzz: invariants hold across random key sequences from any phase
// ---------------------------------------------------------------------------

describe("fuzz", () => {
  const ALL_KEYS = ["r", "a", "d", "i", "y", "n", "\r", "\x7f", "\x1b", "x", "1", " ", "🚀", "\x01", "ab"];

  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("phase is always one of the four valid values, goalId is null iff idle, intents only carry the open goal's id", () => {
    const rnd = mulberry32(12345);
    for (let trial = 0; trial < 50; trial++) {
      let s = interruptInit();
      for (let step = 0; step < 60; step++) {
        // Occasionally (re)open on a running goal, mostly feed random keys.
        if (rnd() < 0.08) {
          s = interruptOpen(s, { goalId: `g-${trial}`, objective: `objective ${trial}` });
        } else {
          const key = ALL_KEYS[Math.floor(rnd() * ALL_KEYS.length)]!;
          const { state, intent } = interruptKey(s, key);
          expect(["idle", "menu", "redirect", "confirm-abort"]).toContain(state.phase);
          expect(state.phase === "idle").toBe(state.goalId === null);
          if (intent && intent.kind !== "resume") {
            expect(intent.goalId).toBe(`g-${trial}`);
          }
          if (intent) {
            expect(state.phase).toBe("idle");
          }
          s = state;
        }
      }
    }
  });
});
