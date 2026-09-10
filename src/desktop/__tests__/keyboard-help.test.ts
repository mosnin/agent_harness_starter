import { describe, it, expect } from "vitest";
import { renderKeyboardHelp, helpFocusTrap, helpItemId } from "../ui/keyboard-help";
import { KeymapRegistry, defaultBindings, type KeyBinding, type KeyContext } from "../ui/keyboard-nav";

function ctx(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    nav: "run",
    overlayOpen: true,
    paletteOpen: false,
    editing: false,
    running: false,
    listSize: 5,
    listIndex: 0,
    platform: "other",
    ...overrides,
  };
}

function extractIds(html: string): string[] {
  const ids: string[] = [];
  const re = /data-focusable="true"[^>]*\sid="([^"]+)"|id="([^"]+)"[^>]*\sdata-focusable="true"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    ids.push(m[1] ?? m[2]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// renderKeyboardHelp
// ---------------------------------------------------------------------------

describe("renderKeyboardHelp", () => {
  it("renders nothing when the overlay is closed", () => {
    const registry = new KeymapRegistry(defaultBindings());
    expect(renderKeyboardHelp(registry, ctx({ overlayOpen: false }))).toBe("");
  });

  it("renders a dialog with the right ARIA wiring when open", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const html = renderKeyboardHelp(registry, ctx());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-help-open="true"');
    expect(html).toContain('aria-labelledby="keyboard-help-title"');
    expect(html).toContain('id="keyboard-help-title"');
    expect(html).toMatch(/<h2[^>]*id="keyboard-help-title"[^>]*>Keyboard shortcuts<\/h2>/);
  });

  it("shows every eligible binding's label and platform-correct chord", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const html = renderKeyboardHelp(registry, ctx({ platform: "mac" }));
    expect(html).toContain("Open command palette");
    expect(html).toContain("⌘K");
    expect(html).toContain("Go to Run");
  });

  it("renders Ctrl+ text (not ⌘) on non-mac platforms", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const html = renderKeyboardHelp(registry, ctx({ platform: "other" }));
    expect(html).toContain("Ctrl+K");
    expect(html).not.toContain("⌘K");
  });

  it("respects when() clauses: only the applicable start/stop binding shows", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const runningHtml = renderKeyboardHelp(registry, ctx({ running: true }));
    expect(runningHtml).toContain("Stop runtime");
    expect(runningHtml).not.toContain("Start runtime");

    const stoppedHtml = renderKeyboardHelp(registry, ctx({ running: false }));
    expect(stoppedHtml).toContain("Start runtime");
    expect(stoppedHtml).not.toContain("Stop runtime");
  });

  it("groups bindings under their `group`, sorted alphabetically", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const html = renderKeyboardHelp(registry, ctx());
    const globalIdx = html.indexOf(">Global<");
    const listIdx = html.indexOf(">List<");
    const navIdx = html.indexOf(">Navigation<");
    const viewIdx = html.indexOf(">View<");
    expect(globalIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(globalIdx);
    expect(navIdx).toBeGreaterThan(listIdx);
    expect(viewIdx).toBeGreaterThan(navIdx);
  });

  it("every eligible binding is rendered as a focusable, uniquely-id'd row", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const eligibleCount = registry.bindings().filter((b) => !b.when || b.when(ctx())).length;
    const html = renderKeyboardHelp(registry, ctx());
    const ids = extractIds(html);
    expect(ids).toHaveLength(eligibleCount);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(helpItemId(0));
  });

  it("HTML-escapes binding labels and group names", () => {
    const dangerous: KeyBinding = {
      id: "danger",
      scope: "global",
      sequence: [{ key: "z" }],
      action: { type: "focus", op: "next" },
      label: `<script>alert("x")</script>`,
      group: `<b>Danger & Co</b>`,
    };
    const registry = new KeymapRegistry([dangerous]);
    const html = renderKeyboardHelp(registry, ctx());
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Danger &amp; Co&lt;/b&gt;");
  });

  it("shows a graceful empty state when no bindings are eligible", () => {
    const registry = new KeymapRegistry([
      {
        id: "hidden",
        scope: "global",
        sequence: [{ key: "z" }],
        action: { type: "focus", op: "next" },
        label: "Hidden",
        group: "Hidden group",
        when: () => false,
      },
    ]);
    const html = renderKeyboardHelp(registry, ctx());
    expect(html).toContain("No shortcuts available");
    expect(html).not.toContain("Hidden");
  });

  it("uses no framework markup — a plain HTML string, same discipline as command-palette.ts", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const html = renderKeyboardHelp(registry, ctx());
    expect(typeof html).toBe("string");
    expect(html.trim().startsWith("<div")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// helpFocusTrap
// ---------------------------------------------------------------------------

describe("helpFocusTrap", () => {
  const ids = ["a", "b", "c"];

  it("advances forward and wraps past the last item", () => {
    expect(helpFocusTrap(ids, 0, "next")).toBe(1);
    expect(helpFocusTrap(ids, 1, "next")).toBe(2);
    expect(helpFocusTrap(ids, 2, "next")).toBe(0);
  });

  it("advances backward and wraps past the first item", () => {
    expect(helpFocusTrap(ids, 2, "prev")).toBe(1);
    expect(helpFocusTrap(ids, 1, "prev")).toBe(0);
    expect(helpFocusTrap(ids, 0, "prev")).toBe(2);
  });

  it("resolves 'nothing focused yet' (-1) to the first item on next", () => {
    expect(helpFocusTrap(ids, -1, "next")).toBe(0);
  });

  it("resolves 'nothing focused yet' (-1) to the last item on prev", () => {
    expect(helpFocusTrap(ids, -1, "prev")).toBe(2);
  });

  it("returns -1 for an empty id list", () => {
    expect(helpFocusTrap([], 0, "next")).toBe(-1);
    expect(helpFocusTrap([], -1, "prev")).toBe(-1);
  });

  it("round-trips a full lap in both directions", () => {
    let i = 0;
    for (let step = 0; step < ids.length; step++) i = helpFocusTrap(ids, i, "next");
    expect(i).toBe(0);
    for (let step = 0; step < ids.length; step++) i = helpFocusTrap(ids, i, "prev");
    expect(i).toBe(0);
  });
});
