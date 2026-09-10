/* ------------------------------------------------------------------ *
 * demotion.test.ts
 *
 * A state-machine torture test for `demotion.ts`'s trust-policy engine.
 * `evaluateSkillTrust` and `applyOutcomeToStreak` are pure, so every test
 * here constructs inputs by hand (no fixtures from `track-record.ts` — we
 * only need its *type*, `SkillTrackSummary`, which this file fabricates
 * directly) and asserts on the exact returned state/decision.
 * ------------------------------------------------------------------ */
import { describe, it, expect } from "vitest";

import {
  evaluateSkillTrust,
  applyOutcomeToStreak,
  defaultSkillTrustPolicy,
  serializeTrustStates,
  parseTrustStates,
  type SkillTrustState,
  type SkillTrustPolicy,
  type SkillTrustStatus,
} from "../demotion";
import type { SkillTrackSummary } from "../track-record";

// ===========================================================================
// helpers
// ===========================================================================

function summary(overrides: Partial<SkillTrackSummary> = {}): SkillTrackSummary {
  return {
    skillName: "test-skill",
    n: 20,
    verifiedN: 20,
    brier: 0.05,
    recentBrier: 0.05,
    successRate: 0.95,
    recentSuccessRate: 0.95,
    window: 20,
    lastAt: 1000,
    wilsonLower: 0.85,
    ...overrides,
  };
}

function freshState(overrides: Partial<SkillTrustState> = {}): SkillTrustState {
  return {
    skillName: "test-skill",
    status: "active",
    since: 0,
    streak: 0,
    reasons: [],
    ...overrides,
  };
}

function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj as object)) {
      const val = (obj as Record<string, unknown>)[key];
      if (val && typeof val === "object" && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }
  return obj;
}

// ===========================================================================
// defaultSkillTrustPolicy — pin every default so a silent change breaks a test
// ===========================================================================

describe("defaultSkillTrustPolicy", () => {
  it("returns the exact locked defaults", () => {
    expect(defaultSkillTrustPolicy()).toEqual({
      minSamples: 5,
      demoteBelowWilson: 0.5,
      probationBelowWilson: 0.7,
      brierCeiling: 0.35,
      recoverAboveWilson: 0.75,
      recoveryStreak: 3,
      hysteresis: 0.05,
    });
  });

  it("returns a fresh object each call (caller can safely mutate its own copy)", () => {
    const a = defaultSkillTrustPolicy();
    const b = defaultSkillTrustPolicy();
    expect(a).not.toBe(b);
    a.minSamples = 999;
    expect(b.minSamples).toBe(5);
  });
});

// ===========================================================================
// (a) seeded regression: active -> probation -> demoted, with quoted numbers
// ===========================================================================

describe("seeded regression scenario", () => {
  it("crosses active -> probation -> demoted as the recent window collapses, quoting real numbers", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "active", streak: 0 });

    // Strong early record: stays active.
    const strong = summary({ n: 20, wilsonLower: 0.9, recentBrier: 0.05 });
    const step1 = evaluateSkillTrust(state, strong, policy, 100);
    expect(step1.decision.next).toBe("active");
    expect(step1.decision.changed).toBe(false);
    state = step1.state;

    // Recent window collapses: wilsonLower drops below probationBelowWilson (0.7).
    const collapsing = summary({ n: 20, wilsonLower: 0.6, recentBrier: 0.4 });
    const step2 = evaluateSkillTrust(state, collapsing, policy, 200);
    expect(step2.decision.previous).toBe("active");
    expect(step2.decision.next).toBe("probation");
    expect(step2.decision.changed).toBe(true);
    expect(step2.decision.reasons.some((r) => r.includes("wilsonLower=0.6000"))).toBe(true);
    expect(step2.decision.reasons.some((r) => r.includes("probationBelowWilson=0.7000"))).toBe(true);
    expect(step2.decision.reasons.some((r) => r.includes("recentBrier=0.4000"))).toBe(true);
    expect(step2.decision.reasons.some((r) => r.includes("brierCeiling=0.3500"))).toBe(true);
    expect(step2.state.since).toBe(200);
    expect(step2.state.streak).toBe(0);
    state = step2.state;

    // Continues to deteriorate below the demote threshold.
    const collapsed = summary({ n: 25, wilsonLower: 0.3, recentBrier: 0.6 });
    const step3 = evaluateSkillTrust(state, collapsed, policy, 300);
    expect(step3.decision.previous).toBe("probation");
    expect(step3.decision.next).toBe("demoted");
    expect(step3.decision.changed).toBe(true);
    expect(step3.decision.reasons.some((r) => r.includes("wilsonLower=0.3000"))).toBe(true);
    expect(step3.decision.reasons.some((r) => r.includes("demoteBelowWilson=0.5000"))).toBe(true);
    expect(step3.state.since).toBe(300);
    expect(step3.state.streak).toBe(0);
  });
});

// ===========================================================================
// (b) hysteresis: no flapping when oscillating around probationBelowWilson
// ===========================================================================

describe("hysteresis prevents flapping", () => {
  it("status changes at most once when wilsonLower oscillates tightly around probationBelowWilson", () => {
    const policy = defaultSkillTrustPolicy(); // probationBelowWilson=0.7, recoverAboveWilson+hysteresis=0.8
    let state = freshState({ status: "active" });

    const oscillation = [0.72, 0.69, 0.71, 0.68, 0.72, 0.69, 0.70, 0.695, 0.705, 0.69];
    let changes = 0;
    let t = 0;
    for (const wilsonLower of oscillation) {
      t += 10;
      const { state: nextState, decision } = evaluateSkillTrust(
        state,
        summary({ n: 30, wilsonLower, recentBrier: 0.1 }),
        policy,
        t,
      );
      if (decision.changed) changes++;
      state = nextState;
    }

    expect(changes).toBeLessThanOrEqual(1);
    // With this specific series the first sub-0.7 reading demotes to
    // probation, and nothing in the series reaches the 0.8 recovery bar, so
    // it settles there permanently (proves the gap actually holds).
    expect(changes).toBe(1);
    expect(state.status).toBe("probation");
  });

  it("does not flap even across many repeated cycles", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "active" });
    let changes = 0;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 1;
      const wilsonLower = i % 2 === 0 ? 0.705 : 0.695; // straddles 0.7, never near 0.8
      const { state: nextState, decision } = evaluateSkillTrust(
        state,
        summary({ n: 30, wilsonLower, recentBrier: 0.1 }),
        policy,
        t,
      );
      if (decision.changed) changes++;
      state = nextState;
    }
    expect(changes).toBe(1);
  });
});

// ===========================================================================
// (c) minSamples guard
// ===========================================================================

describe("minSamples guard", () => {
  it("never demotes below minSamples even with a terrible record, then demotes exactly at the threshold", () => {
    const policy = defaultSkillTrustPolicy(); // minSamples = 5
    let state = freshState({ status: "active" });

    for (let n = 1; n <= 4; n++) {
      const { state: nextState, decision } = evaluateSkillTrust(
        state,
        summary({ n, wilsonLower: 0.01, recentBrier: 0.9 }), // catastrophic, but n < 5
        policy,
        n * 10,
      );
      expect(decision.changed).toBe(false);
      expect(decision.next).toBe("active");
      expect(decision.reasons.some((r) => r.includes(`n=${n} < minSamples=5`))).toBe(true);
      state = nextState;
    }

    // 5th sample crosses minSamples and the record is still catastrophic: demotes.
    const step5 = evaluateSkillTrust(
      state,
      summary({ n: 5, wilsonLower: 0.01, recentBrier: 0.9 }),
      policy,
      999,
    );
    expect(step5.decision.changed).toBe(true);
    expect(step5.decision.next).toBe("demoted");
  });

  it("guard leaves streak and since untouched", () => {
    const policy = defaultSkillTrustPolicy();
    const state = freshState({ status: "probation", since: 42, streak: 2 });
    const { state: next } = evaluateSkillTrust(state, summary({ n: 1, wilsonLower: 0.01 }), policy, 500);
    expect(next.status).toBe("probation");
    expect(next.since).toBe(42);
    expect(next.streak).toBe(2);
  });
});

// ===========================================================================
// (d) sticky demotion
// ===========================================================================

describe("sticky demotion", () => {
  it("a demoted skill fed one perfect verified window does not jump straight to active", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "demoted", streak: 0 });

    // One perfect window (wilsonLower well above recovery bar) but streak is
    // still 0 verified successes in a row — must NOT reach active, and per
    // the sticky rule demoted can never reach active in a single hop anyway.
    const { state: next, decision } = evaluateSkillTrust(
      state,
      summary({ n: 30, wilsonLower: 0.99, recentBrier: 0.01 }),
      policy,
      1000,
    );
    expect(decision.next).not.toBe("active");
    expect(decision.next).toBe("demoted"); // streak (0) < recoveryStreak (3)
    expect(decision.changed).toBe(false);
    state = next;
  });

  it("reaches probation only after recoveryStreak verified successes, never active in one hop", () => {
    const policy = defaultSkillTrustPolicy(); // recoveryStreak = 3
    let state = freshState({ status: "demoted", streak: 0 });

    for (let i = 1; i <= 2; i++) {
      state = applyOutcomeToStreak(state, { success: true, verified: true });
      const { state: next, decision } = evaluateSkillTrust(
        state,
        summary({ n: 30, wilsonLower: 0.99, recentBrier: 0.01 }),
        policy,
        i,
      );
      expect(decision.next).toBe("demoted");
      expect(decision.changed).toBe(false);
      state = next;
    }

    // Third verified success completes the streak.
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    expect(state.streak).toBe(3);
    const { state: promoted, decision } = evaluateSkillTrust(
      state,
      summary({ n: 30, wilsonLower: 0.99, recentBrier: 0.01 }),
      policy,
      99,
    );
    expect(decision.previous).toBe("demoted");
    expect(decision.next).toBe("probation");
    expect(decision.changed).toBe(true);
    expect(promoted.streak).toBe(0); // fresh streak required for probation -> active
  });
});

// ===========================================================================
// (e) unverified successes do not extend the recovery streak
// ===========================================================================

describe("unverified successes cannot launder recovery", () => {
  it("an unverified success does not advance the streak, even many in a row", () => {
    let state = freshState({ status: "probation", streak: 0 });
    for (let i = 0; i < 10; i++) {
      state = applyOutcomeToStreak(state, { success: true, verified: false });
    }
    expect(state.streak).toBe(0);
  });

  it("mixing verified and unverified successes only counts the verified ones", () => {
    let state = freshState({ status: "probation", streak: 0 });
    state = applyOutcomeToStreak(state, { success: true, verified: true }); // 1
    state = applyOutcomeToStreak(state, { success: true, verified: false }); // still 1
    state = applyOutcomeToStreak(state, { success: true, verified: true }); // 2
    state = applyOutcomeToStreak(state, { success: true, verified: false }); // still 2
    state = applyOutcomeToStreak(state, { success: true, verified: true }); // 3
    expect(state.streak).toBe(3);
  });

  it("a demoted skill cannot reach probation via a wall of unverified wins", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "demoted", streak: 0 });
    for (let i = 0; i < 50; i++) {
      state = applyOutcomeToStreak(state, { success: true, verified: false });
    }
    const { decision } = evaluateSkillTrust(
      state,
      summary({ n: 60, wilsonLower: 0.99, recentBrier: 0.01 }),
      policy,
      1,
    );
    expect(decision.next).toBe("demoted");
    expect(decision.changed).toBe(false);
  });
});

// ===========================================================================
// (f) streak resets on failure mid-recovery
// ===========================================================================

describe("streak reset on failure", () => {
  it("a failure mid-recovery resets the streak to zero", () => {
    let state = freshState({ status: "probation", streak: 0 });
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    expect(state.streak).toBe(2);
    state = applyOutcomeToStreak(state, { success: false, verified: true });
    expect(state.streak).toBe(0);
  });

  it("an unverified failure also resets the streak", () => {
    let state = freshState({ status: "probation", streak: 5 });
    state = applyOutcomeToStreak(state, { success: false, verified: false });
    expect(state.streak).toBe(0);
  });

  it("prevents promotion when the streak breaks one short of recoveryStreak", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "probation", streak: 0 });
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    state = applyOutcomeToStreak(state, { success: false, verified: true }); // breaks it
    state = applyOutcomeToStreak(state, { success: true, verified: true }); // streak=1, not 3
    const { decision } = evaluateSkillTrust(
      state,
      summary({ n: 30, wilsonLower: 0.99, recentBrier: 0.01 }),
      policy,
      1,
    );
    expect(decision.next).toBe("probation");
    expect(decision.changed).toBe(false);
  });
});

// ===========================================================================
// (g) full transition-matrix coverage
// ===========================================================================

describe("transition matrix", () => {
  const policy = defaultSkillTrustPolicy();

  const cases: Array<{
    name: string;
    status: SkillTrustStatus;
    streak: number;
    summary: Partial<SkillTrackSummary>;
    expectNext: SkillTrustStatus;
    expectChanged: boolean;
  }> = [
    // active
    {
      name: "active + demote-rule fires -> demoted",
      status: "active",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.2, recentBrier: 0.1 },
      expectNext: "demoted",
      expectChanged: true,
    },
    {
      name: "active + probation-rule fires (low wilson) -> probation",
      status: "active",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.6, recentBrier: 0.1 },
      expectNext: "probation",
      expectChanged: true,
    },
    {
      name: "active + probation-rule fires (bad brier only) -> probation",
      status: "active",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.9, recentBrier: 0.5 },
      expectNext: "probation",
      expectChanged: true,
    },
    {
      name: "active + no rule fires -> active (no-change diagonal)",
      status: "active",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.9, recentBrier: 0.05 },
      expectNext: "active",
      expectChanged: false,
    },
    // probation
    {
      name: "probation + demote-rule fires -> demoted",
      status: "probation",
      streak: 3,
      summary: { n: 10, wilsonLower: 0.2, recentBrier: 0.1 },
      expectNext: "demoted",
      expectChanged: true,
    },
    {
      name: "probation + recovery-rule fires -> active",
      status: "probation",
      streak: 3,
      summary: { n: 10, wilsonLower: 0.9, recentBrier: 0.05 },
      expectNext: "active",
      expectChanged: true,
    },
    {
      name: "probation + neither fires (streak too low) -> probation (no-change diagonal)",
      status: "probation",
      streak: 1,
      summary: { n: 10, wilsonLower: 0.9, recentBrier: 0.05 },
      expectNext: "probation",
      expectChanged: false,
    },
    {
      name: "probation + neither fires (wilson still under recovery bar) -> probation",
      status: "probation",
      streak: 3,
      summary: { n: 10, wilsonLower: 0.72, recentBrier: 0.1 },
      expectNext: "probation",
      expectChanged: false,
    },
    // demoted
    {
      name: "demoted + demote-rule fires (still bad) -> demoted (no-change diagonal)",
      status: "demoted",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.2, recentBrier: 0.1 },
      expectNext: "demoted",
      expectChanged: false,
    },
    {
      name: "demoted + recovery-rule fires -> probation",
      status: "demoted",
      streak: 3,
      summary: { n: 10, wilsonLower: 0.9, recentBrier: 0.05 },
      expectNext: "probation",
      expectChanged: true,
    },
    {
      name: "demoted + neither fires (streak too low, wilson mid-band) -> demoted",
      status: "demoted",
      streak: 0,
      summary: { n: 10, wilsonLower: 0.6, recentBrier: 0.1 },
      expectNext: "demoted",
      expectChanged: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const state = freshState({ status: c.status, streak: c.streak });
      const { decision } = evaluateSkillTrust(state, summary(c.summary), policy, 1);
      expect(decision.next).toBe(c.expectNext);
      expect(decision.changed).toBe(c.expectChanged);
      expect(decision.previous).toBe(c.status);
    });
  }
});

// ===========================================================================
// (h) serialize/parse
// ===========================================================================

describe("serializeTrustStates / parseTrustStates", () => {
  it("round-trips a populated map exactly", () => {
    const states = new Map<string, SkillTrustState>([
      ["skill-a", freshState({ skillName: "skill-a", status: "active", since: 10, streak: 0, reasons: [] })],
      [
        "skill-b",
        freshState({
          skillName: "skill-b",
          status: "probation",
          since: 20,
          streak: 2,
          reasons: ["wilsonLower=0.6000 < probationBelowWilson=0.7000: demote active -> probation"],
        }),
      ],
      ["skill-c", freshState({ skillName: "skill-c", status: "demoted", since: 30, streak: 0, reasons: [] })],
    ]);

    const json = serializeTrustStates(states);
    const result = parseTrustStates(json);

    expect(result.ok).toBe(true);
    expect(result.states.size).toBe(3);
    expect(result.states.get("skill-a")).toEqual(states.get("skill-a"));
    expect(result.states.get("skill-b")).toEqual(states.get("skill-b"));
    expect(result.states.get("skill-c")).toEqual(states.get("skill-c"));
  });

  it("round-trips an empty map", () => {
    const json = serializeTrustStates(new Map());
    const result = parseTrustStates(json);
    expect(result.ok).toBe(true);
    expect(result.states.size).toBe(0);
  });

  it("rejects invalid JSON", () => {
    const result = parseTrustStates("{not json");
    expect(result.ok).toBe(false);
    expect(result.states.size).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it("rejects a non-object root", () => {
    const result = parseTrustStates(JSON.stringify([1, 2, 3]));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown version", () => {
    const result = parseTrustStates(JSON.stringify({ version: 2, states: {} }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("version");
  });

  it("rejects a missing version", () => {
    const result = parseTrustStates(JSON.stringify({ states: {} }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object states field", () => {
    const result = parseTrustStates(JSON.stringify({ version: 1, states: "nope" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed individual state (bad status enum)", () => {
    const result = parseTrustStates(
      JSON.stringify({
        version: 1,
        states: { x: { skillName: "x", status: "banned", since: 1, streak: 0, reasons: [] } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("x");
  });

  it("rejects a malformed individual state (wrong type for streak)", () => {
    const result = parseTrustStates(
      JSON.stringify({
        version: 1,
        states: { x: { skillName: "x", status: "active", since: 1, streak: "three", reasons: [] } },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a negative streak", () => {
    const result = parseTrustStates(
      JSON.stringify({
        version: 1,
        states: { x: { skillName: "x", status: "active", since: 1, streak: -1, reasons: [] } },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects reasons entries that are not strings", () => {
    const result = parseTrustStates(
      JSON.stringify({
        version: 1,
        states: { x: { skillName: "x", status: "active", since: 1, streak: 0, reasons: [1, 2] } },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("safely ignores a __proto__ key instead of polluting Object.prototype", () => {
    const hostile = `{"version":1,"states":{"__proto__":{"skillName":"evil","status":"active","since":0,"streak":0,"reasons":[]},"legit":{"skillName":"legit","status":"active","since":0,"streak":0,"reasons":[]}}}`;
    const result = parseTrustStates(hostile);
    expect(result.ok).toBe(true);
    expect(result.states.has("__proto__")).toBe(false);
    expect(result.states.get("legit")?.skillName).toBe("legit");
    // Prototype itself must be untouched.
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "evil")).toBe(false);
  });

  it("safely ignores constructor/prototype keys too", () => {
    const hostile = JSON.stringify({
      version: 1,
      states: {
        constructor: { skillName: "c", status: "active", since: 0, streak: 0, reasons: [] },
        prototype: { skillName: "p", status: "active", since: 0, streak: 0, reasons: [] },
        legit: { skillName: "legit", status: "demoted", since: 5, streak: 0, reasons: [] },
      },
    });
    const result = parseTrustStates(hostile);
    expect(result.ok).toBe(true);
    expect(result.states.size).toBe(1);
    expect(result.states.get("legit")?.status).toBe("demoted");
  });

  it("never throws on arbitrary garbage input", () => {
    const garbageInputs = ["", "null", "true", "42", '"a string"', "{}", "[]", "{{{{"];
    for (const g of garbageInputs) {
      expect(() => parseTrustStates(g)).not.toThrow();
    }
  });
});

// ===========================================================================
// (i) determinism / purity
// ===========================================================================

describe("determinism and purity", () => {
  it("evaluateSkillTrust is referentially transparent: same inputs twice, deep-equal outputs", () => {
    const policy = deepFreeze(defaultSkillTrustPolicy());
    const state = deepFreeze(freshState({ status: "probation", streak: 2, since: 7 }));
    const s = deepFreeze(summary({ n: 12, wilsonLower: 0.55, recentBrier: 0.2 }));

    const first = evaluateSkillTrust(state, s, policy, 500);
    const second = evaluateSkillTrust(state, s, policy, 500);

    expect(first).toEqual(second);
  });

  it("evaluateSkillTrust does not mutate its inputs (frozen objects survive)", () => {
    const policy = deepFreeze(defaultSkillTrustPolicy());
    const state = deepFreeze(freshState({ status: "active", streak: 0 }));
    const s = deepFreeze(summary({ n: 12, wilsonLower: 0.2, recentBrier: 0.6 }));

    expect(() => evaluateSkillTrust(state, s, policy, 500)).not.toThrow();
    // Still frozen / unchanged after the call.
    expect(state.status).toBe("active");
    expect(state.streak).toBe(0);
    expect(policy.minSamples).toBe(5);
    expect(s.wilsonLower).toBe(0.2);
  });

  it("applyOutcomeToStreak is referentially transparent and does not mutate its input", () => {
    const state = deepFreeze(freshState({ status: "probation", streak: 1 }));
    const outcome = deepFreeze({ success: true, verified: true });

    const first = applyOutcomeToStreak(state, outcome);
    const second = applyOutcomeToStreak(state, outcome);

    expect(first).toEqual(second);
    expect(state.streak).toBe(1); // original untouched
  });

  it("repeated evaluation with an unchanging summary is idempotent after the first settle", () => {
    const policy = defaultSkillTrustPolicy();
    let state = freshState({ status: "active", streak: 0 });
    const s = summary({ n: 10, wilsonLower: 0.3, recentBrier: 0.1 });

    const first = evaluateSkillTrust(state, s, policy, 1);
    state = first.state;
    const second = evaluateSkillTrust(state, s, policy, 2);

    expect(first.decision.next).toBe("demoted");
    expect(second.decision.next).toBe("demoted");
    expect(second.decision.changed).toBe(false);
  });
});

// ===========================================================================
// misc sanity: policy dimensions used correctly (regression against
// accidentally swapping thresholds)
// ===========================================================================

describe("policy field wiring sanity", () => {
  it("a custom brierCeiling alone can force probation even with a great wilsonLower", () => {
    const policy: SkillTrustPolicy = { ...defaultSkillTrustPolicy(), brierCeiling: 0.1 };
    const state = freshState({ status: "active" });
    const { decision } = evaluateSkillTrust(
      state,
      summary({ n: 10, wilsonLower: 0.95, recentBrier: 0.15 }),
      policy,
      1,
    );
    expect(decision.next).toBe("probation");
  });

  it("a custom recoveryStreak of 1 lets a single verified success promote", () => {
    const policy: SkillTrustPolicy = { ...defaultSkillTrustPolicy(), recoveryStreak: 1 };
    let state = freshState({ status: "probation", streak: 0 });
    state = applyOutcomeToStreak(state, { success: true, verified: true });
    const { decision } = evaluateSkillTrust(
      state,
      summary({ n: 10, wilsonLower: 0.99, recentBrier: 0.01 }),
      policy,
      1,
    );
    expect(decision.next).toBe("active");
    expect(decision.changed).toBe(true);
  });

  it("hysteresis of 0 still requires wilsonLower >= recoverAboveWilson exactly", () => {
    const policy: SkillTrustPolicy = { ...defaultSkillTrustPolicy(), hysteresis: 0 };
    let state = freshState({ status: "probation", streak: 3 });
    const atBar = evaluateSkillTrust(
      state,
      summary({ n: 10, wilsonLower: 0.75, recentBrier: 0.01 }),
      policy,
      1,
    );
    expect(atBar.decision.next).toBe("active");

    const justBelow = evaluateSkillTrust(
      state,
      summary({ n: 10, wilsonLower: 0.7499, recentBrier: 0.01 }),
      policy,
      1,
    );
    expect(justBelow.decision.next).toBe("probation");
  });
});
