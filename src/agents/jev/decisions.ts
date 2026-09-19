/**
 * Agent-loop decisions — quiet-ask, compaction, completion, browser step,
 * command-failure classification (jev-judgment, pi-quiet-ask, limpet,
 * jev-ultrafast, pi-fast-jev-compaction, foreman).
 */

import { createJevAsker } from "./client";
import { GATES, NOUL, decideChoice, decideUnavailable, passesGate } from "./policy";
import { choice, noul, score } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireChoice, requireNoul, requireScore } from "./validate";

export async function quietAsk(input: {
  question: string;
  options: Record<string, string>;
  userRequest: string;
  facts?: string[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  if (Object.keys(input.options).length < 2) {
    throw new Error("quietAsk: options must include at least two choices");
  }
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        user_request: input.userRequest.slice(0, 4000),
        question: input.question,
        facts: (input.facts ?? []).slice(0, 20),
      } as JevState,
      questions: {
        pick: choice("Given `user_request` and `facts`, which option answers `question`?", {
          ...input.options,
          ask_user: "Not enough evidence — ask the user.",
        }),
        determined: noul("Is the answer to `question` determined by the available evidence without guessing?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("quiet_ask", "ask_user", "review");

  const pick = requireChoice(asked.result.answers, "pick");
  const determined = requireNoul(asked.result.answers, "determined");
  if (pick.choice === "ask_user") {
    return { action: "review", value: "ask_user", reason: "ask-user", node: "quiet_ask", answers: asked.result.answers };
  }
  if (passesGate(pick, GATES.quietAskAuto) && determined >= 0.9) {
    return { action: "auto", value: pick.choice, reason: "determined", node: "quiet_ask", answers: asked.result.answers, confidence: pick.confidence };
  }
  if ((pick.probabilities[pick.choice] ?? 0) >= 0.5) {
    return { action: "review", value: pick.choice, reason: "suggest", node: "quiet_ask", answers: asked.result.answers, confidence: pick.confidence };
  }
  return { action: "review", value: "ask_user", reason: "undetermined", node: "quiet_ask", answers: asked.result.answers };
}

export async function decideCompletion(input: {
  goal: string;
  artifacts?: string;
  tests?: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        original_goal: input.goal.slice(0, 2000),
        artifacts: (input.artifacts ?? "").slice(0, 4000),
        test_results: (input.tests ?? "").slice(0, 2000),
      } as JevState,
      questions: {
        requirements_satisfied: noul("Have the requirements in `original_goal` been satisfied by `artifacts`?"),
        needs_verification: noul("Should we run more verification before finishing?"),
        ready_to_finish: noul("Is it correct to stop and report completion now?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("task_complete", "continue", "open");
  return interpretCompletion(asked.result.answers);
}

export function interpretCompletion(answers: import("./types").JevAnswers): PolicyDecision {
  const ready = requireNoul(answers, "ready_to_finish");
  const requirements = requireNoul(answers, "requirements_satisfied");
  const verify = requireNoul(answers, "needs_verification");
  if (ready >= NOUL.finish && requirements >= NOUL.requirements && verify < NOUL.needsVerification) {
    return { action: "auto", value: "finish", reason: "ready", node: "task_complete", answers };
  }
  return { action: "review", value: "continue", reason: "not-ready", node: "task_complete", answers };
}

export async function decideCompaction(input: {
  tokenEstimate: number;
  tokenLimit: number;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const pressure = input.tokenLimit > 0 ? input.tokenEstimate / input.tokenLimit : 0;
  if (pressure < 0.55) {
    return { action: "auto", value: "keep", reason: "under-budget", node: "compaction" };
  }
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { token_estimate: input.tokenEstimate, token_limit: input.tokenLimit, pressure },
      questions: {
        strategy: score("How aggressively should we compact this conversation?", [
          "Keep all turns; budget is fine",
          "Summarize the middle, keep recent turns and facts",
          "Aggressive summarize; only keep the goal and open blockers",
        ]),
      },
    },
    input.signal
  );
  if (!asked.ok) {
    return { action: "auto", value: pressure > 0.85 ? "aggressive" : "summarize", reason: "budget-heuristic", node: "compaction" };
  }
  const scored = requireScore(asked.result.answers, "strategy");
  const value = scored.score < 0.75 ? "keep" : scored.score < 1.5 ? "summarize" : "aggressive";
  return { action: "auto", value, reason: "jev", node: "compaction", answers: asked.result.answers };
}

export async function classifyCommandFailure(input: {
  command: string;
  output: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { command: input.command.slice(0, 500), output: input.output.slice(0, 2000), is_error: true },
      questions: {
        leaks_secret: noul("Does `output` contain a secret that must not be repeated?"),
        failure_class: choice("What kind of failure is this?", {
          no_failure: "The command actually succeeded or the output is not an error.",
          transient: "Retrying the same command is likely to work.",
          environment: "Missing tool, network, or environment setup.",
          code_bug: "The program or script is wrong.",
          permission: "Auth or filesystem permission denied.",
          user_error: "The user asked for something invalid.",
        }),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("command_failure", "environment", "closed");
  const leaks = requireNoul(asked.result.answers, "leaks_secret");
  if (leaks >= NOUL.secretLeak) {
    return { action: "block", value: "secret", reason: "leaks-secret", node: "command_failure", answers: asked.result.answers };
  }
  const classified = requireChoice(asked.result.answers, "failure_class");
  return { ...decideChoice("command_failure", classified, GATES.routing, "environment"), answers: asked.result.answers };
}

export async function decideBrowserStep(input: {
  task: string;
  elements: Array<{ id: string; type: string; label: string }>;
  pageText?: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const elementCriteria = Object.fromEntries([
    ...input.elements.slice(0, 40).map((el) => [el.id, `${el.type}: ${el.label}`]),
    ["none", "No visible element matches the next action."],
  ]);
  const asked = await asker.ask(
    {
      state: {
        task: input.task.slice(0, 2000),
        elements: input.elements.slice(0, 40),
        page_text: (input.pageText ?? "").slice(0, 3000),
      } as JevState,
      questions: {
        action: choice("What should the browser agent do next?", {
          CLICK: "Click a visible element.",
          TYPE_TEXT: "Type into a field. Generation fills the text separately.",
          NAVIGATE: "Go to a URL.",
          EXTRACT: "Read visible text and stop acting.",
          DONE: "The task is complete.",
          BLOCKED: "Cannot proceed (login wall, captcha, missing element).",
        }),
        target: choice("Which element is the target of the next action? Use none if not applicable.", elementCriteria),
        goal_done: noul("Has `task` already been completed on this page?"),
        stuck: noul("Is the agent stuck in a loop or unable to make progress?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("browser_step", "BLOCKED", "closed");
  const done = requireNoul(asked.result.answers, "goal_done");
  const stuck = requireNoul(asked.result.answers, "stuck");
  if (done >= NOUL.goalDone) {
    return { action: "auto", value: "DONE", reason: "goal-done", node: "browser_step", answers: asked.result.answers };
  }
  if (stuck >= NOUL.stuck) {
    return { action: "review", value: "BLOCKED", reason: "stuck", node: "browser_step", answers: asked.result.answers };
  }
  const action = requireChoice(asked.result.answers, "action");
  return { ...decideChoice("browser_step", action, GATES.routing, "BLOCKED"), answers: asked.result.answers };
}

export async function judge(input: {
  decision: string;
  evidence: string;
  candidates: Record<string, string>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { decision: input.decision, evidence: input.evidence.slice(0, 6000) },
      questions: {
        recommendation: choice("Given `evidence`, what should we do about `decision`?", {
          ...input.candidates,
          ask_user: "Not enough evidence — ask the user.",
          investigate: "Need more evidence before deciding.",
        }),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("judgment", "investigate", "review");
  return { ...decideChoice("judgment", requireChoice(asked.result.answers, "recommendation"), GATES.classification, "investigate"), answers: asked.result.answers };
}
