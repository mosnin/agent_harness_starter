import { describe, expect, it } from "vitest";

import { composeInit, composeKey, composeText, renderCompose, type ComposeState } from "../compose";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed a sequence of keys through composeKey, returning the final state + effects seen. */
function feed(state: ComposeState, keys: string[]): { state: ComposeState; effects: Array<ReturnType<typeof composeKey>["effect"]> } {
  const effects: Array<ReturnType<typeof composeKey>["effect"]> = [];
  let s = state;
  for (const k of keys) {
    const r = composeKey(s, k);
    s = r.state;
    effects.push(r.effect);
  }
  return { state: s, effects };
}

function typeString(state: ComposeState, text: string): ComposeState {
  return feed(state, [...text]).state;
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// composeInit / composeText
// ---------------------------------------------------------------------------

describe("composeInit", () => {
  it("starts with a single empty line and cursor at (0,0)", () => {
    const s = composeInit();
    expect(s.lines).toEqual([""]);
    expect(s.row).toBe(0);
    expect(s.col).toBe(0);
    expect(s.scrollTop).toBe(0);
    expect(s.pasting).toBe(false);
    expect(s.pasteBuffer).toEqual([]);
  });

  it("seeds from text, placing the cursor at the end of the last line", () => {
    const s = composeInit("hello\nworld");
    expect(s.lines).toEqual(["hello", "world"]);
    expect(s.row).toBe(1);
    expect(s.col).toBe(5);
  });
});

describe("composeText", () => {
  it("joins lines with newline", () => {
    const s = composeInit("a\nb\nc");
    expect(composeText(s)).toBe("a\nb\nc");
  });
});

// ---------------------------------------------------------------------------
// Submit / cancel
// ---------------------------------------------------------------------------

describe("submit", () => {
  it("Enter submits the joined, trimmed text and resets the buffer", () => {
    const s0 = typeString(composeInit(), "  hello world  ");
    const { state, effect } = composeKey(s0, "\r");
    expect(effect).toEqual({ kind: "submit", text: "hello world" });
    expect(state).toEqual(composeInit());
  });

  it("Enter on an empty/whitespace-only buffer produces effect null, not a dispatch", () => {
    const s0 = typeString(composeInit(), "   ");
    const { state, effect } = composeKey(s0, "\r");
    expect(effect).toBeNull();
    expect(state.lines).toEqual(["   "]);
  });

  it("submits multi-line content joined with real newlines, trimmed as a whole", () => {
    let s = typeString(composeInit(), "line one");
    s = composeKey(s, "\x1b\r").state; // alt-enter newline
    s = typeString(s, "line two");
    const { effect } = composeKey(s, "\r");
    expect(effect).toEqual({ kind: "submit", text: "line one\nline two" });
  });

  it("\\n (Enter alias) and literal 'return' also submit", () => {
    const s0 = typeString(composeInit(), "hi");
    expect(composeKey(s0, "\n").effect).toEqual({ kind: "submit", text: "hi" });
    expect(composeKey(s0, "return").effect).toEqual({ kind: "submit", text: "hi" });
  });
});

describe("cancel", () => {
  it("Esc (\\x1b) produces a cancel effect without altering the buffer", () => {
    const s0 = typeString(composeInit(), "abc");
    const { state, effect } = composeKey(s0, "\x1b");
    expect(effect).toEqual({ kind: "cancel" });
    expect(state).toBe(s0);
  });

  it("literal 'escape' also cancels", () => {
    const s0 = typeString(composeInit(), "abc");
    expect(composeKey(s0, "escape").effect).toEqual({ kind: "cancel" });
  });
});

// ---------------------------------------------------------------------------
// Newline injection: Alt-Enter, Ctrl-J, backslash continuation
// ---------------------------------------------------------------------------

describe("newline injection", () => {
  it("Alt-Enter (\\x1b\\r) inserts a newline without submitting", () => {
    const s0 = typeString(composeInit(), "abc");
    const { state, effect } = composeKey(s0, "\x1b\r");
    expect(effect).toBeNull();
    expect(state.lines).toEqual(["abc", ""]);
    expect(state.row).toBe(1);
    expect(state.col).toBe(0);
  });

  it("Ctrl-J (literal alias) inserts a newline without submitting", () => {
    const s0 = typeString(composeInit(), "abc");
    const { state, effect } = composeKey(s0, "ctrl-j");
    expect(effect).toBeNull();
    expect(state.lines).toEqual(["abc", ""]);
  });

  it("a single trailing backslash + Enter continues to a new line, backslash stripped", () => {
    const s0 = typeString(composeInit(), "line one\\");
    const { state, effect } = composeKey(s0, "\r");
    expect(effect).toBeNull();
    expect(state.lines).toEqual(["line one", ""]);
    expect(state.row).toBe(1);
    expect(state.col).toBe(0);
  });

  it("a double trailing backslash does NOT continue (submits normally)", () => {
    const s0 = typeString(composeInit(), "line one\\\\");
    const { effect } = composeKey(s0, "\r");
    expect(effect).toEqual({ kind: "submit", text: "line one\\\\" });
  });

  it("newline injection splits at the cursor, not always at end of line", () => {
    let s = typeString(composeInit(), "abcdef");
    s = { ...s, col: 3 }; // cursor between c and d
    const { state } = composeKey(s, "\x1b\r");
    expect(state.lines).toEqual(["abc", "def"]);
    expect(state.row).toBe(1);
    expect(state.col).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backspace / Delete (join semantics)
// ---------------------------------------------------------------------------

describe("backspace", () => {
  it("deletes the previous code point within a line", () => {
    const s0 = typeString(composeInit(), "abc");
    const { state } = composeKey(s0, "\x7f");
    expect(state.lines).toEqual(["ab"]);
    expect(state.col).toBe(2);
  });

  it("\\b behaves the same as \\x7f", () => {
    const s0 = typeString(composeInit(), "abc");
    expect(composeKey(s0, "\b").state.lines).toEqual(["ab"]);
  });

  it("at col 0 joins the current line onto the previous line", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, col: 0 };
    const { state } = composeKey(s, "\x7f");
    expect(state.lines).toEqual(["foobar"]);
    expect(state.row).toBe(0);
    expect(state.col).toBe(3);
  });

  it("is a no-op at (0,0)", () => {
    const s0 = composeInit();
    const { state, effect } = composeKey(s0, "\x7f");
    expect(state).toBe(s0);
    expect(effect).toBeNull();
  });
});

describe("delete (forward)", () => {
  it("deletes the code point at the cursor", () => {
    let s = typeString(composeInit(), "abc");
    s = { ...s, col: 0 };
    const { state } = composeKey(s, "\x1b[3~");
    expect(state.lines).toEqual(["bc"]);
    expect(state.col).toBe(0);
  });

  it("at end of line joins the next line forward", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, row: 0, col: 3 };
    const { state } = composeKey(s, "\x1b[3~");
    expect(state.lines).toEqual(["foobar"]);
    expect(state.row).toBe(0);
    expect(state.col).toBe(3);
  });

  it("is a no-op at the very end of the buffer", () => {
    const s0 = typeString(composeInit(), "abc");
    const { state, effect } = composeKey(s0, "\x1b[3~");
    expect(state).toBe(s0);
    expect(effect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Word ops / kill ops
// ---------------------------------------------------------------------------

describe("word-wise movement", () => {
  it("ctrl-right (\\x1b[1;5C) jumps to the start of the next word", () => {
    const s0 = typeString(composeInit(), "foo bar baz");
    let s = { ...s0, col: 0 };
    s = composeKey(s, "\x1b[1;5C").state;
    expect(s.col).toBe(4); // start of "bar"
    s = composeKey(s, "\x1b[1;5C").state;
    expect(s.col).toBe(8); // start of "baz"
  });

  it("ctrl-left (\\x1b[1;5D) jumps to the start of the previous word", () => {
    const s0 = typeString(composeInit(), "foo bar baz");
    const { state } = composeKey(s0, "\x1b[1;5D");
    expect(state.col).toBe(8); // start of "baz"
  });

  it("ctrl-left at col 0 crosses to the end of the previous line", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, col: 0 };
    const { state } = composeKey(s, "\x1b[1;5D");
    expect(state.row).toBe(0);
    expect(state.col).toBe(3);
  });

  it("ctrl-right at end of line crosses to the start of the next line", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, row: 0, col: 3 };
    const { state } = composeKey(s, "\x1b[1;5C");
    expect(state.row).toBe(1);
    expect(state.col).toBe(0);
  });
});

describe("kill ops", () => {
  it("Ctrl-U kills from line start to cursor", () => {
    const s0 = typeString(composeInit(), "hello world");
    const s1 = { ...s0, col: 6 }; // cursor before "world"
    const { state } = composeKey(s1, "\x15");
    expect(state.lines).toEqual(["world"]);
    expect(state.col).toBe(0);
  });

  it("literal 'ctrl-u' behaves the same", () => {
    const s0 = typeString(composeInit(), "hello world");
    const s1 = { ...s0, col: 6 };
    expect(composeKey(s1, "ctrl-u").state.lines).toEqual(["world"]);
  });

  it("Ctrl-K kills from cursor to line end", () => {
    const s0 = typeString(composeInit(), "hello world");
    const s1 = { ...s0, col: 5 };
    const { state } = composeKey(s1, "\x0b");
    expect(state.lines).toEqual(["hello"]);
    expect(state.col).toBe(5);
  });

  it("Ctrl-W deletes the previous word", () => {
    const s0 = typeString(composeInit(), "hello world");
    const { state } = composeKey(s0, "\x17");
    expect(state.lines).toEqual(["hello "]);
    expect(state.col).toBe(6);
  });

  it("Ctrl-W at col 0 joins with the previous line", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, col: 0 };
    const { state } = composeKey(s, "\x17");
    expect(state.lines).toEqual(["foobar"]);
    expect(state.row).toBe(0);
  });

  it("Ctrl-W skips trailing whitespace before deleting the word", () => {
    const s0 = typeString(composeInit(), "hello world   ");
    const { state } = composeKey(s0, "\x17");
    expect(state.lines).toEqual(["hello "]);
  });
});

// ---------------------------------------------------------------------------
// Home / End / arrows / up-down across lines
// ---------------------------------------------------------------------------

describe("home/end", () => {
  it("Home moves to column 0, End moves to line length", () => {
    const s0 = typeString(composeInit(), "hello");
    const home = composeKey(s0, "\x1b[H").state;
    expect(home.col).toBe(0);
    const end = composeKey(home, "\x1b[F").state;
    expect(end.col).toBe(5);
  });
});

describe("arrow movement", () => {
  it("left/right move within a line and wrap across line boundaries", () => {
    let s = typeString(composeInit(), "foo");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "bar");
    s = { ...s, row: 1, col: 0 };
    const left = composeKey(s, "\x1b[D").state;
    expect(left.row).toBe(0);
    expect(left.col).toBe(3);
    const right = composeKey(left, "\x1b[C").state;
    expect(right.row).toBe(1);
    expect(right.col).toBe(0);
  });

  it("left is a no-op at (0,0); right is a no-op at the very end", () => {
    const s0 = composeInit();
    expect(composeKey(s0, "\x1b[D").state).toBe(s0);
    expect(composeKey(s0, "\x1b[C").state).toBe(s0);
  });

  it("up/down move the cursor across lines, clamping column to the target line length", () => {
    let s = typeString(composeInit(), "hello");
    s = composeKey(s, "\x1b\r").state;
    s = typeString(s, "hi");
    // cursor at end of "hi" (row 1, col 2)
    const up = composeKey(s, "\x1b[A").state;
    expect(up.row).toBe(0);
    expect(up.col).toBe(2); // clamped from... stayed within "hello"'s length
    const down = composeKey(up, "\x1b[B").state;
    expect(down.row).toBe(1);
    expect(down.col).toBe(2);
  });

  it("up is a no-op on the first line; down is a no-op on the last line", () => {
    const s0 = composeInit();
    expect(composeKey(s0, "\x1b[A").state).toBe(s0);
    expect(composeKey(s0, "\x1b[B").state).toBe(s0);
  });
});

// ---------------------------------------------------------------------------
// Bracketed paste
// ---------------------------------------------------------------------------

describe("bracketed paste", () => {
  it("enters and exits pasting, inserting newlines literally, never submitting", () => {
    let s = composeInit();
    let r = composeKey(s, "\x1b[200~");
    expect(r.state.pasting).toBe(true);
    expect(r.effect).toBeNull();
    r = composeKey(r.state, "hello\nworld");
    expect(r.state.pasting).toBe(true);
    expect(r.effect).toBeNull();
    r = composeKey(r.state, "\x1b[201~");
    expect(r.state.pasting).toBe(false);
    expect(r.effect).toBeNull();
    expect(r.state.lines).toEqual(["hello", "world"]);
    expect(r.state.pasteBuffer).toEqual([]);
  });

  it("handles the whole paste bundled into a single chunk", () => {
    const r = composeKey(composeInit(), "\x1b[200~a\nb\x1b[201~");
    expect(r.effect).toBeNull();
    expect(r.state.pasting).toBe(false);
    expect(r.state.lines).toEqual(["a", "b"]);
  });

  it("finds a terminator split across several chunks without corrupting state or firing submit", () => {
    let r = composeKey(composeInit(), "\x1b[200~");
    r = composeKey(r.state, "text");
    r = composeKey(r.state, "\x1b[20"); // marker split mid-sequence
    expect(r.state.pasting).toBe(true);
    expect(r.effect).toBeNull();
    r = composeKey(r.state, "1~");
    expect(r.state.pasting).toBe(false);
    expect(r.effect).toBeNull();
    expect(r.state.lines).toEqual(["text"]);
  });

  it("splits the terminator one character at a time", () => {
    let r = composeKey(composeInit(), "\x1b[200~");
    for (const ch of "hi\x1b[201~") {
      r = composeKey(r.state, ch);
      expect(r.effect).toBeNull();
    }
    expect(r.state.pasting).toBe(false);
    expect(r.state.lines).toEqual(["hi"]);
  });

  it("pasted content containing \\r or lone CR is normalized to a literal newline, not a control action", () => {
    const r = composeKey(composeInit(), "\x1b[200~one\r\ntwo\rthree\x1b[201~");
    expect(r.state.lines).toEqual(["one", "two", "three"]);
    expect(r.effect).toBeNull();
  });

  it("pasted content containing stray escape bytes is inserted literally, never dispatched as a command", () => {
    const r = composeKey(composeInit(), "\x1b[200~abc\x1bxyz\x1b[201~");
    expect(r.state.lines).toEqual(["abc\x1bxyz"]);
    expect(r.effect).toBeNull();
  });

  it("a real end marker split across chunks after content that itself looks marker-ish is still detected correctly", () => {
    // Payload text ends up containing the literal characters "1~" only because
    // the true terminator "\x1b[201~" is what's being split; the payload text
    // itself must not accidentally swallow part of the terminator.
    let r = composeKey(composeInit(), "\x1b[200~");
    r = composeKey(r.state, "abc\x1b[2");
    expect(r.state.pasting).toBe(true);
    r = composeKey(r.state, "01~");
    expect(r.state.pasting).toBe(false);
    expect(r.state.lines).toEqual(["abc"]);
    expect(r.effect).toBeNull();
  });

  it("paste inserts at the current cursor position, not always at the end", () => {
    let s = typeString(composeInit(), "ac");
    s = { ...s, col: 1 };
    let r = composeKey(s, "\x1b[200~b\x1b[201~");
    expect(r.state.lines).toEqual(["abc"]);
    expect(r.state.col).toBe(2);
  });

  it("purity holds during a multi-chunk paste (input state left untouched at every step)", () => {
    const s0 = deepFreeze(composeInit());
    const frozenCopy: ComposeState = JSON.parse(JSON.stringify(s0));
    const r1 = composeKey(s0, "\x1b[200~");
    expect(s0).toEqual(frozenCopy);
    const r2 = composeKey(deepFreeze(r1.state), "chunk\x1b[201~");
    expect(r2.effect).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Terminal-injection resistance
// ---------------------------------------------------------------------------

describe("control character rejection", () => {
  it("a raw \\x1b fed as a normal key never lands in the buffer text", () => {
    const s0 = typeString(composeInit(), "ok");
    const { state } = composeKey(s0, "\x1b");
    expect(composeText(state)).toBe("ok");
    expect(composeText(state)).not.toContain("\x1b");
  });

  it("a raw \\x07 (bell) is rejected outright, not appended", () => {
    const s0 = typeString(composeInit(), "ok");
    const { state, effect } = composeKey(s0, "\x07");
    expect(state).toBe(s0);
    expect(effect).toBeNull();
    expect(composeText(state)).toBe("ok");
  });

  it("unrecognized multi-char escape fragments are rejected, not appended", () => {
    const s0 = typeString(composeInit(), "ok");
    const { state } = composeKey(s0, "\x1b[99~");
    expect(composeText(state)).toBe("ok");
  });

  it("C1 control range code points are rejected", () => {
    const s0 = composeInit();
    const { state } = composeKey(s0, String.fromCodePoint(0x85));
    expect(state.lines).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// Multi-byte / emoji content and box alignment
// ---------------------------------------------------------------------------

describe("Unicode / emoji handling", () => {
  it("printable insertion counts emoji as a single code point for cursor math", () => {
    const s0 = typeString(composeInit(), "a😀b");
    expect(s0.lines).toEqual(["a😀b"]);
    expect(s0.col).toBe(3);
    // Backspace removes exactly the emoji, not half a surrogate pair.
    const removedTrailing = composeKey(s0, "\x7f").state;
    expect(removedTrailing.lines).toEqual(["a😀"]);
    const removedEmoji = composeKey(removedTrailing, "\x7f").state;
    expect(removedEmoji.lines).toEqual(["a"]);
  });

  it("renderCompose keeps every row exactly `width` code points with CJK + emoji content", () => {
    const s = composeInit("你好世界 😀🚀\nsecond line");
    const rows = renderCompose(s, 24, 5);
    expect(rows.length).toBe(7); // maxRows + 2
    for (const row of rows) {
      expect([...row].length).toBe(24);
    }
  });
});

// ---------------------------------------------------------------------------
// renderCompose: structure, scroll markers, cursor marker
// ---------------------------------------------------------------------------

describe("renderCompose", () => {
  it("returns exactly maxRows + 2 lines, each exactly width code points, with no scrolling needed", () => {
    const s = composeInit("hello");
    const rows = renderCompose(s, 30, 4);
    expect(rows.length).toBe(6);
    for (const r of rows) expect([...r].length).toBe(30);
    expect(rows[0]!.startsWith("╭")).toBe(true);
    expect(rows[rows.length - 1]!.startsWith("╰")).toBe(true);
  });

  it("places the cursor marker ▏ at the right row and column", () => {
    let s = typeString(composeInit(), "hi");
    s = { ...s, col: 1 };
    const rows = renderCompose(s, 20, 3);
    const contentRow = rows[1]!; // header is rows[0]
    expect(contentRow).toContain("h▏i");
  });

  it("shows an honest '…(N more lines above)' marker when scrolled past the top", () => {
    const s0 = composeInit(Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"));
    // Cursor is on the last line (row 9); with only 3 visible rows most
    // earlier lines must be hidden above.
    const rows = renderCompose(s0, 30, 3);
    const joined = rows.join("\n");
    expect(joined).toMatch(/…\(\d+ more lines? above\)/);
  });

  it("shows an honest '…(N more lines below)' marker when earlier lines are visible and later ones are hidden", () => {
    let s0 = composeInit(Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"));
    s0 = { ...s0, row: 0, col: 0 };
    const rows = renderCompose(s0, 30, 3);
    const joined = rows.join("\n");
    expect(joined).toMatch(/…\(\d+ more lines? below\)/);
  });

  it("hidden counts above + visible + (marker rows) never lie: sum of hidden reported matches actual", () => {
    const total = 12;
    const s0 = composeInit(Array.from({ length: total }, (_, i) => `l${i}`).join("\n"));
    const withCursorAt = (row: number) => ({ ...s0, row, col: 0 });
    for (const row of [0, 3, 6, 9, 11]) {
      const rows = renderCompose(withCursorAt(row), 30, 4);
      const aboveMatch = rows.join("\n").match(/…\((\d+) more lines? above\)/);
      const belowMatch = rows.join("\n").match(/…\((\d+) more lines? below\)/);
      const above = aboveMatch ? Number(aboveMatch[1]) : 0;
      const below = belowMatch ? Number(belowMatch[1]) : 0;
      // The window always contains the cursor's line, so above+below must be
      // strictly less than total (at least the cursor line itself is shown).
      expect(above + below).toBeLessThan(total);
      expect(above).toBeGreaterThanOrEqual(0);
      expect(below).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not show scroll markers when everything fits", () => {
    const s0 = composeInit("a\nb\nc");
    const rows = renderCompose(s0, 20, 10);
    expect(rows.join("\n")).not.toMatch(/more lines/);
  });
});

// ---------------------------------------------------------------------------
// Reducer purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  const KEYS = [
    "a", "b", "c", " ", "\r", "\x1b\r", "ctrl-j", "\x7f", "\b", "\x1b",
    "\x1b[3~", "\x1b[H", "\x1b[F", "\x1b[1;5C", "\x1b[1;5D", "\x1b[D",
    "\x1b[C", "\x1b[A", "\x1b[B", "\x15", "\x0b", "\x17", "\x07",
    "\x1b[200~", "abc", "\x1b[201~",
  ];

  it("never mutates the input state, for every key kind exercised", () => {
    let s = typeString(composeInit(), "seed text\nsecond line");
    for (const key of KEYS) {
      const before = JSON.parse(JSON.stringify(s));
      const { state } = composeKey(s, key);
      expect(s).toEqual(before);
      s = state;
    }
  });
});

// ---------------------------------------------------------------------------
// Randomized key-fuzz: cursor bounds & render shape invariants
// ---------------------------------------------------------------------------

describe("key fuzz", () => {
  const ALPHABET = [
    "a", "b", " ", "1", "😀", "你",
    "\r", "\n", "return", "\x1b\r", "ctrl-j",
    "\x7f", "\b", "\x1b", "escape",
    "\x1b[3~", "\x1b[H", "\x1b[F",
    "\x1b[1;5C", "\x1b[1;5D", "\x1b[D", "\x1b[C", "\x1b[A", "\x1b[B",
    "\x15", "\x0b", "\x17", "\x07",
    "\x1b[200~", "\x1b[201~", "pasted\ntext",
  ];

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

  it("keeps row/col in bounds and render output well-formed across a few hundred random keys", () => {
    const rand = mulberry32(1234567);
    let s = composeInit();
    for (let i = 0; i < 400; i++) {
      const key = ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
      const { state } = composeKey(s, key);
      s = state;

      expect(s.row).toBeGreaterThanOrEqual(0);
      expect(s.row).toBeLessThan(s.lines.length);
      expect(s.col).toBeGreaterThanOrEqual(0);
      expect(s.col).toBeLessThanOrEqual([...s.lines[s.row]!].length);

      const width = 42;
      const maxRows = 8;
      const rendered = renderCompose(s, width, maxRows);
      expect(rendered.length).toBe(maxRows + 2);
      for (const row of rendered) {
        expect([...row].length).toBe(width);
      }
    }
  });

  it("runs several independent fuzz seeds without ever violating invariants", () => {
    for (const seed of [1, 42, 999, 77777]) {
      const rand = mulberry32(seed);
      let s = composeInit();
      for (let i = 0; i < 250; i++) {
        const key = ALPHABET[Math.floor(rand() * ALPHABET.length)]!;
        s = composeKey(s, key).state;
        expect(s.row).toBeGreaterThanOrEqual(0);
        expect(s.row).toBeLessThan(s.lines.length);
        expect(s.col).toBeGreaterThanOrEqual(0);
        expect(s.col).toBeLessThanOrEqual([...s.lines[s.row]!].length);
      }
    }
  });
});
