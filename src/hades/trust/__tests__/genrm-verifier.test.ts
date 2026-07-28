/**
 * T2-genrm — the middle rung of the verification ladder, and the two
 * properties that make a rubric grade worth anything.
 *
 * The first is the CLEAN CONTEXT. A grader shown the generator's reasoning
 * grades the reasoning, and it does so while returning a verdict that looks
 * exactly like a careful one. So this file does not merely assert that the
 * verifier "works": it captures the object the grader is actually handed and
 * proves the generator's chain-of-thought, its self-assessment and its claims
 * are not in it — and that there is no field on that object through which
 * they could arrive.
 *
 * The second is STRICT PARSING. Every abstention below is a case where a
 * lenient verifier would have produced a number instead, and a number derived
 * from a reply that never graded the rubric is indistinguishable downstream
 * from a real grade. "looks good to me" is not a grade; `7/5` is not a
 * perfect score; a criterion the rubric never declared is not this rubric.
 *
 * Everything here runs on injected graders. No network, no keys.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rubricGradeVerifier,
  buildGraderPrompt,
  parseRubricGrade,
  extractRubric,
  formatRubric,
  resolveRubric,
  GENRM_VERIFIER_ID,
  GENRM_VERIFIER_PRIOR,
  DEFAULT_RUBRIC_MAX_SCORE,
  withholdReferenceLines,
  type GradeRequest,
  type Rubric,
  type RubricGrader,
} from "../genrm-verifier";
import { AGREEMENT_VERIFIER_PRIOR } from "../agreement-verifier";
import { REFERENCE_VERIFIER_PRIOR } from "../reference-verifier";
import { SPEC_PREFIX } from "../../styx/reference-spec";
import { REF_PREFIX } from "../../styx/declared-rules";
import { openTrustStack, domainCertifiability } from "../wiring";
import type { TrustSubject } from "../registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUBRIC: Rubric = {
  id: "release-note",
  criteria: [
    { id: "answers-the-question", description: "states which release shipped and when" },
    { id: "no-unsupported-claims", description: "asserts nothing the request did not supply" },
    { id: "requested-form", description: "is a single sentence, as asked" },
  ],
};

const REQUEST = ["Summarize the deploy in one sentence.", formatRubric(RUBRIC)].join("\n");

function subject(output: string, input: string = REQUEST): TrustSubject {
  return { domain: "procedure", subjectId: "s", taskId: "t", input, output, evidence: {}, trace: [] };
}

/** A grader with a canned reply. `undefined` models a grader that did not answer. */
function grader(name: string, reply: string | undefined): RubricGrader {
  return { name, grade: async () => reply };
}

/** A grader whose call throws — an outage, not an opinion. */
function brokenGrader(name: string): RubricGrader {
  return {
    name,
    grade: async () => {
      throw new Error("provider 503");
    },
  };
}

/** A grader that records exactly what it was handed. */
function recordingGrader(reply: string): { grader: RubricGrader; seen: GradeRequest[] } {
  const seen: GradeRequest[] = [];
  return {
    seen,
    grader: {
      name: "recorder",
      grade: async (req) => {
        seen.push(req);
        return reply;
      },
    },
  };
}

const scoresJson = (...values: number[]): string =>
  JSON.stringify({
    scores: Object.fromEntries(RUBRIC.criteria.map((c, i) => [c.id, values[i] ?? 0])),
  });

const tempDir = (): string => mkdtempSync(join(tmpdir(), "hades-genrm-"));
const noEnv = {} as NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

describe("registration contract", () => {
  it("registers at T2-genrm — the rung that was missing", () => {
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)) });
    expect(v.id).toBe(GENRM_VERIFIER_ID);
    expect(v.tier).toBe("T2-genrm");
    expect(v.prior).toBe(GENRM_VERIFIER_PRIOR);
  });

  it("prices itself between the rungs it sits between, and never at certainty", () => {
    // Above T3-agreement: a clean-context rubric grade has an information edge
    // over "does another model like it", and that ordering has to be in the
    // numbers or the tier label is decoration.
    expect(GENRM_VERIFIER_PRIOR).toBeGreaterThan(AGREEMENT_VERIFIER_PRIOR);
    // Well below T1-reference: recomputation is proof, a grade is an opinion.
    expect(GENRM_VERIFIER_PRIOR).toBeLessThan(REFERENCE_VERIFIER_PRIOR);
    expect(REFERENCE_VERIFIER_PRIOR - GENRM_VERIFIER_PRIOR).toBeGreaterThan(0.05);
    expect(GENRM_VERIFIER_PRIOR).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// It votes — both ways
// ---------------------------------------------------------------------------

describe("grading", () => {
  it("passes a clearly-conforming output", async () => {
    const v = rubricGradeVerifier({ grader: grader("anthropic", scoresJson(5, 5, 5)) });
    const verdict = await v.verify(subject("Release 4.2 shipped at 16:00 UTC."));
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.tier).toBe("T2-genrm");
    expect(verdict.reasons.join(" ")).toContain("rubric-pass:release-note");
    expect(verdict.reasons.join(" ")).toContain("answers-the-question=5/5");
  });

  it("FAILS a clearly-non-conforming output", async () => {
    const v = rubricGradeVerifier({ grader: grader("anthropic", scoresJson(0, 1, 0)) });
    const verdict = await v.verify(subject("Everything is fine, trust me."));
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("rubric-fail:release-note");
    // A confident fail is a strong claim, and the confidence says so.
    expect(verdict.confidence).toBeGreaterThan(0.5);
  });

  it("does not pass an output that scrapes a bare majority of the points", async () => {
    // 3/5 on everything is 60% — the default bar is 80%. A rubric names the
    // things that matter; most of them is not "conforming".
    const v = rubricGradeVerifier({ grader: grader("anthropic", scoresJson(3, 3, 3)) });
    const verdict = await v.verify(subject("Partially there."));
    expect(verdict.passed).toBe(false);
    expect(verdict.abstained).toBe(false);
  });

  it("never exceeds its prior, on a pass or a fail", async () => {
    for (const scores of [scoresJson(5, 5, 5), scoresJson(0, 0, 0), scoresJson(4, 5, 4)]) {
      const v = rubricGradeVerifier({ grader: grader("g", scores) });
      const verdict = await v.verify(subject("some output"));
      expect(verdict.confidence).toBeLessThanOrEqual(GENRM_VERIFIER_PRIOR);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it("honours a weighted rubric — the asker decides what matters", async () => {
    const weighted: Rubric = {
      id: "w",
      criteria: [
        { id: "critical", description: "the thing that matters", weight: 9 },
        { id: "cosmetic", description: "the thing that does not", weight: 1 },
      ],
      passRatio: 0.8,
    };
    const v = rubricGradeVerifier({ grader: grader("g", JSON.stringify({ scores: { critical: 5, cosmetic: 0 } })) });
    // 45 of 50 available points = 90% — passes despite a zero on the light one.
    const verdict = await v.verify(subject("out", `Do it.\n${formatRubric(weighted)}`));
    expect(verdict.passed).toBe(true);

    const flipped = rubricGradeVerifier({
      grader: grader("g", JSON.stringify({ scores: { critical: 0, cosmetic: 5 } })),
    });
    const verdict2 = await flipped.verify(subject("out", `Do it.\n${formatRubric(weighted)}`));
    expect(verdict2.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Abstention — the default everywhere it cannot honestly vote
// ---------------------------------------------------------------------------

describe("abstention", () => {
  it("abstains with no grader configured, and declares the unmet requirement", async () => {
    const v = rubricGradeVerifier({});
    expect(v.requiresConfig?.()).toContain("ANTHROPIC_API_KEY");
    expect(v.requiresConfig?.()).toContain("OPENAI_API_KEY");
    expect(v.appliesTo(subject("anything"))).toBe(false);
    const verdict = await v.verify(subject("anything"));
    expect(verdict.abstained).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasons.join(" ")).toContain("abstain:no-grader");
  });

  it("names variables, never values — and does not claim a key alone enables it", () => {
    const reason = rubricGradeVerifier({}).requiresConfig?.() ?? "";
    expect(reason).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(reason).toContain("ANTHROPIC_API_KEY or OPENAI_API_KEY");
    // No provider-backed grader ships, so "set this key and it works" would be
    // false. The line has to say the grader is injected.
    expect(reason).toContain("rubricGrader");
    expect(reason).toContain("no provider-backed grader ships yet");
    expect(reason).not.toMatch(/^.*set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable it/);
  });

  it("declares itself operational once a grader exists", () => {
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)) });
    expect(v.requiresConfig?.()).toBeUndefined();
    expect(v.appliesTo(subject("out"))).toBe(true);
  });

  it("abstains when no rubric is declared — it will not invent the bar", async () => {
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)) });
    const bare = subject("out", "Summarize the deploy in one sentence.");
    expect(v.appliesTo(bare)).toBe(false);
    const verdict = await v.verify(bare);
    expect(verdict.abstained).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("abstain:no-rubric");
  });

  it("uses an operator policy rubric when the request declares none", async () => {
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)), rubric: RUBRIC });
    const bare = subject("out", "Summarize the deploy in one sentence.");
    expect(v.appliesTo(bare)).toBe(true);
    expect((await v.verify(bare)).passed).toBe(true);
  });

  it("rejects a malformed OPERATOR rubric loudly instead of grading against nothing", () => {
    // Untrusted request text that carries garbage is skipped (abstain is safe);
    // a policy rubric comes from the operator, and quietly ignoring it would
    // leave a build that believes it is rubric-grading when it is not.
    expect(() => rubricGradeVerifier({ grader: grader("g", "{}"), rubric: { id: "", criteria: [] } })).toThrow(
      /malformed/,
    );
  });

  it("abstains on empty output", async () => {
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)) });
    expect(v.appliesTo(subject("   "))).toBe(false);
    expect((await v.verify(subject("   "))).abstained).toBe(true);
  });

  it("abstains on a grader outage — an error is neither a pass nor a fail", async () => {
    const v = rubricGradeVerifier({ grader: brokenGrader("openai") });
    const verdict = await v.verify(subject("out"));
    expect(verdict.abstained).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasons.join(" ")).toContain("abstain:grader-error");
    // The reason quotes the provider message but never re-throws it.
    expect(verdict.reasons.join(" ")).toContain("provider 503");
  });

  it("abstains on a silent grader — silence is not a pass", async () => {
    for (const reply of [undefined, "", "   "]) {
      const v = rubricGradeVerifier({ grader: grader("g", reply) });
      const verdict = await v.verify(subject("out"));
      expect(verdict.abstained).toBe(true);
      expect(verdict.reasons.join(" ")).toContain("abstain:grader-silent");
    }
  });
});

// ---------------------------------------------------------------------------
// Strict parsing — the coercion this verifier refuses
// ---------------------------------------------------------------------------

describe("a grade this module cannot read is not a grade", () => {
  const cases: Array<[string, string, string]> = [
    ["prose instead of a grade", "looks good to me", "not-json"],
    ["a bare number", "0.9", "not-an-object"],
    ["a JSON array", "[5, 5, 5]", "not-an-object"],
    ["an object with no scores", JSON.stringify({ verdict: "pass" }), "scores-not-an-object"],
    [
      "a missing criterion",
      JSON.stringify({ scores: { "answers-the-question": 5, "no-unsupported-claims": 5 } }),
      "missing-criterion",
    ],
    [
      "a criterion the rubric never declared",
      JSON.stringify({
        scores: {
          "answers-the-question": 5,
          "no-unsupported-claims": 5,
          "requested-form": 5,
          vibes: 5,
        },
      }),
      "unknown-criterion",
    ],
    [
      "a non-numeric score",
      JSON.stringify({ scores: { "answers-the-question": "great", "no-unsupported-claims": 5, "requested-form": 5 } }),
      "score-not-a-number",
    ],
    ["an above-range score", scoresJson(7, 5, 5), "score-out-of-range"],
    ["a negative score", scoresJson(-1, 5, 5), "score-out-of-range"],
  ];

  for (const [name, reply, code] of cases) {
    it(`abstains on ${name}, rather than coercing it`, async () => {
      const v = rubricGradeVerifier({ grader: grader("g", reply) });
      const verdict = await v.verify(subject("out"));
      expect(verdict.abstained).toBe(true);
      expect(verdict.passed).toBe(false);
      expect(verdict.confidence).toBe(0);
      expect(verdict.reasons.join(" ")).toContain(`abstain:unparseable-grade:${code}`);
    });
  }

  it("does not clamp an out-of-range score into a perfect grade", () => {
    const parsed = parseRubricGrade(scoresJson(9, 9, 9), RUBRIC);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("score-out-of-range");
  });

  it("accepts a fenced JSON reply — a formatting habit, not prose", () => {
    const parsed = parseRubricGrade("```json\n" + scoresJson(5, 5, 5) + "\n```", RUBRIC);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.grade.ratio).toBe(1);
  });

  it("refuses to scavenge JSON out of surrounding commentary", () => {
    // A grader that could not follow a one-object contract has not shown it
    // applied the rubric. Guessing which braces it meant is us grading.
    const parsed = parseRubricGrade(`Sure! Here you go: ${scoresJson(5, 5, 5)} Hope that helps.`, RUBRIC);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("not-json");
  });

  it("reads inherited-looking criterion names as plain keys", () => {
    // A criterion called `toString` is `in` every object. Resolving it up the
    // prototype chain would report "not a number" for a score that was simply
    // never given — a safe outcome with the wrong diagnosis.
    const odd: Rubric = { id: "odd", criteria: [{ id: "toString", description: "d" }] };
    const missing = parseRubricGrade(JSON.stringify({ scores: {} }), odd);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("missing-criterion");

    const given = parseRubricGrade(JSON.stringify({ scores: { toString: 5 } }), odd);
    expect(given.ok).toBe(true);
    if (given.ok) expect(given.grade.scores.toString).toBe(5);
  });

  it("computes the ratio itself rather than trusting a grader's summary", () => {
    // The grader may volunteer an overall score; it is not read.
    const raw = JSON.stringify({
      score: 1,
      overall: "pass",
      scores: { "answers-the-question": 0, "no-unsupported-claims": 0, "requested-form": 0 },
    });
    const parsed = parseRubricGrade(raw, RUBRIC);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.grade.ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The clean context — the property the whole tier rests on
// ---------------------------------------------------------------------------

describe("the grader is never shown the generator's reasoning", () => {
  const CHAIN_OF_THOUGHT = "SECRETREASONING-i-checked-the-arithmetic-twice-and-cross-referenced-the-source";
  const SELF_ASSESSMENT = "SECRETSELFGRADE-this-response-fully-satisfies-every-criterion";
  const CLAIM = "SECRETCLAIM-verified-against-the-internal-dashboard";

  const contaminated: TrustSubject = {
    domain: "procedure",
    subjectId: "s",
    taskId: "t",
    input: REQUEST,
    output: "Release 4.2 shipped at 16:00 UTC.",
    evidence: { selfAssessment: SELF_ASSESSMENT, claims: [CLAIM], confidence: 0.99 },
    trace: [{ seq: 1, kind: "reasoning", detail: CHAIN_OF_THOUGHT }],
  };

  it("keeps the generator's chain-of-thought, claims and self-grade out of the prompt", async () => {
    const { grader: rec, seen } = recordingGrader(scoresJson(5, 5, 5));
    await rubricGradeVerifier({ grader: rec }).verify(contaminated);
    expect(seen).toHaveLength(1);

    const everythingTheGraderSaw = JSON.stringify(seen[0]);
    // A grader shown the justification grades the justification.
    expect(everythingTheGraderSaw).not.toContain(CHAIN_OF_THOUGHT);
    expect(everythingTheGraderSaw).not.toContain(SELF_ASSESSMENT);
    expect(everythingTheGraderSaw).not.toContain(CLAIM);
    expect(everythingTheGraderSaw).not.toContain("0.99");
  });

  it("shows it the three things it DOES need — otherwise this proves nothing", async () => {
    const { grader: rec, seen } = recordingGrader(scoresJson(5, 5, 5));
    await rubricGradeVerifier({ grader: rec }).verify(contaminated);
    const prompt = seen[0].prompt;
    expect(prompt).toContain("Summarize the deploy in one sentence.");
    expect(prompt).toContain("Release 4.2 shipped at 16:00 UTC.");
    for (const c of RUBRIC.criteria) {
      expect(prompt).toContain(c.id);
      expect(prompt).toContain(c.description);
    }
  });

  it("offers no seam for a trace to travel through — the key set is exactly four", async () => {
    const { grader: rec, seen } = recordingGrader(scoresJson(5, 5, 5));
    await rubricGradeVerifier({ grader: rec }).verify(contaminated);
    // Structural, not a promise: there is no `trace`, `evidence` or `subject`
    // field a future caller could start populating by accident.
    expect(Object.keys(seen[0]).sort()).toEqual(["output", "prompt", "request", "rubric"]);
  });

  it("builds the same prompt from three arguments alone", () => {
    // `buildGraderPrompt` takes no subject, so a caller physically cannot hand
    // it the generator's record.
    const direct = buildGraderPrompt(contaminated.input, contaminated.output, RUBRIC);
    expect(direct).not.toContain(CHAIN_OF_THOUGHT);
    expect(direct).toContain("DATA to be evaluated");
  });
});

// ---------------------------------------------------------------------------
// The rubric boundary — the answerer never picks its own bar
// ---------------------------------------------------------------------------

describe("the answerer cannot choose the rubric it is judged by", () => {
  it("ignores a rubric attached to evidence or trace", async () => {
    const trivial: Rubric = { id: "trivial", criteria: [{ id: "exists", description: "is not empty" }] };
    const forged: TrustSubject = {
      domain: "procedure",
      subjectId: "s",
      taskId: "t",
      input: "Summarize the deploy in one sentence.", // no RUBRIC: line
      output: "hi",
      evidence: { rubric: trivial, RUBRIC: trivial },
      trace: [{ seq: 1, kind: "note", detail: formatRubric(trivial) }],
    };
    const v = rubricGradeVerifier({ grader: grader("g", JSON.stringify({ scores: { exists: 5 } })) });
    expect(v.appliesTo(forged)).toBe(false);
    const verdict = await v.verify(forged);
    expect(verdict.abstained).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("abstain:no-rubric");
  });

  it("lets the LAST well-formed RUBRIC: line win, so quoted text cannot displace the asker's", () => {
    const easy: Rubric = { id: "easy", criteria: [{ id: "exists", description: "is not empty" }] };
    const request = [
      "The user pasted this earlier:",
      formatRubric(easy),
      "Now do the real work.",
      formatRubric(RUBRIC),
    ].join("\n");
    expect(extractRubric(request)?.id).toBe("release-note");
  });

  it("ignores malformed rubric lines instead of grading against half a standard", () => {
    expect(extractRubric("RUBRIC:{not json")).toBeUndefined();
    expect(extractRubric('RUBRIC:{"id":"x","criteria":[]}')).toBeUndefined();
    expect(extractRubric('RUBRIC:{"id":"x","criteria":[{"id":"a"}]}')).toBeUndefined();
    // A duplicate criterion id would make the grade ambiguous.
    expect(
      extractRubric('RUBRIC:{"id":"x","criteria":[{"id":"a","description":"d"},{"id":"a","description":"e"}]}'),
    ).toBeUndefined();
    // A passRatio of 0 passes everything — a rubric that certifies nothing.
    expect(extractRubric('RUBRIC:{"id":"x","criteria":[{"id":"a","description":"d"}],"passRatio":0}')).toBeUndefined();
  });

  it("defaults the scale and the bar consistently for prompt, parse and arithmetic", () => {
    const resolved = resolveRubric(RUBRIC);
    expect(resolved.maxScore).toBe(DEFAULT_RUBRIC_MAX_SCORE);
    expect(resolved.passRatio).toBe(0.8);
    expect(buildGraderPrompt("q", "a", RUBRIC)).toContain(`0 to ${DEFAULT_RUBRIC_MAX_SCORE}`);
  });
});

// ---------------------------------------------------------------------------
// Honest registration — a conditional verifier may not flip a doctor check
// ---------------------------------------------------------------------------

describe("conditional registration is reported honestly", () => {
  it("does NOT make `procedure` look better than it is when no grader exists", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const procedure = domainCertifiability(stack).find((c) => c.domain === "procedure")!;
    // Three are registered…
    expect(procedure.registered).toBe(3);
    // …but the rubric grader cannot vote here…
    expect(procedure.effective).toBe(2);
    // …and of the two that CAN vote, only one carries independent evidence:
    // `verify.procedure-run` is self-attested, so `../registry.ts` drops its
    // pass before counting voters. `effective >= 2` used to be enough to
    // report this domain as structurally certifiable, which was false — the
    // reachable outcome was always "degraded-evidence".
    expect(procedure.independent).toBe(1);
    expect(procedure.canEverCertify).toBe(false);
    expect(procedure.detail).toContain("degraded-evidence");
  });

  it("names EVERY reason the domain falls short, not just the first one", () => {
    // Two different failures apply at once here and reporting only the inert
    // grader would imply that waking it is sufficient — while a self-attested
    // co-voter still would not count. Both get named.
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const procedure = domainCertifiability(stack).find((c) => c.domain === "procedure")!;
    expect(procedure.canEverCertify).toBe(false);
    expect(procedure.detail).toContain("INERT here");
    expect(procedure.detail).toContain(GENRM_VERIFIER_ID);
    expect(procedure.detail).toContain("ANTHROPIC_API_KEY");
    expect(procedure.detail).toContain("self-attested");
    expect(procedure.detail).toContain("verify.procedure-run");
    // Variable NAMES, never values.
    expect(procedure.detail).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("passes `procedure` ONLY once a grader supplies the second independent voter", () => {
    const stack = openTrustStack({
      dataDir: tempDir(),
      env: noEnv,
      now: () => 0,
      rubricGrader: grader("anthropic", scoresJson(5, 5, 5)),
    });
    const procedure = domainCertifiability(stack).find((c) => c.domain === "procedure")!;
    expect(procedure.effective).toBe(3);
    // T1-reference + T2-genrm. `verify.procedure-run` is still counted out.
    expect(procedure.independent).toBe(2);
    expect(procedure.canEverCertify).toBe(true);
    expect(procedure.detail).toContain("self-attested");
    expect(procedure.detail).toContain("verify.procedure-run");
  });

  it("is listed as an unmet requirement naming the variables that would fix it", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const registered = stack.registry.list("procedure").find((v) => v.id === GENRM_VERIFIER_ID)!;
    expect(registered.tier).toBe("T2-genrm");
    expect(registered.requiresConfig?.()).toContain("ANTHROPIC_API_KEY");
  });

  it("updates the caveat once a grader is genuinely configured", () => {
    const stack = openTrustStack({
      dataDir: tempDir(),
      env: noEnv,
      now: () => 0,
      rubricGrader: grader("anthropic", scoresJson(5, 5, 5)),
    });
    const procedure = domainCertifiability(stack).find((c) => c.domain === "procedure")!;
    expect(procedure.effective).toBe(3);
    // The old sentence would now understate the build — the mirror image of
    // the overclaim the caveat exists to prevent.
    expect(procedure.detail).toContain("T2-genrm grader is configured");
    expect(procedure.detail).toContain("RUBRIC:");
    // …without pretending the step-manifest hole closed.
    expect(procedure.detail).toContain("degraded-evidence");
  });

  it("does not disturb the other domains' accounting", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const byDomain = new Map(domainCertifiability(stack).map((c) => [c.domain, c]));
    expect(byDomain.get("message")!.effective).toBe(1);
    expect(byDomain.get("message")!.canEverCertify).toBe(false);
    expect(byDomain.get("memory")!.canEverCertify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through the registry — the tier survives normalization
// ---------------------------------------------------------------------------

describe("through the real registry", () => {
  it("keeps its tier and its prior cap when fused", async () => {
    const stack = openTrustStack({
      dataDir: tempDir(),
      env: noEnv,
      now: () => 0,
      rubricGrader: grader("anthropic", scoresJson(5, 5, 5)),
    });
    const fused = await stack.registry.verify(subject("Release 4.2 shipped at 16:00 UTC."));
    const mine = fused.verdicts.find((v) => v.verifierId === GENRM_VERIFIER_ID)!;
    expect(mine).toBeDefined();
    expect(mine.tier).toBe("T2-genrm");
    expect(mine.abstained).toBe(false);
    expect(mine.passed).toBe(true);
    expect(mine.confidence).toBeLessThanOrEqual(GENRM_VERIFIER_PRIOR);
  });

  it("is simply absent from the vote when it has no grader", async () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const fused = await stack.registry.verify(subject("Release 4.2 shipped at 16:00 UTC."));
    const mine = fused.verdicts.find((v) => v.verifierId === GENRM_VERIFIER_ID);
    // Either not selected at all, or selected and abstained — never a vote.
    expect(mine === undefined || mine.abstained).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Independence: the grader must not be handed T1's answer key
// ---------------------------------------------------------------------------

describe("independence from T1-reference", () => {
  it("withholds SPEC: and REF: lines — the answer key never reaches the grader", async () => {
    const input = [
      'Reverse "Hello".',
      'SPEC:{"family":"transform","op":"reverse","text":"Hello"}',
      formatRubric(RUBRIC),
    ].join("\n");
    const rec = recordingGrader(scoresJson(5, 5, 5));
    const v = rubricGradeVerifier({ grader: rec.grader });
    await v.verify(subject("olleH", input));

    expect(rec.seen).toHaveLength(1);
    const seen = rec.seen[0];
    // The point of the whole exercise: a "second opinion" that has read the
    // first voter's source is not a second opinion.
    expect(seen.prompt).not.toContain("SPEC:");
    expect(seen.request).not.toContain("SPEC:");
    expect(seen.prompt).not.toContain('"op":"reverse"');
    // ...and the natural-language task is still there, so this restored
    // independence without narrowing coverage.
    expect(seen.request).toContain('Reverse "Hello".');
    expect(seen.prompt).toContain('Reverse "Hello".');
  });

  it("withholds a REF: declared rule too", async () => {
    const input = [
      "Extract every email address.",
      "alice@example.com and bob@test.org",
      'REF:{"rule":"extract-emails"}',
      formatRubric(RUBRIC),
    ].join("\n");
    const rec = recordingGrader(scoresJson(5, 5, 5));
    const v = rubricGradeVerifier({ grader: rec.grader });
    await v.verify(subject("alice@example.com,bob@test.org", input));
    expect(rec.seen[0].prompt).not.toContain("REF:");
    expect(rec.seen[0].request).not.toContain("extract-emails");
    // The material the task is ABOUT survives — only the rule is withheld.
    expect(rec.seen[0].request).toContain("alice@example.com");
  });

  it("withholds a MALFORMED reference line as well — conservative direction only", async () => {
    // T1 ignores an unparseable SPEC: line. Showing it to the grader anyway
    // would still hand over the operands, so it is withheld regardless.
    const input = ["Do the thing.", "SPEC:{not json at all", formatRubric(RUBRIC)].join("\n");
    const rec = recordingGrader(scoresJson(5, 5, 5));
    const v = rubricGradeVerifier({ grader: rec.grader });
    await v.verify(subject("done", input));
    expect(rec.seen[0].prompt).not.toContain("SPEC:");
  });

  it("pins the withheld prefixes against the canonical exports so they cannot drift", () => {
    // These two literals are duplicated inside `genrm-verifier.ts` ON PURPOSE:
    // importing the styx modules would put `computeSpec()` inside the grader
    // module's reach, and a rubric grader that can recompute the true answer is
    // a T1 wearing a T2 badge. The duplication is safe only while this holds.
    expect(withholdReferenceLines(`a\n${SPEC_PREFIX}{"x":1}\nb`).withheld).toBe(1);
    expect(withholdReferenceLines(`a\n${REF_PREFIX}{"rule":"r"}\nb`).withheld).toBe(1);
    expect(withholdReferenceLines(`a\n${SPEC_PREFIX}{"x":1}\nb`).text).toBe("a\nb");
    expect(withholdReferenceLines("a\nb").withheld).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Confidence is distance from the BAR, not from zero
// ---------------------------------------------------------------------------

describe("confidence margin", () => {
  it("gives a grade sitting exactly ON the pass bar no weight at all", async () => {
    // The rubric's bar is 80%. 4/5 on every criterion is exactly 80% — a pass
    // that discriminated nothing. Measuring the margin from ZERO reported this
    // as 0.8 of the prior; measuring it from the BAR reports the truth.
    const v = rubricGradeVerifier({ grader: grader("g", scoresJson(4, 4, 4)) });
    const verdict = await v.verify(subject("exactly at the bar"));
    expect(verdict.passed).toBe(true);
    expect(verdict.abstained).toBe(false);
    expect(verdict.confidence).toBe(0);
  });

  it("gives a perfect score the full prior and a total miss the full prior", async () => {
    const perfect = await rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 5)) }).verify(
      subject("perfect"),
    );
    expect(perfect.passed).toBe(true);
    expect(perfect.confidence).toBeCloseTo(GENRM_VERIFIER_PRIOR, 10);

    const miss = await rubricGradeVerifier({ grader: grader("g", scoresJson(0, 0, 0)) }).verify(
      subject("nothing"),
    );
    expect(miss.passed).toBe(false);
    expect(miss.confidence).toBeCloseTo(GENRM_VERIFIER_PRIOR, 10);
  });

  it("keeps a verdict near the bar weak on BOTH sides of it", async () => {
    // 11/15 = 73.3%, just under the 80% bar: a fail with barely any margin.
    const nearFail = await rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 1)) }).verify(
      subject("just under"),
    );
    expect(nearFail.passed).toBe(false);
    expect(nearFail.confidence).toBeGreaterThan(0);
    expect(nearFail.confidence).toBeLessThan(GENRM_VERIFIER_PRIOR / 2);

    // 13/15 = 86.7%, just over: a pass with barely any margin. Under the old
    // measure-from-zero formula this reported 0.867 of the prior — nearly the
    // same weight as a perfect score.
    const nearPass = await rubricGradeVerifier({ grader: grader("g", scoresJson(5, 5, 3)) }).verify(
      subject("just over"),
    );
    expect(nearPass.passed).toBe(true);
    expect(nearPass.confidence).toBeGreaterThan(0);
    expect(nearPass.confidence).toBeLessThan(GENRM_VERIFIER_PRIOR / 2);
  });

  it("never exceeds the prior for any grade in range", async () => {
    for (let a = 0; a <= 5; a++) {
      for (let b = 0; b <= 5; b++) {
        const verdict = await rubricGradeVerifier({ grader: grader("g", scoresJson(a, b, a)) }).verify(
          subject("x"),
        );
        expect(verdict.confidence).toBeGreaterThanOrEqual(0);
        expect(verdict.confidence).toBeLessThanOrEqual(GENRM_VERIFIER_PRIOR);
      }
    }
  });
});
