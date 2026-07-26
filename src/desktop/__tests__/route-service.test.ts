import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RouteService } from "../core/route-service";
import { Sidecar } from "../core/sidecar";
import { isRouteEvent, type RouteEvent } from "../ipc/route-contract";
import type { AppEvent, Command } from "../ipc/contract";
import { openRouter, recordRouteOutcome, type RouterStack } from "../../hades/routing/wiring";
import { ModelRegistry } from "../../hades/models/registry";

function registry(): ModelRegistry {
  return new ModelRegistry()
    .register({ id: "claude-haiku-4-5-20251001", provider: "anthropic", displayName: "Haiku", contextWindow: 200_000 })
    .register({ id: "claude-opus-4-1", provider: "anthropic", displayName: "Opus", contextWindow: 200_000 })
    .register({ id: "totally-unknown-model", provider: "mystery", displayName: "Unknown", contextWindow: 8_000 });
}

const HAIKU = "anthropic/claude-haiku-4-5-20251001";
const UNPRICED = "mystery/totally-unknown-model";

let dir: string;
let stack: RouterStack;
let service: RouteService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-route-svc-"));
  stack = openRouter({ dataDir: dir, env: { NODE_ENV: "test" }, registry: registry(), budgetUsd: 5, seed: 11 });
  service = new RouteService({ stack: () => stack, now: () => 1234 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================

describe("RouteService — every reply is a valid RouteEvent", () => {
  it("route.status", async () => {
    const ev = await service.handle({ kind: "route.status" });
    expect(isRouteEvent(ev)).toBe(true);
    expect(ev.kind).toBe("route.status");
    if (ev.kind !== "route.status") throw new Error("unreachable");
    expect(ev.at).toBe(1234);
    expect(ev.status.totalArms).toBe(3);
    expect(ev.status.chainOk).toBe(true);
  });

  it("route.arms", async () => {
    const ev = await service.handle({ kind: "route.arms" });
    expect(isRouteEvent(ev)).toBe(true);
    if (ev.kind !== "route.arms") throw new Error("unreachable");
    expect(ev.eligibility.eligible.every((a) => !a.unpriced)).toBe(true);
    expect(ev.eligibility.rejected.some((r) => r.armId === UNPRICED && r.code === "unpriced")).toBe(true);
  });

  it("route.explain", async () => {
    const ev = await service.handle({ kind: "route.explain", category: "code" });
    expect(isRouteEvent(ev)).toBe(true);
    if (ev.kind !== "route.explain") throw new Error("unreachable");
    expect(ev.explain.note.length).toBeGreaterThan(0);
    expect(ev.explain.ranked.every((r) => r.armId !== UNPRICED)).toBe(true);
  });

  it("route.ledger", async () => {
    const ev = await service.handle({ kind: "route.ledger" });
    expect(isRouteEvent(ev)).toBe(true);
    if (ev.kind !== "route.ledger") throw new Error("unreachable");
    expect(ev.ledger.chainOk).toBe(true);
    expect(ev.ledger.entries).toHaveLength(0);
  });
});

describe("RouteService — honesty rules enforced here, not in the renderer", () => {
  it("an unpriced arm crosses the wire labelled, never as a $0 arm", async () => {
    const ev = await service.handle({ kind: "route.status" });
    if (ev.kind !== "route.status") throw new Error("unreachable");
    const unpriced = ev.status.arms.find((a) => a.armId === UNPRICED)!;
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.costSource).toBe("unpriced");
    expect(unpriced.eligible).toBe(false);
  });

  it("an abstaining stratum crosses as riskThreshold null + riskThresholdFinite false", async () => {
    const ev = await service.handle({ kind: "route.status" });
    if (ev.kind !== "route.status") throw new Error("unreachable");
    for (const a of ev.status.arms) {
      expect(a.riskThresholdFinite).toBe(false);
      expect(a.riskThreshold).toBeNull();
    }
    // And it survives a real JSON boundary intact.
    const round = JSON.parse(JSON.stringify(ev)) as RouteEvent;
    expect(isRouteEvent(round)).toBe(true);
  });

  it("a never-pulled arm reports 0 measured V-TPH$/$", async () => {
    const ev = await service.handle({ kind: "route.status" });
    if (ev.kind !== "route.status") throw new Error("unreachable");
    expect(ev.status.arms.every((a) => a.pulls > 0 || a.measuredVtphPerDollar === 0)).toBe(true);
  });

  it("a claimed-but-wrong decision surfaces as silentWrong, not verifiedCorrect", async () => {
    recordRouteOutcome(stack, {
      taskId: "t1",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.002,
      actualUsd: 0.002,
      wallMs: 100,
      tokensIn: 10,
      tokensOut: 5,
      claimedVerified: true,
      graded: false,
      pCorrect: 0.95,
      at: 1,
    });
    const ev = await service.handle({ kind: "route.ledger" });
    if (ev.kind !== "route.ledger") throw new Error("unreachable");
    const row = ev.ledger.attribution.find((a) => a.armId === HAIKU)!;
    expect(row.silentWrong).toBe(1);
    expect(row.verifiedCorrect).toBe(0);
  });
});

describe("RouteService — read-only and bounded", () => {
  it("route.explain records nothing and persists nothing", async () => {
    await service.handle({ kind: "route.explain", category: "code" });
    expect(stack.ledger.entries()).toHaveLength(0);
    expect(stack.bandit.spentUsd()).toBe(0);
    expect(existsSync(join(dir, "routing"))).toBe(false);
  });

  it("clamps a hostile token context instead of printing a nonsense dollar figure", async () => {
    const svc = new RouteService({ stack: () => stack, now: () => 0, maxTokens: 1000 });
    const ev = await svc.handle({ kind: "route.status", promptTokens: 1e12, expectedOutputTokens: -5 });
    if (ev.kind !== "route.status") throw new Error("unreachable");
    expect(isRouteEvent(ev)).toBe(true);
    expect(ev.status.arms.every((a) => Number.isFinite(a.usdMean))).toBe(true);
  });

  it("caps how many ledger entries one request can drag across the wire", async () => {
    for (let i = 0; i < 12; i++) {
      recordRouteOutcome(stack, {
        taskId: `t${i}`,
        category: "extraction",
        armId: HAIKU,
        reason: "test",
        candidates: [HAIKU],
        estimatedUsd: 0.0001,
        actualUsd: 0.0001,
        wallMs: 10,
        tokensIn: 1,
        tokensOut: 1,
        claimedVerified: true,
        graded: true,
        pCorrect: 0.5,
        at: i,
      });
    }
    const svc = new RouteService({ stack: () => stack, now: () => 0, maxLedgerEntries: 5 });
    const ev = await svc.handle({ kind: "route.ledger", entries: 1000 });
    if (ev.kind !== "route.ledger") throw new Error("unreachable");
    expect(ev.ledger.entries).toHaveLength(5);
    expect(ev.ledger.chainEntries).toBe(12); // the COUNT is never truncated
  });
});

describe("RouteService — failure is reported, never silenced", () => {
  it("a stack that cannot open becomes route.error with the REAL reason", async () => {
    const svc = new RouteService({
      stack: () => {
        throw new Error("routing dir is on fire");
      },
      now: () => 7,
    });
    const ev = await svc.handle({ kind: "route.status" });
    expect(ev).toEqual({ kind: "route.error", op: "route.status", message: "routing dir is on fire", at: 7 });
    expect(isRouteEvent(ev)).toBe(true);
  });

  it("a REFUSED (tampered) ledger reports chainOk false rather than an empty healthy view", async () => {
    const { RoutingLedger } = await import("../../hades/routing/ledger");
    recordRouteOutcome(stack, {
      taskId: "t1",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.002,
      actualUsd: 0.002,
      wallMs: 100,
      tokensIn: 10,
      tokensOut: 5,
      claimedVerified: true,
      graded: true,
      pCorrect: 0.9,
      at: 1,
    });
    const entries = stack.ledger.entries().map((e) => ({ ...e }));
    entries[0].actualUsd = 0.0000001;
    stack.ledger = new RoutingLedger(entries) as typeof stack.ledger;

    const ev = await service.handle({ kind: "route.ledger" });
    if (ev.kind !== "route.ledger") throw new Error("unreachable");
    expect(ev.ledger.chainOk).toBe(false);
    expect(ev.ledger.chainCode).not.toBe("ok");
  });
});

describe("Sidecar — the route lane", () => {
  function collect(): { events: AppEvent[]; sidecar: Sidecar } {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => {
        throw new Error("no swarm needed for this test");
      },
      now: () => 99,
      emit: (e: AppEvent) => events.push(e),
      route: service,
    });
    return { events, sidecar };
  }

  it("routes route.* commands to the injected handler", async () => {
    const { events, sidecar } = collect();
    await sidecar.handle({ kind: "route.status" } as Command);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("route.status");
  });

  it("replies with an honest route.error when no router is configured", async () => {
    const events: AppEvent[] = [];
    const sidecar = new Sidecar({
      factory: () => {
        throw new Error("unused");
      },
      now: () => 42,
      emit: (e: AppEvent) => events.push(e),
    });
    await sidecar.handle({ kind: "route.ledger" } as Command);
    expect(events).toEqual([
      {
        kind: "route.error",
        op: "route.ledger",
        message: "the budget-constrained router is not configured in this build",
        at: 42,
      },
    ]);
  });
});
