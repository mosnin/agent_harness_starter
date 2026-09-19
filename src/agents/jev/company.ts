/**
 * Company OS approvals — opencompany pattern.
 * Jev decides whether a named company action is authorized and routine.
 */

import { createJevAsker } from "./client";
import { NOUL, decideUnavailable } from "./policy";
import { noul } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireNoul } from "./validate";

export interface CompanyAction {
  id: string;
  description: string;
  effects: string;
  arguments?: unknown;
}

export const ALWAYS_HITL = new Set(["deploy_prod", "wire_transfer", "delete_account", "rotate_keys"]);

export function isAlwaysHitlCompany(actionId: string): boolean {
  return ALWAYS_HITL.has(actionId);
}

export async function approveCompanyAction(input: {
  userRequest: string;
  action: CompanyAction;
  priorRequests?: string[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  if (ALWAYS_HITL.has(input.action.id)) {
    return { action: "review", value: input.action.id, reason: "ineligible-always-approve", node: "company_os" };
  }

  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        userRequest: input.userRequest.slice(0, 2000),
        priorUserRequests: (input.priorRequests ?? []).slice(0, 8),
        action: {
          id: input.action.id,
          description: input.action.description,
          effects: input.action.effects,
        },
        arguments: JSON.stringify(input.action.arguments ?? {}).slice(0, 1500),
      } as JevState,
      questions: {
        authorized: noul("Did the user authorize this company action in `userRequest`?"),
        routine: noul("Is this a routine, in-policy action for this company OS?"),
      },
    },
    input.signal
  );

  if (!asked.ok) return decideUnavailable("company_os", input.action.id, "closed");
  return interpretCompanyAnswers(asked.result.answers, input.action.id);
}

export function interpretCompanyAnswers(answers: import("./types").JevAnswers, actionId: string): PolicyDecision {
  const authorized = requireNoul(answers, "authorized");
  const routine = requireNoul(answers, "routine");
  if (authorized >= NOUL.authorized && routine >= NOUL.routine) {
    return { action: "auto", value: actionId, reason: "routine-authorized", node: "company_os", answers };
  }
  return { action: "review", value: actionId, reason: "needs-approval", node: "company_os", answers };
}
