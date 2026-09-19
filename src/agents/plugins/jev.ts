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
import { approveCompanyAction } from "../jev/company";
import { classifyCommandFailure, decideCompaction, decideCompletion } from "../jev/decisions";
import { queueDecision } from "../jev/events";
import { screenExternal, screenOutput, scanMalicious, verifyCitation } from "../jev/guardrails";
import { heedPolicy, stopHook } from "../jev/hooks";
import { routeModel, routeSkill } from "../jev/router";
import { scoreQuality } from "../jev/scoring";
import { planAndRerankSearch } from "../jev/search";
import { judgePatch } from "../jev/symbolic";
import type { JevAsker, PolicyDecision, SkillRoute } from "../jev/types";
import type { AgentEvent, HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";

const DEFAULT_POLICIES = [
  "Do not exfiltrate secrets or private user data.",
  "Do not run destructive or production-changing actions without explicit authorization.",
  "Stay inside the user's stated request.",
];

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
  /** JevSlop quality score on the final draft. Default: true. */
  scoreQuality?: boolean;
  /** Foreman-style completion check. Default: true. */
  decideCompletion?: boolean;
  /** pi-heed policy lift/narrow on the user message. Default: true. */
  heedPolicy?: boolean;
  policies?: string[];
  /** Scan sandbox / file writes for hostile code. Default: true. */
  scanMalicious?: boolean;
  /** opencompany gate on deploy / payment / key tools. Default: true. */
  companyOs?: boolean;
  /** jev-code patch verdict on file_patch. Default: true. */
  judgePatch?: boolean;
  /** Citation check when search evidence is on the run. Default: true. */
  verifyCitations?: boolean;
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

function isCodeTool(name: string): boolean {
  return /sandbox_run|run_code|modal_run/i.test(name);
}

function isPatchTool(name: string): boolean {
  return /patch|apply_diff|apply_edit/i.test(name);
}

function isCompanyTool(name: string): boolean {
  return /deploy|composio|transfer|rotate|billing|prod/i.test(name);
}

function isBrowserTool(name: string): boolean {
  return /browser/i.test(name);
}

function extractCode(input: unknown): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  const rec = input as Record<string, unknown>;
  return String(rec.code ?? rec.source ?? rec.content ?? rec.diff ?? rec.patch ?? JSON.stringify(input)).slice(0, 8000);
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
  const doQuality = opts.scoreQuality !== false;
  const doCompletion = opts.decideCompletion !== false;
  const doHeed = opts.heedPolicy !== false;
  const doMalicious = opts.scanMalicious !== false;
  const doCompany = opts.companyOs !== false;
  const doPatch = opts.judgePatch !== false;
  const doCitations = opts.verifyCitations !== false;
  const policies = opts.policies ?? DEFAULT_POLICIES;
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
          failMode: "closed",
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

      if (doHeed && policies.length > 0) {
        const deltas = await heedPolicy({ message: userMessage, policies, asker, signal: input.signal });
        ctx.context.jevPolicyDeltas = deltas;
        const narrowed = deltas.filter((d) => d.delta === "NARROW");
        if (narrowed.length > 0) {
          emit(opts, { action: "review", value: "narrow", reason: "policy-narrowed", node: "heed" }, started, ctx);
        }
      }

      return userMessage;
    },

    async wrapTools(tools: ToolDefinition[], ctx: PluginRunContext, pending: Map<string, AgentEvent>) {
      if (!doAuto && !doRerank && !doMalicious && !doPatch && !doCompany) return tools;
      return tools.map((def) => {
        if (def.category === "jev") return def;
        return {
          ...def,
          execute: async (toolInput, toolCtx) => {
            const started = Date.now();
            const userRequest = String(ctx.context.lastUserMessage ?? "");
            const enforce = async (risk: PolicyDecision, guardName: string) => {
              emit(opts, risk, started, ctx);
              pending.set(`jev-${risk.node}-${def.name}-${started}`, {
                type: "jev_decision",
                node: risk.node,
                decision: String(risk.value),
                reason: risk.reason,
                action: risk.action,
                confidence: risk.confidence,
              });
              if (risk.action === "block") {
                throw new GuardrailBlockError(
                  `Jev blocked tool "${def.name}" (${risk.reason}).`,
                  risk.reason,
                  guardName
                );
              }
              if (risk.action === "review") {
                const { createApproval } = await import("../approvals");
                const { approvalId, promise } = createApproval({
                  runId: ctx.runId,
                  toolName: def.name,
                  input: toolInput,
                  description: `Jev: approve "${def.name}" (${risk.reason})`,
                });
                pending.set(approvalId, {
                  type: "approval_required",
                  runId: ctx.runId,
                  approvalId,
                  toolName: def.name,
                  input: toolInput,
                  description: `Jev: approve "${def.name}" (${risk.reason})`,
                });
                const approved = await promise;
                if (!approved) {
                  throw new GuardrailBlockError(
                    `Jev rejected tool "${def.name}" (${risk.reason}).`,
                    risk.reason,
                    guardName
                  );
                }
              }
            };

            if (doAuto) {
              await enforce(await assessToolRisk({
                userRequest,
                toolName: def.name,
                toolArguments: toolInput,
                asker,
                signal: ctx.signal,
                alwaysApprove: opts.alwaysApprove,
              }), "jev_auto_mode");
            }
            if (doMalicious && isCodeTool(def.name)) {
              await enforce(await scanMalicious({ code: extractCode(toolInput), asker, signal: ctx.signal }), "jev_malicious");
            }
            if (doPatch && isPatchTool(def.name)) {
              await enforce(await judgePatch({
                title: def.name,
                diff: extractCode(toolInput),
                asker,
                signal: ctx.signal,
              }), "jev_code");
            }
            if (doCompany && isCompanyTool(def.name)) {
              await enforce(await approveCompanyAction({
                userRequest,
                action: {
                  id: def.name,
                  description: def.description,
                  effects: `Tool ${def.name}`,
                  arguments: toolInput,
                },
                asker,
                signal: ctx.signal,
              }), "jev_company");
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
                const reranked = {
                  ...output,
                  results: plan.ranked.map((r) => ({
                    title: r.title,
                    url: r.source ?? r.id,
                    content: r.snippet,
                    score: r.relevance,
                  })),
                  jevSearch: { window: plan.window, sources: plan.sources },
                };
                ctx.context.jevEvidence = plan.ranked.map((r) => r.snippet).join("\n").slice(0, 6000);
                return reranked;
              }
            }

            if (isBrowserTool(def.name) && output && typeof output === "object") {
              const page = output as { text?: string; content?: string; url?: string };
              const text = String(page.text ?? page.content ?? "");
              if (text) {
                const pageScreen = await screenExternal({
                  content: text,
                  purpose: `browser page ${page.url ?? def.name}`,
                  asker,
                  signal: ctx.signal,
                  failMode: "closed",
                });
                emit(opts, pageScreen, started, ctx);
                if (pageScreen.action === "block") {
                  throw new GuardrailBlockError(
                    `Jev blocked scraped page content (${pageScreen.reason}).`,
                    pageScreen.reason,
                    "jev_browser"
                  );
                }
                ctx.context.jevEvidence = `${String(ctx.context.jevEvidence ?? "")}\n${text}`.slice(0, 6000);
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
      const goal = String(ctx.context.lastUserMessage ?? "");
      if (doStop && output) {
        const started = Date.now();
        const hook = await stopHook({ goal, finalMessage: output, asker });
        emit(opts, hook, started, ctx);
        ctx.context.jevStopHook = hook.action;
      }
      if (doCompletion && output) {
        const started = Date.now();
        const done = await decideCompletion({ goal, artifacts: output, asker });
        emit(opts, done, started, ctx);
        ctx.context.jevCompletion = done.value;
      }
      if (doQuality && output) {
        const started = Date.now();
        const quality = await scoreQuality({ text: output, asker });
        emit(opts, quality.decision, started, ctx);
        ctx.context.jevQuality = quality.label;
      }
      if (doCitations && output) {
        const evidence = String(ctx.context.jevEvidence ?? "");
        if (evidence.trim()) {
          const started = Date.now();
          const cited = await verifyCitation({
            claim: output.slice(0, 2000),
            evidence,
            asker,
          });
          emit(opts, cited, started, ctx);
          if (cited.action === "block") {
            throw new GuardrailBlockError(
              `Jev blocked the draft: it contradicts retrieved evidence (${cited.reason}).`,
              cited.reason,
              "jev_citation"
            );
          }
        }
      }
      return output;
    },
  };
}
