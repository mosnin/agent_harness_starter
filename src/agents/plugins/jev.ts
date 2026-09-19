/**
 * withJev — harness plugin that puts Jev on the critical path.
 *
 * LangChain equivalent:
 *   ModelRouterMiddleware  → onBeforeRun picks a Qwen route
 *   AutoModeMiddleware     → wrapTools blocks/reviews risky calls
 * plus input/output screens, skill routing, stop-hooks, search rerank.
 */

import { GuardrailBlockError, GuardrailHumanReviewError } from "../guardrails/types";
import { recordDecision } from "../jev/audit";
import { assessToolRisk } from "../jev/auto-mode";
import { createJevAsker } from "../jev/client";
import { DEFAULT_HADES_SKILLS } from "../jev/catalog";
import { classifyCommandFailure, decideCompaction } from "../jev/decisions";
import { queueDecision } from "../jev/events";
import { screenExternal, screenOutput } from "../jev/guardrails";
import { stopHook } from "../jev/hooks";
import { routeModel, routeSkill } from "../jev/router";
import { planAndRerankSearch } from "../jev/search";
import type { JevAsker, PolicyDecision, SkillRoute } from "../jev/types";
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
  /** Route a specialist skill when `skills` is set. Default: true if skills provided. */
  routeSkills?: boolean;
  skills?: SkillRoute[];
  /** Limpet-style stop-hook on the final draft. Default: true. */
  stopHook?: boolean;
  /** Compact long threads when token pressure is high. Default: true. */
  compact?: boolean;
  /** Rerank web_search results with Jev. Default: true. */
  rerankSearch?: boolean;
  /** Wrap tools with Auto Mode. Default: true. */
  autoMode?: boolean;
  /** Tool names that always require HITL. */
  alwaysApprove?: string[];
  /** Called whenever Jev makes a decision (tests / UI). */
  onDecision?: (decision: PolicyDecision) => void;
}

function emit(opts: JevPluginOptions, decision: PolicyDecision, started: number, ctx?: PluginRunContext): void {
  recordDecision(decision, Date.now() - started);
  opts.onDecision?.(decision);
  if (ctx) queueDecision(ctx, decision);
}

function isSearchTool(name: string): boolean {
  return /search|tavily/i.test(name);
}

function isShellTool(name: string): boolean {
  return /shell|exec|bash|sandbox/i.test(name);
}

export function withJev(opts: JevPluginOptions = {}): HarnessPlugin {
  const asker = opts.asker ?? createJevAsker();
  const screenIn = opts.screenInput !== false;
  const screenOut = opts.screenOutput !== false;
  const doRoute = opts.routeModel !== false;
  const doAuto = opts.autoMode !== false;
  const doStop = opts.stopHook !== false;
  const doCompact = opts.compact !== false;
  const doRerank = opts.rerankSearch !== false;
  const skills = opts.skills ?? [];
  const doSkills = opts.routeSkills !== false && skills.length > 0;

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
        emit(opts, screened, started, ctx);
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

      if (doCompact && (input.messages?.length ?? 0) >= 8) {
        const chars = input.messages.reduce((n, m) => n + m.content.length, 0);
        const compact = await decideCompaction({
          tokenEstimate: Math.ceil(chars / 4),
          tokenLimit: 128_000,
          asker,
          signal: input.signal,
        });
        emit(opts, compact, started, ctx);
        ctx.context.jevCompaction = compact.value;
      }

      if (doRoute) {
        const routed = await routeModel({
          message: userMessage,
          currentRoute: typeof ctx.context.hadesRoute === "string" ? ctx.context.hadesRoute : "balanced",
          previousAssistantReply: input.messages?.filter((m) => m.role === "assistant").at(-1)?.content,
          asker,
          signal: input.signal,
        });
        emit(opts, routed, started, ctx);
        ctx.context.hadesRoute = routed.tier ?? routed.value;
        ctx.context.hadesModel = routed.model;
        ctx.context.jevRouting = routed;
      }

      if (doSkills) {
        const skill = await routeSkill({
          message: userMessage,
          skills: [...skills, ...DEFAULT_HADES_SKILLS.filter((s) => s.id.startsWith("__"))],
          asker,
          signal: input.signal,
        });
        emit(opts, skill, started, ctx);
        ctx.context.hadesSkill = skill.value;
      }

      return userMessage;
    },

    async wrapTools(tools: ToolDefinition[], ctx: PluginRunContext, pending: Map<string, AgentEvent>) {
      if (!doAuto && !doRerank) return tools;
      return tools.map((def) => {
        if (def.category === "jev") return def;
        return {
          ...def,
          execute: async (toolInput, toolCtx) => {
            const started = Date.now();
            const userRequest = String(ctx.context.lastUserMessage ?? "");
            if (doAuto) {
              const risk = await assessToolRisk({
                userRequest,
                toolName: def.name,
                toolArguments: toolInput,
                asker,
                signal: ctx.signal,
                alwaysApprove: opts.alwaysApprove,
              });
              emit(opts, risk, started, ctx);
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
            }

            const output = await def.execute(toolInput, toolCtx);

            if (doRerank && isSearchTool(def.name) && output && typeof output === "object" && "results" in output) {
              const raw = output as { results: Array<{ title?: string; url?: string; content?: string; snippet?: string }> };
              if (Array.isArray(raw.results) && raw.results.length > 1) {
                const plan = await planAndRerankSearch({
                  request: userRequest || String((toolInput as { query?: string }).query ?? ""),
                  results: raw.results.map((r, i) => ({
                    id: r.url ?? String(i),
                    title: r.title,
                    snippet: (r.content ?? r.snippet ?? "").slice(0, 400),
                    source: r.url,
                  })),
                  asker,
                  signal: ctx.signal,
                });
                return {
                  ...output,
                  results: plan.ranked.map((r) => ({
                    title: r.title,
                    url: r.source ?? r.id,
                    content: r.snippet,
                    score: r.relevance,
                  })),
                  jevSearch: { window: plan.window, sources: plan.sources },
                };
              }
            }

            if (isShellTool(def.name) && output && typeof output === "object") {
              const rec = output as { stderr?: string; exitCode?: number; error?: string; stdout?: string };
              const failed = (rec.exitCode !== undefined && rec.exitCode !== 0) || Boolean(rec.error) || Boolean(rec.stderr);
              if (failed) {
                const classified = await classifyCommandFailure({
                  command: String((toolInput as { command?: string }).command ?? def.name),
                  output: String(rec.stderr ?? rec.error ?? rec.stdout ?? "").slice(0, 2000),
                  asker,
                  signal: ctx.signal,
                });
                emit(opts, classified, started, ctx);
                if (classified.action === "block") {
                  throw new GuardrailBlockError(
                    `Jev blocked repeating this command output (${classified.reason}).`,
                    classified.reason,
                    "jev_command_failure"
                  );
                }
                return { ...output, jevFailure: classified };
              }
            }

            return output;
          },
        };
      });
    },

    async onAfterRun(finalOutput, ctx) {
      let output = finalOutput;
      if (screenOut) {
        const started = Date.now();
        const screened = await screenOutput({
          draft: output,
          userRequest: String(ctx.context.lastUserMessage ?? ""),
          asker,
        });
        emit(opts, screened, started, ctx);
        if (screened.action === "block") {
          throw new GuardrailBlockError(
            `Jev blocked the agent output (${screened.reason}).`,
            screened.reason,
            "jev_output"
          );
        }
      }
      if (doStop && output) {
        const started = Date.now();
        const hook = await stopHook({
          goal: String(ctx.context.lastUserMessage ?? ""),
          finalMessage: output,
          asker,
        });
        emit(opts, hook, started, ctx);
        ctx.context.jevStopHook = hook.action;
      }
      return output;
    },
  };
}
