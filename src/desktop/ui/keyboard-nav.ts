/**
 * Hades desktop — keyboard navigation engine.
 *
 * A real keymap engine (scopes, chord sequences, roving focus, platform-
 * correct modifiers) covering every view in the app, replacing the four-key
 * (mod+K / Escape / ArrowUp / ArrowDown / Enter) palette-only handler that
 * `renderer.ts` wires today.
 *
 * Pure and DOM-free by design, exactly like the other UI modules: every
 * export here is a plain function or class operating on plain objects
 * (`KeyEventLike`, `KeyContext`, `FocusRing`) — no `window`, no
 * `KeyboardEvent`, no `navigator` at module scope or anywhere else. That
 * makes the whole engine unit-testable with plain objects under vitest, with
 * no browser and no Tauri webview, and lets a caller (the renderer) supply
 * real DOM events, translated into `KeyEventLike`, and a real platform.
 *
 * Terminology:
 *  - A "chord" is a single keypress plus modifiers, e.g. `mod+k`.
 *  - A "sequence" is one or more chords pressed in order with a timeout
 *    between them, e.g. `g r` (press `g`, then `r` within the timeout).
 *  - `mod` always means "the platform's primary modifier": Cmd on mac,
 *    Ctrl elsewhere. It is never the same key as the platform's *other*
 *    modifier (Ctrl on mac, which must NOT satisfy a `mod` binding there).
 */

import type { NavKey } from "./shell";
import { NAV } from "./shell";
import type { Command } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type KeyScope = "global" | "nav" | "view" | "list" | "overlay" | "input";

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  targetTag?: string;
  targetEditable?: boolean;
}

/** `mod` = Cmd on mac, Ctrl elsewhere. */
export interface Chord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type Platform = "mac" | "other";

export type KeyAction =
  | { type: "nav"; to: NavKey }
  | { type: "command"; command: Command }
  | { type: "palette"; op: "open" | "close" }
  | { type: "help"; op: "open" | "close" | "toggle" }
  | { type: "focus"; op: "next" | "prev" | "first" | "last" | "activate" | "escape" }
  | { type: "view"; op: string; arg?: string };

export interface KeyBinding {
  id: string;
  scope: KeyScope;
  sequence: Chord[];
  action: KeyAction;
  label: string;
  group: string;
  when?: (ctx: KeyContext) => boolean;
}

export interface KeyContext {
  nav: NavKey;
  overlayOpen: boolean;
  paletteOpen: boolean;
  editing: boolean;
  running: boolean;
  listSize: number;
  listIndex: number;
  platform: Platform;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------

/** `KeyboardEvent.key` values that represent a bare modifier press. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
  "OS",
]);

const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: " ",
  spacebar: " ",
  " ": " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  tab: "Tab",
  delete: "Delete",
  del: "Delete",
  backspace: "Backspace",
};

/**
 * Normalizes a raw key token (from a chord spec or a `KeyEventLike.key`) to
 * a canonical form so spec parsing and live-event matching agree: known
 * named keys collapse to their canonical `KeyboardEvent.key` spelling
 * (`"esc"` / `"Escape"` -> `"Escape"`), single characters are lower-cased
 * (`"K"` -> `"k"`; case of a letter is carried by the `shift` flag, not by
 * the key itself), and anything else (e.g. `"F1"`) passes through unchanged.
 */
function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias !== undefined) return alias;
  if (raw.length === 1) return raw.toLowerCase();
  return raw;
}

// ---------------------------------------------------------------------------
// Chord / sequence parsing
// ---------------------------------------------------------------------------

const MOD_TOKENS = new Set(["mod"]);
const SHIFT_TOKENS = new Set(["shift"]);
const ALT_TOKENS = new Set(["alt", "option"]);

/**
 * Parses a single chord spec, e.g. `"mod+k"`, `"shift+/"`, `"g"`. Modifier
 * tokens (`mod`, `shift`, `alt`) may appear in any order before the key,
 * joined with `+`. A spec containing whitespace is a sequence, not a single
 * chord — use {@link parseSequence} for those (e.g. `"g r"`).
 */
export function parseChord(spec: string): Chord {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error("parseChord: empty chord spec");
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `parseChord: "${spec}" contains whitespace — it looks like a sequence; use parseSequence() instead`
    );
  }

  const tokens = trimmed.split("+");
  let key: string;
  let modTokens: string[];

  if (tokens[tokens.length - 1] === "" && tokens.length > 1) {
    // Trailing "+" means the key itself is the literal "+" character,
    // e.g. "mod++" -> mod held, key "+".
    key = "+";
    modTokens = tokens.slice(0, -2);
  } else {
    key = tokens[tokens.length - 1];
    modTokens = tokens.slice(0, -1);
  }

  if (key.length === 0) {
    throw new Error(`parseChord: no key found in "${spec}"`);
  }

  const chord: Chord = { key: normalizeKey(key) };
  for (const token of modTokens) {
    const lower = token.toLowerCase();
    if (MOD_TOKENS.has(lower)) chord.mod = true;
    else if (SHIFT_TOKENS.has(lower)) chord.shift = true;
    else if (ALT_TOKENS.has(lower)) chord.alt = true;
    else throw new Error(`parseChord: unknown modifier "${token}" in "${spec}"`);
  }
  return chord;
}

/**
 * Parses a whitespace-separated sequence of chord specs, e.g. `"g r"` is
 * the two-chord sequence `[{key:"g"}, {key:"r"}]` — press `g`, then `r`.
 */
export function parseSequence(spec: string): Chord[] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new Error("parseSequence: empty sequence spec");
  }
  return trimmed.split(/\s+/).map(parseChord);
}

// ---------------------------------------------------------------------------
// Chord <-> live-event matching
// ---------------------------------------------------------------------------

/**
 * Whether a live event's `shiftKey` should be carried into the chord.
 *
 * For a single printable character that is NOT an ASCII letter, Shift is
 * already baked into `KeyboardEvent.key` itself — pressing Shift+`/` reports
 * `key: "?"`, not `key: "/"`. Requiring the flag as WELL would mean a chord
 * spelled `"?"` could never match the very keystroke that produces it (the
 * bug that made the keyboard-help sheet unreachable). Letters are the
 * exception: {@link normalizeKey} lower-cases them, so `shift` is the only
 * thing left distinguishing `K` from `k` and must be kept. Named keys
 * (`Tab`, `Enter`, arrows) also keep it — `Shift+Tab` is genuinely distinct.
 */
function shiftIsMeaningful(key: string): boolean {
  if (key.length !== 1) return true;
  return key >= "a" && key <= "z";
}

function chordFromEvent(ev: KeyEventLike, platform: Platform): Chord {
  const key = normalizeKey(ev.key);
  const chord: Chord = { key };
  if (platform === "mac" ? ev.metaKey : ev.ctrlKey) chord.mod = true;
  if (ev.shiftKey && shiftIsMeaningful(key)) chord.shift = true;
  if (ev.altKey) chord.alt = true;
  return chord;
}

function chordEqual(a: Chord, b: Chord): boolean {
  return a.key === b.key && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/**
 * Whether a live keyboard event matches a chord on a given platform. `mod`
 * is resolved per-platform: on `mac` only `metaKey` (Cmd) counts, `ctrlKey`
 * alone never satisfies a `mod` binding there (and vice-versa on `other`).
 */
export function matchChord(ev: KeyEventLike, c: Chord, platform: Platform): boolean {
  if (MODIFIER_KEYS.has(ev.key)) return false;
  return chordEqual(chordFromEvent(ev, platform), c);
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

const DISPLAY_KEY: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Home: "Home",
  End: "End",
  Delete: "Del",
  Backspace: "⌫",
};

function displayKey(key: string): string {
  const named = DISPLAY_KEY[key];
  if (named !== undefined) return named;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Renders a chord for display: `"⌘K"` on mac, `"Ctrl+K"` elsewhere. */
export function formatChord(c: Chord, platform: Platform): string {
  if (platform === "mac") {
    return `${c.mod ? "⌘" : ""}${c.shift ? "⇧" : ""}${c.alt ? "⌥" : ""}${displayKey(c.key)}`;
  }
  const parts: string[] = [];
  if (c.mod) parts.push("Ctrl");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  parts.push(displayKey(c.key));
  return parts.join("+");
}

/** Renders a full chord sequence for display, e.g. `"G R"` or `"⌘K"`. */
export function formatSequence(seq: Chord[], platform: Platform): string {
  return seq.map((c) => formatChord(c, platform)).join(" ");
}

function sequenceKey(seq: Chord[]): string {
  return seq
    .map((c) => `${c.mod ? "mod+" : ""}${c.shift ? "shift+" : ""}${c.alt ? "alt+" : ""}${c.key}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class KeymapRegistry {
  private byScope = new Map<KeyScope, KeyBinding[]>();
  private seqIndex = new Map<string, KeyBinding>();
  private conflictLog: Array<{ a: KeyBinding; b: KeyBinding }> = [];

  constructor(bindings: KeyBinding[] = []) {
    for (const b of bindings) this.register(b);
  }

  /** Registers a binding. Throws {@link ConflictError} on a duplicate (scope, sequence) pair. */
  register(b: KeyBinding): void {
    if (b.sequence.length === 0) {
      throw new Error(`KeymapRegistry.register: binding "${b.id}" has an empty sequence`);
    }
    const indexKey = `${b.scope}\u0000${sequenceKey(b.sequence)}`;
    const existing = this.seqIndex.get(indexKey);
    if (existing) {
      this.conflictLog.push({ a: existing, b });
      throw new ConflictError(
        `KeymapRegistry: conflicting binding "${b.id}" collides with "${existing.id}" ` +
          `in scope "${b.scope}" on sequence "${formatSequenceDebug(b.sequence)}"`
      );
    }
    this.seqIndex.set(indexKey, b);
    const list = this.byScope.get(b.scope) ?? [];
    list.push(b);
    this.byScope.set(b.scope, list);
  }

  /** Removes a binding by id. Returns true if a binding was found and removed. */
  unregister(id: string): boolean {
    let removed = false;
    for (const [scope, list] of this.byScope) {
      const idx = list.findIndex((b) => b.id === id);
      if (idx >= 0) {
        const [b] = list.splice(idx, 1);
        this.seqIndex.delete(`${scope}\u0000${sequenceKey(b.sequence)}`);
        removed = true;
      }
    }
    return removed;
  }

  /** Returns all bindings, or only those in `scope` when given. */
  bindings(scope?: KeyScope): KeyBinding[] {
    if (scope) return [...(this.byScope.get(scope) ?? [])];
    const all: KeyBinding[] = [];
    for (const list of this.byScope.values()) all.push(...list);
    return all;
  }

  /**
   * Every (scope, sequence) collision that was ever attempted via
   * {@link register} and rejected. `register` never silently drops the
   * later binding — it throws immediately — but the rejected pair is kept
   * here so callers (and tests) can inspect what conflicted after catching
   * the thrown error, without needing to re-derive it themselves.
   */
  conflicts(): Array<{ a: KeyBinding; b: KeyBinding }> {
    return [...this.conflictLog];
  }
}

function formatSequenceDebug(seq: Chord[]): string {
  return seq
    .map((c) => `${c.mod ? "mod+" : ""}${c.shift ? "shift+" : ""}${c.alt ? "alt+" : ""}${c.key}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const EDITABLE_TAGS: ReadonlySet<string> = new Set(["input", "textarea"]);

function isEditableEvent(ev: KeyEventLike, ctx: KeyContext): boolean {
  if (ctx.editing) return true;
  if (ev.targetEditable) return true;
  if (ev.targetTag && EDITABLE_TAGS.has(ev.targetTag.toLowerCase())) return true;
  return false;
}

/** Motion ops are safe under key-repeat (holding `j` should keep moving). */
function isMotionAction(action: KeyAction): boolean {
  return (
    action.type === "focus" &&
    (action.op === "next" || action.op === "prev" || action.op === "first" || action.op === "last")
  );
}

function isPrefixOf(shorter: Chord[], longer: Chord[]): boolean {
  if (shorter.length >= longer.length) return false;
  return shorter.every((c, i) => chordEqual(c, longer[i]));
}

function sequencesEqual(a: Chord[], b: Chord[]): boolean {
  return a.length === b.length && a.every((c, i) => chordEqual(c, b[i]));
}

export interface DispatchResult {
  action: KeyAction | null;
  pending: Chord[];
  preventDefault: boolean;
}

export interface KeyDispatcherOptions {
  registry: KeymapRegistry;
  platform: Platform;
  sequenceTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_SEQUENCE_TIMEOUT_MS = 1500;

/**
 * Turns a stream of `KeyEventLike` + `KeyContext` pairs into `KeyAction`s,
 * owning the chord-sequence state machine (pending chords, timeout) and the
 * scope/precedence rules for which bindings are even eligible to fire.
 *
 * Scope precedence, most to least exclusive:
 *  1. `overlayOpen` — only `"overlay"` bindings are tried (the help sheet
 *     traps the keyboard; Escape closes it — handled specially, below).
 *  2. `paletteOpen` — only `"global"` bindings are tried (the palette owns
 *     everything else; its own list/query interaction is out of scope for
 *     this engine, same as today).
 *  3. Otherwise `"list"`, `"nav"`, `"view"` and `"global"` are all tried.
 *
 * `Escape` is handled outside the registry entirely, with a fixed unwind
 * order (`overlay -> palette -> pending sequence -> focus escape`), so it
 * reliably works everywhere — including inside a text field — regardless of
 * what is or isn't bound.
 */
export class KeyDispatcher {
  private readonly registry: KeymapRegistry;
  private readonly platform: Platform;
  private readonly sequenceTimeoutMs: number;
  private readonly now: () => number;
  private pendingChords: Chord[] = [];
  private lastChordAt: number | null = null;

  constructor(opts: KeyDispatcherOptions) {
    this.registry = opts.registry;
    this.platform = opts.platform;
    this.sequenceTimeoutMs = opts.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  pending(): Chord[] {
    return [...this.pendingChords];
  }

  reset(): void {
    this.pendingChords = [];
    this.lastChordAt = null;
  }

  private activeScopes(ctx: KeyContext): KeyScope[] {
    if (ctx.overlayOpen) return ["overlay"];
    if (ctx.paletteOpen) return ["global"];
    return ["list", "nav", "view", "global", "input"];
  }

  handle(ev: KeyEventLike, ctx: KeyContext): DispatchResult {
    // Bare modifier presses (Shift alone, etc.) never advance or break a
    // pending sequence and never produce an action.
    if (MODIFIER_KEYS.has(ev.key)) {
      return { action: null, pending: this.pending(), preventDefault: false };
    }

    // Escape has a fixed, registry-independent unwind order and always
    // works — even mid-sequence and even while a text field is focused.
    if (normalizeKey(ev.key) === "Escape") {
      this.reset();
      if (ctx.overlayOpen) {
        return { action: { type: "help", op: "close" }, pending: [], preventDefault: true };
      }
      if (ctx.paletteOpen) {
        return { action: { type: "palette", op: "close" }, pending: [], preventDefault: true };
      }
      return { action: { type: "focus", op: "escape" }, pending: [], preventDefault: true };
    }

    // A stale pending sequence (no continuation within the timeout) is
    // dropped before it can be extended by an unrelated keypress.
    if (this.pendingChords.length > 0 && this.lastChordAt !== null) {
      const elapsed = this.now() - this.lastChordAt;
      if (elapsed >= this.sequenceTimeoutMs) {
        this.reset();
      }
    }

    // Text-entry guard: while focus is in an input/textarea/contenteditable
    // (or the caller otherwise says we're "editing"), only modifier combos
    // (mod/ctrl/meta) are allowed through — a bare "g" must never navigate.
    const editable = isEditableEvent(ev, ctx);
    const hasCommandModifier = !!ev.metaKey || !!ev.ctrlKey;
    if (editable && !hasCommandModifier) {
      this.reset();
      return { action: null, pending: [], preventDefault: false };
    }

    const chord = chordFromEvent(ev, this.platform);
    const candidate = [...this.pendingChords, chord];

    const scopes = this.activeScopes(ctx);
    const candidates = this.registry.bindings().filter((b) => scopes.includes(b.scope));

    let fullMatch: KeyBinding | null = null;
    let hasPartial = false;
    for (const b of candidates) {
      if (b.when && !b.when(ctx)) continue;
      if (sequencesEqual(b.sequence, candidate)) {
        fullMatch = b;
        break;
      }
      if (isPrefixOf(candidate, b.sequence)) {
        hasPartial = true;
      }
    }

    if (fullMatch) {
      this.reset();
      if (ev.repeat && !isMotionAction(fullMatch.action)) {
        // Key-repeat is allowed for motion (holding `j`), but deliberately
        // ignored for anything else — most importantly destructive
        // commands — so an auto-repeating keydown can never fire a
        // one-shot or destructive action more than once.
        return { action: null, pending: [], preventDefault: true };
      }
      return { action: fullMatch.action, pending: [], preventDefault: true };
    }

    if (hasPartial) {
      this.pendingChords = candidate;
      this.lastChordAt = this.now();
      return { action: null, pending: this.pending(), preventDefault: true };
    }

    // Unknown continuation (or an unbound single key): reset cleanly and
    // let the webview do whatever it would normally do with this key.
    this.reset();
    return { action: null, pending: [], preventDefault: false };
  }
}

// ---------------------------------------------------------------------------
// Focus ring (roving tabindex list navigation)
// ---------------------------------------------------------------------------

export interface FocusRing {
  size: number;
  index: number;
}

const DEFAULT_PAGE = 5;

/**
 * Pure roving-focus reducer for lists. `wrap` (default true) controls
 * whether `next`/`prev`/`pageDown`/`pageUp` wrap around; `first`/`last`
 * always jump to the ends regardless of `wrap`. Degenerates safely at
 * `size === 0` (index clamped to 0) and `size === 1` (index always 0).
 */
export function moveFocus(
  ring: FocusRing,
  op: "next" | "prev" | "first" | "last" | "pageDown" | "pageUp",
  opts: { wrap?: boolean; page?: number } = {}
): FocusRing {
  const size = ring.size;
  if (size <= 0) return { size, index: 0 };

  const wrap = opts.wrap ?? true;
  const page = opts.page ?? DEFAULT_PAGE;

  const wrapIndex = (i: number) => ((i % size) + size) % size;
  const clampIndex = (i: number) => Math.min(Math.max(i, 0), size - 1);
  const move = (delta: number) => (wrap ? wrapIndex(ring.index + delta) : clampIndex(ring.index + delta));

  let index: number;
  switch (op) {
    case "next":
      index = move(1);
      break;
    case "prev":
      index = move(-1);
      break;
    case "first":
      index = 0;
      break;
    case "last":
      index = size - 1;
      break;
    case "pageDown":
      index = move(page);
      break;
    case "pageUp":
      index = move(-page);
      break;
    default:
      index = clampIndex(ring.index);
  }
  return { size, index };
}

/**
 * Type-ahead: finds the next item (starting just after `from`, wrapping
 * fully around and including `from` itself last) whose text starts with
 * `buffer`, case-insensitively. Returns -1 when nothing matches.
 */
export function typeAhead(items: string[], buffer: string, from: number): number {
  const n = items.length;
  if (n === 0 || buffer.length === 0) return -1;
  const needle = buffer.toLowerCase();
  for (let step = 1; step <= n; step++) {
    const idx = (((from + step) % n) + n) % n;
    if (items[idx].toLowerCase().startsWith(needle)) return idx;
  }
  return -1;
}

/** Roving-tabindex markup for a list row: only the focused row is tabbable. */
export function focusAttrs(index: number, active: number): string {
  const isActive = index === active;
  return `tabindex="${isActive ? 0 : -1}" aria-selected="${isActive ? "true" : "false"}" data-focused="${isActive ? "true" : "false"}"`;
}

// ---------------------------------------------------------------------------
// Default bindings
// ---------------------------------------------------------------------------

/**
 * Assigns each `NavKey` a unique single-letter mnemonic for the `g <letter>`
 * "go to" sequence, derived automatically from `NAV` so a newly added view
 * is covered without anyone having to remember to hand-edit a table here.
 * `"g"` itself is never assigned (it is reserved for `g g` / list "go to
 * top" at list scope); collisions fall back to a later character of the
 * same key, then to the first free letter of the alphabet.
 */
function assignGotoLetters(keys: readonly NavKey[]): Map<NavKey, string> {
  const used = new Set<string>(["g"]);
  const map = new Map<NavKey, string>();
  for (const key of keys) {
    const lower = key.toLowerCase();
    let letter = "";
    for (const ch of lower) {
      if (/[a-z]/.test(ch) && !used.has(ch)) {
        letter = ch;
        break;
      }
    }
    if (!letter) {
      for (let code = 97; code <= 122; code++) {
        const cand = String.fromCharCode(code);
        if (!used.has(cand)) {
          letter = cand;
          break;
        }
      }
    }
    if (!letter) {
      throw new Error(`assignGotoLetters: exhausted the alphabet assigning a letter to "${key}"`);
    }
    used.add(letter);
    map.set(key, letter);
  }
  return map;
}

/** Command kinds that mutate/tear down running state — never bound bare. */
const DESTRUCTIVE_COMMAND_KINDS: ReadonlySet<string> = new Set([
  "runtime.stop",
  "worker.kill",
  "fleet.terminate",
  "fleet.hibernate",
]);

export function isDestructiveCommandKind(kind: string): boolean {
  return DESTRUCTIVE_COMMAND_KINDS.has(kind);
}

/**
 * The engine's built-in bindings, covering every surface of the app:
 *  - Every `NavKey` in `NAV` is reachable two ways — a mnemonic `g <letter>`
 *    sequence and a positional `mod+<1..8>` chord (NAV's current order).
 *  - Global: command palette, keyboard-help toggle, runtime start/stop
 *    (stop requires a modifier, never a bare letter — it's destructive).
 *  - List: vim-style `j/k/g g/G/Home/End/PageUp/PageDown` motion plus
 *    `Enter`/`Space` to activate the focused row.
 *  - Escape is intentionally NOT registered here: it is handled directly by
 *    `KeyDispatcher.handle` with a fixed unwind order so it always works.
 */
export function defaultBindings(): KeyBinding[] {
  const bindings: KeyBinding[] = [];
  const letters = assignGotoLetters(NAV.map((n) => n.key));

  NAV.forEach((item, index) => {
    const letter = letters.get(item.key);
    if (!letter) throw new Error(`defaultBindings: no goto letter assigned for "${item.key}"`);

    bindings.push({
      id: `nav.goto.${item.key}`,
      scope: "nav",
      sequence: parseSequence(`g ${letter}`),
      action: { type: "nav", to: item.key },
      label: `Go to ${item.label}`,
      group: "Navigation",
    });

    if (index < 9) {
      bindings.push({
        id: `nav.goto.${item.key}.mod`,
        scope: "nav",
        sequence: [parseChord(`mod+${index + 1}`)],
        action: { type: "nav", to: item.key },
        label: `Go to ${item.label} (${index + 1})`,
        group: "Navigation",
      });
    }
  });

  bindings.push(
    {
      id: "global.palette.open",
      scope: "global",
      sequence: [parseChord("mod+k")],
      action: { type: "palette", op: "open" },
      label: "Open command palette",
      group: "Global",
    },
    {
      id: "global.help.toggle",
      scope: "global",
      // The literal character a real keyboard reports for Shift+`/` — NOT
      // `"shift+/"`, which no live event ever produces (see
      // `shiftIsMeaningful`).
      sequence: [parseChord("?")],
      action: { type: "help", op: "toggle" },
      label: "Show keyboard shortcuts",
      group: "Global",
    },
    {
      id: "global.escape",
      scope: "global",
      sequence: [parseChord("escape")],
      action: { type: "focus", op: "escape" },
      label: "Close overlay / palette / cancel",
      group: "Global",
    },
    {
      id: "global.runtime.start",
      scope: "global",
      sequence: [parseChord("mod+enter")],
      action: { type: "command", command: { kind: "runtime.start", mode: "inline", poolSize: 3 } },
      label: "Start runtime",
      group: "Global",
      when: (ctx) => !ctx.running,
    },
    {
      id: "global.runtime.stop",
      scope: "global",
      // Destructive (tears down live workers): requires mod+shift, never a
      // bare letter, per the "never a bare letter" rule for destructive ops.
      sequence: [parseChord("mod+shift+q")],
      action: { type: "command", command: { kind: "runtime.stop" } },
      label: "Stop runtime",
      group: "Global",
      when: (ctx) => ctx.running,
    }
  );

  // Every list binding is gated on there actually BEING a list in the current
  // context. Without this, bare `j`/`k`/`Enter`/`Space` are swallowed
  // app-wide on views that have no focus ring (returning a `focus` action
  // nothing can perform), and the help sheet advertises motion the user
  // cannot use. `listSize > 0` is the honest predicate.
  const hasList = (ctx: KeyContext): boolean => ctx.listSize > 0;

  bindings.push(
    {
      id: "list.next",
      scope: "list",
      sequence: [parseChord("j")],
      action: { type: "focus", op: "next" },
      label: "Next item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.next.arrow",
      scope: "list",
      sequence: [parseChord("down")],
      action: { type: "focus", op: "next" },
      label: "Next item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.prev",
      scope: "list",
      sequence: [parseChord("k")],
      action: { type: "focus", op: "prev" },
      label: "Previous item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.prev.arrow",
      scope: "list",
      sequence: [parseChord("up")],
      action: { type: "focus", op: "prev" },
      label: "Previous item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.first",
      scope: "list",
      sequence: parseSequence("g g"),
      action: { type: "focus", op: "first" },
      label: "Go to first item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.first.home",
      scope: "list",
      sequence: [parseChord("home")],
      action: { type: "focus", op: "first" },
      label: "Go to first item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.last",
      scope: "list",
      sequence: [parseChord("shift+g")],
      action: { type: "focus", op: "last" },
      label: "Go to last item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.last.end",
      scope: "list",
      sequence: [parseChord("end")],
      action: { type: "focus", op: "last" },
      label: "Go to last item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.pagedown",
      scope: "list",
      // PageDown/PageUp signal a coarse forward/back move at the KeyAction
      // level (the union has no dedicated page op); a host that wants the
      // actual page-sized jump calls `moveFocus(ring, "pageDown", {page})`
      // directly from its own PageDown handling, using the same FocusRing
      // it drives `next`/`prev` with. `moveFocus` fully implements both.
      sequence: [parseChord("pagedown")],
      action: { type: "focus", op: "next" },
      label: "Page down",
      group: "List",
      when: hasList,
    },
    {
      id: "list.pageup",
      scope: "list",
      sequence: [parseChord("pageup")],
      action: { type: "focus", op: "prev" },
      label: "Page up",
      group: "List",
      when: hasList,
    },
    {
      id: "list.activate.enter",
      scope: "list",
      sequence: [parseChord("enter")],
      action: { type: "focus", op: "activate" },
      label: "Activate selected item",
      group: "List",
      when: hasList,
    },
    {
      id: "list.activate.space",
      scope: "list",
      sequence: [parseChord("space")],
      action: { type: "focus", op: "activate" },
      label: "Activate selected item",
      group: "List",
      when: hasList,
    }
  );

  bindings.push(
    {
      id: "view.refresh",
      scope: "view",
      sequence: [parseChord("r")],
      action: { type: "view", op: "refresh" },
      label: "Refresh current view",
      group: "View",
    },
    {
      id: "view.compose",
      scope: "view",
      sequence: [parseChord("n")],
      action: { type: "view", op: "compose" },
      label: "New / compose",
      group: "View",
    }
  );

  return bindings;
}
