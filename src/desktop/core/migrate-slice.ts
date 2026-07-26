/**
 * Pure reducer for the desktop migration surface (`migrate.*` events).
 *
 * Same shape as `./state-slice.ts`: a plain immutable state object plus a
 * `(state, event) => state` reducer with no I/O, no clock and no globals, so
 * the Import card can be exercised in tests by feeding it real
 * `MigrateEvent`s decoded off the wire.
 *
 * Honesty rules encoded here rather than in the view:
 *  - `busy` is set by the renderer when a command is SENT and cleared by any
 *    terminal event, so the card can never show a stale "scanning…" forever
 *    while also never claiming a result it did not receive.
 *  - An error does not clear the previous scan/plan — the last real data
 *    stays visible with the failure shown next to it, instead of the view
 *    silently reverting to "nothing found".
 *  - `applied` is only ever set from a real `migrate.applied` event; a
 *    refused apply arrives as that same event with `refused` set and zero
 *    counts, so a refusal can never render as a successful import.
 */

import type {
  MigrateApplyView,
  MigrateEvent,
  MigratePlanView,
  MigrateReceiptsView,
  MigrateScanView,
} from "../ipc/migrate-contract";

export interface MigrateSlice {
  /** Last real scan result, or null if none has been received yet. */
  scan: MigrateScanView | null;
  /** Last plan (always a preview: `dryRun: true`) or the plan an apply ran from. */
  plan: MigratePlanView | null;
  /** Last apply result — including a refusal (`refused` set, zero counts). */
  applied: MigrateApplyView | null;
  /** Last receipt-chain summary. */
  receipts: MigrateReceiptsView | null;
  /** Last error, kept alongside (not instead of) the previous real data. */
  error: { op: string; message: string; at: number } | null;
  /** True between sending a command and receiving its terminal event. */
  busy: boolean;
  /** Timestamp of the most recent event applied to this slice (0 = none). */
  lastAt: number;
}

export function initialMigrateSlice(): MigrateSlice {
  return { scan: null, plan: null, applied: null, receipts: null, error: null, busy: false, lastAt: 0 };
}

/** Marks the slice busy (renderer calls this when it SENDS a migrate command). */
export function migrateBusy(state: MigrateSlice): MigrateSlice {
  return { ...state, busy: true };
}

export function reduceMigrate(state: MigrateSlice, ev: MigrateEvent): MigrateSlice {
  switch (ev.kind) {
    case "migrate.sources":
      return { ...state, scan: ev.scan, error: null, busy: false, lastAt: ev.at };
    case "migrate.plan":
      return { ...state, plan: ev.plan, scan: ev.scan, error: null, busy: false, lastAt: ev.at };
    case "migrate.applied":
      return { ...state, applied: ev.result, plan: ev.plan, error: null, busy: false, lastAt: ev.at };
    case "migrate.receipts":
      return { ...state, receipts: ev.receipts, error: null, busy: false, lastAt: ev.at };
    case "migrate.error":
      return { ...state, error: { op: ev.op, message: ev.message, at: ev.at }, busy: false, lastAt: ev.at };
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return state;
    }
  }
}

export const migrateSelectors = {
  /** How many sources were actually read (duplicate layout matches excluded). */
  sourcesRead(state: MigrateSlice): number {
    return state.scan ? state.scan.sources.filter((s) => s.read).length : 0;
  },
  /** Total items across every discovered source. */
  itemsFound(state: MigrateSlice): number {
    return state.scan ? state.scan.sources.filter((s) => s.read).reduce((n, s) => n + s.itemCount, 0) : 0;
  },
  /** True when the current plan cannot be applied as-is. */
  blocked(state: MigrateSlice): boolean {
    return !!state.plan && state.plan.blockers.length > 0;
  },
  /** True when the last apply actually wrote something that stuck. */
  importedSomething(state: MigrateSlice): boolean {
    const a = state.applied;
    return !!a && !a.refused && !a.rolledBack && a.applied > 0;
  },
};
