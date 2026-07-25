/**
 * MARKET pane (`src/swarm-runtime/tui/market-pane.ts`) — pure render/key
 * tests, plus the honesty assertions the pane exists to enforce.
 *
 * The pane is a pure function of its rows, so every test here is exact: no
 * timers, no I/O, no randomness. The load-bearing assertions are:
 *  - an UNDEFINED skill score renders `—`, never `0.000`;
 *  - a proven fabricator renders a FABRICATED alert regardless of how good
 *    every other cell looks;
 *  - a failed reputation chain renders as a full-width alert;
 *  - an install with no trusted issuer says so;
 *  - control characters in upstream text can never inject escape sequences;
 *  - no rendered line ever exceeds the requested width.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WIDTH,
  initMarketPane,
  marketPaneKey,
  participantNote,
  renderMarketPane,
  scoreCell,
  type MarketPaneParticipantRow,
  type MarketPaneSummary,
} from "../market-pane";

function row(overrides: Partial<MarketPaneParticipantRow> = {}): MarketPaneParticipantRow {
  return {
    id: "alice",
    kind: "agent",
    standing: "active",
    balance: 1000,
    escrowed: 0,
    score: 0.72,
    scoreDefined: true,
    n: 40,
    passRate: 0.8,
    brier: 0.12,
    settledN: 40,
    fabricatedN: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<MarketPaneSummary> = {}): MarketPaneSummary {
  return {
    treasury: 99_000,
    totalTokens: 100_000,
    openAwards: 2,
    settlements: 41,
    fabrications: 1,
    certificatesSpent: 40,
    chainOk: true,
    issuerPublicKeyHex: "a".repeat(64),
    ...overrides,
  };
}

function widths(lines: string[]): number[] {
  return lines.map((l) => [...l].length);
}

// ===========================================================================

describe("scoreCell — an undefined skill score is never printed as a number", () => {
  it("renders — when scoreDefined is false, even though `score` carries a 0", () => {
    expect(scoreCell(row({ score: 0, scoreDefined: false }))).toBe("—");
  });

  it("renders — when score is null", () => {
    expect(scoreCell(row({ score: null, scoreDefined: true }))).toBe("—");
  });

  it("renders the real number when the score IS defined", () => {
    expect(scoreCell(row({ score: 0.7234, scoreDefined: true }))).toBe("0.723");
  });

  it("a genuine, measured zero still renders as 0.000 (that IS a measurement)", () => {
    expect(scoreCell(row({ score: 0, scoreDefined: true }))).toBe("0.000");
  });
});

// ===========================================================================

describe("participantNote — the consequence line", () => {
  it("a proven fabricator is named as one regardless of every other cell", () => {
    const note = participantNote(row({ fabricatedN: 2, standing: "banned", balance: 999_999, score: 0.99 }));
    expect(note).toContain("FABRICATED x2");
    expect(note).toContain("banned");
  });

  it("an unscoreable participant says so, rather than reading as low-skill", () => {
    expect(participantNote(row({ n: 1, scoreDefined: false, score: 0 }))).toBe(
      "not scoreable yet: no outcome variance",
    );
  });

  it("no history at all is its own note", () => {
    expect(participantNote(row({ n: 0, scoreDefined: false, score: null }))).toBe("no settled work yet");
  });

  it("each standing has a distinct, non-empty consequence", () => {
    const notes = ["active", "probation", "demoted", "banned"].map((s) => participantNote(row({ standing: s })));
    expect(new Set(notes).size).toBe(4);
    for (const n of notes) expect(n.length).toBeGreaterThan(0);
  });
});

// ===========================================================================

describe("renderMarketPane", () => {
  it("renders an explicit empty-state line rather than a bare box", () => {
    const lines = renderMarketPane(initMarketPane([]));
    expect(lines.join("\n")).toContain("no market participants registered");
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[lines.length - 1].startsWith("╰")).toBe(true);
  });

  it("never exceeds the requested width, at any width, with any content", () => {
    const rows = [
      row({ id: "a".repeat(120), standing: "probation" }),
      row({ id: "b", fabricatedN: 3, standing: "banned" }),
      row({ id: "c", scoreDefined: false, score: 0 }),
    ];
    for (const w of [24, 40, DEFAULT_WIDTH, 120]) {
      const lines = renderMarketPane(initMarketPane(rows, summary()), w);
      expect(Math.max(...widths(lines))).toBeLessThanOrEqual(w);
    }
  });

  it("prints — (not 0.000) in the SCORE column for an unscoreable participant", () => {
    const lines = renderMarketPane(initMarketPane([row({ id: "newbie", n: 1, score: 0, scoreDefined: false })]));
    const dataRow = lines.find((l) => l.includes("newbie"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("—");
    expect(dataRow).not.toContain("0.000");
  });

  it("a fabricator's alert line appears even though the table row itself looks ordinary", () => {
    const lines = renderMarketPane(initMarketPane([row({ id: "liar", fabricatedN: 1, standing: "banned" })]));
    expect(lines.join("\n")).toContain("FABRICATED x1");
  });

  it("a FAILED reputation chain renders a full-width alert", () => {
    const lines = renderMarketPane(initMarketPane([row()], summary({ chainOk: false })));
    const text = lines.join("\n");
    expect(text).toContain("CHAIN    FAILED");
    // The alert must survive the width clamp INTACT — a truncated integrity
    // warning is a defeated one.
    expect(text).toContain("numbers unfounded");
    expect(text).not.toContain("unfo…");
  });

  it("an install with no trusted issuer says so, and the warning is not truncated", () => {
    const text = renderMarketPane(initMarketPane([row()], summary({ issuerPublicKeyHex: "" }))).join("\n");
    expect(text).toContain("NO TRUSTED ISSUER");
    expect(text).toContain("every certificate would be rejected");
  });

  it("a healthy summary reports the real totals verbatim", () => {
    const text = renderMarketPane(initMarketPane([row()], summary())).join("\n");
    expect(text).toContain("TREASURY 99000.00 / 100000.00 tokens");
    expect(text).toContain("SETTLED  41  fabrications 1  certificates spent 40");
    expect(text).toContain("CHAIN    verified from its own bytes");
  });

  it("control characters and ESC in upstream text are stripped, never rendered", () => {
    // Escape sequences are written as \u escapes on purpose: a raw control
    // byte in a source file is itself a defect (it makes git and grep treat
    // the file as binary).
    const hostileId = `ali\u001b[2Jce`;
    const hostileStanding = `act\u0007ive\u009b`;
    const lines = renderMarketPane(initMarketPane([row({ id: hostileId, standing: hostileStanding })]));
    const text = lines.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u009b");
    // The printable remainder survives — sanitizing is not the same as dropping.
    expect(text).toContain("ali[2Jce");
    expect(text).toContain("active");
  });

  it("the detail block shows the selected participant's measured numbers", () => {
    let state = initMarketPane([row({ id: "alice" }), row({ id: "bob", brier: 0.31 })], summary());
    state = marketPaneKey(state, "j");
    state = marketPaneKey(state, "enter");
    const text = renderMarketPane(state).join("\n");
    expect(text).toContain("DETAIL  bob");
    expect(text).toContain("0.3100");
  });

  it("rendering is deterministic — the same state renders identically every time", () => {
    const state = initMarketPane([row(), row({ id: "bob" })], summary());
    expect(renderMarketPane(state)).toEqual(renderMarketPane(state));
  });
});

// ===========================================================================

describe("marketPaneKey", () => {
  const state = initMarketPane([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);

  it("j/k move the selection and clamp at both ends", () => {
    expect(marketPaneKey(state, "j").selected).toBe(1);
    expect(marketPaneKey(marketPaneKey(state, "j"), "k").selected).toBe(0);
    expect(marketPaneKey(state, "k")).toBe(state); // clamped: same object
    let last = state;
    for (let i = 0; i < 10; i++) last = marketPaneKey(last, "j");
    expect(last.selected).toBe(2);
  });

  it("g/G jump to the ends", () => {
    expect(marketPaneKey(state, "G").selected).toBe(2);
    expect(marketPaneKey(marketPaneKey(state, "G"), "g").selected).toBe(0);
  });

  it("enter toggles detail, escape closes it, and escape on a closed pane is a no-op", () => {
    const open = marketPaneKey(state, "enter");
    expect(open.showDetail).toBe(true);
    expect(marketPaneKey(open, "escape").showDetail).toBe(false);
    expect(marketPaneKey(state, "escape")).toBe(state);
  });

  it("an unknown key returns the SAME object so a caller can skip re-rendering", () => {
    expect(marketPaneKey(state, "ctrl+q")).toBe(state);
  });

  it("an empty pane never produces an out-of-range selection", () => {
    const empty = initMarketPane([]);
    expect(marketPaneKey(empty, "j").selected).toBe(0);
    expect(marketPaneKey(empty, "G").selected).toBe(0);
  });
});
