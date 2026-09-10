/**
 * Keyboard engine <-> renderer integration.
 *
 * `keyboard-nav.ts` / `keyboard-help.ts` were built as standalone modules
 * with no wiring; these tests are what make them the app's REAL keyboard,
 * driven through `createApp().handleKey` against the actual default bindings
 * — every NavKey reachable, the help overlay mountable, Escape unwinding in
 * its fixed order, and the text-entry guard holding.
 */
import { describe, it, expect } from "vitest";

import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/renderer";
import { NAV } from "../ui/shell";
import type { AppEvent, Command } from "../ipc/contract";
import { defaultBindings, isDestructiveCommandKind, KeymapRegistry } from "../ui/keyboard-nav";

function makeFakeBridge() {
  const sent: Command[] = [];
  const bridge: Bridge = {
    send(cmd) {
      sent.push(cmd);
    },
    onEvent() {
      return () => {};
    },
    async start() {},
    async stop() {},
  };
  return { bridge, sent };
}

function app(platform: "mac" | "other" = "other") {
  const { bridge, sent } = makeFakeBridge();
  return { app: createApp(bridge, { platform }), sent };
}

describe("keymap -> renderer", () => {
  it("reaches every NavKey through its positional mod+<n> chord", () => {
    NAV.forEach((item, index) => {
      const { app: a } = app();
      const consumed = a.handleKey({ key: String(index + 1), ctrlKey: true });
      expect(consumed).toBe(true);
      expect(a.getNav()).toBe(item.key);
    });
  });

  it("reaches every NavKey through its mnemonic `g <letter>` sequence", () => {
    const registry = new KeymapRegistry(defaultBindings());
    for (const item of NAV) {
      const binding = registry.bindings("nav").find((b) => b.id === `nav.goto.${item.key}`);
      expect(binding, `no goto binding for ${item.key}`).toBeDefined();
      const letter = binding!.sequence[1].key;

      const { app: a } = app();
      // First chord: consumed, but nothing happens yet.
      expect(a.handleKey({ key: "g" })).toBe(true);
      expect(a.getNav()).toBe("run");
      expect(a.handleKey({ key: letter })).toBe(true);
      expect(a.getNav()).toBe(item.key);
    }
  });

  it("opens the palette on mod+K and closes it on Escape", () => {
    const { app: a } = app();
    expect(a.html()).not.toContain('data-palette-open="true"');
    expect(a.handleKey({ key: "k", ctrlKey: true })).toBe(true);
    expect(a.html()).toContain('data-palette-open="true"');
    expect(a.handleKey({ key: "Escape" })).toBe(true);
    expect(a.html()).not.toContain('data-palette-open="true"');
  });

  it("treats Cmd (not Ctrl) as `mod` on mac", () => {
    const mac = app("mac");
    expect(mac.app.handleKey({ key: "k", ctrlKey: true })).toBe(false);
    expect(mac.app.html()).not.toContain('data-palette-open="true"');
    expect(mac.app.handleKey({ key: "k", metaKey: true })).toBe(true);
    expect(mac.app.html()).toContain('data-palette-open="true"');
  });

  it("mounts the real keyboard-help overlay on `?` and closes it on Escape", () => {
    const { app: a } = app();
    expect(a.handleKey({ key: "?", shiftKey: true })).toBe(true);
    const open = a.html();
    expect(open).toContain('data-help-open="true"');
    expect(open).toContain('role="dialog"');
    expect(open).toContain("Keyboard shortcuts");
    // It lists real bindings derived from the real NAV table.
    expect(open).toContain(`Go to ${NAV[0].label}`);

    expect(a.handleKey({ key: "Escape" })).toBe(true);
    expect(a.html()).not.toContain('data-help-open="true"');
  });

  it("never mounts the help sheet and the palette at the same time", () => {
    const { app: a } = app();
    a.help("open");
    a.palette({ type: "open" });
    expect(a.html()).toContain('data-palette-open="true"');
    expect(a.html()).not.toContain('data-help-open="true"');

    a.help("open");
    expect(a.html()).toContain('data-help-open="true"');
    expect(a.html()).not.toContain('data-palette-open="true"');
  });

  it("blocks bare-letter navigation while a text field is focused, but not mod chords", () => {
    const { app: a } = app();
    expect(a.handleKey({ key: "g", targetEditable: true, targetTag: "input" })).toBe(false);
    expect(a.getNav()).toBe("run");
    // A modifier chord is still allowed from inside a field.
    expect(a.handleKey({ key: "2", ctrlKey: true, targetEditable: true, targetTag: "input" })).toBe(true);
    expect(a.getNav()).toBe(NAV[1].key);
  });

  it("Escape cancels a half-typed chord instead of leaking it", () => {
    const { app: a } = app();
    expect(a.handleKey({ key: "g" })).toBe(true);
    expect(a.handleKey({ key: "Escape" })).toBe(true);
    // The second key of the aborted sequence must not still complete it.
    const letter = new KeymapRegistry(defaultBindings())
      .bindings("nav")
      .find((b) => b.id === "nav.goto.state")!.sequence[1].key;
    a.handleKey({ key: letter });
    expect(a.getNav()).toBe("run");
  });

  it("sends the real runtime command bound to mod+Enter", () => {
    const { app: a, sent } = app();
    expect(a.handleKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(sent).toEqual([{ kind: "runtime.start", mode: "inline", poolSize: 3 }]);
  });

  it("matches a shifted-punctuation chord from the character a real keyboard reports", () => {
    // Regression: `shift+/` never matches a live event, because pressing
    // Shift+`/` reports `key: "?"` (with shiftKey set). A help binding
    // spelled `shift+/` was therefore unreachable in the running app.
    const { app: a } = app();
    expect(a.handleKey({ key: "?", shiftKey: true })).toBe(true);
    expect(a.html()).toContain('data-help-open="true"');
  });

  it("does not swallow list motion on a view with no list", () => {
    // Regression: the list bindings were ungated, so bare j/k/Enter/Space
    // were consumed app-wide and returned a `focus` action nothing could
    // perform — breaking Space-to-scroll and Enter-on-a-focused-button.
    const { app: a, sent } = app();
    for (const key of ["j", "k", "Enter", " ", "Home", "End", "PageDown", "PageUp"]) {
      expect(a.handleKey({ key }), `"${key}" was swallowed`).toBe(false);
    }
    expect(sent).toEqual([]);
    expect(a.getNav()).toBe("run");
  });

  it("`r` refreshes the surface it is pressed on, and is not consumed where there is nothing to refresh", () => {
    const { app: a, sent } = app();
    a.setNav("state");
    sent.length = 0;
    expect(a.handleKey({ key: "r" })).toBe(true);
    expect(sent).toContainEqual({ kind: "state.status" });

    const other = app();
    other.app.setNav("settings");
    other.sent.length = 0;
    // Settings has no refresh path — the key goes back to the webview
    // rather than being eaten by a binding that does nothing.
    expect(other.app.handleKey({ key: "r" })).toBe(false);
    expect(other.sent).toEqual([]);
  });

  it("leaves an unbound key to the webview", () => {
    const { app: a, sent } = app();
    expect(a.handleKey({ key: "F13" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("never throws for a malformed key event", () => {
    const { app: a } = app();
    expect(() => a.handleKey({ key: "" })).not.toThrow();
    expect(() => a.handleKey({ key: "Shift", shiftKey: true })).not.toThrow();
  });
});

describe("default bindings — safety invariants still hold with the new NavKey", () => {
  it("registers without a conflict", () => {
    const registry = new KeymapRegistry(defaultBindings());
    expect(registry.conflicts()).toEqual([]);
  });

  it("never binds a destructive command to a bare unmodified letter", () => {
    for (const b of defaultBindings()) {
      if (b.action.type !== "command") continue;
      if (!isDestructiveCommandKind(b.action.command.kind)) continue;
      for (const chord of b.sequence) {
        expect(chord.mod || chord.alt || chord.shift, `${b.id} is bare`).toBe(true);
      }
    }
  });

  it("gives every NavKey a unique goto letter", () => {
    const registry = new KeymapRegistry(defaultBindings());
    const letters = NAV.map((n) => registry.bindings("nav").find((b) => b.id === `nav.goto.${n.key}`)!.sequence[1].key);
    expect(new Set(letters).size).toBe(NAV.length);
    expect(letters).not.toContain("g");
  });
});
