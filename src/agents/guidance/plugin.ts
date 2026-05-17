import type { HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition, ToolContext } from "../tools/types";
import type { PolicyBundle, GateContext, GateResult } from "./types";
import {
  destructiveOpsGate,
  secretsGate,
  toolAllowlistGate,
  diffSizeGate,
  aggregateGateResults,
} from "./gates";
import { compileGuidance } from "./compiler";
import type { CompilerOptions } from "./compiler";

export interface GuidancePluginOptions {
  /** Path options for CLAUDE.md files. Defaults to cwd. */
  compiler?: CompilerOptions;
  /** Tool names that are allowed. Empty = no restriction. */
  allowedTools?: string[];
  /** Max lines per edit before warning. Default: 300 */
  maxEditLines?: number;
  /** If true, log violations but don't block. Default: false */
  auditOnly?: boolean;
  /** Called on every gate result that isn't "allow" */
  onViolation?: (result: GateResult, ctx: GateContext) => void;
}

export function withGuidance(options?: GuidancePluginOptions): HarnessPlugin {
  const allowedTools = options?.allowedTools ?? [];
  const maxEditLines = options?.maxEditLines ?? 300;
  const auditOnly = options?.auditOnly ?? false;
  const onViolation = options?.onViolation;

  // Bundle is loaded in onBeforeRun and shared via closure
  let bundle: PolicyBundle | null = null;

  return {
    name: "guidance",

    async onBeforeRun(
      userMessage: string,
      _ctx: PluginRunContext,
      _input: import("../types").RunInput
    ): Promise<string> {
      bundle = await compileGuidance(options?.compiler);
      const count = bundle.rules.length;
      const constitutionCount = bundle.constitutionRules.length;
      console.log(
        `[guidance] Policy compiled: ${count} rule(s) (${constitutionCount} constitution), hash=${bundle.hash}`
      );
      return userMessage;
    },

    async wrapTools(
      tools: ToolDefinition[],
      ctx: PluginRunContext,
      _pendingEvents: Map<string, import("../types").AgentEvent>
    ): Promise<ToolDefinition[]> {
      return tools.map((tool) => ({
        ...tool,
        execute: async (input: unknown, toolCtx: ToolContext) => {
          const rules = bundle?.rules ?? [];

          const gateCtx: GateContext = {
            toolName: tool.name,
            toolArgs: input,
            runId: ctx.runId,
          };

          const gateResults: GateResult[] = [];

          // Always run secrets gate
          gateResults.push(secretsGate(gateCtx, rules));

          // Always run allowlist gate
          gateResults.push(toolAllowlistGate(gateCtx, allowedTools, rules));

          // Run destructive ops gate for bash/shell tools
          if (tool.name === "bash" || tool.name === "shell") {
            const command =
              typeof input === "object" &&
              input !== null &&
              "command" in input
                ? String((input as Record<string, unknown>).command)
                : typeof input === "string"
                ? input
                : undefined;
            gateResults.push(
              destructiveOpsGate({ ...gateCtx, command }, rules)
            );
          }

          // Run diff size gate if editContent is present
          const editContent =
            typeof input === "object" &&
            input !== null &&
            "content" in input
              ? String((input as Record<string, unknown>).content)
              : typeof input === "object" &&
                input !== null &&
                "new_string" in input
              ? String((input as Record<string, unknown>).new_string)
              : undefined;

          if (editContent !== undefined) {
            gateResults.push(
              diffSizeGate({ ...gateCtx, editContent }, maxEditLines, rules)
            );
          }

          const aggregate = aggregateGateResults(gateResults);

          if (aggregate.decision !== "allow") {
            onViolation?.(aggregate, gateCtx);
          }

          if (aggregate.decision === "block") {
            if (!auditOnly) {
              throw new Error(
                `[guidance] Tool "${tool.name}" blocked: ${aggregate.reason}${
                  aggregate.remediation ? ` — ${aggregate.remediation}` : ""
                }`
              );
            } else {
              console.warn(
                `[guidance] AUDIT: Tool "${tool.name}" would be blocked: ${aggregate.reason}`
              );
            }
          } else if (aggregate.decision === "require-confirmation") {
            console.warn(
              `[guidance] WARNING: Tool "${tool.name}" requires confirmation: ${aggregate.reason}${
                aggregate.remediation ? ` — ${aggregate.remediation}` : ""
              }`
            );
          } else if (aggregate.decision === "warn") {
            console.warn(
              `[guidance] Tool "${tool.name}" warning: ${aggregate.reason}${
                aggregate.remediation ? ` — ${aggregate.remediation}` : ""
              }`
            );
          }

          return tool.execute(input, toolCtx);
        },
      }));
    },
  };
}
