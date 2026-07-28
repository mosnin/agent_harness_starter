/**
 * The annotation proof: every `reference` on a real eval task must be TRUE.
 *
 * A declared rule (`../../styx/declared-rules`) claims "this task's answer is
 * what this transform computes from this prompt". That claim is exactly the
 * kind of thing that is easy to get subtly wrong — annotate a task whose
 * prompt happens to contain an extra number, or whose normalization differs
 * from what the prose asks for, and the T1-reference verifier starts REJECTING
 * correct answers on the real corpus while looking like it works.
 *
 * So every annotation is proved here, against the one authority on correctness
 * the corpus ships: the task's own `grade()`. This test file is the ONLY place
 * in the repo where a declared rule and a grader meet. The verifier itself
 * never sees a grader — it is handed a `TrustSubject` and reads the request
 * text — which is what makes its verdict worth anything. Proving the
 * annotation here and forbidding it there is the whole design:
 *
 *   - here (once, offline, in CI): does the rule agree with the answer key?
 *   - there (every verdict, in production): does the answer agree with the
 *     rule, recomputed from the request?
 *
 * If the first ever fails, the annotation is wrong and must be removed or
 * fixed — not "tuned" until it passes.
 */
import { describe, it, expect } from "vitest";
import { EVAL_TASKS, referenceAnnotatedTasks } from "../eval-suite";
import {
  computeDeclaredReference,
  extractDeclaredReference,
  DECLARED_RULE_IDS,
} from "../../styx/declared-rules";

/**
 * The split, pinned. Not a vanity number: it is here so that ADDING an
 * annotation is a deliberate act with a visible diff, and so that a future
 * refactor cannot quietly widen the verifier's reach past what has been
 * proved. See the module note in `eval-suite.ts` for why the other tasks are
 * deliberately left alone.
 */
const EXPECTED_ANNOTATED = 19;
/** The rest, left alone on purpose — see "the unannotated remainder" below. */
const EXPECTED_UNANNOTATED = 29;

describe("corpus reference annotations are true", () => {
  it("annotates exactly the tasks that have been proved decidable", () => {
    const annotated = referenceAnnotatedTasks();
    expect(annotated.length).toBe(EXPECTED_ANNOTATED);
    expect(EVAL_TASKS.filter((t) => !t.reference).length).toBe(EXPECTED_UNANNOTATED);
    expect(EVAL_TASKS.length).toBe(EXPECTED_ANNOTATED + EXPECTED_UNANNOTATED);
  });

  for (const task of referenceAnnotatedTasks()) {
    it(`${task.id}: the declared rule recomputes an answer its own grade() accepts`, () => {
      const reference = task.reference;
      expect(reference).toBeDefined();
      if (!reference) return;

      // The rule sees the prompt and nothing else — the same input the
      // verifier will have in production.
      const recomputed = computeDeclaredReference(reference, task.prompt);
      expect(recomputed).toBeDefined();
      expect(recomputed).not.toBe("");

      // …and the corpus's own ground truth agrees it is a correct answer.
      expect(task.grade(recomputed as string)).toBe(true);
    });
  }
});

describe("the declaration reaches the verifier through the request", () => {
  it("renders every annotation into its own prompt, with no drift", () => {
    for (const task of referenceAnnotatedTasks()) {
      // The prompt's REF: line and the task field are the same declaration —
      // one is derived from the other, so they cannot disagree. If this ever
      // failed, an agent and its verifier would be reading different questions.
      expect(extractDeclaredReference(task.prompt)).toEqual(task.reference);
    }
  });

  it("leaves unannotated prompts free of any reference", () => {
    for (const task of EVAL_TASKS) {
      if (task.reference) continue;
      expect(extractDeclaredReference(task.prompt)).toBeUndefined();
    }
  });

  it("uses only rules this build implements", () => {
    for (const task of referenceAnnotatedTasks()) {
      expect(DECLARED_RULE_IDS).toContain(task.reference?.rule);
    }
  });
});

describe("the unannotated remainder is deliberate", () => {
  /**
   * Named categories, not a count, so the reason survives a corpus edit. Each
   * of these is undecidable from the prompt by any deterministic rule:
   * classification and reasoning need judgement, transformation answers are
   * JSON documents whose value types are declared in prose, arithmetic word
   * problems would each need their own single-use operand scraper, and
   * `multi-07-capital` needs world knowledge (which country a city is in).
   */
  it("leaves every judgement-bound category untouched", () => {
    const annotatedCategories = new Set(referenceAnnotatedTasks().map((t) => t.category));
    for (const category of ["classification", "reasoning", "transformation", "arithmetic"]) {
      expect(annotatedCategories.has(category)).toBe(false);
    }
  });

  it("leaves the one multi-part task that needs world knowledge unannotated", () => {
    const capital = EVAL_TASKS.find((t) => t.id === "multi-07-capital");
    expect(capital).toBeDefined();
    expect(capital?.reference).toBeUndefined();
  });
});
