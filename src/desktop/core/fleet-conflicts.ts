/**
 * ConflictsLane — a read-only view model over the desktop fleet's restart
 * recovery reports (`../../hades/backends/adoption.ts`'s `AdoptionReport`,
 * `../../hades/backends/handle-store.ts`'s `ReconcileReport`, and
 * `../ipc/fleet-provision-contract.ts`'s `FleetRestoredDrop[]` — the exact
 * shape `fleet-wiring.ts` hands the `fleet.restored` event) that separates
 * three genuinely different situations an operator needs to act on
 * differently:
 *
 *  - **conflict** — a restored handle's `workerId` was already live in the
 *    registry, so adoption skipped it entirely (`AdoptionReport.conflicts`).
 *    This is the one severity with a real remediation: rename-and-provision
 *    a fresh worker under a free id (never overwrite the live one).
 *  - **dropped** — a handle adoption/reconcile could not trust or would
 *    never adopt at all (unknown backend, a throwing probe, a terminal
 *    remote state, ...). Nothing to rename; the reason is shown verbatim.
 *  - **corrected** — a handle WAS adopted/restored, but its persisted state
 *    disagreed with the freshly probed truth. Informational, not actionable.
 *
 * This module never mutates or re-adopts anything — it is a pure derivation
 * over already-computed reports, safe to call as often as the UI likes.
 *
 * This module also carries {@link extractPlaceholderNotice}, a small,
 * purely structural helper that undoes the one piece of string concatenation
 * `fleet-wiring.ts` does to `routing.reason` when the manager URL / auth
 * token were placeholders (see that module's `placeholderNote` local), so
 * the desktop UI can show the placeholder-credentials warning as its own
 * first-class banner instead of buried inside a free-text routing reason.
 */

import type { AdoptionReport } from "../../hades/backends/adoption";
import type { ReconcileReport } from "../../hades/backends/handle-store";
import type { FleetRestoredDrop, FleetProvisionRouting } from "../ipc/fleet-provision-contract";
import { suggestWorkerId } from "./worker-id-suggest";

// ===========================================================================
// Model
// ===========================================================================

export type ConflictSeverity = "conflict" | "dropped" | "corrected";

export interface ConflictItem {
  workerId: string;
  severity: ConflictSeverity;
  reason: string;
  suggestedAction: "rename-and-provision" | "terminate-live-first" | "none";
  suggestedWorkerId?: string;
}

export interface ConflictsLaneModel {
  items: ConflictItem[];
  counts: { conflict: number; dropped: number; corrected: number };
  notices: string[];
}

/** Ordering weight: higher wins when the same `workerId` shows up at more
 *  than one severity (a live-registry conflict is always the more urgent,
 *  more actionable fact than "also happened to be dropped somewhere"). Also
 *  the sort key for {@link deriveConflictsLane}'s `items` (conflict first,
 *  then dropped, then corrected). */
function severityRank(s: ConflictSeverity): number {
  switch (s) {
    case "conflict":
      return 3;
    case "dropped":
      return 2;
    case "corrected":
      return 1;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

interface RawEntry {
  workerId: string;
  severity: ConflictSeverity;
  reason: string;
}

/** Every `workerId` mentioned ANYWHERE in the input — live, adopted,
 *  conflicted, dropped, corrected, restored — used as the collision set fed
 *  to `suggestWorkerId` so a rename suggestion can never collide with
 *  anything the input knows about, not just the currently-live fleet. */
function collectMentionedIds(input: {
  adoption?: AdoptionReport;
  reconcile?: ReconcileReport;
  drops?: FleetRestoredDrop[];
  liveIds: Iterable<string>;
}): Set<string> {
  const ids = new Set<string>();
  for (const id of input.liveIds) ids.add(id);

  if (input.adoption) {
    for (const h of input.adoption.adopted) ids.add(h.workerId);
    for (const c of input.adoption.corrected) ids.add(c.workerId);
    for (const c of input.adoption.conflicts) ids.add(c.workerId);
    for (const d of input.adoption.dropped) ids.add(d.workerId);
  }
  if (input.reconcile) {
    for (const h of input.reconcile.restored) ids.add(h.workerId);
    for (const c of input.reconcile.corrected) ids.add(c.workerId);
    for (const d of input.reconcile.dropped) ids.add(d.workerId);
  }
  for (const d of input.drops ?? []) ids.add(d.workerId);

  return ids;
}

function correctedReason(stored: string, probed: string): string {
  return `stored ${stored} ≠ probed ${probed}`;
}

/**
 * Derives a {@link ConflictsLaneModel} from the fleet's restart-recovery
 * reports. Purely read-only: nothing in `input` is mutated, and no adoption,
 * probing, or persistence happens here (that already happened upstream, in
 * `HandleAdoptionService` / `HandleStore.reconcile`).
 *
 * Classification (per source, before dedup):
 *
 *  - `adoption.conflicts[]` -> `"conflict"`, action `"rename-and-provision"`,
 *    with a `suggestedWorkerId` computed via `suggestWorkerId({ base:
 *    workerId, taken: liveIds ∪ every id mentioned anywhere in `input` })`.
 *  - `adoption.dropped[]`, `reconcile.dropped[]`, `drops[]` -> `"dropped"`,
 *    action `"none"`, the verbatim reason.
 *  - `adoption.corrected[]`, `reconcile.corrected[]` -> `"corrected"`,
 *    action `"none"`, reason `"stored <state> ≠ probed <state>"`.
 *
 * A `workerId` that appears under more than one of the above (e.g. it is
 * BOTH a live-registry conflict AND separately reported dropped by
 * `reconcile`) collapses into a single {@link ConflictItem} at the HIGHEST
 * severity present (conflict > dropped > corrected), with every distinct
 * reason string across all its occurrences joined with `"; "` — and a
 * `notices[]` entry recording that a merge happened, so the UI/operator can
 * see the collapse wasn't silent data loss. A `workerId` present in both
 * `corrected` and `reconcile.restored` still surfaces as a `"corrected"`
 * item — `restored` itself contributes no items (it is the "probed clean"
 * superset, not a problem list).
 *
 * `items` is deterministically ordered: severity (conflict, then dropped,
 * then corrected), then `workerId` lexicographically. `counts` tallies the
 * FINAL, deduped items (never raw per-source entries). An input with
 * nothing wrong anywhere yields `{ items: [], counts: {0,0,0}, notices: [] }`.
 */
export function deriveConflictsLane(input: {
  adoption?: AdoptionReport;
  reconcile?: ReconcileReport;
  drops?: FleetRestoredDrop[];
  liveIds: Iterable<string>;
}): ConflictsLaneModel {
  const raw: RawEntry[] = [];

  if (input.adoption) {
    for (const c of input.adoption.conflicts) {
      raw.push({ workerId: c.workerId, severity: "conflict", reason: c.reason });
    }
    for (const d of input.adoption.dropped) {
      raw.push({ workerId: d.workerId, severity: "dropped", reason: d.reason });
    }
    for (const c of input.adoption.corrected) {
      raw.push({ workerId: c.workerId, severity: "corrected", reason: correctedReason(c.stored, c.probed) });
    }
  }
  if (input.reconcile) {
    for (const d of input.reconcile.dropped) {
      raw.push({ workerId: d.workerId, severity: "dropped", reason: d.reason });
    }
    for (const c of input.reconcile.corrected) {
      raw.push({ workerId: c.workerId, severity: "corrected", reason: correctedReason(c.stored, c.probed) });
    }
  }
  for (const d of input.drops ?? []) {
    raw.push({ workerId: d.workerId, severity: "dropped", reason: d.reason });
  }

  const byId = new Map<string, RawEntry[]>();
  for (const entry of raw) {
    const list = byId.get(entry.workerId);
    if (list) list.push(entry);
    else byId.set(entry.workerId, [entry]);
  }

  const mentionedIds = collectMentionedIds(input);
  const notices: string[] = [];
  const items: ConflictItem[] = [];

  for (const [workerId, entries] of byId) {
    let severity: ConflictSeverity = entries[0].severity;
    for (const e of entries) {
      if (severityRank(e.severity) > severityRank(severity)) severity = e.severity;
    }

    const reasons: string[] = [];
    for (const e of entries) {
      if (!reasons.includes(e.reason)) reasons.push(e.reason);
    }
    const reason = reasons.join("; ");

    const distinctSeverities = [...new Set(entries.map((e) => e.severity))];
    if (distinctSeverities.length > 1 || entries.length > 1) {
      notices.push(
        `workerId "${workerId}": merged ${entries.length} reason(s) from ${distinctSeverities.join(
          ", "
        )} source(s) into a single "${severity}" item.`
      );
    }

    let suggestedAction: ConflictItem["suggestedAction"] = "none";
    let suggestedWorkerId: string | undefined;
    if (severity === "conflict") {
      suggestedAction = "rename-and-provision";
      suggestedWorkerId = suggestWorkerId({ base: workerId, taken: mentionedIds });
    }

    items.push({
      workerId,
      severity,
      reason,
      suggestedAction,
      ...(suggestedWorkerId !== undefined ? { suggestedWorkerId } : {}),
    });
  }

  items.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0;
  });

  const counts = { conflict: 0, dropped: 0, corrected: 0 };
  for (const item of items) counts[item.severity]++;

  return { items, counts, notices };
}

// ===========================================================================
// deriveConflictsLaneFromRestored — wire-event adapter for the renderer
// ===========================================================================

/**
 * Derive the conflicts lane straight from a `fleet.restored` WIRE event
 * (`../ipc/fleet-provision-contract.ts`), which is all the renderer ever
 * sees — the sidecar-side `AdoptionReport`/`ReconcileReport` objects never
 * cross the IPC boundary. The event's `conflicts` field (when the sidecar
 * sends it) carries the already-live workerId collisions; because
 * `fleet-wiring.ts` ALSO keeps those inside `dropped` for wire back-compat,
 * this adapter filters conflict ids out of the drops list first — otherwise
 * every conflict would surface twice and be merge-noticed on every render.
 *
 * `extraLiveIds` lets the caller union in worker ids it knows are live from
 * other event streams (e.g. the fleet snapshot view), so a rename suggestion
 * can never collide with a worker the restored event itself didn't mention.
 */
export function deriveConflictsLaneFromRestored(
  ev: {
    workers: Array<{ workerId: string }>;
    dropped: FleetRestoredDrop[];
    conflicts?: FleetRestoredDrop[];
  },
  extraLiveIds: Iterable<string> = []
): ConflictsLaneModel {
  const conflicts = ev.conflicts ?? [];
  const conflictIds = new Set(conflicts.map((c) => c.workerId));
  const liveIds = new Set<string>(extraLiveIds);
  for (const w of ev.workers) liveIds.add(w.workerId);

  const adoption: AdoptionReport = {
    adopted: [],
    corrected: [],
    conflicts: conflicts.map((c) => ({ workerId: c.workerId, reason: c.reason })),
    dropped: [],
  };

  return deriveConflictsLane({
    adoption,
    drops: ev.dropped.filter((d) => !conflictIds.has(d.workerId)),
    liveIds,
  });
}

// ===========================================================================
// extractPlaceholderNotice
// ===========================================================================

/**
 * The exact literal marker `fleet-wiring.ts` prefixes its placeholder note
 * with (`placeholderNote = \` (placeholder manager credentials — set
 * ${MANAGER_URL_ENV}/${AUTH_TOKEN_ENV} for real ones)\``): a leading space,
 * an opening paren, then this fixed phrase, before the (variable) env var
 * names and the fixed `" for real ones)"` tail. Anchoring on this exact
 * multi-word phrase — rather than the single word "placeholder" — is what
 * keeps ordinary routing reasons that happen to mention "placeholder" from
 * ever being misread as the credentials notice.
 */
const PLACEHOLDER_NOTICE_MARKER = " (placeholder manager credentials — set ";

/**
 * Structurally splits the placeholder-credentials suffix `fleet-wiring.ts`
 * appends to a provision's `routing.reason` back out into a clean `reason`
 * plus a separate `notice`, so the desktop UI can render the credentials
 * warning as its own first-class banner instead of leaving it concatenated
 * into free-text routing prose.
 *
 * Anchored on STRUCTURE, not on the word "placeholder" appearing anywhere:
 * the marker must appear as a genuine SUFFIX — `reason` must both contain
 * {@link PLACEHOLDER_NOTICE_MARKER} and end with the closing `")"` that
 * marker's own parenthetical opens. A routing reason that merely happens to
 * contain the word "placeholder" somewhere in the middle (or even the exact
 * marker text, but not running all the way to a final closing paren) never
 * matches, and is returned completely unchanged.
 *
 * `routing`, and `routing.reason`, are both optional-safe: a `undefined`
 * routing, or a routing with no `reason`, returns `{ reason: "" }` rather
 * than throwing.
 */
export function extractPlaceholderNotice(
  routing: FleetProvisionRouting | undefined
): { reason: string; notice?: string } {
  const rawReason = routing?.reason ?? "";

  const idx = rawReason.lastIndexOf(PLACEHOLDER_NOTICE_MARKER);
  if (idx === -1) return { reason: rawReason };
  if (!rawReason.endsWith(")")) return { reason: rawReason };

  const cleanReason = rawReason.slice(0, idx);
  // Strip the marker's leading " (" and the trailing ")" to leave just the
  // human-readable notice text.
  const notice = rawReason.slice(idx + 2, rawReason.length - 1);
  if (notice.length === 0) return { reason: rawReason };

  return { reason: cleanReason, notice };
}
