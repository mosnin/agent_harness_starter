/**
 * One System One call for every onAfterRun decision.
 * Output screen, stop-hook, completion, quality, and citations share state
 * and run in parallel instead of 4–5 sequential RTTs after Qwen finishes.
 */

import { SLOP_LEVELS } from "./catalog";
import { createJevAsker } from "./client";
import { interpretCitationAnswers, interpretOutputAnswers } from "./guardrails";
import { interpretGrounding, splitSentences, type GroundingResult } from "./ground";
import { interpretStopHook } from "./hooks";
import { interpretCompletion } from "./decisions";
import { decideUnavailable } from "./policy";
import { choice, noul, score } from "./questions";
import { hasSevereSecret, localSecretBlock } from "./redact";
import { interpretQuality, type QualityScore } from "./scoring";
import type { JevAsker, JevQuestions, JevState, PolicyDecision } from "./types";

const STOP_RULES = [
  "The user asked for a finished artifact but the reply is a plan or a question.",
  "Tests or verification the user required are missing.",
  "The reply claims success without evidence in the session.",
];

export interface PostflightInput {
  draft: string;
  userRequest: string;
  evidence?: string;
  asker?: JevAsker;
  signal?: AbortSignal;
  screenOutput?: boolean;
  stopHook?: boolean;
  completion?: boolean;
  quality?: boolean;
  citations?: boolean;
  grounding?: boolean;
  strict?: boolean;
}

export interface PostflightResult {
  asks: number;
  screen: PolicyDecision;
  stop?: PolicyDecision;
  completion?: PolicyDecision;
  quality?: QualityScore;
  citation?: PolicyDecision;
  grounding?: GroundingResult;
  abstain?: string;
}

export async function runPostflight(input: PostflightInput): Promise<PostflightResult> {
  const doScreen = input.screenOutput !== false;
  if (doScreen && (hasSevereSecret(input.draft) || hasSevereSecret(input.userRequest))) {
    return { asks: 0, screen: localSecretBlock("screen_output") };
  }
  const asker = input.asker ?? createJevAsker();
  const doStop = input.stopHook !== false;
  const doCompletion = input.completion !== false;
  const doQuality = input.quality !== false;
  const evidence = (input.evidence ?? "").trim();
  const doCite = input.citations !== false && evidence.length > 0;
  const doGround = input.grounding !== false;
  const sentences = doGround ? splitSentences(input.draft) : [];

  const questions: JevQuestions = {};
  if (doScreen) {
    questions.secret_leak = noul("Does `draft` leak secrets, API keys, or private user data?");
    questions.policy_violation = noul("Does `draft` violate a safety, legal, or product policy?");
    questions.answers_question = noul("Does `draft` actually answer `user_request`?");
    questions.unverified_claims = noul("Does `draft` make factual claims that are not grounded in the available state?");
  }
  if (doStop) {
    for (const [i, rule] of STOP_RULES.entries()) {
      questions[`r${i}`] = noul(`Does the visible reply violate this stop rule: ${rule}`);
    }
  }
  if (doCompletion) {
    questions.requirements_satisfied = noul("Have the requirements in `user_request` been satisfied by `draft`?");
    questions.needs_verification = noul("Should we run more verification before finishing?");
    questions.ready_to_finish = noul("Is it correct to stop and report completion now?");
  }
  if (doQuality) {
    questions.slop = score("How much AI-slop does `draft` exhibit (generic filler, hedging, ungrounded claims)?", SLOP_LEVELS);
    questions.grounded = noul("Are the claims in `draft` grounded in stated evidence or a clear caveat?");
    questions.specific = noul("Is `draft` specific to the user's situation rather than generic advice?");
  }
  if (doCite) {
    questions.support = choice("Does `evidence` support the claims in `draft`?", {
      supports: "The evidence directly supports the claim.",
      contradicts: "The evidence contradicts the claim.",
      says_nothing: "The evidence is silent on the claim.",
    });
  }
  if (doGround) {
    questions.invented_numbers = noul(
      "Does `draft` invent specific numbers, dates, or quantities that are not in `evidence`?"
    );
    questions.invented_sources = noul(
      "Does `draft` invent citations, URLs, file paths, or source names that are not in `evidence`?"
    );
    questions.needs_abstain = noul(
      "Should we refuse to ship `draft` because it guesses facts instead of using `evidence` or saying we do not know?"
    );
    for (const [i, sentence] of sentences.entries()) {
      questions[`g${i}`] = noul(
        `Sentence ${i} of \`sentences\` makes a factual claim that \`evidence\` does not support (invented number, source, or outcome). False if it is a question, hedge, instruction, or clearly supported. Sentence: ${sentence.slice(0, 280)}`
      );
    }
  }

  if (Object.keys(questions).length === 0) {
    return {
      asks: 0,
      screen: { action: "auto", value: "pass", reason: "skipped", node: "screen_output" },
    };
  }

  const asked = await asker.ask(
    {
      state: {
        draft: input.draft.slice(0, 8000),
        user_request: input.userRequest.slice(0, 2000),
        evidence: evidence.slice(0, 6000),
        sentences,
        rules: STOP_RULES,
      } as JevState,
      questions,
    },
    input.signal
  );

  if (!asked.ok) {
    return {
      asks: 1,
      screen: doScreen
        ? decideUnavailable("screen_output", "unsafe", "closed")
        : { action: "auto", value: "pass", reason: "skipped", node: "screen_output" },
      citation: doCite ? decideUnavailable("citation_verify", "says_nothing", "closed") : undefined,
    };
  }

  const answers = asked.result.answers;
  const grounding = doGround
    ? interpretGrounding(answers, {
        draft: input.draft,
        evidence,
        sentences,
        strict: input.strict,
      })
    : undefined;
  return {
    asks: 1,
    screen: doScreen
      ? interpretOutputAnswers(answers)
      : { action: "auto", value: "pass", reason: "skipped", node: "screen_output" },
    stop: doStop ? interpretStopHook(answers, STOP_RULES.length) : undefined,
    completion: doCompletion ? interpretCompletion(answers) : undefined,
    quality: doQuality ? interpretQuality(answers) : undefined,
    citation: doCite ? interpretCitationAnswers(answers) : undefined,
    grounding,
    abstain: grounding?.abstain,
  };
}
