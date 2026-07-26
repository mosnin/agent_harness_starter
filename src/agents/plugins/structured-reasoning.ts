/**
 * Plugin: Structured Reasoning (PLAN → ACT → VERIFY → CRITIC LOOP)
 *
 * Injects a structured reasoning protocol into the agent's system prompt via
 * onResolveInstructions. The protocol forces the model to plan explicitly before
 * acting, verify its work, and run up to N critic passes before finalizing output.
 *
 * Also injects live memory anchors (short-lived pinned facts) for the current user.
 *
 * Usage:
 *   plugins: [
 *     withStructuredReasoning({
 *       role: "data analyst",
 *       goal: "Answer the user's question using only verified data",
 *       constraints: ["Never invent statistics", "Cite sources"],
 *       maxCriticLoops: 2,
 *       rubric: { accuracy: "All numbers must match source data" },
 *     }),
 *   ]
 */

import type { HarnessPlugin, PluginRunContext } from "../types";
import {
  buildStructuredReasoningPrompt,
  mergeInstructions,
  type StructuredReasoningConfig,
} from "../lib/prompt-builder";
import { anchors as globalAnchors, type AnchorStore } from "../memory/anchors";

export interface StructuredReasoningPluginOptions extends StructuredReasoningConfig {
  /**
   * AnchorStore instance. Defaults to the global singleton.
   * Override in tests or for per-tenant isolation.
   */
  anchorStore?: AnchorStore;

  /**
   * Namespace key for anchor lookups. Defaults to ctx.userId.
   * Set this if you want per-thread or per-org anchors instead.
   */
  anchorNamespace?: string | ((ctx: PluginRunContext) => string);
}

export function withStructuredReasoning(
  opts: StructuredReasoningPluginOptions
): HarnessPlugin {
  const {
    anchorStore = globalAnchors,
    anchorNamespace,
    ...reasoningConfig
  } = opts;

  const promptBlock = buildStructuredReasoningPrompt(reasoningConfig);

  return {
    name: "structured-reasoning",

    onResolveInstructions(
      instructions: string,
      _userMessage: string,
      ctx: PluginRunContext
    ): string {
      const ns =
        typeof anchorNamespace === "function"
          ? anchorNamespace(ctx)
          : anchorNamespace ?? ctx.userId;

      const anchorBlock = ns ? anchorStore.format(ns) : "";

      const fullBlock = anchorBlock
        ? `${anchorBlock}\n\n${promptBlock}`
        : promptBlock;

      return mergeInstructions(instructions, fullBlock);
    },
  };
}
