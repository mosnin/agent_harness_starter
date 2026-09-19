/**
 * withJev — harness plugin that puts Jev on the critical path.
 *
 * LangChain equivalent:
 *   ModelRouterMiddleware  → onBeforeRun picks a Qwen route
 *   AutoModeMiddleware     → wrapTools blocks/reviews risky calls
 * plus input/output screens from safer-with-jev / jev_screen.
 */

import { GuardrailBlockError, GuardrailHumanReviewError } from "../guardrails/types";
import { recordDecision } from "../jev/audit";
import { assessToolRisk } from "../jev/auto-mode";
import { createJevAsker } from "../jev/client";
import { screenExternal, screenOutput } from "../jev/guardrails";
import { routeModel } from "../jev/router";
import type { JevAsker, PolicyDecision } from "../jev/types";
import type { AgentEvent, HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";

export interface JevPluginOptions {
  asker?: JevAsker;
  /** Screen the user message for injection / secrets. Default: true. */
  screenInput?: boolean;
  /** Screen the final draft. Default: true. */
  screenOutput?: boolean;
  /** Route the generation model via Jev. Default: true. */
  routeModel?: boolean;
  /** Wrap tools with Auto Mode. Default: true. */
  autoMode?: boolean;
  /** Tool names that always require HITL. */
  alwaysApprove?: string[];
  /** Called whenever Jev makes a decision (tests / UI). */
  onDecision?: (decision: PolicyDecision) => void;
}

function emit(opts: JevPluginOptions, decision: PolicyDecision, started: number): void {
  recordDecision(decision, Date.now() - started);
  opts.onDecision?.(decision);
}

export function withJev(opts: JevPluginOptions = {}): HarnessPlugin {
  const asker = opts.asker ?? createJevAsker();
  const screenIn = opts.screenInput !== false;
  const screenOut = opts.screenOutput !== false;
  const doRoute = opts.routeModel !== false;
  const doAuto = opts.autoMode !== false;

  return {
    name: "jev",

    async onBeforeRun(userMessage, ctx, input) {
      const started = Date.now();
      ctx.context.lastUserMessage = userMessage;
      if (screenIn) {
        const screened = await screenExternal({
          content: userMessage,
          purpose: `Hades agent ${ctx.agentName}`,
          asker,
          signal: input.signal,
        });
        emit(opts, screened, started);
        if (screened.action === "block") {
          throw new GuardrailBlockError(
            `Jev blocked this message (${screened.reason}).`,
            screened.reason,
            "jev_screen"
          );
        }
        if (screened.action === "review" && (screened.value === "injection" || screened.value === "secret")) {
          throw new GuardrailHumanReviewError(
            `Jev flagged this message for review (${screened.reason}).`,
            screened.reason,
            screened
          );
        }
      }

      if (doRoute) {
        const routed = await routeModel({
          message: userMessage,
          currentRoute: typeof ctx.context.hadesRoute === "string" ? ctx.context.hadesRoute : "balanced",
          asker,
          signal: input.signal,
        });
        emit(opts, routed, started);
        ctx.context.hadesRoute = routed.tier ?? routed.value;
        ctx.context.hadesModel = routed.model;
        ctx.context.jevRouting = routed;
      }

      return userMessage;
    },

    async wrapTools(tools: ToolDefinition[], ctx: PluginRunContext, pending: Map<string, AgentEvent>) {
      if (!doAuto) return tools;
      return tools.map((def) => {
        if (def.category === "jev") return def;
        return {
          ...def,
          execute: async (toolInput, toolCtx) => {
            const started = Date.now();
            const userRequest = String(ctx.context.lastUserMessage ?? "");
            const risk = await assessToolRisk({
              userRequest,
              toolName: def.name,
              toolArguments: toolInput,
              asker,
              signal: ctx.signal,
              alwaysApprove: opts.alwaysApprove,
            });
            emit(opts, risk, started);
            pending.set(`jev-auto-${def.name}-${started}`, {
              type: "jev_decision",
              node: risk.node,
              decision: String(risk.value),
              reason: risk.reason,
              action: risk.action,
              confidence: risk.confidence,
            });
            if (risk.action === "block") {
              throw new GuardrailBlockError(
                `Jev Auto Mode blocked tool "${def.name}" (${risk.reason}).`,
                risk.reason,
                "jev_auto_mode"
              );
            }
            if (risk.action === "review") {
              const { createApproval } = await import("../approvals");
              const { approvalId, promise } = createApproval({
                runId: ctx.runId,
                toolName: def.name,
                input: toolInput,
                description: `Jev Auto Mode: approve "${def.name}" (${risk.reason})`,
              });
              pending.set(approvalId, {
                type: "approval_required",
                runId: ctx.runId,
                approvalId,
                toolName: def.name,
                input: toolInput,
                description: `Jev Auto Mode: approve "${def.name}" (${risk.reason})`,
              });
              const approved = await promise;
              if (!approved) {
                throw new GuardrailBlockError(
                  `Jev Auto Mode rejected tool "${def.name}" (${risk.reason}).`,
                  risk.reason,
                  "jev_auto_mode"
                );
              }
            }
            return def.execute(toolInput, toolCtx);
          },
        };
      });
    },

    async onAfterRun(finalOutput, ctx) {
      if (!screenOut) return finalOutput;
      const started = Date.now();
      const screened = await screenOutput({
        draft: finalOutput,
        userRequest: String(ctx.context.lastUserMessage ?? ""),
        asker,
      });
      emit(opts, screened, started);
      if (screened.action === "block") {
        throw new GuardrailBlockError(
          `Jev blocked the agent output (${screened.reason}).`,
          screened.reason,
          "jev_output"
        );
      }
      return finalOutput;
    },
  };
}
