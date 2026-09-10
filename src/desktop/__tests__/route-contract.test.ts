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
  ROUTE_COMMAND_KINDS,
  ROUTE_EVENT_KINDS,
  isRouteArmWire,
  isRouteCommand,
  isRouteEligibilityWire,
  isRouteEvent,
  isRouteExplainWire,
  isRouteLedgerWire,
  isRouteStatusWire,
  type RouteArmWire,
  type RouteCommand,
  type RouteEvent,
  type RouteExplainWire,
  type RouteLedgerWire,
  type RouteStatusWire,
} from "../ipc/route-contract";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const arm: RouteArmWire = {
  armId: "anthropic/claude-haiku-4-5-20251001",
  provider: "anthropic",
  modelId: "claude-haiku-4-5-20251001",
  execTarget: null,
  displayName: "Haiku",
  contextWindow: 200_000,
  unpriced: false,
  eligible: true,
  rejectionCode: null,
  rejectionDetail: null,
  usdMean: 0.0045,
  usdP90: 0.0045,
  latencyMsMean: 0,
  costSamples: 0,
  costSource: "priced-prior",
  pulls: 0,
  verified: 0,
  pVerifiedMean: 0.5,
  measuredVtphPerDollar: 0,
  riskThreshold: null,
  riskThresholdFinite: false,
  riskSource: "none",
  riskCalibrationSize: 0,
};

const status: RouteStatusWire = {
  root: "/tmp/.hades/routing",
  budgetUsd: 10,
  spentUsd: 0.25,
  remainingUsd: 9.75,
  lambda: 0.0125,
  seed: 1,
  epsilon: 0.05,
  tier: "T4-consistency",
  totalArms: 1,
  eligibleArms: 1,
  unpricedArms: 0,
  ledgerEntries: 3,
  chainOk: true,
  chainCode: "ok",
  riskStrata: 1,
  riskCalibrated: 0,
  riskPooledFallbacks: 0,
  riskAbstainingStrata: 1,
  riskPoints: 3,
  verifiersTracked: 1,
  arms: [arm],
  loadErrors: [],
};

const explain: RouteExplainWire = {
  taskId: "explain:code",
  category: "code",
  difficulty: 0.5,
  decomposable: false,
  chosenArmId: arm.armId,
  reason: "forced-exploration",
  lambda: 0,
  budgetRemainingUsd: 10,
  ranked: [
    {
      armId: arm.armId,
      sampledScore: 1.25,
      shadowCost: 0,
      estimatedUsd: 0.0045,
      unpriced: false,
      pulls: 0,
      verified: 0,
      pVerifiedMean: 0.5,
    },
  ],
  rejected: [{ armId: "mystery/x", code: "unpriced", detail: "no published price" }],
  note: "pure read",
};

const ledger: RouteLedgerWire = {
  chainOk: true,
  chainCode: "ok",
  chainEntries: 1,
  brokenAt: null,
  attribution: [
    {
      armId: arm.armId,
      tasks: 1,
      verifiedCorrect: 1,
      silentWrong: 0,
      declined: 0,
      usd: 0.002,
      wallMs: 1500,
      vtph: 2400,
      vtphPerDollar: 1_200_000,
      escalatedInto: 0,
    },
  ],
  entries: [
    {
      seq: 0,
      taskId: "t1",
      category: "extraction",
      armId: arm.armId,
      actualUsd: 0.002,
      wallMs: 1500,
      claimedVerified: true,
      graded: true,
      hash: "abc123",
    },
  ],
};

// ===========================================================================

describe("route contract — kind tuples", () => {
  it("lists every command and event kind exactly once", () => {
    expect([...ROUTE_COMMAND_KINDS]).toEqual(["route.status", "route.arms", "route.explain", "route.ledger"]);
    expect([...ROUTE_EVENT_KINDS]).toEqual([
      "route.status",
      "route.arms",
      "route.explain",
      "route.ledger",
      "route.error",
    ]);
    expect(new Set(ROUTE_COMMAND_KINDS).size).toBe(ROUTE_COMMAND_KINDS.length);
    expect(new Set(ROUTE_EVENT_KINDS).size).toBe(ROUTE_EVENT_KINDS.length);
  });

  it("carries NO mutating command: a renderer can never record an outcome or start billing", () => {
    expect(ROUTE_COMMAND_KINDS as readonly string[]).not.toContain("route.record");
    expect(ROUTE_COMMAND_KINDS as readonly string[]).not.toContain("route.bench");
    expect(isRouteCommand({ kind: "route.record", armId: "x" })).toBe(false);
    expect(isRouteCommand({ kind: "route.bench" })).toBe(false);
    expect(isCommand({ kind: "route.record", armId: "x" })).toBe(false);
  });
});

describe("route contract — command guard", () => {
  it("accepts every well-formed command", () => {
    const cmds: RouteCommand[] = [
      { kind: "route.status" },
      { kind: "route.status", tier: "T0-execution", promptTokens: 100, expectedOutputTokens: 20 },
      { kind: "route.arms" },
      { kind: "route.arms", provider: "anthropic", maxUsdPerTask: 0.01, minContextWindow: 1000, allowUnpriced: true },
      { kind: "route.explain", category: "code" },
      { kind: "route.explain", category: "code", taskId: "t", difficulty: 0.3, decomposable: true },
      { kind: "route.ledger" },
      { kind: "route.ledger", entries: 10 },
    ];
    for (const c of cmds) expect(isRouteCommand(c)).toBe(true);
  });

  it("rejects malformed commands", () => {
    expect(isRouteCommand({ kind: "route.explain" })).toBe(false); // category required
    expect(isRouteCommand({ kind: "route.explain", category: "" })).toBe(false); // non-empty
    expect(isRouteCommand({ kind: "route.status", promptTokens: Number.NaN })).toBe(false);
    expect(isRouteCommand({ kind: "route.status", promptTokens: Infinity })).toBe(false);
    expect(isRouteCommand({ kind: "route.ledger", entries: "10" })).toBe(false);
    expect(isRouteCommand({ kind: "route.nope" })).toBe(false);
    expect(isRouteCommand(null)).toBe(false);
    expect(isRouteCommand([])).toBe(false);
  });

  it("rejects prototype-pollution keys", () => {
    const hostile = JSON.parse('{"kind":"route.status","__proto__":{"polluted":true}}');
    expect(isRouteCommand(hostile)).toBe(false);
    expect(isCommand(hostile)).toBe(false);
  });
});

describe("route contract — view guards", () => {
  it("accepts the fixtures", () => {
    expect(isRouteArmWire(arm)).toBe(true);
    expect(isRouteStatusWire(status)).toBe(true);
    expect(isRouteExplainWire(explain)).toBe(true);
    expect(isRouteLedgerWire(ledger)).toBe(true);
    expect(
      isRouteEligibilityWire({ promptTokens: 1, expectedOutputTokens: 1, eligible: [arm], rejected: [] }),
    ).toBe(true);
  });

  it("REJECTS an arm whose abstain flag disagrees with its threshold", () => {
    // "finite threshold" with no number, and "abstaining" with a number, are
    // both the shape that would let a renderer draw an accept bar for a gate
    // that accepts nothing.
    expect(isRouteArmWire({ ...arm, riskThresholdFinite: true, riskThreshold: null })).toBe(false);
    expect(isRouteArmWire({ ...arm, riskThresholdFinite: false, riskThreshold: 0.5 })).toBe(false);
    expect(isRouteArmWire({ ...arm, riskThresholdFinite: true, riskThreshold: 0.5 })).toBe(true);
  });

  it("REJECTS a non-finite number anywhere in an arm row", () => {
    expect(isRouteArmWire({ ...arm, usdMean: Number.NaN })).toBe(false);
    expect(isRouteArmWire({ ...arm, measuredVtphPerDollar: Infinity })).toBe(false);
  });

  it("REJECTS an arm missing the unpriced/costSource honesty fields", () => {
    const { unpriced: _u, ...noUnpriced } = arm;
    expect(isRouteArmWire(noUnpriced)).toBe(false);
    const { costSource: _c, ...noSource } = arm;
    expect(isRouteArmWire(noSource)).toBe(false);
  });

  it("REJECTS an explain view whose 'this changed nothing' note has been stripped", () => {
    expect(isRouteExplainWire({ ...explain, note: "" })).toBe(false);
    const { note: _n, ...noNote } = explain;
    expect(isRouteExplainWire(noNote)).toBe(false);
  });

  it("REJECTS a status view missing the chain verdict", () => {
    const { chainOk: _c, ...noChain } = status;
    expect(isRouteStatusWire(noChain)).toBe(false);
  });
});

describe("route contract — event guard + codec", () => {
  it("round-trips every event through the top-level codec", () => {
    const events: RouteEvent[] = [
      { kind: "route.status", status, at: 1 },
      { kind: "route.arms", eligibility: { promptTokens: 1, expectedOutputTokens: 1, eligible: [arm], rejected: [] }, at: 2 },
      { kind: "route.explain", explain, at: 3 },
      { kind: "route.ledger", ledger, at: 4 },
      { kind: "route.error", op: "route.status", message: "boom", at: 5 },
    ];
    for (const ev of events) {
      expect(isRouteEvent(ev)).toBe(true);
      expect(isAppEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });

  it("round-trips every command through the top-level codec", () => {
    const cmds: RouteCommand[] = [
      { kind: "route.status", tier: "T2-genrm" },
      { kind: "route.arms", allowUnpriced: true },
      { kind: "route.explain", category: "code" },
      { kind: "route.ledger", entries: 5 },
    ];
    for (const c of cmds) {
      expect(isCommand(c)).toBe(true);
      expect(decodeCommand(encodeCommand(c))).toEqual(c);
    }
  });

  it("rejects a malformed event rather than decoding it", () => {
    expect(isRouteEvent({ kind: "route.status", status: { ...status, arms: [{ bogus: true }] }, at: 1 })).toBe(false);
    expect(isRouteEvent({ kind: "route.error", op: "x", message: 5, at: 1 })).toBe(false);
    expect(() => decodeEvent(JSON.stringify({ kind: "route.ledger", ledger: {}, at: 1 }))).toThrow();
  });

  it("an Infinity threshold cannot survive JSON, which is exactly why the flag exists", () => {
    // JSON.stringify(Infinity) === "null": a renderer keying on the NUMBER
    // would read "no limit". The boolean is what carries the truth.
    const encoded = JSON.stringify({ threshold: Infinity });
    expect(JSON.parse(encoded).threshold).toBeNull();
    expect(arm.riskThresholdFinite).toBe(false);
    expect(isRouteArmWire(JSON.parse(JSON.stringify(arm)))).toBe(true);
  });
});
