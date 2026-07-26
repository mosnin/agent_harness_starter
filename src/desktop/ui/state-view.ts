/**
 * Hades desktop — the Workspace surface.
 *
 * A pure HTML-string renderer over `StateSlice` (`../core/state-slice.ts`),
 * in exactly the style of `run-view.ts` / `fleet-view.ts`: string in, string
 * out, no DOM, no globals, no clock. Everything it shows is real data the
 * sidecar read off the SHARED workspace store (`src/hades/state/**`) — the
 * same `<dataDir>/state` journal `hades state` writes — so a record set from
 * a terminal appears here, and the change log below it names the actor that
 * wrote each batch.
 *
 * Nothing here is fabricated: an empty domain renders "no records", a
 * never-synced workspace renders "never", and a broken hash chain renders as
 * a loud failure rather than being smoothed over.
 *
 * ## Escaping
 *
 * Record keys and actor ids are FOREIGN data (another process wrote them),
 * and a workspace key may legally contain quotes — see `validateKey` in
 * `src/hades/state/record.ts`. Every value that lands inside an attribute
 * therefore goes through `escAttr`, never plain `esc`.
 */

import { esc, escAttr } from "./shell";
import type { StateSlice } from "../core/state-slice";
import { stateSelectors } from "../core/state-slice";
import type { WorkspaceRecordView } from "../ipc/state-contract";

/** The domains the Workspace surface offers, in display order. Mirrors `WORKSPACE_DOMAINS`. */
export const STATE_VIEW_DOMAINS = ["sessions", "memory", "config", "skills"] as const;
export type StateViewDomain = (typeof STATE_VIEW_DOMAINS)[number];

export function isStateViewDomain(v: string): v is StateViewDomain {
  return (STATE_VIEW_DOMAINS as readonly string[]).includes(v);
}

/** Renderer-owned view state for this surface (which domain is selected, filter text). */
export interface StateViewState {
  domain: StateViewDomain;
  filter: string;
}

export function initialStateViewState(): StateViewState {
  return { domain: "memory", filter: "" };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortHash(h: string): string {
  if (h.length === 0) return "—";
  return h.slice(0, 10);
}

function whenLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "—";
  }
}

/**
 * A one-line preview of a record's value. Deliberately built from
 * `JSON.stringify` and truncated with a visible ellipsis, so a long value is
 * obviously abbreviated rather than looking complete. A value that cannot be
 * stringified (a cycle, which the store would have rejected, but the wire
 * type is `unknown`) reports that fact instead of rendering "{}".
 */
function valuePreview(value: unknown, max = 120): string {
  if (value === null) return "null";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return "(unrenderable value)";
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderStatus(slice: StateSlice): string {
  const s = slice.status;
  if (!s) {
    return `<div class="state-status state-status--empty" data-testid="state-status">
      <p class="settings-row">No workspace status yet — the sidecar has not answered <code>state.status</code>.</p>
    </div>`;
  }

  const chainClass = s.chainOk ? "state-chip state-chip--ok" : "state-chip state-chip--bad";
  const chainLabel = s.chainOk ? "chain verified" : "CHAIN BROKEN";
  const domains = s.perDomain
    .map(
      (d) => `<li class="state-domain-stat">
        <span class="state-domain-stat__name">${esc(d.domain)}</span>
        <span class="state-domain-stat__count">${d.records}</span>
        <span class="state-domain-stat__when">${esc(whenLabel(d.lastUpdatedAt))}</span>
      </li>`,
    )
    .join("");

  return `<div class="state-status" data-testid="state-status">
    <div class="state-status__row">
      <span class="${chainClass}" data-testid="state-chain">${esc(chainLabel)}</span>
      <span class="state-chip">seq ${s.journalSeq}</span>
      <span class="state-chip" title="Journal head hash">head ${esc(shortHash(s.head))}</span>
      <span class="state-chip" title="This desktop install's actor identity">as ${esc(s.actor || "unknown")}</span>
    </div>
    <p class="state-status__root" title="${escAttr(s.root)}">${esc(s.root || "(root unknown)")}</p>
    <ul class="state-domain-stats" role="list">${domains}</ul>
    <p class="state-status__sync">
      Last sync: <strong>${esc(s.lastSyncAt === null ? "never" : whenLabel(s.lastSyncAt))}</strong>
      &middot; unresolved conflicts: <strong>${s.conflicts}</strong>
    </p>
  </div>`;
}

function renderToolbar(view: StateViewState): string {
  const tabs = STATE_VIEW_DOMAINS.map((d) => {
    const active = d === view.domain;
    return `<button type="button" class="state-tab${active ? " state-tab--active" : ""}" data-cmd="state.domain" data-value="${escAttr(d)}" aria-pressed="${active ? "true" : "false"}">${esc(d)}</button>`;
  }).join("");

  return `<div class="state-toolbar">
    <div class="state-tabs" role="group" aria-label="Workspace domain">${tabs}</div>
    <input type="text" class="state-filter" id="state-filter-input" placeholder="Filter keys&hellip;" value="${escAttr(view.filter)}" data-state-field="filter" />
    <div class="state-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="state.refresh" data-value="${escAttr(view.domain)}">Refresh</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="state.sync.plan">Preview sync</button>
      <button type="button" class="btn btn-sm" data-cmd="state.sync">Sync</button>
    </div>
  </div>`;
}

function renderRecordRow(r: WorkspaceRecordView): string {
  const cls = r.deleted ? "state-row state-row--deleted" : "state-row";
  const value = r.deleted ? "(tombstone)" : valuePreview(r.value);
  return `<tr class="${cls}" data-domain="${escAttr(r.domain)}" data-key="${escAttr(r.key)}">
    <td class="state-row__key" title="${escAttr(r.key)}">${esc(r.key)}</td>
    <td class="state-row__rev">${r.rev}</td>
    <td class="state-row__actor">${esc(r.actor)}</td>
    <td class="state-row__when">${esc(whenLabel(r.updatedAt))}</td>
    <td class="state-row__hash" title="${escAttr(r.hash)}">${esc(shortHash(r.hash))}</td>
    <td class="state-row__value">${esc(value)}</td>
    <td class="state-row__actions">
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="state.delete" data-value="${escAttr(r.key)}"${r.deleted ? " disabled" : ""}>Delete</button>
    </td>
  </tr>`;
}

/** Case-insensitive substring match on the key — a plain filter, never a fuzzy score presented as relevance. */
export function filterRecords(records: readonly WorkspaceRecordView[], filter: string): WorkspaceRecordView[] {
  const needle = filter.trim().toLowerCase();
  const sorted = [...records].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (needle.length === 0) return sorted;
  return sorted.filter((r) => r.key.toLowerCase().includes(needle));
}

function renderRecords(slice: StateSlice, view: StateViewState): string {
  const all = stateSelectors.domainRecords(slice, view.domain);
  const rows = filterRecords(all, view.filter);

  if (rows.length === 0) {
    const why =
      all.length === 0
        ? `No records in <strong>${esc(view.domain)}</strong>.`
        : `No key in <strong>${esc(view.domain)}</strong> matches that filter (${all.length} record(s) hidden).`;
    return `<p class="state-empty" data-testid="state-empty">${why}</p>`;
  }

  return `<div class="state-table-wrap">
    <table class="state-table" data-testid="state-table">
      <thead>
        <tr><th>Key</th><th>Rev</th><th>Actor</th><th>Updated</th><th>Hash</th><th>Value</th><th></th></tr>
      </thead>
      <tbody>${rows.map(renderRecordRow).join("")}</tbody>
    </table>
  </div>`;
}

function renderConflicts(slice: StateSlice): string {
  if (slice.conflicts.length === 0) return "";
  const rows = slice.conflicts
    .map(
      (c) => `<li class="state-conflict">
      <span class="state-conflict__key">${esc(c.domain)}/${esc(c.key)}</span>
      <span class="state-chip state-chip--warn">${esc(c.resolution)}</span>
      <span class="state-conflict__actors">${esc(c.localActor)} vs ${esc(c.remoteActor)}</span>
      <span class="state-conflict__reason">${esc(c.reason)}</span>
    </li>`,
    )
    .join("");
  return `<section class="run-section" aria-label="Sync conflicts">
    <h2 class="run-section-title">Conflicts from the last sync</h2>
    <ul class="state-conflicts" role="list">${rows}</ul>
  </section>`;
}

function renderChangeLog(slice: StateSlice, selfActor: string): string {
  if (slice.changeLog.length === 0) {
    return `<p class="settings-row state-changelog--empty">No live changes observed yet.</p>`;
  }
  const foreign = stateSelectors.foreignWrites(slice, selfActor);
  // Newest first; the slice appends chronologically.
  const rows = [...slice.changeLog]
    .reverse()
    .slice(0, 40)
    .map((e) => {
      const mine = e.actor === selfActor;
      return `<li class="state-change${mine ? "" : " state-change--foreign"}">
        <span class="state-change__seq">#${e.seq}</span>
        <span class="state-change__actor">${esc(e.actor)}</span>
        <span class="state-change__keys" title="${escAttr(e.keys.join(", "))}">${esc(e.keys.slice(0, 4).join(", "))}${e.keys.length > 4 ? ` +${e.keys.length - 4}` : ""}</span>
      </li>`;
    })
    .join("");
  return `<p class="settings-row">${foreign} of ${slice.changeLog.length} observed batch(es) came from another surface.</p>
  <ul class="state-changelog" role="list">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

export function renderStateView(slice: StateSlice, view: StateViewState): string {
  const selfActor = slice.status?.actor ?? "";
  const error = slice.lastError
    ? `<p class="state-error" data-testid="state-error" role="alert">${esc(slice.lastError.op)}: ${esc(slice.lastError.message)}</p>`
    : "";

  return `<div class="state-view">
    <section class="run-section" aria-label="Workspace status">
      <h2 class="run-section-title">Shared workspace</h2>
      <p class="settings-row">One hash-chained store, written concurrently by this app, the <code>hades state</code> CLI and the TUI.</p>
      ${renderStatus(slice)}
      ${error}
    </section>

    <section class="run-section" aria-label="Workspace records">
      <h2 class="run-section-title">Records</h2>
      ${renderToolbar(view)}
      ${renderRecords(slice, view)}
    </section>

    ${renderConflicts(slice)}

    <section class="run-section" aria-label="Live changes">
      <h2 class="run-section-title">Live changes</h2>
      ${renderChangeLog(slice, selfActor)}
    </section>
  </div>`;
}
