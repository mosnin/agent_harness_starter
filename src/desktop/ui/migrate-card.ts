/**
 * Hades desktop — the "Import from Hermes / OpenClaw" card (Settings view).
 *
 * A pure HTML-string renderer over `MigrateSlice` (`../core/migrate-slice.ts`),
 * in the same style as `state-view.ts` / `learning-card.ts`: string in, string
 * out, no DOM, no globals, no clock.
 *
 * What it will never do:
 *  - claim an import happened. Only a real `migrate.applied` event with a
 *    non-refused, non-rolled-back result renders as an import, and the exact
 *    counts (applied / quarantined by the write-guard / secrets written) come
 *    straight off the wire.
 *  - print key material. Discovered API keys are rendered by env-var NAME
 *    only — that is all the wire carries (see `../ipc/migrate-contract.ts`).
 *  - hide a blocker. A blocked plan disables the Import button and lists
 *    every blocker code and message.
 *
 * ## Escaping
 *
 * Every value here is FOREIGN data read out of somebody else's install —
 * paths, layout names, reasons, vendor strings. Text goes through `esc`,
 * anything landing in an attribute goes through `escAttr`.
 */

import { esc, escAttr } from "./shell";
import type { MigrateSlice } from "../core/migrate-slice";
import { migrateSelectors } from "../core/migrate-slice";

function whenLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "—";
  }
}

function renderSources(slice: MigrateSlice): string {
  const scan = slice.scan;
  if (!scan) {
    return `<p class="settings-row migrate-empty">No scan yet — run a scan to look for a Hermes or OpenClaw install on this machine.</p>`;
  }
  if (scan.sources.length === 0) {
    return `<div class="migrate-empty" data-testid="migrate-no-sources">
      <p class="settings-row">No Hermes/OpenClaw installation found. Searched ${scan.searched.length} location(s).</p>
      ${
        scan.skipped.length > 0
          ? `<ul class="migrate-list" role="list">${scan.skipped
              .map((s) => `<li><code>${esc(s.path)}</code> — ${esc(s.reason)}</li>`)
              .join("")}</ul>`
          : ""
      }
    </div>`;
  }

  const rows = scan.sources
    .map(
      (s) => `<li class="migrate-source${s.read ? "" : " migrate-source--dup"}">
      <span class="migrate-chip">${esc(s.vendor)}</span>
      <span class="migrate-source__layout">${esc(s.layout)}</span>
      <code class="migrate-source__root" title="${escAttr(s.root)}">${esc(s.root)}</code>
      <span class="migrate-source__count">${s.itemCount} item(s)</span>
      <span class="migrate-source__confidence" title="Detection confidence">${s.confidence.toFixed(2)}</span>
      ${s.read ? "" : `<span class="migrate-chip migrate-chip--muted">duplicate layout match</span>`}
      ${s.warnings.map((w) => `<span class="migrate-warning">${esc(w)}</span>`).join("")}
    </li>`,
    )
    .join("");

  const keys =
    scan.secretEnvVars.length > 0
      ? `<p class="settings-row migrate-keys" data-testid="migrate-keys">API keys found (names only, never displayed or logged): ${scan.secretEnvVars
          .map((k) => `<code>${esc(k)}</code>`)
          .join(", ")}</p>`
      : "";

  const readErrors =
    scan.readErrors.length > 0
      ? `<ul class="migrate-list migrate-list--bad" role="list">${scan.readErrors
          .map((e) => `<li><code>${esc(e.path)}</code> — ${esc(e.reason)}</li>`)
          .join("")}</ul>`
      : "";

  const notes =
    scan.notes.length > 0
      ? `<ul class="migrate-list migrate-list--muted" role="list">${scan.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : "";

  return `<ul class="migrate-sources" role="list" data-testid="migrate-sources">${rows}</ul>${keys}${readErrors}${notes}`;
}

function renderPlan(slice: MigrateSlice): string {
  const plan = slice.plan;
  if (!plan) return "";

  const counts = plan.byAction
    .filter((c) => c.count > 0)
    .map((c) => `<span class="migrate-chip">${esc(c.action)} ${c.count}</span>`)
    .join("");

  const blockers =
    plan.blockers.length > 0
      ? `<ul class="migrate-list migrate-list--bad" role="list" data-testid="migrate-blockers">${plan.blockers
          .map((b) => `<li><strong>${esc(b.code)}</strong> — ${esc(b.message)}${b.path ? ` <code>${esc(b.path)}</code>` : ""}</li>`)
          .join("")}</ul>`
      : "";

  const notImported =
    plan.unimportable.length > 0
      ? `<details class="migrate-details"><summary>Not imported (${plan.unimportable.length})</summary>
        <ul class="migrate-list" role="list">${plan.unimportable
          .map((u) => `<li><code>${esc(u.path)}</code> [${esc(u.kind)}] — ${esc(u.reason)}</li>`)
          .join("")}</ul></details>`
      : "";

  return `<div class="migrate-plan" data-testid="migrate-plan">
    <p class="settings-row">
      <strong>${plan.actions.length}</strong> action(s) planned
      &middot; plan <code>${esc(plan.planHash.slice(0, 12))}</code>
      ${plan.dryRun ? `<span class="migrate-chip migrate-chip--dry">preview only</span>` : ""}
      ${plan.destructive > 0 ? `<span class="migrate-chip migrate-chip--bad">${plan.destructive} destructive</span>` : ""}
    </p>
    <div class="migrate-chips">${counts}</div>
    ${blockers}
    ${notImported}
  </div>`;
}

function renderApplied(slice: MigrateSlice): string {
  const a = slice.applied;
  if (!a) return "";
  if (a.refused) {
    return `<p class="settings-row migrate-refused" data-testid="migrate-applied">Nothing was imported — ${esc(a.refused)}</p>`;
  }
  if (a.rolledBack) {
    return `<p class="settings-row migrate-refused" data-testid="migrate-applied">The import FAILED and was rolled back — your data directory is unchanged (${a.failed} failure(s)).</p>`;
  }
  return `<p class="settings-row migrate-ok" data-testid="migrate-applied">
    Imported <strong>${a.applied}</strong> action(s)${a.failed > 0 ? `, ${a.failed} failed` : ""}
    &middot; ${a.quarantined} quarantined by the memory write-guard
    &middot; ${a.secretsWritten} API key(s) written
    &middot; receipts <code>${esc(a.receiptHead.slice(0, 12))}</code>
  </p>`;
}

function renderReceipts(slice: MigrateSlice): string {
  const r = slice.receipts;
  if (!r) return "";
  const chainClass = r.chainOk ? "migrate-chip" : "migrate-chip migrate-chip--bad";
  const chainLabel = r.chainOk ? "chain verified" : `CHAIN BROKEN at seq ${r.brokenAt ?? "?"}`;
  return `<p class="settings-row" data-testid="migrate-receipts">
    Receipts: <strong>${r.total}</strong> (${r.ok} ok, ${r.failed} failed)
    <span class="${chainClass}">${esc(chainLabel)}</span>
    ${r.lastAt !== undefined ? `<span class="migrate-chip migrate-chip--muted">last ${esc(whenLabel(r.lastAt))}</span>` : ""}
  </p>`;
}

/**
 * The whole card. `data-cmd` values are handled by the renderer, which turns
 * them into REAL `migrate.*` wire commands answered by the sidecar's
 * `MigrateService` — nothing here is simulated locally.
 */
export function renderMigrateCard(slice: MigrateSlice): string {
  const busy = slice.busy;
  const blocked = migrateSelectors.blocked(slice);
  const hasPlan = !!slice.plan;
  const importDisabled = busy || !hasPlan || blocked;

  const error = slice.error
    ? `<p class="settings-row migrate-error" data-testid="migrate-error">${esc(slice.error.op)} failed: ${esc(slice.error.message)}</p>`
    : "";

  const busyNote = busy ? `<p class="settings-row migrate-busy">Working&hellip;</p>` : "";

  return `<section class="run-section migrate-card" aria-label="Import from Hermes or OpenClaw">
    <h2 class="run-section-title">Import from Hermes / OpenClaw</h2>
    <p class="settings-row migrate-lede">
      Move a real Hermes or OpenClaw install into Hades: memories, sessions, skills, context files,
      config, model selection and API keys. Nothing is written until you press Import, and a failed
      import is rolled back in full.
    </p>
    <div class="settings-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="migrate.scan"${busy ? " disabled" : ""}>Scan for installs</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="migrate.plan"${busy ? " disabled" : ""}>Preview plan</button>
      <button type="button" class="btn btn-primary btn-sm" data-cmd="migrate.apply"${importDisabled ? " disabled" : ""}>${
        blocked ? "Import blocked" : "Import"
      }</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cmd="migrate.receipts"${busy ? " disabled" : ""}>Receipts</button>
    </div>
    ${busyNote}
    ${error}
    ${renderSources(slice)}
    ${renderPlan(slice)}
    ${renderApplied(slice)}
    ${renderReceipts(slice)}
  </section>`;
}
