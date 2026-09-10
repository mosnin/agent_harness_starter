import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../hades/styx/certificate";
import {
  ClusterMembership,
  electLeader,
  type GossipDigest,
  type GossipEntry,
  type LeaderView,
  type NodeDescriptor,
  type NodeState,
} from "../membership";
import type { IsolationKind } from "../../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Deterministic mutable clock injected as `now` — never Date.now / sleep. */
class VirtualClock {
  value = 0;
  now = (): number => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

function mkDescriptor(nodeId: string, overrides: Partial<NodeDescriptor> = {}): NodeDescriptor {
  return {
    nodeId,
    managerUrl: `https://${nodeId}.internal:9443`,
    capabilities: ["exec", "verify"],
    capacity: { maxWorkers: 4, providerKinds: ["process"] as IsolationKind[] },
    publicKeyHex: `pk-${nodeId}`,
    startedAt: 0,
    ...overrides,
  };
}

function mkEntry(partial: Partial<GossipEntry> & { nodeId: string }): GossipEntry {
  return { incarnation: 0, health: "alive", load: 0, liveWorkers: 0, ...partial };
}

// Mirrors membership.ts's internal canonical-json + sha256 checksum exactly,
// so tests can hand-craft digests (including adversarial ones) that pass the
// integrity check and exercise the entry-level validation logic underneath.
function stableJsonForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJsonForTest(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonForTest(record[k])}`).join(",")}}`;
}
function checksumFor(entries: GossipEntry[]): string {
  return sha256Hex(stableJsonForTest(entries));
}

function mkDigest(
  senderId: string,
  entries: GossipEntry[],
  overrides: Partial<Pick<GossipDigest, "sentAt" | "epoch" | "checksum">> = {},
): GossipDigest {
  return {
    senderId,
    sentAt: overrides.sentAt ?? 0,
    epoch: overrides.epoch ?? 0,
    entries,
    checksum: overrides.checksum ?? checksumFor(entries),
  };
}

/** Full-mesh anti-entropy round: every member applies every other member's digest. */
function gossipRound(members: ClusterMembership[]): void {
  const digests = members.map((m) => m.digest());
  for (let i = 0; i < members.length; i++) {
    for (let j = 0; j < members.length; j++) {
      if (i === j) continue;
      members[i].apply(digests[j]);
    }
  }
}

function meshJoin(members: Map<string, ClusterMembership>): void {
  for (const [id, m] of members) {
    for (const [otherId, other] of members) {
      if (id !== otherId) m.join(other.self().descriptor);
    }
  }
}

// Seeded PRNG (mulberry32) — deterministic, no external dependency.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Construction & basic accessors
// ---------------------------------------------------------------------------

describe("ClusterMembership — construction & accessors", () => {
  it("seeds a self entry as alive at incarnation 0", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now });
    const s = m.self();
    expect(s.health).toBe("alive");
    expect(s.incarnation).toBe(0);
    expect(s.descriptor.nodeId).toBe("a");
    expect(m.nodes()).toHaveLength(1);
    expect(m.alive().map((n) => n.descriptor.nodeId)).toEqual(["a"]);
    expect(m.get("nonexistent")).toBeUndefined();
  });

  it("get() and nodes() return defensive copies", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const s1 = m.get("a")!;
    s1.health = "dead";
    expect(m.get("a")!.health).toBe("alive");
    const arr = m.nodes();
    arr[0].incarnation = 999;
    expect(m.get("a")!.incarnation).toBe(0);
  });

  it("rejects an invalid suspect/dead threshold configuration", () => {
    expect(() => new ClusterMembership({ self: mkDescriptor("a"), suspectAfterMs: 0 })).toThrow(RangeError);
    expect(
      () => new ClusterMembership({ self: mkDescriptor("a"), suspectAfterMs: 5000, deadAfterMs: 5000 }),
    ).toThrow(RangeError);
  });

  it("a single-node cluster is its own majority leader", () => {
    const m = new ClusterMembership({ self: mkDescriptor("solo"), now: () => 0 });
    expect(m.isLeader()).toBe(true);
    expect(m.election()).toMatchObject({ leaderId: "solo", quorum: true });
  });
});

// ---------------------------------------------------------------------------
// join()
// ---------------------------------------------------------------------------

describe("ClusterMembership.join()", () => {
  it("registers a brand new node as alive and fires node:joined exactly once", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const events: string[] = [];
    m.on("node:joined", (n: NodeState) => events.push(n.descriptor.nodeId));
    m.join(mkDescriptor("b"));
    expect(m.get("b")?.health).toBe("alive");
    expect(events).toEqual(["b"]);
  });

  it("throws when asked to join self", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    expect(() => m.join(mkDescriptor("a"))).toThrow();
  });

  it("re-joining an already-alive node is a silent no-op (no duplicate event)", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const joined: string[] = [];
    m.on("node:joined", (n: NodeState) => joined.push(n.descriptor.nodeId));
    m.join(mkDescriptor("b"));
    m.join(mkDescriptor("b"));
    expect(joined).toEqual(["b"]);
    expect(m.get("b")?.incarnation).toBe(0);
  });

  it("rejoining a dead/suspect node bumps incarnation and fires node:recovered exactly once", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({
      self: mkDescriptor("a"),
      now: clock.now,
      suspectAfterMs: 100,
      deadAfterMs: 200,
    });
    m.join(mkDescriptor("b"));
    clock.advance(1000);
    const changes = m.tick();
    expect(changes.map((c) => c.to)).toEqual(["suspect", "dead"]);

    const recovered: string[] = [];
    m.on("node:recovered", (n: NodeState) => recovered.push(n.descriptor.nodeId));
    m.join(mkDescriptor("b"));
    expect(recovered).toEqual(["b"]);
    expect(m.get("b")?.health).toBe("alive");
    expect(m.get("b")?.incarnation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tick() — suspect/dead promotion driven purely by injected clock
// ---------------------------------------------------------------------------

describe("ClusterMembership.tick()", () => {
  it("promotes alive -> suspect -> dead only as the virtual clock advances, never on its own", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({
      self: mkDescriptor("a"),
      now: clock.now,
      suspectAfterMs: 1000,
      deadAfterMs: 3000,
    });
    m.join(mkDescriptor("b"));

    expect(m.tick()).toEqual([]); // no time elapsed
    clock.advance(500);
    expect(m.tick()).toEqual([]); // still under suspect threshold

    clock.advance(600); // total 1100 > 1000
    const c1 = m.tick();
    expect(c1).toEqual([{ nodeId: "b", from: "alive", to: "suspect", at: 1100 }]);
    expect(m.get("b")?.health).toBe("suspect");

    clock.advance(1000); // total 2100, still < 3000
    expect(m.tick()).toEqual([]);

    clock.advance(1000); // total 3100 > 3000
    const c2 = m.tick();
    expect(c2).toEqual([{ nodeId: "b", from: "suspect", to: "dead", at: 3100 }]);
    expect(m.get("b")?.health).toBe("dead");

    // Dead is terminal under tick(): no further transitions, ever.
    clock.advance(100000);
    expect(m.tick()).toEqual([]);
  });

  it("cascades alive -> suspect -> dead within a single tick() call after a large time jump", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({
      self: mkDescriptor("a"),
      now: clock.now,
      suspectAfterMs: 1000,
      deadAfterMs: 3000,
    });
    m.join(mkDescriptor("b"));
    clock.advance(10_000);
    const changes = m.tick();
    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual(["alive->suspect", "suspect->dead"]);
    expect(m.get("b")?.health).toBe("dead");
  });

  it("never marks self suspect or dead", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now, suspectAfterMs: 10, deadAfterMs: 20 });
    clock.advance(100000);
    expect(m.tick()).toEqual([]);
    expect(m.self().health).toBe("alive");
  });

  it("emits each transition exactly once — no duplicate events across repeated ticks", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now, suspectAfterMs: 100, deadAfterMs: 300 });
    m.join(mkDescriptor("b"));
    const suspectEvents: string[] = [];
    const deadEvents: string[] = [];
    m.on("node:suspect", (n: NodeState) => suspectEvents.push(n.descriptor.nodeId));
    m.on("node:dead", (n: NodeState) => deadEvents.push(n.descriptor.nodeId));

    clock.advance(150);
    m.tick();
    m.tick();
    m.tick();
    clock.advance(400);
    m.tick();
    m.tick();

    expect(suspectEvents).toEqual(["b"]);
    expect(deadEvents).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// digest() / apply() round trip + idempotency
// ---------------------------------------------------------------------------

describe("ClusterMembership.digest() / apply()", () => {
  it("propagates a join to a peer via digest/apply", () => {
    const clock = new VirtualClock();
    const a = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now });
    const b = new ClusterMembership({ self: mkDescriptor("b"), now: clock.now });
    a.join(mkDescriptor("c"));

    const result = b.apply(a.digest());
    expect(result.rejected).toEqual([]);
    expect(b.get("a")?.health).toBe("alive");
    expect(b.get("c")?.health).toBe("alive");
    expect(result.applied).toBeGreaterThan(0);
  });

  it("apply() is fully idempotent: re-applying the same digest yields zero changes and emits nothing", () => {
    const clock = new VirtualClock();
    const a = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now });
    const b = new ClusterMembership({ self: mkDescriptor("b"), now: clock.now });
    a.join(mkDescriptor("c"));
    const d = a.digest();

    b.apply(d);
    const anyEvent = trackAnyEvent(b);
    const r2 = b.apply(d);

    expect(r2.applied).toBe(0);
    expect(r2.rejected).toEqual([]);
    expect(r2.changes).toEqual([]);
    expect(anyEvent.fired).toBe(false);
  });

  it("digest() output is deterministic and stable across repeated calls with no state change", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 42 });
    m.join(mkDescriptor("b"));
    m.join(mkDescriptor("c"));
    expect(m.digest()).toEqual(m.digest());
  });

  it("rejects a digest whose checksum has been tampered with (malformed)", () => {
    const a = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const b = new ClusterMembership({ self: mkDescriptor("b"), now: () => 0 });
    a.join(mkDescriptor("c"));
    const tampered = a.digest();
    tampered.entries[0] = { ...tampered.entries[0], load: 999999 };
    const result = b.apply(tampered);
    expect(result.applied).toBe(0);
    expect(result.rejected.every((r) => r.reason === "malformed")).toBe(true);
    expect(result.rejected.length).toBe(tampered.entries.length);
  });

  it("rejects an entry for an unknown node with no descriptor attached", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const entries = [mkEntry({ nodeId: "ghost", incarnation: 0, health: "alive" })];
    const result = m.apply(mkDigest("ghost", entries));
    expect(result.rejected).toEqual([{ nodeId: "ghost", reason: "unknown-node" }]);
    expect(result.applied).toBe(0);
    expect(m.get("ghost")).toBeUndefined();
  });

  it("rejects structurally malformed entries (bad shape) without throwing", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const badEntries = [
      { nodeId: "x", incarnation: -1, health: "alive", load: 0, liveWorkers: 0 } as GossipEntry,
      { nodeId: "", incarnation: 0, health: "alive", load: 0, liveWorkers: 0 } as GossipEntry,
      { nodeId: "y", incarnation: 0, health: "not-a-health" as unknown as "alive", load: 0, liveWorkers: 0 },
    ];
    const result = m.apply(mkDigest("attacker", badEntries));
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason === "malformed")).toBe(true);
  });

  it("rejects a digest whose sentAt is outside the allowed clock-skew window", () => {
    const clock = new VirtualClock();
    clock.value = 1_000_000;
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now, maxClockSkewMs: 5_000 });
    const entries = [mkEntry({ nodeId: "b", incarnation: 0, health: "alive", descriptor: mkDescriptor("b") })];
    const farFuture = mkDigest("b", entries, { sentAt: clock.value + 100_000 });
    const result = m.apply(farFuture);
    expect(result.rejected.every((r) => r.reason === "clock-skew")).toBe(true);
    expect(result.applied).toBe(0);
    expect(m.get("b")).toBeUndefined(); // far-future claim never granted liveness
  });

  it("caps digest entries deterministically, prioritizing self then most severe health, tie-broken by nodeId", () => {
    const m = new ClusterMembership({ self: mkDescriptor("self"), now: () => 0, maxDigestEntries: 2 });
    m.join(mkDescriptor("alive-node"));
    m.join(mkDescriptor("dead-node"));
    m.join(mkDescriptor("suspect-node"));

    // Drive health directly via apply() (higher incarnation always wins),
    // avoiding any dependency on tick() timing.
    m.apply(mkDigest("dead-node", [mkEntry({ nodeId: "dead-node", incarnation: 1, health: "dead" })]));
    m.apply(mkDigest("suspect-node", [mkEntry({ nodeId: "suspect-node", incarnation: 1, health: "suspect" })]));

    expect(m.get("dead-node")?.health).toBe("dead");
    expect(m.get("suspect-node")?.health).toBe("suspect");
    expect(m.get("alive-node")?.health).toBe("alive");

    const d1 = m.digest();
    expect(d1.entries).toHaveLength(2);
    expect(d1.entries[0].nodeId).toBe("self");
    expect(d1.entries[1].nodeId).toBe("dead-node"); // dead outranks suspect/alive

    const d2 = m.digest();
    expect(d2.entries).toEqual(d1.entries);
  });
});

// ---------------------------------------------------------------------------
// Incarnation monotonicity & identity pinning (adversarial)
// ---------------------------------------------------------------------------

describe("ClusterMembership — adversarial gossip handling", () => {
  it("rejects a rolled-back incarnation (incarnation rollback attack)", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const bDesc = mkDescriptor("b");
    m.apply(mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 5, health: "alive", descriptor: bDesc })]));
    expect(m.get("b")?.incarnation).toBe(5);

    const rollback = mkDigest("attacker", [mkEntry({ nodeId: "b", incarnation: 2, health: "alive", descriptor: bDesc })]);
    const result = m.apply(rollback);
    expect(result.rejected).toEqual([{ nodeId: "b", reason: "stale-incarnation" }]);
    expect(m.get("b")?.incarnation).toBe(5);
  });

  it("rejects a replayed stale digest after fresher state has already been learned", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const bDesc = mkDescriptor("b");
    const stale = mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 1, health: "alive", descriptor: bDesc })]);
    m.apply(stale);
    m.apply(mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 4, health: "alive", descriptor: bDesc })]));
    expect(m.get("b")?.incarnation).toBe(4);

    // Replay of the old captured digest, well after fresher info arrived.
    const replay = m.apply(stale);
    expect(replay.applied).toBe(0);
    expect(replay.changes).toEqual([]);
    expect(m.get("b")?.incarnation).toBe(4);
  });

  it("never lets gossip mutate the self entry: forged suspect/dead of self is rejected and triggers refutation", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("me"), now: clock.now });
    const initialIncarnation = m.self().incarnation;
    const recovered: unknown[] = [];
    m.on("node:recovered", (n) => recovered.push(n));

    const forged = mkDigest("attacker", [mkEntry({ nodeId: "me", incarnation: initialIncarnation, health: "dead" })]);
    const result = m.apply(forged);

    expect(result.rejected).toEqual([{ nodeId: "me", reason: "self-downgrade" }]);
    expect(result.applied).toBe(0);
    expect(m.self().health).toBe("alive");
    expect(m.self().incarnation).toBe(initialIncarnation + 1);
    // Self was already alive, so no visible health transition — no recovered event.
    expect(recovered).toEqual([]);
  });

  it("refutes repeated forged downgrades, incarnation strictly climbing each time", () => {
    const m = new ClusterMembership({ self: mkDescriptor("me"), now: () => 0 });
    const before = m.self().incarnation;
    m.apply(mkDigest("attacker1", [mkEntry({ nodeId: "me", incarnation: before, health: "suspect" })]));
    m.apply(mkDigest("attacker2", [mkEntry({ nodeId: "me", incarnation: before + 1, health: "dead" })]));
    expect(m.self().incarnation).toBe(before + 2);
    expect(m.self().health).toBe("alive");
  });

  it("silently ignores non-downgrade gossip about self without mutating it", () => {
    const m = new ClusterMembership({ self: mkDescriptor("me"), now: () => 0 });
    const before = m.self();
    const result = m.apply(mkDigest("peer", [mkEntry({ nodeId: "me", incarnation: 999, health: "alive" })]));
    expect(result.applied).toBe(0);
    expect(result.rejected).toEqual([]);
    expect(m.self()).toEqual(before);
  });

  it("rejects a byzantine descriptor mutation (identity-mismatch) even at a much higher incarnation", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const genuine = mkDescriptor("b", { publicKeyHex: "pk-genuine" });
    m.apply(mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 1, health: "alive", descriptor: genuine })]));

    const forged = mkDescriptor("b", { publicKeyHex: "pk-attacker", managerUrl: "https://evil.example" });
    const attack = mkDigest("attacker", [mkEntry({ nodeId: "b", incarnation: 999, health: "alive", descriptor: forged })]);
    const result = m.apply(attack);

    expect(result.rejected).toEqual([{ nodeId: "b", reason: "identity-mismatch" }]);
    expect(m.get("b")?.descriptor.publicKeyHex).toBe("pk-genuine");
    expect(m.get("b")?.incarnation).toBe(1);
  });

  it("allows a legitimate non-identity descriptor update (e.g. capacity change) at a higher incarnation", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const original = mkDescriptor("b");
    m.apply(mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 1, health: "alive", descriptor: original })]));
    const updated = mkDescriptor("b", { capacity: { maxWorkers: 16, providerKinds: ["docker"] as IsolationKind[] } });
    const result = m.apply(mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 2, health: "alive", descriptor: updated })]));
    expect(result.rejected).toEqual([]);
    expect(m.get("b")?.descriptor.capacity.maxWorkers).toBe(16);
  });

  it("a node that dies and rejoins with a strictly higher incarnation is revived (node:recovered fires once)", () => {
    const clock = new VirtualClock();
    const a = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now, suspectAfterMs: 100, deadAfterMs: 300 });
    const bDesc = mkDescriptor("b");
    a.join(bDesc);
    clock.advance(1000);
    a.tick();
    expect(a.get("b")?.health).toBe("dead");

    const recovered: string[] = [];
    a.on("node:recovered", (n: NodeState) => recovered.push(n.descriptor.nodeId));

    const rejoin = mkDigest("b", [mkEntry({ nodeId: "b", incarnation: 1, health: "alive", descriptor: bDesc })], {
      sentAt: clock.value,
    });
    const result = a.apply(rejoin);

    expect(result.changes).toEqual([{ nodeId: "b", from: "dead", to: "alive", at: clock.value }]);
    expect(recovered).toEqual(["b"]);
    expect(a.get("b")?.health).toBe("alive");
    expect(a.get("b")?.incarnation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------

describe("electLeader() — pure function", () => {
  function state(nodeId: string, health: NodeState["health"]): NodeState {
    return {
      descriptor: mkDescriptor(nodeId),
      health,
      incarnation: 0,
      lastSeenAt: 0,
      load: 0,
      liveWorkers: 0,
    };
  }

  it("picks the lexicographically smallest alive nodeId as leader when quorum holds", () => {
    const nodes = [state("c", "alive"), state("a", "alive"), state("b", "alive")];
    const view = electLeader(nodes, { quorum: "majority", epoch: 7, knownSize: 3 });
    expect(view).toEqual({ leaderId: "a", epoch: 7, quorum: true, voters: ["a", "b", "c"] });
  });

  it("elects no leader when the alive set does not form a majority of knownSize", () => {
    const nodes = [state("a", "alive"), state("b", "dead"), state("c", "dead")];
    const view = electLeader(nodes, { quorum: "majority", epoch: 1, knownSize: 3 });
    expect(view.quorum).toBe(false);
    expect(view.leaderId).toBeNull();
  });

  it("'single' quorum policy accepts any non-empty alive set", () => {
    const nodes = [state("a", "alive")];
    const view = electLeader(nodes, { quorum: "single", epoch: 0, knownSize: 5 });
    expect(view.quorum).toBe(true);
    expect(view.leaderId).toBe("a");
  });

  it("no leader when there are zero alive nodes at all", () => {
    const view = electLeader([], { quorum: "majority", epoch: 0, knownSize: 0 });
    expect(view.leaderId).toBeNull();
    expect(view.quorum).toBe(false);
  });
});

describe("ClusterMembership — leadership integration", () => {
  it("emits leader:changed exactly once per actual leader transition, never on a no-op change", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("z"), now: clock.now, suspectAfterMs: 100, deadAfterMs: 300 });
    const changes: Array<string | null> = [];
    m.on("leader:changed", (v: LeaderView) => changes.push(v.leaderId));

    m.join(mkDescriptor("a")); // "a" < "z" lexicographically -> leader flips to "a"
    m.join(mkDescriptor("m")); // leader stays "a" -> no new event
    clock.advance(1000);
    m.tick(); // both "a" and "m" time out -> only "z" alive out of 3 known -> no quorum

    expect(changes).toEqual(["a", null]);
  });

  it("election flips deterministically as membership changes, with epoch fencing", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("z"), now: clock.now, suspectAfterMs: 100, deadAfterMs: 300 });
    const epoch0 = m.election().epoch;
    expect(m.election().leaderId).toBe("z");

    m.join(mkDescriptor("a"));
    const view1 = m.election();
    expect(view1.leaderId).toBe("a");
    expect(view1.epoch).toBeGreaterThan(epoch0);

    clock.advance(1000);
    m.tick(); // "a" dies (never refreshed) -> only 1 of 2 known nodes alive -> no quorum
    const view2 = m.election();
    expect(view2.leaderId).toBeNull();
    expect(view2.quorum).toBe(false);
    expect(view2.epoch).toBeGreaterThan(view1.epoch);
  });

  it("isLeader() reflects the current election outcome", () => {
    const clock = new VirtualClock();
    const z = new ClusterMembership({ self: mkDescriptor("z"), now: clock.now });
    expect(z.isLeader()).toBe(true);
    z.join(mkDescriptor("a"));
    expect(z.isLeader()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Partition scenarios (the core distributed-systems adversarial suite)
// ---------------------------------------------------------------------------

describe("ClusterMembership — partition tolerance", () => {
  it("2-2 partition: zero leaders on both sides", () => {
    const clock = new VirtualClock();
    const ids = ["a", "b", "c", "d"];
    const members = new Map(
      ids.map((id) => [
        id,
        new ClusterMembership({ self: mkDescriptor(id), now: clock.now, suspectAfterMs: 500, deadAfterMs: 1500 }),
      ]),
    );
    meshJoin(members);

    // Pre-partition: full mesh of 4, majority = 3, quorum holds.
    expect(members.get("a")!.election().quorum).toBe(true);

    const group1 = ["a", "b"];
    const group2 = ["c", "d"];

    // Simulate the partition: only in-group gossip continues, refreshing
    // in-group liveness; cross-group members simply stop hearing anything
    // and age out via tick().
    for (let round = 0; round < 4; round++) {
      gossipRound(group1.map((id) => members.get(id)!));
      gossipRound(group2.map((id) => members.get(id)!));
      clock.advance(400); // < suspectAfterMs per round, keeps in-group fresh
      for (const id of ids) members.get(id)!.tick();
    }

    for (const id of ids) {
      const view = members.get(id)!.election();
      expect(view.quorum).toBe(false);
      expect(view.leaderId).toBeNull();
    }
  });

  it("3-2 partition: exactly one leader on the majority side, minority stays leaderless", () => {
    const clock = new VirtualClock();
    const ids = ["a", "b", "c", "d", "e"];
    const members = new Map(
      ids.map((id) => [
        id,
        new ClusterMembership({ self: mkDescriptor(id), now: clock.now, suspectAfterMs: 500, deadAfterMs: 1500 }),
      ]),
    );
    meshJoin(members);

    const majority = ["a", "b", "c"];
    const minority = ["d", "e"];

    for (let round = 0; round < 4; round++) {
      gossipRound(majority.map((id) => members.get(id)!));
      gossipRound(minority.map((id) => members.get(id)!));
      clock.advance(400);
      for (const id of ids) members.get(id)!.tick();
    }

    const majorityLeaders = new Set(majority.map((id) => members.get(id)!.election().leaderId));
    expect(majorityLeaders.size).toBe(1);
    const leader = [...majorityLeaders][0];
    expect(leader).not.toBeNull();
    expect(majority).toContain(leader);
    for (const id of majority) {
      expect(members.get(id)!.election().quorum).toBe(true);
    }

    for (const id of minority) {
      const view = members.get(id)!.election();
      expect(view.quorum).toBe(false);
      expect(view.leaderId).toBeNull();
    }
  });

  it("heals a partition and converges to a single deterministic leader across all nodes", () => {
    const clock = new VirtualClock();
    const ids = ["a", "b", "c", "d", "e"];
    const members = new Map(
      ids.map((id) => [
        id,
        new ClusterMembership({ self: mkDescriptor(id), now: clock.now, suspectAfterMs: 500, deadAfterMs: 1500 }),
      ]),
    );
    meshJoin(members);

    const groupA = ["a", "b", "c"];
    const groupB = ["d", "e"];

    for (let round = 0; round < 4; round++) {
      gossipRound(groupA.map((id) => members.get(id)!));
      gossipRound(groupB.map((id) => members.get(id)!));
      clock.advance(400);
      for (const id of ids) members.get(id)!.tick();
    }

    // Confirm the partition actually took effect first.
    expect(members.get("d")!.election().quorum).toBe(false);

    // Heal: resume full-mesh gossip. The wrongly-"dead" nodes will see
    // themselves marked dead in an incoming digest, self-refute (bump their
    // own incarnation), and their next digest will carry that higher
    // incarnation back to the other side, reviving them there too.
    for (let round = 0; round < 6; round++) {
      clock.advance(50);
      gossipRound(ids.map((id) => members.get(id)!));
    }

    for (const id of ids) {
      expect(members.get(id)!.alive().map((n) => n.descriptor.nodeId).sort()).toEqual(ids);
    }

    const leaders = new Set(ids.map((id) => members.get(id)!.election().leaderId));
    expect(leaders.size).toBe(1);
    expect([...leaders][0]).toBe("a"); // deterministic: lexicographically smallest
    for (const id of ids) {
      expect(members.get(id)!.election().quorum).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Randomized digest-arrival-order convergence (property test)
// ---------------------------------------------------------------------------

describe("ClusterMembership — order-independent convergence", () => {
  it("converges to the identical membership view regardless of digest arrival order (seeded)", () => {
    // Build a pool of facts for 4 remote nodes. For each node, the facts are
    // an evolving sequence of (incarnation, health) pairs — only the fact
    // with the greatest (incarnation, healthRank) key should survive, no
    // matter what order all facts across all nodes are applied in.
    const nodeIds = ["n1", "n2", "n3", "n4"];
    const descriptors = new Map(nodeIds.map((id) => [id, mkDescriptor(id)]));

    // Every fact carries its descriptor (realistic: a full-state digest
    // entry always includes it) so that no matter which fact about a given
    // node happens to be applied *first* in a given shuffle, the node can
    // always be created — isolating the property under test (order-
    // independent convergence of the incarnation/health merge) from the
    // separate, intentional "unknown-node" behavior covered elsewhere.
    const factsByNode: Record<string, GossipEntry[]> = {
      n1: [
        mkEntry({ nodeId: "n1", incarnation: 0, health: "alive", descriptor: descriptors.get("n1") }),
        mkEntry({ nodeId: "n1", incarnation: 0, health: "suspect", descriptor: descriptors.get("n1") }),
        mkEntry({ nodeId: "n1", incarnation: 1, health: "alive", descriptor: descriptors.get("n1") }),
      ],
      n2: [
        mkEntry({ nodeId: "n2", incarnation: 0, health: "alive", descriptor: descriptors.get("n2") }),
        mkEntry({ nodeId: "n2", incarnation: 0, health: "suspect", descriptor: descriptors.get("n2") }),
        mkEntry({ nodeId: "n2", incarnation: 0, health: "dead", descriptor: descriptors.get("n2") }),
      ],
      n3: [mkEntry({ nodeId: "n3", incarnation: 2, health: "alive", descriptor: descriptors.get("n3") })],
      n4: [
        mkEntry({ nodeId: "n4", incarnation: 0, health: "alive", descriptor: descriptors.get("n4") }),
        mkEntry({ nodeId: "n4", incarnation: 5, health: "dead", descriptor: descriptors.get("n4") }),
        mkEntry({ nodeId: "n4", incarnation: 5, health: "left", descriptor: descriptors.get("n4") }),
      ],
    };

    const expected: Record<string, { health: string; incarnation: number }> = {
      n1: { health: "alive", incarnation: 1 },
      n2: { health: "dead", incarnation: 0 },
      n3: { health: "alive", incarnation: 2 },
      n4: { health: "left", incarnation: 5 },
    };

    const allFacts = Object.values(factsByNode).flat();
    const rng = mulberry32(1337);

    for (let trial = 0; trial < 25; trial++) {
      const target = new ClusterMembership({ self: mkDescriptor("observer"), now: () => 1_000 });
      const order = shuffle(allFacts, rng);
      for (const fact of order) {
        target.apply(mkDigest(fact.nodeId, [fact], { sentAt: 1_000 }));
      }
      const observed: Record<string, { health: string; incarnation: number }> = {};
      for (const id of nodeIds) {
        const s = target.get(id);
        expect(s, `node ${id} missing on trial ${trial}, order=${order.map((f) => f.nodeId).join(",")}`).toBeDefined();
        observed[id] = { health: s!.health, incarnation: s!.incarnation };
      }
      expect(observed).toEqual(expected);
    }
  });

  it("converges identically across independently-shuffled peers applying the same fact set", () => {
    const clock = new VirtualClock();
    const rng = mulberry32(99);
    const bDesc = mkDescriptor("b");
    const facts: GossipEntry[] = [
      mkEntry({ nodeId: "b", incarnation: 0, health: "alive", descriptor: bDesc }),
      mkEntry({ nodeId: "b", incarnation: 1, health: "suspect", descriptor: bDesc }),
      mkEntry({ nodeId: "b", incarnation: 1, health: "dead", descriptor: bDesc }),
      mkEntry({ nodeId: "b", incarnation: 2, health: "alive", descriptor: bDesc }),
    ];

    const observers = ["p1", "p2", "p3"].map(
      (id) => new ClusterMembership({ self: mkDescriptor(id), now: clock.now }),
    );

    for (const observer of observers) {
      const order = shuffle(facts, rng);
      for (const fact of order) {
        observer.apply(mkDigest("b", [fact], { sentAt: clock.value }));
      }
    }

    // Compare only node "b" — each observer has a distinct self id (p1/p2/p3)
    // so their own self entries legitimately differ; what must converge
    // identically is their shared view of the remote node "b".
    const bViews = observers.map((o) => {
      const s = o.get("b")!;
      return { health: s.health, incarnation: s.incarnation };
    });
    expect(bViews[0]).toEqual(bViews[1]);
    expect(bViews[1]).toEqual(bViews[2]);
    expect(bViews[0]).toEqual({ health: "alive", incarnation: 2 });
  });
});

// ---------------------------------------------------------------------------
// leave() / refute()
// ---------------------------------------------------------------------------

describe("ClusterMembership — leave() & refute()", () => {
  it("leave() marks self as left, bumps incarnation, and returns a digest reflecting it", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const before = m.self().incarnation;
    const leftEvents: string[] = [];
    m.on("node:left", (n: NodeState) => leftEvents.push(n.descriptor.nodeId));

    const digest = m.leave();
    expect(m.self().health).toBe("left");
    expect(m.self().incarnation).toBe(before + 1);
    expect(leftEvents).toEqual(["a"]);
    const selfEntry = digest.entries.find((e) => e.nodeId === "a");
    expect(selfEntry?.health).toBe("left");
  });

  it("leave() is idempotent: calling it twice fires node:left only once", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const leftEvents: string[] = [];
    m.on("node:left", (n: NodeState) => leftEvents.push(n.descriptor.nodeId));
    m.leave();
    const incarnationAfterFirst = m.self().incarnation;
    m.leave();
    expect(leftEvents).toEqual(["a"]);
    expect(m.self().incarnation).toBe(incarnationAfterFirst);
  });

  it("a left node propagated via gossip is respected by peers (terminal state)", () => {
    const a = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const b = new ClusterMembership({ self: mkDescriptor("b"), now: () => 0 });
    a.join(mkDescriptor("b"));
    b.join(mkDescriptor("a"));
    const leaveDigest = a.leave();
    b.apply(leaveDigest);
    expect(b.get("a")?.health).toBe("left");
  });

  it("refute() bumps incarnation and only fires node:recovered when health actually changes", () => {
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: () => 0 });
    const recovered: string[] = [];
    m.on("node:recovered", (n: NodeState) => recovered.push(n.descriptor.nodeId));

    const inc1 = m.refute();
    expect(inc1).toBe(1);
    expect(recovered).toEqual([]); // already alive, no transition

    m.leave();
    const inc2 = m.refute();
    expect(inc2).toBe(3); // leave() bumped once, refute() bumps again
    expect(m.self().health).toBe("alive");
    expect(recovered).toEqual(["a"]); // left -> alive is a real transition
  });
});

// ---------------------------------------------------------------------------
// markLocalLoad()
// ---------------------------------------------------------------------------

describe("ClusterMembership.markLocalLoad()", () => {
  it("updates self load/liveWorkers and refreshes lastSeenAt without touching health/incarnation", () => {
    const clock = new VirtualClock();
    const m = new ClusterMembership({ self: mkDescriptor("a"), now: clock.now });
    clock.advance(500);
    m.markLocalLoad(0.75, 3);
    const s = m.self();
    expect(s.load).toBe(0.75);
    expect(s.liveWorkers).toBe(3);
    expect(s.lastSeenAt).toBe(500);
    expect(s.health).toBe("alive");
    expect(s.incarnation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Small local helper: counts whether ANY membership event fired during a scope.
// ---------------------------------------------------------------------------

function trackAnyEvent(m: ClusterMembership): { fired: boolean } {
  const tracker = { fired: false };
  const events = ["node:joined", "node:suspect", "node:dead", "node:recovered", "node:left", "leader:changed"];
  for (const ev of events) {
    m.on(ev, () => {
      tracker.fired = true;
    });
  }
  return tracker;
}
