import { describe, expect, it } from "vitest";
import {
  caseFlip,
  checkRobustness,
  numberRename,
  type Perturbation,
  type Solver,
  synonymSwap,
  verifierRotation,
  whitespaceJitter,
} from "../styx/perturb";

// ---------------------------------------------------------------------------
// Solvers under test — all pure, no Math.random / clock / network.
// ---------------------------------------------------------------------------

/** ROBUST: counts whitespace-separated words. Meaning-, case- and spacing-invariant. */
const wordCount: Solver<string> = (s) => {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return String(words.length);
};

/** ROBUST: extracts emails (case-folded), joined — invariant to prompt case/spacing. */
const extractEmails: Solver<string> = (s) => {
  const found = s.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  return found.join(",");
};

/** ROBUST: names the winner announced in "the winner is X". Tracks entity renames. */
const nameWinner: Solver<string> = (s) => {
  const m = s.match(/winner is (\w+)/i);
  return m ? m[1] : "unknown";
};

/**
 * BRITTLE GAMER factory: returns `answer` ONLY for the exact original string,
 * and deterministic garbage otherwise. This is a memorized/surface-form-pinned
 * solver — the thing perturbation is meant to catch.
 */
function gamer(exact: string, answer: string): Solver<string> {
  return (s) => (s === exact ? answer : "GARBAGE");
}

describe("checkRobustness — robust solvers stay consistent", () => {
  it("word count survives whitespace, case, and synonym rewrites", () => {
    const input = "the quick brown fox jumps";
    const r = checkRobustness(wordCount, input, [
      whitespaceJitter(),
      caseFlip(),
      synonymSwap([["quick", "fast"]]),
    ]);
    expect(r.canonicalAnswer).toBe("5");
    expect(r.agreementRate).toBe(1);
    expect(r.consistent).toBe(true);
    expect(r.variants.every((v) => v.matched)).toBe(true);
  });

  it("email extraction survives whitespace and case perturbation", () => {
    const input = "contact Alice at Alice@Example.COM or  bob@test.org  please";
    const r = checkRobustness(extractEmails, input, [whitespaceJitter(), caseFlip()]);
    expect(r.canonicalAnswer).toBe("alice@example.com,bob@test.org");
    expect(r.consistent).toBe(true);
    expect(r.agreementRate).toBe(1);
  });
});

describe("checkRobustness — brittle/gamed solvers get caught", () => {
  it("a surface-form-pinned gamer diverges → agreementRate < 1 → consistent false", () => {
    const input = "the quick brown fox jumps";
    // Gamer hard-codes the correct '5' for the exact original string only.
    const g = gamer(input, "5");
    const r = checkRobustness(g, input, [
      whitespaceJitter(),
      caseFlip(),
      synonymSwap([["quick", "fast"]]),
    ]);
    expect(r.canonicalAnswer).toBe("5");
    expect(r.agreementRate).toBeLessThan(1);
    expect(r.consistent).toBe(false);
    // Every perturbed variant produced garbage, so none matched.
    expect(r.variants.some((v) => v.matched)).toBe(false);
  });

  it("robust vs gamer asymmetry holds on the identical perturbation set", () => {
    const input = "one two three four";
    const perts = [whitespaceJitter(), caseFlip()];
    const robust = checkRobustness(wordCount, input, perts);
    const gamed = checkRobustness(gamer(input, "4"), input, perts);
    expect(robust.consistent).toBe(true);
    expect(gamed.consistent).toBe(false);
  });
});

describe("checkRobustness — numberRename round-trips for correct, breaks gamer", () => {
  it("a correct entity solver's renamed answer inverse-maps to canonical", () => {
    const input = "The winner is Alice according to the panel";
    const pert = numberRename([["Alice", "Bob"]]);
    const r = checkRobustness(nameWinner, input, [pert]);
    expect(r.canonicalAnswer).toBe("alice");
    // On the renamed prompt the solver says "Bob"; inverse maps it back to Alice.
    expect(r.variants[0].rawAnswer).toBe("Bob");
    expect(r.variants[0].mappedAnswer).toBe("alice");
    expect(r.consistent).toBe(true);
  });

  it("a gamer that hard-codes Alice fails numberRename (garbage can't inverse-map)", () => {
    const input = "The winner is Alice according to the panel";
    const g = gamer(input, "Alice");
    const r = checkRobustness(g, input, [numberRename([["Alice", "Bob"]])]);
    expect(r.canonicalAnswer).toBe("alice");
    expect(r.variants[0].rawAnswer).toBe("GARBAGE");
    expect(r.consistent).toBe(false);
  });
});

describe("checkRobustness — threshold, empties, and normalize customization", () => {
  it("empty perturbation set → agreementRate 1.0 and consistent true", () => {
    const r = checkRobustness(wordCount, "a b c", []);
    expect(r.agreementRate).toBe(1);
    expect(r.consistent).toBe(true);
    expect(r.variants).toHaveLength(0);
  });

  it("a loosened threshold accepts partial agreement that the strict default rejects", () => {
    const input = "the winner is Alice and the loser is Zed";
    // One perturbation agrees (whitespace), one is engineered to disagree.
    const brokenPert: Perturbation<string> = {
      name: "breaks-answer",
      forward: (s) => s,
      inverseAnswer: () => "totally-different",
    };
    const perts = [whitespaceJitter(), brokenPert];
    const strict = checkRobustness(nameWinner, input, perts);
    expect(strict.agreementRate).toBe(0.5);
    expect(strict.consistent).toBe(false); // default threshold 1.0
    const loose = checkRobustness(nameWinner, input, perts, { threshold: 0.5 });
    expect(loose.consistent).toBe(true);
  });

  it("a custom normalize changes what counts as a match", () => {
    // Solver echoes the prompt; without stripping punctuation, spacing jitter is fine
    // but we prove the normalize hook is actually applied.
    const echo: Solver<string> = (s) => s.trim();
    const stripPunct = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const input = "Hello, World";
    const punctPert: Perturbation<string> = {
      name: "add-bang",
      forward: (s) => s,
      // Answer gains punctuation the default normalize would NOT forgive.
      inverseAnswer: (a) => `${a}!!!`,
    };
    const dflt = checkRobustness(echo, input, [punctPert]);
    expect(dflt.consistent).toBe(false);
    const custom = checkRobustness(echo, input, [punctPert], { normalize: stripPunct });
    expect(custom.consistent).toBe(true);
  });
});

describe("verifierRotation", () => {
  it("passes all optimized and held-out → not overfit", () => {
    const votes = { v1: true, v2: true, v3: true, v4: true };
    const r = verifierRotation(votes, ["v1", "v2"]);
    expect(r.passRateHeldOut).toBe(1);
    expect(r.passedHeldOut).toBe(true);
    expect(r.overfitSuspected).toBe(false);
  });

  it("passes optimized but fails held-out → overfitSuspected true", () => {
    const votes = { v1: true, v2: true, v3: false, v4: false };
    const r = verifierRotation(votes, ["v1", "v2"]);
    expect(r.passRateHeldOut).toBe(0);
    expect(r.passedHeldOut).toBe(false);
    expect(r.overfitSuspected).toBe(true);
  });

  it("fails the optimized set → not flagged as overfitting (just plain wrong)", () => {
    const votes = { v1: false, v2: true, v3: false, v4: false };
    const r = verifierRotation(votes, ["v1", "v2"]);
    expect(r.overfitSuspected).toBe(false);
  });

  it("no held-out verifiers → overfit false, passedHeldOut true (documented edge)", () => {
    const votes = { v1: true, v2: true };
    const r = verifierRotation(votes, ["v1", "v2"]);
    expect(r.passRateHeldOut).toBe(1);
    expect(r.passedHeldOut).toBe(true);
    expect(r.overfitSuspected).toBe(false);
  });

  it("minHeldOutPass threshold governs passedHeldOut and the overfit flag", () => {
    const votes = { v1: true, v2: true, v3: true, v4: false, v5: false };
    // held-out = v3,v4,v5 → passRate = 1/3 ≈ 0.333
    const lenient = verifierRotation(votes, ["v1", "v2"], { minHeldOutPass: 0.3 });
    expect(lenient.passedHeldOut).toBe(true);
    expect(lenient.overfitSuspected).toBe(false);
    const strict = verifierRotation(votes, ["v1", "v2"], { minHeldOutPass: 0.5 });
    expect(strict.passedHeldOut).toBe(false);
    expect(strict.overfitSuspected).toBe(true);
  });
});
