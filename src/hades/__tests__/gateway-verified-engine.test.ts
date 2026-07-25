import { describe, it, expect } from "vitest";

import {
  verifiedSwarmEngine,
  extractGoalSignals,
  scoreGoalSignals,
  type GoalEvidenceSignals,
} from "../gateway/verified-engine";
import { AgentGatewayHandler, type AgentTurn } from "../gateway/agent-handler";
import { assessReply, BadgeStamper } from "../gateway/badge";
import type { ContinuityContext, Identity } from "../gateway/continuity";
import { ConformalGate } from "../styx/gate";
import {
  CertificateAuthority,
  certifiesOutput,
  generatePrivateKeyHex,
  type VerificationCertificate,
} from "../styx/certificate";
import { defaultCalibration } from "../styx/runner";
import type { GatewayManager, InboundMessage } from "../../swarm-runtime/gateway/gateway";
import type { Goal } from "../../swarm-runtime/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeManager(startGoal: GatewayManager["startGoal"]): GatewayManager {
  return { startGoal, getGoal: () => undefined };
}

function fakeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    objective: "do the thing",
    status: "completed",
    createdAt: 0,
    taskIds: ["t1", "t2", "t3", "t4", "t5"],
    synthesis: "the synthesized answer is 42",
    ...overrides,
  };
}

const turnFixture: AgentTurn = {
  sessionId: "sess-1",
  identityId: "id-1",
  platform: "telegram",
  user: "u1",
  text: "please compute something",
  switchedChannel: false,
};

/** A REAL calibrated ConformalGate — never a mock. Threshold lands well below
 * a unanimous, contradiction-free ratio of 1.0 and above a single-contradiction
 * halving of it (see defaultCalibration's module doc). */
function calibratedGate(epsilon = 0.1): ConformalGate {
  const gate = new ConformalGate({ epsilon });
  gate.calibrate(defaultCalibration());
  return gate;
}

/** A REAL ed25519 CertificateAuthority — never a crypto mock. */
function realAuthority(): CertificateAuthority {
  return new CertificateAuthority(generatePrivateKeyHex());
}

// ---------------------------------------------------------------------------
// verifiedSwarmEngine — end to end over a REAL gate + REAL certificate authority
// ---------------------------------------------------------------------------

describe("verifiedSwarmEngine", () => {
  it("is mode:real", () => {
    const engine = verifiedSwarmEngine(fakeManager(async () => ({ goalId: "g", done: Promise.resolve(fakeGoal()) })), {
      gate: calibratedGate(),
      authority: realAuthority(),
    });
    expect(engine.mode).toBe("real");
  });

  it("a completed, contradiction-free, fully-verified goal clears the real gate and issues a certificate that binds EXACTLY the returned text — the first live-path 'verified' proof", async () => {
    const manager = fakeManager(async (objective) => ({
      goalId: "g-high",
      done: Promise.resolve(fakeGoal({ synthesis: `synthesized: ${objective}` })),
    }));
    const gate = calibratedGate();
    const engine = verifiedSwarmEngine(manager, { gate, authority: realAuthority() });

    const result = await engine.respond(turnFixture);

    expect(result.text).toBe(`synthesized: ${turnFixture.text}`);
    expect(result.decision).toBeDefined();
    expect(result.decision?.emit).toBe(true);
    expect(result.decision?.score).toBe(1); // ratio 1, 0 contradictions
    expect(result.certificate).toBeDefined();

    const cert = result.certificate as VerificationCertificate;
    // Certifies the exact returned text...
    expect(await certifiesOutput(cert, result.text)).toBe(true);
    // ...and ONLY that exact text — any other text, even a near-miss, fails.
    expect(await certifiesOutput(cert, result.text + " ")).toBe(false);
    expect(await certifiesOutput(cert, "a completely unrelated reply")).toBe(false);

    // Pushed through the REAL BadgeStamper pipeline this renders "verified" —
    // the first genuine verified badge on live-shaped traffic.
    const stamped = await assessReply(result.text, { decision: result.decision, certificate: cert });
    expect(stamped.badge).toBe("verified");
    expect(stamped.pCorrect).toBe(cert.payload.pCorrect);
    expect(stamped.certFingerprint).toBeTruthy();

    // The certificate's correctness leg matches what the engine actually computed.
    expect(cert.payload.verifierTier).toBe("T4-goal-consistency");
    expect(cert.payload.ensembleScore).toBe(1);
    expect(cert.payload.pCorrect).toBe(result.decision?.pCorrectEstimate);
    expect(cert.payload.epsilon).toBe(gate.stats().epsilon);
    expect(cert.payload.taskId).toBe("g-high");
  });

  it("respects a custom taskIdFor when issuing a certificate", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-ignored", done: Promise.resolve(fakeGoal()) }));
    const engine = verifiedSwarmEngine(manager, {
      gate: calibratedGate(),
      authority: realAuthority(),
      taskIdFor: (turn) => `custom:${turn.sessionId}`,
    });
    const result = await engine.respond(turnFixture);
    expect(result.certificate?.payload.taskId).toBe(`custom:${turnFixture.sessionId}`);
  });

  it("issuedAt honors an injected `now`, never the real wall clock, when provided", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-time", done: Promise.resolve(fakeGoal()) }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority(), now: () => 123_456 });
    const result = await engine.respond(turnFixture);
    expect(result.certificate?.payload.issuedAt).toBe(123_456);
  });

  it("a completed goal whose contradictions drag the score below the gate threshold abstains — no certificate, badge 'abstained'", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g-low",
      done: Promise.resolve(
        fakeGoal({
          contradictions: [
            {
              subject: "retries",
              conflicts: [
                { value: "5", statement: "retries is 5" },
                { value: "999", statement: "retries is 999" },
              ],
            },
          ],
        }),
      ),
    }));
    const gate = calibratedGate();
    const engine = verifiedSwarmEngine(manager, { gate, authority: realAuthority() });

    const result = await engine.respond(turnFixture);
    expect(result.decision).toBeDefined();
    expect(result.decision?.score).toBe(0.5); // ratio 1 * penalty^1
    expect(result.decision?.emit).toBe(false);
    expect(result.certificate).toBeUndefined();

    const stamped = await assessReply(result.text, { decision: result.decision, certificate: result.certificate });
    expect(stamped.badge).toBe("abstained");
  });

  it("a failed goal: decision is attached, non-emitting, no certificate, and the text never claims success", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g-failed",
      done: Promise.resolve(fakeGoal({ status: "failed", synthesis: undefined, taskIds: ["t1"] })),
    }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });

    const result = await engine.respond(turnFixture);
    expect(result.decision).toBeDefined();
    expect(result.decision?.emit).toBe(false);
    expect(result.certificate).toBeUndefined();
    expect(result.text.toLowerCase()).toContain("could not produce a verified answer");
    expect(result.text).toContain("failed");

    const stamped = await assessReply(result.text, { decision: result.decision, certificate: result.certificate });
    expect(stamped.badge).toBe("abstained");
  });

  it("an aborted goal: decision is attached, non-emitting, no certificate, and text is an honest cancellation notice", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g-aborted",
      done: Promise.resolve(fakeGoal({ status: "aborted", synthesis: undefined })),
    }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });

    const result = await engine.respond(turnFixture);
    expect(result.decision?.emit).toBe(false);
    expect(result.certificate).toBeUndefined();
    expect(result.text.toLowerCase()).toContain("cancelled");
    expect(result.text.toLowerCase()).not.toContain("42");
  });

  it("startGoal itself throwing yields a non-emitting decision, no certificate, and the real error reason — never a success string", async () => {
    const manager = fakeManager(async () => {
      throw new Error("manager is at capacity");
    });
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });

    const result = await engine.respond(turnFixture);
    expect(result.decision).toBeDefined();
    expect(result.decision?.emit).toBe(false);
    expect(result.decision?.score).toBe(0);
    expect(result.certificate).toBeUndefined();
    expect(result.text).toContain("manager is at capacity");
  });

  it("a rejected `done` promise yields a non-emitting decision, no certificate, and the real error reason", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-reject", done: Promise.reject(new Error("worker crashed mid-execution")) }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });

    const result = await engine.respond(turnFixture);
    expect(result.decision?.emit).toBe(false);
    expect(result.certificate).toBeUndefined();
    expect(result.text).toContain("worker crashed mid-execution");
  });

  it("a non-Error throw is still mapped to honest text, never left to crash the caller", async () => {
    const manager = fakeManager(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "raw string failure";
    });
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });
    const result = await engine.respond(turnFixture);
    expect(result.text).toContain("raw string failure");
    expect(result.decision?.emit).toBe(false);
  });

  it("a goal left in a non-terminal status (e.g. still 'running') is reported honestly, not as success, and never certified", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g-running",
      done: Promise.resolve(fakeGoal({ status: "running", synthesis: undefined })),
    }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });
    const result = await engine.respond(turnFixture);
    expect(result.text.toLowerCase()).toContain("could not produce a verified answer");
    expect(result.text).toContain("running");
    expect(result.certificate).toBeUndefined();
  });

  it("passes opts.timeoutMs through to startGoal, mirroring swarmEngine's own contract", async () => {
    const seen: (number | undefined)[] = [];
    const manager = fakeManager(async (_objective, opts) => {
      seen.push(opts?.timeoutMs);
      return { goalId: "g-t", done: Promise.resolve(fakeGoal()) };
    });
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority(), timeoutMs: 12_345 });
    await engine.respond(turnFixture);
    expect(seen).toEqual([12_345]);
  });

  it("a certificate replayed onto different reply text renders 'unverified', never 'verified'", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-replay", done: Promise.resolve(fakeGoal()) }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });
    const result = await engine.respond(turnFixture);
    expect(result.certificate).toBeDefined();

    const stamped = await assessReply("a completely different reply that was never certified", {
      decision: result.decision,
      certificate: result.certificate,
    });
    expect(stamped.badge).toBe("unverified");
  });

  it("a certificate whose payload was tampered after issuance fails certifiesOutput and renders 'unverified'", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-tamper", done: Promise.resolve(fakeGoal()) }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });
    const result = await engine.respond(turnFixture);
    const cert = result.certificate as VerificationCertificate;

    const tampered: VerificationCertificate = {
      ...cert,
      payload: { ...cert.payload, pCorrect: 0.999999 },
    };
    expect(await certifiesOutput(tampered, result.text)).toBe(false);

    const stamped = await assessReply(result.text, { decision: result.decision, certificate: tampered });
    expect(stamped.badge).toBe("unverified");
  });

  it("AgentGatewayHandler's channel-switch continuity prefix mutates the certified text — the badge honestly demotes to 'unverified' (documented fail-closed behavior, not a bug)", async () => {
    const manager = fakeManager(async () => ({ goalId: "g-switch", done: Promise.resolve(fakeGoal({ synthesis: "the grounded answer" })) }));
    const engine = verifiedSwarmEngine(manager, { gate: calibratedGate(), authority: realAuthority() });
    const handler = new AgentGatewayHandler({ engine });
    const stamper = new BadgeStamper();

    const identity: Identity = {
      id: "identity-switch",
      links: [{ platform: "telegram", user: "u1" }],
      updatedAt: 0,
      lastSeen: { platform: "slack", user: "u1" },
    };
    const ctx: ContinuityContext = { identity, sessionId: "sess-switch", switchedChannel: true };
    const msg: InboundMessage = { platform: "telegram", user: "u1", text: turnFixture.text };

    // Sanity: without the prefix mutation the same evidence WOULD verify.
    const unprefixed = await handler.handle(msg, { ...ctx, switchedChannel: false });
    const evidence = (unprefixed as unknown as { evidence?: { decision?: unknown; certificate?: VerificationCertificate } }).evidence;
    expect(await certifiesOutput(evidence!.certificate as VerificationCertificate, unprefixed.text)).toBe(true);

    const wrapped = stamper.wrap((m) => handler.handle(m, ctx));
    const reply = await wrapped(msg);

    expect(reply.text.startsWith("(continuing our conversation from slack)")).toBe(true);
    // The badge line is derived from the (mutated) FULL reply text, so the
    // certificate — bound to the original, unprefixed text — no longer matches.
    expect(reply.text).toContain("unverified");
    expect(reply.text).not.toContain("✅");
  });
});

// ---------------------------------------------------------------------------
// extractGoalSignals — reads only real Goal fields, honestly
// ---------------------------------------------------------------------------

describe("extractGoalSignals", () => {
  it("a completed goal: verifiedTasks equals totalTasks (SwarmManager's completion invariant), contradictionCount reflects the real list length", () => {
    const goal = fakeGoal({ taskIds: ["a", "b", "c"], contradictions: [{ subject: "x", conflicts: [] }] });
    const signals = extractGoalSignals(goal);
    expect(signals).toEqual({ completed: true, verifiedTasks: 3, totalTasks: 3, contradictionCount: 1 });
  });

  it("a non-completed goal (running/failed/aborted) conservatively reports 0 verified tasks, never a fabricated partial count", () => {
    for (const status of ["running", "failed", "aborted", "planning"] as const) {
      const goal = fakeGoal({ status, taskIds: ["a", "b"], synthesis: undefined });
      const signals = extractGoalSignals(goal);
      expect(signals.completed).toBe(false);
      expect(signals.verifiedTasks).toBe(0);
      expect(signals.totalTasks).toBe(2);
    }
  });

  it("no contradictions field present -> contradictionCount 0, not undefined/NaN", () => {
    const goal = fakeGoal({ contradictions: undefined });
    expect(extractGoalSignals(goal).contradictionCount).toBe(0);
  });

  it("empty taskIds -> totalTasks 0 regardless of status", () => {
    expect(extractGoalSignals(fakeGoal({ taskIds: [] })).totalTasks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreGoalSignals — pure, monotone, bounded, NaN-hostile
// ---------------------------------------------------------------------------

describe("scoreGoalSignals", () => {
  it("is 0 when not completed, regardless of otherwise-perfect signals", () => {
    const s: GoalEvidenceSignals = { completed: false, verifiedTasks: 100, totalTasks: 100, contradictionCount: 0 };
    expect(scoreGoalSignals(s)).toBe(0);
  });

  it("is 0 when totalTasks === 0, even if marked completed", () => {
    const s: GoalEvidenceSignals = { completed: true, verifiedTasks: 0, totalTasks: 0, contradictionCount: 0 };
    expect(scoreGoalSignals(s)).toBe(0);
  });

  it("is the exact verified/total ratio when completed with zero contradictions", () => {
    for (const [verified, total] of [
      [1, 4],
      [3, 4],
      [4, 4],
      [7, 10],
    ]) {
      const s: GoalEvidenceSignals = { completed: true, verifiedTasks: verified, totalTasks: total, contradictionCount: 0 };
      expect(scoreGoalSignals(s)).toBeCloseTo(verified / total, 10);
    }
  });

  it("is monotone non-decreasing in verifiedTasks for fixed totalTasks and contradictionCount", () => {
    const total = 20;
    let prev = -Infinity;
    for (let verified = 0; verified <= total; verified++) {
      const score = scoreGoalSignals({ completed: true, verifiedTasks: verified, totalTasks: total, contradictionCount: 0 });
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("is strictly decreasing in contradictionCount whenever the verified ratio is positive", () => {
    const base = { completed: true, verifiedTasks: 8, totalTasks: 8 } as const;
    let prev = Infinity;
    for (let contradictions = 0; contradictions <= 6; contradictions++) {
      const score = scoreGoalSignals({ ...base, contradictionCount: contradictions });
      expect(score).toBeLessThan(prev);
      prev = score;
    }
  });

  it("never exceeds 1 or drops below 0, across a wide battery of inputs including out-of-range ones", () => {
    const totals = [0, 1, 5, 100];
    const verifieds = [-5, 0, 1, 5, 50, 1000];
    const contradictions = [-3, 0, 1, 5, 50];
    for (const completed of [true, false]) {
      for (const totalTasks of totals) {
        for (const verifiedTasks of verifieds) {
          for (const contradictionCount of contradictions) {
            const score = scoreGoalSignals({ completed, verifiedTasks, totalTasks, contradictionCount });
            expect(Number.isFinite(score)).toBe(true);
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("is NaN-hostile: NaN/Infinity in any field never produces NaN, Infinity, or a throw", () => {
    const hostileValues = [NaN, Infinity, -Infinity];
    for (const verifiedTasks of hostileValues) {
      const score = scoreGoalSignals({ completed: true, verifiedTasks, totalTasks: 10, contradictionCount: 0 });
      expect(Number.isFinite(score)).toBe(true);
    }
    for (const totalTasks of hostileValues) {
      const score = scoreGoalSignals({ completed: true, verifiedTasks: 5, totalTasks, contradictionCount: 0 });
      expect(Number.isFinite(score)).toBe(true);
    }
    for (const contradictionCount of hostileValues) {
      const score = scoreGoalSignals({ completed: true, verifiedTasks: 5, totalTasks: 5, contradictionCount });
      expect(Number.isFinite(score)).toBe(true);
    }
  });

  it("verifiedTasks exceeding totalTasks is clamped, never producing a score above 1", () => {
    const score = scoreGoalSignals({ completed: true, verifiedTasks: 999, totalTasks: 5, contradictionCount: 0 });
    expect(score).toBe(1);
  });

  it("negative contradictionCount is treated as zero (no bonus for a nonsensical negative count)", () => {
    const zero = scoreGoalSignals({ completed: true, verifiedTasks: 4, totalTasks: 4, contradictionCount: 0 });
    const negative = scoreGoalSignals({ completed: true, verifiedTasks: 4, totalTasks: 4, contradictionCount: -7 });
    expect(negative).toBe(zero);
  });

  it("never reads a clock or randomness: repeated calls with identical input are byte-identical", () => {
    const s: GoalEvidenceSignals = { completed: true, verifiedTasks: 3, totalTasks: 5, contradictionCount: 2 };
    const a = scoreGoalSignals(s);
    const b = scoreGoalSignals(s);
    expect(a).toBe(b);
  });
});
