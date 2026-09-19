/**
 * Queue Jev decisions onto the harness event stream.
 * Plugins stash events on AgentContext; core drains them after hooks.
 */

import type { AgentEvent, PluginRunContext } from "../types";
import type { PolicyDecision } from "./types";

export function decisionEvent(decision: PolicyDecision): Extract<AgentEvent, { type: "jev_decision" }> {
  return {
    type: "jev_decision",
    node: decision.node,
    decision: String(decision.value),
    reason: decision.reason,
    action: decision.action,
    confidence: decision.confidence,
  };
}

export function queueDecision(ctx: PluginRunContext, decision: PolicyDecision): void {
  const existing = Array.isArray(ctx.context.pendingPluginEvents)
    ? (ctx.context.pendingPluginEvents as AgentEvent[])
    : [];
  existing.push(decisionEvent(decision));
  ctx.context.pendingPluginEvents = existing;
}

export function drainPendingPluginEvents(ctx: { pendingPluginEvents?: unknown }): AgentEvent[] {
  const queued = ctx.pendingPluginEvents;
  if (!Array.isArray(queued) || queued.length === 0) return [];
  ctx.pendingPluginEvents = [];
  return queued.filter((event): event is AgentEvent => {
    return Boolean(event) && typeof event === "object" && "type" in event;
  });
}
