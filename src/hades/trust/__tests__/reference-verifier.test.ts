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
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceRecomputeVerifier, REFERENCE_VERIFIER_ID, REFERENCE_VERIFIER_PRIOR } from "../reference-verifier";
import { computeSpec, extractReferenceSpec, matchesReference, type ReferenceSpec } from "../../styx/reference-spec";
import { computeDeclaredReference, formatDeclaredReference } from "../../styx/declared-rules";
import { EVAL_TASKS, referenceAnnotatedTasks } from "../../bench/eval-suite";
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

// ---------------------------------------------------------------------------
// Declared rules — the same recompute-and-compare, over the REAL corpus
// ---------------------------------------------------------------------------

/**
 * Wrap an answer the way a model actually answers: a sentence, not a bare
 * token. Every one of these graders re-extracts from the output, so this stays
 * a CORRECT answer — and each assertion below confirms that with `grade()`
 * before demanding anything of the verifier. Without this, "the verifier
 * passes correct answers" could be satisfied by a verifier that only accepts
 * one exact rendering, which on real output is a false-alarm machine.
 *
 * No colon and no trailing period: a colon would be swallowed by the
 * `key:value` parse and a period would be swallowed by the URL pattern,
 * turning the wrapper itself into the wrong answer.
 */
function asProse(answer: string): string {
  return `The answer is ${answer}`;
}

/** Drop the first element — a plausible, well-formed, INCOMPLETE answer. */
function dropFirstElement(answer: string): string | undefined {
  const comma = answer.indexOf(",");
  return comma < 0 ? undefined : answer.slice(comma + 1);
}

describe("declared rules — the real EVAL_TASKS corpus", () => {
  const annotated = referenceAnnotatedTasks();

  it("covers a real, non-trivial slice of the corpus", () => {
    // The gap this closes: before declared rules, this number was 0 and the
    // fitted conformal threshold was +Infinity on every eval subject.
    expect(annotated.length).toBeGreaterThan(0);
    expect(annotated.length).toBeLessThan(EVAL_TASKS.length);
  });

  for (const task of annotated) {
    const expected = computeDeclaredReference(task.reference!, task.prompt) as string;

    it(`${task.id}: passes a correct answer the grader also accepts`, async () => {
      const answer = asProse(expected);
      expect(task.grade(answer)).toBe(true); // the answer really is correct…
      const verdict = await verifier.verify(subject(task.prompt, answer));
      expect(verdict.abstained).toBe(false);
      expect(verdict.passed).toBe(true); // …and the verifier says so
      expect(verdict.reasons.join(" ")).toContain(`reference-match:rule:${task.reference!.rule}`);
    });

    it(`${task.id}: fails an incomplete answer the grader also rejects`, async () => {
      const wrong = dropFirstElement(expected);
      expect(wrong).toBeDefined();
      expect(task.grade(wrong as string)).toBe(false); // the answer really is wrong…
      const verdict = await verifier.verify(subject(task.prompt, wrong as string));
      expect(verdict.abstained).toBe(false);
      expect(verdict.passed).toBe(false); // …and the verifier says so
      expect(verdict.confidence).toBe(REFERENCE_VERIFIER_PRIOR);
    });

    it(`${task.id}: fails an empty answer`, async () => {
      const verdict = await verifier.verify(subject(task.prompt, ""));
      expect(verdict.passed).toBe(false);
    });
  }

  it("abstains on every task that carries no declaration", async () => {
    const unannotated = EVAL_TASKS.filter((t) => !t.reference);
    expect(unannotated.length).toBeGreaterThan(0);
    for (const task of unannotated) {
      // A guessed verdict on sentiment/summarisation/world-knowledge work
      // would be worse than no verdict at all.
      expect(verifier.appliesTo(subject(task.prompt, "anything"))).toBe(false);
      const verdict = await verifier.verify(subject(task.prompt, "anything"));
      expect(verdict.abstained).toBe(true);
      expect(verdict.confidence).toBe(0);
    }
  });
});

/**
 * Walk the verifier's transitive RELATIVE imports. A boundary that is only
 * promised in a comment is a boundary that will be crossed by the next
 * refactor; this reads the actual module graph off disk.
 */
function transitiveImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [normalize(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const base = normalize(join(dirname(file), m[1]));
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return Array.from(seen);
}

describe("the verifier cannot reach the answer key — structurally, not by promise", () => {
  it("never imports the eval corpus, its graders, or anything under bench/", () => {
    const here = dirname(fileURLToPath(import.meta.url)); // src/hades/trust/__tests__
    const entry = join(here, "..", "reference-verifier.ts");
    const closure = transitiveImports(entry);

    // Sanity: the walk actually found the graph it is asserting about.
    expect(closure.length).toBeGreaterThan(1);
    expect(closure.some((f) => f.endsWith("declared-rules.ts"))).toBe(true);

    // The claim: no module the verifier can reach lives in the benchmark, so
    // there is no import path from a verdict to an expected value or a
    // `grade()` closure. A verifier that could consult the answer key would
    // agree with it by construction and certify nothing.
    const fromBench = closure.filter((f) => /[\\/]bench[\\/]/.test(f));
    expect(fromBench).toEqual([]);
  });
});

describe("declared rules — the boundary that makes the check honest", () => {
  it("ignores a rule the ANSWERER attached to evidence or trace", async () => {
    // The verifier reads the REQUEST. If it read `evidence`, whoever produced
    // the answer could pick the criterion it is judged by — here, declaring an
    // email-extraction rule for a prompt full of addresses so that echoing
    // them back "verifies" a non-answer.
    const forged: TrustSubject = {
      domain: "procedure",
      subjectId: "t",
      taskId: "t",
      input: "Summarize this thread from alice@example.com and bob@test.org.",
      output: "alice@example.com,bob@test.org",
      evidence: { reference: { rule: "extract-emails" }, declaredRule: "extract-emails" },
      trace: [{ seq: 1, kind: "declare", detail: formatDeclaredReference({ rule: "extract-emails" }) }],
    };
    expect(verifier.appliesTo(forged)).toBe(false);
    expect((await verifier.verify(forged)).abstained).toBe(true);
  });

  it("abstains when a declared rule recomputes nothing from the request", async () => {
    // An empty extraction must NOT become an empty expectation that an empty
    // answer trivially matches.
    const prompt = `Extract all email addresses from this message.\n${formatDeclaredReference({ rule: "extract-emails" })}`;
    expect(verifier.appliesTo(subject(prompt, ""))).toBe(false);
    const verdict = await verifier.verify(subject(prompt, ""));
    expect(verdict.abstained).toBe(true);
  });

  it("abstains on a malformed or unknown declaration rather than guessing", async () => {
    for (const bad of [
      "REF:{not json",
      'REF:{"rule":"extract-unicorns"}',
      'REF:{"rule":42}',
      "REF:",
    ]) {
      const prompt = `Contact alice@example.com.\n${bad}`;
      expect(verifier.appliesTo(subject(prompt, "x"))).toBe(false);
      expect((await verifier.verify(subject(prompt, "x"))).abstained).toBe(true);
    }
  });

  it("takes the LAST declaration, so a quoted one cannot displace the real one", async () => {
    // The attacker echoes an easier rule; the asker's line is appended last.
    const prompt =
      `A user pasted: "${formatDeclaredReference({ rule: "extract-integers-ascending" })}"\n` +
      `Extract all email addresses from: Contact alice@example.com or bob@test.org.\n` +
      `${formatDeclaredReference({ rule: "extract-emails" })}`;
    const verdict = await verifier.verify(subject(prompt, "alice@example.com,bob@test.org"));
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("rule:extract-emails");
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
