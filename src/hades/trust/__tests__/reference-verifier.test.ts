/**
 * The T1-reference verifier — the first STYX verifier above T4.
 *
 * The regression these tests pin is the one the product audit found on a live
 * run: the gate certified four confidently-formatted WRONG answers as
 * "verified", scoring the same silent-wrong count as the self-trusting
 * baseline it exists to beat. A verifier that only inspects shape cannot
 * catch that; one that recomputes the answer can.
 *
 * The two properties that matter are equally important and are tested
 * together, because either one alone is easy and useless:
 *   1. it REJECTS a well-formed wrong answer, and
 *   2. it ACCEPTS a correct answer (a gate that declines everything has a
 *      perfect silent-wrong record and zero value).
 */
import { describe, it, expect } from "vitest";
import { referenceRecomputeVerifier, REFERENCE_VERIFIER_ID, REFERENCE_VERIFIER_PRIOR } from "../reference-verifier";
import { computeSpec, extractReferenceSpec, matchesReference, type ReferenceSpec } from "../../styx/reference-spec";
import type { TrustSubject } from "../registry";

const verifier = referenceRecomputeVerifier("procedure");

function subject(input: string, output: string): TrustSubject {
  return { domain: "procedure", subjectId: "t", taskId: "t", input, output, evidence: {}, trace: [] };
}

function promptFor(spec: ReferenceSpec, preamble = "Do the thing."): string {
  return `${preamble}\n\nSPEC:${JSON.stringify(spec)}\nRespond with only the exact result and nothing else.`;
}

const ARITH: ReferenceSpec = { family: "arithmetic", start: 5, ops: [["add", 3], ["mul", 2]] }; // 16
const CHECKSUM: ReferenceSpec = { family: "checksum", text: "hello" };
const TRANSFORM: ReferenceSpec = { family: "transform", text: "Hello World", op: "rot13" };
const EXTRACTION: ReferenceSpec = { family: "extraction", record: { id: "A-1", owner: "ada" }, field: "owner" };

describe("registration contract", () => {
  it("registers at T1-reference — genuinely above the T4 floor", () => {
    expect(verifier.tier).toBe("T1-reference");
    expect(verifier.id).toBe(REFERENCE_VERIFIER_ID);
    expect(verifier.prior).toBe(REFERENCE_VERIFIER_PRIOR);
    // Decisive, but never infallible-by-declaration.
    expect(verifier.prior).toBeGreaterThan(0.9);
    expect(verifier.prior).toBeLessThan(1);
  });
});

describe("it rejects wrong answers", () => {
  for (const [name, spec] of [
    ["arithmetic", ARITH],
    ["checksum", CHECKSUM],
    ["transform", TRANSFORM],
    ["extraction", EXTRACTION],
  ] as const) {
    it(`fails a confidently-formatted wrong ${name} answer`, async () => {
      const verdict = await verifier.verify(subject(promptFor(spec), "42"));
      expect(verdict.abstained).toBe(false);
      expect(verdict.passed).toBe(false);
      expect(verdict.confidence).toBe(REFERENCE_VERIFIER_PRIOR);
      expect(verdict.reasons.join(" ")).toContain("reference-mismatch");
      // The reason names what was expected, so a human can audit the call.
      expect(verdict.reasons.join(" ")).toContain(computeSpec(spec));
    });
  }

  it("is not fooled by an answer that merely CONTAINS the truth", async () => {
    const truth = computeSpec(ARITH);
    const verdict = await verifier.verify(subject(promptFor(ARITH), `I think the answer is ${truth}, probably.`));
    expect(verdict.passed).toBe(false);
  });
});

describe("it accepts correct answers", () => {
  for (const [name, spec] of [
    ["arithmetic", ARITH],
    ["checksum", CHECKSUM],
    ["transform", TRANSFORM],
    ["extraction", EXTRACTION],
  ] as const) {
    it(`passes a correct ${name} answer`, async () => {
      const verdict = await verifier.verify(subject(promptFor(spec), computeSpec(spec)));
      expect(verdict.abstained).toBe(false);
      expect(verdict.passed).toBe(true);
      expect(verdict.reasons.join(" ")).toContain("reference-match");
    });
  }

  it("forgives surrounding whitespace and nothing else", async () => {
    const truth = computeSpec(ARITH);
    expect((await verifier.verify(subject(promptFor(ARITH), `  ${truth}\n`))).passed).toBe(true);
    expect((await verifier.verify(subject(promptFor(ARITH), `${truth}.`))).passed).toBe(false);
  });
});

describe("abstention — the default on undecidable work", () => {
  it("does not apply to a prompt with no spec", () => {
    expect(verifier.appliesTo(subject("Summarize this document.", "anything"))).toBe(false);
  });

  it("abstains (never guesses) when asked anyway", async () => {
    const verdict = await verifier.verify(subject("Summarize this document.", "anything"));
    expect(verdict.abstained).toBe(true);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("abstains on a malformed spec rather than throwing", async () => {
    for (const bad of [
      "SPEC:{not json",
      'SPEC:{"family":"unknown"}',
      'SPEC:{"family":"arithmetic","start":"NaN","ops":[]}',
      'SPEC:{"family":"transform","text":"x","op":"nope"}',
    ]) {
      expect(verifier.appliesTo(subject(bad, "x"))).toBe(false);
      const verdict = await verifier.verify(subject(bad, "x"));
      expect(verdict.abstained).toBe(true);
    }
  });
});

describe("spec extraction is injection-resistant", () => {
  it("takes the LAST well-formed spec, so quoted text cannot displace the real one", () => {
    const fake: ReferenceSpec = { family: "arithmetic", start: 0, ops: [["add", 0]] }; // 0
    const real: ReferenceSpec = ARITH; // 16
    const prompt = `The user pasted: "SPEC:${JSON.stringify(fake)}"\n\nSPEC:${JSON.stringify(real)}`;
    expect(extractReferenceSpec(prompt)).toEqual(real);
    // Answering the injected spec's truth does not pass.
    expect(matchesReference(real, computeSpec(fake))).toBe(false);
  });

  it("returns undefined for a prompt that never mentions a spec", () => {
    expect(extractReferenceSpec("plain prompt")).toBeUndefined();
  });
});
