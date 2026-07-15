import type { Goal } from "../types";

export type GatewayPlatform = "slack" | "discord" | "telegram" | "whatsapp" | "cli" | "generic";

/** Platform-agnostic inbound message. */
export interface InboundMessage {
  platform: GatewayPlatform;
  user: string;
  channel?: string;
  text: string;
}

/** Reply the gateway hands back to the platform. */
export interface OutboundReply {
  text: string;
  goalId?: string;
  status?: string;
  accepted: boolean;
}

/** Minimal manager surface the gateway needs. */
export interface GatewayManager {
  startGoal(objective: string, opts?: { timeoutMs?: number }): Promise<{ goalId: string; done: Promise<Goal> }>;
  getGoal(id: string): Goal | undefined;
}

export interface GatewayOptions {
  /** Only these users may trigger the swarm (empty/undefined = anyone). */
  allowedUsers?: string[];
  /** If the message must start with this trigger to be handled (e.g. "/swarm"). */
  trigger?: string;
  /** Wait for the goal to finish and reply with the result. Default true. */
  awaitCompletion?: boolean;
  /** Max wait when awaiting completion. Default 5 min. */
  timeoutMs?: number;
  /** Format the reply from a finished goal. */
  formatReply?: (goal: Goal) => string;
}

/**
 * Gateway that lets a chat message — Slack, Discord, Telegram, or any platform —
 * kick off a swarm goal and get a reply, the way Hermes "lives where you do".
 * Platform payloads are normalized to {@link InboundMessage} by the parsers
 * below, so the core logic is platform-independent. Every reply is still the
 * product of the verification gate: the swarm can't answer the channel with an
 * ungrounded result.
 */
export class SwarmGateway {
  constructor(
    private readonly manager: GatewayManager,
    private readonly opts: GatewayOptions = {}
  ) {}

  async handle(msg: InboundMessage): Promise<OutboundReply> {
    // Access control.
    if (this.opts.allowedUsers?.length && !this.opts.allowedUsers.includes(msg.user)) {
      return { text: "You are not authorized to use the swarm here.", accepted: false };
    }

    const objective = this.extractObjective(msg.text);
    if (objective == null) {
      return { text: "", accepted: false }; // not addressed to us — ignore
    }
    if (!objective.trim()) {
      return { text: "Please include a goal after the trigger.", accepted: false };
    }

    const { goalId, done } = await this.manager.startGoal(objective, { timeoutMs: this.opts.timeoutMs });

    if (this.opts.awaitCompletion === false) {
      void done.catch(() => undefined);
      return { text: `On it — started goal \`${goalId}\`. I'll follow up.`, goalId, status: "running", accepted: true };
    }

    const goal = await done;
    return {
      text: this.formatReply(goal),
      goalId,
      status: goal.status,
      accepted: true,
    };
  }

  private extractObjective(text: string): string | null {
    const trimmed = text.trim();
    if (!this.opts.trigger) return trimmed;
    // Accept "<trigger> objective" or "<@mention> <trigger> objective".
    const idx = trimmed.toLowerCase().indexOf(this.opts.trigger.toLowerCase());
    if (idx < 0) return null; // trigger required but absent → not for us
    return trimmed.slice(idx + this.opts.trigger.length).trim();
  }

  private formatReply(goal: Goal): string {
    if (this.opts.formatReply) return this.opts.formatReply(goal);
    if (goal.status === "completed") {
      const synth = typeof goal.synthesis === "string" ? goal.synthesis : JSON.stringify(goal.synthesis);
      const warn =
        goal.contradictions && goal.contradictions.length
          ? `\n⚠️ ${goal.contradictions.length} contradiction(s) detected across results.`
          : "";
      return `✅ ${synth}${warn}`;
    }
    if (goal.status === "aborted") return "⏹️ The goal was cancelled or ran out of budget.";
    return "❌ The swarm could not produce a verified answer.";
  }
}

// ── Platform parsers (payload → InboundMessage) ──────────────────────────────

export function parseSlack(payload: { event?: { user?: string; text?: string; channel?: string } }): InboundMessage {
  const e = payload.event ?? {};
  return { platform: "slack", user: String(e.user ?? ""), channel: e.channel, text: String(e.text ?? "") };
}

export function parseTelegram(payload: {
  message?: { from?: { id?: number | string }; chat?: { id?: number | string }; text?: string };
}): InboundMessage {
  const m = payload.message ?? {};
  return {
    platform: "telegram",
    user: String(m.from?.id ?? ""),
    channel: m.chat?.id != null ? String(m.chat.id) : undefined,
    text: String(m.text ?? ""),
  };
}

export function parseDiscord(payload: { author?: { id?: string }; channel_id?: string; content?: string }): InboundMessage {
  return {
    platform: "discord",
    user: String(payload.author?.id ?? ""),
    channel: payload.channel_id,
    text: String(payload.content ?? ""),
  };
}
