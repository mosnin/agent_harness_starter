/**
 * Jev policy for the Hades desktop sidecar.
 *
 * The Tauri window never talks to Qwen or Jev directly. It sends a Command
 * to the Node sidecar; this module decides whether that command may touch
 * the machine (record, patch, export) before any binary runs.
 *
 * Read-only inspect hops fail open. Every write (capture, edit, export)
 * fails closed when Jev is down.
 */

import { createJevAsker } from "./client";
import { GATES, decideChoice, decideUnavailable } from "./policy";
import { choice, noul } from "./questions";
import type { JevAsker, PolicyDecision } from "./types";
import { requireChoice, requireNoul } from "./validate";

export const DESKTOP_WRITE_ACTIONS = [
  "record_start",
  "record_stop",
  "project_patch",
  "editor_open",
  "export",
] as const;

export const DESKTOP_READ_ACTIONS = [
  "targets",
  "record_status",
  "project_get",
  "project_validate",
] as const;

export type DesktopWriteAction = (typeof DESKTOP_WRITE_ACTIONS)[number];
export type DesktopReadAction = (typeof DESKTOP_READ_ACTIONS)[number];
export type DesktopAction = DesktopWriteAction | DesktopReadAction;

export function isDesktopWrite(action: string): action is DesktopWriteAction {
  return (DESKTOP_WRITE_ACTIONS as readonly string[]).includes(action);
}

export function isDesktopRead(action: string): action is DesktopReadAction {
  return (DESKTOP_READ_ACTIONS as readonly string[]).includes(action);
}

export function isDesktopAction(action: string): action is DesktopAction {
  return isDesktopWrite(action) || isDesktopRead(action);
}

/** Sidecar executes a desktop write only on a confident auto / allow. */
export function shouldExecuteDesktop(decision: { action: string; value: unknown }): boolean {
  return decision.action === "auto" && (decision.value === "allow" || decision.value === "auto");
}

export async function assessDesktopAction(input: {
  action: string;
  args?: unknown;
  userRequest?: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  if (isDesktopRead(input.action)) {
    return {
      action: "auto",
      value: "allow",
      reason: "desktop-read",
      node: "desktop_action",
    };
  }
  if (!isDesktopWrite(input.action)) {
    return {
      action: "block",
      value: input.action,
      reason: "unknown-desktop-action",
      node: "desktop_action",
    };
  }

  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        action: input.action,
        args: serialize(input.args),
        user_request: (input.userRequest ?? "").slice(0, 2000),
      },
      questions: {
        verdict: choice("May Hades run this desktop write on the local machine?", {
          allow: "Authorized, in scope, and not capturing secrets or overwriting the user's work.",
          review: "A human should confirm before the sidecar touches capture, the project, or disk.",
          block: "Unsafe, out of scope, or likely to leak what is on screen.",
        }),
        leaks_screen: noul("Would starting or exporting this capture likely include secrets, passwords, or private messages?"),
      },
    },
    input.signal
  );
  if (!asked.ok) {
    return decideUnavailable("desktop_action", "block", "closed");
  }
  const leaks = requireNoul(asked.result.answers, "leaks_screen");
  if (leaks >= 0.7) {
    return {
      action: "block",
      value: "block",
      reason: "desktop-screen-secrets",
      node: "desktop_action",
      answers: asked.result.answers,
    };
  }
  const verdict = requireChoice(asked.result.answers, "verdict");
  if (verdict.choice === "block") {
    return {
      action: "block",
      value: "block",
      reason: "desktop-blocked",
      node: "desktop_action",
      answers: asked.result.answers,
      confidence: verdict.confidence,
    };
  }
  const decided = decideChoice("desktop_action", verdict, GATES.verification, "review");
  if (decided.action === "auto" && verdict.choice === "allow") {
    return { ...decided, value: "allow", answers: asked.result.answers };
  }
  return {
    action: "review",
    value: verdict.choice,
    reason: decided.reason === "jev" ? "desktop-needs-confirm" : decided.reason,
    node: "desktop_action",
    answers: asked.result.answers,
    confidence: verdict.confidence,
  };
}

function serialize(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  } catch {
    return String(value);
  }
}
