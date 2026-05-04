/**
 * Escalation protocols — when and how agents stop, pause, or hand off.
 *
 * An EscalationHandler receives an EscalationEvent and decides:
 *   - notify a supervisor agent
 *   - send a human-approval request
 *   - pause the workflow until resolved
 *   - hard-stop the current run
 *
 * Usage:
 *   import { createEscalationHandler, EscalationError } from "@/agents/governance/escalation";
 *
 *   const handler = createEscalationHandler({
 *     notifyHuman: async (evt) => await sendSlackAlert(evt),
 *     notifyAgent: async (evt) => await supervisorRun(evt),
 *     onCritical: "stop",
 *   });
 *
 *   await handler.escalate(ctx, "high_risk_action", "Agent attempted shell_exec");
 */

import { randomUUID } from "crypto";
import type { EscalationEvent, EscalationReason, GovernanceContext } from "./types";

// ── Escalation handler config ─────────────────────────────────────────────────

export interface EscalationHandlerConfig {
  /**
   * Async function called for every escalation event.
   * Use for Slack/PagerDuty/email notifications, approval queues, etc.
   */
  notifyHuman?: (event: EscalationEvent) => Promise<void>;

  /**
   * Async function to delegate the event to a supervisor agent.
   * Receives the escalation event and returns a resolution string.
   */
  notifyAgent?: (event: EscalationEvent) => Promise<string | undefined>;

  /**
   * What to do when risk is "critical":
   *   "stop"    — throw EscalationError immediately (default)
   *   "flag"    — record the event but do not throw
   *   "notify"  — notify handlers only, do not throw
   */
  onCritical?: "stop" | "flag" | "notify";

  /**
   * What to do when risk is "high":
   *   "stop"    — throw EscalationError
   *   "flag"    — record only (default)
   *   "notify"  — notify handlers
   */
  onHigh?: "stop" | "flag" | "notify";

  /**
   * Custom escalation log sink. Defaults to in-memory store.
   */
  logSink?: (event: EscalationEvent) => void;
}

export interface EscalationHandler {
  /**
   * Trigger an escalation. Depending on the config, this may:
   *   - log the event
   *   - notify human/agent handlers
   *   - throw EscalationError
   */
  escalate(
    ctx: GovernanceContext,
    reason: EscalationReason,
    description: string
  ): Promise<void>;

  /** Mark an escalation event as resolved. */
  resolve(eventId: string, resolution: string): void;

  /** Return all unresolved escalation events. */
  pending(): EscalationEvent[];

  /** Return all escalation events (resolved + unresolved). */
  history(): EscalationEvent[];
}

// ── Escalation error ──────────────────────────────────────────────────────────

export class EscalationError extends Error {
  readonly event: EscalationEvent;
  constructor(event: EscalationEvent) {
    super(`Escalation triggered [${event.reason}]: ${event.description}`);
    this.name = "EscalationError";
    this.event = event;
  }
}

// ── In-memory escalation log ──────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __escalationLog: EscalationEvent[] | undefined;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createEscalationHandler(
  config: EscalationHandlerConfig = {}
): EscalationHandler {
  const log: EscalationEvent[] = [];

  function record(event: EscalationEvent): void {
    log.push(event);
    config.logSink?.(event);
  }

  return {
    async escalate(ctx, reason, description) {
      const event: EscalationEvent = {
        id: randomUUID(),
        agentId: ctx.agentId,
        userId: ctx.userId,
        threadId: ctx.threadId,
        reason,
        description,
        context: ctx,
        timestamp: Date.now(),
        resolved: false,
      };

      record(event);

      // Run notification handlers (non-blocking — errors are swallowed to avoid
      // masking the original error)
      const notifications: Promise<void>[] = [];

      if (config.notifyHuman) {
        notifications.push(config.notifyHuman(event).catch(() => undefined));
      }

      if (config.notifyAgent) {
        notifications.push(
          config.notifyAgent(event).then((resolution) => {
            if (resolution) {
              event.resolved = true;
              event.resolvedAt = Date.now();
              event.resolution = resolution;
            }
          }).catch(() => undefined)
        );
      }

      await Promise.allSettled(notifications);

      // Decide whether to throw
      const risk = ctx.metadata?.risk as string | undefined;
      const isCritical = risk === "critical" || reason === "ethical_concern";
      const isHigh = risk === "high" || reason === "irreversible_action";

      if (isCritical) {
        const onCritical = config.onCritical ?? "stop";
        if (onCritical === "stop") throw new EscalationError(event);
      } else if (isHigh) {
        const onHigh = config.onHigh ?? "flag";
        if (onHigh === "stop") throw new EscalationError(event);
      }
    },

    resolve(eventId, resolution) {
      const event = log.find((e) => e.id === eventId);
      if (event) {
        event.resolved = true;
        event.resolvedAt = Date.now();
        event.resolution = resolution;
      }
    },

    pending() {
      return log.filter((e) => !e.resolved);
    },

    history() {
      return [...log];
    },
  };
}

// ── Escalation triggers ───────────────────────────────────────────────────────

/**
 * Escalation conditions that wrap around workflow steps or tool calls.
 * Returns true if the given action should be escalated.
 */
export interface EscalationTrigger {
  reason: EscalationReason;
  description: string;
  check(ctx: GovernanceContext): boolean | Promise<boolean>;
}

/** Escalate when the agent's self-reported confidence is below a threshold. */
export function lowConfidenceTrigger(threshold = 0.5): EscalationTrigger {
  return {
    reason: "low_confidence",
    description: `Agent confidence below ${threshold * 100}%`,
    check: (ctx) => {
      const confidence = ctx.metadata?.confidence as number | undefined;
      return confidence !== undefined && confidence < threshold;
    },
  };
}

/** Escalate when a specific set of tools is invoked. */
export function sensitiveToolTrigger(toolNames: string[]): EscalationTrigger {
  const set = new Set(toolNames);
  return {
    reason: "high_risk_action",
    description: `Invocation of sensitive tool: ${toolNames.join(", ")}`,
    check: (ctx) => ctx.action.startsWith("tool:") && set.has(ctx.action.slice(5)),
  };
}

/** Escalate after N consecutive policy violations. */
export function repeatedViolationTrigger(threshold = 3): EscalationTrigger {
  return {
    reason: "repeated_violation",
    description: `${threshold} consecutive policy violations detected`,
    check: (ctx) => {
      const count = ctx.metadata?.consecutiveViolations as number | undefined;
      return count !== undefined && count >= threshold;
    },
  };
}

/** Evaluate a list of triggers; return the first that fires, or null. */
export async function checkEscalationTriggers(
  triggers: EscalationTrigger[],
  ctx: GovernanceContext
): Promise<EscalationTrigger | null> {
  for (const trigger of triggers) {
    if (await trigger.check(ctx)) return trigger;
  }
  return null;
}
