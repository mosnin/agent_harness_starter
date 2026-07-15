import { describe, it, expect } from "vitest";
import {
  PriorityScheduler,
  propagateDeadline,
} from "../hierarchy/scheduling";
import type {
  Job,
  SchedEvent,
  SchedulerOptions,
} from "../hierarchy/scheduling";

/**
 * ADVERSARIAL contract tests for the priority / EDF hierarchy scheduler.
 *
 * These tests deliberately try to BREAK a correct implementation and pin the
 * edges implied by the API + task spec. Assumed semantics (documented so a
 * discrepancy is legible rather than a mystery):
 *
 *  - Dispatch order is a TOTAL order: priority DESC, tie -> earliest deadline
 *    (EDF; a job with `deadline == null` sorts AFTER any dated job), final tie
 *    -> id ascending (string compare). This is a total order because ids are
 *    unique, so a correct impl must not depend on input order or sort stability.
 *  - Default concurrency is 1: jobs are processed strictly in the sorted order.
 *  - Cancellation is evaluated at DISPATCH time against the LIVE clock:
 *    a job with `deadline != null && now() >= deadline` is cancelled (never
 *    passed to exec), recorded in `cancelled`, and emits exactly one
 *    `cancel-deadline` event (and NO `dispatch`). Note `!= null`, so a deadline
 *    of 0 is a real deadline (not "falsy / absent").
 *  - `exec` may advance the clock (it mutates whatever `now()` reads), so a
 *    later job can expire because earlier jobs consumed time. The check must be
 *    re-read per job, not snapshotted once.
 *  - A completed job emits `dispatch` then `complete` and lands in `completed`.
 *  - `order` restricted to completed ids reflects the dispatch sequence. Where
 *    cancellation happens we assert the well-defined sets + the completed
 *    subsequence, and do NOT assume whether `order` includes cancelled ids
 *    (the API leaves that under-specified).
 *  - `propagateDeadline` = min of the DEFINED values (undefined is ignored),
 *    using `!= null` semantics so 0 is a valid deadline.
 */

// ---------------------------------------------------------------------------
// Contract comparator, re-implemented independently for the stress test. This
// is the total order the spec describes; the scheduler must reproduce it.
// ---------------------------------------------------------------------------
function contractCompare<T>(a: Job<T>, b: Job<T>): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pb - pa; // priority DESC
  const da = a.deadline;
  const db = b.deadline;
  if (da == null && db == null) {
    // both undated -> id tiebreak
  } else if (da == null) {
    return 1; // undated sorts last
  } else if (db == null) {
    return -1;
  } else if (da !== db) {
    return da - db; // EDF: earliest deadline first
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id asc
}

/** Build a scheduler whose exec records every task it is handed. */
function recordingScheduler<T = number>(
  opts?: SchedulerOptions,
  onExec?: (task: T, job: Job<T>) => void,
) {
  const seen: T[] = [];
  const seenIds: string[] = [];
  const exec = async (task: T, job: Job<T>): Promise<string> => {
    seen.push(task);
    seenIds.push(job.id);
    onExec?.(task, job);
    return `R:${job.id}`;
  };
  const sched = new PriorityScheduler<T, string>(exec, opts);
  return { sched, seen, seenIds };
}

describe("PriorityScheduler — strict priority + EDF + id ordering (#1)", () => {
  it("produces the exact total order a naive/unstable sort would get wrong", async () => {
    // now far in the past so nothing can be cancelled.
    const now = () => -1_000_000;
    const jobs: Array<Job<number>> = [
      // deliberately shuffled so input order != output order
      { id: "b1", task: 1, priority: 5, deadline: 10 },
      { id: "a2", task: 2, priority: 5, deadline: 10 },
      { id: "u3", task: 3, priority: 5 /* undated */ },
      { id: "z4", task: 4, priority: 5, deadline: 3 },
      { id: "m5", task: 5, priority: 9 /* undated, but top priority */ },
      { id: "c6", task: 6, priority: 1, deadline: 1 },
      { id: "a7", task: 7, priority: 5, deadline: 3 },
    ];
    const { sched } = recordingScheduler({ now });
    const res = await sched.run(jobs);

    // Priority 9 first (m5), then priority-5 block by EDF then id:
    //   deadline 3: a7, z4   (id asc)
    //   deadline 10: a2, b1  (id asc)
    //   undated: u3          (last within the group)
    // then priority 1: c6
    expect(res.order).toEqual(["m5", "a7", "z4", "a2", "b1", "u3", "c6"]);
    expect(res.cancelled).toEqual([]);
    expect(res.completed.map((c) => c.id)).toEqual([
      "m5",
      "a7",
      "z4",
      "a2",
      "b1",
      "u3",
      "c6",
    ]);
    // results are carried through from exec
    expect(res.completed.find((c) => c.id === "m5")?.result).toBe("R:m5");
  });
});

describe("PriorityScheduler — exec never runs a cancelled job (#2)", () => {
  it("a past-deadline job's task is never passed to exec", async () => {
    const now = () => 50;
    const jobs: Array<Job<number>> = [
      { id: "ok1", task: 100, priority: 5, deadline: 100 },
      { id: "dead", task: 999, priority: 9, deadline: 10 }, // expired: 50 >= 10
      { id: "ok2", task: 200, priority: 5, deadline: 100 },
    ];
    const { sched, seen, seenIds } = recordingScheduler({ now });
    const res = await sched.run(jobs);

    expect(seen).not.toContain(999); // the cancelled job's task
    expect(seenIds).not.toContain("dead");
    expect(res.cancelled).toContain("dead");
    expect(res.completed.map((c) => c.id).sort()).toEqual(["ok1", "ok2"]);
    // the valid tasks WERE executed
    expect(seen.sort((a, b) => a - b)).toEqual([100, 200]);
  });
});

describe("PriorityScheduler — now() === deadline boundary (#3)", () => {
  it("cancels when now == deadline and runs when deadline == now+1", async () => {
    const now = () => 100;
    const jobs: Array<Job<number>> = [
      { id: "equal", task: 1, priority: 5, deadline: 100 }, // 100 >= 100 -> cancel
      { id: "plus1", task: 2, priority: 5, deadline: 101 }, // 100 >= 101 false -> run
    ];
    const { sched, seenIds } = recordingScheduler({ now });
    const res = await sched.run(jobs);

    expect(res.cancelled).toEqual(["equal"]);
    expect(res.completed.map((c) => c.id)).toEqual(["plus1"]);
    expect(seenIds).toEqual(["plus1"]);
  });

  it("deadline of 0 with now 0 is a real deadline and cancels (not treated as absent)", async () => {
    const now = () => 0;
    const jobs: Array<Job<number>> = [
      { id: "zero", task: 1, priority: 5, deadline: 0 }, // 0 >= 0 -> cancel
      { id: "undated", task: 2, priority: 5 }, // no deadline -> always runs
    ];
    const { sched } = recordingScheduler({ now });
    const res = await sched.run(jobs);

    expect(res.cancelled).toEqual(["zero"]);
    expect(res.completed.map((c) => c.id)).toEqual(["undated"]);
  });
});

describe("PriorityScheduler — cascading deadline misses (#4)", () => {
  it("clock advanced by exec expires only the jobs that fall behind", async () => {
    // Equal priority so order is pure EDF (deadlines are distinct & ascending).
    // Clock starts at 0; every executed job advances it by 20.
    // Trace (concurrency 1):
    //   now=0  A(dl15): 0>=15?  no  -> run,  now->20
    //   now=20 B(dl25): 20>=25? no  -> run,  now->40
    //   now=40 C(dl35): 40>=35? YES -> CANCEL (clock unchanged)
    //   now=40 D(dl45): 40>=45? no  -> run,  now->60
    //   now=60 E(dl55): 60>=55? YES -> CANCEL
    // => completed {A,B,D}, cancelled {C,E}. A "once-one-cancels-all-cancel"
    //    bug or a snapshot-the-clock bug both get this wrong.
    let clock = 0;
    const now = () => clock;
    const exec = async (task: number, job: Job<number>): Promise<string> => {
      clock += 20;
      return `R:${job.id}`;
    };
    const sched = new PriorityScheduler<number, string>(exec, { now });
    const jobs: Array<Job<number>> = [
      { id: "A", task: 1, priority: 5, deadline: 15 },
      { id: "B", task: 2, priority: 5, deadline: 25 },
      { id: "C", task: 3, priority: 5, deadline: 35 },
      { id: "D", task: 4, priority: 5, deadline: 45 },
      { id: "E", task: 5, priority: 5, deadline: 55 },
    ];
    const res = await sched.run(jobs);

    const completedIds = res.completed.map((c) => c.id);
    expect(completedIds.slice().sort()).toEqual(["A", "B", "D"]);
    expect(res.cancelled.slice().sort()).toEqual(["C", "E"]);
    // completed subsequence within order must preserve dispatch order A,B,D
    const completedSet = new Set(completedIds);
    expect(res.order.filter((id) => completedSet.has(id))).toEqual([
      "A",
      "B",
      "D",
    ]);
    // sanity: every job accounted for exactly once
    expect([...completedIds, ...res.cancelled].sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });
});

describe("PriorityScheduler — all jobs expired (#5)", () => {
  it("completes nothing, cancels everything, and never calls exec", async () => {
    const now = () => 10_000;
    const jobs: Array<Job<number>> = [
      { id: "x", task: 1, priority: 3, deadline: 1 },
      { id: "y", task: 2, priority: 9, deadline: 500 },
      { id: "z", task: 3, priority: 1, deadline: 10_000 }, // 10000>=10000 -> cancel
    ];
    const { sched, seen } = recordingScheduler({ now });
    const res = await sched.run(jobs);

    expect(res.completed).toEqual([]);
    expect(res.cancelled.slice().sort()).toEqual(["x", "y", "z"]);
    expect(seen).toEqual([]);
  });
});

describe("PriorityScheduler — event stream consistency (#6)", () => {
  it("emits dispatch+complete per completed and exactly one cancel-deadline per cancelled, timestamps non-decreasing", async () => {
    let clock = 0;
    const now = () => clock;
    const events: SchedEvent[] = [];
    const exec = async (task: number, job: Job<number>): Promise<string> => {
      clock += 5;
      return `R:${job.id}`;
    };
    const sched = new PriorityScheduler<number, string>(exec, {
      now,
      onEvent: (e) => events.push(e),
    });
    // q expires immediately (dl 0 at now 0); p and r run.
    const jobs: Array<Job<number>> = [
      { id: "q", task: 1, priority: 5, deadline: 0 },
      { id: "p", task: 2, priority: 5, deadline: 1000 },
      { id: "r", task: 3, priority: 5, deadline: 1000 },
    ];
    const res = await sched.run(jobs);

    const completed = res.completed.map((c) => c.id).sort();
    expect(completed).toEqual(["p", "r"]);
    expect(res.cancelled).toEqual(["q"]);

    const byType = (t: SchedEvent["type"]) => events.filter((e) => e.type === t);
    const idsOf = (t: SchedEvent["type"]) => byType(t).map((e) => e.id).sort();

    // completed ids: exactly one dispatch and one complete each
    expect(idsOf("dispatch")).toEqual(["p", "r"]);
    expect(idsOf("complete")).toEqual(["p", "r"]);
    // cancelled id: exactly one cancel-deadline, and NO dispatch/complete
    expect(idsOf("cancel-deadline")).toEqual(["q"]);
    expect(byType("dispatch").some((e) => e.id === "q")).toBe(false);
    expect(byType("complete").some((e) => e.id === "q")).toBe(false);

    // each completed id has dispatch strictly before its complete
    for (const id of ["p", "r"]) {
      const di = events.findIndex((e) => e.type === "dispatch" && e.id === id);
      const ci = events.findIndex((e) => e.type === "complete" && e.id === id);
      expect(di).toBeGreaterThanOrEqual(0);
      expect(ci).toBeGreaterThan(di);
    }

    // no duplicate events for any (type,id)
    const keys = events.map((e) => `${e.type}:${e.id}`);
    expect(new Set(keys).size).toBe(keys.length);

    // timestamps are non-decreasing in emission order
    for (let i = 1; i < events.length; i++) {
      expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
    }
  });
});

describe("propagateDeadline (#7)", () => {
  it("returns the min of defined values, ignoring undefined, with 0 treated as defined", () => {
    // (n, n) -> min
    expect(propagateDeadline(5, 3)).toBe(3);
    expect(propagateDeadline(3, 5)).toBe(3);
    // (n, undef) -> n
    expect(propagateDeadline(7, undefined)).toBe(7);
    // (undef, n) -> n
    expect(propagateDeadline(undefined, 7)).toBe(7);
    // (undef, undef) -> undef
    expect(propagateDeadline(undefined, undefined)).toBeUndefined();
    // equal -> that value
    expect(propagateDeadline(4, 4)).toBe(4);
    // 0 is a real deadline, not "falsy/absent" — catches `parent || child`
    expect(propagateDeadline(0, 5)).toBe(0);
    expect(propagateDeadline(5, 0)).toBe(0);
    expect(propagateDeadline(0, undefined)).toBe(0);
    expect(propagateDeadline(undefined, 0)).toBe(0);
  });
});

describe("PriorityScheduler — seeded stress / determinism (#8)", () => {
  it("orders 200 jobs by the exact priority-EDF-id total order (nothing cancels)", async () => {
    const now = () => -1_000_000; // far in the past: nothing can expire
    const jobs: Array<Job<number>> = [];
    for (let i = 0; i < 200; i++) {
      jobs.push({
        id: `j${i}`, // string ids: lexicographic order != numeric index
        task: i,
        priority: (i * 37) % 10, // 0..9, ~20 per bucket -> ties -> EDF
        deadline: 1000 + ((i * 13) % 50), // 1000..1049, many ties -> id tiebreak
      });
    }
    // Independently compute the expected total order.
    const expected = jobs
      .slice()
      .sort(contractCompare)
      .map((j) => j.id);

    const { sched, seen } = recordingScheduler<number>({ now });
    const res = await sched.run(jobs);

    expect(res.cancelled).toEqual([]);
    expect(res.order).toEqual(expected);
    expect(res.completed.map((c) => c.id)).toEqual(expected);
    expect(seen.length).toBe(200);

    // Guard: the expected order is genuinely non-trivial (not just input order,
    // not just id-lexicographic), so this actually exercises the comparator.
    const inputOrder = jobs.map((j) => j.id);
    expect(expected).not.toEqual(inputOrder);
    const lexIds = jobs.map((j) => j.id).sort();
    expect(expected).not.toEqual(lexIds);
  });
});
