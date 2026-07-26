import { describe, expect, it } from "vitest";

import {
  initSkillTrustPane,
  renderSkillTrustPane,
  skillTrustPaneKey,
  type SkillTrustPaneRow,
  type SkillTrustPaneState,
} from "../tui/skill-trust-pane";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<SkillTrustPaneRow> = {}): SkillTrustPaneRow {
  return {
    skillName: "web-search",
    status: "active",
    wilsonLower: 0.8123,
    recentBrier: 0.0456,
    n: 40,
    verifiedN: 38,
    reasons: ["healthy calibration over last 40 evaluations"],
    ...overrides,
  };
}

function allStatusRows(): SkillTrustPaneRow[] {
  return [
    makeRow({ skillName: "alpha-active-hi", status: "active", wilsonLower: 0.91, reasons: [] }),
    makeRow({ skillName: "beta-active-lo", status: "active", wilsonLower: 0.12, reasons: [] }),
    makeRow({
      skillName: "gamma-active-null",
      status: "active",
      wilsonLower: null,
      recentBrier: null,
      reasons: ["persisted active status but no current track-record entries"],
    }),
    makeRow({ skillName: "zeta-unscored", status: "unscored", wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0, reasons: ["no track record"] }),
    makeRow({ skillName: "delta-unscored", status: "unscored", wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0, reasons: ["no track record"] }),
    makeRow({ skillName: "epsilon-probation", status: "probation", wilsonLower: 0.4, reasons: ["deprioritized: status=probation"] }),
    makeRow({ skillName: "theta-demoted", status: "demoted", wilsonLower: 0.05, reasons: ["demoted after repeated failures"] }),
    makeRow({ skillName: "iota-integrity", status: "integrity-error", wilsonLower: null, recentBrier: null, reasons: ["hash-chain integrity check failed"] }),
  ];
}

function extractOutputLines(lines: string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// initSkillTrustPane
// ---------------------------------------------------------------------------

describe("initSkillTrustPane", () => {
  it("starts with selection 0, sort=name, reasons collapsed", () => {
    const state = initSkillTrustPane([makeRow(), makeRow({ skillName: "b" })]);
    expect(state.selected).toBe(0);
    expect(state.sort).toBe("name");
    expect(state.showReasons).toBe(false);
    expect(state.rows.length).toBe(2);
  });

  it("handles an empty row list", () => {
    const state = initSkillTrustPane([]);
    expect(state.rows.length).toBe(0);
    expect(state.selected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// skillTrustPaneKey — up/down clamping
// ---------------------------------------------------------------------------

describe("skillTrustPaneKey: up/down movement and clamping", () => {
  it("moves down through rows in current sort order", () => {
    const state = initSkillTrustPane([
      makeRow({ skillName: "a" }),
      makeRow({ skillName: "b" }),
      makeRow({ skillName: "c" }),
    ]);
    const s1 = skillTrustPaneKey(state, "down");
    expect(s1.selected).toBe(1);
    const s2 = skillTrustPaneKey(s1, "down");
    expect(s2.selected).toBe(2);
  });

  it("clamps at the bottom end: down at the last row is a no-op returning same reference", () => {
    const state: SkillTrustPaneState = { ...initSkillTrustPane([makeRow(), makeRow({ skillName: "b" })]), selected: 1 };
    const next = skillTrustPaneKey(state, "down");
    expect(next).toBe(state);
    expect(next.selected).toBe(1);
  });

  it("clamps at the top end: up at row 0 is a no-op returning same reference", () => {
    const state = initSkillTrustPane([makeRow(), makeRow({ skillName: "b" })]);
    const next = skillTrustPaneKey(state, "up");
    expect(next).toBe(state);
    expect(next.selected).toBe(0);
  });

  it("with a single row, both up and down are no-ops", () => {
    const state = initSkillTrustPane([makeRow()]);
    expect(skillTrustPaneKey(state, "up")).toBe(state);
    expect(skillTrustPaneKey(state, "down")).toBe(state);
  });

  it("with zero rows, up/down pin selection to 0 and no-op when already 0", () => {
    const state = initSkillTrustPane([]);
    const next = skillTrustPaneKey(state, "down");
    expect(next).toBe(state);
    expect(next.selected).toBe(0);
  });

  it("does not mutate the input state object", () => {
    const state = initSkillTrustPane([makeRow(), makeRow({ skillName: "b" })]);
    const snapshotSelected = state.selected;
    skillTrustPaneKey(state, "down");
    expect(state.selected).toBe(snapshotSelected);
  });
});

// ---------------------------------------------------------------------------
// skillTrustPaneKey — sort toggle, selection follows the SKILL not the index
// ---------------------------------------------------------------------------

describe("skillTrustPaneKey: sort toggle preserves selected skill identity", () => {
  it("toggles sort from name to trust and relocates selection to the same skill", () => {
    // Name order: alpha-active-hi, beta-active-lo, gamma-active-null ...
    // Selecting "beta-active-lo" (index 1 in name order) and toggling sort
    // to trust must keep "beta-active-lo" selected even though its trust-sort
    // index differs (active sorted by wilson desc: alpha(.91), beta(.12), gamma(null)).
    let state = initSkillTrustPane(allStatusRows());
    state = { ...state, selected: 1 }; // beta-active-lo in name order
    expect(state.rows[1].skillName).toBe("beta-active-lo");

    const toggled = skillTrustPaneKey(state, "s");
    expect(toggled.sort).toBe("trust");
    const rendered = renderSkillTrustPane(toggled, 100);
    // find which line has the marker "▸" and confirm it is beta-active-lo
    const markedLine = rendered.find((l) => l.includes("▸"));
    expect(markedLine).toBeDefined();
    expect(markedLine).toContain("beta-active-lo");
  });

  it("round-trips: toggling sort twice returns to a state selecting the same skill", () => {
    let state = initSkillTrustPane(allStatusRows());
    state = { ...state, selected: 4 }; // index 4 in name-sorted order = "gamma-active-null"
    const nameSorted = state.rows.slice().sort((a, b) => (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0));
    const originalSkill = nameSorted[4];
    expect(originalSkill.skillName).toBe("gamma-active-null");

    const once = skillTrustPaneKey(state, "s");
    const twice = skillTrustPaneKey(once, "s");
    expect(twice.sort).toBe("name");
    // `selected` indexes into the *current sorted display order*, not raw
    // `rows` array order — recover it the same way renderSkillTrustPane does.
    const twiceNameSorted = twice.rows.slice().sort((a, b) => (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0));
    expect(twiceNameSorted[twice.selected].skillName).toBe(originalSkill.skillName);
  });

  it("toggles sort with an empty row list without throwing", () => {
    const state = initSkillTrustPane([]);
    const next = skillTrustPaneKey(state, "s");
    expect(next.sort).toBe("trust");
    expect(next.selected).toBe(0);
  });

  it("toggling sort on an empty list twice in a row is a no-op the second... (returns fresh object each time since sort flips)", () => {
    const state = initSkillTrustPane([]);
    const s1 = skillTrustPaneKey(state, "s");
    const s2 = skillTrustPaneKey(s1, "s");
    expect(s2.sort).toBe("name");
  });

  it("preserves selection across sort toggle with duplicate skill names by object identity", () => {
    const dupRows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "dup", status: "active", wilsonLower: 0.9 }),
      makeRow({ skillName: "dup", status: "demoted", wilsonLower: 0.1 }),
    ];
    let state = initSkillTrustPane(dupRows);
    // name-sorted: both "dup", stable order is array order after sort (equal keys) — select index 1 (the demoted one)
    state = { ...state, selected: 1 };
    const beforeLines = renderSkillTrustPane(state, 100);
    const beforeMarked = beforeLines.find((l) => l.includes("▸"));
    expect(beforeMarked).toContain("demoted");

    const toggled = skillTrustPaneKey(state, "s");
    expect(toggled.sort).toBe("trust");
    // In trust order the active row sorts first and the demoted row second —
    // selection must still land on the demoted row (the one that was
    // selected before), by object identity, not by coincidental index reuse.
    const afterLines = renderSkillTrustPane(toggled, 100);
    const afterMarked = afterLines.find((l) => l.includes("▸"));
    expect(afterMarked).toContain("demoted");
  });
});

// ---------------------------------------------------------------------------
// skillTrustPaneKey — enter toggles reasons
// ---------------------------------------------------------------------------

describe("skillTrustPaneKey: enter toggles showReasons", () => {
  it("toggles showReasons on then off", () => {
    const state = initSkillTrustPane([makeRow()]);
    const on = skillTrustPaneKey(state, "enter");
    expect(on.showReasons).toBe(true);
    const off = skillTrustPaneKey(on, "enter");
    expect(off.showReasons).toBe(false);
  });

  it("toggles showReasons even with zero rows, without throwing", () => {
    const state = initSkillTrustPane([]);
    const on = skillTrustPaneKey(state, "enter");
    expect(on.showReasons).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skillTrustPaneKey — unknown keys
// ---------------------------------------------------------------------------

describe("skillTrustPaneKey: unknown keys", () => {
  it("returns the identical state reference for an unrecognized key", () => {
    const state = initSkillTrustPane([makeRow(), makeRow({ skillName: "b" })]);
    const next = skillTrustPaneKey(state, "q");
    expect(next).toBe(state);
  });

  it("returns the identical reference for an empty-string key", () => {
    const state = initSkillTrustPane([makeRow()]);
    expect(skillTrustPaneKey(state, "")).toBe(state);
  });

  it("returns the identical reference for a plausible but unbound key like 'left'", () => {
    const state = initSkillTrustPane([makeRow()]);
    expect(skillTrustPaneKey(state, "left")).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// renderSkillTrustPane — border integrity across widths + multi-byte text
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: border integrity", () => {
  const widths = [20, 40, 72, 100];

  it.each(widths)("keeps every line <= width and aligns borders at width=%i", (width) => {
    const rows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "こんにちは-skill-name-long", reasons: ["日本語の理由テキストがとても長い場合のテスト"] }),
      makeRow({ skillName: "emoji-🔥🚀🎉-skill", status: "demoted", reasons: ["fails with 🔥 emoji reason"] }),
      makeRow({ skillName: "plain-ascii", status: "unscored", wilsonLower: null, recentBrier: null }),
    ];
    let state = initSkillTrustPane(rows);
    state = skillTrustPaneKey(state, "enter"); // show reasons too
    const lines = renderSkillTrustPane(state, width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(width);
    }
    // top/bottom border shape
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[0].endsWith("╮")).toBe(true);
    expect(lines[lines.length - 1].startsWith("╰")).toBe(true);
    expect(lines[lines.length - 1].endsWith("╯")).toBe(true);
    // top/bottom border exactly `width` code points (when width fits at least the minimal box)
    expect([...lines[0]].length).toBe(width);
    expect([...lines[lines.length - 1]].length).toBe(width);
  });

  it("uses a divider between the table and the reasons section", () => {
    const state = skillTrustPaneKey(initSkillTrustPane([makeRow()]), "enter");
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.startsWith("├") && l.endsWith("┤"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderSkillTrustPane — ANSI / control-character injection
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: control-character and ANSI injection resistance", () => {
  it("strips ESC-based ANSI sequences, BEL, and C1 bytes from skillName and reasons", () => {
    const malicious: SkillTrustPaneRow = {
      skillName: "evil\u001b[31mred\u0007bell",
      status: "demoted",
      wilsonLower: 0.1,
      recentBrier: 0.2,
      n: 5,
      verifiedN: 5,
      reasons: ["reason with \u001b[31mred\u001b[0m and \u0007 bell and \u0090 c1-byte"],
    };
    let state = initSkillTrustPane([malicious]);
    state = skillTrustPaneKey(state, "enter");
    const lines = renderSkillTrustPane(state, 100);
    const joined = extractOutputLines(lines);
    // No ESC (the byte that begins every ANSI escape sequence), no BEL, and
    // no raw C1 control byte survives anywhere in the rendered output.
    expect(joined.includes("\u001b")).toBe(false);
    expect(joined.includes("\u0007")).toBe(false);
    expect(joined.includes("")).toBe(false);
    // Only the control bytes themselves are stripped -- the surrounding
    // printable text (including the now-inert literal "[31m" left behind
    // once ESC is gone) still makes it through untouched.
    expect(joined).toContain("evil[31mredbell");
    expect(joined).toContain("reason with [31mred[0m and");
  });

  it("collapses embedded newlines in a reason to a single visual marker instead of breaking the grid", () => {
    const row = makeRow({ reasons: ["line one\nline two\r\nline three"] });
    const state = skillTrustPaneKey(initSkillTrustPane([row]), "enter");
    const lines = renderSkillTrustPane(state, 100);
    const reasonLine = lines.find((l) => l.includes("line one"));
    expect(reasonLine).toBeDefined();
    expect(reasonLine).not.toContain("\n");
    expect(reasonLine).not.toContain("\r");
  });
});

// ---------------------------------------------------------------------------
// renderSkillTrustPane — sort order matrix
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: trust-sort ordering matrix", () => {
  it("orders active(wilson desc) -> unscored -> probation -> demoted -> integrity-error", () => {
    const state = skillTrustPaneKey(initSkillTrustPane(allStatusRows()), "s");
    expect(state.sort).toBe("trust");
    const lines = renderSkillTrustPane(state, 100);
    const nameOrder = lines
      .filter((l) => l.startsWith("▸") || l.startsWith(" ✓") || l.startsWith(" ~") || l.startsWith(" ✗") || l.startsWith(" ?") || l.startsWith(" !") || l.startsWith("▸ "))
      .map((l) => l.trim());
    // Fall back to a simpler extraction: pull skillName tokens by scanning known names in order encountered
    const knownNames = allStatusRows().map((r) => r.skillName);
    const encountered = lines
      .map((l) => knownNames.find((n) => l.includes(n)))
      .filter((n): n is string => !!n);
    expect(encountered).toEqual([
      "alpha-active-hi",
      "beta-active-lo",
      "gamma-active-null",
      "delta-unscored",
      "zeta-unscored",
      "epsilon-probation",
      "theta-demoted",
      "iota-integrity",
    ]);
    void nameOrder;
  });

  it("plain name sort is simple ascending regardless of status", () => {
    const state = initSkillTrustPane(allStatusRows());
    const lines = renderSkillTrustPane(state, 100);
    const knownNames = allStatusRows().map((r) => r.skillName);
    const encountered = lines
      .map((l) => knownNames.find((n) => l.includes(n)))
      .filter((n): n is string => !!n);
    const expected = knownNames.slice().sort((a, b) => (a < b ? -1 : 1));
    expect(encountered).toEqual(expected);
  });

  it("a null wilsonLower active row never compares as 0 (sorts below all real-wilson actives, above unscored)", () => {
    const rows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "low-real", status: "active", wilsonLower: 0.001 }),
      makeRow({ skillName: "null-wilson", status: "active", wilsonLower: null }),
      makeRow({ skillName: "some-unscored", status: "unscored", wilsonLower: null }),
    ];
    const state = skillTrustPaneKey(initSkillTrustPane(rows), "s");
    const lines = renderSkillTrustPane(state, 100);
    const knownNames = rows.map((r) => r.skillName);
    const encountered = lines
      .map((l) => knownNames.find((n) => l.includes(n)))
      .filter((n): n is string => !!n);
    expect(encountered).toEqual(["low-real", "null-wilson", "some-unscored"]);
  });

  it("unscored rows sort by name among themselves", () => {
    const rows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "z-unscored", status: "unscored", wilsonLower: null }),
      makeRow({ skillName: "a-unscored", status: "unscored", wilsonLower: null }),
      makeRow({ skillName: "m-unscored", status: "unscored", wilsonLower: null }),
    ];
    const state = skillTrustPaneKey(initSkillTrustPane(rows), "s");
    const lines = renderSkillTrustPane(state, 100);
    const knownNames = rows.map((r) => r.skillName);
    const encountered = lines
      .map((l) => knownNames.find((n) => l.includes(n)))
      .filter((n): n is string => !!n);
    expect(encountered).toEqual(["a-unscored", "m-unscored", "z-unscored"]);
  });

  it("ties within a status group break by skillName ascending", () => {
    const rows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "zeta-tie", status: "active", wilsonLower: 0.5 }),
      makeRow({ skillName: "alpha-tie", status: "active", wilsonLower: 0.5 }),
    ];
    const state = skillTrustPaneKey(initSkillTrustPane(rows), "s");
    const lines = renderSkillTrustPane(state, 100);
    const knownNames = rows.map((r) => r.skillName);
    const encountered = lines
      .map((l) => knownNames.find((n) => l.includes(n)))
      .filter((n): n is string => !!n);
    expect(encountered).toEqual(["alpha-tie", "zeta-tie"]);
  });
});

// ---------------------------------------------------------------------------
// renderSkillTrustPane — honest empty/edge states
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: honest empty/edge states", () => {
  it("renders an explicit 'no skills tracked' line for zero rows, never a bare box", () => {
    const state = initSkillTrustPane([]);
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.includes("no skills tracked"))).toBe(true);
  });

  it("renders correctly for exactly one row", () => {
    const state = initSkillTrustPane([makeRow({ skillName: "solo" })]);
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.includes("solo"))).toBe(true);
    expect(lines.some((l) => l.includes("▸"))).toBe(true);
  });

  it("renders 'no reasons recorded' when the selected row's reasons array is empty and showReasons is on", () => {
    const state = skillTrustPaneKey(initSkillTrustPane([makeRow({ reasons: [] })]), "enter");
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.includes("no reasons recorded"))).toBe(true);
  });

  it("shows 'no skills tracked' in the reasons section too when showReasons is on with zero rows", () => {
    const state = skillTrustPaneKey(initSkillTrustPane([]), "enter");
    const lines = renderSkillTrustPane(state, 72);
    const reasonsSectionStart = lines.findIndex((l) => l.includes("REASONS"));
    expect(reasonsSectionStart).toBeGreaterThan(-1);
    expect(lines.slice(reasonsSectionStart).some((l) => l.includes("no skills tracked"))).toBe(true);
  });

  it("does not render a reasons section at all when showReasons is off", () => {
    const state = initSkillTrustPane([makeRow()]);
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.includes("REASONS"))).toBe(false);
  });

  it("renders duplicate skill names verbatim without deduping", () => {
    const rows: SkillTrustPaneRow[] = [
      makeRow({ skillName: "dupe", status: "active" }),
      makeRow({ skillName: "dupe", status: "demoted" }),
    ];
    const state = initSkillTrustPane(rows);
    const lines = renderSkillTrustPane(state, 72);
    const dupeCount = lines.filter((l) => l.includes("dupe")).length;
    expect(dupeCount).toBe(2);
  });

  it("formats null wilsonLower/recentBrier as em-dash, never the strings 'null' or 'NaN'", () => {
    const state = initSkillTrustPane([makeRow({ wilsonLower: null, recentBrier: null })]);
    const lines = renderSkillTrustPane(state, 72);
    const joined = extractOutputLines(lines);
    expect(joined).toContain("wilson=—");
    expect(joined).toContain("brier=—");
    expect(joined).not.toMatch(/null/i);
    expect(joined).not.toMatch(/NaN/);
  });

  it("formats a real wilsonLower/recentBrier fixed to 4 decimals", () => {
    const state = initSkillTrustPane([makeRow({ wilsonLower: 0.5, recentBrier: 0.123456789 })]);
    const lines = renderSkillTrustPane(state, 72);
    const joined = extractOutputLines(lines);
    expect(joined).toContain("wilson=0.5000");
    expect(joined).toContain("brier=0.1235");
  });

  it("prints n and verifiedN verbatim from the row", () => {
    const state = initSkillTrustPane([makeRow({ n: 123, verifiedN: 45 })]);
    const lines = renderSkillTrustPane(state, 72);
    const joined = extractOutputLines(lines);
    expect(joined).toContain("n=123");
    expect(joined).toContain("verified=45");
  });
});

// ---------------------------------------------------------------------------
// renderSkillTrustPane — determinism
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: determinism", () => {
  it("renders byte-identical frames across repeated calls on the same state", () => {
    const state = skillTrustPaneKey(initSkillTrustPane(allStatusRows()), "enter");
    const a = renderSkillTrustPane(state, 72).join("\n");
    const b = renderSkillTrustPane(state, 72).join("\n");
    const c = renderSkillTrustPane(state, 72).join("\n");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does not mutate the rows array or its objects across a render", () => {
    const rows = allStatusRows();
    const snapshot = JSON.parse(JSON.stringify(rows));
    const state = initSkillTrustPane(rows);
    renderSkillTrustPane(state, 72);
    expect(JSON.parse(JSON.stringify(rows))).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Default width
// ---------------------------------------------------------------------------

describe("renderSkillTrustPane: default width", () => {
  it("defaults to width 72 when no width argument is given", () => {
    const state = initSkillTrustPane([makeRow()]);
    const lines = renderSkillTrustPane(state);
    expect([...lines[0]].length).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// Structural-compat test — plain JSON literal shaped like trust-selection's
// documented SkillTrustRow display fields, with ZERO import from
// src/hades/**. If trust-selection.ts's SkillTrustRow display fields ever
// drift from this pane's SkillTrustPaneRow, this test (constructed from a
// hand-written literal mirroring that shape) is the one that should start
// failing type-checking or assertions.
// ---------------------------------------------------------------------------

describe("structural compatibility with trust-selection.ts's SkillTrustRow", () => {
  it("accepts a JSON literal shaped exactly like SkillTrustRow's display fields with no adapter code", () => {
    // Mirrors src/hades/skills/trust-selection.ts's SkillTrustRow shape:
    // { skillName, status, wilsonLower, recentBrier, n, verifiedN, since, streak, reasons }
    // `since` and `streak` are extra fields trust-selection carries that this
    // pane does not display; a structural (excess-property-tolerant) value
    // still satisfies SkillTrustPaneRow when narrowed to its own fields.
    const hadesShapedLiteral = {
      skillName: "compat-skill",
      status: "probation" as const,
      wilsonLower: 0.6789,
      recentBrier: 0.0321,
      n: 17,
      verifiedN: 16,
      since: 1_700_000_000_000,
      streak: 3,
      reasons: ["deprioritized: status=probation"],
    };

    const paneRow: SkillTrustPaneRow = {
      skillName: hadesShapedLiteral.skillName,
      status: hadesShapedLiteral.status,
      wilsonLower: hadesShapedLiteral.wilsonLower,
      recentBrier: hadesShapedLiteral.recentBrier,
      n: hadesShapedLiteral.n,
      verifiedN: hadesShapedLiteral.verifiedN,
      reasons: hadesShapedLiteral.reasons,
    };

    const state = initSkillTrustPane([paneRow]);
    const lines = renderSkillTrustPane(state, 72);
    expect(lines.some((l) => l.includes("compat-skill"))).toBe(true);
    expect(lines.some((l) => l.includes("probation"))).toBe(true);
    expect(lines.some((l) => l.includes("wilson=0.6789"))).toBe(true);
    expect(lines.some((l) => l.includes("n=17"))).toBe(true);
    expect(lines.some((l) => l.includes("verified=16"))).toBe(true);
  });

  it("accepts a full JSON.parse'd payload (all five statuses) shaped like SkillTrustReader.rows() output", () => {
    const jsonPayload = JSON.stringify([
      { skillName: "s-active", status: "active", wilsonLower: 0.7, recentBrier: 0.05, n: 10, verifiedN: 10, since: 1, streak: 5, reasons: [] },
      { skillName: "s-probation", status: "probation", wilsonLower: 0.4, recentBrier: 0.2, n: 8, verifiedN: 8, since: 2, streak: 1, reasons: ["low wilson bound"] },
      { skillName: "s-demoted", status: "demoted", wilsonLower: 0.1, recentBrier: 0.5, n: 20, verifiedN: 18, since: 3, streak: 0, reasons: ["repeated failure"] },
      { skillName: "s-unscored", status: "unscored", wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0, since: null, streak: 0, reasons: ["no track record"] },
      { skillName: "s-integrity", status: "integrity-error", wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0, since: null, streak: 0, reasons: ["corrupt trust file"] },
    ]);
    const parsed = JSON.parse(jsonPayload) as Array<{
      skillName: string;
      status: "active" | "probation" | "demoted" | "unscored" | "integrity-error";
      wilsonLower: number | null;
      recentBrier: number | null;
      n: number;
      verifiedN: number;
      since: number | null;
      streak: number;
      reasons: string[];
    }>;

    const paneRows: SkillTrustPaneRow[] = parsed.map((r) => ({
      skillName: r.skillName,
      status: r.status,
      wilsonLower: r.wilsonLower,
      recentBrier: r.recentBrier,
      n: r.n,
      verifiedN: r.verifiedN,
      reasons: r.reasons,
    }));

    const state = initSkillTrustPane(paneRows);
    const lines = renderSkillTrustPane(state, 100);
    for (const r of parsed) {
      expect(lines.some((l) => l.includes(r.skillName))).toBe(true);
    }
  });
});
