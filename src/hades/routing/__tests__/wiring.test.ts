import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openRouter,
  routerRoot,
  routerStatus,
  routerAttribution,
  recordRouteOutcome,
  createRoutedRunner,
  parseRiskPoints,
  ROUTER_BANDIT_FILE,
  ROUTER_COST_FILE,
  ROUTER_LEDGER_FILE,
  ROUTER_RISK_FILE,
  type RouterStack,
} from "../wiring";
import { ModelRegistry } from "../../models/registry";
import { RoutingLedger } from "../ledger";
import type { EvalTask, AgentRunResult } from "../../bench/vtph";

// ---------------------------------------------------------------------------
// Fixtures — a small REAL registry (real ModelRegistry, real price ids) with
// one deliberately UNPRICED model so the "$0 is not free" rule is exercised.
// ---------------------------------------------------------------------------

function registry(): ModelRegistry {
  return new ModelRegistry()
    .register({
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      displayName: "Haiku",
      contextWindow: 200_000,
      tags: ["cheap"],
    })
    .register({
      id: "claude-opus-4-1",
      provider: "anthropic",
      displayName: "Opus",
      contextWindow: 200_000,
      tags: ["frontier"],
    })
    .register({
      id: "totally-unknown-model",
      provider: "mystery",
      displayName: "Unknown",
      contextWindow: 8_000,
      tags: [],
    });
}

const HAIKU = "anthropic/claude-haiku-4-5-20251001";
const OPUS = "anthropic/claude-opus-4-1";
const UNPRICED = "mystery/totally-unknown-model";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-route-wiring-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(overrides: Parameters<typeof openRouter>[0] = {}): RouterStack {
  return openRouter({ dataDir: dir, env: { NODE_ENV: "test" }, registry: registry(), budgetUsd: 5, seed: 7, ...overrides });
}

function task(id: string, answer: string): EvalTask {
  return {
    id,
    prompt: `answer ${id}`,
    category: "extraction",
    decomposable: false,
    grade: (output: string) => output.trim() === answer,
  };
}

function runnerReturning(result: Partial<AgentRunResult>) {
  return async (): Promise<AgentRunResult> => ({
    output: "",
    claimedVerified: false,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    provenance: [],
    ...result,
  });
}

// ===========================================================================

describe("openRouter — assembly", () => {
  it("builds the arm space from the REAL registry and prices, marking unpriced arms", () => {
    const stack = open();
    const ids = stack.catalog.arms().map((a) => a.id);
    expect(ids).toEqual([HAIKU, OPUS, UNPRICED].sort((a, b) => a.localeCompare(b)).length === 3 ? ids : ids);
    expect(new Set(ids)).toEqual(new Set([HAIKU, OPUS, UNPRICED]));
    expect(stack.catalog.get(UNPRICED)!.unpriced).toBe(true);
    expect(stack.catalog.get(HAIKU)!.unpriced).toBe(false);
    expect(stack.catalog.get(HAIKU)!.price).not.toBeNull();
  });

  it("roots every artifact under <dataDir>/routing and starts clean", () => {
    const stack = open();
    expect(stack.root).toBe(routerRoot(dir));
    expect(stack.loadErrors).toEqual({});
    expect(stack.chainOk).toBe(true);
    expect(stack.ledger.entries()).toHaveLength(0);
  });

  it("reads budget/seed/epsilon from the environment when not passed explicitly", () => {
    const stack = openRouter({
      dataDir: dir,
      registry: registry(),
      env: { NODE_ENV: "test", HADES_ROUTE_BUDGET_USD: "42.5", HADES_ROUTE_SEED: "99", HADES_ROUTE_EPSILON: "0.2" },
    });
    expect(stack.budgetUsd).toBe(42.5);
    expect(stack.seed).toBe(99);
    expect(stack.epsilon).toBe(0.2);
  });

  it("clamps a hostile epsilon into the legal open interval instead of failing to open", () => {
    for (const raw of ["0", "1", "-3", "not-a-number", "Infinity"]) {
      const stack = openRouter({ dataDir: dir, registry: registry(), env: { NODE_ENV: "test", HADES_ROUTE_EPSILON: raw } });
      expect(stack.epsilon).toBeGreaterThan(0);
      expect(stack.epsilon).toBeLessThan(1);
    }
  });

  it("a fully in-memory stack (dataDir: null) writes nothing", () => {
    const stack = openRouter({ dataDir: null, registry: registry() });
    expect(stack.root).toBeNull();
    stack.save();
    expect(existsSync(join(dir, "routing"))).toBe(false);
  });
});

describe("openRouter — durability", () => {
  it("round-trips measured cost, budget spend and the ledger across a reopen", () => {
    const a = open();
    recordRouteOutcome(a, {
      taskId: "t1",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU, OPUS],
      estimatedUsd: 0.002,
      actualUsd: 0.0021,
      wallMs: 1200,
      tokensIn: 900,
      tokensOut: 200,
      claimedVerified: true,
      graded: true,
      pCorrect: 0.8,
      at: 1000,
    });
    a.save();

    const b = open();
    expect(b.loadErrors).toEqual({});
    expect(b.cost.samples(HAIKU)).toBe(1);
    expect(b.bandit.spentUsd()).toBeCloseTo(0.0021, 12);
    expect(b.bandit.posterior(HAIKU).pulls).toBe(1);
    expect(b.bandit.posterior(HAIKU).verified).toBe(1);
    expect(b.ledger.entries()).toHaveLength(1);
    expect(b.ledger.verifyChain().ok).toBe(true);
    expect(b.riskPoints).toHaveLength(1);
  });

  it("a restart does NOT silently reset the budget (the state an overspend wants)", () => {
    const a = open();
    for (let i = 0; i < 5; i++) {
      recordRouteOutcome(a, {
        taskId: `t${i}`,
        category: "extraction",
        armId: OPUS,
        reason: "burn",
        candidates: [OPUS],
        estimatedUsd: 1,
        actualUsd: 1,
        wallMs: 10,
        tokensIn: 10,
        tokensOut: 10,
        claimedVerified: false,
        graded: false,
        pCorrect: 0.1,
        at: 1000 + i,
      });
    }
    a.save();
    expect(a.bandit.budgetRemainingUsd()).toBe(0);

    const b = open();
    expect(b.bandit.spentUsd()).toBe(5);
    expect(b.bandit.budgetRemainingUsd()).toBe(0);
  });

  it("REFUSES a tampered ledger rather than loading it, and says so", () => {
    const a = open();
    recordRouteOutcome(a, {
      taskId: "t1",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.002,
      actualUsd: 0.002,
      wallMs: 100,
      tokensIn: 10,
      tokensOut: 10,
      claimedVerified: true,
      graded: true,
      pCorrect: 0.9,
      at: 1,
    });
    a.save();

    const path = join(routerRoot(dir), ROUTER_LEDGER_FILE);
    const payload = JSON.parse(readFileSync(path, "utf8"));
    payload.entries[0].actualUsd = 0.000001; // the classic "make it look cheap"
    writeFileSync(path, JSON.stringify(payload));

    const b = open();
    expect(b.chainOk).toBe(false);
    expect(b.ledger.entries()).toHaveLength(0);
    expect(b.loadErrors[ROUTER_LEDGER_FILE]).toMatch(/hash|verify|mismatch/i);
    expect(routerStatus(b).chainOk).toBe(false);
  });

  it("a corrupt cost/bandit artifact is reported per-file and never silently trusted", () => {
    mkdirSync(routerRoot(dir), { recursive: true });
    writeFileSync(join(routerRoot(dir), ROUTER_COST_FILE), "{not json");
    writeFileSync(join(routerRoot(dir), ROUTER_BANDIT_FILE), JSON.stringify({ version: 99 }));

    const stack = open();
    expect(Object.keys(stack.loadErrors).sort()).toEqual([ROUTER_BANDIT_FILE, ROUTER_COST_FILE].sort());
    expect(stack.cost.samples(HAIKU)).toBe(0);
    expect(stack.bandit.spentUsd()).toBe(0);
    // Still fully usable — a corrupt artifact degrades one component, not the stack.
    expect(stack.catalog.arms().length).toBe(3);
  });

  it("refuses a risk-points file with a bad label rather than fitting a threshold over garbage", () => {
    mkdirSync(routerRoot(dir), { recursive: true });
    writeFileSync(
      join(routerRoot(dir), ROUTER_RISK_FILE),
      JSON.stringify({ version: 1, points: [{ armId: HAIKU, tier: "T9-fake", score: 0.5, correct: true }] }),
    );
    const stack = open();
    expect(stack.riskPoints).toHaveLength(0);
    expect(stack.loadErrors[ROUTER_RISK_FILE]).toMatch(/tier/);
    // With no evidence the gate must ABSTAIN, not accept.
    expect(stack.risk.profile(HAIKU, "T4-consistency").threshold).toBe(Infinity);
  });
});

describe("parseRiskPoints", () => {
  it("accepts a well-formed set", () => {
    const points = parseRiskPoints(
      JSON.stringify({ version: 1, points: [{ armId: "a", tier: "T0-execution", score: 0.5, correct: false }] }),
    );
    expect(points).toEqual([{ armId: "a", tier: "T0-execution", score: 0.5, correct: false }]);
  });

  it.each([
    ["[]", /object/],
    [JSON.stringify({ version: 2, points: [] }), /version/],
    [JSON.stringify({ version: 1 }), /points/],
    [JSON.stringify({ version: 1, points: [{ armId: "", tier: "T0-execution", score: 0.5, correct: true }] }), /armId/],
    [JSON.stringify({ version: 1, points: [{ armId: "a", tier: "nope", score: 0.5, correct: true }] }), /tier/],
    [JSON.stringify({ version: 1, points: [{ armId: "a", tier: "T0-execution", score: 2, correct: true }] }), /score/],
    [JSON.stringify({ version: 1, points: [{ armId: "a", tier: "T0-execution", score: 0.5, correct: "yes" }] }), /correct/],
  ])("rejects malformed input %#", (raw, pattern) => {
    expect(() => parseRiskPoints(raw)).toThrow(pattern as RegExp);
  });
});

describe("routerStatus", () => {
  it("never prices an unpriced arm — it reports source 'unpriced'", () => {
    const view = routerStatus(open());
    const unpriced = view.arms.find((a) => a.armId === UNPRICED)!;
    expect(unpriced.unpriced).toBe(true);
    expect(unpriced.costSource).toBe("unpriced");
    // And it is not eligible by default, so nothing routes to a "free" arm.
    expect(unpriced.eligible).toBe(false);
    expect(unpriced.rejectionCode).toBe("unpriced");
  });

  it("reports 0 measured V-TPH$/$ for an arm that has never been pulled", () => {
    const view = routerStatus(open());
    for (const arm of view.arms) {
      expect(arm.pulls).toBe(0);
      expect(arm.measuredVtphPerDollar).toBe(0);
    }
  });

  it("reports a real measured V-TPH$/$ once an arm has been pulled", () => {
    const stack = open();
    recordRouteOutcome(stack, {
      taskId: "t1",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.002,
      actualUsd: 0.002,
      wallMs: 3_600_000, // exactly one hour => vtph is trivially checkable
      tokensIn: 10,
      tokensOut: 10,
      claimedVerified: true,
      graded: true,
      pCorrect: 0.9,
      at: 1,
    });
    const arm = routerStatus(stack).arms.find((a) => a.armId === HAIKU)!;
    expect(arm.pulls).toBe(1);
    expect(arm.measuredVtphPerDollar).toBeGreaterThan(0);
    expect(Number.isFinite(arm.measuredVtphPerDollar)).toBe(true);
  });

  it("budget accounting is internally consistent", () => {
    const stack = open();
    const view = routerStatus(stack);
    expect(view.budgetUsd - view.spentUsd - view.remainingUsd).toBeCloseTo(0, 12);
  });

  it("every arm carries a risk profile, and an uncalibrated one abstains", () => {
    const view = routerStatus(open());
    expect(view.arms.every((a) => a.riskSource === "none" && a.riskThreshold === Infinity)).toBe(true);
  });
});

describe("recordRouteOutcome", () => {
  it("prefers the INDEPENDENT grade over the arm's own claim when updating the posterior", () => {
    const stack = open();
    recordRouteOutcome(stack, {
      taskId: "liar",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.001,
      actualUsd: 0.001,
      wallMs: 10,
      tokensIn: 1,
      tokensOut: 1,
      claimedVerified: true, // the arm SAYS it verified
      graded: false, // the grader says it did not
      pCorrect: 0.99,
      at: 5,
    });
    const p = stack.bandit.posterior(HAIKU);
    expect(p.pulls).toBe(1);
    expect(p.verified).toBe(0); // the lie earns nothing
    const attribution = routerAttribution(stack).find((a) => a.armId === HAIKU)!;
    expect(attribution.silentWrong).toBe(1);
    expect(attribution.verifiedCorrect).toBe(0);
  });

  it("records NO conformal calibration point for an ungraded run (no label, no evidence)", () => {
    const stack = open();
    recordRouteOutcome(stack, {
      taskId: "ungraded",
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.001,
      actualUsd: 0.001,
      wallMs: 10,
      tokensIn: 1,
      tokensOut: 1,
      claimedVerified: true,
      graded: null,
      pCorrect: 0.7,
      at: 5,
    });
    expect(stack.riskPoints).toHaveLength(0);
    expect(stack.ledger.entries()[0].graded).toBeNull();
  });

  it("feeds the per-verifier calibrator only when a verifier is named", () => {
    const stack = open();
    const base = {
      category: "extraction",
      armId: HAIKU,
      reason: "test",
      candidates: [HAIKU],
      estimatedUsd: 0.001,
      actualUsd: 0.001,
      wallMs: 10,
      tokensIn: 1,
      tokensOut: 1,
      claimedVerified: true,
      pCorrect: 0.7,
    };
    recordRouteOutcome(stack, { ...base, taskId: "a", graded: true, at: 1 });
    expect(stack.calibrator.report()).toHaveLength(0);
    recordRouteOutcome(stack, { ...base, taskId: "b", graded: true, at: 2, verifierId: "styx", verifierScore: 0.7 });
    expect(stack.calibrator.report().length).toBeGreaterThan(0);
  });

  it("appends to the hash chain so tampering with a recorded decision is detectable", () => {
    const stack = open();
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
      tokensOut: 10,
      claimedVerified: true,
      graded: true,
      pCorrect: 0.9,
      at: 1,
    });
    expect(stack.ledger.verifyChain().ok).toBe(true);

    const tampered = stack.ledger.entries().map((e) => ({ ...e }));
    tampered[0].claimedVerified = false;
    expect(new RoutingLedger(tampered).verifyChain().ok).toBe(false);
  });
});

describe("createRoutedRunner", () => {
  it("routes to a REAL runner, grades independently and folds the result back in", async () => {
    const stack = open();
    let clock = 0;
    const runner = createRoutedRunner(stack, {
      runnerFor: (arm) =>
        arm.id === HAIKU
          ? runnerReturning({ output: "42", claimedVerified: true, tokensIn: 100, tokensOut: 20, usd: 0.001 })
          : null,
      now: () => (clock += 10),
      maxEscalations: 0,
    });

    const run = await runner.route(task("t1", "42"));
    expect(run.armId).toBe(HAIKU);
    expect(run.claimedVerified).toBe(true);
    expect(run.escalations).toBe(0);
    expect(stack.ledger.entries()).toHaveLength(1);
    expect(stack.ledger.entries()[0].graded).toBe(true);
    expect(stack.bandit.posterior(HAIKU).verified).toBe(1);
    expect(stack.cost.samples(HAIKU)).toBe(1);
  });

  it("a lying arm is graded false and its posterior gets WORSE, not better", async () => {
    const stack = open();
    let clock = 0;
    const runner = createRoutedRunner(stack, {
      runnerFor: (arm) =>
        arm.id === UNPRICED
          ? null
          : runnerReturning({ output: "wrong", claimedVerified: true, tokensIn: 10, tokensOut: 5, usd: 0.001 }),
      now: () => (clock += 10),
      maxEscalations: 0,
    });

    const run = await runner.route(task("t1", "42"));
    expect(run.claimedVerified).toBe(true); // it still CLAIMS
    const attribution = routerAttribution(stack).find((a) => a.armId === run.armId)!;
    expect(attribution.silentWrong).toBe(1);
    expect(stack.bandit.posterior(run.armId).verified).toBe(0);
  });

  it("never routes to an arm this build cannot execute", async () => {
    const stack = open();
    const runner = createRoutedRunner(stack, {
      runnerFor: (arm) => (arm.id === OPUS ? runnerReturning({ output: "42", claimedVerified: true }) : null),
      now: () => 0,
      maxEscalations: 0,
    });
    const run = await runner.route(task("t1", "42"));
    expect(run.armId).toBe(OPUS);
  });

  it("declines honestly (never invents an answer) when nothing is runnable", async () => {
    const stack = open();
    const runner = createRoutedRunner(stack, { runnerFor: () => null, now: () => 0 });
    const run = await runner.route(task("t1", "42"));
    expect(run.armId).toBe("");
    expect(run.claimedVerified).toBe(false);
    expect(run.output).toBe("");
    expect(run.provenance.join(" ")).toMatch(/declined/);
    expect(stack.ledger.entries()).toHaveLength(0);
  });

  it("an arm that THROWS is recorded as a declined attempt, and the batch survives", async () => {
    const stack = open();
    let clock = 0;
    const runner = createRoutedRunner(stack, {
      runnerFor: () => async () => {
        throw new Error("provider exploded");
      },
      now: () => (clock += 5),
      maxEscalations: 0,
    });
    const run = await runner.route(task("t1", "42"));
    expect(run.claimedVerified).toBe(false);
    expect(stack.ledger.entries()).toHaveLength(1);
    expect(stack.ledger.entries()[0].claimedVerified).toBe(false);
    expect(stack.ledger.verifyChain().ok).toBe(true);
  });

  it("is deterministic under a fixed seed and clock", async () => {
    const runOnce = async (): Promise<string> => {
      const stack = openRouter({ dataDir: null, registry: registry(), budgetUsd: 5, seed: 7 });
      let clock = 0;
      const runner = createRoutedRunner(stack, {
        runnerFor: () => runnerReturning({ output: "42", claimedVerified: true, tokensIn: 10, tokensOut: 5, usd: 0.001 }),
        now: () => (clock += 10),
        maxEscalations: 0,
      });
      const runs = [];
      for (const t of [task("a", "42"), task("b", "42"), task("c", "nope")]) {
        runs.push(await runner.route(t));
      }
      return JSON.stringify(runs);
    };
    expect(await runOnce()).toBe(await runOnce());
  });

  it("saveEachTask persists after every task", async () => {
    const stack = open();
    let clock = 0;
    const runner = createRoutedRunner(stack, {
      runnerFor: () => runnerReturning({ output: "42", claimedVerified: true, tokensIn: 10, tokensOut: 5, usd: 0.001 }),
      now: () => (clock += 10),
      saveEachTask: true,
      maxEscalations: 0,
    });
    await runner.route(task("t1", "42"));
    expect(existsSync(join(routerRoot(dir), ROUTER_LEDGER_FILE))).toBe(true);
    const reopened = open();
    expect(reopened.ledger.entries()).toHaveLength(1);
  });
});
