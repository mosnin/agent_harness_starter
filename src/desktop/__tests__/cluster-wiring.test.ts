/**
 * The desktop `cluster.*` lane, end to end: contract codec -> `Sidecar`
 * routing -> `ClusterService` over the REAL multi-node fabric -> `app-store`
 * reducer.
 *
 * This suite is written to fail loudly if the lane is fake:
 *  - a `cluster.*` command must survive the real `encodeCommand`/`decodeCommand`
 *    round trip and be recognized by the merged `isCommand` union (a lane that
 *    does not is unreachable from the renderer);
 *  - a `Sidecar` with NO cluster handler must emit an honest `cluster.error`,
 *    never a synthesized empty status a renderer would read as "every node is
 *    healthy";
 *  - `ClusterService` must report numbers produced by REALLY building a fabric
 *    (real SWIM membership, real inline `SwarmManager`s behind the real
 *    verification gate, real ed25519 certificates) and running real tasks
 *    through it — a `cluster.run` that verifies nothing must come back
 *    `complete: false`, never a fabricated success;
 *  - the renderer-supplied sizes must be CLAMPED server-side;
 *  - a failure inside the fabric must surface as `cluster.error` carrying the
 *    real reason, and must not poison the next request.
 *
 * These tests really do execute swarm work, so they use the smallest fabric
 * that still exercises the multi-node path (2 nodes x 1 worker) and generous
 * real-clock timeouts.
 */

import { describe, expect, it, vi } from "vitest";

import {
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isAppEvent,
  isClusterRunWire,
  isCommand,
  type AppEvent,
  type Command,
} from "../ipc/contract";
import { Sidecar, type SwarmFactory, type SwarmHandle } from "../core/sidecar";
import { ClusterService } from "../core/cluster-service";
import { initialState, reduce } from "../core/app-store";
import {
  buildClusterFabric,
  type ClusterFabric,
  type ClusterFabricOptions,
} from "../../swarm-runtime/distributed/cluster-chaos";

const NOW = 1_700_000_000_000;

const factory: SwarmFactory = () =>
  ({
    start: async () => {},
    stop: async () => {},
    snapshot: () => ({ workers: [], tasks: [], goals: [], verifications: [], metrics: null }),
    on: () => () => {},
    dispatch: async () => {},
  }) as unknown as SwarmHandle;

/** A tiny real fabric: still a genuine multi-node topology (2 compute nodes +
 *  the controller, full mesh of real signed links), just the smallest one. */
function tinyService(overrides: Partial<ConstructorParameters<typeof ClusterService>[0]> = {}): ClusterService {
  return new ClusterService({
    now: () => NOW,
    maxNodes: 2,
    maxTasks: 2,
    maxWorkersPerNode: 1,
    runTimeoutMs: 20_000,
    ...overrides,
  });
}

describe("cluster lane — codec reachability", () => {
  it("every cluster command survives the real codec and the merged isCommand union", () => {
    const cmds: Command[] = [
      { kind: "cluster.status", nodes: 2 },
      { kind: "cluster.nodes", nodes: 2, workersPerNode: 1 },
      { kind: "cluster.run", nodes: 2, tasks: 2, workersPerNode: 1 },
      { kind: "cluster.chaos", nodes: 2, tasks: 2, workersPerNode: 1, seed: 3, density: 0.4 },
    ];
    for (const c of cmds) {
      expect(isCommand(c)).toBe(true);
      expect(decodeCommand(encodeCommand(c))).toEqual(c);
    }
  });
});

describe("cluster lane — Sidecar routing", () => {
  it("with NO cluster handler, a cluster command yields an honest cluster.error — never a fake healthy status", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({ factory, emit: (e) => events.push(e), now: () => NOW });
    await sidecar.handle({ kind: "cluster.status" });
    expect(events).toEqual([
      {
        kind: "cluster.error",
        op: "cluster.status",
        message: "the multi-node cluster layer is not configured in this build",
        at: NOW,
      },
    ]);
  });

  it("routes every cluster kind to the configured handler and emits its reply verbatim", async () => {
    const seen: string[] = [];
    const handler = {
      handle: vi.fn(async (cmd: { kind: string }) => {
        seen.push(cmd.kind);
        return { kind: "cluster.error", op: cmd.kind, message: "handled", at: NOW } as AppEvent;
      }),
    };
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory,
      emit: (e) => events.push(e),
      now: () => NOW,
      cluster: handler as never,
    });

    await sidecar.handle({ kind: "cluster.status" });
    await sidecar.handle({ kind: "cluster.nodes" });
    await sidecar.handle({ kind: "cluster.run", nodes: 2, tasks: 1 });
    await sidecar.handle({ kind: "cluster.chaos", nodes: 2, tasks: 1, seed: 1 });

    expect(seen).toEqual(["cluster.status", "cluster.nodes", "cluster.run", "cluster.chaos"]);
    expect(events).toHaveLength(4);
  });
});

describe("ClusterService over the REAL fabric", () => {
  it("cluster.nodes reports real per-node snapshots from a really-built fabric", async () => {
    const ev = await tinyService().handle({ kind: "cluster.nodes", nodes: 2, workersPerNode: 1 });
    expect(ev.kind).toBe("cluster.nodes");
    if (ev.kind !== "cluster.nodes") throw new Error("unreachable");

    expect(ev.nodes.map((n) => n.nodeId)).toEqual(["node-0", "node-1"]);
    for (const n of ev.nodes) {
      expect(n.health).toBe("alive");
      // Real inline worker pools were really started: workerCount() is not 0.
      expect(n.liveWorkers).toBeGreaterThan(0);
      expect(n.inFlight).toBe(0);
      expect(Number.isFinite(n.load)).toBe(true);
    }
    // The event must be valid on the merged union, i.e. actually deliverable.
    expect(isAppEvent(ev)).toBe(true);
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  }, 60_000);

  it("cluster.status carries mode/ephemeral and real federation peer counts", async () => {
    const ev = await tinyService().handle({ kind: "cluster.status", nodes: 2, workersPerNode: 1 });
    expect(ev.kind).toBe("cluster.status");
    if (ev.kind !== "cluster.status") throw new Error("unreachable");

    expect(ev.status.mode).toBe("measured");
    expect(ev.status.ephemeral).toBe(true);
    expect(ev.status.nodes).toBe(2);
    // A full mesh of 3 participants means every node router really handshook
    // with 2 peers (the other node + the controller).
    expect(ev.status.peersReady).toHaveLength(2);
    for (const ready of ev.status.peersReady) expect(ready).toBe(2);
  }, 60_000);

  it("cluster.run really executes tasks and reports a complete, certified run", async () => {
    const ev = await tinyService().handle({ kind: "cluster.run", nodes: 2, tasks: 2, workersPerNode: 1 });
    expect(ev.kind).toBe("cluster.run");
    if (ev.kind !== "cluster.run") throw new Error("unreachable");

    expect(isClusterRunWire(ev.run)).toBe(true);
    expect(ev.run.tasksSubmitted).toBe(2);
    expect(ev.run.tasksVerified).toBe(2);
    expect(ev.run.tasksFailed).toBe(0);
    expect(ev.run.complete).toBe(true);
    // Every verified task was certified, and every certificate independently
    // re-verified against the exact bytes it claims to bind.
    expect(ev.run.certificatesValid).toBe(2);
    expect(ev.run.certificatesInvalid).toBe(0);
    expect(ev.run.duplicateVerifications).toBe(0);
    // A real wall clock, not a constant.
    expect(ev.run.makespanMs).toBeGreaterThan(0);
    expect(ev.run.faults).toEqual([]);
    expect(ev.run.seed).toBeNull();
  }, 90_000);

  it("clamps renderer-supplied sizes server-side — a 500-node request cannot wedge the machine", async () => {
    const built: ClusterFabricOptions[] = [];
    const service = tinyService({
      buildFabric: (async (opts: ClusterFabricOptions): Promise<ClusterFabric> => {
        built.push(opts);
        return buildClusterFabric(opts);
      }) as typeof buildClusterFabric,
    });

    await service.handle({ kind: "cluster.run", nodes: 500, tasks: 5000, workersPerNode: 64 });
    expect(built).toHaveLength(1);
    expect(built[0].nodes).toBe(2); // maxNodes
    expect(built[0].workersPerNode).toBe(1); // maxWorkersPerNode
  }, 90_000);

  it("a fabric that fails to build surfaces the REAL reason as cluster.error, and does not poison the next request", async () => {
    let calls = 0;
    const service = tinyService({
      buildFabric: (async (opts: ClusterFabricOptions): Promise<ClusterFabric> => {
        calls += 1;
        if (calls === 1) throw new Error("no ed25519 backend available on this host");
        return buildClusterFabric(opts);
      }) as typeof buildClusterFabric,
    });

    const bad = await service.handle({ kind: "cluster.nodes", nodes: 2 });
    expect(bad).toEqual({
      kind: "cluster.error",
      op: "cluster.nodes",
      message: "no ed25519 backend available on this host",
      at: NOW,
    });

    // The internal queue must not stay rejected for every later request.
    const good = await service.handle({ kind: "cluster.nodes", nodes: 2, workersPerNode: 1 });
    expect(good.kind).toBe("cluster.nodes");
  }, 90_000);

  it("serializes concurrent requests so two fabrics never run at once (measured wall clocks stay meaningful)", async () => {
    let live = 0;
    let maxLive = 0;
    const service = tinyService({
      buildFabric: (async (opts: ClusterFabricOptions): Promise<ClusterFabric> => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        const fabric = await buildClusterFabric(opts);
        const realShutdown = fabric.shutdown;
        return {
          ...fabric,
          shutdown: async () => {
            live -= 1;
            await realShutdown.call(fabric);
          },
        };
      }) as typeof buildClusterFabric,
    });

    await Promise.all([
      service.handle({ kind: "cluster.nodes", nodes: 2, workersPerNode: 1 }),
      service.handle({ kind: "cluster.nodes", nodes: 2, workersPerNode: 1 }),
      service.handle({ kind: "cluster.status", nodes: 2, workersPerNode: 1 }),
    ]);

    expect(maxLive).toBe(1);
  }, 120_000);
});

describe("cluster events in the app-store reducer", () => {
  it("are rendered directly and deliberately never fold an ephemeral fabric into the local swarm state", () => {
    const before = initialState();
    const run = {
      mode: "measured" as const,
      ephemeral: true as const,
      nodes: 3,
      tasksSubmitted: 6,
      tasksVerified: 6,
      tasksFailed: 0,
      duplicateVerifications: 0,
      reassignments: 0,
      conflicts: 0,
      certificatesValid: 6,
      certificatesInvalid: 0,
      makespanMs: 500,
      verifiedPerSec: 12,
      complete: true,
      faults: [],
      seed: null,
    };
    const evs: AppEvent[] = [
      { kind: "cluster.status", status: { mode: "measured", ephemeral: true, nodes: 3, workersPerNode: 2, total: 0, pending: 0, leased: 0, verified: 0, failed: 0, reassignments: 0, staleReportsRejected: 0, conflicts: 0, peersReady: [3, 3, 3] }, at: 1 },
      { kind: "cluster.nodes", nodes: [], at: 2 },
      { kind: "cluster.run", run, at: 3 },
      { kind: "cluster.chaos", run, at: 4 },
      { kind: "cluster.error", op: "cluster.run", message: "x", at: 5 },
    ];
    let state = before;
    for (const ev of evs) state = reduce(state, ev);

    // Referentially unchanged: no cluster event may claim a worker or a task
    // in the main view that no longer exists.
    expect(state).toBe(before);
    expect(state.workers).toEqual([]);
    expect(state.running).toBe(false);
  });
});
