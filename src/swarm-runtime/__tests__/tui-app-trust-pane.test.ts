/**
 * Central-integration tests for the SKILLS/TRUST pane inside TuiApp: the `t`
 * key toggles the pane (asking central wiring for fresh SkillTrustReader rows
 * on open), the pane renders its honest "no skills tracked" empty state until
 * real data arrives, `setSkillTrustData` lays real reader-shaped rows into
 * the pure pane state, navigation/sort/reasons keys drive the pane's own
 * keymap, and esc/q returns to the dashboard.
 */
import { describe, it, expect, vi } from "vitest";
import { TuiApp } from "../tui/app";
import { keyToAction } from "../tui/keymap";
import type { SkillTrustPaneRow } from "../tui/skill-trust-pane";

function row(overrides: Partial<SkillTrustPaneRow> & { skillName: string }): SkillTrustPaneRow {
  return {
    status: "active",
    wilsonLower: 0.7225,
    recentBrier: 0.01,
    n: 10,
    verifiedN: 10,
    reasons: [],
    ...overrides,
  };
}

describe("keymap: t toggles the SKILLS/TRUST pane", () => {
  it("maps t to the trust pane action in view mode, and to plain input in compose mode", () => {
    expect(keyToAction("t", "view")).toEqual({ kind: "pane", pane: "trust" });
    expect(keyToAction("t", "compose")).toEqual({ kind: "input", char: "t" });
  });
});

describe("TuiApp: SKILLS/TRUST pane", () => {
  it("t opens the pane (requesting a refresh from central wiring), renders the honest empty state, and t/esc/q leave it", () => {
    const refreshSkillTrust = vi.fn();
    const app = new TuiApp({
      controller: {
        dispatchGoal: () => {},
        scalePool: () => {},
        cancel: () => {},
        refreshSkillTrust,
      },
    });

    expect(app.activePane()).toBe("dashboard");
    app.handleKey("t");
    expect(app.activePane()).toBe("trust");
    expect(refreshSkillTrust).toHaveBeenCalledTimes(1);

    const frame = app.frame();
    expect(frame).toContain("SKILLS/TRUST");
    expect(frame).toContain("no skills tracked");
    expect(frame).toContain("[r] refresh");

    // r while open re-requests fresh data.
    app.handleKey("r");
    expect(refreshSkillTrust).toHaveBeenCalledTimes(2);

    // Toggle back with t; reopen; escape out; reopen; q backs out (never quits from the pane).
    app.handleKey("t");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("t");
    app.handleKey("\x1b");
    expect(app.activePane()).toBe("dashboard");
    app.handleKey("t");
    const result = app.handleKey("q");
    expect(result.quit).toBeUndefined();
    expect(app.activePane()).toBe("dashboard");

    // The dashboard footer advertises the pane.
    expect(app.frame()).toContain("[t] trust");
  });

  it("setSkillTrustData lays rows into the pane; navigation, sort toggle, and reasons drill-in all work", () => {
    const app = new TuiApp({});
    app.handleKey("t");
    app.setSkillTrustData([
      row({ skillName: "zeta", status: "active", wilsonLower: 0.9 }),
      row({ skillName: "alpha", status: "demoted", wilsonLower: 0.1, reasons: ["wilson fell below the demotion floor"] }),
      row({ skillName: "mid", status: "unscored", wilsonLower: null, recentBrier: null, n: 0, verifiedN: 0 }),
    ]);

    const frame = app.frame();
    expect(frame).toContain("SKILLS (3)");
    expect(frame).toContain("sort=name");
    expect(frame).toContain("zeta");
    expect(frame).toContain("alpha");
    expect(frame).toContain("demoted");
    expect(frame).toContain("wilson=0.9000");
    // null metrics render as an em dash, never "null"/"NaN".
    expect(frame).not.toContain("null");
    expect(frame).not.toContain("NaN");

    // name sort: alpha first; selection starts at 0 and moves with j/k/arrows.
    expect(app.skillTrustState().selected).toBe(0);
    app.handleKey("j");
    expect(app.skillTrustState().selected).toBe(1);
    app.handleKey("\x1b[B");
    expect(app.skillTrustState().selected).toBe(2);
    app.handleKey("down"); // clamped at the last row
    expect(app.skillTrustState().selected).toBe(2);
    app.handleKey("k");
    expect(app.skillTrustState().selected).toBe(1);

    // s toggles the sort mode inside the pane (it does NOT open the showdown
    // pane while the trust pane is claiming keys).
    app.handleKey("s");
    expect(app.activePane()).toBe("trust");
    expect(app.skillTrustState().sort).toBe("trust");
    expect(app.frame()).toContain("sort=trust");

    // enter toggles the REASONS drill-in for the selected row.
    app.handleKey("\r");
    expect(app.skillTrustState().showReasons).toBe(true);
    expect(app.frame()).toContain("REASONS");
    app.handleKey("\r");
    expect(app.skillTrustState().showReasons).toBe(false);
  });

  it("a refreshed, shorter row list re-clamps the selection instead of pointing past the list", () => {
    const app = new TuiApp({});
    app.handleKey("t");
    app.setSkillTrustData([row({ skillName: "a" }), row({ skillName: "b" }), row({ skillName: "c" })]);
    app.handleKey("j");
    app.handleKey("j");
    expect(app.skillTrustState().selected).toBe(2);

    app.setSkillTrustData([row({ skillName: "a" })]);
    expect(app.skillTrustState().selected).toBe(0);
    expect(() => app.frame()).not.toThrow();
  });

  it("adversarial skill names and reasons never leak control bytes into the frame", () => {
    const app = new TuiApp({});
    app.handleKey("t");
    app.setSkillTrustData([
      row({
        skillName: "evil\u001b[2Jname\nwith\u0007controls",
        status: "integrity-error",
        reasons: ["reason with \u001b[31mansi\u001b[0m and\nnewlines"],
      }),
    ]);
    app.handleKey("\r"); // show REASONS too, so the reasons text is exercised
    const frame = app.frame();
    const paneLines = frame
      .split("\n")
      .filter((l) => l.startsWith("╭") || l.startsWith("│") || l.startsWith("├") || l.startsWith("╰"));
    expect(paneLines.length).toBeGreaterThan(0);
    for (const line of paneLines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });
});
