/**
 * Central-integration tests for the desktop learning surface: the learning
 * wire format merged into the main IPC contract (`../ipc/contract.ts`), the
 * sidecar's `learning.get` delegation (`../core/sidecar.ts`), the app-store's
 * pass-through of learning events, and the renderer's learning-card plumbing
 * on the fleet nav (`../ui/renderer.ts`).
 *
 * Real components everywhere: the real codecs, the real `Sidecar`, the real
 * `LearningService` projection, the real `FileLearningStatusStore` writing to
 * a real temp dir on disk, the real reducer/renderers. The only fakes are an
 * array-backed event sink and a scripted `Bridge`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeCommand, decodeEvent, encodeCommand, encodeEvent } from "../ipc/contract";
import type { AppEvent, Command, LearningStatusView } from "../ipc/contract";
import { initialState, reduce } from "../core/app-store";
import { Sidecar, type LearningStatusHandler } from "../core/sidecar";
import { LearningService } from "../core/learning-service";
import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/bridge";
import { FileLearningStatusStore } from "../../hades/backends/learning-status-store";
import type { SwarmLearningStatus } from "../../hades/backends/swarm-learning";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A real, typed SwarmLearningStatus — the engine's own shape, no invented fields. */
function engineStatus(): SwarmLearningStatus {
  return {
    attached: true,
    counts: { recorded: 2, skipped: 1, duplicate: 0 },
    arms: {
      local: { pulls: 2, verified: 2, totalElapsedMs: 340, totalUsd: 0, meanReward: 0.9, ucb: 1.4 },
      docker: { pulls: 0, verified: 0, totalElapsedMs: 0, totalUsd: 0, meanReward: 0, ucb: null },
    },
    recent: [
      { type: "recorded", at: 10, taskId: "t1", backend: "local" },
      {
        type: "recorded",
        at: 20,
        taskId: "t2",
        backend: "local",
        detail: { usdNote: 'no dispatch-time accruedUsd baseline for backend "local" on task "t2"; usd defaulted to 0 (never guessed)' },
      },
    ],
  };
}

function statusView(overrides: Partial<LearningStatusView> = {}): LearningStatusView {
  return {
    attached: true,
    source: "live",
    savedAt: null,
    counts: { recorded: 2, skipped: 1, duplicate: 0 },
    arms: [
      { name: "docker", pulls: 0, verified: 0, meanReward: null, ucb: null },
      { name: "local", pulls: 2, verified: 2, meanReward: 0.9, ucb: 1.4 },
    ],
    recentNotes: [],
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function fakeBridge() {
  const sent: Command[] = [];
  const listeners = new Set<(e: AppEvent) => void>();
  const bridge: Bridge = {
    send(cmd) {
      sent.push(cmd);
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async start() {},
    async stop() {},
  };
  return {
    bridge,
    sent,
    push(e: AppEvent) {
      for (const cb of listeners) cb(e);
    },
  };
}

// ---------------------------------------------------------------------------
// contract merge
// ---------------------------------------------------------------------------

describe("IPC contract carries learning traffic", () => {
  it("round-trips learning.get through the main command codec", () => {
    const cmd: Command = { kind: "learning.get" };
    expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
  });

  it("round-trips learning.status and learning.error through the main event codec", () => {
    const status: AppEvent = { kind: "learning.status", status: statusView() };
    expect(decodeEvent(encodeEvent(status))).toEqual(status);
    const err: AppEvent = { kind: "learning.error", message: "no learning status available", at: 7 };
    expect(decodeEvent(encodeEvent(err))).toEqual(err);
  });

  it("still rejects unknown kinds and malformed learning payloads", () => {
    expect(() => decodeCommand(JSON.stringify({ kind: "learning.bogus" }))).toThrow(/bad command/);
    expect(() => decodeEvent(JSON.stringify({ kind: "learning.status", status: "nope" }))).toThrow(/bad event/);
    // A string-typed meanReward (JSON can't smuggle NaN — it serializes to
    // null, which IS the honest no-data wire value) is rejected:
    expect(() =>
      decodeEvent(
        JSON.stringify({
          kind: "learning.status",
          status: statusView({
            arms: [{ name: "x", pulls: 1, verified: 1, meanReward: "0.9" as unknown as number, ucb: null }],
          }),
        })
      )
    ).toThrow(/bad event/);
  });
});

// ---------------------------------------------------------------------------
// app-store pass-through
// ---------------------------------------------------------------------------

describe("app-store treats learning events as owned by the learning card", () => {
  it("learning.status / learning.error leave the swarm app state untouched", () => {
    const s0 = initialState();
    expect(reduce(s0, { kind: "learning.status", status: statusView() })).toBe(s0);
    expect(reduce(s0, { kind: "learning.error", message: "x", at: 1 })).toBe(s0);
  });
});

// ---------------------------------------------------------------------------
// sidecar delegation
// ---------------------------------------------------------------------------

describe("Sidecar learning.get delegation", () => {
  it("without a handler, replies with an honest learning.error (never silence)", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }), emit: (e) => events.push(e), now: () => 99 });
    await sidecar.handle({ kind: "learning.get" });
    expect(events).toEqual([
      { kind: "learning.error", message: "learning status is not configured in this build", at: 99 },
    ]);
  });

  it("delegates to a real LearningService over a live source and emits exactly one learning.status", async () => {
    const service = new LearningService({ source: { status: () => engineStatus() }, now: () => 123 });
    const handler: LearningStatusHandler = service;
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }), emit: (e) => events.push(e), learningStatus: handler });
    await sidecar.handle({ kind: "learning.get" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.kind !== "learning.status") throw new Error(`expected learning.status, got ${ev.kind}`);
    expect(ev.status.source).toBe("live");
    expect(ev.status.savedAt).toBeNull();
    expect(ev.status.at).toBe(123);
    // The projection's honesty rule survived the trip: the engine's stored
    // meanReward 0 for the never-pulled docker arm was NOT forwarded.
    const docker = ev.status.arms.find((a) => a.name === "docker");
    expect(docker).toEqual({ name: "docker", pulls: 0, verified: 0, meanReward: null, ucb: null });
    // The wire event survives the real codec round trip.
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it("a throwing handler is caught by the sidecar's own guard (a log line, not a crash)", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
      emit: (e) => events.push(e),
      now: () => 7,
      learningStatus: {
        handle: async () => {
          throw new Error("poisoned handler");
        },
      },
    });
    await sidecar.handle({ kind: "learning.get" });
    expect(events).toEqual([{ kind: "log", line: "sidecar error: poisoned handler", at: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// durable round trip: store on disk -> LearningService -> sidecar -> renderer
// ---------------------------------------------------------------------------

describe("durable snapshot round trip (real files, real store)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hades-learning-int-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a status persisted by one store instance is served as source:snapshot through the whole pipe", async () => {
    // Persist with one instance (the "previous process")...
    const writer = new FileLearningStatusStore({ path: join(dir, "learning-status.json"), now: () => 555 });
    const saved = await writer.save(engineStatus());
    expect(saved).toEqual({ saved: true });

    // ...serve with a FRESH instance behind a real LearningService (no live
    // loop), through the real Sidecar, exactly like sidecar-entry wires it.
    const reader = new FileLearningStatusStore({ path: join(dir, "learning-status.json") });
    const service = new LearningService({
      loadPersisted: async () => {
        const persisted = await reader.load();
        return persisted ? { at: persisted.at, status: persisted.status } : undefined;
      },
      now: () => 999,
    });
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }), emit: (e) => events.push(e), learningStatus: service });
    await sidecar.handle({ kind: "learning.get" });

    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.kind !== "learning.status") throw new Error(`expected learning.status, got ${ev.kind}`);
    expect(ev.status.source).toBe("snapshot");
    expect(ev.status.savedAt).toBe(555);
    expect(ev.status.counts).toEqual({ recorded: 2, skipped: 1, duplicate: 0 });

    // Feed the event into the real renderer: the fleet view shows the card
    // with the honest snapshot badge, never a live claim.
    const { bridge, push } = fakeBridge();
    const app = createApp(bridge, { initialNav: "fleet" });
    push(ev);
    const html = app.html();
    expect(html).toContain("learning-badge--snapshot");
    expect(html).not.toContain("learning-badge--live");
    app.destroy();
  });

  it("an empty store yields the honest learning.error end to end", async () => {
    const reader = new FileLearningStatusStore({ path: join(dir, "never-written.json") });
    const service = new LearningService({
      loadPersisted: async () => {
        const persisted = await reader.load();
        return persisted ? { at: persisted.at, status: persisted.status } : undefined;
      },
      now: () => 1,
    });
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }), emit: (e) => events.push(e), learningStatus: service });
    await sidecar.handle({ kind: "learning.get" });
    expect(events).toEqual([{ kind: "learning.error", message: "no learning status available", at: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// renderer plumbing
// ---------------------------------------------------------------------------

describe("renderer learning plumbing", () => {
  it("entering the fleet nav requests both the fleet snapshot and the learning status", () => {
    const { bridge, sent } = fakeBridge();
    const app = createApp(bridge);
    app.setNav("fleet");
    expect(sent).toContainEqual({ kind: "fleet.list" });
    expect(sent).toContainEqual({ kind: "learning.get" });
    app.destroy();
  });

  it("renders the honest empty card before any event, then the live status, then keeps it on error", () => {
    const { bridge, push } = fakeBridge();
    const app = createApp(bridge, { initialNav: "fleet" });

    expect(app.html()).toContain("No learning data yet");

    push({ kind: "learning.status", status: statusView() });
    let html = app.html();
    expect(html).toContain("learning-badge--live");
    expect(html).toContain("never pulled"); // docker: 0 pulls, no fabricated 0.00
    expect(html).toContain("0.90"); // local's real measured mean reward

    // A later failed refresh keeps the last-known status and shows the error.
    push({ kind: "learning.error", message: "sidecar went away", at: 5 });
    html = app.html();
    expect(html).toContain("learning-badge--live");
    expect(html).toContain("sidecar went away");
    app.destroy();
  });

  it("escapes a hostile arm name all the way through the fleet-view HTML", () => {
    const { bridge, push } = fakeBridge();
    const app = createApp(bridge, { initialNav: "fleet" });
    push({
      kind: "learning.status",
      status: statusView({
        arms: [{ name: '<img src=x onerror=alert(1)>', pulls: 1, verified: 1, meanReward: 0.5, ucb: 0.6 }],
      }),
    });
    const html = app.html();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    app.destroy();
  });
});
