/**
 * Unit tests for ClaimsService state machine and createClaimsTools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaimsService } from "../claims/service";
import { createClaimsTools } from "../claims/mcp-tools";
import type { Claimant } from "../claims/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaimant(overrides: Partial<Claimant> = {}): Claimant {
  return {
    id: "claimant-1",
    type: "agent",
    name: "Test Agent",
    ...overrides,
  };
}

function openClaim(svc: ClaimsService, overrides: Partial<Parameters<ClaimsService["create"]>[0]> = {}) {
  return svc.create({
    title: "Test Claim",
    description: "A test claim",
    priority: 5,
    tags: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("ClaimsService — create()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("returns a claim with status 'open'", () => {
    const claim = openClaim(svc);
    expect(claim.status).toBe("open");
  });

  it("assigns an auto-generated id", () => {
    const c1 = openClaim(svc);
    const c2 = openClaim(svc);
    expect(typeof c1.id).toBe("string");
    expect(c1.id.length).toBeGreaterThan(0);
    expect(c1.id).not.toBe(c2.id);
  });

  it("stores the title and description", () => {
    const claim = svc.create({ title: "My Title", description: "My Desc" });
    expect(claim.title).toBe("My Title");
    expect(claim.description).toBe("My Desc");
  });

  it("uses the provided priority (1-10)", () => {
    const claim = svc.create({ title: "T", description: "D", priority: 8 });
    expect(claim.priority).toBe(8);
  });

  it("defaults priority to 5 when not provided", () => {
    const claim = svc.create({ title: "T", description: "D" });
    expect(claim.priority).toBe(5);
  });

  it("clamps priority to max 10", () => {
    const claim = svc.create({ title: "T", description: "D", priority: 99 });
    expect(claim.priority).toBe(10);
  });

  it("clamps priority to min 1", () => {
    const claim = svc.create({ title: "T", description: "D", priority: -5 });
    expect(claim.priority).toBe(1);
  });

  it("stores tags", () => {
    const claim = svc.create({ title: "T", description: "D", tags: ["backend", "urgent"] });
    expect(claim.tags).toEqual(["backend", "urgent"]);
  });

  it("defaults tags to empty array", () => {
    const claim = svc.create({ title: "T", description: "D" });
    expect(claim.tags).toEqual([]);
  });

  it("sets createdAt to a recent timestamp", () => {
    const before = Date.now();
    const claim = openClaim(svc);
    expect(claim.createdAt).toBeGreaterThanOrEqual(before);
    expect(claim.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// claim() — open → claimed
// ---------------------------------------------------------------------------

describe("ClaimsService — claim()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions open → claimed", () => {
    const claim = openClaim(svc);
    const claimed = svc.claim(claim.id, makeClaimant());
    expect(claimed.status).toBe("claimed");
  });

  it("sets claimant on the claim", () => {
    const claim = openClaim(svc);
    const claimant = makeClaimant({ id: "agent-42", name: "Worker Bot" });
    const claimed = svc.claim(claim.id, claimant);
    expect(claimed.claimant?.id).toBe("agent-42");
    expect(claimed.claimant?.name).toBe("Worker Bot");
  });

  it("sets claimedAt timestamp", () => {
    const claim = openClaim(svc);
    const before = Date.now();
    const claimed = svc.claim(claim.id, makeClaimant());
    expect(claimed.claimedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// start() — claimed → active
// ---------------------------------------------------------------------------

describe("ClaimsService — start()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions claimed → active", () => {
    const claim = openClaim(svc);
    svc.claim(claim.id, makeClaimant());
    const active = svc.start(claim.id);
    expect(active.status).toBe("active");
  });

  it("sets startedAt timestamp", () => {
    const claim = openClaim(svc);
    svc.claim(claim.id, makeClaimant());
    const before = Date.now();
    const active = svc.start(claim.id);
    expect(active.startedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// pause() — active → paused
// ---------------------------------------------------------------------------

describe("ClaimsService — pause()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  function activeClaim() {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    return c;
  }

  it("transitions active → paused", () => {
    const c = activeClaim();
    const paused = svc.pause(c.id);
    expect(paused.status).toBe("paused");
  });

  it("stores pause reason in metadata when provided", () => {
    const c = activeClaim();
    const paused = svc.pause(c.id, "waiting for data");
    expect(paused.metadata?.pauseReason).toBe("waiting for data");
  });
});

// ---------------------------------------------------------------------------
// resume() — paused → active
// ---------------------------------------------------------------------------

describe("ClaimsService — resume()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions paused → active", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.pause(c.id);
    const resumed = svc.resume(c.id);
    expect(resumed.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// block() — active → blocked
// ---------------------------------------------------------------------------

describe("ClaimsService — block()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions active → blocked", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const blocked = svc.block(c.id);
    expect(blocked.status).toBe("blocked");
  });

  it("stores block reason in metadata when provided", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const blocked = svc.block(c.id, "dependency not ready");
    expect(blocked.metadata?.blockReason).toBe("dependency not ready");
  });
});

// ---------------------------------------------------------------------------
// unblock (resume from blocked) — blocked → active
// ---------------------------------------------------------------------------

describe("ClaimsService — unblock via resume()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions blocked → active via resume()", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.block(c.id);
    const unblocked = svc.resume(c.id);
    expect(unblocked.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// complete() — active → completed
// ---------------------------------------------------------------------------

describe("ClaimsService — complete()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions active → completed", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const completed = svc.complete(c.id, { output: "done" });
    expect(completed.status).toBe("completed");
  });

  it("sets completedAt timestamp", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const before = Date.now();
    const completed = svc.complete(c.id, null);
    expect(completed.completedAt).toBeGreaterThanOrEqual(before);
  });

  it("stores the result payload", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const completed = svc.complete(c.id, { answer: 42 });
    expect(completed.result).toEqual({ answer: 42 });
  });

  it("records duration in getStats().avgCompletionMs", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.complete(c.id, null);
    expect(svc.getStats().avgCompletionMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// fail() — active → failed
// ---------------------------------------------------------------------------

describe("ClaimsService — fail()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("transitions active → failed", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const failed = svc.fail(c.id, "something broke");
    expect(failed.status).toBe("failed");
  });

  it("stores the error message", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const failed = svc.fail(c.id, "something broke");
    expect(failed.error).toBe("something broke");
  });
});

// ---------------------------------------------------------------------------
// cancel() — non-terminal → cancelled
// ---------------------------------------------------------------------------

describe("ClaimsService — cancel()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("cancels an open claim", () => {
    const c = openClaim(svc);
    const cancelled = svc.cancel(c.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancels a claimed claim", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    const cancelled = svc.cancel(c.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancels an active claim", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const cancelled = svc.cancel(c.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancels a paused claim", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.pause(c.id);
    const cancelled = svc.cancel(c.id);
    expect(cancelled.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("ClaimsService — invalid transitions", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("claim() on already-claimed throws", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    expect(() => svc.claim(c.id, makeClaimant())).toThrow(/Invalid transition/);
  });

  it("complete() on paused throws", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.pause(c.id);
    expect(() => svc.complete(c.id)).toThrow(/Invalid transition/);
  });

  it("start() on open (not yet claimed) throws", () => {
    const c = openClaim(svc);
    expect(() => svc.start(c.id)).toThrow(/Invalid transition/);
  });

  it("fail() on completed throws", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.complete(c.id, null);
    expect(() => svc.fail(c.id, "oops")).toThrow(/Invalid transition/);
  });

  it("cancel() on completed throws", () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    svc.complete(c.id, null);
    expect(() => svc.cancel(c.id)).toThrow(/Invalid transition/);
  });
});

// ---------------------------------------------------------------------------
// steal()
// ---------------------------------------------------------------------------

describe("ClaimsService — steal()", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("steal() on non-stealable claim throws", () => {
    const svc = new ClaimsService();
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant({ id: "original" }));
    expect(() => svc.steal(c.id, makeClaimant({ id: "thief" }))).toThrow(/stealable/);
  });

  it("tick() marks active claim stealable after stealAfterMs", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const c = svc.create({
      title: "T",
      description: "D",
      stealAfterMs: 1000,
    });
    svc.claim(c.id, makeClaimant({ id: "original" }));
    svc.start(c.id);

    vi.advanceTimersByTime(1001);

    const { markedStealable } = svc.tick();
    expect(markedStealable).toContain(c.id);
    expect(svc.get(c.id)!.status).toBe("stealable");
  });

  it("steal() on stealable claim reassigns claimant and transitions to claimed", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const c = svc.create({
      title: "T",
      description: "D",
      stealAfterMs: 1000,
    });
    svc.claim(c.id, makeClaimant({ id: "original" }));
    svc.start(c.id);

    vi.advanceTimersByTime(1001);
    svc.tick();

    const newClaimant = makeClaimant({ id: "new-agent", name: "New Bot" });
    const stolen = svc.steal(c.id, newClaimant);

    expect(stolen.status).toBe("claimed");
    expect(stolen.claimant?.id).toBe("new-agent");
    expect(stolen.startedAt).toBeUndefined();
  });

  it("steal() increments stealCount in getStats()", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const c = svc.create({ title: "T", description: "D", stealAfterMs: 500 });
    svc.claim(c.id, makeClaimant({ id: "original" }));
    svc.start(c.id);

    vi.advanceTimersByTime(501);
    svc.tick();
    svc.steal(c.id, makeClaimant({ id: "thief" }));

    expect(svc.getStats().stealCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tick() expiry
// ---------------------------------------------------------------------------

describe("ClaimsService — tick() expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks open claim as failed when expiresAt is in the past", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const expiresAt = Date.now() + 500;
    const c = svc.create({ title: "T", description: "D", expiresAt });

    vi.advanceTimersByTime(600);

    const { expired } = svc.tick();
    expect(expired).toContain(c.id);
    expect(svc.get(c.id)!.status).toBe("failed");
    expect(svc.get(c.id)!.error).toBe("expired");
  });

  it("marks claimed claim as failed when expiresAt is in the past", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const expiresAt = Date.now() + 500;
    const c = svc.create({ title: "T", description: "D", expiresAt });
    svc.claim(c.id, makeClaimant());

    vi.advanceTimersByTime(600);

    const { expired } = svc.tick();
    expect(expired).toContain(c.id);
    expect(svc.get(c.id)!.status).toBe("failed");
  });

  it("does not expire active claim", () => {
    vi.useFakeTimers();
    const svc = new ClaimsService();
    const expiresAt = Date.now() + 500;
    const c = svc.create({ title: "T", description: "D", expiresAt });
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);

    vi.advanceTimersByTime(600);

    const { expired } = svc.tick();
    expect(expired).not.toContain(c.id);
    expect(svc.get(c.id)!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// findBest()
// ---------------------------------------------------------------------------

describe("ClaimsService — findBest()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("returns undefined when no open claims exist", () => {
    expect(svc.findBest(makeClaimant())).toBeUndefined();
  });

  it("returns the highest priority open claim", () => {
    svc.create({ title: "Low", description: "", priority: 2 });
    const high = svc.create({ title: "High", description: "", priority: 9 });
    svc.create({ title: "Mid", description: "", priority: 5 });

    const best = svc.findBest(makeClaimant());
    expect(best?.id).toBe(high.id);
  });

  it("prefers claim with matching preferred tag when priorities are equal", () => {
    const plain = svc.create({ title: "Plain", description: "", priority: 5, tags: ["other"] });
    const tagged = svc.create({ title: "Tagged", description: "", priority: 5, tags: ["backend"] });

    const best = svc.findBest(makeClaimant(), ["backend"]);
    expect(best?.id).toBe(tagged.id);
  });

  it("ignores non-open claims", () => {
    const c = svc.create({ title: "T", description: "", priority: 9 });
    svc.claim(c.id, makeClaimant());
    // No open claims left
    expect(svc.findBest(makeClaimant())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list() filtering
// ---------------------------------------------------------------------------

describe("ClaimsService — list() filtering", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("returns all claims when no filter provided", () => {
    openClaim(svc);
    openClaim(svc);
    expect(svc.list()).toHaveLength(2);
  });

  it("filters by single status", () => {
    const c1 = openClaim(svc);
    openClaim(svc);
    svc.claim(c1.id, makeClaimant());

    const open = svc.list({ status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe("open");
  });

  it("filters by status array", () => {
    const c1 = openClaim(svc);
    const c2 = openClaim(svc);
    svc.claim(c1.id, makeClaimant());
    svc.claim(c2.id, makeClaimant());
    svc.start(c2.id);

    const results = svc.list({ status: ["claimed", "active"] });
    expect(results).toHaveLength(2);
    expect(results.every((r) => ["claimed", "active"].includes(r.status))).toBe(true);
  });

  it("filters by claimantId", () => {
    const c1 = openClaim(svc);
    const c2 = openClaim(svc);
    svc.claim(c1.id, makeClaimant({ id: "agent-A" }));
    svc.claim(c2.id, makeClaimant({ id: "agent-B" }));

    const results = svc.list({ claimantId: "agent-A" });
    expect(results).toHaveLength(1);
    expect(results[0].claimant?.id).toBe("agent-A");
  });

  it("filters by tag", () => {
    svc.create({ title: "T1", description: "", tags: ["frontend"] });
    svc.create({ title: "T2", description: "", tags: ["backend"] });
    svc.create({ title: "T3", description: "", tags: ["frontend", "backend"] });

    const results = svc.list({ tag: "frontend" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.tags.includes("frontend"))).toBe(true);
  });

  it("filters by minPriority", () => {
    svc.create({ title: "Low", description: "", priority: 2 });
    svc.create({ title: "Mid", description: "", priority: 5 });
    svc.create({ title: "High", description: "", priority: 8 });

    const results = svc.list({ minPriority: 5 });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.priority >= 5)).toBe(true);
  });

  it("can combine multiple filters", () => {
    const c1 = svc.create({ title: "T1", description: "", priority: 7, tags: ["backend"] });
    const c2 = svc.create({ title: "T2", description: "", priority: 3, tags: ["backend"] });
    svc.claim(c1.id, makeClaimant({ id: "agent-X" }));
    svc.claim(c2.id, makeClaimant({ id: "agent-X" }));

    // claimantId + minPriority
    const results = svc.list({ claimantId: "agent-X", minPriority: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(c1.id);
  });
});

// ---------------------------------------------------------------------------
// getStats()
// ---------------------------------------------------------------------------

describe("ClaimsService — getStats()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("returns total = 0 and all-zero byStatus on empty service", () => {
    const stats = svc.getStats();
    expect(stats.total).toBe(0);
    expect(stats.stealCount).toBe(0);
    expect(stats.avgCompletionMs).toBe(0);
    // All statuses should be 0
    const allZero = Object.values(stats.byStatus).every((v) => v === 0);
    expect(allZero).toBe(true);
  });

  it("counts claims by status correctly", () => {
    const c1 = openClaim(svc);
    const c2 = openClaim(svc);
    const c3 = openClaim(svc);
    svc.claim(c2.id, makeClaimant());
    svc.claim(c3.id, makeClaimant());
    svc.start(c3.id);
    svc.complete(c3.id, null);

    const stats = svc.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byStatus.open).toBe(1);
    expect(stats.byStatus.claimed).toBe(1);
    expect(stats.byStatus.completed).toBe(1);
  });

  it("includes all ClaimStatus keys in byStatus", () => {
    const stats = svc.getStats();
    const expectedKeys = [
      "open", "claimed", "active", "paused", "blocked",
      "stealable", "completed", "failed", "cancelled",
    ];
    for (const key of expectedKeys) {
      expect(key in stats.byStatus).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// createClaimsTools()
// ---------------------------------------------------------------------------

describe("createClaimsTools()", () => {
  let svc: ClaimsService;

  beforeEach(() => {
    svc = new ClaimsService();
  });

  it("returns exactly 8 tool definitions", () => {
    const tools = createClaimsTools(svc);
    expect(tools).toHaveLength(8);
  });

  it("each tool has name, description, parameters, and execute", () => {
    const tools = createClaimsTools(svc);
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.parameters).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("contains expected tool names", () => {
    const tools = createClaimsTools(svc);
    const names = tools.map((t) => t.name);
    expect(names).toContain("claims_create");
    expect(names).toContain("claims_list");
    expect(names).toContain("claims_claim");
    expect(names).toContain("claims_start");
    expect(names).toContain("claims_complete");
    expect(names).toContain("claims_fail");
    expect(names).toContain("claims_steal");
    expect(names).toContain("claims_stats");
  });

  it("claims_create tool creates a claim when executed", async () => {
    const tools = createClaimsTools(svc);
    const createTool = tools.find((t) => t.name === "claims_create")!;
    const result = await createTool.execute(svc, {
      title: "From Tool",
      description: "Created via tool",
      priority: 7,
    }) as { status: string; title: string };
    expect(result.status).toBe("open");
    expect(result.title).toBe("From Tool");
  });

  it("claims_list tool lists all claims", async () => {
    openClaim(svc);
    openClaim(svc);
    const tools = createClaimsTools(svc);
    const listTool = tools.find((t) => t.name === "claims_list")!;
    const result = await listTool.execute(svc, {}) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("claims_claim tool transitions open → claimed", async () => {
    const c = openClaim(svc);
    const tools = createClaimsTools(svc);
    const claimTool = tools.find((t) => t.name === "claims_claim")!;
    const result = await claimTool.execute(svc, {
      claimId: c.id,
      claimantId: "agent-99",
      claimantType: "agent",
      claimantName: "Bot 99",
    }) as { status: string };
    expect(result.status).toBe("claimed");
  });

  it("claims_start tool transitions claimed → active", async () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    const tools = createClaimsTools(svc);
    const startTool = tools.find((t) => t.name === "claims_start")!;
    const result = await startTool.execute(svc, { claimId: c.id }) as { status: string };
    expect(result.status).toBe("active");
  });

  it("claims_complete tool transitions active → completed", async () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const tools = createClaimsTools(svc);
    const completeTool = tools.find((t) => t.name === "claims_complete")!;
    const result = await completeTool.execute(svc, {
      claimId: c.id,
      result: { done: true },
    }) as { status: string };
    expect(result.status).toBe("completed");
  });

  it("claims_fail tool transitions active → failed", async () => {
    const c = openClaim(svc);
    svc.claim(c.id, makeClaimant());
    svc.start(c.id);
    const tools = createClaimsTools(svc);
    const failTool = tools.find((t) => t.name === "claims_fail")!;
    const result = await failTool.execute(svc, {
      claimId: c.id,
      error: "tool error",
    }) as { status: string; error: string };
    expect(result.status).toBe("failed");
    expect(result.error).toBe("tool error");
  });

  it("claims_stats tool returns stats object", async () => {
    openClaim(svc);
    const tools = createClaimsTools(svc);
    const statsTool = tools.find((t) => t.name === "claims_stats")!;
    const result = await statsTool.execute(svc, {}) as { total: number; byStatus: object };
    expect(result.total).toBe(1);
    expect(typeof result.byStatus).toBe("object");
  });
});
