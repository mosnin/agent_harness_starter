import { describe, it, expect, afterEach } from "vitest";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";

import {
  FederationLink,
  localIdentity,
  pinnedTrust,
  signEnvelope,
  socketWire,
  type FederationLinkOptions,
  type FederatedEnvelope,
  type FederatedKind,
  type NodeIdentity,
} from "../federation-link";
import type { Wire } from "../../../hades/a2a/remote-transport";
import { ClusterMembership, type GossipEntry, type NodeDescriptor } from "../membership";
import type { Lease, FederatedResultEntry } from "../lease-ledger";
import type { IsolationKind, VerificationReport, WorkerResult, WorkerTask } from "../../types";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex, type CertificatePayload } from "../../../hades/styx/certificate";

import {
  FederationRouter,
  pairedWires,
  type ClusterAccept,
  type ClusterOffer,
  type PeerStatus,
} from "../federation-router";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeIdentity(nodeId: string): NodeIdentity {
  return localIdentity(nodeId, generatePrivateKeyHex());
}

function makeDescriptor(nodeId: string, publicKeyHex: string, overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    nodeId,
    managerUrl: `http://${nodeId}.local:9000`,
    capabilities: ["general"],
    capacity: { maxWorkers: 4, providerKinds: ["process"] as IsolationKind[] },
    publicKeyHex,
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeMembership(self: NodeDescriptor): ClusterMembership {
  return new ClusterMembership({ self });
}

function makeWorkerTask(id: string): WorkerTask {
  return {
    id,
    goalId: "goal-1",
    description: "do the thing",
    requiredCapabilities: [],
    input: { foo: "bar" },
    dependsOn: [],
    priority: 1,
    status: "dispatched",
    attempts: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
  };
}

function makeLease(taskId: string, nodeId: string, fencing = 1): Lease {
  return { taskId, nodeId, fencing, attempt: 1, grantedAt: Date.now(), expiresAt: Date.now() + 60_000 };
}

function makeClusterOffer(task: WorkerTask, lease: Lease, fromNodeId: string): ClusterOffer {
  return { taskId: task.id, task, lease, fromNodeId, deadlineAt: Date.now() + 30_000 };
}

function makeWorkerResult(taskId: string, workerId: string, output: unknown = { answer: 42 }): WorkerResult {
  return {
    taskId,
    workerId,
    output,
    claims: [{ statement: "it works", evidence: ["trace"], confidence: 0.9 }],
    toolTrace: [],
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
}

function makeVerificationReport(taskId: string, workerId: string): VerificationReport {
  return {
    taskId,
    workerId,
    verdict: "accept",
    score: 0.95,
    checks: [{ name: "grounding", passed: true, weight: 1, detail: "ok" }],
    feedback: "",
    at: Date.now(),
  };
}

async function makeCertifiedEntry(
  ca: CertificateAuthority,
  taskId: string,
  nodeId: string,
  fencing: number
): Promise<FederatedResultEntry> {
  const result = makeWorkerResult(taskId, nodeId);
  const report = makeVerificationReport(taskId, nodeId);
  const outputText = JSON.stringify(result.output);
  const payload: CertificatePayload = {
    outputSha256: sha256Hex(outputText),
    taskId,
    verifierTier: "T0-execution",
    ensembleScore: 0.95,
    pCorrect: 0.97,
    epsilon: 0.05,
    traceSha256: sha256Hex("trace"),
    verifierVersions: ["v1"],
    issuedAt: Date.now(),
  };
  const certificate = await ca.issue(payload);
  return { taskId, nodeId, fencing, result, report, certificate, outputText };
}

/** Mirrors membership.ts's private stableJson/digestChecksum exactly, so a
 *  hand-crafted hostile digest can carry a checksum ClusterMembership.apply()
 *  will accept as well-formed (letting the *merge* rules — not shape
 *  validation — be what rejects it). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
}
function digestChecksum(entries: GossipEntry[]): string {
  return createHash("sha256").update(stableJson(entries), "utf8").digest("hex");
}

async function craftEnvelope(
  identity: NodeIdentity,
  fields: { id: string; kind: FederatedKind; fromNodeId: string; toNodeId: string; seq: number; nonce: string; payload: unknown }
): Promise<FederatedEnvelope> {
  return signEnvelope(identity, { v: 1, ts: Date.now(), ...fields });
}

const openRouters: FederationRouter[] = [];
function track(router: FederationRouter): FederationRouter {
  openRouters.push(router);
  return router;
}

afterEach(async () => {
  await Promise.all(openRouters.splice(0).map((r) => r.close()));
});

async function connectPair(
  routerA: FederationRouter,
  descA: NodeDescriptor,
  wireA: Wire,
  routerB: FederationRouter,
  descB: NodeDescriptor,
  wireB: Wire,
  reconnect?: { attempts: number; baseDelayMs: number; maxDelayMs: number; reconnectWire?: () => Promise<Wire> }
): Promise<[PeerStatus, PeerStatus]> {
  return Promise.all([routerA.connect(descB, wireA, reconnect), routerB.connect(descA, wireB, reconnect)]);
}

// ---------------------------------------------------------------------------
// pairedWires
// ---------------------------------------------------------------------------

describe("pairedWires", () => {
  it("delivers frames both directions, honoring the send/onFrame contract", async () => {
    const { a, b } = pairedWires();
    const receivedByA: string[] = [];
    const receivedByB: string[] = [];
    a.onFrame((f) => receivedByA.push(f));
    b.onFrame((f) => receivedByB.push(f));

    a.send("hello-from-a");
    b.send("hello-from-b");
    await delay(30);

    expect(receivedByB).toEqual(["hello-from-a"]);
    expect(receivedByA).toEqual(["hello-from-b"]);
  });

  it("partition() cuts frame flow and heal() resumes it, without replaying dropped-in-flight frames", async () => {
    const { a, b, partition, heal } = pairedWires();
    const receivedByB: string[] = [];
    b.onFrame((f) => receivedByB.push(f));

    a.send("before-partition");
    await delay(20);
    expect(receivedByB).toEqual(["before-partition"]);

    partition();
    a.send("during-partition-1");
    a.send("during-partition-2");
    await delay(20);
    expect(receivedByB).toEqual(["before-partition"]); // still just the one

    heal();
    a.send("after-heal");
    await delay(20);
    // the two in-flight-during-partition sends are gone for good — a real
    // cut link doesn't queue and replay packets it dropped.
    expect(receivedByB).toEqual(["before-partition", "after-heal"]);
  });

  it("is deterministic for a given seed: two independent pairs see identical drop patterns", async () => {
    async function run(seed: number): Promise<boolean[]> {
      const { a, b } = pairedWires({ dropRate: 0.5, seed });
      const arrived: boolean[] = [];
      let count = 0;
      b.onFrame(() => {
        count++;
      });
      for (let i = 0; i < 40; i++) {
        const before = count;
        a.send(`msg-${i}`);
        await delay(5);
        arrived.push(count > before);
      }
      return arrived;
    }

    const first = await run(777);
    const second = await run(777);
    expect(first).toEqual(second);
    // sanity: with dropRate 0.5 over 40 sends we should see a genuine mix,
    // not "the RNG never actually dropped anything" (which would make the
    // determinism check vacuous).
    expect(first.some((x) => x)).toBe(true);
    expect(first.some((x) => !x)).toBe(true);
  });

  it("models latency: with latencyMs set, delivery is observably delayed rather than immediate", async () => {
    const { a, b } = pairedWires({ latencyMs: 60 });
    let arrivedAt: number | undefined;
    const sentAt = Date.now();
    b.onFrame(() => {
      arrivedAt = Date.now();
    });
    a.send("slow-frame");
    await delay(15);
    expect(arrivedAt).toBeUndefined(); // hasn't arrived yet
    await delay(80);
    expect(arrivedAt).toBeDefined();
    expect((arrivedAt as number) - sentAt).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// connect / disconnect / close lifecycle
// ---------------------------------------------------------------------------

describe("FederationRouter — connect/disconnect/close lifecycle", () => {
  it("connect() performs a real mutual ed25519 handshake and both sides report ready", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({
        identity: idA,
        trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]),
        membership: makeMembership(descA),
      })
    );
    const routerB = track(
      new FederationRouter({
        identity: idB,
        trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]),
        membership: makeMembership(descB),
      })
    );

    const readyEvents: PeerStatus[] = [];
    routerA.on("peer:ready", (s: PeerStatus) => readyEvents.push(s));

    const { a: wireA, b: wireB } = pairedWires();
    const [statusA, statusB] = await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    expect(statusA).toMatchObject({ nodeId: "B", phase: "ready", publicKeyHex: idB.publicKeyHex });
    expect(statusB).toMatchObject({ nodeId: "A", phase: "ready", publicKeyHex: idA.publicKeyHex });
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0].nodeId).toBe("B");

    expect(routerA.peers()).toHaveLength(1);
    expect(routerA.peers()[0].phase).toBe("ready");
    expect(routerA.stats().ready).toBe(1);
    expect(routerB.stats().ready).toBe(1);
  });

  it("refuses (never trust-on-first-use) a peer whose public key isn't pinned, and counts it", async () => {
    const idC = makeIdentity("C");
    const idD = makeIdentity("D");
    const idWrong = makeIdentity("not-c");
    const descC = makeDescriptor("C", idC.publicKeyHex);
    const descD = makeDescriptor("D", idD.publicKeyHex);

    // Both sides are pinned to the WRONG key for their peer — simulates a
    // misconfigured / attacker-substituted pin symmetrically, so *neither*
    // side's hello/welcome is ever accepted by the other (each side's own
    // handshake success is unilateral: it only depends on what *it* is
    // willing to accept from the wire, not on whether the peer accepted it).
    const routerC = track(
      new FederationRouter({
        identity: idC,
        trust: pinnedTrust([{ nodeId: "D", publicKeyHex: idWrong.publicKeyHex }]),
        membership: makeMembership(descC),
        requestTimeoutMs: 250,
      })
    );
    const routerD = track(
      new FederationRouter({
        identity: idD,
        trust: pinnedTrust([{ nodeId: "C", publicKeyHex: idWrong.publicKeyHex }]),
        membership: makeMembership(descD),
        requestTimeoutMs: 250,
      })
    );

    const rejectedOnD: Array<{ reason: string; fromNodeId: string }> = [];
    routerD.on("envelope:rejected", (reason: string, fromNodeId: string) => rejectedOnD.push({ reason, fromNodeId }));

    const { a: wireC, b: wireD } = pairedWires();
    const [resC, resD] = await Promise.allSettled([
      routerC.connect(descD, wireC),
      routerD.connect(descC, wireD),
    ]);

    expect(resD.status).toBe("rejected");
    expect(resC.status).toBe("rejected"); // C's own trust pin for D is wrong too — symmetric refusal
    expect(routerD.stats().rejected["untrusted"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(rejectedOnD.some((r) => r.reason === "untrusted" && r.fromNodeId === "C")).toBe(true);
    expect(routerD.peers()).toHaveLength(0);
  }, 5000);

  it("disconnect() closes one peer cleanly with a single peer:closed(reason) and removes it from peers()", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA) })
    );
    const routerB = track(
      new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) })
    );
    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    const closedEvents: Array<[string, string]> = [];
    routerA.on("peer:closed", (nodeId: string, reason: string) => closedEvents.push([nodeId, reason]));

    await routerA.disconnect("B", "test-shutdown");
    await delay(20);

    expect(closedEvents).toEqual([["B", "test-shutdown"]]);
    expect(routerA.peers()).toHaveLength(0);
  });

  it("close() tears down every peer link and emits peer:closed for each", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const idC = makeIdentity("C");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const descC = makeDescriptor("C", idC.publicKeyHex);
    const routerA = track(
      new FederationRouter({
        identity: idA,
        trust: pinnedTrust([
          { nodeId: "B", publicKeyHex: idB.publicKeyHex },
          { nodeId: "C", publicKeyHex: idC.publicKeyHex },
        ]),
        membership: makeMembership(descA),
      })
    );
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const routerC = track(new FederationRouter({ identity: idC, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descC) }));

    const { a: wireAB, b: wireBA } = pairedWires();
    const { a: wireAC, b: wireCA } = pairedWires();
    await Promise.all([
      connectPair(routerA, descA, wireAB, routerB, descB, wireBA),
      connectPair(routerA, descA, wireAC, routerC, descC, wireCA),
    ]);
    expect(routerA.peers()).toHaveLength(2);

    const closedEvents: string[] = [];
    routerA.on("peer:closed", (nodeId: string) => closedEvents.push(nodeId));

    await routerA.close();

    expect(closedEvents.sort()).toEqual(["B", "C"]);
    expect(routerA.peers()).toHaveLength(0);
    expect(routerA.stats().peers).toBe(0);
    // idempotent
    await expect(routerA.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gossip
// ---------------------------------------------------------------------------

describe("FederationRouter — gossip", () => {
  it("broadcastGossip() feeds the real ClusterMembership.apply() on the peer and fires gossip:received", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const membershipA = makeMembership(descA);
    const membershipB = makeMembership(descB);
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: membershipA }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: membershipB }));

    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    const gossipEvents: Array<{ fromNodeId: string }> = [];
    routerB.on("gossip:received", (_digest: unknown, fromNodeId: string) => gossipEvents.push({ fromNodeId }));

    const outcome = await routerA.broadcastGossip();
    expect(outcome.sent).toEqual(["B"]);
    expect(outcome.failed).toEqual([]);
    await delay(30);

    expect(gossipEvents).toEqual([{ fromNodeId: "A" }]);
    expect(routerA.stats().gossipSent).toBe(1);
    expect(routerB.stats().gossipReceived).toBe(1);

    // Real merge: B's membership now genuinely knows about A.
    expect(membershipB.get("A")?.descriptor.nodeId).toBe("A");
    expect(membershipB.get("A")?.health).toBe("alive");
  });

  it("surfaces a real GossipApplyResult rejection (stale-incarnation) via envelope:rejected, never swallowed", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const membershipA = makeMembership(descA);
    const membershipB = makeMembership(descB);
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: membershipA }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: membershipB }));

    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    // Round 1: B legitimately learns about A at incarnation 0.
    await routerA.broadcastGossip();
    await delay(20);
    expect(membershipB.get("A")?.incarnation).toBe(0);

    // A bumps its own incarnation (a real refute) and re-broadcasts — B's
    // stored incarnation for A now advances to 1.
    membershipA.refute();
    await routerA.broadcastGossip();
    await delay(20);
    expect(membershipB.get("A")?.incarnation).toBe(1);

    const rejected: Array<{ reason: string; fromNodeId: string }> = [];
    routerB.on("envelope:rejected", (reason: string, fromNodeId: string) => rejected.push({ reason, fromNodeId }));

    // Now hand-craft a hostile digest claiming A is back at incarnation 0 —
    // stale relative to what B already has on file.
    const staleEntries: GossipEntry[] = [{ nodeId: "A", incarnation: 0, health: "alive", load: 0, liveWorkers: 0, descriptor: descA }];
    const digest = { senderId: "A", sentAt: Date.now(), epoch: 0, entries: staleEntries, checksum: digestChecksum(staleEntries) };
    const envelope = await craftEnvelope(idA, {
      id: "stale-gossip-1",
      kind: "gossip",
      fromNodeId: "A",
      toNodeId: "B",
      seq: 999,
      nonce: "stale-incarnation-nonce",
      payload: digest,
    });
    wireA.send(JSON.stringify(envelope));
    await delay(30);

    expect(rejected).toEqual([{ reason: "stale-incarnation", fromNodeId: "A" }]);
    expect(routerB.stats().rejected["stale-incarnation"]).toBe(1);
    // The real merge actually refused it — B's view of A did not regress.
    expect(membershipB.get("A")?.incarnation).toBe(1);
  });

  it("converges three routers wired in a line (A-B-C) to the same membership view via relayed gossip", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const idC = makeIdentity("C");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const descC = makeDescriptor("C", idC.publicKeyHex);
    const membershipA = makeMembership(descA);
    const membershipB = makeMembership(descB);
    const membershipC = makeMembership(descC);

    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: membershipA }));
    const routerB = track(
      new FederationRouter({
        identity: idB,
        trust: pinnedTrust([
          { nodeId: "A", publicKeyHex: idA.publicKeyHex },
          { nodeId: "C", publicKeyHex: idC.publicKeyHex },
        ]),
        membership: membershipB,
      })
    );
    const routerC = track(new FederationRouter({ identity: idC, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: membershipC }));

    const { a: wireAB, b: wireBA } = pairedWires();
    const { a: wireBC, b: wireCB } = pairedWires();
    await Promise.all([
      connectPair(routerA, descA, wireAB, routerB, descB, wireBA),
      connectPair(routerB, descB, wireBC, routerC, descC, wireCB),
    ]);

    // A and C each tell B about themselves.
    await routerA.broadcastGossip();
    await routerC.broadcastGossip();
    await delay(30);
    expect(membershipB.nodes().map((n) => n.descriptor.nodeId).sort()).toEqual(["A", "B", "C"]);

    // B relays its now-complete view onward to both neighbors in one hop.
    await routerB.broadcastGossip();
    await delay(30);

    for (const m of [membershipA, membershipB, membershipC]) {
      expect(m.nodes().map((n) => n.descriptor.nodeId).sort()).toEqual(["A", "B", "C"]);
      expect(m.nodes().every((n) => n.health === "alive")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Offer / accept and results — genuine two-node round trip (item a)
// ---------------------------------------------------------------------------

describe("FederationRouter — offer/accept and results", () => {
  it("offer() round-trips a real accept and sendResult() ships a byte-identical certified result back (two-node round trip)", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex, { capabilities: ["compute"] });
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA) }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));

    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    const task = makeWorkerTask("task-rt-1");
    const lease = makeLease(task.id, "B", 1);
    const offer = makeClusterOffer(task, lease, "A");

    routerB.onOffer((o: ClusterOffer): ClusterAccept => {
      expect(o).toEqual(offer); // arrives byte-identical through the real signed envelope
      return { taskId: o.taskId, fencing: o.lease.fencing, nodeId: "B", accepted: true, at: Date.now() };
    });

    const accept = await routerA.offer("B", offer);
    expect(accept.accepted).toBe(true);
    expect(accept.nodeId).toBe("B");
    expect(accept.fencing).toBe(1);
    expect(routerA.stats().offersSent).toBe(1);
    expect(routerA.stats().offersAccepted).toBe(1);

    const ca = new CertificateAuthority(generatePrivateKeyHex());
    const entry = await makeCertifiedEntry(ca, task.id, "B", lease.fencing);

    const received: Array<{ entry: FederatedResultEntry; fromNodeId: string }> = [];
    routerA.onResult((e: FederatedResultEntry, fromNodeId: string) => {
      received.push({ entry: e, fromNodeId });
    });

    await routerB.sendResult("A", entry);
    await delay(30);

    expect(received).toHaveLength(1);
    expect(received[0].fromNodeId).toBe("B");
    expect(received[0].entry).toEqual(entry); // byte-identical, certificate included
    expect(routerB.stats().resultsSent).toBe(1);
    expect(routerA.stats().resultsReceived).toBe(1);
    expect(routerA.stats().resultsDeduped).toBe(0);
  });

  it("REFUSES a result whose entry.nodeId is not the AUTHENTICATED sender — a trusted peer cannot attribute its own work to another node", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({
        identity: idA,
        trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]),
        membership: makeMembership(descA),
      }),
    );
    const routerB = track(
      new FederationRouter({
        identity: idB,
        trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]),
        membership: makeMembership(descB),
      }),
    );
    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    const received: FederatedResultEntry[] = [];
    routerA.onResult((e: FederatedResultEntry) => {
      received.push(e);
    });
    const rejections: Array<{ reason: string; from: string }> = [];
    routerA.on("envelope:rejected", (reason: string, from: string) => {
      rejections.push({ reason, from });
    });

    // B mints a PERFECTLY VALID certificate over its own output — real
    // ed25519, really binds these bytes — but labels the entry as node "C"'s
    // work. Everything downstream of the wire would happily verify it: the
    // signature is genuine and it certifies exactly this output. Only the
    // router knows the frame was really signed by B.
    const ca = new CertificateAuthority(generatePrivateKeyHex());
    const impersonating = await makeCertifiedEntry(ca, "task-spoof", "C", 9);
    await routerB.sendResult("A", impersonating);
    await delay(40);

    expect(received).toHaveLength(0);
    expect(rejections.some((r) => r.reason === "result-node-mismatch" && r.from === "B")).toBe(true);
    expect(routerA.stats().rejected["result-node-mismatch"]).toBe(1);
    // It is refused, not silently swallowed into the received tally.
    expect(routerA.stats().resultsReceived).toBe(0);

    // The honest form of the same entry — B reporting B's own work — still
    // goes through, so the guard is not just "reject everything".
    const honest = await makeCertifiedEntry(ca, "task-spoof", "B", 9);
    await routerB.sendResult("A", honest);
    await delay(40);
    expect(received).toHaveLength(1);
    expect(received[0].nodeId).toBe("B");
  });

  it("offer() propagates an explicit refusal reason verbatim", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA) }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    const task = makeWorkerTask("task-refuse");
    const lease = makeLease(task.id, "B", 3);
    routerB.onOffer(() => ({ taskId: task.id, fencing: 3, nodeId: "B", accepted: false, refusal: "draining", at: Date.now() }));

    const accept = await routerA.offer("B", makeClusterOffer(task, lease, "A"));
    expect(accept).toEqual({ taskId: task.id, fencing: 3, nodeId: "B", accepted: false, refusal: "draining", at: accept.at });
    expect(routerA.stats().offersRefused).toBe(1);
  });

  it("offer() to an unresponsive (partitioned) peer resolves a refusal after timeout, rather than throwing", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA), requestTimeoutMs: 150 })
    );
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const { a: wireA, b: wireB, partition } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    routerB.onOffer(() => ({ taskId: "x", fencing: 1, nodeId: "B", accepted: true, at: Date.now() }));
    partition(); // the offer request will never reach B

    const task = makeWorkerTask("task-timeout");
    const lease = makeLease(task.id, "B", 1);
    const accept = await routerA.offer("B", makeClusterOffer(task, lease, "A"));

    expect(accept.accepted).toBe(false);
    expect(accept.refusal).toBe("unknown");
    expect(routerA.stats().offersRefused).toBe(1);
  }, 3000);
});

// ---------------------------------------------------------------------------
// Partition + heal — exact delivery counts across a real reconnect (item b)
// ---------------------------------------------------------------------------

describe("FederationRouter — partition + heal", () => {
  it("resumes result delivery after a real partition/heal cycle with no duplicate and no gap", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const fastLinkFactory = (opts: FederationLinkOptions): FederationLink => new FederationLink({ ...opts, heartbeatMs: 40 });

    const routerA = track(
      new FederationRouter({
        identity: idA,
        trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]),
        membership: makeMembership(descA),
        requestTimeoutMs: 150,
        linkFactory: fastLinkFactory,
      })
    );
    const routerB = track(
      new FederationRouter({
        identity: idB,
        trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]),
        membership: makeMembership(descB),
        requestTimeoutMs: 150,
        linkFactory: fastLinkFactory,
      })
    );

    const pair2 = pairedWires();
    const reconnectOptsForA = { attempts: 40, baseDelayMs: 15, maxDelayMs: 100, reconnectWire: async () => pair2.a };
    const reconnectOptsForB = { attempts: 40, baseDelayMs: 15, maxDelayMs: 100, reconnectWire: async () => pair2.b };
    await Promise.all([
      routerA.connect(descB, pair2.a, reconnectOptsForA),
      routerB.connect(descA, pair2.b, reconnectOptsForB),
    ]);

    const ca = new CertificateAuthority(generatePrivateKeyHex());
    const receivedOnB: FederatedResultEntry[] = [];
    routerB.onResult((e: FederatedResultEntry) => {
      receivedOnB.push(e);
    });

    const entry1 = await makeCertifiedEntry(ca, "task-1", "A", 1);
    const entry2 = await makeCertifiedEntry(ca, "task-2", "A", 2);

    await routerA.sendResult("B", entry1);
    await delay(60);
    expect(routerB.stats().resultsReceived).toBe(1);
    expect(routerB.stats().resultsDeduped).toBe(0);

    const readyAgain = new Promise<void>((resolve) => {
      const handler = (status: PeerStatus): void => {
        if (status.nodeId === "B") {
          routerA.off("peer:ready", handler);
          resolve();
        }
      };
      routerA.on("peer:ready", handler);
    });

    pair2.partition();
    await routerA.sendResult("B", entry2); // queues; the wire silently drops it while partitioned
    await delay(200); // let at least one heartbeat-timeout + failed reconnect attempt happen
    pair2.heal();

    await Promise.race([
      readyAgain,
      delay(4000).then(() => {
        throw new Error("timed out waiting for reconnect to resume after heal()");
      }),
    ]);
    await delay(150); // margin for the resumed flush to actually land

    // App-level retry of the *same* entry1 after the partition — must dedupe.
    await routerA.sendResult("B", entry1);
    await delay(60);

    expect(routerB.stats().resultsReceived).toBe(3); // entry1, entry2(resumed), entry1(retry)
    expect(routerB.stats().resultsDeduped).toBe(1);
    expect(receivedOnB).toHaveLength(2); // handler invoked exactly once per distinct entry
    expect(receivedOnB.map((e) => e.taskId).sort()).toEqual(["task-1", "task-2"]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Hostile peer matrix (item c)
// ---------------------------------------------------------------------------

describe("FederationRouter — hostile peer matrix", () => {
  async function connectedHostilePair() {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA) }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);
    const rejectedOnB: Array<{ reason: string; fromNodeId: string }> = [];
    routerB.on("envelope:rejected", (reason: string, fromNodeId: string) => rejectedOnB.push({ reason, fromNodeId }));
    const gossipOnB: unknown[] = [];
    routerB.on("gossip:received", (d: unknown) => gossipOnB.push(d));
    const resultsOnB: unknown[] = [];
    routerB.onResult((e: unknown) => {
      resultsOnB.push(e);
    });
    return { idA, idB, descA, descB, routerA, routerB, wireA, wireB, rejectedOnB, gossipOnB, resultsOnB };
  }

  it("wrong public key mid-session (key substitution on an already-bound link) is refused as key-mismatch", async () => {
    const { idB, wireA, routerB, rejectedOnB, gossipOnB, resultsOnB } = await connectedHostilePair();
    const attacker = makeIdentity("mallory");

    const forged = await craftEnvelope(attacker, {
      id: "forge-1",
      kind: "gossip",
      fromNodeId: "A", // claims to be the already-bound peer "A"
      toNodeId: "B",
      seq: 500,
      nonce: "key-mismatch-nonce",
      payload: { senderId: "A", sentAt: Date.now(), epoch: 0, entries: [], checksum: digestChecksum([]) },
    });
    wireA.send(JSON.stringify(forged));
    await delay(30);

    expect(rejectedOnB.some((r) => r.reason === "key-mismatch" && r.fromNodeId === "A")).toBe(true);
    expect(routerB.stats().rejected["key-mismatch"]).toBeGreaterThanOrEqual(1);
    expect(gossipOnB).toEqual([]);
    expect(resultsOnB).toEqual([]);
    void idB;
  });

  it("a tampered payload (broken signature) is refused as bad-signature and never dispatched", async () => {
    const { idA, wireA, routerB, rejectedOnB, gossipOnB } = await connectedHostilePair();

    const genuine = await craftEnvelope(idA, {
      id: "tamper-1",
      kind: "gossip",
      fromNodeId: "A",
      toNodeId: "B",
      seq: 501,
      nonce: "tamper-nonce",
      payload: { senderId: "A", sentAt: Date.now(), epoch: 0, entries: [], checksum: digestChecksum([]) },
    });
    const tampered: FederatedEnvelope = { ...genuine, payload: { senderId: "A", sentAt: Date.now(), epoch: 999, entries: [], checksum: digestChecksum([]) } };
    wireA.send(JSON.stringify(tampered));
    await delay(30);

    expect(rejectedOnB.some((r) => r.reason === "bad-signature" && r.fromNodeId === "A")).toBe(true);
    expect(gossipOnB).toEqual([]);
  });

  it("a byte-identical replayed envelope is refused as replay-nonce, and the handler runs only once", async () => {
    const { idA, wireA, routerB, rejectedOnB } = await connectedHostilePair();

    const envelope = await craftEnvelope(idA, {
      id: "replay-1",
      kind: "gossip",
      fromNodeId: "A",
      toNodeId: "B",
      seq: 502,
      nonce: "replay-once-nonce",
      payload: { senderId: "A", sentAt: Date.now(), epoch: 0, entries: [], checksum: digestChecksum([]) },
    });
    const frame = JSON.stringify(envelope);
    wireA.send(frame);
    await delay(20);
    wireA.send(frame); // exact replay
    await delay(20);

    expect(routerB.stats().gossipReceived).toBe(1);
    expect(rejectedOnB.some((r) => r.reason === "replay-nonce" && r.fromNodeId === "A")).toBe(true);
  });

  it("a regressed sequence number is refused as replay-seq", async () => {
    const { idA, wireA, routerA, routerB, rejectedOnB } = await connectedHostilePair();

    // Consume reliable seq 1 legitimately, so seq=1 is now stale.
    await routerA.broadcastGossip();
    await delay(20);

    const regressed = await craftEnvelope(idA, {
      id: "regressed-1",
      kind: "gossip",
      fromNodeId: "A",
      toNodeId: "B",
      seq: 1,
      nonce: "regressed-seq-nonce",
      payload: { senderId: "A", sentAt: Date.now(), epoch: 0, entries: [], checksum: digestChecksum([]) },
    });
    wireA.send(JSON.stringify(regressed));
    await delay(30);

    expect(rejectedOnB.some((r) => r.reason === "replay-seq" && r.fromNodeId === "A")).toBe(true);
    expect(routerB.stats().gossipReceived).toBe(1); // only the legitimate broadcast counted
  });

  it("malformed JSON is absorbed without throwing and never delivered (counted at the link)", async () => {
    const { wireA, routerA, routerB, gossipOnB, resultsOnB } = await connectedHostilePair();

    expect(() => wireA.send("{not valid json")).not.toThrow();
    expect(() => wireA.send("")).not.toThrow();
    await delay(30);

    expect(gossipOnB).toEqual([]);
    expect(resultsOnB).toEqual([]);
    const peerStatus = routerB.peers().find((p) => p.nodeId === "A");
    expect(peerStatus?.stats.rejected.malformed ?? 0).toBeGreaterThanOrEqual(1);
    void routerA;
  });

  it("an envelope claiming another node's fromNodeId on an already-bound link is refused as wrong-peer", async () => {
    const { idA, wireA, routerB, rejectedOnB, gossipOnB } = await connectedHostilePair();

    const impersonating = await craftEnvelope(idA, {
      id: "wrong-peer-1",
      kind: "gossip",
      fromNodeId: "phantom-node", // B's link is bound to "A", not this
      toNodeId: "B",
      seq: 503,
      nonce: "wrong-peer-nonce",
      payload: { senderId: "phantom-node", sentAt: Date.now(), epoch: 0, entries: [], checksum: digestChecksum([]) },
    });
    wireA.send(JSON.stringify(impersonating));
    await delay(30);

    expect(rejectedOnB.some((r) => r.reason === "wrong-peer")).toBe(true);
    expect(gossipOnB).toEqual([]);
  });

  it("an oversized frame over a real TCP socket is destroyed by the framing cap before it ever reaches the router", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA) }));
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));

    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

    const serverSocketPromise = once(server, "connection") as Promise<[Socket]>;
    const clientSocket = netConnect({ host: "127.0.0.1", port: address.port });
    clientSocket.on("error", () => undefined);
    await once(clientSocket, "connect");
    const [serverSocket] = await serverSocketPromise;
    serverSocket.on("error", () => undefined);

    const gossipOnB: unknown[] = [];
    routerB.on("gossip:received", (d: unknown) => gossipOnB.push(d));
    const closedOnB: Array<[string, string]> = [];
    routerB.on("peer:closed", (nodeId: string, reason: string) => closedOnB.push([nodeId, reason]));

    await connectPair(routerA, descA, socketWire(clientSocket), routerB, descB, socketWire(serverSocket, { maxFrameBytes: 4096 }));
    // A simultaneous bidirectional handshake can leave one last control frame
    // (the echoed "welcome") still in flight over the real socket even after
    // both connect() promises resolve (each side's handshake only needs to
    // receive *one* of the two triggering envelopes) — let it land before
    // taking the baseline so it isn't mistaken for post-attack traffic.
    await delay(50);
    const baselineReceived = routerB.peers().find((p) => p.nodeId === "A")?.stats.received ?? 0;

    // Declare an oversized frame length (well over the 4KiB cap) directly on
    // the raw socket, bypassing socketWire.send entirely — this is exactly
    // what a hostile peer controlling the raw bytes could do.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1024 * 1024, 0);
    clientSocket.write(header);
    clientSocket.write(Buffer.from("not nearly the declared 1MiB"));
    await delay(80);

    expect(gossipOnB).toEqual([]);
    const afterReceived = routerB.peers().find((p) => p.nodeId === "A")?.stats.received ?? baselineReceived;
    expect(afterReceived).toBe(baselineReceived);
    expect(closedOnB.length).toBeGreaterThanOrEqual(1);
    expect(closedOnB[0][0]).toBe("A");

    clientSocket.destroy();
    serverSocket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Backpressure / liveness (item e)
// ---------------------------------------------------------------------------

describe("FederationRouter — backpressure and liveness", () => {
  it("bounds memory against a peer that stops acking: drops are counted, not unbounded growth", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA), sendQueueLimit: 3 })
    );
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const { a: wireA, b: wireB, partition } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    partition(); // B stops acking anything from here on

    const ca = new CertificateAuthority(generatePrivateKeyHex());
    for (let i = 0; i < 6; i++) {
      await routerA.sendResult("B", await makeCertifiedEntry(ca, `task-bp-${i}`, "A", i + 1));
    }
    await delay(30);

    const status = routerA.peers().find((p) => p.nodeId === "B");
    expect(status?.stats.queued).toBe(3);
    expect(status?.stats.dropped).toBe(3);
  });

  it("broadcastGossip() completes promptly and is not blocked by one stuck peer", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const idD = makeIdentity("D");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const descD = makeDescriptor("D", idD.publicKeyHex);
    const routerA = track(
      new FederationRouter({
        identity: idA,
        trust: pinnedTrust([
          { nodeId: "B", publicKeyHex: idB.publicKeyHex },
          { nodeId: "D", publicKeyHex: idD.publicKeyHex },
        ]),
        membership: makeMembership(descA),
      })
    );
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const routerD = track(new FederationRouter({ identity: idD, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descD) }));

    const { a: wireAB, b: wireBA } = pairedWires();
    const { a: wireAD, b: wireDA, partition } = pairedWires();
    await Promise.all([
      connectPair(routerA, descA, wireAB, routerB, descB, wireBA),
      connectPair(routerA, descA, wireAD, routerD, descD, wireDA),
    ]);
    partition(); // D goes silent

    const startedAt = Date.now();
    const outcome = await routerA.broadcastGossip();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500); // never waits on D's (nonexistent) ack
    expect(outcome.sent.sort()).toEqual(["B", "D"]);
    expect(outcome.failed).toEqual([]);
  });

  it("close() mid-request resolves a pending offer() with a refusal instead of hanging", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const routerA = track(
      new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA), requestTimeoutMs: 5000 })
    );
    const routerB = track(new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB) }));
    const { a: wireA, b: wireB } = pairedWires();
    await connectPair(routerA, descA, wireA, routerB, descB, wireB);

    // B "accepts" the offer but never actually replies — request stays pending.
    routerB.onOffer(() => new Promise<ClusterAccept>(() => undefined));

    const task = makeWorkerTask("task-hang");
    const lease = makeLease(task.id, "B", 1);
    const pending = routerA.offer("B", makeClusterOffer(task, lease, "A"));
    await delay(30); // ensure the request envelope is actually in flight

    const start = Date.now();
    await routerA.close();
    const result = await pending;
    const elapsed = Date.now() - start;

    expect(result.accepted).toBe(false);
    expect(result.refusal).toBe("unknown");
    expect(elapsed).toBeLessThan(500); // resolved by close(), not by the 5s request timeout
  });
});

// ---------------------------------------------------------------------------
// No leaked timers after close() (item g)
// ---------------------------------------------------------------------------

describe("FederationRouter — resource cleanup", () => {
  it("close() clears the link's heartbeat timer — no further wire activity after shutdown", async () => {
    const idA = makeIdentity("A");
    const idB = makeIdentity("B");
    const descA = makeDescriptor("A", idA.publicKeyHex);
    const descB = makeDescriptor("B", idB.publicKeyHex);
    const fastLinkFactory = (opts: FederationLinkOptions): FederationLink => new FederationLink({ ...opts, heartbeatMs: 30 });
    const routerA = track(
      new FederationRouter({ identity: idA, trust: pinnedTrust([{ nodeId: "B", publicKeyHex: idB.publicKeyHex }]), membership: makeMembership(descA), linkFactory: fastLinkFactory })
    );
    const routerB = track(
      new FederationRouter({ identity: idB, trust: pinnedTrust([{ nodeId: "A", publicKeyHex: idA.publicKeyHex }]), membership: makeMembership(descB), linkFactory: fastLinkFactory })
    );

    const pair = pairedWires();
    let closed = false;
    let framesAfterClose = 0;
    const tappedWireA: Wire & { onClose: (h: (err?: Error) => void) => void; close: () => void } = {
      send(frame: string): void {
        if (closed) framesAfterClose++;
        pair.a.send(frame);
      },
      onFrame(h: (frame: string) => void): void {
        pair.a.onFrame(h);
      },
      onClose(h: (err?: Error) => void): void {
        (pair.a as unknown as { onClose: (h: (err?: Error) => void) => void }).onClose(h);
      },
      close(): void {
        (pair.a as unknown as { close: () => void }).close();
      },
    };

    await connectPair(routerA, descA, tappedWireA, routerB, descB, pair.b);
    await delay(100); // let a couple of real heartbeats fire pre-close
    const framesBeforeClose = framesAfterClose;
    expect(framesBeforeClose).toBe(0); // (closed flag not yet set — sanity)

    await routerA.close();
    closed = true;
    await delay(150); // well past several 30ms heartbeat intervals

    expect(framesAfterClose).toBe(0);
  });
});
