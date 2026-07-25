import { describe, it, expect } from "vitest";
import { renderShell, renderSidebar, NAV, intentToCommand, esc, type NavKey } from "../ui/shell";
import { initialState } from "../core/app-store";
import type { AppState } from "../core/app-store";

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...initialState(), ...overrides };
}

describe("renderShell", () => {
  it("embeds the content slot and the sidebar in the app frame", () => {
    const html = renderShell({ state: initialState(), active: "run" }, "<p>hello-content-marker</p>");
    expect(html).toContain("hello-content-marker");
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="titlebar"');
  });

  it("reserves macOS traffic-light space in the titlebar", () => {
    const html = renderShell({ state: initialState(), active: "settings" }, "<p>x</p>");
    expect(html).toContain("titlebar__traffic-light-space");
  });
});

describe("renderSidebar", () => {
  it("marks the active nav item and leaves the others inactive", () => {
    const html = renderSidebar(initialState(), "trust");
    expect(html).toContain('class="nav-item nav-item--active" data-nav="trust"');
    expect(html).not.toContain('class="nav-item nav-item--active" data-nav="run"');
  });

  it("shows the live worker count and running state from AppState", () => {
    const state = stateWith({
      running: true,
      mode: "inline",
      poolSize: 5,
      workers: [
        { id: "w-1", status: "busy", capabilities: [] },
        { id: "w-2", status: "idle", capabilities: [] },
        { id: "w-3", status: "dead", capabilities: [] }, // not live
        { id: "w-4", status: "killed", capabilities: [] }, // not live
      ],
    });
    const html = renderSidebar(state, "workers");
    // liveWorkerCount excludes dead/killed => 2 live, out of pool size 5
    expect(html).toContain(">2/5<");
    expect(html).toContain("status-dot--on");
    expect(html).not.toContain("status-dot--off");
  });

  it("reflects a stopped runtime with the off-state status dot", () => {
    const state = stateWith({ running: false, mode: "", poolSize: 0 });
    const html = renderSidebar(state, "run");
    expect(html).toContain("status-dot--off");
  });
});

describe("NAV", () => {
  it("covers exactly the nine nav keys", () => {
    const keys = NAV.map((n) => n.key).sort();
    const expected: NavKey[] = ["compare", "fleet", "metrics", "run", "settings", "skills", "state", "trust", "workers"].sort() as NavKey[];
    expect(keys).toEqual(expected);
  });

  it("gives every nav key an icon", () => {
    // A NavKey added without an icon would render an empty span in the
    // sidebar; ICONS is a Record<NavKey, string>, so this asserts the
    // runtime table actually has a non-empty entry for each.
    for (const item of NAV) {
      const html = renderSidebar(initialState(), item.key);
      expect(html).toContain(`data-nav="${item.key}"`);
      expect(html).toContain("<svg");
    }
  });
});

describe("intentToCommand", () => {
  it("maps runtime.start and runtime.stop", () => {
    expect(intentToCommand({ cmd: "runtime.start" })).toEqual({
      kind: "runtime.start",
      mode: "inline",
      poolSize: 3,
    });
    expect(intentToCommand({ cmd: "runtime.stop" })).toEqual({ kind: "runtime.stop" });
  });

  it("maps pool.scale.up to pool.scale with current+1, using the passed value", () => {
    expect(intentToCommand({ cmd: "pool.scale.up", value: "2" })).toEqual({
      kind: "pool.scale",
      size: 3,
    });
  });

  it("maps goal.dispatch to goal.dispatch{objective}", () => {
    expect(intentToCommand({ cmd: "goal.dispatch", value: "ship the feature" })).toEqual({
      kind: "goal.dispatch",
      objective: "ship the feature",
    });
  });

  it("returns null for an unknown intent", () => {
    expect(intentToCommand({ cmd: "not.a.real.command" })).toBeNull();
  });
});

describe("esc", () => {
  it("escapes &, <, and >", () => {
    expect(esc("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
});

describe("XSS safety", () => {
  it("escapes a script tag flowing through a run objective into the sidebar", () => {
    const state = stateWith({
      runs: [{ goalId: "g-1", objective: "<script>alert(1)</script>", status: "running" }],
    });
    const html = renderSidebar(state, "run");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
