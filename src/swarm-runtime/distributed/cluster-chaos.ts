/**
 * @module swarm-runtime/distributed/cluster-chaos
 *
 * Team 5 — the in-process multi-node cluster fabric plus deterministic fault
 * injection. This module reimplements nothing: it *composes* the four other
 * teams' real, already-tested modules into one runnable topology —
 *
 *  - {@link ClusterCoordinator} (Team 1) is the control plane: placement,
 *    fencing-token leases, exactly-once verified-result merging.
 *  - {@link ClusterNode} (Team 2) is the per-machine executor: a real inline
 *    {@link SwarmManager} (real worker pool, real verification gate, real
 *    ed25519 certificates) driving one leased task at a time through
 *    `startGoal()`.
 *  - {@link FederationRouter} + {@link pairedWires} (Team 3) is the wire: a
 *    real signed/sequenced/replay-proof link between every pair of
 *    participants, carrying real gossip digests, real offer/accept round
 *    trips, and real federated result envelopes.
 *  - {@link ClusterMembership} (Team 4, `./membership`) is the SWIM layer:
 *    every liveness/health transition below — suspect, dead, left, leader
 *    re-election — is the real `tick()`/`apply()`/`election()` machinery,
 *    never a hand-rolled shortcut.
 *
 * ── Topology ────────────────────────────────────────────────────────────
 * `opts.nodes` compute nodes (`node-0..node-{n-1}`), each with its own
 * ed25519 identity, `ClusterMembership`, inline `SwarmManager`, `ClusterNode`
 * and `FederationRouter`. One additional, non-compute "control-plane"
 * identity (`controller`) hosts the single {@link ClusterCoordinator} and its
 * own `ClusterMembership`/`FederationRouter`; it deliberately advertises zero
 * capacity and no capabilities so `plan()` can never place work on it, and
 * its nodeId is chosen to sort before every compute node's so it is always
 * the coordinator's own view of "leader" as long as its own membership sees
 * cluster quorum — the honest in-process analogue of a durable control plane
 * that never itself fails during a bounded test run. Every pair of
 * participants (compute nodes and the controller) is connected over a real
 * `pairedWires()` link via `FederationRouter.connect()` — a full mesh, so no
 * single link failure can strand the whole cluster.
 *
 * Per-task dispatch genuinely round-trips the wire: the controller's router
 * `offer()`s a `ClusterOffer` to the target node (a real signed
 * request/response over the link, decided by the node's own `canAccept()`);
 * only on `accepted` does the fabric invoke `ClusterNode.execute()`
 * (in-process — it is the same object graph, so there is no value in
 * serializing the actual task body over the simulated wire); the resulting
 * `LeasedTaskOutcome` is independently certificate-verified
 * (`verifyCertificate` + `certifiesOutput`, real ed25519 math) and then
 * shipped back to the controller as a `FederatedResultEntry` via the node's
 * own router `sendResult()` — a second real, signed, deduped wire hop that
 * the controller's `onResult` handler feeds straight into
 * `ClusterCoordinator.report()`.
 *
 * ── Fault injection ─────────────────────────────────────────────────────
 * Every {@link FaultKind} drives a *real* consequence, never a fabricated
 * counter bump:
 *  - `kill-worker` kills a task genuinely in flight on a node (or arms the
 *    node's next dispatch) by having that node's task executor throw
 *    mid-execution — a real worker-runtime error, caught by the real
 *    verification gate exactly as a real crash would be, forcing the
 *    coordinator to `handBack()` and reassign.
 *  - `crash-node` calls the real `ClusterNode.crash()` (abandons in-flight
 *    leases, no membership announcement — exactly like a real crash) and
 *    then simply stops heartbeating that node into the controller's
 *    membership; the controller only learns of the death once its own real
 *    `ClusterMembership.tick()` times the node out through suspect → dead,
 *    at which point `ClusterCoordinator.onNodeDown()` reclaims its leases.
 *  - `leave-node` calls the real `ClusterNode.leave()` (a real, higher-
 *    incarnation "left" gossip entry) and applies that digest into the
 *    controller's membership immediately — a graceful departure is detected
 *    right away, unlike a crash.
 *  - `partition-link` / `heal-link` cut and restore one real `pairedWires`
 *    link between two participants.
 *  - `delay-link` tears down and reconnects a link over a freshly-built,
 *    higher-latency `pairedWires` pair — a real (slower) reconnect, not a
 *    cosmetic delay flag.
 *
 * `mode` is always the literal `"measured"`: every field on
 * {@link ChaosRunReport} is read off real counters (`ClusterCoordinator`'s
 * own `stats()`, real `Date.now()` wall-clock deltas, real certificate
 * verification tallies) — nothing here is ever a modeled or hand-picked
 * number.
 */

import { randomUUID } from "node:crypto";

import {
  ClusterCoordinator,
  type CoordinatorStats,
  type Placement,
} from "./cluster-coordinator";
import { ClusterNode, type LeasedTaskOutcome } from "./cluster-node";
import {
  FederationRouter,
  pairedWires,
  type ClusterAccept,
  type ClusterOffer,
} from "./federation-router";
import { ClusterMembership, type NodeDescriptor } from "./membership";
import { LeaseLedger, VerifiedResultLedger, type FederatedResultEntry } from "./lease-ledger";
import { createInlineSwarm } from "../factory";
import { localIdentity, pinnedTrust, type NodeIdentity, type PeerTrustPolicy } from "./federation-link";
import {
  generatePrivateKeyHex,
  CertificateAuthority,
  verifyCertificate,
  certifiesOutput,
} from "../../hades/styx/certificate";
import { DemoExecutor, type TaskExecutor, type ExecutionOutput, type WorkerContext } from "../worker/executor";
import type { SwarmManager } from "../manager/manager";
import type { IsolationKind, WorkerTask } from "../types";

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export type FaultKind =
  | "kill-worker"
  | "crash-node"
  | "partition-link"
  | "heal-link"
  | "leave-node"
  | "rejoin-node"
  | "delay-link";

export interface FaultEvent {
  at: number;
  kind: FaultKind;
  target: string;
  peer?: string;
  detail?: string;
}

export interface ChaosPlan {
  seed: number;
  faults: FaultEvent[];
}

export interface ClusterFabricOptions {
  nodes: number;
  workersPerNode?: number;
  capabilities?: string[];
  seed?: number;
  consensus?: { replicas: number; quorum: number };
  leaseTtlMs?: number;
  taskTimeoutMs?: number;
}

export interface ClusterFabric {
  coordinator: ClusterCoordinator;
  nodes: ClusterNode[];
  routers: FederationRouter[];
  run(tasks: WorkerTask[], opts?: { timeoutMs?: number; plan?: ChaosPlan }): Promise<ChaosRunReport>;
  shutdown(): Promise<void>;
}

export interface ChaosRunReport {
  mode: "measured";
  nodes: number;
  tasksSubmitted: number;
  tasksVerified: number;
  tasksFailed: number;
  duplicateVerifications: number;
  reassignments: number;
  faultsInjected: FaultEvent[];
  makespanMs: number;
  verifiedPerSec: number;
  certificatesValid: number;
  certificatesInvalid: number;
  conflicts: number;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Seedable PRNG (mulberry32) — pure function of `seed`, so {@link chaosPlan}
 *  is 100% reproducible given the same inputs; never used for anything
 *  security-sensitive. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

// ---------------------------------------------------------------------------
// chaosPlan — pure, deterministic fault-schedule generator.
// ---------------------------------------------------------------------------

export function chaosPlan(opts: { seed: number; durationMs: number; nodes: string[]; density?: number }): ChaosPlan {
  if (!Number.isFinite(opts.seed)) throw new RangeError("chaosPlan: seed must be a finite number");
  if (!(opts.durationMs > 0)) throw new RangeError(`chaosPlan: durationMs must be > 0, got ${opts.durationMs}`);
  if (!Array.isArray(opts.nodes) || opts.nodes.length === 0) {
    throw new RangeError("chaosPlan: nodes must be a non-empty array of node ids");
  }

  const density = Math.max(0, opts.density ?? 0.5);
  const rng = mulberry32(opts.seed);
  const nodes = [...opts.nodes];
  const count = Math.max(1, Math.round(density * Math.max(1, opts.durationMs / 250)));

  const pickNode = (): string => nodes[Math.floor(rng() * nodes.length) % nodes.length];
  const pickPeer = (excl: string): string => {
    if (nodes.length < 2) return excl;
    let p = excl;
    let guard = 0;
    while (p === excl && guard < 16) {
      p = pickNode();
      guard += 1;
    }
    return p;
  };

  const faults: FaultEvent[] = [];

  for (let i = 0; i < count; i++) {
    const at = Math.floor(rng() * opts.durationMs);
    const target = pickNode();
    const roll = rng();

    if (roll < 0.25) {
      faults.push({ at, kind: "kill-worker", target });
    } else if (roll < 0.45) {
      faults.push({ at, kind: "crash-node", target });
    } else if (roll < 0.75 && nodes.length >= 2) {
      const peer = pickPeer(target);
      const healAt = Math.min(opts.durationMs - 1, at + 1 + Math.floor(rng() * Math.max(1, opts.durationMs - at)));
      faults.push({ at, kind: "partition-link", target, peer });
      faults.push({ at: healAt, kind: "heal-link", target, peer });
    } else if (roll < 0.9) {
      const rejoinAt = Math.min(opts.durationMs - 1, at + 1 + Math.floor(rng() * Math.max(1, opts.durationMs - at)));
      faults.push({ at, kind: "leave-node", target });
      faults.push({ at: rejoinAt, kind: "rejoin-node", target });
    } else if (nodes.length >= 2) {
      const peer = pickPeer(target);
      const latencyMs = 20 + Math.floor(rng() * 60);
      faults.push({ at, kind: "delay-link", target, peer, detail: String(latencyMs) });
    } else {
      faults.push({ at, kind: "kill-worker", target });
    }
  }

  faults.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target));
  return { seed: opts.seed, faults: faults.map((f) => ({ ...f })) };
}

// ---------------------------------------------------------------------------
// buildClusterFabric — the topology.
// ---------------------------------------------------------------------------

const CONTROLLER_ID = "controller";
// Real ed25519 signing/verification for every gossip round across a full
// mesh (O(participants^2) link traffic) is genuine CPU work, not free — with
// several participants a single gossip+tick+plan loop iteration can itself
// take tens of milliseconds. These must comfortably exceed the *slowest*
// realistic loop iteration or a healthy, still-connected node would be
// spuriously suspected/declared dead purely from scheduling jitter, not an
// actual fault.
const SUSPECT_AFTER_MS = 500;
const DEAD_AFTER_MS = 1500;
const CHAOS_STEP_MS = 10;
const CHAOS_STEPS = 4;
const OFFER_TIMEOUT_MS = 400;
const GOSSIP_INTERVAL_MS = 20;
const DEFAULT_RUN_TIMEOUT_MS = 15_000;

interface FabricNodeInternal {
  id: string;
  descriptor: NodeDescriptor;
  manager: SwarmManager;
  node: ClusterNode;
  router: FederationRouter;
  membership: ClusterMembership;
  killed: Set<string>;
  armed: boolean;
  /** Our own bookkeeping of "reachable from the controller's gossip pump" —
   *  false once crash-node/leave-node fires, true again after a legitimate
   *  rejoin-node. Independent of (but consistent with) the real SWIM health
   *  each participant's own `ClusterMembership` eventually converges to. */
  connected: boolean;
}

/** Chaos-aware task executor: real grounded work (delegates to the same
 *  `DemoExecutor` every other inline-swarm test uses), but checks a
 *  per-node kill set right before "finishing" so a `kill-worker` fault fired
 *  while this exact task is in flight causes a genuine thrown error — caught
 *  by the real worker runtime and rejected by the real verification gate,
 *  never a synthetic report fabricated by this module. */
function makeChaosExecutor(killed: Set<string>): TaskExecutor {
  const base = new DemoExecutor();
  return {
    async execute(task, ctx: WorkerContext): Promise<ExecutionOutput> {
      const clusterTaskId = String((task.input as Record<string, unknown>).__clusterTaskId ?? "");
      for (let i = 0; i < CHAOS_STEPS; i++) {
        await sleep(CHAOS_STEP_MS);
        if (clusterTaskId && killed.has(clusterTaskId)) {
          killed.delete(clusterTaskId);
          throw new Error(`cluster-chaos: worker executing task "${clusterTaskId}" was killed`);
        }
      }
      if (clusterTaskId && killed.has(clusterTaskId)) {
        killed.delete(clusterTaskId);
        throw new Error(`cluster-chaos: worker executing task "${clusterTaskId}" was killed`);
      }
      return base.execute(task, ctx);
    },
  };
}

export async function buildClusterFabric(opts: ClusterFabricOptions): Promise<ClusterFabric> {
  if (!Number.isInteger(opts.nodes) || opts.nodes < 1) {
    throw new RangeError(`buildClusterFabric: nodes must be a positive integer, got ${opts.nodes}`);
  }
  const workersPerNode = Math.max(1, Math.floor(opts.workersPerNode ?? 2));
  const capabilities = opts.capabilities && opts.capabilities.length > 0 ? [...opts.capabilities] : ["general"];
  const leaseTtlMs = Math.max(50, opts.leaseTtlMs ?? 1500);
  const taskTimeoutMs = Math.max(50, opts.taskTimeoutMs ?? 4000);
  const nowFn = (): number => Date.now();

  const nodeIds = Array.from({ length: opts.nodes }, (_, i) => `node-${i}`);
  const allIds = [CONTROLLER_ID, ...nodeIds];

  // ── Identities ──────────────────────────────────────────────────────────
  const privateKeys = new Map<string, string>();
  for (const id of allIds) privateKeys.set(id, generatePrivateKeyHex());
  const identities = new Map<string, NodeIdentity>();
  for (const id of allIds) identities.set(id, localIdentity(id, privateKeys.get(id) as string));

  function makeDescriptor(id: string, maxWorkers: number, caps: string[]): NodeDescriptor {
    return {
      nodeId: id,
      managerUrl: `inline://${id}`,
      capabilities: caps,
      capacity: { maxWorkers, providerKinds: ["inline"] as IsolationKind[] },
      publicKeyHex: (identities.get(id) as NodeIdentity).publicKeyHex,
      startedAt: nowFn(),
    };
  }

  const controllerDescriptor = makeDescriptor(CONTROLLER_ID, 0, []);
  const descriptors = new Map<string, NodeDescriptor>();
  descriptors.set(CONTROLLER_ID, controllerDescriptor);
  for (const id of nodeIds) descriptors.set(id, makeDescriptor(id, workersPerNode, capabilities));

  // ── Trust: every identity pins every other identity's real public key ──
  const trustPolicies = new Map<string, PeerTrustPolicy>();
  for (const id of allIds) {
    const seed = allIds
      .filter((other) => other !== id)
      .map((other) => ({ nodeId: other, publicKeyHex: (identities.get(other) as NodeIdentity).publicKeyHex }));
    trustPolicies.set(id, pinnedTrust(seed));
  }

  // ── Memberships ─────────────────────────────────────────────────────────
  const controllerMembership = new ClusterMembership({
    self: controllerDescriptor,
    now: nowFn,
    suspectAfterMs: SUSPECT_AFTER_MS,
    deadAfterMs: DEAD_AFTER_MS,
  });
  for (const id of nodeIds) controllerMembership.join(descriptors.get(id) as NodeDescriptor);

  const nodeMemberships = new Map<string, ClusterMembership>();
  for (const id of nodeIds) {
    const m = new ClusterMembership({
      self: descriptors.get(id) as NodeDescriptor,
      now: nowFn,
      suspectAfterMs: SUSPECT_AFTER_MS,
      deadAfterMs: DEAD_AFTER_MS,
    });
    m.join(controllerDescriptor);
    for (const peerId of nodeIds) {
      if (peerId !== id) m.join(descriptors.get(peerId) as NodeDescriptor);
    }
    nodeMemberships.set(id, m);
  }

  // ── Coordinator ─────────────────────────────────────────────────────────
  const leases = new LeaseLedger();
  const results = new VerifiedResultLedger({ requireCertificate: true, consensus: opts.consensus, now: nowFn });
  const coordinator = new ClusterCoordinator({
    membership: controllerMembership,
    leases,
    results,
    now: nowFn,
    leaseTtlMs,
    consensus: opts.consensus,
    requireCertificate: true,
    requireLeadership: true,
  });

  // ── Controller router ───────────────────────────────────────────────────
  const controllerRouter = new FederationRouter({
    identity: identities.get(CONTROLLER_ID) as NodeIdentity,
    trust: trustPolicies.get(CONTROLLER_ID) as PeerTrustPolicy,
    membership: controllerMembership,
    now: nowFn,
    requestTimeoutMs: OFFER_TIMEOUT_MS,
  });
  controllerRouter.onResult((entry) => {
    void coordinator.report(entry);
  });

  // ── Compute nodes ───────────────────────────────────────────────────────
  const fabricNodes = new Map<string, FabricNodeInternal>();
  const managers: SwarmManager[] = [];

  for (const id of nodeIds) {
    const descriptor = descriptors.get(id) as NodeDescriptor;
    const killed = new Set<string>();
    const manager = await createInlineSwarm({
      capabilities,
      poolSize: workersPerNode,
      executor: makeChaosExecutor(killed),
      maxAttempts: 1,
    });
    managers.push(manager);

    const membership = nodeMemberships.get(id) as ClusterMembership;
    const clusterNode = new ClusterNode({
      descriptor,
      manager,
      membership,
      now: nowFn,
      maxConcurrentTasks: workersPerNode,
      taskTimeoutMs,
      certificateAuthority: new CertificateAuthority(generatePrivateKeyHex()),
    });
    await clusterNode.start();

    const router = new FederationRouter({
      identity: identities.get(id) as NodeIdentity,
      trust: trustPolicies.get(id) as PeerTrustPolicy,
      membership,
      now: nowFn,
      requestTimeoutMs: OFFER_TIMEOUT_MS,
    });
    router.onOffer((offer: ClusterOffer): ClusterAccept => {
      const fn = fabricNodes.get(id);
      const accepted = !!fn && fn.connected && fn.node.canAccept(offer.task);
      return {
        taskId: offer.taskId,
        fencing: offer.lease.fencing,
        nodeId: id,
        accepted,
        refusal: accepted ? undefined : "capacity",
        at: nowFn(),
      };
    });

    fabricNodes.set(id, {
      id,
      descriptor,
      manager,
      node: clusterNode,
      router,
      membership,
      killed,
      armed: false,
      connected: true,
    });
  }

  // ── Full mesh: every pair of participants gets a real paired-wire link ──
  const routers = new Map<string, FederationRouter>();
  routers.set(CONTROLLER_ID, controllerRouter);
  for (const [id, fn] of fabricNodes) routers.set(id, fn.router);

  const links = new Map<string, ReturnType<typeof pairedWires>>();

  async function connectPair(a: string, b: string, latencyMs?: number): Promise<void> {
    const wires = pairedWires(latencyMs !== undefined ? { latencyMs } : undefined);
    links.set(pairKey(a, b), wires);
    const routerA = routers.get(a) as FederationRouter;
    const routerB = routers.get(b) as FederationRouter;
    await Promise.all([
      routerA.connect(descriptors.get(b) as NodeDescriptor, wires.a),
      routerB.connect(descriptors.get(a) as NodeDescriptor, wires.b),
    ]);
  }

  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      await connectPair(allIds[i], allIds[j]);
    }
  }

  // ── Fault application ───────────────────────────────────────────────────

  async function relinkWithLatency(a: string, b: string, latencyMs: number): Promise<void> {
    const routerA = routers.get(a);
    const routerB = routers.get(b);
    if (!routerA || !routerB) return;
    await Promise.all([
      routerA.disconnect(b, "chaos: delay-link").catch(() => undefined),
      routerB.disconnect(a, "chaos: delay-link").catch(() => undefined),
    ]);
    try {
      await connectPair(a, b, latencyMs);
    } catch {
      // A reconnect can genuinely fail under load (handshake timeout) —
      // one real retry at plain (non-delayed) latency before giving up and
      // leaving the pair disconnected; either way this must never surface
      // as an unhandled rejection from a fire-and-forget fault application.
      await connectPair(a, b).catch(() => undefined);
    }
  }

  async function applyFault(f: FaultEvent): Promise<void> {
    switch (f.kind) {
      case "kill-worker": {
        const fn = fabricNodes.get(f.target);
        if (!fn) return;
        const inFlight = fn.node.renewals();
        if (inFlight.length > 0) {
          fn.killed.add(inFlight[0].taskId);
        } else {
          fn.armed = true;
        }
        return;
      }
      case "crash-node": {
        const fn = fabricNodes.get(f.target);
        if (!fn || !fn.connected) return;
        fn.connected = false;
        fn.node.crash(f.detail ?? "chaos: crash-node");
        return;
      }
      case "leave-node": {
        const fn = fabricNodes.get(f.target);
        if (!fn || !fn.connected) return;
        fn.connected = false;
        const digest = await fn.node.leave(f.detail ?? "chaos: leave-node");
        controllerMembership.apply(digest);
        return;
      }
      case "rejoin-node": {
        const fn = fabricNodes.get(f.target);
        if (!fn) return;
        // Only a graceful leave can be rejoined: `ClusterNode` exposes no
        // "un-crash" API (a real crashed process needs a real restart), so a
        // rejoin fault targeting a crashed node is an honest no-op.
        if (fn.node.snapshot().health !== "left") return;
        fn.connected = true;
        controllerMembership.join(fn.descriptor);
        return;
      }
      case "partition-link": {
        links.get(pairKey(f.target, f.peer ?? ""))?.partition();
        return;
      }
      case "heal-link": {
        links.get(pairKey(f.target, f.peer ?? ""))?.heal();
        return;
      }
      case "delay-link": {
        const peer = f.peer ?? "";
        if (!peer) return;
        const latencyMs = Math.max(1, Number(f.detail) || 40);
        await relinkWithLatency(f.target, peer, latencyMs);
        return;
      }
      default:
        return;
    }
  }

  // Real SWIM re-election flows from this: a dead compute node's leases are
  // reclaimed only once the controller's own `tick()` genuinely times it out.
  controllerMembership.on("node:dead", (state: { descriptor: NodeDescriptor }) => {
    coordinator.onNodeDown(state.descriptor.nodeId, "dead");
  });
  controllerMembership.on("node:left", (state: { descriptor: NodeDescriptor }) => {
    coordinator.onNodeDown(state.descriptor.nodeId, "left");
  });

  // ── run() ───────────────────────────────────────────────────────────────

  async function run(
    tasks: WorkerTask[],
    runOpts?: { timeoutMs?: number; plan?: ChaosPlan },
  ): Promise<ChaosRunReport> {
    const startedAt = nowFn();
    const timeoutMs = Math.max(1, runOpts?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const sortedFaults = runOpts?.plan ? [...runOpts.plan.faults].sort((a, b) => a.at - b.at) : [];
    const faultsInjected: FaultEvent[] = [];

    // The coordinator's own counters are CUMULATIVE over its whole lifetime,
    // and one fabric may legitimately be run more than once. A report that
    // read `stats().verified` directly would, on a second run, claim more
    // verified tasks than it submitted — a number that looks like a
    // measurement but is an accounting artifact. So the baseline is captured
    // here and every rate/count below is a delta over THIS run, and the
    // verified/failed tallies are read back per submitted task id rather than
    // taken from the global counters at all.
    const statsBefore: CoordinatorStats = coordinator.stats();
    const submittedIds = tasks.map((t) => t.id);

    let duplicateVerifications = 0;
    let certificatesValid = 0;
    let certificatesInvalid = 0;

    const onRejected = (_taskId: string, _nodeId: string, outcome: { accepted: boolean; reason?: string }): void => {
      if (!outcome.accepted && outcome.reason === "duplicate") duplicateVerifications += 1;
    };
    coordinator.on("result:rejected", onRejected);

    const annotated = tasks.map((t) => ({
      ...t,
      input: { ...t.input, __clusterTaskId: t.id },
    }));
    coordinator.submit(annotated);

    const inFlight = new Set<Promise<void>>();

    async function dispatchPlacement(p: Placement): Promise<void> {
      const state = coordinator.state(p.taskId);
      const task = state?.task;
      const fn = fabricNodes.get(p.nodeId);
      if (!task || !fn) return;

      const offer: ClusterOffer = {
        taskId: p.taskId,
        task,
        lease: p.lease,
        fromNodeId: CONTROLLER_ID,
        deadlineAt: p.lease.expiresAt,
      };
      const accept = await controllerRouter.offer(p.nodeId, offer);
      if (!accept.accepted) {
        coordinator.handBack(p.taskId, p.nodeId, p.lease.fencing, accept.refusal ?? "offer-refused");
        return;
      }

      if (fn.armed) {
        fn.armed = false;
        fn.killed.add(p.taskId);
      }

      let outcome: LeasedTaskOutcome;
      try {
        outcome = await fn.node.execute(p.lease, task);
      } catch {
        // Node crashed / drained mid-flight: the lease is reclaimed for
        // reassignment by onNodeDown()/tick() — nothing more to do here.
        return;
      }

      // The lease this outcome was computed under may since have been
      // reclaimed (TTL expiry, onNodeDown, or an explicit handBack) while
      // execution was still running — e.g. a `kill-worker` fault armed a
      // retry on a fresh fencing token before this older attempt finished.
      // Reporting a result for a lease the coordinator no longer considers
      // outstanding would only ever be rejected downstream (stale-fencing,
      // or — if the same node's deterministic output collides with the
      // attempt that superseded it — "duplicate"); checking first avoids
      // that race outright instead of relying on the ledger as a crutch.
      const stillHeld = coordinator
        .state(outcome.taskId)
        ?.leases.some((l) => l.nodeId === outcome.nodeId && l.fencing === outcome.fencing);
      if (!stillHeld) return;

      if (outcome.report.verdict !== "accept") {
        // The node itself honestly reports it could not complete the task
        // (e.g. its executor was killed by a `kill-worker` fault) — hand the
        // lease straight back for reassignment rather than waiting out the
        // full TTL. There is nothing to federate: a non-accept verdict can
        // never be accepted by `VerifiedResultLedger` anyway.
        coordinator.handBack(outcome.taskId, outcome.nodeId, outcome.fencing, outcome.report.feedback || "task not accepted");
        return;
      }

      if (outcome.certificate) {
        const sigOk = await verifyCertificate(outcome.certificate);
        const boundOk = sigOk && (await certifiesOutput(outcome.certificate, outcome.outputText));
        if (boundOk) certificatesValid += 1;
        else certificatesInvalid += 1;
      }

      // Models "died with the result computed but unshipped": if this node
      // has since gone down, the report is honestly lost in transit — the
      // coordinator reclaims and re-executes the task elsewhere via fencing,
      // never double-counting the abandoned attempt.
      if (!fn.connected) return;

      const entry: FederatedResultEntry = {
        taskId: outcome.taskId,
        nodeId: outcome.nodeId,
        fencing: outcome.fencing,
        result: outcome.result,
        report: outcome.report,
        certificate: outcome.certificate,
        outputText: outcome.outputText,
      };

      try {
        await fn.router.sendResult(CONTROLLER_ID, entry);
      } catch {
        // Link down: the result never arrives, and the lease is reclaimed
        // through the normal TTL/membership path — not lost or duplicated.
      }
    }

    function applyDueFaults(elapsedMs: number, idx: { i: number }): void {
      while (idx.i < sortedFaults.length && sortedFaults[idx.i].at <= elapsedMs) {
        const f = sortedFaults[idx.i];
        idx.i += 1;
        faultsInjected.push(f);
        // Fire-and-forget from the caller's perspective (the scheduling loop
        // must not block on a fault's own async work), but always caught —
        // a fault application failing (e.g. a delay-link reconnect losing a
        // handshake race) must never become an unhandled rejection.
        void applyFault(f).catch(() => undefined);
      }
    }

    const faultIdx = { i: 0 };

    try {
      while (true) {
        const elapsed = nowFn() - startedAt;
        applyDueFaults(elapsed, faultIdx);

        await Promise.all(
          [...fabricNodes.values()]
            .filter((fn) => fn.connected)
            .map((fn) => fn.router.broadcastGossip().catch(() => undefined)),
        );
        await controllerRouter.broadcastGossip().catch(() => undefined);

        controllerMembership.tick(nowFn());
        for (const fn of fabricNodes.values()) {
          if (fn.connected) fn.membership.tick(nowFn());
        }

        coordinator.tick(nowFn());
        const placements = coordinator.plan(nowFn());
        for (const p of placements) {
          const promise = dispatchPlacement(p).catch(() => undefined);
          inFlight.add(promise);
          void promise.finally(() => inFlight.delete(promise));
        }

        const elapsedNow = nowFn() - startedAt;
        const due = elapsedNow >= timeoutMs;
        const complete = coordinator.isComplete() && inFlight.size === 0 && faultIdx.i >= sortedFaults.length;
        if (complete || due) break;

        await sleep(GOSSIP_INTERVAL_MS);
      }

      const remaining = Math.max(0, timeoutMs - (nowFn() - startedAt));
      await Promise.race([Promise.all([...inFlight]), sleep(remaining)]);
    } finally {
      coordinator.off("result:rejected", onRejected);
    }

    const stats: CoordinatorStats = coordinator.stats();
    const makespanMs = Math.max(0, nowFn() - startedAt);
    const denomSec = Math.max(1, makespanMs) / 1000;

    // Counted over THIS run's own submitted task ids, so the tally can never
    // exceed `tasksSubmitted` and never inherits an earlier run's outcomes.
    let tasksVerified = 0;
    let tasksFailed = 0;
    for (const id of submittedIds) {
      const status = coordinator.state(id)?.status;
      if (status === "verified") tasksVerified += 1;
      else if (status === "failed") tasksFailed += 1;
    }

    return {
      mode: "measured",
      nodes: opts.nodes,
      tasksSubmitted: tasks.length,
      tasksVerified,
      tasksFailed,
      duplicateVerifications,
      reassignments: Math.max(0, stats.reassignments - statsBefore.reassignments),
      faultsInjected,
      makespanMs,
      verifiedPerSec: tasksVerified / denomSec,
      certificatesValid,
      certificatesInvalid,
      conflicts: Math.max(0, stats.conflicts - statsBefore.conflicts),
    };
  }

  async function shutdown(): Promise<void> {
    await Promise.all(
      [...fabricNodes.values()].map(async (fn) => {
        await fn.node.shutdown().catch(() => undefined);
        await fn.router.close().catch(() => undefined);
        await fn.manager.shutdown().catch(() => undefined);
      }),
    );
    await controllerRouter.close().catch(() => undefined);
  }

  return {
    coordinator,
    nodes: nodeIds.map((id) => (fabricNodes.get(id) as FabricNodeInternal).node),
    routers: nodeIds.map((id) => (fabricNodes.get(id) as FabricNodeInternal).router),
    run,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// runClusterChaos — convenience: build a fabric, run a synthetic workload
// through it under the given (or generated) chaos plan, tear it down.
// ---------------------------------------------------------------------------

function buildSyntheticTasks(count: number, capabilities: string[], consensus?: { replicas: number; quorum: number }): WorkerTask[] {
  const createdAt = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const task: WorkerTask = {
      id: `chaos-${i}-${randomUUID().slice(0, 8)}`,
      goalId: "cluster-chaos-goal",
      description: `Chaos workload item ${i}`,
      requiredCapabilities: capabilities,
      input: { objective: `chaos objective ${i}` },
      dependsOn: [],
      priority: 1,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt,
    };
    if (consensus) task.consensus = consensus;
    return task;
  });
}

export async function runClusterChaos(
  opts: ClusterFabricOptions & { tasks: number; plan?: ChaosPlan; timeoutMs?: number },
): Promise<ChaosRunReport> {
  if (!Number.isInteger(opts.tasks) || opts.tasks < 1) {
    throw new RangeError(`runClusterChaos: tasks must be a positive integer, got ${opts.tasks}`);
  }
  const fabric = await buildClusterFabric(opts);
  try {
    const tasks = buildSyntheticTasks(opts.tasks, opts.capabilities && opts.capabilities.length > 0 ? opts.capabilities : ["general"], opts.consensus);
    return await fabric.run(tasks, { timeoutMs: opts.timeoutMs, plan: opts.plan });
  } finally {
    await fabric.shutdown();
  }
}
