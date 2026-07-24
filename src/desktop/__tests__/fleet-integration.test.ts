/**
 * Central-integration tests for the desktop fleet surface: the fleet wire
 * format merged into the main IPC contract, the sidecar's fleet delegation,
 * the shell's fleet nav + intent mapping, the renderer's fleet state
 * plumbing, and `fleet-wiring.ts`'s real `BackendManager`/`FleetSupervisor`
 * stack behind a `FleetService`.
 *
 * Real components everywhere: the real codecs, the real `Sidecar`, the real
 * reducer/renderers, the real `FleetService` over the real `BackendManager`
 * with the real `LocalProcessBackend`/`DockerBackend` registered (their
 * availability is never assumed — nothing here probes). The only fakes are a
 * scripted `SwarmHandle` (so no worker pool spins up) and an array-backed
 * event sink.
 */
import { describe, expect, it } from "vitest";
import {
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isCommand,
  isAppEvent,
} from "../ipc/contract";
import type { AppEvent, Command, FleetEvent, BackendView, FleetWorkerView } from "../ipc/contract";
import { initialState, reduce } from "../core/app-store";
import { Sidecar, type FleetHandler } from "../core/sidecar";
import { intentToCommand, NAV } from "../ui/shell";
import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/bridge";
import { createRealFleet } from "../core/fleet-wiring";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function backendView(overrides: Partial<BackendView> = {}): BackendView {
  return {
    name: "local",
    kind: "local",
    capabilities: ["shell"],
    locality: "local",
    supportsHibernate: true,
    available: null,
    cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
    telemetry: {
      provisions: 0,
      failures: 0,
      provisionLatencyEmaMs: null,
      runningMs: 0,
      hibernatedMs: 0,
      accruedUsd: 0,
    },
    ...overrides,
  };
}

function workerView(overrides: Partial<FleetWorkerView> = {}): FleetWorkerView {
  return {
    workerId: "w1",
    backend: "local",
    nativeId: "pid-123",
    state: "running",
    startedAt: 1_700_000_000_000,
    idleMs: 0,
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

describe("IPC contract carries fleet traffic", () => {
  const fleetCommands: Command[] = [
    { kind: "fleet.list" },
    { kind: "fleet.probe" },
    { kind: "fleet.hibernate", workerId: "w1" },
    { kind: "fleet.wake", workerId: "w1" },
    { kind: "fleet.terminate", workerId: "w1" },
  ];

  it.each(fleetCommands.map((c) => [c.kind, c] as const))("round-trips %s through the main codec", (_kind, cmd) => {
    expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
  });

  it("round-trips fleet events through the main event codec", () => {
    const snapshot: AppEvent = {
      kind: "fleet.snapshot",
      backends: [backendView()],
      workers: [workerView()],
      at: 42,
    };
    expect(decodeEvent(encodeEvent(snapshot))).toEqual(snapshot);
    const err: AppEvent = { kind: "fleet.error", message: "boom", workerId: "w1", at: 43 };
    expect(decodeEvent(encodeEvent(err))).toEqual(err);
  });

  it("still rejects unknown kinds and malformed fleet payloads", () => {
    expect(() => decodeCommand(JSON.stringify({ kind: "fleet.bogus" }))).toThrow(/bad command/);
    expect(() => decodeCommand(JSON.stringify({ kind: "fleet.hibernate" }))).toThrow(/bad command/);
    expect(() => decodeEvent(JSON.stringify({ kind: "fleet.snapshot", backends: "x", workers: [], at: 1 }))).toThrow(
      /bad event/,
    );
    expect(isCommand({ kind: "fleet.wake", workerId: 7 })).toBe(false);
    expect(isAppEvent({ kind: "fleet.error", message: "m" })).toBe(false); // missing at
  });

  it("app-store reduce passes fleet events through without touching swarm state", () => {
    const s0 = initialState();
    const s1 = reduce(s0, { kind: "fleet.worker.upsert", worker: workerView() });
    expect(s1).toBe(s0); // identity: fleet state is owned by the fleet reducer
  });
});

// ---------------------------------------------------------------------------
// sidecar delegation
// ---------------------------------------------------------------------------

describe("Sidecar fleet delegation", () => {
  it("hands fleet commands to the configured handler and emits every event it returns", async () => {
    const emitted: AppEvent[] = [];
    const handled: string[] = [];
    const fleet: FleetHandler = {
      async handle(cmd) {
        handled.push(cmd.kind);
        const events: FleetEvent[] = [
          { kind: "fleet.snapshot", backends: [backendView()], workers: [], at: 1 },
        ];
        return events;
      },
    };
    const sidecar = new Sidecar({ emit: (e) => emitted.push(e), fleet, now: () => 99 });
    await sidecar.handle({ kind: "fleet.list" });
    expect(handled).toEqual(["fleet.list"]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe("fleet.snapshot");
  });

  it("without a handler, replies with an honest fleet.error instead of silence", async () => {
    const emitted: AppEvent[] = [];
    const sidecar = new Sidecar({ emit: (e) => emitted.push(e), now: () => 7 });
    await sidecar.handle({ kind: "fleet.probe" });
    expect(emitted).toEqual([
      { kind: "fleet.error", message: "fleet is not configured in this build", at: 7 },
    ]);
  });

  it("a throwing fleet handler becomes a log event, never an exception", async () => {
    const emitted: AppEvent[] = [];
    const fleet: FleetHandler = {
      async handle() {
        throw new Error("port exploded");
      },
    };
    const sidecar = new Sidecar({ emit: (e) => emitted.push(e), fleet, now: () => 1 });
    await sidecar.handle({ kind: "fleet.wake", workerId: "w1" });
    expect(emitted).toEqual([{ kind: "log", line: "sidecar error: port exploded", at: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// shell nav + intents
// ---------------------------------------------------------------------------

describe("shell fleet nav + intent mapping", () => {
  it("the sidebar NAV includes the fleet surface", () => {
    expect(NAV.some((n) => n.key === "fleet")).toBe(true);
  });

  it("maps fleet intents to typed wire commands", () => {
    expect(intentToCommand({ cmd: "fleet.refresh" })).toEqual({ kind: "fleet.list" });
    expect(intentToCommand({ cmd: "fleet.probe" })).toEqual({ kind: "fleet.probe" });
    expect(intentToCommand({ cmd: "fleet.hibernate", value: "w1" })).toEqual({
      kind: "fleet.hibernate",
      workerId: "w1",
    });
    expect(intentToCommand({ cmd: "fleet.wake", value: "w2" })).toEqual({ kind: "fleet.wake", workerId: "w2" });
    expect(intentToCommand({ cmd: "fleet.terminate", value: "w3" })).toEqual({
      kind: "fleet.terminate",
      workerId: "w3",
    });
  });

  it("worker actions without a workerId map to null (never a malformed command)", () => {
    expect(intentToCommand({ cmd: "fleet.hibernate" })).toBeNull();
    expect(intentToCommand({ cmd: "fleet.wake" })).toBeNull();
    expect(intentToCommand({ cmd: "fleet.terminate" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderer plumbing
// ---------------------------------------------------------------------------

describe("renderer fleet plumbing", () => {
  it("entering the fleet nav requests a fresh probe-free snapshot", () => {
    const { bridge, sent } = fakeBridge();
    const app = createApp(bridge);
    app.setNav("fleet");
    expect(sent).toContainEqual({ kind: "fleet.list" });
    app.destroy();
  });

  it("fleet.snapshot events land in the fleet view, independent of swarm state", () => {
    const { bridge, push } = fakeBridge();
    const app = createApp(bridge, { initialNav: "fleet" });
    push({
      kind: "fleet.snapshot",
      backends: [backendView({ name: "dockerish" })],
      workers: [workerView({ workerId: "w-render" })],
      at: 5,
    });
    const html = app.html();
    expect(html).toContain("dockerish");
    expect(html).toContain("w-render");
    // Swarm app state untouched by fleet traffic.
    expect(app.getState()).toEqual(initialState());
    app.destroy();
  });

  it("fleet.error renders the banner while keeping the last snapshot", () => {
    const { bridge, push } = fakeBridge();
    const app = createApp(bridge, { initialNav: "fleet" });
    push({ kind: "fleet.snapshot", backends: [backendView({ name: "keepme" })], workers: [], at: 5 });
    push({ kind: "fleet.error", message: "hibernate blew up", workerId: "w9", at: 6 });
    const html = app.html();
    expect(html).toContain("hibernate blew up");
    expect(html).toContain("keepme");
    app.destroy();
  });
});

// ---------------------------------------------------------------------------
// fleet-wiring: the real stack
// ---------------------------------------------------------------------------

describe("createRealFleet (real BackendManager + FleetSupervisor + FleetService)", () => {
  it("fleet.list snapshots the real local+docker inventory without probing", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 123 });
    const events = await fleet.service.handle({ kind: "fleet.list" });
    expect(events).toHaveLength(1);
    const snap = events[0];
    if (snap.kind !== "fleet.snapshot") throw new Error(`expected snapshot, got ${snap.kind}`);
    const names = snap.backends.map((b) => b.name).sort();
    expect(names).toEqual(["docker", "local"]);
    for (const b of snap.backends) {
      expect(b.available).toBeNull(); // list never probes
      expect(b.cost.source).toBe("configured");
      expect(b.cost.perRunningHourUsd).toBe(0); // your own machine, no fabricated price
      expect(b.telemetry.provisionLatencyEmaMs).toBeNull(); // no samples yet, never 0
    }
    expect(snap.workers).toEqual([]);
    // Every event survives the real wire codec.
    expect(decodeEvent(encodeEvent(snap))).toEqual(snap);
  });

  it("mutating an unknown worker yields a fleet.error, and the real manager saw no mutation", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 1 });
    const events = await fleet.service.handle({ kind: "fleet.hibernate", workerId: "ghost" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "fleet.error", workerId: "ghost" });
    expect(fleet.manager.registry.list()).toEqual([]);
    expect(fleet.supervisor.lifecycle("ghost")).toBeUndefined();
  });

  it("restore() with no persistence configured is a safe no-op", async () => {
    const fleet = createRealFleet({ persist: false });
    await expect(fleet.restore()).resolves.toBeUndefined();
  });

  it("manager lifecycle events land in the real provenance ledger and the chain verifies", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 10 });
    // Registration alone already appended two "registered" records.
    expect(fleet.ledger.records().length).toBe(2);
    // A probe appends one real "probe" record per backend.
    await fleet.service.handle({ kind: "fleet.probe" });
    expect(fleet.ledger.records().length).toBe(4);
    const verdict = fleet.ledger.verifyChain();
    expect(verdict.ok).toBe(true);
  });
});
