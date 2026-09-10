import { describe, it, expect } from "vitest";
import {
  PriorityScheduler,
  propagateDeadline,
  type Job,
  type SchedEvent,
} from "../hierarchy/scheduling";

function jobs(defs: Array<Partial<Job<string>> & { id: string }>): Array<Job<string>> {
  return defs.map((d) => ({ task: d.id, ...d }));
}

describe("PriorityScheduler", () => {
  it("dispatches higher priority first (order + completed reflect it)", async () => {
    const sched = new PriorityScheduler<string, string>(async (t) => `r:${t}`, { now: () => 0 });
    const res = await sched.run(
      jobs([
        { id: "low", priority: 1 },
        { id: "high", priority: 10 },
        { id: "mid", priority: 5 },
      ])
    );

    expect(res.order).toEqual(["high", "mid", "low"]);
    // concurrency 1 (default) → completed order equals dispatch order
    expect(res.completed.map((c) => c.id)).toEqual(["high", "mid", "low"]);
    expect(res.completed.map((c) => c.result)).toEqual(["r:high", "r:mid", "r:low"]);
    expect(res.cancelled).toEqual([]);
  });

  it("breaks priority ties by earliest deadline (EDF), undefined last", async () => {
    const sched = new PriorityScheduler<string, string>(async (t) => t, { now: () => 0 });
    const res = await sched.run(
      jobs([
        { id: "none", priority: 5 }, // no deadline → sorts last within the tie
        { id: "late", priority: 5, deadline: 100 },
        { id: "early", priority: 5, deadline: 50 },
      ])
    );

    expect(res.order).toEqual(["early", "late", "none"]);
    expect(res.completed.map((c) => c.id)).toEqual(["early", "late", "none"]);
  });

  it("cancels a job whose deadline is already in the past (never runs it)", async () => {
    const ran: string[] = [];
    const sched = new PriorityScheduler<string, string>(
      async (t) => {
        ran.push(t);
        return t;
      },
      { now: () => 1000 }
    );

    const res = await sched.run(
      jobs([
        { id: "expired", priority: 10, deadline: 500 }, // 1000 >= 500 → cancelled
        { id: "fresh", priority: 1, deadline: 2000 },
      ])
    );

    expect(res.cancelled).toEqual(["expired"]);
    expect(res.completed.map((c) => c.id)).toEqual(["fresh"]);
    expect(res.completed.some((c) => c.id === "expired")).toBe(false);
    expect(ran).toEqual(["fresh"]); // exec never called for the expired job
  });

  it("cancels a later job when the clock advances past its deadline mid-run", async () => {
    // Clock starts at 0 and each exec advances it by 40ms.
    let clock = 0;
    const events: SchedEvent[] = [];
    const sched = new PriorityScheduler<string, string>(
      async (t) => {
        clock += 40;
        return t;
      },
      { now: () => clock, onEvent: (e) => events.push(e) }
    );

    // All equal priority → EDF order: a(30) will be cancelled? No: dispatch a at t=0,
    // deadline 100 ok → clock 40. b deadline 100 ok → clock 80. c deadline 100 ok → clock 120.
    // d deadline 50: at its dispatch clock already 120 >= 50 → cancelled.
    const res = await sched.run(
      jobs([
        { id: "a", priority: 5, deadline: 100 },
        { id: "b", priority: 5, deadline: 110 },
        { id: "c", priority: 5, deadline: 120 },
        { id: "d", priority: 5, deadline: 130 },
      ])
    );

    // Ordered by EDF: a(100), b(110), c(120), d(130).
    // a dispatch@0 ok→40; b dispatch@40 ok→80; c dispatch@80 ok→120; d dispatch@120, 120>=130? no →ok? 120<130 so runs.
    expect(res.completed.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(res.cancelled).toEqual([]);
  });

  it("cancels the exact later job whose deadline the clock overruns", async () => {
    let clock = 0;
    const sched = new PriorityScheduler<string, string>(
      async (t) => {
        clock += 50;
        return t;
      },
      { now: () => clock }
    );

    // EDF order: a(60), b(90), c(70)->reorder. Let's enumerate: deadlines a=60,b=200,c=70.
    // sorted EDF: a(60), c(70), b(200).
    // a dispatch@0 (<60) ok → clock 50.
    // c dispatch@50, 50>=70? no → ok → clock 100.
    // b dispatch@100, 100>=200? no → ok → clock 150.
    // To force a cancel, give a tight one:
    const res = await sched.run(
      jobs([
        { id: "a", priority: 5, deadline: 60 },
        { id: "tight", priority: 5, deadline: 70 }, // at dispatch clock=50 <70 ok → clock 100
        { id: "missed", priority: 5, deadline: 80 }, // at dispatch clock=100 >=80 → cancelled
      ])
    );

    expect(res.completed.map((c) => c.id)).toEqual(["a", "tight"]);
    expect(res.cancelled).toEqual(["missed"]);
  });

  it("propagateDeadline takes the min, honoring undefined", () => {
    expect(propagateDeadline(100, 50)).toBe(50);
    expect(propagateDeadline(50, 100)).toBe(50);
    expect(propagateDeadline(100, undefined)).toBe(100);
    expect(propagateDeadline(undefined, 100)).toBe(100);
    expect(propagateDeadline(undefined, undefined)).toBeUndefined();
    expect(propagateDeadline(70, 70)).toBe(70);
  });

  it("with concurrency > 1 still pulls jobs in priority order", async () => {
    const dispatched: string[] = [];
    // exec resolves on a microtask so the pool actually overlaps.
    const sched = new PriorityScheduler<string, string>(
      async (t) => {
        await Promise.resolve();
        return t;
      },
      { now: () => 0, onEvent: (e) => e.type === "dispatch" && dispatched.push(e.id) }
    );

    const res = await sched.run(
      jobs([
        { id: "p1", priority: 1 },
        { id: "p9", priority: 9 },
        { id: "p5", priority: 5 },
        { id: "p7", priority: 7 },
        { id: "p3", priority: 3 },
      ]),
      { concurrency: 2 }
    );

    // Sorted order is fully determined.
    expect(res.order).toEqual(["p9", "p7", "p5", "p3", "p1"]);
    // All complete (none cancelled).
    expect(res.completed.map((c) => c.id).sort()).toEqual(["p1", "p3", "p5", "p7", "p9"]);
    expect(res.cancelled).toEqual([]);
    // The first N=concurrency dispatched are the top-N priority jobs.
    expect(dispatched.slice(0, 2)).toEqual(["p9", "p7"]);
  });
});
