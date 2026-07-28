/**
 * The first STYX verifier above T4 — recompute-and-compare against a
 * machine-checkable reference carried in the task prompt.
 *
 * ## Why this exists
 *
 * Every previously registered verifier sat at `T4-consistency`, the weakest
 * rung of the tier ladder in `../styx/tiers.ts`. A T4 verifier can only ask
 * whether an answer is *shaped* like a good answer — well-formed, internally
 * agreeing, carrying the fields it should. It has no access to what the right
 * answer actually is, so a confidently-formatted WRONG answer passes it. That
 * is not a hypothetical: on a live run against a provider that returned a
 * fixed wrong answer, the gate certified every single one, and the lane's
 * silent-wrong count equalled the self-trusting baseline's.
 *
 * This verifier closes that hole for the class of work where truth is
 * decidable: tasks whose REQUEST carries a machine-checkable reference —
 * either an inline `SPEC:{json}` (see `../styx/reference-spec.ts`) or a
 * declared `REF:{"rule":…}` transform recomputed against the request text
 * (see `../styx/declared-rules.ts`). It resolves the reference out of the
 * REQUEST, recomputes the answer with real code, and compares. A mismatch is
 * a hard fail with near-certain confidence — not a soft signal to be out-voted
 * by three consistency checks that liked the formatting.
 *
 * ## The boundary: this verifier reads the REQUEST and nothing else
 *
 * It is handed a `TrustSubject` — domain, subjectId, taskId, input, output,
 * evidence, trace — and it reads exactly one field, `input`, plus the `output`
 * it is judging. It never receives the task object, its expected value or its
 * `grade()` closure, and there is no seam through which one could be passed:
 * `resolveReference` takes a string and returns a judge that closes over that
 * string alone.
 *
 * That boundary is the entire value of the check. A verifier that consulted
 * the grader would agree with the grader by construction — it would certify
 * nothing, because its verdict would carry no information the answer key did
 * not already have, and on any subject with no answer key (i.e. all of
 * production) it would have nothing to say. Recomputing from the request is
 * what makes a PASS mean "this answer is right", auditable months later by
 * anyone holding the request and the answer.
 *
 * The corollary, deliberately accepted: the reference must be carried by the
 * REQUEST, never by `evidence` or `trace`. Those are authored by whoever
 * produced the answer, and a verifier that let the answerer declare its own
 * success criterion certifies nothing either.
 *
 * ## Why the tier and prior are what they are
 *
 * `tier: "T1-reference"` — the ladder defines T1 as entailment against a
 * retrieved ground-truth source. For a deterministic task the prompt IS the
 * source and recomputation IS the entailment check, so this is a genuine T1,
 * not a T4 wearing a better label.
 *
 * `prior: 0.99`, not 1.0 — the recomputation is exact, but the *binding*
 * between spec and task is only as good as the harness that embedded it, and
 * a prior of 1.0 would let a single verifier assert certainty no evidence
 * chain can actually deliver. The registry treats `prior` as a hard ceiling
 * on every confidence emitted, so 0.99 keeps this verifier decisive without
 * making it infallible-by-declaration.
 *
 * ## Abstention is the default
 *
 * `appliesTo` returns false — and `verify` abstains — for any subject whose
 * input carries no well-formed spec. Most real work is not decidable this
 * way, and a verifier that guessed on undecidable subjects would be worse
 * than the T4 checks it supplements. Abstaining leaves the fused verdict to
 * whoever else voted, exactly as the registry intends.
 *
 * @module hades/trust/reference-verifier
 */

import { resolveReference } from "../styx/reference-spec";
import type { TrustSubject, UniversalVerdict, UniversalVerifier } from "./registry";

/** Registered id — stable, because calibration records are keyed by it. */
export const REFERENCE_VERIFIER_ID = "verify.reference-recompute";

/** See the module docs: exact math, imperfect binding. */
export const REFERENCE_VERIFIER_PRIOR = 0.99;

/**
 * Truncate a value for a reason string. Reasons are surfaced in CLI output
 * and bound into certificates, so an adversarially long "answer" must not be
 * able to flood them.
 */
function clip(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * Build the T1-reference verifier.
 *
 * @param domain Which trust domain to register under. The same recompute
 *   logic is valid for any domain whose subjects can carry a reference spec;
 *   the domain only decides which pool of voters this one joins.
 */
export function referenceRecomputeVerifier(domain: TrustSubject["domain"] = "procedure"): UniversalVerifier {
  return {
    id: REFERENCE_VERIFIER_ID,
    version: "1.0.0",
    domain,
    tier: "T1-reference",
    prior: REFERENCE_VERIFIER_PRIOR,

    /**
     * Only subjects whose REQUEST carries a reference that actually decides
     * them. A declared rule that recomputes nothing from this request (an
     * empty extraction, an item list it cannot parse) does NOT apply — see
     * `resolveReference`, which returns `undefined` in that case rather than
     * handing back an empty expectation any empty answer would match.
     */
    appliesTo(subject: TrustSubject): boolean {
      return resolveReference(subject.input) !== undefined;
    },

    verify(subject: TrustSubject): UniversalVerdict {
      const reference = resolveReference(subject.input);
      if (!reference) {
        // Not decidable by recomputation — cast no vote.
        return {
          verifierId: REFERENCE_VERIFIER_ID,
          version: "1.0.0",
          tier: "T1-reference",
          passed: false,
          confidence: 0,
          reasons: [
            "abstain:no-reference-spec",
            "the request carries no machine-checkable SPEC:/REF: reference that decides it",
          ],
          abstained: true,
        };
      }

      const passed = reference.matches(subject.output);

      return {
        verifierId: REFERENCE_VERIFIER_ID,
        version: "1.0.0",
        tier: "T1-reference",
        passed,
        confidence: REFERENCE_VERIFIER_PRIOR,
        reasons: passed
          ? [
              `reference-match:${reference.label}`,
              `recomputed ${reference.describe} from the request; the answer agrees`,
            ]
          : [
              `reference-mismatch:${reference.label}`,
              `recomputed "${clip(reference.expected)}" from the request (${reference.describe}), ` +
                `but the answer was "${clip(subject.output)}"`,
            ],
        abstained: false,
      };
    },
  };
}
