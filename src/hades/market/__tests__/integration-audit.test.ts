/**
 * ADVERSARIAL INTEGRATION AUDIT of the verified-work market
 * (`src/hades/market/**`) — the seams the five per-module suites could not
 * see, because each one only had its own module in front of it.
 *
 * Every test here corresponds to a REAL defect found (and fixed) during
 * central integration, and is written so it fails loudly if the fix is ever
 * reverted:
 *
 *  1. CERTIFICATE THEFT. `claims.ts`'s replay registry keyed only on
 *     (signature -> task, output). A second participant re-presenting a
 *     stolen but byte-identical certificate passed every content check and
 *     adjudicated "verified", because nothing compared WHO consumed it.
 *  2. REPLAY-REGISTRY POISONING. The registry was written by the FIRST
 *     presentation, valid or not. Anyone who could observe a signature could
 *     pre-bind it to a bogus task, and the legitimate holder's own correct
 *     submission then came back `replayed-certificate` -> fabricated ->
 *     slashed and banned.
 *  3. BUDGET OVERRUN. `exchange.ts`'s second price is `A_w / V_r`, which is
 *     unbounded above: a weak runner-up drove the clearing price far past
 *     the `maxPrice` the requester declared and every offer was gated
 *     against.
 *  4. COLD-START LOCKOUT. `economy.ts` gated bidding on a Brier SKILL score
 *     that is mathematically UNDEFINED (and reported as 0) until a
 *     participant has both a pass and a fail on record — so an honest worker
 *     was permanently barred from the market by the first job they did
 *     right.
 *  5. TREASURY INSOLVENCY. Payments are drawn from the treasury with no
 *     solvency check, so a long run of successful settlements drove
 *     `treasury()` negative while `totalTokens()` still "conserved" —
 *     three-bucket conservation is not solvency.
 *  6. DURABILITY. Nothing persisted the replay registry or the economy, so
 *     every process restart re-opened a market in which no certificate had
 *     ever been spent.
 *
 * REAL crypto throughout: a real `CertificateAuthority` (ed25519, seeded
 * deterministically — no `Math.random`) issues REAL certificates. `now` is
 * always passed explicitly, never `Date.now()`.
 */

import { describe, expect, it } from "vitest";

import { ClaimAdjudicator, defaultClaimPolicy, type ClaimPolicy, type VerifiedClaim } from "../claims";
import { Economy, defaultEconomyPolicy } from "../economy";
import { WorkExchange, type TaskOrder, type WorkOffer } from "../exchange";
import { ReputationLedger } from "../reputation";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../styx/certificate";

// ---------------------------------------------------------------------------
// Deterministic real key material (no Math.random)
// ---------------------------------------------------------------------------

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

const CA = new CertificateAuthority(generatePrivateKeyHex(seededRng(11)));
const NOW = 1_700_000_000_000;
const OUTPUT = "the delivered agent output, verbatim";
const TRACE = JSON.stringify({ steps: ["plan", "execute", "verify"], ok: true });

function payload(overrides: Partial<CertificatePayload> = {}): CertificatePayload {
  return {
    outputSha256: sha256Hex(OUTPUT),
    taskId: "task-alpha",
    verifierTier: "T1-reference",
    ensembleScore: 0.93,
    pCorrect: 0.95,
    epsilon: 0.05,
    traceSha256: sha256Hex(TRACE),
    verifierVersions: ["genrm-v1", "consistency-v2"],
    issuedAt: NOW - 1000,
    ...overrides,
  };
}

function claim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    taskId: "task-alpha",
    participantId: "alice",
    outputText: OUTPUT,
    claimedPCorrect: 0.9,
    traceJson: TRACE,
    submittedAt: NOW - 500,
    ...overrides,
  };
}

function policy(overrides: Partial<ClaimPolicy> = {}): ClaimPolicy {
  return { ...defaultClaimPolicy([CA.publicKeyHex()]), ...overrides };
}

async function issue(overrides: Partial<CertificatePayload> = {}): Promise<VerificationCertificate> {
  return CA.issue(payload(overrides));
}

// ===========================================================================
// 1. Certificate theft
// ===========================================================================

describe("AUDIT 1 — a stolen certificate cannot be spent by a second participant", () => {
  it("a byte-identical certificate re-presented by a DIFFERENT participant is replayed-certificate, not verified", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    const cert = await issue();

    const alice = await adjudicator.adjudicate(claim({ certificate: cert, participantId: "alice" }), NOW);
    expect(alice.status).toBe("verified");
    expect(alice.codes).toEqual([]);

    // Mallory submits the EXACT same claim — same task, same output text,
    // same real certificate. Every content check passes; only the
    // participant binding can catch this.
    const mallory = await adjudicator.adjudicate(claim({ certificate: cert, participantId: "mallory" }), NOW);
    expect(mallory.status).toBe("fabricated");
    expect(mallory.codes).toContain("replayed-certificate");
    expect(mallory.score).toBe(0);
    expect(mallory.fabricated).toBe(true);
  });

  it("the original holder can still re-present their own certificate idempotently after the theft attempt", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    const cert = await issue();
    await adjudicator.adjudicate(claim({ certificate: cert, participantId: "alice" }), NOW);
    await adjudicator.adjudicate(claim({ certificate: cert, participantId: "mallory" }), NOW);

    const again = await adjudicator.adjudicate(claim({ certificate: cert, participantId: "alice" }), NOW + 5);
    expect(again.status).toBe("verified");
    expect(again.codes).toEqual([]);
  });
});

// ===========================================================================
// 2. Replay-registry poisoning
// ===========================================================================

describe("AUDIT 2 — a rejected presentation cannot poison the replay registry", () => {
  it("pre-binding a certificate with a bogus task does NOT make the legitimate holder's later correct claim a replay", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    const cert = await issue({ taskId: "task-alpha" });

    // The attacker presents the observed certificate against the wrong task.
    // This is rejected (task-mismatch) and must leave no trace behind.
    const poison = await adjudicator.adjudicate(
      claim({ certificate: cert, taskId: "task-attacker", participantId: "mallory" }),
      NOW,
    );
    expect(poison.status).toBe("fabricated");
    expect(poison.codes).toContain("task-mismatch");
    expect(adjudicator.seenCertificates()).toBe(0);

    // The real holder's correct submission must still be clean.
    const honest = await adjudicator.adjudicate(claim({ certificate: cert, participantId: "alice" }), NOW);
    expect(honest.status).toBe("verified");
    expect(honest.codes).toEqual([]);
    expect(adjudicator.seenCertificates()).toBe(1);
  });

  it("an untrusted-issuer rejection likewise binds nothing", async () => {
    const adjudicator = new ClaimAdjudicator(policy({ trustedIssuers: [] }));
    const cert = await issue();
    const rejected = await adjudicator.adjudicate(claim({ certificate: cert }), NOW);
    expect(rejected.codes).toContain("untrusted-issuer");
    expect(adjudicator.seenCertificates()).toBe(0);
  });
});

// ===========================================================================
// 3. Clearing price never exceeds the requester's declared budget
// ===========================================================================

describe("AUDIT 3 — the second price is capped at the order's own maxPrice", () => {
  /** A calibrated history: claims track a genuinely varying per-item probability. */
  function seedCalibrated(ledger: ReputationLedger, id: string, n: number, at: number): void {
    for (let i = 0; i < n; i++) {
      const p = 0.1 + 0.8 * ((i * 7) % 10) / 10;
      ledger.record({
        participantId: id,
        kind: "agent",
        taskId: `t-${id}-${i}`,
        claimedP: p,
        outcome: (i * 7) % 10 >= 5 ? 1 : 0,
        certified: true,
        difficulty: 0.5,
        at: at + i,
      });
    }
  }

  it("a weak runner-up cannot drive the clearing price past maxPrice", () => {
    const ledger = new ReputationLedger();
    seedCalibrated(ledger, "strong", 40, NOW - 1000);
    seedCalibrated(ledger, "weak", 40, NOW - 1000);
    const exchange = new WorkExchange({ reputation: ledger });

    const order: TaskOrder = {
      taskId: "task-1",
      domain: "code",
      maxPrice: 10,
      postedAt: NOW,
    };
    const offers: WorkOffer[] = [
      {
        participantId: "strong",
        taskId: "task-1",
        price: 1,
        claimedPCorrect: 0.99,
        capability: { domain: "code", tags: [] },
      },
      {
        // A deliberately terrible value/dollar runner-up: max price, minimum
        // claim. Its `V_r` is tiny, so the uncapped breakeven price explodes.
        participantId: "weak",
        taskId: "task-1",
        price: 10,
        claimedPCorrect: 0.01,
        capability: { domain: "code", tags: [] },
      },
    ];

    const result = exchange.clear([order], offers, NOW);
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0];
    expect(m.participantId).toBe("strong");
    // The uncapped breakeven would be adjusted/V_r, provably far above 10 here.
    expect(m.adjustedPCorrect / (m.runnerUp?.expectedVerifiedValue ?? 1)).toBeGreaterThan(order.maxPrice);
    // ...and the cap must bind.
    expect(m.clearingPrice).toBeLessThanOrEqual(order.maxPrice);
    expect(m.clearingPrice).toBe(order.maxPrice);
  });

  it("the cap never lowers a clearing price below the winner's own ask", () => {
    const ledger = new ReputationLedger();
    seedCalibrated(ledger, "a", 30, NOW - 1000);
    seedCalibrated(ledger, "b", 30, NOW - 1000);
    const exchange = new WorkExchange({ reputation: ledger });
    const order: TaskOrder = { taskId: "t", domain: "code", maxPrice: 100, postedAt: NOW };
    const result = exchange.clear(
      [order],
      [
        { participantId: "a", taskId: "t", price: 5, claimedPCorrect: 0.8, capability: { domain: "code", tags: [] } },
        { participantId: "b", taskId: "t", price: 7, claimedPCorrect: 0.75, capability: { domain: "code", tags: [] } },
      ],
      NOW,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].clearingPrice).toBeGreaterThanOrEqual(result.matches[0].offerPrice);
    expect(result.matches[0].clearingPrice).toBeLessThanOrEqual(100);
  });
});

// ===========================================================================
// 4. Cold start — an honest first job must not lock a worker out forever
// ===========================================================================

describe("AUDIT 4 — an undefined skill score is not treated as a bad one", () => {
  async function settleOneHonestPass(economy: Economy, taskId: string, at: number): Promise<void> {
    const cert = await CA.issue(payload({ taskId, outputSha256: sha256Hex(OUTPUT), issuedAt: at - 10 }));
    economy.postTask({ taskId, domain: "code", reward: 100, difficulty: 0.5, postedAt: at });
    economy.award({ taskId, participantId: "honest", price: 40, claimedPCorrect: 0.9, awardedAt: at });
    const settlement = await economy.submitClaim({
      taskId,
      participantId: "honest",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: TRACE,
      submittedAt: at,
    });
    expect(settlement.status).toBe("verified");
  }

  it("a worker who settles their FIRST task successfully is still eligible to bid", async () => {
    const economy = new Economy({
      adjudicator: new ClaimAdjudicator(policy()),
      policy: { ...defaultEconomyPolicy(), minReputationToBid: 0.05 },
    });
    economy.register("honest", "agent", 1000);
    expect(economy.eligible("honest")).toEqual({ ok: true });

    await settleOneHonestPass(economy, "task-alpha", NOW);

    // A single all-pass history has ZERO realized-outcome variance, so the
    // ledger's Brier skill score is undefined and reports 0. That must NOT
    // read as "scored terribly".
    const state = economy.reputation().state("honest");
    expect(state).not.toBeNull();
    expect(state!.decomposition.uncertainty).toBeLessThan(1e-9);
    expect(economy.eligible("honest")).toEqual({ ok: true });
  });

  it("a fresh participant is still gated by an absurd threshold (the gate is not simply disabled)", () => {
    const economy = new Economy({
      adjudicator: new ClaimAdjudicator(policy()),
      policy: { minReputationToBid: 1.5 },
    });
    economy.register("anyone", "agent", 1000);
    expect(economy.eligible("anyone")).toEqual({ ok: false, reason: "reputation-too-low" });
  });

  it("a proven fabricator is still refused — the ban never consults the score", async () => {
    const economy = new Economy({ adjudicator: new ClaimAdjudicator(policy({ trustedIssuers: [] })) });
    economy.register("liar", "agent", 1000);
    const cert = await issue();
    economy.postTask({ taskId: "t1", domain: "code", reward: 100, postedAt: NOW });
    economy.award({ taskId: "t1", participantId: "liar", price: 40, claimedPCorrect: 0.9, awardedAt: NOW });
    const settlement = await economy.submitClaim({
      taskId: "t1",
      participantId: "liar",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: TRACE,
      submittedAt: NOW,
    });
    expect(settlement.status).toBe("fabricated");
    expect(economy.standing("liar")).toBe("banned");
    expect(economy.eligible("liar")).toEqual({ ok: false, reason: "participant-not-eligible" });
  });
});

// ===========================================================================
// 5. Treasury solvency
// ===========================================================================

describe("AUDIT 5 — the treasury never pays out money it does not have", () => {
  it("payment is capped at the treasury balance and the treasury never goes negative", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    // A deliberately near-broke treasury: the Brier payment for this claim is
    // far larger than what is actually available.
    const economy = new Economy({ adjudicator, policy: { openingBalance: 3 } });
    economy.register("worker", "agent", 1000);
    economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
    economy.award({ taskId: "task-alpha", participantId: "worker", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });

    const cert = await issue();
    const settlement = await economy.submitClaim({
      taskId: "task-alpha",
      participantId: "worker",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: cert,
      traceJson: TRACE,
      submittedAt: NOW,
    });

    expect(settlement.status).toBe("verified");
    expect(settlement.payment).toBeLessThanOrEqual(3);
    expect(economy.treasury()).toBeGreaterThanOrEqual(0);
    // Conservation still holds exactly.
    const bucketed =
      economy.treasury() + economy.accounts().reduce((acc, a) => acc + a.balance + a.escrowed, 0);
    expect(Math.abs(economy.totalTokens() - bucketed)).toBeLessThan(1e-9);
  });

  it("a healthy treasury is unaffected — the cap only binds when it must", async () => {
    const economy = new Economy({ adjudicator: new ClaimAdjudicator(policy()) });
    economy.register("worker", "agent", 1000);
    economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
    economy.award({ taskId: "task-alpha", participantId: "worker", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    const settlement = await economy.submitClaim({
      taskId: "task-alpha",
      participantId: "worker",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await issue(),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    expect(settlement.payment).toBeGreaterThan(3);
    expect(economy.treasury()).toBeLessThan(100_000);
  });
});

// ===========================================================================
// 6. Durability across a process boundary
// ===========================================================================

describe("AUDIT 6 — market state survives a restart", () => {
  it("a certificate spent before a restart cannot be re-spent after one", async () => {
    const first = new ClaimAdjudicator(policy());
    const cert = await issue();
    const spent = await first.adjudicate(claim({ certificate: cert }), NOW);
    expect(spent.status).toBe("verified");

    const persisted = first.serializeReplayRegistry();

    // A brand-new process, same policy, registry restored from disk.
    const second = new ClaimAdjudicator(policy());
    expect(second.seenCertificates()).toBe(0);
    expect(second.loadReplayRegistry(persisted)).toBe(1);
    expect(second.seenCertificates()).toBe(1);

    const theft = await second.adjudicate(claim({ certificate: cert, participantId: "mallory" }), NOW + 1);
    expect(theft.status).toBe("fabricated");
    expect(theft.codes).toContain("replayed-certificate");
  });

  it("serializeReplayRegistry is deterministic and round-trips byte-identically", async () => {
    const a = new ClaimAdjudicator(policy());
    const b = new ClaimAdjudicator(policy());
    for (let i = 0; i < 5; i++) {
      const cert = await issue({ taskId: `task-${i}`, outputSha256: sha256Hex(`out-${i}`) });
      const c = claim({ certificate: cert, taskId: `task-${i}`, outputText: `out-${i}` });
      await a.adjudicate(c, NOW);
      await b.adjudicate(c, NOW);
    }
    expect(a.serializeReplayRegistry()).toBe(b.serializeReplayRegistry());
    const c = new ClaimAdjudicator(policy());
    c.loadReplayRegistry(a.serializeReplayRegistry());
    expect(c.serializeReplayRegistry()).toBe(a.serializeReplayRegistry());
  });

  it("loadReplayRegistry THROWS on a malformed envelope rather than silently loading an empty registry", () => {
    const adjudicator = new ClaimAdjudicator(policy());
    expect(() => adjudicator.loadReplayRegistry("{")).toThrow(TypeError);
    expect(() => adjudicator.loadReplayRegistry("{}")).toThrow(TypeError);
    expect(() => adjudicator.loadReplayRegistry('{"version":2,"seen":{}}')).toThrow(TypeError);
    expect(() => adjudicator.loadReplayRegistry('{"version":1,"seen":{"k":{"taskId":1}}}')).toThrow(TypeError);
  });

  it("Economy.deserialize restores balances, escrow, standing, history and the hash-chained ledger exactly", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    const economy = new Economy({ adjudicator });
    economy.register("worker", "agent", 1000);
    economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, difficulty: 0.5, postedAt: NOW });
    economy.award({ taskId: "task-alpha", participantId: "worker", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    await economy.submitClaim({
      taskId: "task-alpha",
      participantId: "worker",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await issue(),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    // An open (unsettled) award, so the escrow book has to survive too.
    economy.postTask({ taskId: "task-open", domain: "code", reward: 100, postedAt: NOW + 1 });
    economy.award({ taskId: "task-open", participantId: "worker", price: 60, claimedPCorrect: 0.8, awardedAt: NOW + 1 });

    const restored = Economy.deserialize(economy.serialize(), { adjudicator });

    expect(restored.serialize()).toBe(economy.serialize());
    expect(restored.account("worker")).toEqual(economy.account("worker"));
    expect(restored.treasury()).toBe(economy.treasury());
    expect(restored.totalTokens()).toBe(economy.totalTokens());
    expect(restored.history()).toEqual(economy.history());
    expect(restored.openAwards().map((a) => a.taskId)).toEqual(["task-open"]);
    expect(restored.reputation().verifyChain().ok).toBe(true);
    expect(restored.reputation().entries("worker")).toEqual(economy.reputation().entries("worker"));
  });

  it("a restored economy can settle the award that was still open, and conservation holds across the restart", async () => {
    const adjudicator = new ClaimAdjudicator(policy());
    const economy = new Economy({ adjudicator });
    economy.register("worker", "agent", 1000);
    economy.postTask({ taskId: "task-alpha", domain: "code", reward: 100, postedAt: NOW });
    economy.award({ taskId: "task-alpha", participantId: "worker", price: 80, claimedPCorrect: 0.9, awardedAt: NOW });
    const before = economy.totalTokens();

    const restored = Economy.deserialize(economy.serialize(), { adjudicator });
    const settlement = await restored.submitClaim({
      taskId: "task-alpha",
      participantId: "worker",
      outputText: OUTPUT,
      claimedPCorrect: 0.9,
      certificate: await issue(),
      traceJson: TRACE,
      submittedAt: NOW,
    });
    expect(settlement.status).toBe("verified");
    expect(restored.totalTokens()).toBeCloseTo(before, 9);
    expect(restored.account("worker").escrowed).toBe(0);
  });

  it("Economy.deserialize THROWS on a malformed envelope rather than returning a half-loaded economy", () => {
    const adjudicator = new ClaimAdjudicator(policy());
    expect(() => Economy.deserialize("{", { adjudicator })).toThrow(TypeError);
    expect(() => Economy.deserialize("{}", { adjudicator })).toThrow(TypeError);
    expect(() =>
      Economy.deserialize(JSON.stringify({ policy: {}, treasuryBalance: 1, accounts: [], tasks: [], awards: [] }), {
        adjudicator,
      }),
    ).toThrow(TypeError);
  });
});

// ===========================================================================
// 7. Source hygiene — the defect the previous cycle also had to fix
// ===========================================================================

describe("AUDIT 7 — no raw control characters in market sources", () => {
  it("no market source file contains a raw NUL byte (which makes git and grep treat it as binary)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "..");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const bytes = readFileSync(join(dir, f));
      expect(`${f}:${bytes.includes(0)}`).toBe(`${f}:false`);
    }
  });
});
