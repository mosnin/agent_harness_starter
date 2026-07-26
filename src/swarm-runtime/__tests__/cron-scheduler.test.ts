import { describe, it, expect } from "vitest";
import { cronMatches } from "../scheduling/cron";
import { SwarmScheduler, type GoalRunner } from "../scheduling/scheduler";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

describe("cronMatches", () => {
  it("matches wildcards, steps, lists and ranges", () => {
    const d = new Date(2026, 0, 15, 9, 30, 0); // Jan 15 2026 09:30, a Thursday(4)
    expect(cronMatches("30 9 * * *", d)).toBe(true);
    expect(cronMatches("*/15 * * * *", d)).toBe(true); // 30 % 15 == 0
    expect(cronMatches("0 9 * * *", d)).toBe(false); // minute 0 != 30
    expect(cronMatches("30 9 15 1 *", d)).toBe(true);
    expect(cronMatches("30 8-10 * * 1-5", d)).toBe(true); // hour range + weekday range
    expect(cronMatches("30 9 * * 0", d)).toBe(false); // Sunday only
  });

  it("throws on malformed expressions", () => {
    expect(() => cronMatches("* * *", new Date())).toThrow();
  });
});

describe("SwarmScheduler", () => {
  it("fires interval schedules at the right times with an injected clock", () => {
    const fired: string[] = [];
    const runner: GoalRunner = {
      async startGoal(objective) {
        fired.push(objective);
        return { goalId: "g", done: Promise.resolve({} as never) };
      },
    };
    let t = 1_000_000;
    const sched = new SwarmScheduler(runner, () => t);
    sched.add({ objective: "hourly report", intervalMs: 1000 });

    sched.tick(t); // immediate run
    t += 500;
    sched.tick(t); // not due yet
    t += 600;
    sched.tick(t); // due again (elapsed 1100 >= 1000)
    expect(fired.length).toBe(2);
  });

  it("respects enabled/disabled and skipImmediate", () => {
    const runner: GoalRunner = { async startGoal() { return { goalId: "g", done: Promise.resolve({} as never) }; } };
    let t = 0;
    const sched = new SwarmScheduler(runner, () => t);
    const s = sched.add({ objective: "x", intervalMs: 100, skipImmediate: true });
    expect(sched.tick(0).length).toBe(0); // skipImmediate → not due at t=0
    sched.setEnabled(s.id, false);
    t = 200;
    expect(sched.tick(t).length).toBe(0); // disabled
    sched.setEnabled(s.id, true);
    expect(sched.tick(t).length).toBe(1);
  });

  it("drives a real manager", async () => {
    let swarm: SwarmManager | undefined;
    try {
      swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });
      const sched = new SwarmScheduler(swarm);
      const s = sched.add({ objective: "Scheduled analysis", intervalMs: 60_000 });
      const fired = sched.tick(Date.now());
      expect(fired).toContain(s.id);
      // give the started goal a moment, then confirm it registered a goal id
      await new Promise((r) => setTimeout(r, 300));
      expect(sched.get(s.id)?.lastGoalId).toBeTruthy();
    } finally {
      await swarm?.shutdown();
    }
  });
});
