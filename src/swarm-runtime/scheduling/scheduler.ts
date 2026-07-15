import { randomUUID } from "node:crypto";
import type { BudgetSpec, Goal } from "../types";
import { cronMatches, assertValidCron } from "./cron";

/** Minimal manager surface the scheduler drives (keeps it decoupled). */
export interface GoalRunner {
  startGoal(
    objective: string,
    opts?: { timeoutMs?: number; budget?: BudgetSpec }
  ): Promise<{ goalId: string; done: Promise<Goal> }>;
}

export interface ScheduleSpec {
  objective: string;
  /** Fire every N ms (mutually exclusive with `cron`). */
  intervalMs?: number;
  /** 5-field cron expression (minute granularity). */
  cron?: string;
  /** Options forwarded to each goal run. */
  goalOpts?: { timeoutMs?: number; budget?: BudgetSpec };
  /** Skip the immediate run for interval schedules. */
  skipImmediate?: boolean;
}

export interface Schedule extends ScheduleSpec {
  id: string;
  enabled: boolean;
  createdAt: number;
  runs: number;
  lastRunAt?: number;
  lastGoalId?: string;
  /** For interval schedules: next epoch ms it's due. */
  nextRunAt?: number;
  /** For cron schedules: last minute (epoch/60000) we fired, to de-dupe. */
  lastFiredMinute?: number;
}

/**
 * Recurring-goal scheduler — the swarm equivalent of Hermes' cron automations.
 * Fires goals on an interval or cron expression via a {@link GoalRunner}. The
 * clock is injectable so schedules can be tested deterministically without
 * real time, and `tick(now)` is pure-ish (only side effect is starting goals),
 * so a host can drive it from any timer source.
 */
export class SwarmScheduler {
  private schedules = new Map<string, Schedule>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly runner: GoalRunner,
    private readonly now: () => number = () => Date.now()
  ) {}

  add(spec: ScheduleSpec): Schedule {
    if (!spec.intervalMs && !spec.cron) throw new Error("schedule needs intervalMs or cron");
    if (spec.cron) assertValidCron(spec.cron);
    const t = this.now();
    const schedule: Schedule = {
      ...spec,
      id: randomUUID(),
      enabled: true,
      createdAt: t,
      runs: 0,
      nextRunAt: spec.intervalMs ? (spec.skipImmediate ? t + spec.intervalMs : t) : undefined,
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  remove(id: string): boolean {
    return this.schedules.delete(id);
  }
  setEnabled(id: string, enabled: boolean): void {
    const s = this.schedules.get(id);
    if (s) s.enabled = enabled;
  }
  list(): Schedule[] {
    return [...this.schedules.values()];
  }
  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  /** Evaluate all schedules at time `now` and start any that are due. */
  tick(now = this.now()): string[] {
    const fired: string[] = [];
    for (const s of this.schedules.values()) {
      if (!s.enabled) continue;
      if (this.isDue(s, now)) {
        this.fire(s, now);
        fired.push(s.id);
      }
    }
    return fired;
  }

  /** Start a real timer that ticks every `pollMs` (default 1s). */
  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), pollMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private isDue(s: Schedule, now: number): boolean {
    if (s.intervalMs != null) return s.nextRunAt != null && now >= s.nextRunAt;
    if (s.cron) {
      const minute = Math.floor(now / 60_000);
      return s.lastFiredMinute !== minute && cronMatches(s.cron, new Date(now));
    }
    return false;
  }

  private fire(s: Schedule, now: number): void {
    s.runs += 1;
    s.lastRunAt = now;
    if (s.intervalMs != null) s.nextRunAt = now + s.intervalMs;
    if (s.cron) s.lastFiredMinute = Math.floor(now / 60_000);
    void this.runner
      .startGoal(s.objective, s.goalOpts)
      .then(({ goalId }) => {
        s.lastGoalId = goalId;
      })
      .catch(() => undefined);
  }
}
