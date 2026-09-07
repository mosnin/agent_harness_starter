import { describe, it, expect } from "vitest";
import { eventShortcut, formatShortcut, parseShortcuts } from "../ui/preferences";
const modifiers = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
describe("Mac shortcut presentation and matching", () => {
  it("matches Option combinations using their physical key, since macOS changes the character", () => {
    expect(eventShortcut({ ...modifiers, key: "˚", code: "KeyK", altKey: true })).toBe("mod+alt+k");
    expect(eventShortcut({ ...modifiers, key: "æ", code: "Semicolon", altKey: true })).toBe("mod+alt+;");
  });
  it("normalizes shifted punctuation but keeps ordinary layout-specific characters", () => {
    expect(eventShortcut({ ...modifiers, key: "?", code: "Slash", shiftKey: true })).toBe("mod+shift+/");
    expect(eventShortcut({ ...modifiers, key: "z", code: "KeyY" })).toBe("mod+z");
  });
  it("displays the actual customized binding", () => {
    const bindings = parseShortcuts({ new: "mod+shift+alt+l" });
    expect(formatShortcut(bindings.new)).toBe("⌘ ⇧ ⌥ L");
  });
});
