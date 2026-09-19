/**
 * Auto Mode — LangChain AutoModeMiddleware + jev-judgment + opencompany.
 *
 * Jev checks a pending tool call for destructive, exfiltration, and
 * beyond-scope risk *before* the tool executes. Code owns the thresholds.
 */

import { IMPACT_LEVELS } from "./catalog";
import { createJevAsker } from "./client";
import { interpretGitRisk } from "./hooks";
import { NOUL, SCORE, decideUnavailable } from "./policy";
import { noul, score } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireNoul, requireScore } from "./validate";

function looksLikeGit(toolName: string, args: unknown): boolean {
  if (/git/i.test(toolName)) return true;
  if (!args || typeof args !== "object") return false;
  const rec = args as Record<string, unknown>;
  const command = String(rec.command ?? rec.cmd ?? "");
  const extra = Array.isArray(rec.args) ? rec.args.map(String).join(" ") : "";
  return /\bgit\b/i.test(`${command} ${extra}`);
}

function extractCommand(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const rec = args as Record<string, unknown>;
  const command = String(rec.command ?? rec.cmd ?? "");
  const extra = Array.isArray(rec.args) ? rec.args.map(String).join(" ") : "";
  return `${command} ${extra}`.trim() || JSON.stringify(args).slice(0, 500);
}

export interface AutoModeInput {
  userRequest: string;
  toolName: string;
  toolArguments: unknown;
  cwd?: string;
  asker?: JevAsker;
  signal?: AbortSignal;
  /** Extra tools that always require HITL regardless of Jev. */
  alwaysApprove?: string[];
}

function serializeArgs(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(value);
  }
}

const SAFE_READ_TOOLS = new Set([
  "file_read",
  "read_file",
  "list_dir",
  "list_files",
  "memory_search",
  "web_search",
  "browser_snapshot",
  "targets",
  "record_status",
  "project_get",
  "project_validate",
]);

/** Read-only inspect hops skip System One. Writes still go through Auto Mode. */
export function isSafeReadTool(toolName: string): boolean {
  return SAFE_READ_TOOLS.has(toolName);
}

export async function assessToolRisk(input: AutoModeInput): Promise<PolicyDecision> {
  if (input.alwaysApprove?.includes(input.toolName)) {
    return {
      action: "review",
      value: input.toolName,
      reason: "always-approve-list",
      node: "auto_mode",
    };
  }

  if (isSafeReadTool(input.toolName) && !looksLikeGit(input.toolName, input.toolArguments)) {
    return {
      action: "auto",
      value: input.toolName,
      reason: "safe-read",
      node: "auto_mode",
    };
  }

  const asker = input.asker ?? createJevAsker();
  const gitLike = looksLikeGit(input.toolName, input.toolArguments);

  const asked = await asker.ask(
    {
      state: {
        user_request: input.userRequest.slice(0, 4000),
        cwd: input.cwd ?? "",
        tool: input.toolName,
        arguments: serializeArgs(input.toolArguments),
        command: gitLike ? extractCommand(input.toolArguments) : "",
      } as JevState,
      questions: {
        ...(gitLike
          ? {
              git_force_push: noul("Is this a force-push or history rewrite?"),
              git_unrecoverable: noul("Would this git command drop unrecoverable work?"),
              git_authorized: noul("Did `user_request` authorize this exact git action?"),
            }
          : {}),
        destructive: noul(
          "Would executing `tool` with `arguments` destroy or irreversibly alter user data, files, or infrastructure?",
          {
            true: "rm, drop, reset --hard, overwrite production, or wipe state",
            false: "Read-only or easily reversible",
          }
        ),
        exfiltration: noul(
          "Would this call leak secrets, private data, or credentials outside the trusted boundary?",
          {
            true: "Posts secrets, dumps .env, emails private data, or writes keys to a public sink",
            false: "Stays inside the allowed workspace or redacts secrets",
          }
        ),
        beyond_scope: noul(
          "Is this tool call beyond what `user_request` authorized?",
          {
            true: "Different target, broader blast radius, or a new goal the user did not ask for",
            false: "A reasonable step toward the stated request",
          }
        ),
        impact: score("If this call goes wrong, how bad is the impact?", IMPACT_LEVELS),
        authorized: noul("Did the user authorize this class of action in `user_request`?"),
        routine: noul("Is this a routine, low-surprise action for this kind of request?"),
      },
    },
    input.signal
  );

  if (!asked.ok) {
    return decideUnavailable("auto_mode", input.toolName, "closed");
  }

  return interpretToolRisk(asked.result.answers, input.toolName, gitLike);
}

export function interpretToolRisk(
  answers: import("./types").JevAnswers,
  toolName: string,
  gitLike = false
): PolicyDecision {
  if (gitLike && answers.git_force_push) {
    const git = interpretGitRisk(answers, "git_");
    if (git.action !== "auto") return git;
  }
  const destructive = requireNoul(answers, "destructive");
  const exfiltration = requireNoul(answers, "exfiltration");
  const beyondScope = requireNoul(answers, "beyond_scope");
  const impact = requireScore(answers, "impact");
  const authorized = requireNoul(answers, "authorized");
  const routine = requireNoul(answers, "routine");

  if (destructive >= NOUL.destructive) {
    return { action: "block", value: toolName, reason: "destructive", node: "auto_mode", answers, probability: destructive };
  }
  if (exfiltration >= NOUL.exfiltration) {
    return { action: "block", value: toolName, reason: "exfiltration", node: "auto_mode", answers, probability: exfiltration };
  }
  if (beyondScope >= NOUL.beyondScope) {
    return { action: "review", value: toolName, reason: "beyond-scope", node: "auto_mode", answers, probability: beyondScope };
  }
  if (impact.score >= SCORE.impactHitl && impact.confidence >= 0.5) {
    return { action: "review", value: toolName, reason: "high-impact", node: "auto_mode", answers, confidence: impact.confidence };
  }
  if (authorized >= NOUL.authorized && routine >= NOUL.routine) {
    return { action: "auto", value: toolName, reason: "routine-authorized", node: "auto_mode", answers };
  }
  return { action: "review", value: toolName, reason: "not-routine", node: "auto_mode", answers };
}
