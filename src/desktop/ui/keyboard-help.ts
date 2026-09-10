/**
 * Hades desktop — keyboard shortcuts overlay ("cheat sheet").
 *
 * A pure HTML-string overlay, in the same style as `command-palette.ts`:
 * `renderKeyboardHelp(registry, ctx) -> string` is a plain function of its
 * inputs (no DOM, no globals), rendered into the Tauri webview by the
 * renderer exactly like every other UI module here. It exists to make the
 * keymap *discoverable* — every binding a user could reach for is listed,
 * grouped, and shown with the platform-correct chord glyphs.
 */

import { esc, escAttr } from "./shell";
import type { KeyBinding, KeyContext, KeymapRegistry } from "./keyboard-nav";
import { formatSequence } from "./keyboard-nav";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Turns a free-text group name into a safe HTML id fragment. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "group";
}

function groupBindings(bindings: KeyBinding[]): Map<string, KeyBinding[]> {
  const groups = new Map<string, KeyBinding[]>();
  for (const b of bindings) {
    const list = groups.get(b.group) ?? [];
    list.push(b);
    groups.set(b.group, list);
  }
  return groups;
}

/** The `id` a given rendered row will carry, stable for a given (binding index) pairing. */
export function helpItemId(index: number): string {
  return `keyboard-help-item-${index}`;
}

/**
 * Renders the keyboard-shortcuts overlay for the bindings currently eligible
 * under `ctx` (i.e. whose `when`, if any, passes). Returns an empty string
 * when the overlay isn't open, so the shell can mount it unconditionally —
 * same convention as `renderPalette`. Bindings are grouped by `group` (groups
 * sorted alphabetically for a stable, deterministic layout), each row shows
 * the platform-correct chord via `formatSequence`, and every row carries
 * `data-focusable="true"` plus a stable id so `helpFocusTrap` can drive
 * keyboard focus through them.
 */
export function renderKeyboardHelp(registry: KeymapRegistry, ctx: KeyContext): string {
  if (!ctx.overlayOpen) return "";

  const eligible = registry.bindings().filter((b) => !b.when || b.when(ctx));
  const groups = groupBindings(eligible);
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  let index = 0;
  const sections =
    groupNames.length === 0
      ? `<p class="keyboard-help__empty">No shortcuts available.</p>`
      : groupNames
          .map((name) => {
            const rows = groups
              .get(name)!
              .map((b) => {
                const id = helpItemId(index);
                index += 1;
                const chordText = formatSequence(b.sequence, ctx.platform);
                return `<li class="keyboard-help__row" id="${escAttr(id)}" data-focusable="true" tabindex="-1">
        <span class="keyboard-help__label">${esc(b.label)}</span>
        <kbd class="keyboard-help__chord">${esc(chordText)}</kbd>
      </li>`;
              })
              .join("");
            const groupId = `keyboard-help-group-${slugify(name)}`;
            return `<section class="keyboard-help__group" aria-labelledby="${escAttr(groupId)}">
      <h3 class="keyboard-help__group-title" id="${escAttr(groupId)}">${esc(name)}</h3>
      <ul class="keyboard-help__list" role="list">${rows}</ul>
    </section>`;
          })
          .join("");

  return `<div class="keyboard-help" data-help-open="true" role="dialog" aria-modal="true" aria-labelledby="keyboard-help-title">
    <div class="keyboard-help__overlay" data-help="close"></div>
    <div class="keyboard-help__panel">
      <header class="keyboard-help__header">
        <h2 id="keyboard-help-title" class="keyboard-help__title">Keyboard shortcuts</h2>
        <button type="button" class="keyboard-help__close" data-help="close" aria-label="Close keyboard shortcuts">&times;</button>
      </header>
      <div class="keyboard-help__body">${sections}</div>
      <footer class="keyboard-help__footer">
        <span class="keyboard-help__kbd">Esc to close</span>
      </footer>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Focus trap
// ---------------------------------------------------------------------------

/**
 * Wraps keyboard focus through the overlay's `data-focusable` item ids.
 * `index` is the currently-focused position (or `-1` for "nothing focused
 * yet", which `"next"` resolves to the first item and `"prev"` to the
 * last). Returns `-1` when `ids` is empty — there is nothing to focus.
 */
export function helpFocusTrap(ids: string[], index: number, op: "next" | "prev"): number {
  const n = ids.length;
  if (n === 0) return -1;
  if (index < 0) return op === "next" ? 0 : n - 1;
  if (op === "next") return (index + 1) % n;
  return (index - 1 + n) % n;
}
