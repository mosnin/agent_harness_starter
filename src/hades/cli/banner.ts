/**
 * The `hades` wordmark — block-terminal lettering for the CLI's front door.
 *
 * Pure string builders: no colour codes baked into the glyphs, no direct
 * writes, no environment reads at module scope. The caller decides whether to
 * colour it (`renderBanner({ color: true })`) and where to print it, which is
 * what keeps the banner testable and keeps piped/CI output clean.
 *
 * Two widths, because a banner that wraps is worse than no banner: the full
 * block form needs 44 columns, and anything narrower falls back to a compact
 * one-line mark. `renderBanner` picks for you from the width you pass.
 */

/** Columns the full block wordmark needs before it starts wrapping. */
export const BANNER_MIN_WIDTH = 44;

/**
 * The block wordmark, one string per row. Drawn with U+2588/U+2584/U+2580
 * (full/lower/upper half blocks) so it renders in any monospace terminal font
 * without needing a Nerd Font or box-drawing support.
 */
const BLOCK_ROWS: readonly string[] = [
  "█  █  ▄▀▀▄  █▀▀▄  █▀▀▀  ▄▀▀▀",
  "████  █▄▄█  █  █  █▀▀   ▀▀▀▄",
  "█  █  █  █  █▄▄▀  █▄▄▄  ▀▄▄▀",
];

/** ANSI 256-colour cyan ramp, lightest row first — matches the product mark. */
const ROW_COLORS: readonly string[] = ["[38;5;51m", "[38;5;45m", "[38;5;39m"];
const DIM = "[2m";
const RESET = "[0m";

export interface BannerOptions {
  /** Emit ANSI colour. Callers should pass false for pipes, CI and `--json`. */
  color?: boolean;
  /** Terminal width; below {@link BANNER_MIN_WIDTH} the compact mark is used. */
  width?: number;
  /** Shown under the wordmark, e.g. the version. Omitted when blank. */
  tagline?: string;
}

/** The full block wordmark, optionally coloured. One row per line. */
export function renderBlockBanner(color = false): string {
  return BLOCK_ROWS.map((row, i) => (color ? `${ROW_COLORS[i] ?? ""}${row}${RESET}` : row)).join("\n");
}

/** Single-line mark for narrow terminals. */
export function renderCompactBanner(color = false): string {
  const mark = "▚ hades";
  return color ? `${ROW_COLORS[0]}${mark}${RESET}` : mark;
}

/**
 * The banner as a single printable string: wordmark, then an optional dim
 * tagline. Never ends with a trailing newline — the caller controls spacing.
 */
export function renderBanner(opts: BannerOptions = {}): string {
  const { color = false, width = BANNER_MIN_WIDTH, tagline } = opts;
  const mark = width >= BANNER_MIN_WIDTH ? renderBlockBanner(color) : renderCompactBanner(color);
  const trimmed = tagline?.trim();
  if (!trimmed) return mark;
  const line = color ? `${DIM}${trimmed}${RESET}` : trimmed;
  return `${mark}\n${line}`;
}

/**
 * Whether a banner should be drawn at all, decided from the real environment
 * rather than guessed: never when output is piped, never in CI, never when
 * `NO_COLOR`/`HADES_NO_BANNER` is set. Splitting this out from the renderers
 * is what lets tests assert the policy without a TTY.
 */
export function shouldShowBanner(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (env.HADES_NO_BANNER) return false;
  if (env.CI) return false;
  return true;
}

/** Colour policy, kept separate from banner policy: `NO_COLOR` is honoured. */
export function shouldUseColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === "dumb") return false;
  return true;
}
