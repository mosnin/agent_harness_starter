import { describe, it, expect } from "vitest";
import {
  suggest,
  acInit,
  acUpdate,
  acKey,
  renderAutocomplete,
  TUI_COMMAND_SPECS,
  type CommandSpec,
  type SlashIntent,
  type AcState,
  type Match,
} from "../autocomplete";

/** Exhaustive switch over the locked `SlashIntent` union: a compile-time
 *  proof (via the `never` default) that every intent used in a test is a
 *  real member of the union, plus a runtime sanity check. */
function assertIsLockedIntent(intent: SlashIntent): void {
  switch (intent.kind) {
    case "dispatch-goal":
    case "cancel":
    case "toggle-help":
    case "quit":
    case "interrupt":
      return;
    case "scale":
      expect(intent.delta === 1 || intent.delta === -1).toBe(true);
      return;
    case "open-pane": {
      const validPanes = new Set([
        "fleet",
        "showdown",
        "gateway",
        "schedule",
        "trust",
        "history",
        "verify",
        "stream",
      ]);
      expect(validPanes.has(intent.pane)).toBe(true);
      return;
    }
    default: {
      const exhaustive: never = intent;
      throw new Error(`not a locked SlashIntent: ${JSON.stringify(exhaustive)}`);
    }
  }
}

describe("TUI_COMMAND_SPECS", () => {
  it("covers exactly the fifteen locked commands", () => {
    const names = TUI_COMMAND_SPECS.map((s) => s.name).sort();
    expect(names).toEqual(
      [
        "cancel",
        "fleet",
        "gateway",
        "goal",
        "help",
        "history",
        "interrupt",
        "quit",
        "scale-down",
        "scale-up",
        "schedule",
        "showdown",
        "stream",
        "trust",
        "verify",
      ].sort()
    );
    expect(TUI_COMMAND_SPECS.length).toBe(15);
  });

  it("every intent is a genuine member of the locked SlashIntent union", () => {
    for (const spec of TUI_COMMAND_SPECS) assertIsLockedIntent(spec.intent);
  });

  it("every open-pane intent names a real dashboard pane", () => {
    const panesUsed = TUI_COMMAND_SPECS.filter((s) => s.intent.kind === "open-pane").map(
      (s) => (s.intent as { kind: "open-pane"; pane: string }).pane
    );
    // fleet/showdown/gateway/schedule/trust exist on TuiApp today (app.ts);
    // history/verify/stream are this cycle's new panes per the locked spec.
    expect(new Set(panesUsed)).toEqual(
      new Set(["fleet", "showdown", "gateway", "schedule", "trust", "history", "verify", "stream"])
    );
  });

  it("has no duplicate names and no alias collides with another spec's alias or name", () => {
    const names = TUI_COMMAND_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);

    const allAliases = TUI_COMMAND_SPECS.flatMap((s) => s.aliases ?? []);
    expect(new Set(allAliases).size).toBe(allAliases.length);
    for (const alias of allAliases) expect(names).not.toContain(alias);
  });

  it("every spec has a non-empty name and summary", () => {
    for (const spec of TUI_COMMAND_SPECS) {
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("suggest() — activation", () => {
  it("is inactive (empty) for a buffer with no leading slash", () => {
    expect(suggest(TUI_COMMAND_SPECS, "goal")).toEqual([]);
    expect(suggest(TUI_COMMAND_SPECS, "hello world")).toEqual([]);
    expect(suggest(TUI_COMMAND_SPECS, "")).toEqual([]);
  });

  it("is inactive for a buffer where the slash isn't at the start of the first line", () => {
    expect(suggest(TUI_COMMAND_SPECS, " /goal")).toEqual([]);
    expect(suggest(TUI_COMMAND_SPECS, "not /goal")).toEqual([]);
  });

  it("only the first line counts in a multiline buffer", () => {
    expect(suggest(TUI_COMMAND_SPECS, "no slash here\n/goal")).toEqual([]);
    const m = suggest(TUI_COMMAND_SPECS, "/goal\nsecond line is body text, not a command");
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].spec.name).toBe("goal");
  });

  it("a bare slash opens the full (bounded) list", () => {
    const m = suggest(TUI_COMMAND_SPECS, "/");
    expect(m.length).toBe(8);
  });
});

describe("suggest() — ranking tiers", () => {
  it("exact name beats everything else, including a same-length alias collision", () => {
    const specs: CommandSpec[] = [
      { name: "sc", summary: "alias target", aliases: [], intent: { kind: "cancel" } },
      { name: "schedule", summary: "has alias sc", aliases: ["sc"], intent: { kind: "cancel" } },
    ];
    const m = suggest(specs, "/sc");
    expect(m[0].spec.name).toBe("sc"); // exact name (tier 0) beats exact alias (tier 1)
    expect(m[1].spec.name).toBe("schedule");
  });

  it("exact alias beats a name-prefix match", () => {
    const specs: CommandSpec[] = [
      { name: "quit", summary: "exact alias q", aliases: ["q"], intent: { kind: "quit" } },
      { name: "query-log", summary: "name-prefix q", aliases: [], intent: { kind: "cancel" } },
    ];
    const m = suggest(specs, "/q");
    expect(m[0].spec.name).toBe("quit"); // tier 1
    expect(m[1].spec.name).toBe("query-log"); // tier 2
  });

  it("name prefix beats alias prefix", () => {
    const specs: CommandSpec[] = [
      { name: "trust", summary: "name prefix tr", aliases: [], intent: { kind: "cancel" } },
      { name: "history", summary: "alias prefix tr...ack", aliases: ["track"], intent: { kind: "cancel" } },
    ];
    const m = suggest(specs, "/tr");
    expect(m[0].spec.name).toBe("trust"); // tier 2
    expect(m[1].spec.name).toBe("history"); // tier 3 via alias "track"
  });

  it("word-boundary subsequence beats plain subsequence", () => {
    const specs: CommandSpec[] = [
      { name: "scale-up", summary: "su at word boundaries", aliases: [], intent: { kind: "cancel" } },
      { name: "issue", summary: "su only as a plain subsequence", aliases: [], intent: { kind: "cancel" } },
    ];
    // "issue": s(2) u(3) is a plain subsequence but not word-boundary (word starts at index 0 only).
    const m = suggest(specs, "/su");
    expect(m[0].spec.name).toBe("scale-up"); // tier 4
    expect(m[1].spec.name).toBe("issue"); // tier 5
  });

  it("an alias-only match against a name with no shared characters reports empty matchedIndices", () => {
    const specs: CommandSpec[] = [
      { name: "exit-app", summary: "alias q, name has no q", aliases: ["q"], intent: { kind: "quit" } },
    ];
    const m = suggest(specs, "/q");
    expect(m).toHaveLength(1);
    expect(m[0].matchedIndices).toEqual([]);
  });

  it("matchedIndices always indexes into spec.name for name-tier matches", () => {
    const m = suggest(TUI_COMMAND_SPECS, "/sched");
    const schedule = m.find((x) => x.spec.name === "schedule")!;
    expect(schedule).toBeDefined();
    for (const idx of schedule.matchedIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(schedule.spec.name.length);
    }
    expect(schedule.matchedIndices).toEqual([0, 1, 2, 3, 4]); // "sched" (5 chars) as a prefix
  });

  it("is case-insensitive on both name and alias", () => {
    expect(suggest(TUI_COMMAND_SPECS, "/GOAL")[0].spec.name).toBe("goal");
    expect(suggest(TUI_COMMAND_SPECS, "/Q")[0].spec.name).toBe("quit");
    expect(suggest(TUI_COMMAND_SPECS, "/ScHeD")[0].spec.name).toBe("schedule");
  });

  it("ties within a tier break lexicographically by name", () => {
    const specs: CommandSpec[] = [
      { name: "zeta", summary: "z", aliases: [], intent: { kind: "cancel" } },
      { name: "alpha", summary: "a", aliases: [], intent: { kind: "cancel" } },
      { name: "mid", summary: "m", aliases: [], intent: { kind: "cancel" } },
    ];
    // Empty query -> every spec lands in tier 2 (universal prefix); order must be lexicographic.
    const m = suggest(specs, "/");
    expect(m.map((x) => x.spec.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("queries longer than any spec name never match", () => {
    const m = suggest(TUI_COMMAND_SPECS, "/thisqueryislongerthananyrealcommandname");
    expect(m).toEqual([]);
  });

  it("a non-matching query (no subsequence anywhere) returns no matches", () => {
    const m = suggest(TUI_COMMAND_SPECS, "/zzz9");
    expect(m).toEqual([]);
  });

  it("unicode query characters never crash and behave deterministically (no ASCII spec matches)", () => {
    const once = suggest(TUI_COMMAND_SPECS, "/héllo");
    const twice = suggest(TUI_COMMAND_SPECS, "/héllo");
    expect(once).toEqual(twice);
    expect(once).toEqual([]); // no spec name/alias contains the accented character

    const emoji = suggest(TUI_COMMAND_SPECS, "/🚀goal");
    expect(emoji).toEqual([]);
  });
});

describe("suggest() — bounding, determinism, totality", () => {
  it("never returns more than 8 matches even with many candidates", () => {
    const specs: CommandSpec[] = Array.from({ length: 30 }, (_, i) => ({
      name: `cmd${i}`,
      summary: `command ${i}`,
      aliases: [],
      intent: { kind: "cancel" as const },
    }));
    const m = suggest(specs, "/cmd");
    expect(m.length).toBe(8);
  });

  it("is deterministic: identical inputs produce a deep-equal result every time", () => {
    const queries = ["/g", "/s", "/sc", "/sh", "/", "/quit", "/xyz", "/i"];
    for (const q of queries) {
      const a = suggest(TUI_COMMAND_SPECS, q);
      const b = suggest(TUI_COMMAND_SPECS, q);
      expect(a).toEqual(b);
    }
  });

  it("ordering is total (no incomparable pair) across a battery of adversarial queries", () => {
    const adversarial: CommandSpec[] = [
      { name: "schedule", summary: "s1", aliases: ["s"], intent: { kind: "cancel" } },
      { name: "showdown", summary: "s2", aliases: ["s"], intent: { kind: "cancel" } },
      { name: "scale-up", summary: "s3", aliases: ["s"], intent: { kind: "cancel" } },
      { name: "stream", summary: "s4", aliases: [], intent: { kind: "cancel" } },
      { name: "skip", summary: "s5", aliases: [], intent: { kind: "cancel" } },
    ];
    const queries = ["/s", "/sc", "/sh", "/st", "/sk", "/", "/xx"];
    for (const q of queries) {
      const m = suggest(adversarial, q);
      // total order: sorting an already-sorted array changes nothing.
      const resorted = [...m].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0;
      });
      expect(resorted.map((x) => x.spec.name)).toEqual(m.map((x) => x.spec.name));
      expect(m.length).toBeLessThanOrEqual(8);
    }
  });

  it("colliding aliases across specs (all sharing alias 's') rank deterministically: exact alias wins, then lexicographic name order for the rest", () => {
    const adversarial: CommandSpec[] = [
      { name: "schedule", summary: "s1", aliases: ["s"], intent: { kind: "cancel" } },
      { name: "showdown", summary: "s2", aliases: ["s"], intent: { kind: "cancel" } },
      { name: "scale-up", summary: "s3", aliases: ["s"], intent: { kind: "cancel" } },
    ];
    const m = suggest(adversarial, "/s");
    // All three tie at tier 1 (exact alias "s"); name is also a tier-2 prefix
    // for all three, but exact alias (tier 1) wins over name-prefix (tier 2)
    // in every one of them, so all three land in the SAME tier and the
    // tiebreak is purely lexicographic by name.
    expect(m.map((x) => x.spec.name)).toEqual(["scale-up", "schedule", "showdown"]);
  });
});

describe("acInit / acUpdate", () => {
  it("acInit starts closed with no matches", () => {
    const s = acInit();
    expect(s.open).toBe(false);
    expect(s.matches).toEqual([]);
    expect(s.selected).toBe(0);
  });

  it("opens on a leading slash with matches", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/g");
    expect(s.open).toBe(true);
    expect(s.matches.length).toBeGreaterThan(0);
    expect(s.matches[0].spec.name).toBe("goal");
  });

  it("closes when the buffer no longer has a leading slash", () => {
    const opened = acUpdate(acInit(), TUI_COMMAND_SPECS, "/g");
    const closed = acUpdate(opened, TUI_COMMAND_SPECS, "hello");
    expect(closed.open).toBe(false);
    expect(closed.matches).toEqual([]);
  });

  it("closes (honest empty) when nothing matches, rather than staying open with stale matches", () => {
    const opened = acUpdate(acInit(), TUI_COMMAND_SPECS, "/g");
    const closed = acUpdate(opened, TUI_COMMAND_SPECS, "/zzz9");
    expect(closed.open).toBe(false);
    expect(closed.matches).toEqual([]);
  });

  it("resets selection to 0 when the query text changes", () => {
    let s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s"); // several matches (scale-up/down, showdown, schedule, stream...)
    expect(s.matches.length).toBeGreaterThan(1);
    const moved = acKey(s, "down").state;
    expect(moved.selected).toBe(1);
    const changed = acUpdate(moved, TUI_COMMAND_SPECS, "/sc"); // narrower query
    expect(changed.selected).toBe(0);
  });

  it("preserves (clamped) selection when the query is unchanged", () => {
    let s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s");
    s = acKey(s, "down").state;
    s = acKey(s, "down").state;
    expect(s.selected).toBe(2);
    const same = acUpdate(s, TUI_COMMAND_SPECS, "/s"); // same query text
    expect(same.selected).toBe(2);
  });

  it("clamps selection down when a re-query shrinks the match list below the old selection", () => {
    const specs: CommandSpec[] = [
      { name: "aaa", summary: "1", aliases: [], intent: { kind: "cancel" } },
      { name: "aab", summary: "2", aliases: [], intent: { kind: "cancel" } },
      { name: "aac", summary: "3", aliases: [], intent: { kind: "cancel" } },
    ];
    let s = acUpdate(acInit(), specs, "/aa");
    expect(s.matches.length).toBe(3);
    s = acKey(s, "down").state;
    s = acKey(s, "down").state;
    expect(s.selected).toBe(2);
    // Same query text but a shrunk spec list (simulates matches shrinking) —
    // selection must clamp into range rather than pointing past the end.
    const shrunkSpecs = specs.slice(0, 1);
    const shrunk = acUpdate(s, shrunkSpecs, "/aa");
    expect(shrunk.matches.length).toBe(1);
    expect(shrunk.selected).toBe(0);
  });
});

describe("acKey — navigation", () => {
  function opened(query: string): AcState {
    return acUpdate(acInit(), TUI_COMMAND_SPECS, query);
  }

  it("Tab and Down cycle forward with wraparound", () => {
    let s = opened("/s"); // multiple matches
    const n = s.matches.length;
    expect(n).toBeGreaterThan(1);
    for (let i = 1; i < n; i++) {
      const r = acKey(s, "down");
      expect(r.effect).toBeNull();
      s = r.state;
      expect(s.selected).toBe(i);
    }
    const wrapped = acKey(s, "\x1b[B"); // ANSI down at the end wraps to 0
    expect(wrapped.state.selected).toBe(0);
  });

  it("Shift-Tab and Up cycle backward with wraparound", () => {
    let s = opened("/s");
    const n = s.matches.length;
    const r = acKey(s, "\x1b[Z"); // shift-tab from index 0 wraps to the end
    expect(r.effect).toBeNull();
    expect(r.state.selected).toBe(n - 1);
    const r2 = acKey(r.state, "up");
    expect(r2.state.selected).toBe(n - 2);
  });

  it("keys are no-ops (state unchanged, effect null) when the popup is closed", () => {
    const closed = acInit();
    for (const key of ["down", "up", "tab", "\x1b[Z", "enter", "escape"]) {
      const r = acKey(closed, key);
      expect(r.effect).toBeNull();
      expect(r.state).toEqual(closed);
    }
  });

  it("unrecognized keys while open are no-ops that leave state untouched", () => {
    const s = opened("/g");
    const r = acKey(s, "x");
    expect(r.effect).toBeNull();
    expect(r.state).toEqual(s);
  });
});

describe("acKey — accept", () => {
  it("Enter accepts the currently-selected match and closes the popup", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/go");
    expect(s.matches).toHaveLength(1); // only "goal" contains no 'o' collision with "gateway"
    const r = acKey(s, "enter");
    expect(r.effect).toEqual({ kind: "accept", completed: "/goal ", spec: s.matches[0].spec });
    expect(r.state.open).toBe(false);
    expect(r.state).toEqual(acInit());
  });

  it("preserves already-typed trailing arguments verbatim on accept", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/go stuff");
    expect(s.matches[0].spec.name).toBe("goal");
    const r = acKey(s, "\r");
    expect(r.effect).toEqual({ kind: "accept", completed: "/goal stuff", spec: s.matches[0].spec });
  });

  it("preserves multi-word / irregularly-spaced trailing arguments", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/go   build the thing   now");
    const r = acKey(s, "enter");
    expect(r.effect).toEqual({
      kind: "accept",
      completed: "/goal build the thing   now",
      spec: s.matches[0].spec,
    });
  });

  it("Tab on a single remaining match accepts directly instead of cycling", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/goal"); // exact name -> only "goal" matches
    expect(s.matches.length).toBe(1);
    const r = acKey(s, "tab");
    expect(r.effect).toEqual({ kind: "accept", completed: "/goal ", spec: s.matches[0].spec });
    expect(r.state.open).toBe(false);
  });

  it("Tab with multiple matches cycles instead of accepting", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s");
    expect(s.matches.length).toBeGreaterThan(1);
    const r = acKey(s, "tab");
    expect(r.effect).toBeNull();
    expect(r.state.selected).toBe(1);
  });

  it("accept targets whichever entry is currently selected, not always index 0", () => {
    let s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s");
    s = acKey(s, "down").state;
    const secondSpec = s.matches[1].spec;
    const r = acKey(s, "enter");
    expect(r.effect).toEqual({ kind: "accept", completed: `/${secondSpec.name} `, spec: secondSpec });
  });
});

describe("acKey — dismiss / Esc precedence", () => {
  it("Esc dismisses an open popup without accepting", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/g");
    const r = acKey(s, "escape");
    expect(r.effect).toEqual({ kind: "dismiss" });
    expect(r.state.open).toBe(false);
    expect(r.state.matches).toEqual([]);
  });

  it("Esc on an already-closed popup falls through (effect null) so the integrator applies compose-cancel", () => {
    const r = acKey(acInit(), "\x1b");
    expect(r.effect).toBeNull();
    expect(r.state.open).toBe(false);
  });

  it("a second Esc (after the first closed the popup) also falls through", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/g");
    const first = acKey(s, "escape");
    expect(first.effect).toEqual({ kind: "dismiss" });
    const second = acKey(first.state, "escape");
    expect(second.effect).toBeNull();
  });
});

describe("renderAutocomplete", () => {
  it("returns [] when closed", () => {
    expect(renderAutocomplete(acInit(), 40)).toEqual([]);
  });

  it("returns [] when open but with no matches (defensive — acUpdate never actually produces this)", () => {
    const s: AcState = { open: true, query: "zzz", selected: 0, matches: [] };
    expect(renderAutocomplete(s, 40)).toEqual([]);
  });

  it("renders one row per match, each exactly `width` code points", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s");
    const rows = renderAutocomplete(s, 60);
    expect(rows.length).toBe(s.matches.length);
    for (const row of rows) expect([...row].length).toBe(60);
  });

  it("marks the selected row and only the selected row", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/s");
    const rows = renderAutocomplete(s, 60);
    rows.forEach((row, i) => {
      if (i === s.selected) expect(row.startsWith("▶")).toBe(true);
      else expect(row.startsWith("▶")).toBe(false);
    });
  });

  it("marks matched characters in the name with plain-text asterisks (no ANSI escapes)", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/sched");
    const row = renderAutocomplete(s, 60)[0];
    expect(row).toContain("*sched*ule");
    expect(row).not.toMatch(/\x1b\[/); // no ANSI color codes anywhere
  });

  it("truncates with an ellipsis at narrow widths (20 cols) and stays exactly that wide", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/gateway");
    const rows = renderAutocomplete(s, 20);
    expect(rows.length).toBe(1);
    expect([...rows[0]].length).toBe(20);
    expect(rows[0]).toMatch(/…$/);
  });

  it("pads short content out to the full width rather than leaving a ragged row", () => {
    const specs: CommandSpec[] = [{ name: "x", summary: "y", aliases: [], intent: { kind: "cancel" } }];
    const s = acUpdate(acInit(), specs, "/x");
    const rows = renderAutocomplete(s, 50);
    expect(rows.length).toBe(1);
    expect([...rows[0]].length).toBe(50);
  });

  it("renders at most 8 rows even with many matches", () => {
    const specs: CommandSpec[] = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      summary: `command ${i}`,
      aliases: [],
      intent: { kind: "cancel" as const },
    }));
    const s = acUpdate(acInit(), specs, "/cmd");
    expect(renderAutocomplete(s, 40).length).toBe(8);
  });

  it("includes argHint in the row when present", () => {
    const specs: CommandSpec[] = [
      { name: "goto", summary: "jump somewhere", argHint: "<target>", aliases: [], intent: { kind: "cancel" } },
    ];
    const s = acUpdate(acInit(), specs, "/goto");
    const row = renderAutocomplete(s, 60)[0];
    expect(row).toContain("<target>");
  });
});

describe("end-to-end compose-mode flow", () => {
  it("type '/sc', cycle to schedule, accept, and get a clean completed command", () => {
    let s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/sc");
    expect(s.open).toBe(true);
    const names = s.matches.map((m) => m.spec.name);
    expect(names).toContain("scale-up");
    expect(names).toContain("scale-down");
    expect(names).toContain("schedule");

    const scheduleIdx = names.indexOf("schedule");
    for (let i = 0; i < scheduleIdx; i++) s = acKey(s, "tab").state;
    expect(s.selected).toBe(scheduleIdx);

    const r = acKey(s, "enter");
    expect(r.effect).toEqual({ kind: "accept", completed: "/schedule ", spec: s.matches[scheduleIdx].spec });
    expect(r.state).toEqual(acInit());
  });

  it("typing a full exact command name narrows to exactly one match, ready for Tab-accept", () => {
    const s = acUpdate(acInit(), TUI_COMMAND_SPECS, "/quit");
    expect(s.matches.map((m) => m.spec.name)).toEqual(["quit"]);
    const r = acKey(s, "tab");
    expect(r.effect).toEqual({ kind: "accept", completed: "/quit ", spec: s.matches[0].spec });
  });
});
