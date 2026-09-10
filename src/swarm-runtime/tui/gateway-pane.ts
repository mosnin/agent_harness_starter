/**
 * gateway-pane.ts — pure, deterministic GATEWAY pane for the interactive TUI
 * (`hades tui`).
 *
 * Renders four sections in one box: PLATFORMS (each configured connector's
 * real-vs-offline probe result, plus the live inbound/outbound/rate-limited
 * traffic counters), ENGINE (which reply engine the gateway is actually
 * wired to — honestly labelled "mock" when it is a mock), TRAFFIC (a
 * scrollable, selectable feed of recent inbound/outbound messages), and
 * BADGES (the honest verified/abstained/unverified trust-badge tally).
 *
 * Every function here is a pure string-in/string-out or state-in/state-out
 * transform: no I/O, no timers, no ANSI escapes, no imports outside this
 * file's own declarations. Data arrives as plain JSON-compatible snapshots
 * the orchestrator can populate directly from `GatewayProcess.status()` (the
 * `probes`/`counters` shape), the `ConnectorHub` `Mirror` callback (the
 * `traffic` rows), and `BadgeStamper` outputs (the `badges` tally) — with no
 * adapter layer required. This mirrors `fleet-pane.ts`'s conventions exactly
 * so `tui/app.ts` can adopt this pane with zero adapter code.
 *
 * Visual conventions match `fleet-pane.ts` / `render.ts` / `panes.ts`:
 * `╭─╮ │ ├ ┤ ╰─╯` box drawing, a default width of 72 code points, and a hard
 * clamp — no line this module emits ever exceeds the requested width. Width
 * is measured in Unicode code points (via `[...s].length`) so multi-byte
 * platform/user/preview text never desyncs the border.
 *
 * Honesty discipline:
 *  - An empty PLATFORMS list never renders as a bare box: it says
 *    "no connectors probed yet" explicitly.
 *  - An empty TRAFFIC feed says "no traffic yet" explicitly.
 *  - `badges === null` (nothing has been assessed yet) renders
 *    "no assessed replies yet" — this is never conflated with a real,
 *    counted `{ verified: 0, abstained: 0, unverified: 0 }` tally after
 *    assessment has actually happened. A badge tally is only ever rendered
 *    with real accumulated counts, never fabricated zeros.
 *  - `engine === null` (nothing attached) renders "engine: not attached".
 *    An attached engine always renders its real `mode` — a "mock" engine is
 *    never displayed without the literal word "mock".
 *  - The inbound/outbound/rate-limited counters are printed verbatim from
 *    the snapshot the caller supplies; this module never derives, sums, or
 *    invents a number of its own.
 *  - Free text that flows into the box (platform ids, probe detail strings,
 *    engine requested/detail strings, traffic user/preview text) is run
 *    through `sanitizePreview` before display, so C0/C1 control characters
 *    and ESC (the building block of ANSI escape injection) never reach the
 *    rendered frame, regardless of what an upstream connector handed us.
 */

// ---------------------------------------------------------------------------
// Snapshot shapes (plain, JSON-compatible — no imports from src/hades/**)
// ---------------------------------------------------------------------------

/** One row of the PLATFORMS section: a single connector's real-vs-offline probe result. */
export interface GatewayPaneProbeRow {
  /** Platform id, e.g. "telegram", "discord", "email". */
  platform: string;
  /** "real" when a live transport was constructed; "offline" when required credentials are missing. */
  mode: "real" | "offline";
  /** Human-readable explanation — which env vars satisfied ("real") or are missing ("offline"). */
  detail: string;
}

/** Live traffic counters for the PLATFORMS section. Printed verbatim — never derived. */
export interface GatewayPaneCounters {
  /** Total inbound messages received across all platforms so far. */
  inbound: number;
  /** Total outbound messages sent across all platforms so far. */
  outbound: number;
  /** Total inbound messages dropped by the rate limiter so far. */
  rateLimited: number;
}

/** One row of the TRAFFIC section: a single inbound or outbound message event. */
export interface GatewayPaneTrafficRow {
  /** "in" for an inbound message received, "out" for an outbound message sent/mirrored. */
  direction: "in" | "out";
  /** Platform id this event occurred on. */
  platform: string;
  /** Platform-scoped user/channel identifier the event is attributed to. */
  user: string;
  /** A short preview of the message text. Rendered through `sanitizePreview` — never raw. */
  preview: string;
  /** Epoch milliseconds the event was recorded at. Rendered verbatim, never reformatted/rounded. */
  at: number;
}

/**
 * The honest trust-badge tally for the BADGES section. `null` at the
 * `GatewayPaneState` level means "nothing assessed yet" and is rendered
 * distinctly from a real, counted `{ 0, 0, 0 }` tally.
 */
export interface GatewayPaneBadgeTally {
  verified: number;
  abstained: number;
  unverified: number;
}

/** The ENGINE section's single row: which reply engine the gateway actually resolved to. */
export interface GatewayPaneEngineRow {
  /** The engine identifier that was requested (e.g. via config/env). */
  requested: string;
  /** "real" for a live model-backed engine, "mock" for a deterministic stand-in. Always shown honestly. */
  mode: "real" | "mock";
  /** Human-readable detail (why this engine was selected, or why it fell back to mock). */
  detail: string;
}

/**
 * The pane's full pure view-state: the four data sections plus selection and
 * scroll cursors over the TRAFFIC feed, and the visible window height.
 * Immutable by convention — every helper below returns a fresh object.
 */
export interface GatewayPaneState {
  probes: GatewayPaneProbeRow[];
  counters: GatewayPaneCounters;
  engine: GatewayPaneEngineRow | null;
  traffic: GatewayPaneTrafficRow[];
  badges: GatewayPaneBadgeTally | null;
  /** Index into `traffic` of the selected row, clamped to `[0, traffic.length - 1]`. */
  selected: number;
  /** Rows scrolled down from the top of the TRAFFIC window (>= 0). */
  scroll: number;
  /** Visible row count of the TRAFFIC window. */
  height: number;
}

const DEFAULT_WIDTH = 72;
const DEFAULT_HEIGHT = 8;
const DEFAULT_TRAFFIC_CAP = 200;

/** A fresh, empty `GatewayPaneState` — nothing probed, no traffic, no engine, nothing assessed yet. */
export function gatewayPaneInit(height = DEFAULT_HEIGHT): GatewayPaneState {
  return {
    probes: [],
    counters: { inbound: 0, outbound: 0, rateLimited: 0 },
    engine: null,
    traffic: [],
    badges: null,
    selected: 0,
    scroll: 0,
    height: Math.max(1, Math.floor(height)),
  };
}

// ---------------------------------------------------------------------------
// Width-safe primitives (code-point counted, matching fleet-pane.ts's discipline)
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Pad or truncate (with a trailing "…") so the result is exactly `w` code points. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const cps = [...s];
  if (cps.length === w) return s;
  if (cps.length < w) return s + " ".repeat(w - cps.length);
  return cps.slice(0, w - 1).join("") + "…";
}

/** A boxed block: `╭─ TITLE ─…─╮` header, padded rows, `╰─…─╯` footer, `├─…─┤` dividers. */
function boxifyLines(title: string, sections: string[][], width: number): string[] {
  const inner = Math.max(0, width - 2);
  const label = title ? ` ${title} ` : "";
  const header = fit(`─${label}`, inner).replace(/ +$/g, (m) => "─".repeat(m.length));
  const out: string[] = [];
  out.push(`╭${header}╮`);
  sections.forEach((rows, i) => {
    if (i > 0) out.push(`├${"─".repeat(inner)}┤`);
    for (const r of rows) out.push(`│${fit(r, inner)}│`);
  });
  out.push(`╰${"─".repeat(inner)}╯`);
  return out;
}

// ---------------------------------------------------------------------------
// Preview/text sanitization — no ANSI injection, no stray control characters
// ---------------------------------------------------------------------------

/** C0 controls (excluding LF/CR, already collapsed to "⏎" by the time this runs), DEL, and C1 controls (which include ESC's cousins in the 0x80-0x9F band). ESC (0x1B) itself falls inside the C0 range below. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const NEWLINES = /\r\n|\r|\n/g;

/**
 * Sanitize arbitrary upstream text (a connector's user id, a message
 * preview, a probe/engine detail string, …) before it can ever reach a
 * rendered TUI frame:
 *  1. Collapse every newline variant (`\n`, `\r`, `\r\n`) to a single `⏎`,
 *     so a multi-line payload never breaks the box's one-row-per-line grid.
 *  2. Strip every remaining C0/C1 control character, including ESC — the
 *     byte that begins every ANSI escape sequence — so no upstream text can
 *     inject cursor moves, color codes, or terminal-clear sequences into the
 *     pane.
 *  3. Truncate by Unicode code point (never by UTF-16 code unit, so
 *     surrogate pairs are never split) to at most `max` code points, adding
 *     a trailing "…" when truncation actually occurred.
 *
 * Exported so callers (and tests) can sanitize preview text independently
 * of rendering a full pane.
 */
export function sanitizePreview(text: string, max: number): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  const collapsed = source.replace(NEWLINES, "⏎");
  const stripped = collapsed.replace(CONTROL_CHARS, "");
  const limit = Math.max(0, Math.floor(max));
  if (limit === 0) return "";
  const cps = [...stripped];
  if (cps.length <= limit) return stripped;
  if (limit === 1) return "…";
  return cps.slice(0, limit - 1).join("") + "…";
}

/** Internal shorthand: sanitize a free-text field for display with a generous default cap. */
function sane(text: string, max = 240): string {
  return sanitizePreview(text, max);
}

// ---------------------------------------------------------------------------
// Pure selection/scroll windowing over the TRAFFIC feed
// ---------------------------------------------------------------------------

/**
 * Given a list `length`, a visible `height`, and a desired `selected`
 * index + `scroll` offset, return the clamped pair that (a) keeps
 * `selected` inside `[0, length - 1]` and (b) keeps `scroll` positioned so
 * `selected` is visible inside the `height`-row window. An empty list pins
 * both to 0.
 */
function windowSelectionScroll(
  length: number,
  height: number,
  selected: number,
  scroll: number
): { selected: number; scroll: number } {
  if (length <= 0) return { selected: 0, scroll: 0 };
  const h = Math.max(1, Math.floor(height));
  const sel = clamp(Math.floor(selected), 0, length - 1);
  let sc = clamp(Math.floor(scroll), 0, Math.max(0, length - h));
  if (sel < sc) {
    sc = sel;
  } else if (sel >= sc + h) {
    sc = sel - h + 1;
  }
  sc = clamp(sc, 0, Math.max(0, length - h));
  return { selected: sel, scroll: sc };
}

/**
 * Apply a GATEWAY-pane key action against the TRAFFIC feed: `up`/`down`
 * move the selection by one row, `pageup`/`pagedown` move by a full visible
 * window (`state.height` rows), and `home`/`end` land exactly on the first
 * / last row with the scroll pinned to that edge (not merely "somewhere
 * that keeps it visible"). Selection and scroll are always clamped to valid
 * bounds; an empty feed pins both to 0 regardless of the key pressed.
 * Returns a fresh `GatewayPaneState`; the input is never mutated.
 */
export function gatewayPaneKey(
  state: GatewayPaneState,
  key: "up" | "down" | "pageup" | "pagedown" | "home" | "end"
): GatewayPaneState {
  const length = state.traffic.length;
  const height = Math.max(1, Math.floor(state.height));

  if (length === 0) {
    return { ...state, selected: 0, scroll: 0 };
  }

  if (key === "home") {
    return { ...state, selected: 0, scroll: 0 };
  }
  if (key === "end") {
    const scroll = Math.max(0, length - height);
    return { ...state, selected: length - 1, scroll };
  }

  let target = state.selected;
  if (key === "up") target -= 1;
  else if (key === "down") target += 1;
  else if (key === "pageup") target -= height;
  else if (key === "pagedown") target += height;

  const { selected, scroll } = windowSelectionScroll(length, height, target, state.scroll);
  return { ...state, selected, scroll };
}

// ---------------------------------------------------------------------------
// Snapshot application (pure, replaces whole sections — never mutates input)
// ---------------------------------------------------------------------------

/**
 * Apply a fresh status snapshot: replaces `probes` and `counters` wholesale
 * (they are full, authoritative snapshots — e.g. straight from
 * `GatewayProcess.status()` — not incremental deltas), and updates `engine`
 * only when the caller actually supplies the `engine` key (including
 * explicitly supplying `null`); omitting the key entirely leaves the
 * pane's current `engine` untouched. Returns a fresh `GatewayPaneState`;
 * neither `state` nor `snapshot` (nor its nested objects) is mutated.
 */
export function gatewayPaneApplyStatus(
  state: GatewayPaneState,
  snapshot: {
    probes: GatewayPaneProbeRow[];
    counters: GatewayPaneCounters;
    engine?: GatewayPaneEngineRow | null;
  }
): GatewayPaneState {
  const hasEngineKey = Object.prototype.hasOwnProperty.call(snapshot, "engine");
  return {
    ...state,
    probes: snapshot.probes.map((p) => ({ ...p })),
    counters: { ...snapshot.counters },
    engine: hasEngineKey ? (snapshot.engine ? { ...snapshot.engine } : null) : state.engine,
  };
}

/**
 * Append one traffic event to the feed. The feed is kept in chronological
 * order (oldest first, most recently appended last). When appending would
 * grow the feed past `cap` (default 200), the oldest rows are evicted from
 * the front until the feed is exactly `cap` long. Selection and scroll are
 * re-clamped so the selection stays on the same logical row where possible
 * (shifted left by however many rows were evicted) and stays visible inside
 * the `height`-row window. Returns a fresh `GatewayPaneState`; neither
 * `state` nor `row` is mutated.
 */
export function gatewayPaneAppendTraffic(
  state: GatewayPaneState,
  row: GatewayPaneTrafficRow,
  cap = DEFAULT_TRAFFIC_CAP
): GatewayPaneState {
  const capped = Math.max(1, Math.floor(cap));
  const combined = [...state.traffic, { ...row }];
  const evicted = Math.max(0, combined.length - capped);
  const traffic = evicted > 0 ? combined.slice(evicted) : combined;

  const { selected, scroll } = windowSelectionScroll(
    traffic.length,
    Math.max(1, Math.floor(state.height)),
    state.selected - evicted,
    state.scroll - evicted
  );

  return { ...state, traffic, selected, scroll };
}

/**
 * Record one honest badge assessment. `state.badges === null` means
 * "nothing assessed yet"; the first call transitions it to a real,
 * zero-based tally with the assessed badge incremented to 1 — this is a
 * genuinely counted value, never a fabricated placeholder. Subsequent calls
 * increment the matching counter on the existing tally. Returns a fresh
 * `GatewayPaneState`; the input is never mutated.
 */
export function gatewayPaneApplyBadge(
  state: GatewayPaneState,
  badge: "verified" | "abstained" | "unverified"
): GatewayPaneState {
  const current = state.badges ?? { verified: 0, abstained: 0, unverified: 0 };
  const badges: GatewayPaneBadgeTally = { ...current, [badge]: current[badge] + 1 };
  return { ...state, badges };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the GATEWAY pane: PLATFORMS / ENGINE / TRAFFIC / BADGES sections,
 * one line array entry per rendered line (no embedded newlines). Every
 * emitted line is exactly `width` Unicode code points wide (hard clamp): no
 * line this function returns ever exceeds `width`, and all free text
 * (platform ids, probe/engine detail strings, traffic user/preview text) is
 * passed through `sanitizePreview` before being laid into a row, so no
 * control character or ANSI escape byte from upstream data can ever survive
 * into the rendered frame.
 */
export function renderGatewayPane(state: GatewayPaneState, width = DEFAULT_WIDTH): string[] {
  const platformsRows: string[] = [`PLATFORMS (${state.probes.length})`];
  platformsRows.push(
    `  in=${state.counters.inbound}  out=${state.counters.outbound}  limited=${state.counters.rateLimited}`
  );
  if (state.probes.length === 0) {
    platformsRows.push("  no connectors probed yet");
  } else {
    for (const p of state.probes) {
      platformsRows.push(`  ${sane(p.platform, 40)}  ${p.mode}  ${sane(p.detail, 160)}`);
    }
  }

  const engineRows: string[] = ["ENGINE"];
  if (!state.engine) {
    engineRows.push("  engine: not attached");
  } else {
    const e = state.engine;
    engineRows.push(`  requested=${sane(e.requested, 60)}  mode=${e.mode}  ${sane(e.detail, 160)}`);
  }

  const trafficRows: string[] = [`TRAFFIC (${state.traffic.length})`];
  if (state.traffic.length === 0) {
    trafficRows.push("  no traffic yet");
  } else {
    const height = Math.max(1, Math.floor(state.height));
    const { selected, scroll } = windowSelectionScroll(state.traffic.length, height, state.selected, state.scroll);
    const visible = state.traffic.slice(scroll, scroll + height);
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i];
      const idx = scroll + i;
      const marker = idx === selected ? "▸" : " ";
      const dir = row.direction === "in" ? "IN " : "OUT";
      trafficRows.push(
        `${marker} ${dir} ${sane(row.platform, 40)} ${sane(row.user, 40)} ${sane(row.preview, 200)} @${row.at}`
      );
    }
    if (scroll > 0 || scroll + height < state.traffic.length) {
      trafficRows.push(
        `  (${scroll + 1}-${Math.min(state.traffic.length, scroll + height)} of ${state.traffic.length})`
      );
    }
  }

  const badgeRows: string[] = ["BADGES"];
  if (!state.badges) {
    badgeRows.push("  no assessed replies yet");
  } else {
    const b = state.badges;
    badgeRows.push(`  verified=${b.verified}  abstained=${b.abstained}  unverified=${b.unverified}`);
  }

  return boxifyLines("GATEWAY", [platformsRows, engineRows, trafficRows, badgeRows], width);
}
