import { describe, it, expect } from "vitest";
import {
  encodeCommand,
  decodeCommand,
  encodeEvent,
  decodeEvent,
  isCommand,
  isAppEvent,
} from "../ipc/contract";
import {
  CLUSTER_COMMAND_KINDS,
  CLUSTER_EVENT_KINDS,
  isClusterCommand,
  isClusterEvent,
  isClusterFaultWire,
  isClusterNodeWire,
  isClusterRunWire,
  isClusterStatusWire,
  type ClusterCommand,
  type ClusterEvent,
  type ClusterNodeWire,
  type ClusterRunWire,
  type ClusterStatusWire,
} from "../ipc/cluster-contract";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const node: ClusterNodeWire = {
  nodeId: "node-0",
  health: "alive",
  inFlight: 1,
  liveWorkers: 2,
  load: 0.5,
  completed: 3,
  handedBack: 0,
  abandoned: 0,
  epoch: 4,
  leaderId: "controller",
};

const status: ClusterStatusWire = {
  mode: "measured",
  ephemeral: true,
  nodes: 3,
  workersPerNode: 2,
  total: 6,
  pending: 0,
  leased: 0,
  verified: 6,
  failed: 0,
  reassignments: 1,
  staleReportsRejected: 0,
  conflicts: 0,
  peersReady: [3, 3, 3],
};

const run: ClusterRunWire = {
  mode: "measured",
  ephemeral: true,
  nodes: 3,
  tasksSubmitted: 6,
  tasksVerified: 6,
  tasksFailed: 0,
  duplicateVerifications: 0,
  reassignments: 2,
  conflicts: 0,
  certificatesValid: 6,
  certificatesInvalid: 0,
  makespanMs: 812,
  verifiedPerSec: 7.39,
  complete: true,
  faults: [{ at: 120, kind: "crash-node", target: "node-1", peer: null, detail: null }],
  seed: 7,
};

// ---------------------------------------------------------------------------

describe("cluster IPC contract — view-model guards", () => {
  it("accepts well-formed wires", () => {
    expect(isClusterNodeWire(node)).toBe(true);
    expect(isClusterStatusWire(status)).toBe(true);
    expect(isClusterRunWire(run)).toBe(true);
    expect(isClusterFaultWire(run.faults[0])).toBe(true);
  });

  it("accepts a null leaderId — a node that sees no quorum-backed leader", () => {
    expect(isClusterNodeWire({ ...node, leaderId: null })).toBe(true);
  });

  it("rejects a missing leaderId field rather than reading it as null", () => {
    const { leaderId: _drop, ...withoutLeader } = node;
    expect(isClusterNodeWire(withoutLeader)).toBe(false);
  });

  it("REFUSES a status that drops `mode`/`ephemeral` — the two fields that stop a renderer presenting an ephemeral fabric as a standing cluster", () => {
    const { mode: _m, ...noMode } = status;
    const { ephemeral: _e, ...noEphemeral } = status;
    expect(isClusterStatusWire(noMode)).toBe(false);
    expect(isClusterStatusWire(noEphemeral)).toBe(false);
    expect(isClusterStatusWire({ ...status, mode: "modeled" })).toBe(false);
    expect(isClusterStatusWire({ ...status, ephemeral: false })).toBe(false);
  });

  it("REFUSES a run that drops `complete` — a partial run must never arrive able to be drawn as finished", () => {
    const { complete: _c, ...noComplete } = run;
    expect(isClusterRunWire(noComplete)).toBe(false);
    expect(isClusterRunWire({ ...run, complete: "yes" })).toBe(false);
  });

  it("REFUSES a run that drops the two trust tallies", () => {
    const { certificatesInvalid: _ci, ...noCertInvalid } = run;
    const { duplicateVerifications: _dv, ...noDupes } = run;
    expect(isClusterRunWire(noCertInvalid)).toBe(false);
    expect(isClusterRunWire(noDupes)).toBe(false);
  });

  it("rejects NaN/Infinity, which JSON would silently turn into null and a reader into 'absent'", () => {
    expect(isClusterRunWire({ ...run, makespanMs: Number.NaN })).toBe(false);
    expect(isClusterRunWire({ ...run, verifiedPerSec: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isClusterNodeWire({ ...node, load: Number.NaN })).toBe(false);
  });

  it("rejects prototype-pollution keys on any payload crossing the process boundary", () => {
    const hostile = JSON.parse('{"nodeId":"n","health":"alive","inFlight":0,"liveWorkers":0,"load":0,"completed":0,"handedBack":0,"abandoned":0,"epoch":0,"leaderId":null,"__proto__":{"polluted":true}}');
    expect(isClusterNodeWire(hostile)).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a non-array peersReady and a peersReady containing a non-number", () => {
    expect(isClusterStatusWire({ ...status, peersReady: 3 })).toBe(false);
    expect(isClusterStatusWire({ ...status, peersReady: [1, "2"] })).toBe(false);
  });
});

describe("cluster IPC contract — command/event guards", () => {
  it("accepts every declared command kind, with and without optional fields", () => {
    const cmds: ClusterCommand[] = [
      { kind: "cluster.status" },
      { kind: "cluster.status", nodes: 3, workersPerNode: 2 },
      { kind: "cluster.nodes" },
      { kind: "cluster.run", nodes: 2, tasks: 4 },
      { kind: "cluster.chaos", nodes: 3, tasks: 6, seed: 11, density: 0.5 },
    ];
    for (const c of cmds) expect(isClusterCommand(c)).toBe(true);
  });

  it("rejects a non-numeric size, so a renderer cannot smuggle a string into a loop bound", () => {
    expect(isClusterCommand({ kind: "cluster.run", nodes: "3" })).toBe(false);
    expect(isClusterCommand({ kind: "cluster.chaos", density: "0.5" })).toBe(false);
    expect(isClusterCommand({ kind: "cluster.status", nodes: Number.NaN })).toBe(false);
  });

  it("has NO cluster.bench command — a renderer must not be able to monopolize the stdio pipe for a benchmark", () => {
    expect(isClusterCommand({ kind: "cluster.bench" })).toBe(false);
    expect((CLUSTER_COMMAND_KINDS as readonly string[]).includes("cluster.bench")).toBe(false);
  });

  it("accepts every declared event kind", () => {
    const evs: ClusterEvent[] = [
      { kind: "cluster.status", status, at: 1 },
      { kind: "cluster.nodes", nodes: [node], at: 2 },
      { kind: "cluster.run", run, at: 3 },
      { kind: "cluster.chaos", run: { ...run, seed: 42 }, at: 4 },
      { kind: "cluster.error", op: "cluster.run", message: "boom", at: 5 },
    ];
    for (const e of evs) expect(isClusterEvent(e)).toBe(true);
  });

  it("rejects an event whose payload is structurally wrong even though its kind is right", () => {
    expect(isClusterEvent({ kind: "cluster.status", status: { mode: "measured" }, at: 1 })).toBe(false);
    expect(isClusterEvent({ kind: "cluster.nodes", nodes: [{ nodeId: "x" }], at: 1 })).toBe(false);
    expect(isClusterEvent({ kind: "cluster.run", run: { ...run, complete: undefined }, at: 1 })).toBe(false);
  });
});

describe("cluster lane is merged into the whole-pipe Command/AppEvent unions", () => {
  it("every declared cluster kind is accepted by the composed codec's own kind allowlist", () => {
    // `decodeCommand`/`decodeEvent` reject any kind not present in the merged
    // COMMAND_KINDS/EVENT_KINDS tuples, so a kind that was declared in
    // cluster-contract but never spread into contract.ts fails HERE — which
    // is exactly the "declared but not actually wired" bug this guards.
    const minimalCommandFor: Record<(typeof CLUSTER_COMMAND_KINDS)[number], unknown> = {
      "cluster.status": { kind: "cluster.status" },
      "cluster.nodes": { kind: "cluster.nodes" },
      "cluster.run": { kind: "cluster.run" },
      "cluster.chaos": { kind: "cluster.chaos" },
    };
    for (const k of CLUSTER_COMMAND_KINDS) {
      expect(() => decodeCommand(`${JSON.stringify(minimalCommandFor[k])}\n`)).not.toThrow();
    }

    const minimalEventFor: Record<(typeof CLUSTER_EVENT_KINDS)[number], unknown> = {
      "cluster.status": { kind: "cluster.status", status, at: 1 },
      "cluster.nodes": { kind: "cluster.nodes", nodes: [node], at: 1 },
      "cluster.run": { kind: "cluster.run", run, at: 1 },
      "cluster.chaos": { kind: "cluster.chaos", run, at: 1 },
      "cluster.error": { kind: "cluster.error", op: "cluster.run", message: "m", at: 1 },
    };
    for (const k of CLUSTER_EVENT_KINDS) {
      expect(() => decodeEvent(`${JSON.stringify(minimalEventFor[k])}\n`)).not.toThrow();
    }
  });

  it("isCommand/isAppEvent recognize cluster traffic", () => {
    expect(isCommand({ kind: "cluster.chaos", nodes: 3, tasks: 4, seed: 1 })).toBe(true);
    expect(isAppEvent({ kind: "cluster.run", run, at: 9 })).toBe(true);
    expect(isAppEvent({ kind: "cluster.error", op: "cluster.status", message: "no", at: 9 })).toBe(true);
  });

  it("round-trips every command and event through the REAL newline-delimited codec byte-for-byte", () => {
    const cmds: ClusterCommand[] = [
      { kind: "cluster.status", nodes: 2 },
      { kind: "cluster.nodes" },
      { kind: "cluster.run", nodes: 2, tasks: 3, workersPerNode: 1 },
      { kind: "cluster.chaos", nodes: 3, tasks: 5, seed: 7, density: 1.25 },
    ];
    for (const c of cmds) {
      const line = encodeCommand(c);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trimEnd().includes("\n")).toBe(false);
      expect(decodeCommand(line)).toEqual(c);
    }

    const evs: ClusterEvent[] = [
      { kind: "cluster.status", status, at: 1 },
      { kind: "cluster.nodes", nodes: [node, { ...node, nodeId: "node-1", leaderId: null }], at: 2 },
      { kind: "cluster.run", run, at: 3 },
      { kind: "cluster.chaos", run, at: 4 },
      { kind: "cluster.error", op: "cluster.chaos", message: "fabric build failed", at: 5 },
    ];
    for (const e of evs) {
      expect(decodeEvent(encodeEvent(e))).toEqual(e);
    }
  });

  it("the codec REFUSES a cluster event whose honesty fields were stripped in transit", () => {
    const tampered = JSON.stringify({ kind: "cluster.run", run: { ...run, ephemeral: false }, at: 1 });
    expect(() => decodeEvent(`${tampered}\n`)).toThrow();
  });
});
