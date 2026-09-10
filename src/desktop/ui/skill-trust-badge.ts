/**
 * skill-trust-badge — a theme-aware, framework-free DOM badge rendering one
 * skill's {@link SkillTrustBadgeData} (from `../core/skill-trust-service.ts`)
 * for the Skills view.
 *
 * Same house pattern as `fleet-conflicts-view.ts`: real
 * `document.createElement` nodes (an injectable `doc` here, since this is a
 * leaf component with no `mount`/`update`/`destroy` lifecycle of its own —
 * callers place the single returned element wherever they like, e.g. a
 * table cell), every dynamic value written through `textContent` or
 * `setAttribute` (never `innerHTML`), so a hostile skill name (control
 * characters, `<script>` markup) can never do anything but sit there as
 * inert text.
 *
 * No metric is computed here — every number in {@link SkillTrustBadgeData}
 * is already real (copied verbatim from the track-record store or the
 * persisted trust state by `skill-trust-service.ts`); this module only
 * formats it.
 */

import type { SkillTrustBadgeData, SkillTrustBadgeStatus } from "../core/skill-trust-service";

export type { SkillTrustBadgeData, SkillTrustBadgeStatus } from "../core/skill-trust-service";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const STATUS_WORDS: Record<SkillTrustBadgeStatus, string> = {
  active: "active",
  probation: "probation",
  demoted: "demoted",
  unscored: "unscored",
  "integrity-error": "integrity error",
};

/** Fixed 4-decimal metric text, or the literal `"no track record"` for `null` — never a dash or `"NaN"`. */
function metricText(value: number | null): string {
  if (value === null) return "no track record";
  return value.toFixed(4);
}

/**
 * Pure text label for a trust badge, fixed 4-decimal metrics, e.g.
 * `"active · wilson 0.8123 · brier 0.0912 · n=14"`. `null` metrics render as
 * words (`"no track record"`), never dash-numbers.
 */
export function trustBadgeLabel(data: SkillTrustBadgeData): string {
  return `${data.status} · ${trustBadgeMetricsText(data)}`;
}

/** Human word(s) for a status (`"integrity-error"` -> `"integrity error"`). */
export function trustBadgeStatusWord(status: SkillTrustBadgeStatus): string {
  return STATUS_WORDS[status];
}

/** The metrics half of {@link trustBadgeLabel}, e.g. `"wilson 0.8123 · brier 0.0912 · n=14"`. */
export function trustBadgeMetricsText(data: SkillTrustBadgeData): string {
  return `wilson ${metricText(data.wilsonLower)} · brier ${metricText(data.recentBrier)} · n=${data.n}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders one skill's trust badge as a single, inline-able `HTMLElement`
 * (a `<span>`) suitable for dropping straight into a table cell — it makes
 * no assumptions about `skills-view.ts` internals and mounts nothing of its
 * own; the caller owns placement.
 *
 * `doc` defaults to the global `document` and exists purely so tests can
 * inject a fake DOM without stubbing globals (this repo runs vitest under
 * `environment: "node"`, with no jsdom/happy-dom dependency by house rule).
 */
export function renderSkillTrustBadge(data: SkillTrustBadgeData, doc: Document = document): HTMLElement {
  const label = trustBadgeLabel(data);

  const root = doc.createElement("span");
  root.classList.add("skill-trust-badge", `skill-trust-badge--${data.status}`);
  root.setAttribute("data-skill-trust-status", data.status);
  // `setAttribute`/`textContent` never parse their argument as markup, so a
  // hostile `name` (e.g. containing "<script>" or control characters) can
  // only ever end up here as literal, inert text/attribute data.
  root.setAttribute("data-skill-name", data.name);
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", `${data.name}: ${label}`);
  root.setAttribute("title", label);

  const dot = doc.createElement("span");
  dot.className = "skill-trust-badge__dot";
  root.append(dot);

  const statusEl = doc.createElement("span");
  statusEl.className = "skill-trust-badge__status";
  statusEl.textContent = STATUS_WORDS[data.status];
  root.append(statusEl);

  const metricsEl = doc.createElement("span");
  metricsEl.className = "skill-trust-badge__metrics";
  metricsEl.textContent = trustBadgeMetricsText(data);
  root.append(metricsEl);

  // A visually-hidden node carrying the raw skill name via `textContent`
  // only — never concatenated into markup — so assistive tech (and tests)
  // can read it back verbatim, hostile characters included, with no risk of
  // it ever being interpreted as HTML.
  const nameEl = doc.createElement("span");
  nameEl.className = "skill-trust-badge__name sr-only";
  nameEl.textContent = data.name;
  root.append(nameEl);

  return root;
}
