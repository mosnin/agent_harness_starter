/**
 * Stop-hook (limpet/abide), pi-heed policy deltas, git-risk (jev-git).
 */

import { createJevAsker } from "./client";
import { NOUL, decideUnavailable } from "./policy";
import { choice, noul } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireChoice, requireNoul } from "./validate";

export async function stopHook(input: {
  goal: string;
  finalMessage: string;
  rules?: string[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const rules = input.rules ?? [
    "The user asked for a finished artifact but the reply is a plan or a question.",
    "Tests or verification the user required are missing.",
    "The reply claims success without evidence in the session.",
  ];
  const asker = input.asker ?? createJevAsker();
  const questions = Object.fromEntries(
    rules.map((rule, i) => [`r${i}`, noul(`Does the visible reply violate this stop rule: ${rule}`)])
  );
  const asked = await asker.ask(
    {
      state: {
        goal: input.goal.slice(0, 2000),
        final_message: input.finalMessage.slice(0, 4000),
        rules,
      } as JevState,
      questions,
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("stop_hook", "allow", "open");
  return interpretStopHook(asked.result.answers, rules.length);
}

export function interpretStopHook(answers: import("./types").JevAnswers, ruleCount: number): PolicyDecision {
  for (let i = 0; i < ruleCount; i++) {
    const value = requireNoul(answers, `r${i}`);
    if (value >= NOUL.stopHook) {
      return { action: "review", value: "block_stop", reason: `rule-${i}`, node: "stop_hook", answers, probability: value };
    }
  }
  return { action: "auto", value: "allow", reason: "clean", node: "stop_hook", answers };
}

export async function heedPolicy(input: {
  message: string;
  policies: string[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<Array<{ policy: string; delta: string }>> {
  if (input.policies.length === 0) return [];
  const asker = input.asker ?? createJevAsker();
  const questions = Object.fromEntries(
    input.policies.map((p, i) => [
      `d${i}`,
      choice(`What should happen to policy[${i}] given \`message\`?`, {
        KEEP: "Leave the policy unchanged.",
        LIFT: "The user is relaxing this restriction.",
        NARROW: "The user is tightening this restriction.",
        UNKNOWN: "The message is unrelated.",
      }),
    ])
  );
  const asked = await asker.ask(
    { state: { message: input.message.slice(0, 2000), policies: input.policies } as JevState, questions },
    input.signal
  );
  if (!asked.ok) return [];
  return interpretHeedAnswers(asked.result.answers, input.policies);
}

export function interpretHeedAnswers(
  answers: import("./types").JevAnswers,
  policies: string[]
): Array<{ policy: string; delta: string }> {
  return policies.map((policy, i) => {
    const ans = answers[`d${i}`];
    const delta = ans?.type === "choice" && ans.confidence >= 0.8 ? ans.choice : "KEEP";
    return { policy, delta };
  });
}

export async function assessGitRisk(input: {
  command: string;
  userRequest: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { command: input.command.slice(0, 500), user_request: input.userRequest.slice(0, 2000) },
      questions: {
        force_push: noul("Is this a force-push or history rewrite?"),
        unrecoverable: noul("Would this git command drop unrecoverable work?"),
        authorized: noul("Did `user_request` authorize this exact git action?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("jev_git", "review", "closed");
  return interpretGitRisk(asked.result.answers);
}

export function interpretGitRisk(answers: import("./types").JevAnswers, prefix = ""): PolicyDecision {
  const force = requireNoul(answers, `${prefix}force_push`);
  const unrecoverable = requireNoul(answers, `${prefix}unrecoverable`);
  const authorized = requireNoul(answers, `${prefix}authorized`);
  if (force >= 0.7 || unrecoverable >= 0.7) {
    return { action: "review", value: "git", reason: "dangerous-git", node: "jev_git", answers };
  }
  if (authorized >= 0.7) {
    return { action: "auto", value: "git", reason: "authorized-git", node: "jev_git", answers };
  }
  return { action: "review", value: "git", reason: "unconfirmed-git", node: "jev_git", answers };
}

export async function classifyVoiceIntent(input: {
  transcript: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { transcript: input.transcript.slice(0, 2000) },
      questions: {
        intent: choice("What should Hades do with this voice transcript?", {
          execute_now: "Clear, actionable task.",
          clarify: "Too ambiguous — ask a short clarifying question.",
          out_of_scope: "Cancel / never mind / not an agent task.",
          unsafe: "Would require a dangerous or disallowed action.",
        }),
      },
    },
    input.signal
  );
  if (!asked.ok) {
    return { action: "review", value: "clarify", reason: "jev-unavailable", node: "voice_intent" };
  }
  const pick = requireChoice(asked.result.answers, "intent");
  if (pick.choice === "unsafe") {
    return { action: "block", value: "unsafe", reason: "unsafe-voice", node: "voice_intent", answers: asked.result.answers };
  }
  if (pick.choice === "execute_now" && pick.confidence >= 0.85) {
    return { action: "auto", value: "execute_now", reason: "jev", node: "voice_intent", answers: asked.result.answers, confidence: pick.confidence };
  }
  return { action: "review", value: pick.choice, reason: "voice-clarify", node: "voice_intent", answers: asked.result.answers, confidence: pick.confidence };
}
