/**
 * T3-agreement — cross-model agreement between independent model families.
 *
 * The STYX ladder (`../styx/tiers.ts`) places T3-agreement above
 * T4-consistency because it introduces an *independent* opinion: a second
 * model family, which does not share the first one's failure modes, is asked
 * whether the output actually follows from the request. It sits below
 * T1-reference (`./reference-verifier.ts`) because agreement is evidence,
 * not proof — two models can be wrong together, which is exactly why the
 * prior is capped well short of certainty.
 *
 * ## Where this applies
 *
 * Unlike T1-reference, agreement needs no decidable ground truth, so it
 * covers the large majority of real work — summaries, outbound messages,
 * explanations — where nothing can be recomputed. That is precisely the
 * domain (`message`) that shipped a single voter and therefore could never
 * certify anything at all.
 *
 * ## Honesty: this verifier is CONDITIONAL, and says so
 *
 * Cross-model agreement requires models. With no judges configured, this
 * verifier cannot vote — and rather than quietly abstaining and letting the
 * surfaces imply its domain has two working voters, it reports an unmet
 * requirement through {@link UniversalVerifier.requiresConfig}. `hades trust
 * doctor` counts EFFECTIVE voters, so a domain that only reaches two
 * verifiers when a key is present is reported as not-yet-certifiable, naming
 * the exact environment variables that would fix it.
 *
 * A judge that errors or answers unintelligibly is dropped rather than
 * counted as agreement: silence is never a yes.
 *
 * @module hades/trust/agreement-verifier
 */

import type { TrustSubject, UniversalVerdict, UniversalVerifier } from "./registry";

export const AGREEMENT_VERIFIER_ID = "verify.cross-model-agreement";

/**
 * Agreement is evidence, not proof — two models sharing a training-data
 * blind spot agree confidently and wrongly. The prior caps every verdict
 * this verifier can emit.
 */
export const AGREEMENT_VERIFIER_PRIOR = 0.85;

/** The env vars that can supply a judge, in the order the rest of the CLI checks them. */
export const AGREEMENT_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * One independent judge. Returns whether the output follows from the request.
 * Deliberately a narrow seam — the verifier does not care whether the judge
 * is an HTTP model client, a local model, or a test double.
 */
export type AgreementJudge = {
  /** Human-readable family name, e.g. "anthropic". Used in reasons. */
  readonly family: string;
  judge(subject: TrustSubject, signal?: AbortSignal): Promise<boolean | undefined>;
};

export interface AgreementVerifierOptions {
  /** Independent judges. Fewer than two means no agreement can be measured. */
  judges?: readonly AgreementJudge[];
  /** Domain to register under. Defaults to `message`. */
  domain?: TrustSubject["domain"];
  /**
   * Fraction of responding judges that must agree for a pass. Default 1.0 —
   * unanimity. A split vote is not a pass: the point of a second opinion is
   * that disagreement blocks, otherwise it is decoration.
   */
  threshold?: number;
}

/** Minimum judges for the word "agreement" to mean anything. */
const MIN_JUDGES = 2;

function abstain(reason: string, detail: string): UniversalVerdict {
  return {
    verifierId: AGREEMENT_VERIFIER_ID,
    version: "1.0.0",
    tier: "T3-agreement",
    passed: false,
    confidence: 0,
    reasons: [reason, detail],
    abstained: true,
  };
}

/**
 * Build the T3-agreement verifier.
 *
 * With fewer than {@link MIN_JUDGES} judges the verifier is *inert but
 * honest*: `requiresConfig` reports what is missing, `appliesTo` returns
 * false, and `verify` abstains. It never manufactures a vote it cannot back.
 */
export function crossModelAgreementVerifier(opts: AgreementVerifierOptions = {}): UniversalVerifier {
  const judges = opts.judges ?? [];
  const threshold = opts.threshold ?? 1;
  const enoughJudges = judges.length >= MIN_JUDGES;

  return {
    id: AGREEMENT_VERIFIER_ID,
    version: "1.0.0",
    domain: opts.domain ?? "message",
    tier: "T3-agreement",
    prior: AGREEMENT_VERIFIER_PRIOR,

    /**
     * Names the unmet requirement (variable NAMES only, never values) so the
     * doctor can report an honest effective-voter count instead of implying
     * this verifier is participating when it cannot.
     */
    requiresConfig(): string | undefined {
      if (enoughJudges) return undefined;
      return (
        `cross-model agreement needs ${MIN_JUDGES} independent judges but ${judges.length} are configured — ` +
        `set ${AGREEMENT_KEY_VARS.join(" or ")} to enable it`
      );
    },

    appliesTo(subject: TrustSubject): boolean {
      return enoughJudges && typeof subject.output === "string" && subject.output.trim().length > 0;
    },

    async verify(subject: TrustSubject): Promise<UniversalVerdict> {
      if (!enoughJudges) {
        return abstain(
          "abstain:no-judges",
          `only ${judges.length} judge(s) configured; cross-model agreement needs ${MIN_JUDGES}`,
        );
      }
      if (typeof subject.output !== "string" || subject.output.trim().length === 0) {
        return abstain("abstain:empty-output", "there is no output to seek agreement about");
      }

      // A judge that throws or returns undefined did not vote. Dropping it is
      // load-bearing: counting a failed call as agreement would turn an
      // outage into a certification.
      const votes: Array<{ family: string; agrees: boolean }> = [];
      const silent: string[] = [];
      for (const judge of judges) {
        let agrees: boolean | undefined;
        try {
          agrees = await judge.judge(subject);
        } catch {
          agrees = undefined;
        }
        if (agrees === undefined) silent.push(judge.family);
        else votes.push({ family: judge.family, agrees });
      }

      if (votes.length < MIN_JUDGES) {
        return abstain(
          "abstain:insufficient-responses",
          `only ${votes.length} judge(s) answered (${silent.join(", ") || "none"} did not) — ` +
            "silence is not agreement",
        );
      }

      const agreeing = votes.filter((v) => v.agrees);
      const ratio = agreeing.length / votes.length;
      const passed = ratio >= threshold;

      return {
        verifierId: AGREEMENT_VERIFIER_ID,
        version: "1.0.0",
        tier: "T3-agreement",
        passed,
        // Confidence tracks how lopsided the vote was, capped by the prior.
        confidence: Math.min(AGREEMENT_VERIFIER_PRIOR, AGREEMENT_VERIFIER_PRIOR * ratio),
        reasons: passed
          ? [
              `agreement:${agreeing.length}/${votes.length}`,
              `independent judges (${agreeing.map((v) => v.family).join(", ")}) agree the output follows from the request`,
            ]
          : [
              `disagreement:${agreeing.length}/${votes.length}`,
              `judges split — ${votes
                .filter((v) => !v.agrees)
                .map((v) => v.family)
                .join(", ")} did not agree the output follows from the request`,
            ],
        abstained: false,
      };
    },
  };
}
