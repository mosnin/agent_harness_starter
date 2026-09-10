import { describe, it, expect } from "vitest";
import {
  parseChord,
  parseSequence,
  formatChord,
  formatSequence,
  matchChord,
  KeymapRegistry,
  KeyDispatcher,
  defaultBindings,
  isDestructiveCommandKind,
  moveFocus,
  typeAhead,
  focusAttrs,
  ConflictError,
  type Chord,
  type KeyBinding,
  type KeyContext,
  type KeyEventLike,
  type Platform,
} from "../ui/keyboard-nav";
import { NAV, type NavKey } from "../ui/shell";
import { isCommand } from "../ipc/contract";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    nav: "run",
    overlayOpen: false,
    paletteOpen: false,
    editing: false,
    running: false,
    listSize: 5,
    listIndex: 0,
    platform: "other",
    ...overrides,
  };
}

function ev(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key: "a", ...overrides };
}

function freshDispatcher(opts: { platform?: Platform; sequenceTimeoutMs?: number; now?: () => number } = {}) {
  const registry = new KeymapRegistry(defaultBindings());
  const dispatcher = new KeyDispatcher({
    registry,
    platform: opts.platform ?? "other",
    sequenceTimeoutMs: opts.sequenceTimeoutMs,
    now: opts.now,
  });
  return { registry, dispatcher };
}

// ---------------------------------------------------------------------------
// parseChord / parseSequence
// ---------------------------------------------------------------------------

describe("parseChord", () => {
  it("parses a bare key with no modifiers", () => {
    expect(parseChord("k")).toEqual({ key: "k" });
  });

  it("parses mod+key", () => {
    expect(parseChord("mod+k")).toEqual({ key: "k", mod: true });
  });

  it("parses shift+/ (a punctuation key)", () => {
    expect(parseChord("shift+/")).toEqual({ key: "/", shift: true });
  });

  it("parses modifiers in any order", () => {
    expect(parseChord("shift+mod+q")).toEqual({ key: "q", mod: true, shift: true });
    expect(parseChord("mod+shift+alt+q")).toEqual({ key: "q", mod: true, shift: true, alt: true });
  });

  it("normalizes named keys via aliases", () => {
    expect(parseChord("esc")).toEqual({ key: "Escape" });
    expect(parseChord("enter")).toEqual({ key: "Enter" });
    expect(parseChord("mod+enter")).toEqual({ key: "Enter", mod: true });
    expect(parseChord("down")).toEqual({ key: "ArrowDown" });
  });

  it("lower-cases single-character keys so case is carried by shift, not the key", () => {
    expect(parseChord("K")).toEqual({ key: "k" });
    expect(parseChord("shift+g")).toEqual({ key: "g", shift: true });
  });

  it("rejects an empty spec", () => {
    expect(() => parseChord("")).toThrow();
    expect(() => parseChord("   ")).toThrow();
  });

  it("rejects an unknown modifier token", () => {
    expect(() => parseChord("ctrlx+k")).toThrow();
  });

  it("rejects a spec containing whitespace — that is a sequence, not a chord", () => {
    expect(() => parseChord("g r")).toThrow();
  });
});

describe("parseSequence", () => {
  it("splits 'g r' into two single-key chords", () => {
    expect(parseSequence("g r")).toEqual([{ key: "g" }, { key: "r" }]);
  });

  it("parses a sequence whose chords carry their own modifiers", () => {
    expect(parseSequence("g shift+g")).toEqual([{ key: "g" }, { key: "g", shift: true }]);
  });

  it("collapses extra internal whitespace", () => {
    expect(parseSequence("g    r")).toEqual([{ key: "g" }, { key: "r" }]);
  });

  it("rejects an empty spec", () => {
    expect(() => parseSequence("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatChord — platform correctness
// ---------------------------------------------------------------------------

describe("formatChord", () => {
  it("renders mod+k as ⌘K on mac and Ctrl+K elsewhere", () => {
    const c = parseChord("mod+k");
    expect(formatChord(c, "mac")).toBe("⌘K");
    expect(formatChord(c, "other")).toBe("Ctrl+K");
  });

  it("renders modifier glyphs vs textual names", () => {
    const c = parseChord("mod+shift+alt+q");
    expect(formatChord(c, "mac")).toBe("⌘⇧⌥Q");
    expect(formatChord(c, "other")).toBe("Ctrl+Shift+Alt+Q");
  });

  it("renders named keys distinctly from letters", () => {
    expect(formatChord(parseChord("esc"), "mac")).toBe("Esc");
    expect(formatChord(parseChord("mod+enter"), "other")).toBe("Ctrl+Enter");
  });

  it("uppercases bare single-character keys for display", () => {
    expect(formatChord(parseChord("j"), "other")).toBe("J");
  });

  it("formatSequence joins a multi-chord sequence with spaces", () => {
    expect(formatSequence(parseSequence("g r"), "other")).toBe("G R");
  });
});

// ---------------------------------------------------------------------------
// matchChord — platform correctness, the mac/ctrl trap
// ---------------------------------------------------------------------------

describe("matchChord", () => {
  it("matches mod+k against metaKey on mac", () => {
    const c = parseChord("mod+k");
    expect(matchChord(ev({ key: "k", metaKey: true }), c, "mac")).toBe(true);
  });

  it("does NOT match a mod binding when only ctrlKey is held on mac", () => {
    const c = parseChord("mod+k");
    expect(matchChord(ev({ key: "k", ctrlKey: true }), c, "mac")).toBe(false);
  });

  it("matches mod+k against ctrlKey (not metaKey) on other platforms", () => {
    const c = parseChord("mod+k");
    expect(matchChord(ev({ key: "k", ctrlKey: true }), c, "other")).toBe(true);
    expect(matchChord(ev({ key: "k", metaKey: true }), c, "other")).toBe(false);
  });

  it("requires an exact modifier match, not a superset", () => {
    const c = parseChord("k");
    expect(matchChord(ev({ key: "k", shiftKey: true }), c, "other")).toBe(false);
    expect(matchChord(ev({ key: "k" }), c, "other")).toBe(true);
  });

  it("never matches a bare modifier keypress", () => {
    const c = parseChord("mod+k");
    expect(matchChord(ev({ key: "Meta", metaKey: true }), c, "mac")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KeymapRegistry
// ---------------------------------------------------------------------------

describe("KeymapRegistry", () => {
  function binding(id: string, overrides: Partial<KeyBinding> = {}): KeyBinding {
    return {
      id,
      scope: "global",
      sequence: [{ key: "x" }],
      action: { type: "focus", op: "next" },
      label: id,
      group: "Test",
      ...overrides,
    };
  }

  it("registers and lists bindings", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("a"));
    reg.register(binding("b", { sequence: [{ key: "y" }] }));
    expect(reg.bindings().map((b) => b.id).sort()).toEqual(["a", "b"]);
  });

  it("throws ConflictError on a duplicate (scope, sequence) pair and surfaces it via conflicts()", () => {
    const reg = new KeymapRegistry();
    const a = binding("first", { sequence: [{ key: "x" }] });
    const b = binding("second", { sequence: [{ key: "x" }] });
    reg.register(a);
    expect(() => reg.register(b)).toThrow(ConflictError);
    const conflicts = reg.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].a.id).toBe("first");
    expect(conflicts[0].b.id).toBe("second");
    // The rejected binding never actually joined the registry.
    expect(reg.bindings().map((x) => x.id)).toEqual(["first"]);
  });

  it("does not conflict across different scopes with the same sequence", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("nav-x", { scope: "nav", sequence: [{ key: "x" }] }));
    expect(() => reg.register(binding("list-x", { scope: "list", sequence: [{ key: "x" }] }))).not.toThrow();
    expect(reg.conflicts()).toHaveLength(0);
  });

  it("does not conflict on sequences that merely share a prefix", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("g", { sequence: [{ key: "g" }, { key: "r" }] }));
    expect(() => reg.register(binding("g2", { sequence: [{ key: "g" }, { key: "t" }] }))).not.toThrow();
  });

  it("distinguishes chords that differ only by modifier", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("plain", { sequence: [{ key: "g" }] }));
    expect(() => reg.register(binding("shifted", { sequence: [{ key: "g", shift: true }] }))).not.toThrow();
  });

  it("unregister removes a binding and frees its sequence slot", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("a", { sequence: [{ key: "x" }] }));
    expect(reg.unregister("a")).toBe(true);
    expect(reg.unregister("a")).toBe(false);
    expect(reg.bindings()).toHaveLength(0);
    expect(() => reg.register(binding("b", { sequence: [{ key: "x" }] }))).not.toThrow();
  });

  it("bindings(scope) filters to just that scope", () => {
    const reg = new KeymapRegistry();
    reg.register(binding("g1", { scope: "global", sequence: [{ key: "1" }] }));
    reg.register(binding("l1", { scope: "list", sequence: [{ key: "2" }] }));
    expect(reg.bindings("global").map((b) => b.id)).toEqual(["g1"]);
    expect(reg.bindings("list").map((b) => b.id)).toEqual(["l1"]);
  });

  it("rejects a binding with an empty sequence", () => {
    const reg = new KeymapRegistry();
    expect(() => reg.register(binding("empty", { sequence: [] }))).toThrow();
  });

  it("the constructor form registers an initial list and still throws on internal duplicates", () => {
    expect(() => new KeymapRegistry()).not.toThrow();
    expect(
      () =>
        new KeymapRegistry([
          binding("a", { sequence: [{ key: "x" }] }),
          binding("b", { sequence: [{ key: "x" }] }),
        ])
    ).toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// defaultBindings — comprehensiveness
// ---------------------------------------------------------------------------

describe("defaultBindings", () => {
  it("registers cleanly with no internal conflicts", () => {
    expect(() => new KeymapRegistry(defaultBindings())).not.toThrow();
  });

  it("covers every NavKey from the real shell.ts NAV table via a 'g <letter>' nav binding", () => {
    const bindings = defaultBindings();
    for (const item of NAV) {
      const match = bindings.find(
        (b) => b.scope === "nav" && b.action.type === "nav" && b.action.to === item.key && b.sequence.length === 2 && b.sequence[0].key === "g"
      );
      expect(match, `expected a "g <letter>" binding for NavKey "${item.key}"`).toBeTruthy();
    }
  });

  it("covers every NavKey from NAV via a mod+<1..8> binding", () => {
    const bindings = defaultBindings();
    NAV.forEach((item, index) => {
      const match = bindings.find(
        (b) =>
          b.scope === "nav" &&
          b.action.type === "nav" &&
          b.action.to === item.key &&
          b.sequence.length === 1 &&
          b.sequence[0].mod === true &&
          b.sequence[0].key === String(index + 1)
      );
      expect(match, `expected a mod+${index + 1} binding for NavKey "${item.key}"`).toBeTruthy();
    });
  });

  it("every nav binding actually drives the dispatcher to the right NavKey", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    for (const item of NAV) {
      dispatcher.reset();
      const result = dispatcher.handle(ev({ key: "g" }), ctx());
      expect(result.action).toBeNull();
      expect(result.pending).toHaveLength(1);

      const reg = new KeymapRegistry(defaultBindings());
      const gLetter = reg
        .bindings("nav")
        .find((b) => b.action.type === "nav" && b.action.to === item.key && b.sequence.length === 2)!
        .sequence[1].key;

      const second = dispatcher.handle(ev({ key: gLetter }), ctx());
      expect(second.action).toEqual({ type: "nav", to: item.key });
      expect(second.preventDefault).toBe(true);
    }
  });

  it("no NavKey shares its 'g <letter>' second key with any other NavKey", () => {
    const bindings = defaultBindings().filter(
      (b) => b.scope === "nav" && b.sequence.length === 2 && b.sequence[0].key === "g"
    );
    const letters = bindings.map((b) => b.sequence[1].key);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("never assigns 'g' as the nav mnemonic letter (reserved for list 'g g')", () => {
    const bindings = defaultBindings().filter(
      (b) => b.scope === "nav" && b.sequence.length === 2 && b.sequence[0].key === "g"
    );
    for (const b of bindings) {
      expect(b.sequence[1].key).not.toBe("g");
    }
  });

  it("every command action produced by a default binding is a valid wire Command", () => {
    for (const b of defaultBindings()) {
      if (b.action.type === "command") {
        expect(isCommand(b.action.command)).toBe(true);
      }
    }
  });

  it("destructive commands are never bound to a bare, unmodified letter", () => {
    for (const b of defaultBindings()) {
      if (b.action.type !== "command") continue;
      if (!isDestructiveCommandKind(b.action.command.kind)) continue;
      const last = b.sequence[b.sequence.length - 1];
      const guarded = !!last.mod || !!last.shift || !!last.alt || b.sequence.length > 1;
      expect(guarded, `destructive binding "${b.id}" must require a modifier or a multi-chord sequence`).toBe(true);
    }
  });

  it("has no duplicate binding ids", () => {
    const ids = defaultBindings().map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — sequence state machine
// ---------------------------------------------------------------------------

describe("KeyDispatcher sequences", () => {
  it("g then r navigates to run", () => {
    const { dispatcher } = freshDispatcher();
    const first = dispatcher.handle(ev({ key: "g" }), ctx());
    expect(first.action).toBeNull();
    expect(first.pending).toEqual([{ key: "g" }]);
    expect(first.preventDefault).toBe(true);

    const second = dispatcher.handle(ev({ key: "r" }), ctx());
    expect(second.action).toEqual({ type: "nav", to: "run" });
    expect(second.pending).toEqual([]);
  });

  it("disambiguates g g (list: first) from g r (nav: run)", () => {
    const { dispatcher } = freshDispatcher();
    dispatcher.handle(ev({ key: "g" }), ctx());
    const gg = dispatcher.handle(ev({ key: "g" }), ctx());
    expect(gg.action).toEqual({ type: "focus", op: "first" });

    dispatcher.reset();
    dispatcher.handle(ev({ key: "g" }), ctx());
    const gr = dispatcher.handle(ev({ key: "r" }), ctx());
    expect(gr.action).toEqual({ type: "nav", to: "run" });
  });

  it("an unknown continuation resets cleanly and reports preventDefault:false", () => {
    const { dispatcher } = freshDispatcher();
    dispatcher.handle(ev({ key: "g" }), ctx());
    const result = dispatcher.handle(ev({ key: "z" }), ctx());
    expect(result.action).toBeNull();
    expect(result.pending).toEqual([]);
    expect(result.preventDefault).toBe(false);
    expect(dispatcher.pending()).toEqual([]);
  });

  it("g then a 2s pause then r does NOT navigate (sequence times out)", () => {
    let now = 0;
    const { dispatcher } = freshDispatcher({ sequenceTimeoutMs: 2000, now: () => now });
    dispatcher.handle(ev({ key: "g" }), ctx());
    expect(dispatcher.pending()).toEqual([{ key: "g" }]);

    now += 2000; // exactly at the boundary — treated as expired
    const result = dispatcher.handle(ev({ key: "r" }), ctx());
    // The stale "g" was dropped, so this "r" is evaluated fresh — it does
    // NOT complete the "g r" (go to run) sequence. It resolves to whatever
    // "r" is bound to on its own (view.refresh), never to the nav action.
    expect(result.action).not.toEqual({ type: "nav", to: "run" });
    expect(result.action).toEqual({ type: "view", op: "refresh" });
    expect(dispatcher.pending()).toEqual([]);
  });

  it("does not expire a sequence just under the timeout boundary", () => {
    let now = 0;
    const { dispatcher } = freshDispatcher({ sequenceTimeoutMs: 2000, now: () => now });
    dispatcher.handle(ev({ key: "g" }), ctx());
    now += 1999;
    const result = dispatcher.handle(ev({ key: "r" }), ctx());
    expect(result.action).toEqual({ type: "nav", to: "run" });
  });

  it("reset() clears any pending sequence", () => {
    const { dispatcher } = freshDispatcher();
    dispatcher.handle(ev({ key: "g" }), ctx());
    expect(dispatcher.pending()).toEqual([{ key: "g" }]);
    dispatcher.reset();
    expect(dispatcher.pending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — Escape unwind order
// ---------------------------------------------------------------------------

describe("KeyDispatcher Escape unwind order", () => {
  it("closes the overlay first when both overlay and palette are open", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "Escape" }), ctx({ overlayOpen: true, paletteOpen: true }));
    expect(result.action).toEqual({ type: "help", op: "close" });
    expect(result.preventDefault).toBe(true);
  });

  it("closes the palette when no overlay is open", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "Escape" }), ctx({ paletteOpen: true }));
    expect(result.action).toEqual({ type: "palette", op: "close" });
  });

  it("clears a pending sequence when neither overlay nor palette is open", () => {
    const { dispatcher } = freshDispatcher();
    dispatcher.handle(ev({ key: "g" }), ctx());
    expect(dispatcher.pending()).toEqual([{ key: "g" }]);
    const result = dispatcher.handle(ev({ key: "Escape" }), ctx());
    expect(dispatcher.pending()).toEqual([]);
    expect(result.action).toEqual({ type: "focus", op: "escape" });
  });

  it("falls through to a focus-escape action with nothing open and nothing pending", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "Escape" }), ctx());
    expect(result.action).toEqual({ type: "focus", op: "escape" });
  });

  it("Escape works even while a text field is focused", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(
      ev({ key: "Escape", targetTag: "input" }),
      ctx({ editing: true, paletteOpen: true })
    );
    expect(result.action).toEqual({ type: "palette", op: "close" });
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — text-entry guard
// ---------------------------------------------------------------------------

describe("KeyDispatcher editable guard", () => {
  it("blocks a bare 'g' while ctx.editing is true", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "g" }), ctx({ editing: true }));
    expect(result.action).toBeNull();
    expect(result.preventDefault).toBe(false);
  });

  it("blocks a bare 'g' when targeting an <input>", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "g", targetTag: "input" }), ctx());
    expect(result.action).toBeNull();
  });

  it("blocks a bare 'g' when targeting a <textarea>", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "g", targetTag: "textarea" }), ctx());
    expect(result.action).toBeNull();
  });

  it("blocks a bare 'g' when targeting a contenteditable element", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "g", targetEditable: true, targetTag: "div" }), ctx());
    expect(result.action).toBeNull();
  });

  it("blocks a bare 'g' typed into the command palette's query field", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(
      ev({ key: "g", targetTag: "input" }),
      ctx({ paletteOpen: true, editing: true })
    );
    expect(result.action).toBeNull();
  });

  it("does NOT navigate — sequence state stays clean — after a blocked keystroke", () => {
    const { dispatcher } = freshDispatcher();
    dispatcher.handle(ev({ key: "g", targetTag: "input" }), ctx());
    expect(dispatcher.pending()).toEqual([]);
    const result = dispatcher.handle(ev({ key: "r", targetTag: "input" }), ctx());
    expect(result.action).toBeNull();
  });

  it("mod+k still opens the palette while a text field is focused", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const result = dispatcher.handle(ev({ key: "k", ctrlKey: true, targetTag: "input" }), ctx({ editing: true }));
    expect(result.action).toEqual({ type: "palette", op: "open" });
  });

  it("mod+enter still fires while typing (runtime not running)", () => {
    const { dispatcher } = freshDispatcher({ platform: "mac" });
    const result = dispatcher.handle(
      ev({ key: "Enter", metaKey: true, targetTag: "textarea" }),
      ctx({ editing: true, running: false })
    );
    expect(result.action).toEqual({
      type: "command",
      command: { kind: "runtime.start", mode: "inline", poolSize: 3 },
    });
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — overlay/palette exclusivity
// ---------------------------------------------------------------------------

describe("KeyDispatcher scope exclusivity", () => {
  it("does not fire list/nav bindings while the help overlay is open", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "j" }), ctx({ overlayOpen: true }));
    expect(result.action).toBeNull();
  });

  it("does not fire list/nav bindings while the palette is open", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "j" }), ctx({ paletteOpen: true }));
    expect(result.action).toBeNull();
  });

  it("still fires global bindings while the palette is open", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const result = dispatcher.handle(ev({ key: "k", ctrlKey: true }), ctx({ paletteOpen: true }));
    expect(result.action).toEqual({ type: "palette", op: "open" });
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — repeat handling
// ---------------------------------------------------------------------------

describe("KeyDispatcher key-repeat", () => {
  it("allows repeat for motion (holding j keeps moving)", () => {
    const { dispatcher } = freshDispatcher();
    const result = dispatcher.handle(ev({ key: "j", repeat: true }), ctx());
    expect(result.action).toEqual({ type: "focus", op: "next" });
  });

  it("ignores repeat for a destructive command binding", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const result = dispatcher.handle(
      ev({ key: "q", ctrlKey: true, shiftKey: true, repeat: true }),
      ctx({ running: true })
    );
    expect(result.action).toBeNull();
    expect(result.preventDefault).toBe(true);
  });

  it("the same destructive chord fires normally without repeat", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const result = dispatcher.handle(ev({ key: "q", ctrlKey: true, shiftKey: true }), ctx({ running: true }));
    expect(result.action).toEqual({ type: "command", command: { kind: "runtime.stop" } });
  });

  it("ignores repeat for a one-shot palette-open binding", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const result = dispatcher.handle(ev({ key: "k", ctrlKey: true, repeat: true }), ctx());
    expect(result.action).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// KeyDispatcher — when() clauses
// ---------------------------------------------------------------------------

describe("KeyDispatcher when() clauses", () => {
  it("mod+enter (start) only fires when not running", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const running = dispatcher.handle(ev({ key: "Enter", ctrlKey: true }), ctx({ running: true }));
    expect(running.action).toBeNull();
    const stopped = dispatcher.handle(ev({ key: "Enter", ctrlKey: true }), ctx({ running: false }));
    expect(stopped.action).not.toBeNull();
  });

  it("mod+shift+q (stop) only fires when running", () => {
    const { dispatcher } = freshDispatcher({ platform: "other" });
    const stopped = dispatcher.handle(ev({ key: "q", ctrlKey: true, shiftKey: true }), ctx({ running: false }));
    expect(stopped.action).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// moveFocus
// ---------------------------------------------------------------------------

describe("moveFocus", () => {
  it("moves next/prev with wrap by default", () => {
    expect(moveFocus({ size: 3, index: 0 }, "prev")).toEqual({ size: 3, index: 2 });
    expect(moveFocus({ size: 3, index: 2 }, "next")).toEqual({ size: 3, index: 0 });
  });

  it("clamps instead of wrapping when wrap:false", () => {
    expect(moveFocus({ size: 3, index: 0 }, "prev", { wrap: false })).toEqual({ size: 3, index: 0 });
    expect(moveFocus({ size: 3, index: 2 }, "next", { wrap: false })).toEqual({ size: 3, index: 2 });
  });

  it("first/last jump to the ends regardless of wrap", () => {
    expect(moveFocus({ size: 5, index: 2 }, "first")).toEqual({ size: 5, index: 0 });
    expect(moveFocus({ size: 5, index: 2 }, "last")).toEqual({ size: 5, index: 4 });
  });

  it("pageDown/pageUp move by the page size and wrap by default", () => {
    expect(moveFocus({ size: 10, index: 0 }, "pageDown", { page: 4 })).toEqual({ size: 10, index: 4 });
    expect(moveFocus({ size: 10, index: 1 }, "pageUp", { page: 4 })).toEqual({ size: 10, index: 7 });
  });

  it("pageDown clamps at the end when wrap:false", () => {
    expect(moveFocus({ size: 10, index: 8 }, "pageDown", { page: 4, wrap: false })).toEqual({ size: 10, index: 9 });
  });

  it("clamps at size 0: index stays 0, never negative or NaN", () => {
    expect(moveFocus({ size: 0, index: 0 }, "next")).toEqual({ size: 0, index: 0 });
    expect(moveFocus({ size: 0, index: 0 }, "prev")).toEqual({ size: 0, index: 0 });
    expect(moveFocus({ size: 0, index: 0 }, "last")).toEqual({ size: 0, index: 0 });
  });

  it("clamps at size 1: index is always 0 regardless of op", () => {
    expect(moveFocus({ size: 1, index: 0 }, "next")).toEqual({ size: 1, index: 0 });
    expect(moveFocus({ size: 1, index: 0 }, "prev")).toEqual({ size: 1, index: 0 });
    expect(moveFocus({ size: 1, index: 0 }, "pageDown", { page: 3 })).toEqual({ size: 1, index: 0 });
  });
});

// ---------------------------------------------------------------------------
// typeAhead
// ---------------------------------------------------------------------------

describe("typeAhead", () => {
  const items = ["Alpha", "Bravo", "Charlie", "Bandit", "Delta"];

  it("finds the next match after `from`, case-insensitively", () => {
    expect(typeAhead(items, "b", 0)).toBe(1); // "Bravo"
  });

  it("cycles to the next match after the current one", () => {
    expect(typeAhead(items, "b", 1)).toBe(3); // "Bandit", after "Bravo"
  });

  it("wraps around to a match before `from`", () => {
    expect(typeAhead(items, "a", 4)).toBe(0); // wraps to "Alpha"
  });

  it("returns -1 when nothing matches", () => {
    expect(typeAhead(items, "zz", 0)).toBe(-1);
  });

  it("returns -1 for an empty item list or empty buffer", () => {
    expect(typeAhead([], "a", 0)).toBe(-1);
    expect(typeAhead(items, "", 0)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// focusAttrs
// ---------------------------------------------------------------------------

describe("focusAttrs", () => {
  it("marks the active row tabbable and selected", () => {
    const attrs = focusAttrs(2, 2);
    expect(attrs).toContain('tabindex="0"');
    expect(attrs).toContain('aria-selected="true"');
    expect(attrs).toContain('data-focused="true"');
  });

  it("marks inactive rows as -1 / not selected", () => {
    const attrs = focusAttrs(1, 2);
    expect(attrs).toContain('tabindex="-1"');
    expect(attrs).toContain('aria-selected="false"');
    expect(attrs).toContain('data-focused="false"');
  });
});

// ---------------------------------------------------------------------------
// List motion end-to-end through the dispatcher
// ---------------------------------------------------------------------------

describe("list motion via the dispatcher", () => {
  it("j/k, Home/End, g g/G, and Enter/Space all resolve to focus actions", () => {
    const { dispatcher } = freshDispatcher();
    expect(dispatcher.handle(ev({ key: "j" }), ctx()).action).toEqual({ type: "focus", op: "next" });
    expect(dispatcher.handle(ev({ key: "k" }), ctx()).action).toEqual({ type: "focus", op: "prev" });
    expect(dispatcher.handle(ev({ key: "Home" }), ctx()).action).toEqual({ type: "focus", op: "first" });
    expect(dispatcher.handle(ev({ key: "End" }), ctx()).action).toEqual({ type: "focus", op: "last" });
    expect(dispatcher.handle(ev({ key: "PageDown" }), ctx()).action).toEqual({ type: "focus", op: "next" });
    expect(dispatcher.handle(ev({ key: "PageUp" }), ctx()).action).toEqual({ type: "focus", op: "prev" });
    expect(dispatcher.handle(ev({ key: "Enter" }), ctx()).action).toEqual({ type: "focus", op: "activate" });
    expect(dispatcher.handle(ev({ key: " " }), ctx()).action).toEqual({ type: "focus", op: "activate" });
    expect(dispatcher.handle(ev({ key: "G", shiftKey: true }), ctx()).action).toEqual({ type: "focus", op: "last" });

    dispatcher.handle(ev({ key: "g" }), ctx());
    expect(dispatcher.handle(ev({ key: "g" }), ctx()).action).toEqual({ type: "focus", op: "first" });
  });
});
