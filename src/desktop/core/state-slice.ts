/**
 * Hades desktop workspace-state store slice.
 *
 * A PURE reducer over `StateService`'s `StateEvent` stream into immutable UI
 * state, plus a set of derived selectors — the `state.*` sibling of
 * `./app-store.ts`'s `reduce`/`selectors`, and deliberately independent of
 * it: this module owns no I/O, no timers, no randomness, and never imports
 * `./app-store.ts` (the renderer feeds `AppEvent`s and `StateEvent`s to the
 * two reducers separately, exactly like the fleet/schedule/learning cards
 * already do for their own event streams).
 *
 * ## Purity guarantees
 *
 * `reduceState` never mutates its `slice` argument (every branch returns a
 * freshly-built object; arrays that change are rebuilt, not spliced in
 * place), reads no ambient clock (the `state.changed` log timestamp comes
 * from the INJECTED `now`, defaulted to `Date.now` for the renderer's
 * convenience only), and always returns the exact SAME `slice` reference —
 * not a
 * structurally-equal copy — for an event kind it doesn't recognize, so a
 * caller can cheaply skip a re-render with `===`. `(slice, event) ->
 * result` is a deterministic pure function: calling it twice with the same
 * frozen inputs always produces deep-equal output.
 *
 * ## Ordering / idempotency
 *
 * `state.changed` events can arrive duplicated (a `WorkspaceFeed` resync
 * replays a full snapshot) or, in principle, out of order (a `subscribe`
 * caller that races two deliveries). `byDomain` is always updated by
 * upserting each incoming record by `(domain, key)` — applying the same
 * record twice is a no-op the second time, and applying an older record
 * after a newer one merely overwrites with stale data rather than
 * corrupting the slice's shape (the same tolerance `state.records`
 * pagination needs: multiple ordered pages for one `state.list` must merge
 * without losing or duplicating a key). `lastChangeSeq` only ever moves
 * forward (`Math.max`), so an out-of-order or duplicate delivery can never
 * make the slice's notion of "how far we've observed" go backwards.
 */

import type {
  StateEvent,
  WorkspaceConflictView,
  WorkspaceRecordView,
  WorkspaceStatusView,
} from "../ipc/state-contract";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface StateSlice {
  status: WorkspaceStatusView | null;
  byDomain: Record<string, WorkspaceRecordView[]>;
  conflicts: WorkspaceConflictView[];
  lastChangeSeq: number;
  lastError: { op: string; message: string } | null;
  changeLog: Array<{ seq: number; actor: string; keys: string[]; at: number }>;
}

const LOG_CAP = 200;

export function initialStateSlice(): StateSlice {
  return {
    status: null,
    byDomain: {},
    conflicts: [],
    lastChangeSeq: 0,
    lastError: null,
    changeLog: [],
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Upserts `incoming` into `existing` by `key`, without mutating `existing`. Later entries in `incoming` win over earlier ones for the same key (mirrors how a single ordered event/page stream is meant to be applied). */
function upsertRecords(existing: readonly WorkspaceRecordView[], incoming: readonly WorkspaceRecordView[]): WorkspaceRecordView[] {
  if (incoming.length === 0) return existing.slice();
  const byKey = new Map(existing.map((r) => [r.key, r]));
  for (const rec of incoming) byKey.set(rec.key, rec);
  return [...byKey.values()];
}

function withDomainRecords(slice: StateSlice, domain: string, incoming: readonly WorkspaceRecordView[]): StateSlice {
  const merged = upsertRecords(slice.byDomain[domain] ?? [], incoming);
  return { ...slice, byDomain: { ...slice.byDomain, [domain]: merged } };
}

function appendChangeLog(
  slice: StateSlice,
  entry: { seq: number; actor: string; keys: string[]; at: number },
): Array<{ seq: number; actor: string; keys: string[]; at: number }> {
  const appended = [...slice.changeLog, entry];
  return appended.length > LOG_CAP ? appended.slice(appended.length - LOG_CAP) : appended;
}

/**
 * `now` is injected (never read from the ambient clock inside the reducer)
 * so `reduceState` is genuinely a pure function of its arguments: the same
 * `(slice, event, now)` triple always produces deep-equal output. It
 * defaults to `Date.now` only as an ergonomic convenience for the renderer,
 * which has a real clock; every test and every deterministic replay passes
 * its own.
 */
export function reduceState(slice: StateSlice, ev: StateEvent, now: () => number = Date.now): StateSlice {
  switch (ev.kind) {
    case "state.status": {
      return { ...slice, status: ev.status };
    }

    case "state.records": {
      return withDomainRecords(slice, ev.domain, ev.records);
    }

    case "state.changed": {
      // Group incoming records by domain so a single `state.changed`
      // spanning multiple domains (a resync snapshot can) upserts each
      // domain's array independently, then apply every domain's merge in
      // one pass so intermediate states are never observable.
      const byDomainIncoming = new Map<string, WorkspaceRecordView[]>();
      for (const r of ev.records) {
        const arr = byDomainIncoming.get(r.domain) ?? [];
        arr.push(r);
        byDomainIncoming.set(r.domain, arr);
      }
      const nextByDomain = { ...slice.byDomain };
      for (const [domain, incoming] of byDomainIncoming) {
        nextByDomain[domain] = upsertRecords(nextByDomain[domain] ?? [], incoming);
      }
      const lastChangeSeq = Math.max(slice.lastChangeSeq, ev.seq);
      const changeLog = appendChangeLog(slice, {
        seq: ev.seq,
        actor: ev.actor,
        keys: ev.records.map((r) => `${r.domain}/${r.key}`),
        at: now(),
      });
      return { ...slice, byDomain: nextByDomain, lastChangeSeq, changeLog };
    }

    case "state.synced": {
      return { ...slice, conflicts: [...ev.conflicts] };
    }

    case "state.error": {
      return { ...slice, lastError: { op: ev.op, message: ev.message } };
    }

    default: {
      // Exhaustiveness guard: if a new StateEvent kind is added upstream and
      // not handled here, this branch fails to compile. At runtime (e.g. a
      // malformed/forward-incompatible event that slipped past the wire
      // guard), the identical slice reference is returned unchanged.
      const _exhaustive: never = ev;
      void _exhaustive;
      return slice;
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const stateSelectors = {
  domainRecords(s: StateSlice, d: string): WorkspaceRecordView[] {
    return s.byDomain[d] ?? [];
  },

  recordCount(s: StateSlice): number {
    let n = 0;
    for (const records of Object.values(s.byDomain)) {
      for (const r of records) if (!r.deleted) n++;
    }
    return n;
  },

  hasConflicts(s: StateSlice): boolean {
    return s.conflicts.length > 0;
  },

  /** Count of changeLog entries authored by an actor OTHER than `selfActor` — writes this desktop instance observed but did not itself make (e.g. a `hades state set` from the terminal). */
  foreignWrites(s: StateSlice, selfActor: string): number {
    return s.changeLog.filter((e) => e.actor !== selfActor).length;
  },
};
