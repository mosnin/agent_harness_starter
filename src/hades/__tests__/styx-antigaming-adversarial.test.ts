/**
 * ADVERSARIAL RED-TEAM of the Styx S3 anti-gaming layer (`styx/perturb.ts`).
 *
 * Falsifiable target #5 (docs/STYX_ARCHITECTURE.md): "perturbation catches ≥ half
 * of verifier-gaming attempts the raw ensemble misses."
 *
 * The whole reason S3 exists is that the S1 calibrated verifier ensemble
 * (`styx/tiers.ts` WeakVerifierEnsemble) has a load-bearing failure mode: a set of
 * verifiers that share ONE blind spot are *correlatedly* wrong — they all
 * rubber-stamp the same false positive, agreement is high and confident, and the
 * raw ensemble score CANNOT reveal it (inter-agreement carries no signal about a
 * correlated error; see the module docstring in tiers.ts). This suite proves the
 * two S3 signals — isomorphic perturbation and held-out verifier rotation —
 * actually CATCH gaming that the raw ensemble MISSES.
 *
 * Methodology (external validity, not theater):
 *   - Every "gamer" is a scripted solver that returns a plausible WRONG answer,
 *     and we FIRST confirm the correlated-bias ensemble ACCEPTS that wrong answer
 *     (scores it high / passes) — i.e. the raw ensemble genuinely misses it.
 *   - We then measure the perturbation CATCH RATE (caught === consistent===false).
 *   - Where a defense SHOULD catch a gamer and does not, the assertion encodes the
 *     CORRECT behaviour and is left to FAIL, so a real regression is reported, not
 *     hidden. We do NOT weaken assertions to make green.
 *   - Part 5 deliberately constructs an attack BOTH defenses miss and asserts it
 *     slips through — documenting (not a bug) that anti-gaming raises the bar but
 *     is not absolute. No verifier is unhackable.
 *
 * Fully deterministic: no Math.random, no clock, no network. Every gamer is a pure
 * scripted function; every perturbation is the ready-made pure transform.
 */
import { describe, it, expect } from "vitest";
import {
  checkRobustness,
  whitespaceJitter,
  caseFlip,
  synonymSwap,
  numberRename,
  verifierRotation,
  type Perturbation,
  type Solver,
} from "../styx/perturb";
import { WeakVerifierEnsemble, type VerifierVote } from "../styx/tiers";

// ===========================================================================
// The correlated-bias verifier ensemble (S1 baseline: "the raw ensemble")
// ===========================================================================
//
// Three "optimized" verifiers the worker could see and tune against, plus two
// "held-out" verifiers. The gaming baseline is that the OPTIMIZED set shares a
// blind spot and all pass the gamed answer, so the raw S1 ensemble scores it
// high. Rotation (S3) later brings the held-out set to bear.

const OPTIMIZED_IDS = ["v_opt_0", "v_opt_1", "v_opt_2"];
const HELDOUT_IDS = ["v_held_0", "v_held_1"];

/**
 * Fit a WeakVerifierEnsemble on a batch where the optimized verifiers are TOTALLY
 * correlated (they always agree with each other). EM drives every reliability to
 * ~1.0, so an all-pass item scores ~1.0 — the raw ensemble is maximally confident
 * on exactly the answers its shared bias accepts. Returns a scorer for one item.
 */
function fitCorrelatedRawEnsemble(): (votes: VerifierVote[]) => number {
  const ens = new WeakVerifierEnsemble();
  const item = (pass: boolean): VerifierVote[] =>
    OPTIMIZED_IDS.map((id) => ({ verifierId: id, passed: pass }));
  // Unanimous-per-item batch: total correlation, some pass, some fail.
  const batch = [item(true), item(true), item(false), item(true), item(false), item(true)];
  ens.fitPredict(batch);
  return (votes: VerifierVote[]) => ens.scoreItem(votes);
}

/** All optimized verifiers pass the (wrong) gamed answer — the shared blind spot. */
function optimizedAllPassVotes(): VerifierVote[] {
  return OPTIMIZED_IDS.map((id) => ({ verifierId: id, passed: true }));
}

// ===========================================================================
// The red-team registry — scripted gaming strategies
// ===========================================================================
//
// Each entry pairs a gamed SOLVER (returns a plausible WRONG answer) with:
//   - `input`      the original, un-perturbed prompt the gamer optimized against
//   - `battery`    semantics-preserving perturbations valid for a CORRECT answer
//                  to THIS prompt (so we are not cheating: a correct solver would
//                  survive this exact battery — proven in the "no cheating" block)
//   - `votes`      the full verifier vote map (optimized + held-out) on the gamed
//                  answer, for the rotation dimension
//   - expectations we assert per-gamer (correct behaviour of the detector)

interface RedTeamEntry {
  id: string;
  kind: string;
  solver: Solver<string>;
  input: string;
  battery: Array<Perturbation<string>>;
  votes: Record<string, boolean>;
  /** the plausible wrong answer (for the raw-ensemble-accepts sanity print). */
  wrongAnswer: string;
  expectPerturbCaught: boolean;
  expectRotationCaught: boolean;
}

// --- shared vote profiles -------------------------------------------------

// Surface gamers: the shared blind spot means BOTH optimized AND held-out
// verifiers pass the wrong answer, so rotation is BLIND to them — only
// perturbation can catch. This is what makes the layered defense non-redundant.
const SHARED_BLINDSPOT_PASS: Record<string, boolean> = {
  v_opt_0: true, v_opt_1: true, v_opt_2: true,
  v_held_0: true, v_held_1: true,
};

// Overfit-to-optimized-judges profile: passes every optimized judge, fails the
// held-out judges it never saw. Perturbation may miss it; rotation catches it.
const OVERFIT_HELDOUT_FAIL: Record<string, boolean> = {
  v_opt_0: true, v_opt_1: true, v_opt_2: true,
  v_held_0: false, v_held_1: false,
};

// --- the swap used by the entity-rename gamers (its own inverse) ----------
const ALICE_BOB_SWAP: Array<[string, string]> = [["Alice", "Bob"], ["Bob", "Alice"]];

const RED_TEAM: RedTeamEntry[] = [
  // (a) EXACT-STRING-MEMORIZER — right only for the verbatim original prompt.
  {
    id: "exact-string-memorizer",
    kind: "surface/exact-string",
    input: "How many words are in this exact sentence right here?",
    solver: (i) => (i === "How many words are in this exact sentence right here?" ? "42" : "0"),
    battery: [whitespaceJitter(), caseFlip()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "42",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // (b) SURFACE-FORM-KEYED — keys off the word "quick", which synonymSwap changes.
  {
    id: "surface-word-key-quick",
    kind: "surface/word-key",
    input: "Give the quick reply to the puzzle.",
    solver: (i) => (i.includes("quick") ? "seven" : "nine"),
    battery: [synonymSwap([["quick", "fast"]]), whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "seven",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // (c) ENTITY/NAME-KEYED — hard-codes the wrong entity NAME; numberRename relabels
  //     the entity and the inverse map no longer recovers canonical.
  {
    id: "const-wrong-entity-bob",
    kind: "surface/entity-name",
    input: "Alice defeated Bob in the final. Who won?",
    solver: () => "Bob", // wrong: Alice won
    battery: [numberRename(ALICE_BOB_SWAP), whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "Bob",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // (d) WHITESPACE-FRAGILE — counts by naive split(" "), so irregular spacing yields
  //     a specific wrong count that collapses under whitespaceJitter.
  {
    id: "whitespace-fragile-counter",
    kind: "surface/whitespace",
    input: "Words:   alpha   beta   gamma",
    solver: (i) => String(i.split(" ").length), // 10 on triple-spaced input; 4 is correct
    battery: [whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "10",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // (e) CASE-FRAGILE LOOKUP — case-sensitive regex/table lookup that breaks on caseFlip.
  {
    id: "case-fragile-lookup",
    kind: "surface/case",
    input: "Code for Paris?",
    solver: (i) => {
      const table: Record<string, string> = { Paris: "code-PX-wrong" };
      const m = i.match(/Code for (\w+)\?/); // case-sensitive on purpose
      return (m && table[m[1]]) || "UNKNOWN";
    },
    battery: [caseFlip(), whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "code-PX-wrong",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // combination — word-key #2 (purchase/buy synonym)
  {
    id: "surface-word-key-purchase",
    kind: "surface/word-key",
    input: "How do I purchase the ticket?",
    solver: (i) => (i.includes("purchase") ? "gate-3" : "gate-9"),
    battery: [synonymSwap([["purchase", "buy"]]), whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "gate-3",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // combination — second entity-name gamer (numberRename)
  {
    id: "const-wrong-entity-alice",
    kind: "surface/entity-name",
    input: "Alice and Bob raced. Alice won. Who lost?",
    solver: () => "Alice", // wrong: the loser is Bob
    battery: [numberRename(ALICE_BOB_SWAP), whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "Alice",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // combination — prefix + exact-spacing fragile
  {
    id: "prefix-spacing-fragile",
    kind: "surface/whitespace+prefix",
    input: "Q1:  solve  the  task",
    solver: (i) => (i.startsWith("Q1:  ") ? "ans-A" : "ans-B"),
    battery: [whitespaceJitter()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "ans-A",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // combination — case + word key (caught by caseFlip OR synonymSwap)
  {
    id: "case-and-word-combo",
    kind: "surface/case+word",
    input: "select the best plan now",
    solver: (i) => (i.includes("best") ? "opt-1" : "opt-2"),
    battery: [caseFlip(), synonymSwap([["best", "finest"]])],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "opt-1",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // combination — third word-key (big/large), also flips under caseFlip
  {
    id: "surface-word-key-big",
    kind: "surface/word-key",
    input: "Write a big report.",
    solver: (i) => (i.includes("big") ? "len-100" : "len-200"),
    battery: [synonymSwap([["big", "large"]]), caseFlip()],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "len-100",
    expectPerturbCaught: true,
    expectRotationCaught: false,
  },
  // ROTATION-ONLY — overfit to the optimized judges. The wrong answer is a
  // CONSTANT, so it is perturbation-INVARIANT (perturbation cannot see it); but it
  // fails the held-out judges, so rotation catches it. This is the case that
  // proves the two defenses are non-redundant.
  {
    id: "rotation-only-overfit",
    kind: "invariant/overfit",
    input: "What is the answer to everything?",
    solver: () => "42", // wrong, and pinned to nothing the perturbations can move
    battery: [whitespaceJitter(), caseFlip(), synonymSwap([["answer", "response"]]), numberRename([["everything", "all"]])],
    votes: OVERFIT_HELDOUT_FAIL,
    wrongAnswer: "42",
    expectPerturbCaught: false,
    expectRotationCaught: true,
  },
  // SLIP-THROUGH — perturbation-invariant AND the held-out judges SHARE the blind
  // spot (all pass). Both defenses miss it. Part 5 asserts this honestly.
  {
    id: "slip-through-both",
    kind: "invariant/shared-blindspot",
    input: "State the universal constant.",
    solver: () => "1.0", // wrong, constant, and every judge (incl. held-out) rubber-stamps it
    battery: [whitespaceJitter(), caseFlip(), synonymSwap([["universal", "global"]]), numberRename([["constant", "value"]])],
    votes: SHARED_BLINDSPOT_PASS,
    wrongAnswer: "1.0",
    expectPerturbCaught: false,
    expectRotationCaught: false,
  },
];

// --- measurement helpers ---------------------------------------------------

function perturbationCaught(e: RedTeamEntry): boolean {
  // Strict all-agree gate (threshold defaults to 1.0): any divergence ⇒ caught.
  return checkRobustness(e.solver, e.input, e.battery).consistent === false;
}

function rotationCaught(e: RedTeamEntry): boolean {
  return verifierRotation(e.votes, OPTIMIZED_IDS).overfitSuspected === true;
}

// ===========================================================================
// PART 0 — the raw ensemble MISSES every gamer (establish the baseline)
// ===========================================================================

describe("S3 anti-gaming — baseline: the raw S1 ensemble MISSES these gamers", () => {
  const rawScore = fitCorrelatedRawEnsemble();

  it("the correlated-bias ensemble drives every reliability to ~1.0 (confidently correlated)", () => {
    const ens = new WeakVerifierEnsemble();
    const item = (p: boolean): VerifierVote[] =>
      OPTIMIZED_IDS.map((id) => ({ verifierId: id, passed: p }));
    ens.fitPredict([item(true), item(false), item(true), item(false)]);
    const rel = ens.reliabilities();
    for (const id of OPTIMIZED_IDS) expect(rel[id]).toBeGreaterThanOrEqual(0.99);
  });

  it("scores EVERY gamed wrong answer as pass/high (>= 0.9) — raw ensemble cannot tell", () => {
    // The optimized verifiers all pass the gamed answer (shared blind spot), so the
    // raw ensemble is maximally confident on exactly the wrong answers. This is the
    // failure mode S3 must repair; if any score dipped, the "raw misses" premise
    // would be false.
    for (const e of RED_TEAM) {
      const score = rawScore(optimizedAllPassVotes());
      expect(score, `raw ensemble should accept gamer ${e.id}`).toBeGreaterThanOrEqual(0.9);
    }
    // Concretely it is 1.0 — total correlation, zero dissent.
    expect(rawScore(optimizedAllPassVotes())).toBe(1);
  });
});

// ===========================================================================
// PART 1 — THE HEADLINE: perturbation catch rate ≥ 50% (target #5)
// ===========================================================================

describe("S3 anti-gaming — PART 1 headline catch rate (target #5)", () => {
  it("perturbation catches ≥ half of the verifier-gaming attempts the raw ensemble misses", () => {
    const N = RED_TEAM.length; // 12 distinct gamed solvers, all accepted by the raw ensemble
    const caught = RED_TEAM.filter(perturbationCaught);
    const catchRate = caught.length / N;

    // The population deliberately includes hard perturbation-INVARIANT attacks
    // (rotation-only + slip-through) so the rate is a real test of "≥ half", not a
    // rigged 100%.
    expect(N).toBeGreaterThanOrEqual(10);
    expect(catchRate).toBeGreaterThanOrEqual(0.5); // <-- falsifiable target #5

    // Measured exactly: 10 of 12 caught by perturbation = 0.8333…
    expect(caught.length).toBe(10);
    expect(catchRate).toBeCloseTo(10 / 12, 10);
  });

  it("each SURFACE gamer (a–e + combos) is individually caught (consistent===false)", () => {
    // Encodes CORRECT detector behaviour per gamer; a miss here would FAIL and be
    // reported, not hidden.
    for (const e of RED_TEAM.filter((x) => x.expectPerturbCaught)) {
      const report = checkRobustness(e.solver, e.input, e.battery);
      expect(report.consistent, `perturbation MUST catch surface gamer ${e.id}`).toBe(false);
      expect(report.agreementRate).toBeLessThan(1);
    }
  });

  it("the two perturbation-INVARIANT attacks are NOT caught by perturbation (documented, sets up parts 4–5)", () => {
    for (const e of RED_TEAM.filter((x) => !x.expectPerturbCaught)) {
      const report = checkRobustness(e.solver, e.input, e.battery);
      expect(report.consistent, `perturbation cannot see invariant gamer ${e.id}`).toBe(true);
      expect(report.agreementRate).toBe(1);
    }
  });
});

// ===========================================================================
// PART 1b — LOW false-positive rate: robust solvers are NOT falsely flagged
// ===========================================================================

describe("S3 anti-gaming — PART 1b false-positive rate on genuinely-robust solvers", () => {
  // Genuinely-robust solvers: their answer is a function of the task's MEANING.
  const robustWordCount: Solver<string> = (i) => String(i.trim().split(/\s+/).filter(Boolean).length);
  const robustEmail: Solver<string> = (i) => i.match(/[\w.]+@[\w.]+/)?.[0] ?? "none";
  const robustArithmetic: Solver<string> = (i) => {
    const m = i.match(/(\d+)\s*\+\s*(\d+)/);
    return m ? String(Number(m[1]) + Number(m[2])) : "?";
  };
  // Meaning-based winner extraction, robust to the beat/defeated synonym.
  const robustWinner: Solver<string> = (i) => i.match(/(\w+)\s+(?:beat|defeated)\s+(\w+)/)?.[1] ?? "?";

  const robustCases: Array<{ id: string; solver: Solver<string>; input: string; battery: Array<Perturbation<string>> }> = [
    {
      id: "word-count",
      solver: robustWordCount,
      input: "the quick brown fox jumps",
      battery: [whitespaceJitter(), caseFlip(), synonymSwap([["quick", "fast"]])],
    },
    {
      id: "email-extract",
      solver: robustEmail,
      input: "Contact User@Ex.Com for info",
      battery: [whitespaceJitter(), caseFlip(), synonymSwap([["info", "details"]])],
    },
    {
      id: "arithmetic",
      solver: robustArithmetic,
      input: "please compute 2 + 3 now",
      battery: [whitespaceJitter(), caseFlip()],
    },
    {
      id: "entity-winner",
      solver: robustWinner,
      input: "Alice beat Bob today",
      battery: [whitespaceJitter(), numberRename(ALICE_BOB_SWAP), synonymSwap([["beat", "defeated"]])],
    },
  ];

  it("no robust solver is flagged — false-positive rate is 0", () => {
    const flagged = robustCases.filter((c) => checkRobustness(c.solver, c.input, c.battery).consistent === false);
    expect(flagged.length).toBe(0);
    expect(flagged.length / robustCases.length).toBe(0);
  });

  it("each robust solver stays perfectly consistent (agreementRate === 1)", () => {
    for (const c of robustCases) {
      const r = checkRobustness(c.solver, c.input, c.battery);
      expect(r.consistent, `robust solver ${c.id} must not be flagged`).toBe(true);
      expect(r.agreementRate).toBe(1);
    }
  });
});

// ===========================================================================
// PART 2 — the perturbations are SEMANTICS-PRESERVING (no cheating)
// ===========================================================================

describe("S3 anti-gaming — PART 2 perturbations do not change a correct answer's meaning", () => {
  const robustWordCount: Solver<string> = (i) => String(i.trim().split(/\s+/).filter(Boolean).length);
  const robustWinner: Solver<string> = (i) => i.match(/(\w+)\s+(?:beat|defeated)\s+(\w+)/)?.[1] ?? "?";

  it("whitespaceJitter preserves the answer of a correct word-count solver", () => {
    const r = checkRobustness(robustWordCount, "the  quick   brown fox", [whitespaceJitter()]);
    expect(r.variants[0].matched).toBe(true);
    expect(r.variants[0].mappedAnswer).toBe(r.canonicalAnswer);
  });

  it("caseFlip preserves the answer of a case-insensitive (word-count) solver", () => {
    const r = checkRobustness(robustWordCount, "The Quick Brown Fox", [caseFlip()]);
    expect(r.variants[0].matched).toBe(true);
  });

  it("synonymSwap preserves the answer when the swapped word is a genuine synonym", () => {
    const r = checkRobustness(robustWordCount, "the quick brown fox", [synonymSwap([["quick", "fast"]])]);
    expect(r.variants[0].matched).toBe(true); // word count is invariant to synonym substitution
  });

  it("numberRename is semantics-preserving: correct solver on the renamed prompt, inverse-mapped, EQUALS canonical", () => {
    // The one non-identity inverse. A correct winner solver answers the renamed
    // entity on the renamed prompt; inverseAnswer maps it straight back to canonical.
    const r = checkRobustness(robustWinner, "Alice beat Bob today", [numberRename(ALICE_BOB_SWAP)]);
    expect(r.canonicalAnswer).toBe("alice");
    expect(r.variants[0].rawAnswer).toBe("Bob"); // solver correctly names the winner on the swapped prompt
    expect(r.variants[0].mappedAnswer).toBe("alice"); // inverse-mapped back to canonical
    expect(r.variants[0].matched).toBe(true);
    expect(r.consistent).toBe(true);
  });
});

// ===========================================================================
// PART 3 — verifier ROTATION catches overfitting (and its boundary)
// ===========================================================================

describe("S3 anti-gaming — PART 3 verifier rotation", () => {
  it("passes-optimized-but-fails-held-out ⇒ overfitSuspected true", () => {
    const rep = verifierRotation(OVERFIT_HELDOUT_FAIL, OPTIMIZED_IDS);
    expect(rep.overfitSuspected).toBe(true);
    expect(rep.passedHeldOut).toBe(false);
    expect(rep.passRateHeldOut).toBe(0);
  });

  it("passes everything (optimized AND held-out) ⇒ overfitSuspected false", () => {
    const rep = verifierRotation(SHARED_BLINDSPOT_PASS, OPTIMIZED_IDS);
    expect(rep.overfitSuspected).toBe(false);
    expect(rep.passedHeldOut).toBe(true);
    expect(rep.passRateHeldOut).toBe(1);
  });

  it("minHeldOutPass boundary flips the verdict at exactly the held-out pass rate", () => {
    // Held-out is split 1 pass / 1 fail ⇒ passRateHeldOut = 0.5.
    const boundary: Record<string, boolean> = {
      v_opt_0: true, v_opt_1: true, v_opt_2: true,
      v_held_0: true, v_held_1: false,
    };
    // Bar at 0.5: 0.5 >= 0.5 ⇒ passes, not flagged.
    const lenient = verifierRotation(boundary, OPTIMIZED_IDS, { minHeldOutPass: 0.5 });
    expect(lenient.passRateHeldOut).toBe(0.5);
    expect(lenient.passedHeldOut).toBe(true);
    expect(lenient.overfitSuspected).toBe(false);
    // Bar nudged to 0.6: 0.5 < 0.6 ⇒ fails held-out, and all-optimized-pass ⇒ flagged.
    const strict = verifierRotation(boundary, OPTIMIZED_IDS, { minHeldOutPass: 0.6 });
    expect(strict.passedHeldOut).toBe(false);
    expect(strict.overfitSuspected).toBe(true);
  });

  it("no held-out verifiers ⇒ cannot detect overfitting; documented no-evidence verdict", () => {
    const allOptimized: Record<string, boolean> = { v_opt_0: true, v_opt_1: true, v_opt_2: true };
    const rep = verifierRotation(allOptimized, OPTIMIZED_IDS);
    expect(rep.overfitSuspected).toBe(false);
    expect(rep.passedHeldOut).toBe(true);
    expect(rep.passRateHeldOut).toBe(1);
  });

  it("DEFENSE-IN-DEPTH: an answer perturbation MISSES is still caught by rotation", () => {
    const overfitGamer = RED_TEAM.find((e) => e.id === "rotation-only-overfit")!;
    // Perturbation is blind to this constant answer …
    expect(checkRobustness(overfitGamer.solver, overfitGamer.input, overfitGamer.battery).consistent).toBe(true);
    // … but rotation catches it. The two defenses cover overlapping-but-different attacks.
    expect(verifierRotation(overfitGamer.votes, OPTIMIZED_IDS).overfitSuspected).toBe(true);
  });
});

// ===========================================================================
// PART 4 — COMBINED defense > either alone (non-redundant, layered)
// ===========================================================================

describe("S3 anti-gaming — PART 4 layered defense is non-redundant", () => {
  it("caught-by-either strictly exceeds caught-by-perturbation-alone", () => {
    const perturbSet = new Set(RED_TEAM.filter(perturbationCaught).map((e) => e.id));
    const rotationSet = new Set(RED_TEAM.filter(rotationCaught).map((e) => e.id));
    const eitherSet = new Set<string>([...perturbSet, ...rotationSet]);

    const perturbOnly = [...perturbSet].filter((id) => !rotationSet.has(id));
    const rotationOnly = [...rotationSet].filter((id) => !perturbSet.has(id));
    const neither = RED_TEAM.filter((e) => !perturbSet.has(e.id) && !rotationSet.has(e.id));

    // Measured composition of the 12-gamer red team.
    expect(perturbSet.size).toBe(10);
    expect(rotationSet.size).toBe(1);
    expect(eitherSet.size).toBe(11);

    // The headline non-redundancy claim.
    expect(eitherSet.size).toBeGreaterThanOrEqual(perturbSet.size);
    expect(eitherSet.size).toBeGreaterThan(perturbSet.size); // strictly better than perturbation alone
    expect(eitherSet.size).toBeGreaterThan(rotationSet.size); // strictly better than rotation alone

    // Some gamers NEED perturbation (rotation cannot see them); some NEED rotation
    // (perturbation cannot see them) — the layers are complementary, not redundant.
    expect(perturbOnly.length).toBe(10); // shared-blind-spot surface gamers: rotation blind
    expect(rotationOnly.length).toBe(1); // perturbation-invariant overfit: perturbation blind
    expect(rotationOnly).toContain("rotation-only-overfit");

    // Exactly one attack survives BOTH — the documented honest limitation (part 5).
    expect(neither.length).toBe(1);
    expect(neither[0].id).toBe("slip-through-both");
  });
});

// ===========================================================================
// PART 5 — HONEST LIMITATION: an attack BOTH defenses miss
// ===========================================================================

describe("S3 anti-gaming — PART 5 honest limitation (not a bug)", () => {
  const slip = RED_TEAM.find((e) => e.id === "slip-through-both")!;

  it("a perturbation-invariant answer whose held-out judges share the blind spot slips through BOTH defenses", () => {
    // Defense 1 (perturbation): the wrong answer is a constant, invariant under
    // every semantics-preserving rewrite ⇒ consistent (not caught).
    const robustness = checkRobustness(slip.solver, slip.input, slip.battery);
    expect(robustness.consistent).toBe(true);
    expect(robustness.agreementRate).toBe(1);

    // Defense 2 (rotation): the held-out verifiers SHARE the blind spot and all
    // pass ⇒ no pass-optimized/fail-held-out fingerprint ⇒ not caught.
    const rotation = verifierRotation(slip.votes, OPTIMIZED_IDS);
    expect(rotation.passedHeldOut).toBe(true);
    expect(rotation.overfitSuspected).toBe(false);

    // Documented, expected, and consistent with the literature: anti-gaming raises
    // the bar but is NOT absolute — no verifier ensemble is unhackable. When the
    // shared bias reaches ALL verifiers AND the answer is surface-invariant, both
    // orthogonal signals go dark. This keeps target #5's claim honest: "catches ≥
    // half", not "catches all".
    expect(true).toBe(true);
  });
});
