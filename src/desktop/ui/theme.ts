/**
 * Hades desktop design system — single source of truth for design tokens.
 *
 * This file is consumed by the Tauri desktop shell (native window, not a
 * browser app). `light` / `dark` are the two token sets; `cssVars` flattens
 * either one into a CSS custom-property block that `tokens.css` layers UI
 * primitives on top of.
 *
 * Palette rationale (see final report for full writeup): a single violet
 * accent — evoking the Styx / oath-on-the-river thesis this tool verifies
 * against — sits on neutrals that lean very slightly warm-violet rather than
 * flat grey, so surfaces feel considered instead of default-Bootstrap-grey.
 * Semantic verdict colors (ok/warn/bad) are fully separate hues from the
 * accent so a "verified" pill is never confusable with an interactive accent
 * element.
 */

export interface ThemeTokens {
  color: Record<string, string>;
  space: Record<string, string>;
  radius: Record<string, string>;
  type: {
    family: Record<string, string>;
    size: Record<string, string>;
    weight: Record<string, number>;
  };
  shadow: Record<string, string>;
  motion: Record<string, string>;
}

// Shared across both themes — spacing, radius, and type scale do not shift
// with color scheme, only the color and shadow token groups do.
const space: ThemeTokens["space"] = {
  "3xs": "2px",
  "2xs": "4px",
  xs: "6px",
  sm: "8px",
  md: "12px",
  lg: "16px",
  xl: "24px",
  "2xl": "32px",
  "3xl": "48px",
  "4xl": "64px",
};

const radius: ThemeTokens["radius"] = {
  xs: "4px",
  sm: "6px",
  md: "8px",
  lg: "12px",
  xl: "16px",
  "2xl": "20px",
  pill: "999px",
  full: "50%",
};

const type: ThemeTokens["type"] = {
  family: {
    sans:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", ' +
      '"Segoe UI", "Inter", system-ui, sans-serif',
    mono:
      '"SF Mono", ui-monospace, "Cascadia Code", "JetBrains Mono", ' +
      "Menlo, Consolas, monospace",
    display:
      '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", ' +
      "system-ui, sans-serif",
  },
  size: {
    "2xs": "11px",
    xs: "12px",
    sm: "13px",
    md: "14px",
    base: "15px",
    lg: "17px",
    xl: "20px",
    "2xl": "24px",
    "3xl": "30px",
    "4xl": "38px",
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
};

const motion: ThemeTokens["motion"] = {
  instant: "80ms",
  fast: "120ms",
  base: "180ms",
  slow: "260ms",
  slower: "400ms",
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};

export const light: ThemeTokens = {
  color: {
    // Base surfaces — neutrals biased ~2-3° toward the violet accent hue
    // instead of flat/default grey.
    bg: "#f6f6f9",
    "bg-elevated": "#fbfbfd",
    surface: "#ffffff",
    "surface-2": "#f1f1f6",
    "surface-hover": "#eceef4",
    "surface-pressed": "#e4e6ef",

    // Ink / text
    ink: "#1c1c22",
    "ink-secondary": "#5c5c68",
    "ink-tertiary": "#8b8b98",
    "ink-on-accent": "#ffffff",
    "ink-disabled": "#b3b3bd",

    // Structure
    border: "#e3e3ea",
    "border-strong": "#d0d0da",
    divider: "#ececf1",
    overlay: "rgba(28, 28, 34, 0.32)",
    ring: "rgba(110, 86, 207, 0.45)",

    // Accent — single hue, used for interactive/selection state only
    accent: "#6e56cf",
    "accent-hover": "#5d47b8",
    "accent-pressed": "#4c3a99",
    "accent-soft": "#efebfb",
    "accent-soft-hover": "#e4dcf8",

    // Semantic verdict colors — deliberately distinct hues from accent
    ok: "#1a8f5e",
    "ok-soft": "#e4f5ed",
    warn: "#b3730c",
    "warn-soft": "#faefdc",
    bad: "#c93f3f",
    "bad-soft": "#fbe9e9",

    // Chrome
    titlebar: "#f6f6f9",
    sidebar: "#f0f0f5",
    scrollbar: "rgba(28, 28, 34, 0.22)",
  },
  space,
  radius,
  type,
  shadow: {
    none: "none",
    xs: "0 1px 2px rgba(28, 28, 34, 0.05)",
    sm: "0 1px 2px rgba(28, 28, 34, 0.06), 0 1px 1px rgba(28, 28, 34, 0.04)",
    md: "0 2px 8px rgba(28, 28, 34, 0.08), 0 1px 2px rgba(28, 28, 34, 0.05)",
    lg: "0 8px 24px rgba(28, 28, 34, 0.10), 0 2px 6px rgba(28, 28, 34, 0.06)",
    xl: "0 16px 48px rgba(28, 28, 34, 0.14), 0 4px 12px rgba(28, 28, 34, 0.07)",
    inset: "inset 0 1px 2px rgba(28, 28, 34, 0.06)",
    focus: "0 0 0 3px rgba(110, 86, 207, 0.35)",
  },
  motion,
};

export const dark: ThemeTokens = {
  color: {
    bg: "#0f0f13",
    "bg-elevated": "#141418",
    surface: "#1a1a20",
    "surface-2": "#212129",
    "surface-hover": "#26262f",
    "surface-pressed": "#2d2d38",

    ink: "#f1f1f5",
    "ink-secondary": "#a8a8b6",
    "ink-tertiary": "#78788a",
    "ink-on-accent": "#ffffff",
    "ink-disabled": "#54545f",

    border: "#2a2a33",
    "border-strong": "#38383f",
    divider: "#232329",
    overlay: "rgba(0, 0, 0, 0.55)",
    ring: "rgba(151, 132, 255, 0.5)",

    accent: "#9784ff",
    "accent-hover": "#a998ff",
    "accent-pressed": "#8571f2",
    "accent-soft": "#221f3a",
    "accent-soft-hover": "#2a2647",

    ok: "#3ed9a0",
    "ok-soft": "#123328",
    warn: "#f0b854",
    "warn-soft": "#3a2c14",
    bad: "#ff7a7a",
    "bad-soft": "#3a1c1e",

    titlebar: "#0f0f13",
    sidebar: "#141418",
    scrollbar: "rgba(241, 241, 245, 0.18)",
  },
  space,
  radius,
  type,
  shadow: {
    none: "none",
    xs: "0 1px 2px rgba(0, 0, 0, 0.30)",
    sm: "0 1px 3px rgba(0, 0, 0, 0.36), 0 1px 1px rgba(0, 0, 0, 0.24)",
    md: "0 2px 10px rgba(0, 0, 0, 0.42), 0 1px 3px rgba(0, 0, 0, 0.30)",
    lg: "0 10px 28px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.32)",
    xl: "0 20px 56px rgba(0, 0, 0, 0.56), 0 6px 16px rgba(0, 0, 0, 0.36)",
    inset: "inset 0 1px 2px rgba(0, 0, 0, 0.40)",
    focus: "0 0 0 3px rgba(151, 132, 255, 0.45)",
  },
  motion,
};

/**
 * Flattens a ThemeTokens object into a `:root{ --group-key:value; ... }`
 * CSS custom-property string. Nested groups (color, space, radius, shadow,
 * motion, type.family/size/weight) are joined with `-`, e.g.
 * `--color-accent`, `--type-size-md`, `--type-weight-semibold`.
 */
export function cssVars(t: ThemeTokens): string {
  const decls: string[] = [];

  const addGroup = (prefix: string, group: Record<string, string | number>) => {
    for (const key of Object.keys(group)) {
      decls.push(`--${prefix}-${key}:${group[key]};`);
    }
  };

  addGroup("color", t.color);
  addGroup("space", t.space);
  addGroup("radius", t.radius);
  addGroup("type-family", t.type.family);
  addGroup("type-size", t.type.size);
  addGroup("type-weight", t.type.weight);
  addGroup("shadow", t.shadow);
  addGroup("motion", t.motion);

  return `:root{${decls.join("")}}`;
}
