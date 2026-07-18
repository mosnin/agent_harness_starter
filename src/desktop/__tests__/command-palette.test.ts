import { describe, it, expect } from "vitest";
import {
  createPaletteEntries,
  DEFAULT_ENTRIES,
  filterEntries,
  initialPaletteState,
  paletteReduce,
  renderPalette,
  escapeHtml,
  type PaletteState,
  type PaletteEntry,
} from "../ui/command-palette";
import { isCommand } from "../ipc/contract";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function open(): PaletteState {
  return paletteReduce(initialPaletteState(), { type: "open" }).state;
}

function entryById(id: string, entries: PaletteEntry[] = DEFAULT_ENTRIES): PaletteEntry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`no entry ${id}`);
  return e;
}

// ---------------------------------------------------------------------------
// registry honesty
// ---------------------------------------------------------------------------

describe("registry", () => {
  it("every constant entry produces a valid contract Command", () => {
    for (const entry of DEFAULT_ENTRIES) {
      if (entry.input) continue; // input entries are covered separately
      const cmd = entry.toCommand();
      expect(cmd).not.toBeNull();
      expect(isCommand(cmd)).toBe(true);
    }
  });

  it("scale up/down target current pool size +/- 1 from context", () => {
    const entries = createPaletteEntries({ poolSize: 4 });
    expect(entryById("pool.scale.up", entries).toCommand()).toEqual({ kind: "pool.scale", size: 5 });
    expect(entryById("pool.scale.down", entries).toCommand()).toEqual({ kind: "pool.scale", size: 3 });
  });

  it("scale down never goes below zero", () => {
    const entries = createPaletteEntries({ poolSize: 0 });
    expect(entryById("pool.scale.down", entries).toCommand()).toEqual({ kind: "pool.scale", size: 0 });
  });
});

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

describe("filterEntries", () => {
  it("returns the full registry (natural order) for an empty query", () => {
    const result = filterEntries(DEFAULT_ENTRIES, "");
    expect(result.map((e) => e.id)).toEqual(DEFAULT_ENTRIES.map((e) => e.id));
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterEntries(DEFAULT_ENTRIES, "   ").length).toBe(DEFAULT_ENTRIES.length);
  });

  it("matches by title substring", () => {
    const result = filterEntries(DEFAULT_ENTRIES, "runtime");
    const ids = result.map((e) => e.id);
    expect(ids).toContain("runtime.start");
    expect(ids).toContain("runtime.stop");
    expect(ids).not.toContain("skills.list");
  });

  it("matches by keyword when the title does not contain the query", () => {
    // "boot" is a keyword of runtime.start, not in any title.
    const result = filterEntries(DEFAULT_ENTRIES, "boot");
    expect(result.map((e) => e.id)).toContain("runtime.start");
  });

  it("ranks a title prefix above a keyword-only match", () => {
    // "s" prefixes "Start.../Stop.../Scale.../Set.../Skills"; ranking must be
    // deterministic and put title matches ahead of pure keyword hits.
    const result = filterEntries(DEFAULT_ENTRIES, "start");
    expect(result[0].id).toBe("runtime.start");
  });

  it("supports fuzzy subsequence matching", () => {
    // "dsp" is a subsequence of "dispatch goal..."
    const result = filterEntries(DEFAULT_ENTRIES, "dsp");
    expect(result.map((e) => e.id)).toContain("goal.dispatch");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterEntries(DEFAULT_ENTRIES, "zzzznope")).toEqual([]);
  });

  it("is deterministic: repeated calls give identical ordering", () => {
    const a = filterEntries(DEFAULT_ENTRIES, "scale").map((e) => e.id);
    const b = filterEntries(DEFAULT_ENTRIES, "scale").map((e) => e.id);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// reducer: open / type / navigate / execute
// ---------------------------------------------------------------------------

describe("paletteReduce", () => {
  it("opens to an empty, list-mode state", () => {
    const state = open();
    expect(state).toEqual({ open: true, query: "", selectedIndex: 0, input: null });
  });

  it("closes back to the initial state", () => {
    const state = open();
    const { state: closed } = paletteReduce(state, { type: "close" });
    expect(closed).toEqual(initialPaletteState());
    expect(closed.open).toBe(false);
  });

  it("typing sets the query and resets selection", () => {
    let state = open();
    state = paletteReduce(state, { type: "next" }).state; // move selection off 0
    state = paletteReduce(state, { type: "setQuery", query: "scale" }).state;
    expect(state.query).toBe("scale");
    expect(state.selectedIndex).toBe(0);
  });

  it("next/prev navigate and wrap around the filtered list", () => {
    let state = open();
    const count = filterEntries(DEFAULT_ENTRIES, "").length;

    state = paletteReduce(state, { type: "next" }).state;
    expect(state.selectedIndex).toBe(1);

    // wrap forward from the last item back to 0
    for (let i = 1; i < count; i++) {
      state = paletteReduce(state, { type: "next" }).state;
    }
    expect(state.selectedIndex).toBe(0);

    // wrap backward from 0 to the last item
    state = paletteReduce(state, { type: "prev" }).state;
    expect(state.selectedIndex).toBe(count - 1);
  });

  it("executes the selected no-input entry, emits its Command, and closes", () => {
    let state = open(); // selectedIndex 0 -> runtime.start
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "runtime.start", mode: "inline", poolSize: 3 });
    expect(isCommand(result.command)).toBe(true);
    expect(result.state.open).toBe(false);
  });

  it("executes the second entry (runtime.stop) after navigating", () => {
    let state = open();
    state = paletteReduce(state, { type: "next" }).state; // -> runtime.stop
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "runtime.stop" });
    expect(isCommand(result.command)).toBe(true);
  });

  it("executes a filtered selection (skills.list) by query", () => {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "list skills" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "skills.list" });
    expect(isCommand(result.command)).toBe(true);
  });

  it("emits no command when executing with an empty filtered list", () => {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "zzzznope" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toBeUndefined();
    expect(result.state.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reducer: input sub-state
// ---------------------------------------------------------------------------

describe("paletteReduce input sub-state (goal.dispatch)", () => {
  function reachDispatchInput(): PaletteState {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "dispatch" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toBeUndefined(); // opens input instead of running
    return result.state;
  }

  it("selecting an input entry opens the input sub-state without a command", () => {
    const state = reachDispatchInput();
    expect(state.input).not.toBeNull();
    expect(state.input?.entryId).toBe("goal.dispatch");
    expect(state.open).toBe(true);
  });

  it("setInput records the typed value", () => {
    let state = reachDispatchInput();
    state = paletteReduce(state, { type: "setInput", value: "ship it" }).state;
    expect(state.input?.value).toBe("ship it");
  });

  it("navigation is inert while in the input sub-state", () => {
    let state = reachDispatchInput();
    const after = paletteReduce(state, { type: "next" }).state;
    expect(after).toEqual(state);
  });

  it("executing with a valid objective emits goal.dispatch and closes", () => {
    let state = reachDispatchInput();
    state = paletteReduce(state, { type: "setInput", value: "  ship the feature  " }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "goal.dispatch", objective: "ship the feature" });
    expect(isCommand(result.command)).toBe(true);
    expect(result.state.open).toBe(false);
  });

  it("executing with an empty objective stays open and emits nothing", () => {
    let state = reachDispatchInput();
    state = paletteReduce(state, { type: "setInput", value: "   " }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toBeUndefined();
    expect(result.state.input).not.toBeNull();
  });

  it("cancelInput returns to the list without a command", () => {
    let state = reachDispatchInput();
    const result = paletteReduce(state, { type: "cancelInput" });
    expect(result.state.input).toBeNull();
    expect(result.state.open).toBe(true);
  });
});

describe("paletteReduce input sub-state (pool.scale.set)", () => {
  function reachScaleInput(): PaletteState {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "set pool size" }).state;
    return paletteReduce(state, { type: "execute" }).state;
  }

  it("emits pool.scale with the parsed integer size", () => {
    let state = reachScaleInput();
    expect(state.input?.entryId).toBe("pool.scale.set");
    state = paletteReduce(state, { type: "setInput", value: "6" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "pool.scale", size: 6 });
    expect(isCommand(result.command)).toBe(true);
  });

  it("rejects a non-numeric size and stays open", () => {
    let state = reachScaleInput();
    state = paletteReduce(state, { type: "setInput", value: "abc" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toBeUndefined();
    expect(result.state.input).not.toBeNull();
  });

  it("floors and clamps a negative/fractional size to a valid Command", () => {
    let state = reachScaleInput();
    state = paletteReduce(state, { type: "setInput", value: "-3" }).state;
    const result = paletteReduce(state, { type: "execute" });
    expect(result.command).toEqual({ kind: "pool.scale", size: 0 });
  });
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

describe("renderPalette", () => {
  it("renders nothing when closed", () => {
    expect(renderPalette(initialPaletteState())).toBe("");
  });

  it("renders the dialog and every entry title when open", () => {
    const html = renderPalette(open());
    expect(html).toContain('class="command-palette"');
    expect(html).toContain('role="dialog"');
    for (const entry of DEFAULT_ENTRIES) {
      expect(html).toContain(escapeHtml(entry.title));
    }
  });

  it("marks the row at selectedIndex as selected", () => {
    let state = open();
    state = paletteReduce(state, { type: "next" }).state; // select index 1
    const html = renderPalette(state);
    // the selected row carries the modifier class and aria-selected="true"
    expect(html).toMatch(/command-palette__row--selected[^>]*data-palette-index="1"/);
    expect(html).toContain('data-palette-index="1"');
    // index 0 is present but not selected
    expect(html).toMatch(/data-palette-index="0"[^]*?aria-selected="false"/);
  });

  it("shows an empty state when no command matches", () => {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "zzzznope" }).state;
    const html = renderPalette(state);
    expect(html).toContain("No matching commands");
  });

  it("renders the input sub-view with the entry label and current value", () => {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "dispatch" }).state;
    state = paletteReduce(state, { type: "execute" }).state; // open input
    state = paletteReduce(state, { type: "setInput", value: "do the work" }).state;
    const html = renderPalette(state);
    expect(html).toContain('data-mode="input"');
    expect(html).toContain("Objective");
    expect(html).toContain('value="do the work"');
  });

  it("escapes dynamic query text (XSS safety)", () => {
    let state = open();
    state = paletteReduce(state, { type: "setQuery", query: "<script>alert(1)</script>" }).state;
    const html = renderPalette(state);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
