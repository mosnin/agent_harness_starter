/**
 * Hades desktop - Command Palette.
 *
 * A keyboard-first command launcher (Cmd-K / Ctrl-K class) for the native
 * desktop app. Every entry maps to a real, typed wire `Command` from the IPC
 * contract - the palette never invents commands the sidecar cannot handle.
 *
 * Framework-light and DOM-free by design, exactly like the other UI modules:
 * the logic is a small pure reducer plus pure `render(state) -> HTML string`
 * functions, so it is fully unit-testable without a browser, a bundler, or the
 * Tauri webview. The native shell owns focus, key events, and dispatching the
 * returned `Command` to the sidecar; this module owns none of that.
 */

import type { Command } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Escaping (local copy so this module has no cross-UI imports)
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for safe interpolation into HTML content or attributes. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// ---------------------------------------------------------------------------
// Entry model
// ---------------------------------------------------------------------------

/**
 * Describes a value an entry needs before it can produce a Command. When an
 * entry carries an `input` spec, selecting it opens the palette's input
 * sub-state instead of executing immediately.
 */
export interface PaletteInputSpec {
  /** Label shown above the input field. */
  label: string;
  /** Placeholder text for the field. */
  placeholder: string;
  /** How the raw string is interpreted when building the Command. */
  kind: "text" | "number";
}

/**
 * A single palette entry. `toCommand` is the honesty boundary: it returns a
 * real `Command` from the contract, or `null` when the supplied argument is
 * missing/invalid (e.g. an empty objective, a non-numeric pool size).
 */
export interface PaletteEntry {
  id: string;
  title: string;
  /** One-line description shown under the title. */
  hint: string;
  /** Extra search terms so an entry is findable by synonyms, not just title. */
  keywords: string[];
  /** Present when the entry needs a value before it can run. */
  input?: PaletteInputSpec;
  /** Builds the wire Command, or null if the argument is missing/invalid. */
  toCommand(arg?: string): Command | null;
}

/** Context used to build entries whose Command depends on live app state. */
export interface PaletteContext {
  /** Current pool size, so "scale up/down" can target current +/- 1. */
  poolSize: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function parsePoolSize(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/**
 * Builds the palette registry. Entries that need live state (pool scale up /
 * down) read it from `ctx`; the rest are constant. Ordering here is the
 * deterministic tie-break order used by {@link filterEntries}.
 */
export function createPaletteEntries(ctx: PaletteContext = { poolSize: 0 }): PaletteEntry[] {
  const poolSize = Number.isFinite(ctx.poolSize) ? Math.max(0, Math.floor(ctx.poolSize)) : 0;
  return [
    {
      id: "runtime.start",
      title: "Start runtime",
      hint: "Boot the swarm runtime with an inline pool",
      keywords: ["run", "boot", "launch", "start", "up"],
      toCommand: () => ({ kind: "runtime.start", mode: "inline", poolSize: 3 }),
    },
    {
      id: "runtime.stop",
      title: "Stop runtime",
      hint: "Shut the swarm runtime down",
      keywords: ["halt", "kill", "shutdown", "stop", "down"],
      toCommand: () => ({ kind: "runtime.stop" }),
    },
    {
      id: "goal.dispatch",
      title: "Dispatch goal...",
      hint: "Send a new objective to the swarm",
      keywords: ["goal", "objective", "task", "dispatch", "send", "new"],
      input: {
        label: "Objective",
        placeholder: "Describe the goal to dispatch...",
        kind: "text",
      },
      toCommand: (arg) => {
        const objective = (arg ?? "").trim();
        if (objective.length === 0) return null;
        return { kind: "goal.dispatch", objective };
      },
    },
    {
      id: "pool.scale.up",
      title: "Scale pool up",
      hint: "Add one worker to the pool",
      keywords: ["pool", "scale", "worker", "add", "more", "up", "grow"],
      toCommand: () => ({ kind: "pool.scale", size: poolSize + 1 }),
    },
    {
      id: "pool.scale.down",
      title: "Scale pool down",
      hint: "Remove one worker from the pool",
      keywords: ["pool", "scale", "worker", "remove", "fewer", "down", "shrink"],
      toCommand: () => ({ kind: "pool.scale", size: Math.max(0, poolSize - 1) }),
    },
    {
      id: "pool.scale.set",
      title: "Set pool size...",
      hint: "Scale the pool to an exact number of workers",
      keywords: ["pool", "scale", "worker", "size", "set", "resize"],
      input: {
        label: "Pool size",
        placeholder: "Number of workers",
        kind: "number",
      },
      toCommand: (arg) => {
        const size = parsePoolSize(arg);
        if (size === null) return null;
        return { kind: "pool.scale", size };
      },
    },
    {
      id: "skills.list",
      title: "List skills",
      hint: "Refresh the SKILL.md library",
      keywords: ["skill", "list", "library", "refresh", "reload"],
      toCommand: () => ({ kind: "skills.list" }),
    },
    // Migration is discoverable from here, but only its READ-ONLY halves: a
    // scan and a preview write nothing. The actual import stays behind the
    // Settings card's explicit Import button, which is the only place a
    // `confirm: true` apply is ever produced.
    {
      id: "migrate.scan",
      title: "Scan for Hermes / OpenClaw installs",
      hint: "Look for an existing install to import (writes nothing)",
      keywords: ["migrate", "import", "hermes", "openclaw", "scan", "move", "switch"],
      toCommand: () => ({ kind: "migrate.scan" }),
    },
    {
      id: "migrate.plan",
      title: "Preview migration plan",
      hint: "Build the deterministic import plan (a dry run — writes nothing)",
      keywords: ["migrate", "import", "plan", "preview", "dry", "hermes", "openclaw"],
      toCommand: () => ({ kind: "migrate.plan" }),
    },
  ];
}

/** Default registry, used when no live context is supplied. */
export const DEFAULT_ENTRIES: PaletteEntry[] = createPaletteEntries();

// ---------------------------------------------------------------------------
// Filtering / ranking
// ---------------------------------------------------------------------------

/** True when every char of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Ranks a single entry against a normalized (lowercase, trimmed) query.
 * Lower is better; `null` means "no match". Buckets:
 *   0 exact title, 1 title prefix, 2 title substring,
 *   3 keyword substring, 4 fuzzy subsequence on title.
 */
function scoreEntry(entry: PaletteEntry, query: string): number | null {
  const title = entry.title.toLowerCase();
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (entry.keywords.some((k) => k.toLowerCase().includes(query))) return 3;
  if (isSubsequence(query, title)) return 4;
  return null;
}

/**
 * Filters and ranks entries for a query. An empty/whitespace query returns
 * the full registry in its natural order. Otherwise entries are ranked by
 * match quality, ties broken by registry order (stable) so results are fully
 * deterministic.
 */
export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...entries];

  const scored: Array<{ entry: PaletteEntry; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const score = scoreEntry(entry, q);
    if (score !== null) scored.push({ entry, score, index });
  });

  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.index - b.index));
  return scored.map((s) => s.entry);
}

// ---------------------------------------------------------------------------
// State + reducer
// ---------------------------------------------------------------------------

/** The palette's input sub-state: which entry is being filled, and with what. */
export interface PaletteInputState {
  entryId: string;
  value: string;
}

export interface PaletteState {
  open: boolean;
  query: string;
  selectedIndex: number;
  /** Non-null while collecting a value for an input-bearing entry. */
  input: PaletteInputState | null;
}

export type PaletteAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "setQuery"; query: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "setInput"; value: string }
  | { type: "cancelInput" }
  | { type: "execute" };

/** Result of {@link paletteReduce}: the next state and any emitted Command. */
export interface PaletteResult {
  state: PaletteState;
  command?: Command;
}

/** A fresh, closed palette state. */
export function initialPaletteState(): PaletteState {
  return { open: false, query: "", selectedIndex: 0, input: null };
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

/**
 * Pure reducer for palette interaction. `entries` is passed in (rather than
 * closed over) so the reducer stays a pure function of its inputs and tests
 * can supply their own registry. Only `execute` can emit a `command`.
 */
export function paletteReduce(
  state: PaletteState,
  action: PaletteAction,
  entries: PaletteEntry[] = DEFAULT_ENTRIES
): PaletteResult {
  switch (action.type) {
    case "open":
      return { state: { open: true, query: "", selectedIndex: 0, input: null } };

    case "close":
      return { state: initialPaletteState() };

    case "setQuery":
      // Typing in the search box resets the selection and exits any input mode.
      return { state: { ...state, query: action.query, selectedIndex: 0, input: null } };

    case "next": {
      if (state.input) return { state };
      const count = filterEntries(entries, state.query).length;
      return { state: { ...state, selectedIndex: wrapIndex(state.selectedIndex + 1, count) } };
    }

    case "prev": {
      if (state.input) return { state };
      const count = filterEntries(entries, state.query).length;
      return { state: { ...state, selectedIndex: wrapIndex(state.selectedIndex - 1, count) } };
    }

    case "setInput": {
      if (!state.input) return { state };
      return { state: { ...state, input: { ...state.input, value: action.value } } };
    }

    case "cancelInput": {
      if (!state.input) return { state };
      return { state: { ...state, input: null } };
    }

    case "execute": {
      // Second step: an input entry is being filled - build and emit if valid.
      if (state.input) {
        const entry = entries.find((e) => e.id === state.input!.entryId);
        const command = entry?.toCommand(state.input.value) ?? null;
        if (!command) return { state }; // invalid input: stay open, keep typing
        return { state: initialPaletteState(), command };
      }

      // First step: run the selected entry, or open its input sub-state.
      const filtered = filterEntries(entries, state.query);
      const entry = filtered[state.selectedIndex];
      if (!entry) return { state };

      if (entry.input) {
        return { state: { ...state, input: { entryId: entry.id, value: "" } } };
      }

      const command = entry.toCommand() ?? undefined;
      if (!command) return { state };
      return { state: initialPaletteState(), command };
    }

    default:
      return { state };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SEARCH_ICON = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.5 13.5L17 17"/></svg>`;

function renderInputView(entry: PaletteEntry, input: PaletteInputState): string {
  const spec = entry.input!;
  return `<div class="command-palette__panel" data-mode="input">
    <div class="command-palette__breadcrumb">
      <button type="button" class="command-palette__back" data-palette="cancelInput" aria-label="Back to commands">&lsaquo;</button>
      <span class="command-palette__breadcrumb-title">${escapeHtml(entry.title)}</span>
    </div>
    <label class="command-palette__input-label" for="command-palette-input">${escapeHtml(spec.label)}</label>
    <input
      type="${spec.kind === "number" ? "number" : "text"}"
      id="command-palette-input"
      class="command-palette__input"
      data-palette-field="input"
      placeholder="${escapeHtml(spec.placeholder)}"
      value="${escapeHtml(input.value)}"
      autofocus
    />
    <div class="command-palette__footer">
      <span class="command-palette__kbd">Enter to run</span>
      <span class="command-palette__kbd">Esc to go back</span>
    </div>
  </div>`;
}

function renderListView(state: PaletteState, entries: PaletteEntry[]): string {
  const filtered = filterEntries(entries, state.query);

  const rows =
    filtered.length === 0
      ? `<li class="command-palette__empty">No matching commands</li>`
      : filtered
          .map((entry, index) => {
            const selected = index === state.selectedIndex;
            const arrow = entry.input
              ? `<span class="command-palette__row-arrow" aria-hidden="true">&rsaquo;</span>`
              : "";
            return `<li
      class="command-palette__row${selected ? " command-palette__row--selected" : ""}"
      data-palette-index="${index}"
      data-entry-id="${escapeHtml(entry.id)}"
      aria-selected="${selected ? "true" : "false"}"
    >
      <span class="command-palette__row-title">${escapeHtml(entry.title)}</span>
      <span class="command-palette__row-hint">${escapeHtml(entry.hint)}</span>
      ${arrow}
    </li>`;
          })
          .join("");

  return `<div class="command-palette__panel" data-mode="list">
    <div class="command-palette__search">
      <span class="command-palette__search-icon" aria-hidden="true">${SEARCH_ICON}</span>
      <input
        type="text"
        id="command-palette-query"
        class="command-palette__query"
        data-palette-field="query"
        placeholder="Type a command..."
        value="${escapeHtml(state.query)}"
        autofocus
      />
    </div>
    <ul class="command-palette__list" role="listbox">${rows}</ul>
    <div class="command-palette__footer">
      <span class="command-palette__kbd">Up / Down to navigate</span>
      <span class="command-palette__kbd">Enter to run</span>
      <span class="command-palette__kbd">Esc to close</span>
    </div>
  </div>`;
}

/**
 * Renders the palette to an HTML string using the shared theme classes. Returns
 * an empty string when closed so the shell can mount it unconditionally. When
 * an input entry is active the input sub-view is shown; otherwise the searchable
 * command list is shown, with `selectedIndex` reflected on the highlighted row.
 */
export function renderPalette(state: PaletteState, entries: PaletteEntry[] = DEFAULT_ENTRIES): string {
  if (!state.open) return "";

  let inner: string;
  if (state.input) {
    const entry = entries.find((e) => e.id === state.input!.entryId);
    inner = entry ? renderInputView(entry, state.input) : renderListView(state, entries);
  } else {
    inner = renderListView(state, entries);
  }

  return `<div class="command-palette" data-palette-open="true" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="command-palette__overlay" data-palette="close"></div>
    ${inner}
  </div>`;
}
