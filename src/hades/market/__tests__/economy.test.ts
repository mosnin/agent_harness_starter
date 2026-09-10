/**
 * ADVERSARIAL VERIFICATION of the Verified-Work Economy
 * (`src/hades/market/economy.ts`).
 *
 * Real crypto, real adjudication, real reputation ledger throughout: a real
 * `CertificateAuthority` issues real ed25519 certificates, a real
 * `ClaimAdjudicator` independently re-derives claim truth from them, and a
 * real `ReputationLedger` tracks calibration. Conservation (every token
 * always sits in exactly one of: a balance, an escrow, or the treasury) is
 * asserted after EVERY mutating call, including after every thrown
 * `EconomyError` (state must be byte-identical, via `serialize()`, to
 * before the throw). Deterministic throughout: every timestamp is an
 * explicit literal, never `Date.now()`.
 */

import { describe, expect, it } from "vitest";
import {
  Economy,
  EconomyError,
  defaultEconomyPolicy,
  type EconomyErrorCode,
  type EconomyPolicy,
  type ParticipantAccount,
} from "../economy";
import {
  ClaimAdjudicator,
  defaultClaimPolicy,
  type ClaimAdjudication,
  type ClaimPolicy,
  type VerifiedClaim,
} from "../claims";
import { ReputationLedger, type ParticipantKind } from "../reputation";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
} from "../../styx/certificate";
import { settlementPayment } from "../../styx/market";

// ===========================================================================
// Deterministic key material — xorshift32 seeded byte generator, no
// Math.random anywhere.
// ===========================================================================

function seededRng(seed: number): (bytes: number) => Uint8Array {
  let state = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state >>>= 0;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

const CA_TRUSTED = new CertificateAuthority(generatePrivateKeyHex(seededRng(41)));
const CA_UNTRUSTED = new CertificateAuthority(generatePrivateKeyHex(seededRng(42)));
if (CA_TRUSTED.publicKeyHex() === CA_UNTRUSTED.publicKeyHex()) {
  throw new Error("test setup bug: seeded CAs collided");
}

const NOW = 1_800_000_000_000;

// ===========================================================================
// Fixtures
// ===========================================================================

function outputFor(taskId: string, participantId: string): string {
  return `output for ${taskId} by ${participantId}`;
}

function traceFor(taskId: string): string {
  return JSON.stringify({ steps: ["run", "verify"], taskId });
}

function makeClaimPolicy(overrides: Partial<ClaimPolicy> = {}): ClaimPolicy {
  return { ...defaultClaimPolicy([CA_TRUSTED.publicKeyHex()]), ...overrides };
}

function newAdjudicator(overrides: Partial<ClaimPolicy> = {}): ClaimAdjudicator {
  return new ClaimAdjudicator(makeClaimPolicy(overrides));
}

function newEconomy(
  opts: {
    adjudicator?: ClaimAdjudicator;
    reputation?: ReputationLedger;
    policy?: Partial<EconomyPolicy>;
  } = {},
): Economy {
  return new Economy({
    adjudicator: opts.adjudicator ?? newAdjudicator(),
    reputation: opts.reputation,
    policy: opts.policy,
  });
}

/** Issues a REAL certificate and wraps it into a VerifiedClaim. `claimClaimedPCorrect` (submitted with the claim, used only by claims.ts's fraud checks) defaults to `pCorrect` so it validates by default; it is independent of the AwardRequest's own `claimedPCorrect` (used for the Brier settlement payment). */
async function makeVerifiedClaim(opts: {
  taskId: string;
  participantId: string;
  pCorrect: number;
  claimClaimedPCorrect?: number;
  submittedAt: number;
  ca?: CertificateAuthority;
  payloadOverrides?: Partial<CertificatePayload>;
}): Promise<VerifiedClaim> {
  const outputText = outputFor(opts.taskId, opts.participantId);
  const traceJson = traceFor(opts.taskId);
  const ca = opts.ca ?? CA_TRUSTED;
  const payload: CertificatePayload = {
    outputSha256: sha256Hex(outputText),
    taskId: opts.taskId,
    verifierTier: "T1-reference",
    ensembleScore: opts.pCorrect,
    pCorrect: opts.pCorrect,
    epsilon: 0.05,
    traceSha256: sha256Hex(traceJson),
    verifierVersions: ["v1"],
    issuedAt: opts.submittedAt - 100,
    ...opts.payloadOverrides,
  };
  const cert = await ca.issue(payload);
  return {
    taskId: opts.taskId,
    participantId: opts.participantId,
    outputText,
    claimedPCorrect: opts.claimClaimedPCorrect ?? opts.pCorrect,
    certificate: cert,
    traceJson,
    submittedAt: opts.submittedAt,
  };
}

function makeUnverifiedClaim(opts: {
  taskId: string;
  participantId: string;
  claimedPCorrect: number;
  submittedAt: number;
}): VerifiedClaim {
  return {
    taskId: opts.taskId,
    participantId: opts.participantId,
    outputText: outputFor(opts.taskId, opts.participantId),
    claimedPCorrect: opts.claimedPCorrect,
    submittedAt: opts.submittedAt,
  };
}

const WORKER: ParticipantKind = "worker";

// ===========================================================================
// Shared assertion helpers
// ===========================================================================

/** Conservation: totalTokens() matches, and no account is ever negative. Call after EVERY mutating call. */
function assertConserved(economy: Economy, expectedTotal: number, tag = ""): void {
  expect(economy.totalTokens(), `totalTokens ${tag}`).toBeCloseTo(expectedTotal, 6);
  for (const acc of economy.accounts()) {
    expect(acc.balance, `balance(${acc.id}) ${tag}`).toBeGreaterThanOrEqual(-1e-9);
    expect(acc.escrowed, `escrowed(${acc.id}) ${tag}`).toBeGreaterThanOrEqual(-1e-9);
  }
}

function snapshot(economy: Economy): string {
  return economy.serialize();
}

function expectUnmutated(economy: Economy, before: string, tag = ""): void {
  expect(economy.serialize(), `state mutated on throw ${tag}`).toBe(before);
}

function expectSyncEconomyError(fn: () => unknown, code: EconomyErrorCode): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(EconomyError);
    expect((err as EconomyError).code).toBe(code);
  }
  expect(threw, `expected EconomyError(${code}) to be thrown`).toBe(true);
}

async function expectAsyncEconomyError(p: Promise<unknown>, code: EconomyErrorCode): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(EconomyError);
    expect((err as EconomyError).code).toBe(code);
  }
  expect(threw, `expected EconomyError(${code}) to be thrown`).toBe(true);
}

// ===========================================================================
// 0. defaultEconomyPolicy()
// ===========================================================================

describe("defaultEconomyPolicy", () => {
  it("returns sane, internally-consistent defaults", () => {
    const p = defaultEconomyPolicy();
    expect(p.stakeFraction).toBeGreaterThan(0);
    expect(p.stakeFraction).toBeLessThanOrEqual(1);
    expect(p.minStake).toBeGreaterThan(0);
    expect(p.slashOnFabrication).toBe(1);
    expect(p.refundOnHonestFail).toBeGreaterThan(0);
    expect(p.refundOnHonestFail).toBeLessThan(1);
    expect(p.demoteBrier).toBeGreaterThan(p.probationBrier);
    expect(p.probationStreak).toBeGreaterThan(0);
    expect(p.rehabCertifiedPasses).toBeGreaterThan(0);
    expect(p.probationStakeMultiplier).toBeGreaterThan(1);
    expect(p.minReputationToBid).toBeGreaterThanOrEqual(0);
    expect(p.openingBalance).toBeGreaterThan(0);
    expect(typeof p.treasuryId).toBe("string");
  });
});

// ===========================================================================
// 1. register / postTask / eligible basics + conservation on capitalization
// ===========================================================================

describe("register / postTask / eligible", () => {
  it("register mints exactly openingBalance into totalTokens; postTask/eligible do not mutate the total", () => {
    const economy = newEconomy();
    assertConserved(economy, defaultEconomyPolicy().openingBalance, "at construction");

    const acc = economy.register("alice", WORKER, 500);
    expect(acc.balance).toBe(500);
    expect(acc.escrowed).toBe(0);
    expect(acc.standing).toBe("active");
    expect(acc.consecutiveVerifiedPasses).toBe(0);
    expect(acc.consecutiveOverclaims).toBe(0);
    expect(acc.settledN).toBe(0);
    expect(acc.fabricatedN).toBe(0);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 500, "after register");

    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 500, "after postTask");

    expect(economy.eligible("alice")).toEqual({ ok: true });
    expect(economy.eligible("ghost")).toEqual({ ok: false, reason: "unknown-participant" });
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 500, "after eligible reads");
  });

  it("register defaults openingBalance to 0 and honors an arbitrary ParticipantKind", () => {
    const economy = newEconomy();
    const acc = economy.register("bob", "agent");
    expect(acc.balance).toBe(0);
    expect(acc.kind).toBe("agent");
    assertConserved(economy, defaultEconomyPolicy().openingBalance);
  });

  it("balances()/treasury()/totalTokens()/standing() reflect registered state", () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 500);
    economy.register("bob", WORKER, 250);
    expect(economy.balances()).toEqual({ alice: 500, bob: 250 });
    expect(economy.treasury()).toBe(defaultEconomyPolicy().openingBalance);
    expect(economy.standing("alice")).toBe("active");
    expect(() => economy.standing("ghost")).toThrow(EconomyError);
    expect(() => economy.account("ghost")).toThrow(EconomyError);
  });
});

// ===========================================================================
// 2. postTask illegal sequences
// ===========================================================================

describe("postTask illegal sequences", () => {
  it("duplicate-task: reposting the same taskId throws and leaves state unmutated", () => {
    const economy = newEconomy();
    economy.postTask({ taskId: "t1", domain: "code", reward: 10, postedAt: NOW });
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.postTask({ taskId: "t1", domain: "code", reward: 20, postedAt: NOW + 1 }),
      "duplicate-task",
    );
    expectUnmutated(economy, before);
    assertConserved(economy, defaultEconomyPolicy().openingBalance);
  });

  it("invalid-amount: non-finite / negative / zero reward throws and leaves state unmutated", () => {
    const economy = newEconomy();
    const before = snapshot(economy);
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
      expectSyncEconomyError(
        () => economy.postTask({ taskId: "bad", domain: "code", reward: bad, postedAt: NOW }),
        "invalid-amount",
      );
    }
    expectUnmutated(economy, before);
  });
});

// ===========================================================================
// 3. award() illegal sequences (full matrix)
// ===========================================================================

describe("award illegal sequences", () => {
  function setup(policy: Partial<EconomyPolicy> = {}): Economy {
    const economy = newEconomy({ policy });
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    return economy;
  }

  it("unknown-participant: awarding to an unregistered id throws, state unmutated", () => {
    const economy = setup();
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "ghost", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "unknown-participant",
    );
    expectUnmutated(economy, before);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);
  });

  it("unknown-task: awarding a task that was never posted throws, state unmutated", () => {
    const economy = setup();
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "never-posted", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "unknown-task",
    );
    expectUnmutated(economy, before);
  });

  it("duplicate-award: a second award for an already-awarded task throws, state unmutated relative to the first award", () => {
    const economy = setup();
    economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "duplicate-award",
    );
    expectUnmutated(economy, before);
  });

  it("invalid-amount: non-finite / negative / zero price throws, state unmutated", () => {
    const economy = setup();
    const before = snapshot(economy);
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expectSyncEconomyError(
        () => economy.award({ taskId: "t1", participantId: "alice", price: bad, claimedPCorrect: 0.9, awardedAt: NOW }),
        "invalid-amount",
      );
    }
    // non-finite claimedPCorrect also invalid-amount
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: NaN, awardedAt: NOW }),
      "invalid-amount",
    );
    expectUnmutated(economy, before);
  });

  it("deadline-passed: awarding after the task's deadline throws, state unmutated", () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, deadline: NOW - 1, postedAt: NOW - 100 });
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "deadline-passed",
    );
    expectUnmutated(economy, before);
  });

  it("stake-below-minimum: a computed stake under minStake throws, state unmutated", () => {
    const economy = setup({ minStake: 1000 });
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "alice", price: 10, claimedPCorrect: 0.9, awardedAt: NOW }),
      "stake-below-minimum",
    );
    expectUnmutated(economy, before);
  });

  it("insufficient-balance: a stake exceeding the participant's balance throws, state unmutated", () => {
    const economy = newEconomy();
    economy.register("poor", WORKER, 5);
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    const before = snapshot(economy);
    // stake = 40 * 0.25 = 10 > balance 5
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "poor", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "insufficient-balance",
    );
    expectUnmutated(economy, before);
  });

  it("award to a banned participant throws participant-not-eligible, state unmutated", async () => {
    const economy = newEconomy();
    economy.register("eve", WORKER, 1000);
    economy.postTask({ taskId: "t-fab", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "t-fab", participantId: "eve", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    const cert = await CA_TRUSTED.issue({
      outputSha256: sha256Hex(outputFor("t-fab", "eve")),
      taskId: "t-fab",
      verifierTier: "T1-reference",
      ensembleScore: 0.9,
      pCorrect: 0.9,
      epsilon: 0.05,
      traceSha256: sha256Hex(traceFor("t-fab")),
      verifierVersions: ["v1"],
      issuedAt: NOW - 100,
    });
    const forged = { ...cert, signature: cert.signature.slice(0, -2) + (cert.signature.slice(-2) === "00" ? "11" : "00") };
    const settlement = await economy.submitClaim({
      taskId: "t-fab",
      participantId: "eve",
      outputText: outputFor("t-fab", "eve"),
      claimedPCorrect: 0.9,
      certificate: forged,
      traceJson: traceFor("t-fab"),
      submittedAt: NOW + 10,
    });
    expect(settlement.status).toBe("fabricated");
    expect(economy.standing("eve")).toBe("banned");

    economy.postTask({ taskId: "t2", domain: "code", reward: 50, postedAt: NOW });
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t2", participantId: "eve", price: 10, claimedPCorrect: 0.5, awardedAt: NOW + 20 }),
      "participant-not-eligible",
    );
    expectUnmutated(economy, before);
  });

  it("reputation-too-low precedence: banned beats reputation-too-low, but an absurd threshold alone trips reputation-too-low for a fresh participant", () => {
    // With an unreachable threshold, even a brand-new (score=1) participant fails eligibility on reputation, not on any other ground.
    const economy = setup({ minReputationToBid: 1.5 });
    expect(economy.eligible("alice")).toEqual({ ok: false, reason: "reputation-too-low" });
    const before = snapshot(economy);
    expectSyncEconomyError(
      () => economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }),
      "reputation-too-low",
    );
    expectUnmutated(economy, before);
  });
});

// ===========================================================================
// 4. submitClaim() illegal sequences
// ===========================================================================

describe("submitClaim illegal sequences", () => {
  async function setup(): Promise<Economy> {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.register("mallory", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    return economy;
  }

  it("no-award: claiming a task with no award throws, state unmutated", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    const before = snapshot(economy);
    await expectAsyncEconomyError(
      economy.submitClaim(makeUnverifiedClaim({ taskId: "t1", participantId: "alice", claimedPCorrect: 0.9, submittedAt: NOW })),
      "no-award",
    );
    expectUnmutated(economy, before);
  });

  it("no-award: a claim from the WRONG participant for an awarded task also throws no-award, state unmutated", async () => {
    const economy = await setup();
    const before = snapshot(economy);
    await expectAsyncEconomyError(
      economy.submitClaim(makeUnverifiedClaim({ taskId: "t1", participantId: "mallory", claimedPCorrect: 0.9, submittedAt: NOW })),
      "no-award",
    );
    expectUnmutated(economy, before);
  });

  it("duplicate-claim: a second submitClaim() fired before the first resolves is rejected, and only one settlement is ever recorded", async () => {
    const economy = await setup();
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.95, submittedAt: NOW + 10 });
    const p1 = economy.submitClaim(claim);
    const p2 = economy.submitClaim(claim);
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    const outcomes = [r1, r2];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(EconomyError);
    expect((rejection.reason as EconomyError).code).toBe("duplicate-claim");
    expect(economy.history().length).toBe(1);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000 + 1000);
  });

  it("already-settled: claiming again after a settlement has completed throws, state unmutated", async () => {
    const economy = await setup();
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.95, submittedAt: NOW + 10 });
    await economy.submitClaim(claim);
    const before = snapshot(economy);
    await expectAsyncEconomyError(economy.submitClaim(claim), "already-settled");
    expectUnmutated(economy, before);
  });

  it("cannot escape a slash by submitting a valid claim after a fabricated one for the same task: already-settled, participant stays banned/slashed", async () => {
    const economy = await setup();
    const cert = await CA_TRUSTED.issue({
      outputSha256: sha256Hex(outputFor("t1", "alice")),
      taskId: "t1",
      verifierTier: "T1-reference",
      ensembleScore: 0.9,
      pCorrect: 0.9,
      epsilon: 0.05,
      traceSha256: sha256Hex(traceFor("t1")),
      verifierVersions: ["v1"],
      issuedAt: NOW - 100,
    });
    const forged = { ...cert, publicKey: CA_UNTRUSTED.publicKeyHex() }; // untrusted-issuer forgery
    const fabSettlement = await economy.submitClaim({
      taskId: "t1",
      participantId: "alice",
      outputText: outputFor("t1", "alice"),
      claimedPCorrect: 0.9,
      certificate: forged,
      traceJson: traceFor("t1"),
      submittedAt: NOW + 5,
    });
    expect(fabSettlement.status).toBe("fabricated");
    expect(economy.standing("alice")).toBe("banned");

    const before = snapshot(economy);
    const validClaim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.95, submittedAt: NOW + 10 });
    await expectAsyncEconomyError(economy.submitClaim(validClaim), "already-settled");
    expectUnmutated(economy, before);
    expect(economy.standing("alice")).toBe("banned");
  });
});

// ===========================================================================
// 5. Happy-path settlement + payment cross-check against settlementPayment
// ===========================================================================

describe("settlement outcomes cross-checked against the real settlementPayment rule", () => {
  it("verified pass: full Brier payment, full stake refund, standing stays active, streak counters update", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    const price = 40;
    const claimedPCorrect = 0.8;
    const award = economy.award({ taskId: "t1", participantId: "alice", price, claimedPCorrect, awardedAt: NOW });
    expect(award.stake).toBeCloseTo(10, 9);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);

    const before = economy.account("alice");
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.92, submittedAt: NOW + 10 });
    const settlement = await economy.submitClaim(claim);

    const expectedPayment = Math.min(
      settlementPayment({ workerId: "alice", taskId: "t1", claimedPCorrect, price }, true),
      50,
    );
    expect(settlement.status).toBe("verified");
    expect(settlement.payment).toBeCloseTo(expectedPayment, 9);
    expect(settlement.refundedStake).toBeCloseTo(award.stake, 9);
    expect(settlement.slashed).toBeCloseTo(0, 9);
    expect(settlement.treasuryDelta).toBeCloseTo(-expectedPayment, 9);
    expect(settlement.standingBefore).toBe("active");
    expect(settlement.standingAfter).toBe("active");

    const after = economy.account("alice");
    expect(after.balance).toBeCloseTo(before.balance + settlement.payment + settlement.refundedStake, 9);
    expect(after.escrowed).toBeCloseTo(0, 9);
    expect(after.consecutiveVerifiedPasses).toBe(1);
    expect(after.consecutiveOverclaims).toBe(0);
    expect(after.settledN).toBe(1);
    expect(after.fabricatedN).toBe(0);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);
  });

  it("verified pass with payment capped at the posted reward", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 10, postedAt: NOW });
    const award = economy.award({ taskId: "t1", participantId: "alice", price: 100, claimedPCorrect: 1, awardedAt: NOW });
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 1, submittedAt: NOW + 10 });
    const settlement = await economy.submitClaim(claim);
    const uncapped = settlementPayment({ workerId: "alice", taskId: "t1", claimedPCorrect: 1, price: 100 }, true);
    expect(uncapped).toBeGreaterThan(10);
    expect(settlement.payment).toBeCloseTo(10, 9); // capped at reward
    expect(settlement.refundedStake).toBeCloseTo(award.stake, 9);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);
  });

  it("verified fail (honest, well-calibrated low claim): Brier payment at outcome 0 rewards accurate self-disclosure, partial stake refund", async () => {
    const economy = newEconomy({ policy: { refundOnHonestFail: 0.5 } });
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    const price = 40;
    const claimedPCorrect = 0.05; // honest, well-calibrated: predicted likely failure
    const award = economy.award({ taskId: "t1", participantId: "alice", price, claimedPCorrect, awardedAt: NOW });
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.05, submittedAt: NOW + 10 });
    const settlement = await economy.submitClaim(claim);

    const expectedPayment = Math.min(
      settlementPayment({ workerId: "alice", taskId: "t1", claimedPCorrect, price }, false),
      50,
    );
    expect(settlement.status).toBe("verified");
    expect(settlement.payment).toBeCloseTo(expectedPayment, 9);
    expect(settlement.payment).toBeGreaterThan(price * 0.9); // barely penalized for an accurate low-confidence forecast
    expect(settlement.refundedStake).toBeCloseTo(award.stake * 0.5, 9);
    expect(settlement.slashed).toBeCloseTo(award.stake * 0.5, 9);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);

    const acc = economy.account("alice");
    expect(acc.consecutiveOverclaims).toBe(1);
    expect(acc.consecutiveVerifiedPasses).toBe(0);
  });

  it("verified fail with an overclaimed BID (award.claimedPCorrect high, honest cert low): payment is small, correctly penalized", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    const price = 40;
    const bidClaimedPCorrect = 0.9; // confident bid...
    const award = economy.award({ taskId: "t1", participantId: "alice", price, claimedPCorrect: bidClaimedPCorrect, awardedAt: NOW });
    // ...but the honestly-issued certificate discloses low true confidence — an honest disclosure narrower than the bid.
    const claim = await makeVerifiedClaim({
      taskId: "t1",
      participantId: "alice",
      pCorrect: 0.1,
      claimClaimedPCorrect: 0.1,
      submittedAt: NOW + 10,
    });
    const settlement = await economy.submitClaim(claim);
    const expectedPayment = Math.min(
      settlementPayment({ workerId: "alice", taskId: "t1", claimedPCorrect: bidClaimedPCorrect, price }, false),
      50,
    );
    expect(settlement.payment).toBeCloseTo(expectedPayment, 9);
    expect(settlement.payment).toBeLessThan(price * 0.25); // overconfident bid against a real fail pays little
    void award;
  });

  it("unverified: zero payment regardless of claimed confidence, partial stake refund, counted as a non-pass", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    const award = economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    const settlement = await economy.submitClaim(
      makeUnverifiedClaim({ taskId: "t1", participantId: "alice", claimedPCorrect: 0.9, submittedAt: NOW + 10 }),
    );
    expect(settlement.status).toBe("unverified");
    expect(settlement.payment).toBe(0);
    expect(settlement.refundedStake).toBeCloseTo(award.stake * 0.5, 9);
    expect(settlement.slashed).toBeCloseTo(award.stake * 0.5, 9);
    const acc = economy.account("alice");
    expect(acc.consecutiveOverclaims).toBe(1);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);
  });

  it("payment cross-check table: several price/claim/pCorrect/reward combinations all match settlementPayment exactly", async () => {
    const cases = [
      { price: 10, claimedPCorrect: 0.5, pCorrect: 0.9, reward: 100 },
      { price: 50, claimedPCorrect: 0.95, pCorrect: 0.97, reward: 100 },
      { price: 30, claimedPCorrect: 0.2, pCorrect: 0.1, reward: 100 },
      { price: 15, claimedPCorrect: 0.6, pCorrect: 0.55, reward: 5 }, // capped case
    ];
    let i = 0;
    for (const c of cases) {
      i += 1;
      const taskId = `tc-${i}`;
      const economy = newEconomy();
      economy.register("w", WORKER, 1000);
      economy.postTask({ taskId, domain: "code", reward: c.reward, postedAt: NOW });
      economy.award({ taskId, participantId: "w", price: c.price, claimedPCorrect: c.claimedPCorrect, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "w", pCorrect: c.pCorrect, submittedAt: NOW + 10 });
      const settlement = await economy.submitClaim(claim);
      const gatePassed = c.pCorrect >= 0.5;
      const expected = Math.min(
        settlementPayment({ workerId: "w", taskId, claimedPCorrect: c.claimedPCorrect, price: c.price }, gatePassed),
        c.reward,
      );
      expect(settlement.payment, `case ${i}`).toBeCloseTo(expected, 9);
    }
  });
});

// ===========================================================================
// 6. Fabrication end to end, via the public API, with REAL forged certificates
//    (attack shapes reused from T2's claims.test.ts)
// ===========================================================================

describe("fabrication end to end (real forged certificates through the public API)", () => {
  async function payloadFor(taskId: string, participantId: string, overrides: Partial<CertificatePayload> = {}): Promise<CertificatePayload> {
    return {
      outputSha256: sha256Hex(outputFor(taskId, participantId)),
      taskId,
      verifierTier: "T1-reference",
      ensembleScore: 0.9,
      pCorrect: 0.9,
      epsilon: 0.05,
      traceSha256: sha256Hex(traceFor(taskId)),
      verifierVersions: ["v1"],
      issuedAt: NOW - 100,
      ...overrides,
    };
  }

  async function setupAwarded(taskId = "t-fab"): Promise<{ economy: Economy; stake: number }> {
    const economy = newEconomy();
    economy.register("eve", WORKER, 1000);
    economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
    const award = economy.award({ taskId, participantId: "eve", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    return { economy, stake: award.stake };
  }

  it("bad-signature forgery: banned in ONE settlement, stake fully in the treasury, reputation score exactly 0, every subsequent award throws participant-not-eligible", async () => {
    const { economy, stake } = await setupAwarded();
    const cert = await CA_TRUSTED.issue(await payloadFor("t-fab", "eve"));
    const flipped = cert.signature.slice(0, -2) + (cert.signature.slice(-2) === "00" ? "11" : "00");
    const forged = { ...cert, signature: flipped };

    const treasuryBefore = economy.treasury();
    const settlement = await economy.submitClaim({
      taskId: "t-fab",
      participantId: "eve",
      outputText: outputFor("t-fab", "eve"),
      claimedPCorrect: 0.9,
      certificate: forged,
      traceJson: traceFor("t-fab"),
      submittedAt: NOW + 10,
    });

    expect(settlement.status).toBe("fabricated");
    expect(settlement.codes).toContain("bad-signature");
    expect(settlement.payment).toBe(0);
    expect(settlement.slashed).toBeCloseTo(stake, 9);
    expect(settlement.refundedStake).toBeCloseTo(0, 9);
    expect(settlement.standingBefore).toBe("active");
    expect(settlement.standingAfter).toBe("banned");
    expect(economy.standing("eve")).toBe("banned");
    expect(economy.treasury()).toBeCloseTo(treasuryBefore + stake, 9);
    expect(economy.reputation().state("eve")!.score).toBe(0);
    expect(economy.account("eve").fabricatedN).toBe(1);
    assertConserved(economy, defaultEconomyPolicy().openingBalance + 1000);

    economy.postTask({ taskId: "t2", domain: "code", reward: 50, postedAt: NOW });
    expectSyncEconomyError(
      () => economy.award({ taskId: "t2", participantId: "eve", price: 10, claimedPCorrect: 0.5, awardedAt: NOW + 1 }),
      "participant-not-eligible",
    );
  });

  it("untrusted-issuer forgery (genuinely valid signature, wrong key): fabricated, banned, slashed", async () => {
    const { economy, stake } = await setupAwarded();
    const cert = await CA_UNTRUSTED.issue(await payloadFor("t-fab", "eve"));
    const settlement = await economy.submitClaim({
      taskId: "t-fab",
      participantId: "eve",
      outputText: outputFor("t-fab", "eve"),
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: traceFor("t-fab"),
      submittedAt: NOW + 10,
    });
    expect(settlement.status).toBe("fabricated");
    expect(settlement.codes).toContain("untrusted-issuer");
    expect(settlement.slashed).toBeCloseTo(stake, 9);
    expect(economy.standing("eve")).toBe("banned");
  });

  it("output-mismatch forgery (cert for a different output rebound to this claim): fabricated, banned, slashed", async () => {
    const { economy, stake } = await setupAwarded();
    const cert = await CA_TRUSTED.issue(await payloadFor("t-fab", "eve", { outputSha256: sha256Hex("a completely different delivered output") }));
    const settlement = await economy.submitClaim({
      taskId: "t-fab",
      participantId: "eve",
      outputText: outputFor("t-fab", "eve"),
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: traceFor("t-fab"),
      submittedAt: NOW + 10,
    });
    expect(settlement.status).toBe("fabricated");
    expect(settlement.codes).toContain("output-mismatch");
    expect(settlement.slashed).toBeCloseTo(stake, 9);
    expect(economy.standing("eve")).toBe("banned");
  });

  it("replayed-certificate attack: a certificate legitimately consumed for one task, re-bound to another task via a forged envelope, is caught end to end", async () => {
    const adjudicator = newAdjudicator();
    const economy = newEconomy({ adjudicator });
    economy.register("ivan", WORKER, 1000);
    economy.postTask({ taskId: "t-a", domain: "code", reward: 50, postedAt: NOW });
    economy.postTask({ taskId: "t-b", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "t-a", participantId: "ivan", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    const stakeB = economy.award({ taskId: "t-b", participantId: "ivan", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }).stake;

    const claimA = await makeVerifiedClaim({ taskId: "t-a", participantId: "ivan", pCorrect: 0.95, submittedAt: NOW + 10 });
    const settlementA = await economy.submitClaim(claimA);
    expect(settlementA.status).toBe("verified");

    // Reuse claimA's SAME certificate (same signature) but rebind it to task t-b.
    const claimB: VerifiedClaim = {
      ...claimA,
      taskId: "t-b",
      outputText: outputFor("t-b", "ivan"),
      submittedAt: NOW + 20,
    };
    const settlementB = await economy.submitClaim(claimB);
    expect(settlementB.status).toBe("fabricated");
    expect(settlementB.codes).toContain("replayed-certificate");
    expect(settlementB.slashed).toBeCloseTo(stakeB, 9);
    expect(economy.standing("ivan")).toBe("banned");
  });
});

// ===========================================================================
// 7. Hysteresis-guarded standing state machine
// ===========================================================================

describe("standing hysteresis", () => {
  function taggedPolicy(overrides: Partial<EconomyPolicy>): Partial<EconomyPolicy> {
    // minReputationToBid is exercised in its own dedicated tests above; a
    // participant repeatedly failing on a LOW, well-calibrated claim has
    // zero outcome variance (always outcome=0), which collapses the
    // Brier-skill-score's `raw` term to 0 by construction (see
    // reputation.ts's reputationScore doc) even while decayedBrier itself
    // stays small — so it is disabled here to isolate standing hysteresis.
    return { openingBalance: 100_000, minReputationToBid: 0, ...overrides };
  }

  it("fast trip-wire: a consecutive-overclaim streak alone (low decayed Brier throughout) trips active -> probation exactly at probationStreak", async () => {
    const economy = newEconomy({
      policy: taggedPolicy({ probationStreak: 3, probationBrier: 0.9, demoteBrier: 0.99, rehabCertifiedPasses: 3 }),
    });
    economy.register("bob", WORKER, 1000);
    for (let i = 1; i <= 3; i++) {
      const taskId = `t${i}`;
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "bob", price: 20, claimedPCorrect: 0.1, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "bob", pCorrect: 0.1, submittedAt: NOW + i * 10 });
      const settlement = await economy.submitClaim(claim);
      expect(settlement.status).toBe("verified");
      if (i < 3) {
        expect(economy.standing("bob"), `after event ${i}`).toBe("active");
      } else {
        expect(economy.standing("bob"), `after event ${i}`).toBe("probation");
      }
    }
    // Isolation: the decayed Brier stayed low throughout — this was the streak trip-wire, not the threshold one.
    expect(economy.reputation().state("bob")!.decayedBrier).toBeLessThan(0.3);
    expect(economy.account("bob").consecutiveOverclaims).toBe(3);
  });

  it("slow trip-wire: decayed Brier alone (streak far below probationStreak) trips active -> probation", async () => {
    const economy = newEconomy({
      policy: taggedPolicy({ probationStreak: 10, probationBrier: 0.3, demoteBrier: 0.9, rehabCertifiedPasses: 3 }),
    });
    economy.register("carol", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    // Overclaimed BID (0.9) against an honestly-certified fail (0.1) -> high brierError from a single event.
    economy.award({ taskId: "t1", participantId: "carol", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
    const claim = await makeVerifiedClaim({ taskId: "t1", participantId: "carol", pCorrect: 0.1, submittedAt: NOW + 10 });
    const settlement = await economy.submitClaim(claim);
    expect(settlement.status).toBe("verified");
    expect(economy.account("carol").consecutiveOverclaims).toBe(1); // nowhere near probationStreak=10
    expect(economy.standing("carol")).toBe("probation"); // threshold path fired regardless
  });

  it("does not flap: a single verified pass mid-probation does not clear it; exactly rehabCertifiedPasses CONSECUTIVE passes does; a mid-streak failure resets the counter", async () => {
    const economy = newEconomy({
      policy: taggedPolicy({ probationStreak: 3, probationBrier: 0.9, demoteBrier: 0.99, rehabCertifiedPasses: 3 }),
    });
    economy.register("dan", WORKER, 1000);

    async function fail(taskId: string, at: number): Promise<void> {
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "dan", price: 20, claimedPCorrect: 0.1, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "dan", pCorrect: 0.1, submittedAt: at });
      await economy.submitClaim(claim);
    }
    async function pass(taskId: string, at: number): Promise<void> {
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "dan", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "dan", pCorrect: 0.95, submittedAt: at });
      await economy.submitClaim(claim);
    }

    let t = NOW;
    await fail("f1", (t += 10));
    await fail("f2", (t += 10));
    await fail("f3", (t += 10));
    expect(economy.standing("dan")).toBe("probation");

    // One good result: streak=1 < rehabCertifiedPasses=3 -> still probation, no flap.
    await pass("p1", (t += 10));
    expect(economy.standing("dan")).toBe("probation");
    expect(economy.account("dan").consecutiveVerifiedPasses).toBe(1);

    // A failure mid-rehab resets the counter.
    await fail("f4", (t += 10));
    expect(economy.account("dan").consecutiveVerifiedPasses).toBe(0);
    expect(economy.standing("dan")).toBe("probation");

    // Now complete exactly rehabCertifiedPasses=3 CONSECUTIVE passes.
    await pass("p2", (t += 10));
    expect(economy.standing("dan"), "1 of 3").toBe("probation");
    await pass("p3", (t += 10));
    expect(economy.standing("dan"), "2 of 3").toBe("probation");
    await pass("p4", (t += 10));
    expect(economy.standing("dan"), "3 of 3").toBe("active");
  });

  it("probation -> demoted when decayed Brier crosses demoteBrier; demoted -> active via the same rehab streak", async () => {
    const economy = newEconomy({
      policy: taggedPolicy({ probationStreak: 100, probationBrier: 0.2, demoteBrier: 0.5, rehabCertifiedPasses: 2 }),
    });
    economy.register("erin", WORKER, 1000);

    async function overclaimFail(taskId: string, at: number): Promise<void> {
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "erin", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "erin", pCorrect: 0.1, submittedAt: at });
      await economy.submitClaim(claim);
    }
    async function pass(taskId: string, at: number): Promise<void> {
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "erin", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "erin", pCorrect: 0.95, submittedAt: at });
      await economy.submitClaim(claim);
    }

    let t = NOW;
    await overclaimFail("f1", (t += 10)); // decayedBrier ~0.81 > probationBrier=0.2 -> probation
    expect(economy.standing("erin")).toBe("probation");

    await overclaimFail("f2", (t += 10)); // decayedBrier stays high > demoteBrier=0.5 -> demoted
    expect(economy.standing("erin")).toBe("demoted");

    await pass("p1", (t += 10));
    expect(economy.standing("erin"), "1 of 2").toBe("demoted");
    await pass("p2", (t += 10));
    expect(economy.standing("erin"), "2 of 2").toBe("active");
  });

  it("demoted awards: price above the reduced ceiling throws participant-not-eligible; price within it succeeds at probationStakeMultiplier x stake", async () => {
    const economy = newEconomy({
      policy: taggedPolicy({ probationStreak: 100, probationBrier: 0.2, demoteBrier: 0.4, probationStakeMultiplier: 2 }),
    });
    economy.register("frank", WORKER, 1000);
    let t = NOW;
    economy.postTask({ taskId: "f1", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "f1", participantId: "frank", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
    await economy.submitClaim(await makeVerifiedClaim({ taskId: "f1", participantId: "frank", pCorrect: 0.1, submittedAt: (t += 10) }));
    economy.postTask({ taskId: "f2", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "f2", participantId: "frank", price: 20, claimedPCorrect: 0.9, awardedAt: NOW });
    await economy.submitClaim(await makeVerifiedClaim({ taskId: "f2", participantId: "frank", pCorrect: 0.1, submittedAt: (t += 10) }));
    expect(economy.standing("frank")).toBe("demoted");

    economy.postTask({ taskId: "big", domain: "code", reward: 100, postedAt: NOW });
    const before = snapshot(economy);
    // ceiling = reward / probationStakeMultiplier = 100 / 2 = 50
    expectSyncEconomyError(
      () => economy.award({ taskId: "big", participantId: "frank", price: 60, claimedPCorrect: 0.9, awardedAt: (t += 10) }),
      "participant-not-eligible",
    );
    expectUnmutated(economy, before);

    economy.postTask({ taskId: "small", domain: "code", reward: 100, postedAt: NOW });
    const award = economy.award({ taskId: "small", participantId: "frank", price: 40, claimedPCorrect: 0.9, awardedAt: (t += 10) });
    expect(award.stake).toBeCloseTo(40 * 0.25 * 2, 9); // doubled stake for a demoted participant
  });
});

// ===========================================================================
// 8. Rehabilitation with real numbers
// ===========================================================================

describe("rehabilitation genuinely works", () => {
  it("an honest participant that hits probation after a bad streak returns to active and its balance recovers, with real numbers", async () => {
    const economy = newEconomy({
      policy: {
        openingBalance: 100_000,
        probationStreak: 3,
        probationBrier: 0.9,
        demoteBrier: 0.99,
        rehabCertifiedPasses: 3,
        refundOnHonestFail: 0.5,
        minReputationToBid: 0,
      },
    });
    economy.register("gwen", WORKER, 1000);
    let t = NOW;
    let balance = 1000;

    // Bad streak: 3 unverified claims (no certificate — honest abstention,
    // but zero payment and only a partial stake refund, a genuine net loss
    // each time) — this trips the streak trip-wire without needing a
    // dramatic decayed-Brier swing.
    for (let i = 1; i <= 3; i++) {
      const taskId = `bad${i}`;
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "gwen", price: 20, claimedPCorrect: 0.5, awardedAt: NOW });
      const settlement = await economy.submitClaim(
        makeUnverifiedClaim({ taskId, participantId: "gwen", claimedPCorrect: 0.5, submittedAt: (t += 10) }),
      );
      expect(settlement.status).toBe("unverified");
      expect(settlement.payment).toBe(0);
      balance = economy.account("gwen").balance;
    }
    expect(economy.standing("gwen")).toBe("probation");
    const balanceAfterBadStreak = economy.account("gwen").balance;
    expect(balanceAfterBadStreak).toBeLessThan(1000); // net loss from partial-refund misses

    // Recovery: rehabCertifiedPasses consecutive honest, confident, VERIFIED PASSES.
    for (let i = 1; i <= 3; i++) {
      const taskId = `good${i}`;
      economy.postTask({ taskId, domain: "code", reward: 50, postedAt: NOW });
      economy.award({ taskId, participantId: "gwen", price: 30, claimedPCorrect: 0.9, awardedAt: NOW });
      const claim = await makeVerifiedClaim({ taskId, participantId: "gwen", pCorrect: 0.95, submittedAt: (t += 10) });
      const settlement = await economy.submitClaim(claim);
      expect(settlement.status).toBe("verified");
      expect(settlement.refundedStake).toBeCloseTo(30 * 0.25, 9); // full stake refund on a pass
    }
    expect(economy.standing("gwen")).toBe("active");
    const balanceAfterRecovery = economy.account("gwen").balance;
    expect(balanceAfterRecovery).toBeGreaterThan(balanceAfterBadStreak); // genuinely earned it back
    expect(economy.account("gwen").escrowed).toBeCloseTo(0, 9);
    assertConserved(economy, 100_000 + 1000);
    void balance;
  });
});

// ===========================================================================
// 9. Determinism / replay
// ===========================================================================

describe("determinism / replay", () => {
  async function runScript(): Promise<Economy> {
    const economy = new Economy({
      adjudicator: newAdjudicator(),
      reputation: new ReputationLedger(),
      policy: { openingBalance: 50_000 },
    });
    economy.register("p1", WORKER, 1000);
    economy.register("p2", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    economy.postTask({ taskId: "t2", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "t1", participantId: "p1", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    economy.award({ taskId: "t2", participantId: "p2", price: 40, claimedPCorrect: 0.1, awardedAt: NOW });
    await economy.submitClaim(await makeVerifiedClaim({ taskId: "t1", participantId: "p1", pCorrect: 0.95, submittedAt: NOW + 10 }));
    await economy.submitClaim(await makeVerifiedClaim({ taskId: "t2", participantId: "p2", pCorrect: 0.05, submittedAt: NOW + 20 }));
    try {
      await economy.submitClaim(await makeVerifiedClaim({ taskId: "t1", participantId: "p1", pCorrect: 0.95, submittedAt: NOW + 30 }));
    } catch {
      /* already-settled — exercised deliberately so replay covers a thrown path too */
    }
    return economy;
  }

  it("two fresh Economy instances fed an identical operation sequence produce byte-identical serialize() and history()", async () => {
    const e1 = await runScript();
    const e2 = await runScript();
    expect(e1.serialize()).toBe(e2.serialize());
    expect(e1.history()).toEqual(e2.history());
    expect(e1.totalTokens()).toBe(e2.totalTokens());
  });
});

// ===========================================================================
// 10. Adversarial: second-identity laundering
// ===========================================================================

describe("adversarial: registering a second identity does not launder a demoted reputation", () => {
  it("per-identity accounting is exact: a banned identity stays banned/slashed; a fresh identity is independently active and unaffected", async () => {
    const economy = newEconomy({ policy: { openingBalance: 100_000 } });
    economy.register("heidi-1", WORKER, 1000);
    economy.register("heidi-2", WORKER, 1000);

    economy.postTask({ taskId: "t-fab", domain: "code", reward: 50, postedAt: NOW });
    const stake1 = economy.award({ taskId: "t-fab", participantId: "heidi-1", price: 40, claimedPCorrect: 0.9, awardedAt: NOW }).stake;
    const cert = await CA_UNTRUSTED.issue({
      outputSha256: sha256Hex(outputFor("t-fab", "heidi-1")),
      taskId: "t-fab",
      verifierTier: "T1-reference",
      ensembleScore: 0.9,
      pCorrect: 0.9,
      epsilon: 0.05,
      traceSha256: sha256Hex(traceFor("t-fab")),
      verifierVersions: ["v1"],
      issuedAt: NOW - 100,
    });
    const settlement1 = await economy.submitClaim({
      taskId: "t-fab",
      participantId: "heidi-1",
      outputText: outputFor("t-fab", "heidi-1"),
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: traceFor("t-fab"),
      submittedAt: NOW + 10,
    });
    expect(settlement1.status).toBe("fabricated");
    expect(economy.standing("heidi-1")).toBe("banned");
    const treasuryAfterFab = economy.treasury();
    expect(treasuryAfterFab).toBeCloseTo(100_000 + stake1, 9);

    // A completely separate, fresh identity behaves entirely normally.
    economy.postTask({ taskId: "t-honest", domain: "code", reward: 50, postedAt: NOW });
    const award2 = economy.award({ taskId: "t-honest", participantId: "heidi-2", price: 30, claimedPCorrect: 0.9, awardedAt: NOW });
    const claim2 = await makeVerifiedClaim({ taskId: "t-honest", participantId: "heidi-2", pCorrect: 0.95, submittedAt: NOW + 20 });
    const settlement2 = await economy.submitClaim(claim2);
    expect(settlement2.status).toBe("verified");
    expect(economy.standing("heidi-2")).toBe("active");
    expect(economy.account("heidi-2").fabricatedN).toBe(0);

    // heidi-1's ban/slash is untouched by heidi-2's separate honest activity.
    expect(economy.standing("heidi-1")).toBe("banned");
    expect(economy.account("heidi-1").fabricatedN).toBe(1);
    expect(economy.account("heidi-1").balance).toBeCloseTo(1000 - stake1, 9); // never got the stake back

    // Treasury tells the truth: it moved by exactly (+slash from heidi-1) + (-payment to heidi-2).
    const expectedTreasury = 100_000 + stake1 - settlement2.payment;
    expect(economy.treasury()).toBeCloseTo(expectedTreasury, 9);
    assertConserved(economy, 100_000 + 1000 + 1000);
    void award2;
  });
});

// ===========================================================================
// 11. Fake adjudicator — pipeline propagates an arbitrary ClaimStatus
//     (the ONE narrowly-scoped exception to "no mock adjudicator")
// ===========================================================================

class FakeStatusAdjudicator {
  constructor(private readonly adjudication: Omit<ClaimAdjudication, "taskId" | "participantId">) {}
  async adjudicate(claim: VerifiedClaim, _now: number): Promise<ClaimAdjudication> {
    void _now;
    return { ...this.adjudication, taskId: claim.taskId, participantId: claim.participantId };
  }
  seenCertificates(): number {
    return 0;
  }
  forget(): void {}
  reset(): void {}
}

describe("fake adjudicator proves the pipeline propagates an arbitrary ClaimStatus (wiring, not claims.ts's crypto)", () => {
  it("a fake 'verified' verdict flows through to a real Brier payment and standing update, with no real certificate involved", async () => {
    const fake = new FakeStatusAdjudicator({
      status: "verified",
      codes: [],
      certSha256: "fake-cert-sha",
      pCorrect: 0.77,
      tier: "T1-reference",
      epsilon: 0.05,
      score: 0.77,
      fabricated: false,
      detail: "fake",
    }) as unknown as ClaimAdjudicator;

    const economy = newEconomy({ adjudicator: fake });
    economy.register("w", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "t1", participantId: "w", price: 40, claimedPCorrect: 0.6, awardedAt: NOW });

    const settlement = await economy.submitClaim({
      taskId: "t1",
      participantId: "w",
      outputText: "anything at all — the fake never looks at it",
      claimedPCorrect: 0.6,
      submittedAt: NOW + 10,
    });

    expect(settlement.status).toBe("verified");
    const expected = Math.min(settlementPayment({ workerId: "w", taskId: "t1", claimedPCorrect: 0.6, price: 40 }, true), 50);
    expect(settlement.payment).toBeCloseTo(expected, 9);
    expect(settlement.standingAfter).toBe("active");
  });

  it("a fake 'fabricated' verdict still bans and slashes in one settlement, purely from the adjudicator's say-so", async () => {
    const fake = new FakeStatusAdjudicator({
      status: "fabricated",
      codes: ["untrusted-issuer"],
      certSha256: "fake-cert-sha-2",
      pCorrect: undefined,
      tier: undefined,
      epsilon: undefined,
      score: 0,
      fabricated: true,
      detail: "fake fabrication",
    }) as unknown as ClaimAdjudicator;

    const economy = newEconomy({ adjudicator: fake });
    economy.register("x", WORKER, 1000);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    const award = economy.award({ taskId: "t1", participantId: "x", price: 40, claimedPCorrect: 0.6, awardedAt: NOW });

    const settlement = await economy.submitClaim({
      taskId: "t1",
      participantId: "x",
      outputText: "irrelevant",
      claimedPCorrect: 0.6,
      submittedAt: NOW + 10,
    });

    expect(settlement.status).toBe("fabricated");
    expect(settlement.slashed).toBeCloseTo(award.stake, 9);
    expect(economy.standing("x")).toBe("banned");
    expect(economy.reputation().state("x")!.score).toBe(0);
  });
});

// ===========================================================================
// 12. accounts()/history() defensive copies, direct API sanity
// ===========================================================================

describe("read APIs", () => {
  it("accounts()/account()/history() return defensive copies — mutating the result never mutates internal state", async () => {
    const economy = newEconomy();
    economy.register("alice", WORKER, 100);
    economy.postTask({ taskId: "t1", domain: "code", reward: 50, postedAt: NOW });
    economy.award({ taskId: "t1", participantId: "alice", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    await economy.submitClaim(await makeVerifiedClaim({ taskId: "t1", participantId: "alice", pCorrect: 0.95, submittedAt: NOW + 10 }));

    const acc = economy.account("alice");
    (acc as ParticipantAccount).balance = -999999;
    expect(economy.account("alice").balance).not.toBe(-999999);

    const accs = economy.accounts();
    accs[0].balance = -1;
    expect(economy.accounts()[0].balance).not.toBe(-1);

    const hist = economy.history();
    (hist[0] as { payment: number }).payment = -1;
    expect(economy.history()[0].payment).not.toBe(-1);
  });
});
