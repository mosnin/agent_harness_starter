import type { SessionRecord } from "../memory/session-store";

export type NudgeType = "persist" | "summarize" | "review";

export interface Nudge {
  type: NudgeType;
  sessionId: string;
  reason: string;
}

export interface NudgeConfig {
  /** Persist-nudge once this many new turns accumulate since last curation. Default 8. */
  minTurnsSinceCurated?: number;
  /** Summarize-nudge once a session is idle this long and unsummarized. Default 10 min. */
  summarizeIdleMs?: number;
  /** Minimum turns before a session is worth summarizing at all. Default 4. */
  minTurnsToSummarize?: number;
}

export interface SessionNudgeState {
  lastCuratedTurnCount: number;
}

/**
 * Pure nudge evaluation: given a session, how much of it has already been
 * curated, and the current time, decide whether Hades should be prompted to
 * persist knowledge, summarize the session, or review it. This is the "periodic
 * nudge to persist knowledge" behaviour that keeps the learning loop closing.
 */
export function evaluateNudges(
  session: SessionRecord,
  state: SessionNudgeState,
  now: number,
  config: Required<NudgeConfig>
): Nudge[] {
  const nudges: Nudge[] = [];
  const turns = session.messages.length;
  const newTurns = turns - state.lastCuratedTurnCount;

  if (newTurns >= config.minTurnsSinceCurated) {
    nudges.push({
      type: "persist",
      sessionId: session.id,
      reason: `${newTurns} new turns since last curation — extract durable facts`,
    });
  }

  const lastActivity = session.messages.at(-1)?.at ?? session.startedAt;
  const idle = now - lastActivity;
  if (!session.summary && turns >= config.minTurnsToSummarize && idle >= config.summarizeIdleMs) {
    nudges.push({
      type: "summarize",
      sessionId: session.id,
      reason: `session idle ${Math.round(idle / 1000)}s and unsummarized`,
    });
  }

  return nudges;
}

const DEFAULTS: Required<NudgeConfig> = {
  minTurnsSinceCurated: 8,
  summarizeIdleMs: 10 * 60 * 1000,
  minTurnsToSummarize: 4,
};

/**
 * Tracks per-session curation progress and surfaces nudges. The manager/REPL
 * calls `check()` (or runs `start()` on a timer) to receive nudges, then calls
 * `markCurated()` after acting on a persist-nudge so it doesn't fire again for
 * the same turns.
 */
export class NudgeEngine {
  private readonly config: Required<NudgeConfig>;
  private state = new Map<string, SessionNudgeState>();
  private handlers: Array<(n: Nudge) => void> = [];

  constructor(
    config: NudgeConfig = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.config = { ...DEFAULTS, ...config };
  }

  onNudge(handler: (n: Nudge) => void): void {
    this.handlers.push(handler);
  }

  /** Evaluate a session now; emits and returns any nudges. */
  check(session: SessionRecord): Nudge[] {
    const st = this.state.get(session.id) ?? { lastCuratedTurnCount: 0 };
    this.state.set(session.id, st);
    const nudges = evaluateNudges(session, st, this.now(), this.config);
    for (const n of nudges) for (const h of this.handlers) h(n);
    return nudges;
  }

  /** Record that a session was curated up to its current turn count. */
  markCurated(session: SessionRecord): void {
    this.state.set(session.id, { lastCuratedTurnCount: session.messages.length });
  }
}
