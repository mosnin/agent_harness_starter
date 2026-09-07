export const shortcutDefaults: Record<string, { label: string; key: string }> =
  {
    new: { label: "New conversation", key: "mod+n" },
    "tab-new": { label: "New tab", key: "mod+t" },
    "quick-open": { label: "Quick open", key: "mod+p" },
    palette: { label: "Command palette", key: "mod+k" },
    settings: { label: "Settings", key: "mod+," },
    find: { label: "Find in conversation", key: "mod+f" },
    sidebar: { label: "Sidebar", key: "mod+b" },
    files: { label: "File inspector", key: "mod+j" },
    git: { label: "Git review", key: "mod+g" },
    "tab-close": { label: "Close tab", key: "mod+w" },
    "tab-reopen": { label: "Reopen tab", key: "mod+shift+t" },
    popout: { label: "New window", key: "mod+shift+n" },
    hud: { label: "Floating chat", key: "mod+shift+h" },
    statusbar: { label: "Status bar", key: "mod+shift+s" },
    shortcuts: { label: "Keyboard shortcuts", key: "mod+/" },
  };
export function parseShortcuts(input: Record<string, unknown>) {
  const result: Record<string, string> = {},
    seen = new Set<string>();
  for (const [action, fallback] of Object.entries(shortcutDefaults)) {
    const key = String(input[action] ?? fallback.key)
      .trim()
      .toLowerCase()
      .replace(/\s/g, "");
    if (!/^mod\+(?:shift\+)?(?:alt\+)?[a-z0-9,./;\[\]`-]$/.test(key))
      throw new Error(
        `${fallback.label}: use mod+k or mod+shift+k (mod is Command on Mac).`,
      );
    if (
      [
        "mod+c",
        "mod+v",
        "mod+x",
        "mod+a",
        "mod+z",
        "mod+q",
        "mod+h",
        "mod+m",
        "mod+shift+z",
      ].includes(key)
    )
      throw new Error(`${key} is reserved for the system or text editing.`);
    if (seen.has(key))
      throw new Error(`Two actions use ${key}. Choose a different shortcut.`);
    seen.add(key);
    result[action] = key;
  }
  return result;
}
export function eventShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
) {
  return (
    (e.metaKey || e.ctrlKey ? "mod+" : "") +
    (e.shiftKey ? "shift+" : "") +
    (e.altKey ? "alt+" : "") +
    e.key.toLowerCase()
  );
}
export const themeMapping: Record<string, string> = {
  "editor.background": "--bg",
  "editor.foreground": "--text",
  "sideBar.background": "--sidebar",
  "panel.background": "--panel",
  descriptionForeground: "--muted",
  "panel.border": "--line",
  "list.hoverBackground": "--hover",
  focusBorder: "--accent",
  "list.activeSelectionBackground": "--accent-soft",
};
export function parseTheme(content: string) {
  if (content.length > 1_000_000)
    throw new Error("Theme file is limited to 1 MB");
  // JSONC comments and trailing commas, without altering quoted URLs/strings.
  const json = content
    .replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m) =>
      m.startsWith('"') ? m : "",
    )
    .replace(/("(?:\\.|[^"\\])*"|,)\s*(?=[}\]])/g, (m, token) =>
      token === "," ? "" : m,
    );
  const data = JSON.parse(json);
  if (!data.colors || typeof data.colors !== "object")
    throw new Error("Choose a VS Code color theme with a colors object");
  const colors: Record<string, string> = {};
  for (const [key, css] of Object.entries(themeMapping)) {
    const value = data.colors[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
    )
      throw new Error(`Invalid color for ${key}; use hexadecimal colors`);
    colors[css] = value;
  }
  if (!colors["--bg"] || !colors["--text"])
    throw new Error("Theme needs editor.background and editor.foreground");
  return {
    name: String(data.name ?? "Imported theme").slice(0, 80),
    base: data.type === "light" ? "light" : "dark",
    colors,
  };
}
