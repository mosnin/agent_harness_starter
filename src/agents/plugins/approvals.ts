/**
 * Approvals plugin — wraps specified tools with a human-in-the-loop gate.
 * The tool execution pauses and emits an `approval_required` event; the run
 * resumes only after POST /api/agent/[runId]/approve is called.
 *
 * Usage:
 *   import { withApprovals } from "@/agents/plugins/approvals";
 *
 *   const harness = createCustomHarness({
 *     name: "MyAgent",
 *     instructions: "...",
 *     plugins: [withApprovals({ requireApprovalFor: ["delete_file", "send_email"] })],
 *   });
 */

import type { HarnessPlugin, AgentEvent, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";

export interface ApprovalsPluginOptions {
  /**
   * Tool names that require explicit approval before execution.
   * Also applies to any tool with requiresApproval: true on its definition.
   */
  requireApprovalFor?: string[];
}

export function withApprovals(opts: ApprovalsPluginOptions = {}): HarnessPlugin {
  const requireSet = new Set(opts.requireApprovalFor ?? []);

  return {
    name: "approvals",

    async wrapTools(
      tools: ToolDefinition[],
      ctx: PluginRunContext,
      pendingEvents: Map<string, AgentEvent>
    ): Promise<ToolDefinition[]> {
      const { createApproval } = await import("../approvals");

      return tools.map((def) => {
        if (!requireSet.has(def.name) && !def.requiresApproval) return def;

        return {
          ...def,
          execute: async (input: unknown, toolCtx: import("../tools/types").ToolContext) => {
            const { approvalId, promise } = createApproval({
              runId: ctx.runId,
              toolName: def.name,
              input,
              description: `Approve "${def.name}" tool call`,
            });

            // Push into the side-channel; the streaming loop drains it each iteration
            pendingEvents.set(approvalId, {
              type: "approval_required",
              runId: ctx.runId,
              approvalId,
              toolName: def.name,
              input,
              description: `Approve "${def.name}" tool call`,
            });

            const approved = await promise;
            if (!approved) throw new Error(`Tool "${def.name}" was rejected by the user.`);
            return def.execute(input, toolCtx);
          },
        };
      });
    },

    async onError(_error: Error, ctx: PluginRunContext): Promise<void> {
      const { cancelRunApprovals } = await import("../approvals");
      cancelRunApprovals(ctx.runId);
    },
  };
}
