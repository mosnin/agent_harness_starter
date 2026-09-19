/**
 * Symbolic supervisors — Foreman (worker observation) + jev-code (patch judgment).
 * Added here as first-class Hades decision nodes, not generation.
 */

import { createJevAsker } from "./client";
import { NOUL, decideUnavailable } from "./policy";
import { choice, noul, score } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireChoice, requireNoul, requireScore } from "./validate";

export interface ForemanObservation {
  goal: string;
  workerNotes: string;
  diffSummary?: string;
  tests?: string;
}

export interface ForemanVerdict {
  decision: PolicyDecision;
  flags: {
    complete: number;
    stuck: number;
    offTrack: number;
    needsHuman: number;
    readyToFinish: number;
    needsVerification: number;
  };
}

export async function superviseWorker(input: ForemanObservation & { asker?: JevAsker; signal?: AbortSignal }): Promise<ForemanVerdict> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        goal: input.goal.slice(0, 2000),
        worker_notes: input.workerNotes.slice(0, 4000),
        diff_summary: (input.diffSummary ?? "").slice(0, 3000),
        tests: (input.tests ?? "").slice(0, 2000),
      } as JevState,
      questions: {
        implementation_complete: noul("Has the worker finished the implementation described in `goal`?"),
        tests_sufficient: noul("Are the tests in `tests` sufficient for the change?"),
        requirements_satisfied: noul("Do `worker_notes` and `diff_summary` satisfy `goal`?"),
        needs_verification: noul("Should a verifier run before we accept this work?"),
        meaningful_progress: noul("Did the worker make meaningful progress this turn?"),
        worker_stuck: noul("Is the worker stuck or looping?"),
        work_off_track: noul("Has the worker gone off track relative to `goal`?"),
        ready_to_finish: noul("Is it correct to accept the work and stop?"),
        needs_human: noul("Should a human take over?"),
      },
    },
    input.signal
  );

  if (!asked.ok) {
    return {
      decision: decideUnavailable("foreman", "continue", "review"),
      flags: { complete: 0, stuck: 0, offTrack: 0, needsHuman: 1, readyToFinish: 0, needsVerification: 1 },
    };
  }

  const flags = {
    complete: requireNoul(asked.result.answers, "implementation_complete"),
    stuck: requireNoul(asked.result.answers, "worker_stuck"),
    offTrack: requireNoul(asked.result.answers, "work_off_track"),
    needsHuman: requireNoul(asked.result.answers, "needs_human"),
    readyToFinish: requireNoul(asked.result.answers, "ready_to_finish"),
    needsVerification: requireNoul(asked.result.answers, "needs_verification"),
  };

  let decision: PolicyDecision;
  if (flags.needsHuman >= 0.8 || flags.offTrack >= 0.8 || flags.stuck >= 0.8) {
    decision = { action: "review", value: "escalate", reason: "foreman-escalate", node: "foreman", answers: asked.result.answers };
  } else if (flags.readyToFinish >= NOUL.finish && flags.complete >= 0.8 && flags.needsVerification < 0.65) {
    decision = { action: "auto", value: "accept", reason: "foreman-accept", node: "foreman", answers: asked.result.answers };
  } else {
    decision = { action: "auto", value: "continue", reason: "foreman-continue", node: "foreman", answers: asked.result.answers };
  }
  return { decision, flags };
}

export async function judgePatch(input: {
  title: string;
  diff: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { title: input.title, diff: input.diff.slice(0, 8000) },
      questions: {
        correctness: noul("Does `diff` look like it introduces a correctness bug?"),
        security: noul("Does `diff` introduce a security issue?"),
        test_gap: noul("Is `diff` missing tests that it should include?"),
        verdict: choice("What should happen to this patch?", {
          approve_with_nits: "Safe to merge with minor notes.",
          request_changes: "Needs changes before merge.",
          block: "Must not merge.",
        }),
        risk: score("Overall merge risk", [
          "Trivial and well tested",
          "Ordinary change with residual risk",
          "Risky: large blast radius or weak tests",
          "Dangerous: likely to break production or security",
        ]),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("jev_code", "request_changes", "review");
  const verdict = requireChoice(asked.result.answers, "verdict");
  const security = requireNoul(asked.result.answers, "security");
  const risk = requireScore(asked.result.answers, "risk");
  if (verdict.choice === "block" || security >= 0.65 || risk.score >= 2.5) {
    return { action: "block", value: "block", reason: "patch-unsafe", node: "jev_code", answers: asked.result.answers };
  }
  if (verdict.choice === "request_changes" || verdict.confidence < 0.55) {
    return { action: "review", value: "request_changes", reason: "patch-needs-work", node: "jev_code", answers: asked.result.answers };
  }
  return { action: "auto", value: "approve_with_nits", reason: "patch-ok", node: "jev_code", answers: asked.result.answers };
}
