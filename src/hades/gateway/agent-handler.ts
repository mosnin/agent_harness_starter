/**
 * The brain bridge: turns continuity-routed inbound messages into real agent
 * turns.
 *
 * {@link ContinuityRouter} (see ./continuity) already resolved *who* is
 * talking and *which* durable conversation (`sessionId`) they're in, and
 * flagged whether this message just arrived on a different channel than last
 * time. {@link AgentGatewayHandler} is the next link in the chain: it is a
 * {@link ContinuityHandler} that
 *
 *  - builds a platform-agnostic {@link AgentTurn} from the inbound message
 *    and continuity context,
 *  - serializes turns for the SAME session strictly FIFO (so a user's own
 *    two quick messages are never processed out of order or concurrently —
 *    turns for *different* sessions still run fully concurrently),
 *  - races every turn against a timeout so a stuck engine can never hang a
 *    conversation forever,
 *  - never reports success it didn't earn: a timeout or an engine throw
 *    always yields the same honest, stack-trace-free failure reply (the
 *    failure is still handed to `onError` for observability — just not to
 *    the untrusted cross-platform recipient), and
 *  - prefixes the reply with a short continuity note when the identity just
 *    switched channels, so the human on the new channel isn't confused.
 *
 * The concrete "how do we actually answer" question is delegated to an
 * injected {@link GatewayAgentEngine} — {@link echoEngine} for a fully
 * deterministic, self-announcing mock, or {@link swarmEngine} to drive a
 * real {@link GatewayManager}. Either way the STYX gate/certificate evidence
 * (if any) rides along on the reply as `evidence`, for {@link BadgeStamper}
 * (team verification-badges) to assess *outside* this module — this file
 * never fabricates a badge, it only ever forwards what the engine handed it.
 *
 * @module hades/gateway/agent-handler
 */

import type { ContinuityHandler, ContinuityContext } from "./continuity";
import type { InboundMessage, OutboundReply, GatewayManager } from "../../swarm-runtime/gateway/gateway";
import type { GateDecision } from "../styx/gate";
import type { VerificationCertificate } from "../styx/certificate";
import type { BadgeEvidence } from "./badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A platform-agnostic unit of work handed to a {@link GatewayAgentEngine}. */
export interface AgentTurn {
  /** The one durable conversation id that follows this identity across channels. */
  sessionId: string;
  identityId: string;
  platform: string;
  user: string;
  text: string;
  /** True when this identity's previous turn arrived on a different platform. */
  switchedChannel: boolean;
}

/** What an engine hands back for one turn. */
export interface AgentTurnResult {
  text: string;
  decision?: GateDecision;
  certificate?: VerificationCertificate;
}

/**
 * Anything that can answer an {@link AgentTurn}. `mode` is load-bearing, not
 * decorative: it is the one place a caller (or a test) can tell, without
 * inspecting behavior, whether replies are coming from a real agent or a
 * self-announcing mock — matching the repo's honest-mock rule.
 */
export interface GatewayAgentEngine {
  readonly mode: "real" | "mock";
  respond(turn: AgentTurn): Promise<AgentTurnResult>;
}

// ---------------------------------------------------------------------------
// echoEngine — the honest mock
// ---------------------------------------------------------------------------

/**
 * A fully deterministic mock engine. It never contacts a real model or
 * swarm, attaches no gate/certificate evidence (there is none to attach —
 * fabricating any would be exactly the "unverified claimed as verified"
 * failure STYX exists to prevent), and every reply is unmistakably marked as
 * a mock: prefixed `"[mock] "`, followed by the first 8 characters of the
 * session id and the exact input text, so a human or a test can never
 * mistake this for a real agent answer.
 */
export function echoEngine(): GatewayAgentEngine {
  return {
    mode: "mock",
    async respond(turn: AgentTurn): Promise<AgentTurnResult> {
      const sessionPrefix = turn.sessionId.slice(0, 8);
      return { text: `[mock] ${sessionPrefix} ${turn.text}` };
    },
  };
}

// ---------------------------------------------------------------------------
// swarmEngine — the real bridge to a GatewayManager
// ---------------------------------------------------------------------------

/**
 * Drives a real {@link GatewayManager}: starts a goal for `turn.text`
 * (passing `opts.timeoutMs` through exactly like {@link SwarmGateway} does),
 * awaits its completion, and maps the finished {@link Goal} to text
 * *honestly* — a completed goal's synthesis (plus a contradiction warning if
 * any were found), an aborted goal's explicit cancellation notice, or a
 * generic "no verified answer" notice for anything else (including a
 * `startGoal`/`done` rejection). Never fabricates a success string: every
 * branch either quotes the goal's own synthesis or says plainly that nothing
 * verified was produced.
 */
export function swarmEngine(manager: GatewayManager, opts?: { timeoutMs?: number }): GatewayAgentEngine {
  return {
    mode: "real",
    async respond(turn: AgentTurn): Promise<AgentTurnResult> {
      try {
        const { done } = await manager.startGoal(turn.text, { timeoutMs: opts?.timeoutMs });
        const goal = await done;

        if (goal.status === "completed") {
          const synth = typeof goal.synthesis === "string" ? goal.synthesis : JSON.stringify(goal.synthesis);
          const warn =
            goal.contradictions && goal.contradictions.length
              ? ` (${goal.contradictions.length} contradiction(s) detected across results)`
              : "";
          return { text: `${synth}${warn}` };
        }
        if (goal.status === "aborted") {
          return { text: "The goal was cancelled or ran out of budget before completing." };
        }
        // "failed", or a done-promise that resolved without ever reaching a
        // terminal success state — never spelled as a success.
        return { text: `The swarm could not produce a verified answer for this goal (status: ${goal.status}).` };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { text: `The swarm could not complete this goal: ${reason}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AgentGatewayHandler
// ---------------------------------------------------------------------------

export interface AgentGatewayHandlerOptions {
  engine: GatewayAgentEngine;
  /** Max time to wait for one turn before honestly failing it. Default 300000 (5 min). */
  turnTimeoutMs?: number;
  /**
   * Time source (ms). Not used to schedule the timeout itself (that seam is
   * the global `setTimeout`, which fake-timer tests can control directly) —
   * injectable here so callers/tests can attribute *when* a turn started
   * without depending on the real wall clock.
   */
  now?: () => number;
  /** Observes the real error behind a timeout/throw. Never sees a stack trace leave via the reply text. */
  onError?: (err: unknown, turn: AgentTurn) => void;
}

const TIMEOUT_REPLY_TEXT =
  "I hit a problem completing that — the failure was recorded and nothing unverified was reported as done.";

/**
 * Turns continuity-routed inbound messages into real agent turns. See the
 * module doc for the full behavioral contract; in short: FIFO per session,
 * concurrent across sessions, timeout- and throw-safe, honest on failure,
 * and it prefixes a short continuity note when the channel just switched.
 */
export class AgentGatewayHandler {
  private readonly engine: GatewayAgentEngine;
  private readonly turnTimeoutMs: number;
  private readonly now: () => number;
  private readonly onError?: (err: unknown, turn: AgentTurn) => void;

  /** Per-session FIFO tail. Deleted once its last queued turn drains. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per-session count of queued+running turns. Deleted at zero — no leak. */
  private readonly depth = new Map<string, number>();

  constructor(opts: AgentGatewayHandlerOptions) {
    this.engine = opts.engine;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 300_000;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
  }

  /** Current queue depth (queued + in-flight) for a session. 0 once drained. */
  pendingFor(sessionId: string): number {
    return this.depth.get(sessionId) ?? 0;
  }

  readonly handle: ContinuityHandler = async (
    msg: InboundMessage,
    ctx: ContinuityContext,
  ): Promise<OutboundReply> => {
    const turn: AgentTurn = {
      sessionId: ctx.sessionId,
      identityId: ctx.identity.id,
      platform: msg.platform,
      user: msg.user,
      text: msg.text,
      switchedChannel: ctx.switchedChannel,
    };

    // Captured synchronously, before any await: ContinuityRouter only
    // updates `identity.lastSeen` *after* this handler resolves, but
    // `identity` is a live, mutable reference shared with the store, so
    // reading it eagerly (rather than after we've awaited the engine)
    // guarantees we describe the channel this identity was on *before* this
    // turn, never a value some other in-flight turn already overwrote it
    // with.
    const continuationPlatform = ctx.switchedChannel ? ctx.identity.lastSeen?.platform : undefined;

    const reply = await this.enqueue(turn.sessionId, () => this.runTurn(turn));

    if (continuationPlatform) {
      return { ...reply, text: `(continuing our conversation from ${continuationPlatform}) ${reply.text}` };
    }
    return reply;
  };

  /**
   * Run `task` after every previously-queued turn for `sessionId` has
   * settled (success or failure — a failed turn must never stall the queue
   * behind it), tracking queue depth so {@link pendingFor} is accurate at
   * every point and the Map entries are removed the instant the session's
   * queue is empty.
   */
  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    this.depth.set(sessionId, (this.depth.get(sessionId) ?? 0) + 1);

    const priorTail = this.chains.get(sessionId) ?? Promise.resolve();
    const settled = priorTail.then(task, task);
    // The stored tail itself must never reject (a later turn should still
    // run after an earlier one failed), so store a swallowed view of it —
    // callers still get the real, possibly-rejected `settled` promise back.
    const tailForChain = settled.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(sessionId, tailForChain);

    settled.finally(() => {
      const remaining = (this.depth.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) {
        this.depth.delete(sessionId);
        // Only clear the chain if nobody has queued a newer turn behind us.
        if (this.chains.get(sessionId) === tailForChain) {
          this.chains.delete(sessionId);
        }
      } else {
        this.depth.set(sessionId, remaining);
      }
    });

    return settled;
  }

  /** Race one turn against the timeout and translate the outcome honestly. */
  private async runTurn(turn: AgentTurn): Promise<OutboundReply & { evidence?: BadgeEvidence }> {
    try {
      const result = await this.withTimeout(turn);
      return {
        text: result.text,
        accepted: true,
        evidence: { decision: result.decision, certificate: result.certificate },
      } as OutboundReply & { evidence?: BadgeEvidence };
    } catch (err) {
      this.onError?.(err, turn);
      return { text: TIMEOUT_REPLY_TEXT, accepted: false };
    }
  }

  private withTimeout(turn: AgentTurn): Promise<AgentTurnResult> {
    const startedAt = this.now();
    return new Promise<AgentTurnResult>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const elapsed = this.now() - startedAt;
        reject(new Error(`agent turn for session ${turn.sessionId} timed out after ${elapsed}ms (limit ${this.turnTimeoutMs}ms)`));
      }, this.turnTimeoutMs);
      // Never keep the process alive purely to fire this timeout.
      (timer as unknown as { unref?: () => void }).unref?.();

      this.engine.respond(turn).then(
        (result) => {
          // A late resolution after timeout must be a silent no-op: no
          // double-send (the timeout reply already went out) and no
          // unhandled rejection (we're attached to this promise right here).
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
