/**
 * Central-integration tests for the fleet-provision surface: the provision
 * wire format merged into the main IPC contract, the sidecar's
 * `fleet.provision` delegation + honest fallback + startup restored
 * snapshot, `fleet-wiring.ts`'s real bandit-routed provision port, and the
 * renderer's provision-panel host plumbing.
 *
 * Real components everywhere: the real codecs, the real `Sidecar`, the real
 * `createRealFleet` stack (BackendManager + FleetSupervisor + lazy
 * CostAwareRouteBandit/BanditRoutedProvisioner + FleetProvisionService).
 * The only fakes are a scripted `SwarmHandle` (so no worker pool spins up)
 * and an array-backed event sink. No test here provisions a real OS process
 * — the end-to-end provision path is exercised through its honest failure
 * mode (requirements that exclude every registered backend), which walks
 * the full bandit -> fallback -> manager.select() pipeline for real.
 */
import { describe, expect, it } from "vitest";

import { decodeCommand, decodeEvent, encodeCommand, encodeEvent } from "../ipc/contract";
import type { AppEvent, Command, FleetProvisionEvent } from "../ipc/contract";
import { Sidecar, type FleetProvisionHandler, type SwarmHandle } from "../core/sidecar";
import { createRealFleet } from "../core/fleet-wiring";
import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/bridge";
import { initialState, reduce } from "../core/app-store";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function scriptedSwarmHandle(): SwarmHandle {
  return {
    dispatchGoal: () => ({ goalId: "g1" }),
    snapshot: () => ({ workers: [], tasks: [] }),
  };
}

function makeSidecar(opts: { provision?: FleetProvisionHandler } = {}) {
  const events: AppEvent[] = [];
  const sidecar = new Sidecar({
    factory: () => scriptedSwarmHandle(),
    emit: (e) => events.push(e),
    now: () => 1000,
    ...(opts.provision ? { provision: opts.provision } : {}),
  });
  return { sidecar, events };
}

const PROVISION_CMD: Command = {
  kind: "fleet.provision",
  requestId: "req-1",
  spec: { workerId: "w1", capabilities: ["shell"] },
};

// ---------------------------------------------------------------------------
// IPC contract merge
// ---------------------------------------------------------------------------

describe("IPC contract carries the fleet-provision wire format", () => {
  it("round-trips a fleet.provision command through the main codecs", () => {
    const line = encodeCommand(PROVISION_CMD);
    expect(decodeCommand(line)).toEqual(PROVISION_CMD);
  });

  it("round-trips fleet.provisioned / fleet.provision.error / fleet.restored events", () => {
    const events: AppEvent[] = [
      {
        kind: "fleet.provisioned",
        requestId: "req-1",
        worker: { workerId: "w1", backend: "local", nativeId: "n1", state: "running", startedAt: 1, idleMs: 0 },
        backend: "local",
        routing: { source: "bandit", reason: "ucb-best" },
        at: 2,
      },
      { kind: "fleet.provision.error", requestId: "req-1", message: "no backend available", at: 3 },
      { kind: "fleet.restored", workers: [], adoptedIds: [], dropped: [{ workerId: "w9", reason: "unknown backend: gone" }], at: 4 },
    ];
    for (const ev of events) {
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });

  it("rejects a malformed fleet.provision command (empty workerId) with the house phrasing", () => {
    const bad = JSON.stringify({ kind: "fleet.provision", requestId: "r", spec: { workerId: "", capabilities: [] } });
    expect(() => decodeCommand(bad)).toThrow(/missing or invalid fields for kind "fleet.provision"/);
  });

  it("the app-store reducer passes provision events through without touching swarm state", () => {
    const state = initialState();
    const ev: AppEvent = { kind: "fleet.provision.error", requestId: "r", message: "m", at: 1 };
    expect(reduce(state, ev)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Sidecar delegation
// ---------------------------------------------------------------------------

describe("Sidecar fleet.provision routing", () => {
  it("without a provision handler, replies with an honest fleet.provision.error echoing the requestId", async () => {
    const { sidecar, events } = makeSidecar();
    await sidecar.handle(PROVISION_CMD);
    expect(events).toEqual([
      {
        kind: "fleet.provision.error",
        requestId: "req-1",
        message: "fleet provisioning is not configured in this build",
        at: 1000,
      },
    ]);
  });

  it("with a provision handler, forwards every event the handler returns", async () => {
    const handled: Command[] = [];
    const provision: FleetProvisionHandler = {
      async handle(cmd) {
        handled.push(cmd);
        return [{ kind: "fleet.provision.error", requestId: cmd.requestId, message: "port says no", at: 5 }];
      },
      async restoredSnapshot() {
        return undefined;
      },
    };
    const { sidecar, events } = makeSidecar({ provision });
    await sidecar.handle(PROVISION_CMD);
    expect(handled).toEqual([PROVISION_CMD]);
    expect(events).toEqual([{ kind: "fleet.provision.error", requestId: "req-1", message: "port says no", at: 5 }]);
  });

  it("emits the restored snapshot once on runtime.start when a restore actually ran", async () => {
    const restored: FleetProvisionEvent = {
      kind: "fleet.restored",
      workers: [{ workerId: "w1", backend: "local", nativeId: "n1", state: "running", startedAt: 1, idleMs: 0 }],
      adoptedIds: ["w1"],
      dropped: [],
      at: 7,
    };
    const provision: FleetProvisionHandler = {
      async handle() {
        return [];
      },
      async restoredSnapshot() {
        return restored;
      },
    };
    const { sidecar, events } = makeSidecar({ provision });
    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    expect(events.filter((e) => e.kind === "fleet.restored")).toEqual([restored]);
  });

  it("emits NO restored event when no restore ran (undefined snapshot — never a fabricated empty restore)", async () => {
    const provision: FleetProvisionHandler = {
      async handle() {
        return [];
      },
      async restoredSnapshot() {
        return undefined;
      },
    };
    const { sidecar, events } = makeSidecar({ provision });
    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    expect(events.some((e) => e.kind === "fleet.restored")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createRealFleet — the real provision port behind FleetProvisionService
// ---------------------------------------------------------------------------

describe("createRealFleet provision wiring (real bandit -> manager pipeline)", () => {
  it("restoredSnapshot() is honestly undefined before any restore has run", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 0 });
    await expect(fleet.provision.restoredSnapshot()).resolves.toBeUndefined();
  });

  it("a provision whose requirements exclude every backend resolves to one honest fleet.provision.error", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 0 });
    const events = await fleet.provision.handle({
      kind: "fleet.provision",
      requestId: "req-x",
      spec: { workerId: "w-none", capabilities: [] },
      requirements: { exclude: ["local", "docker"] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "fleet.provision.error", requestId: "req-x" });
    // Nothing was tracked: the worker never came into existence.
    expect(fleet.manager.registry.handle("w-none")).toBeUndefined();
  });

  it("a duplicate workerId is rejected before the port is ever asked to provision", async () => {
    const fleet = createRealFleet({ persist: false, now: () => 0 });
    // Adopt a handle directly into the real registry so the id is tracked.
    fleet.manager.registry.adopt({ workerId: "w-dup", backend: "local", nativeId: "n", state: "running", startedAt: 0 });
    const events = await fleet.provision.handle({
      kind: "fleet.provision",
      requestId: "req-dup",
      spec: { workerId: "w-dup", capabilities: [] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "fleet.provision.error",
      requestId: "req-dup",
      message: 'worker already tracked: "w-dup"',
    });
  });
});

// ---------------------------------------------------------------------------
// Renderer plumbing
// ---------------------------------------------------------------------------

describe("renderer fleet surface hosts the provision panel", () => {
  it("the fleet nav content renders the stable provision host node", () => {
    const bridge: Bridge = {
      send() {},
      onEvent() {
        return () => {};
      },
      async start() {},
      async stop() {},
    };
    const app = createApp(bridge, { initialNav: "fleet" });
    expect(app.html()).toContain('id="fleet-provision-host"');
    app.destroy();
  });
});
