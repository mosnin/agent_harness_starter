/**
 * Hades desktop app store.
 *
 * A pure reducer over the sidecar's `AppEvent` stream into immutable UI
 * state, plus a set of derived selectors. This module owns no I/O, no
 * timers, and no randomness — every transition is a deterministic function
 * of (state, event).
 */

import type {
  AppEvent,
  WorkerView,
  TaskView,
  RunView,
  VerificationView,
  CertificateView,
  MetricsView,
} from "../ipc/contract";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface AppState {
  running: boolean;
  mode: string;
  poolSize: number;
  workers: WorkerView[]; // sorted by id
  tasks: TaskView[]; // insertion order
  runs: RunView[]; // newest first
  verifications: VerificationView[]; // newest last
  certificates: CertificateView[];
  metrics: MetricsView | null;
  skills: Array<{ name: string; description: string }>;
  log: Array<{ line: string; at: number }>; // capped at 200, newest last
}

const LOG_CAP = 200;

export function initialState(): AppState {
  return {
    running: false,
    mode: "",
    poolSize: 0,
    workers: [],
    tasks: [],
    runs: [],
    verifications: [],
    certificates: [],
    metrics: null,
    skills: [],
    log: [],
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function upsertById<T>(list: T[], item: T, keyOf: (t: T) => string): T[] {
  const key = keyOf(item);
  const idx = list.findIndex((existing) => keyOf(existing) === key);
  if (idx === -1) {
    return [...list, item];
  }
  const next = list.slice();
  next[idx] = item;
  return next;
}

function upsertNewestFirst<T>(list: T[], item: T, keyOf: (t: T) => string): T[] {
  const key = keyOf(item);
  const idx = list.findIndex((existing) => keyOf(existing) === key);
  if (idx === -1) {
    return [item, ...list];
  }
  const next = list.slice();
  next[idx] = item;
  return next;
}

function sortedByIdWorkers(list: WorkerView[]): WorkerView[] {
  return list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function reduce(state: AppState, ev: AppEvent): AppState {
  switch (ev.kind) {
    case "runtime.status":
      return {
        ...state,
        running: ev.running,
        mode: ev.mode,
        poolSize: ev.poolSize,
      };

    case "worker.upsert": {
      const merged = upsertById(state.workers, ev.worker, (w) => w.id);
      return { ...state, workers: sortedByIdWorkers(merged) };
    }

    case "task.upsert": {
      return { ...state, tasks: upsertById(state.tasks, ev.task, (t) => t.id) };
    }

    case "run.upsert": {
      return {
        ...state,
        runs: upsertNewestFirst(state.runs, ev.run, (r) => r.goalId),
      };
    }

    case "verification": {
      return { ...state, verifications: [...state.verifications, ev.report] };
    }

    case "certificate": {
      return { ...state, certificates: [...state.certificates, ev.cert] };
    }

    case "metrics": {
      return { ...state, metrics: ev.metrics };
    }

    case "skills.list": {
      return { ...state, skills: [...ev.skills] };
    }

    case "log": {
      const appended = [...state.log, { line: ev.line, at: ev.at }];
      const log = appended.length > LOG_CAP ? appended.slice(appended.length - LOG_CAP) : appended;
      return { ...state, log };
    }

    // Fleet events are owned by the fleet view's own pure reducer
    // (`../ui/fleet-view.ts`'s `applyFleetEvent`) — the renderer feeds them
    // there. They deliberately do not touch the swarm app state.
    case "fleet.snapshot":
    case "fleet.worker.upsert":
    case "fleet.error":
      return state;

    default: {
      // Exhaustiveness guard: if a new AppEvent kind is added upstream and
      // not handled here, this branch fails to compile.
      const _exhaustive: never = ev;
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function computeTaskLevels(tasks: TaskView[]): number[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function levelOf(id: string): number {
    if (memo.has(id)) return memo.get(id) as number;
    const task = byId.get(id);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      memo.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      // Cycle guard: treat as base level to avoid infinite recursion.
      memo.set(id, 0);
      return 0;
    }
    visiting.add(id);
    let max = -1;
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) continue; // dangling dependency: ignore
      max = Math.max(max, levelOf(dep));
    }
    visiting.delete(id);
    const level = max === -1 ? 0 : max + 1;
    memo.set(id, level);
    return level;
  }

  return tasks.map((t) => levelOf(t.id));
}

export const selectors = {
  liveWorkerCount(s: AppState): number {
    return s.workers.filter((w) => w.status !== "killed" && w.status !== "dead").length;
  },

  verifiedCount(s: AppState): number {
    return s.tasks.filter((t) => t.status === "verified").length;
  },

  rejectedCount(s: AppState): number {
    return s.verifications.filter((v) => v.verdict !== "accept").length;
  },

  groundingPct(s: AppState): number {
    if (!s.metrics) return 0;
    return Math.round(s.metrics.groundingRate * 100);
  },

  tasksByLevel(s: AppState): TaskView[][] {
    const levels = computeTaskLevels(s.tasks);
    const maxLevel = levels.reduce((m, l) => Math.max(m, l), -1);
    const result: TaskView[][] = Array.from({ length: maxLevel + 1 }, () => []);
    s.tasks.forEach((task, i) => {
      result[levels[i]].push(task);
    });
    return result;
  },

  latestCertificate(s: AppState): CertificateView | null {
    if (s.certificates.length === 0) return null;
    return s.certificates[s.certificates.length - 1];
  },
};
