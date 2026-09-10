import { describe, expect, it } from "vitest";

import {
  MAX_STREAM_EVENTS,
  normalizeSwarmEvent,
  renderToolStream,
  streamAppend,
  streamInit,
  streamKey,
  streamTick,
  type ToolStreamEvent,
  type ToolStreamState,
} from "../tool-stream";

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === "object") {
    Object.values(obj as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

function ev(overrides: Partial<ToolStreamEvent> & { at: number }): ToolStreamEvent {
  return { source: "worker-1", kind: "log", line: "hello", ...overrides };
}

// ---------------------------------------------------------------------------
// normalizeSwarmEvent — real payload shapes per SwarmHandle.on's forwarding
// convention (args.length <= 1 ? args[0] : args), studied from manager.ts /
// desktop/core/sidecar.ts.
// ---------------------------------------------------------------------------

describe("normalizeSwarmEvent: log", () => {
  it("tuple [workerId, line] (the real SwarmHandle.on forwarding for a 2-arg emit)", () => {
    const out = normalizeSwarmEvent("log", ["worker-3", "compiling..."], 100);
    expect(out).toEqual({ at: 100, source: "worker-3", kind: "log", line: "compiling..." });
  });

  it("bare string payload", () => {
    const out = normalizeSwarmEvent("log", "just text", 5);
    expect(out).toEqual({ at: 5, source: "swarm", kind: "log", line: "just text" });
  });

  it("single-string array falls back to source 'swarm'", () => {
    const out = normalizeSwarmEvent("log", ["only one"], 5);
    expect(out).toEqual({ at: 5, source: "swarm", kind: "log", line: "only one" });
  });

  it("object shape { workerId, line }", () => {
    const out = normalizeSwarmEvent("log", { workerId: "w9", line: "ok" }, 7);
    expect(out).toEqual({ at: 7, source: "w9", kind: "log", line: "ok" });
  });

  it("object shape { line } without workerId falls back to 'swarm'", () => {
    const out = normalizeSwarmEvent("log", { line: "no worker" }, 7);
    expect(out).toEqual({ at: 7, source: "swarm", kind: "log", line: "no worker" });
  });

  it("garbage payloads normalize to null: number, boolean, null, undefined, empty object, wrong-typed array", () => {
    for (const bad of [42, true, null, undefined, {}, [1, 2], [42, "x"]]) {
      expect(normalizeSwarmEvent("log", bad, 1)).toBeNull();
    }
  });
});

describe("normalizeSwarmEvent: task:dispatched (single-arg emit -> bare task object)", () => {
  it("real WorkerTask-shaped object", () => {
    const task = { id: "t1", goalId: "g1", description: "write the docs", assignedTo: "worker-2" };
    const out = normalizeSwarmEvent("task:dispatched", task, 10);
    expect(out).toEqual({ at: 10, source: "worker-2", taskId: "t1", kind: "dispatch", line: "dispatched t1: write the docs" });
  });

  it("tolerates a defensive [task] wrap", () => {
    const task = { id: "t2", description: "x" };
    const out = normalizeSwarmEvent("task:dispatched", [task], 11);
    expect(out?.taskId).toBe("t2");
  });

  it("no assignedTo yet -> source falls back to 'manager'", () => {
    const out = normalizeSwarmEvent("task:dispatched", { id: "t3" }, 12);
    expect(out).toEqual({ at: 12, source: "manager", taskId: "t3", kind: "dispatch", line: "dispatched t3" });
  });

  it("missing id -> null (identity field required)", () => {
    expect(normalizeSwarmEvent("task:dispatched", { description: "no id here" }, 13)).toBeNull();
  });

  it("circular reference elsewhere on the object does not crash or leak into the line", () => {
    type Circular = { id: string; description: string; self?: Circular };
    const circular: Circular = { id: "t4", description: "d" };
    circular.self = circular;
    const out = normalizeSwarmEvent("task:dispatched", circular, 14);
    expect(out?.taskId).toBe("t4");
    expect(out?.line).toBe("dispatched t4: d");
  });
});

describe("normalizeSwarmEvent: task:verified / task:rejected (2-arg -> [task, report])", () => {
  const task = { id: "t5", assignedTo: "worker-7" };
  const report = { taskId: "t5", workerId: "worker-7", verdict: "accept", score: 0.874, feedback: "grounded" };

  it("verified with nested report carrying verdict/score/feedback", () => {
    const out = normalizeSwarmEvent("task:verified", [task, report], 20);
    expect(out).toEqual({
      at: 20,
      source: "worker-7",
      taskId: "t5",
      kind: "verify",
      line: "verified t5 verdict=accept score=0.87 feedback=grounded",
    });
  });

  it("rejected uses the same shape with the reject kind/label", () => {
    const rejectReport = { ...report, verdict: "reject", feedback: "unsupported claim" };
    const out = normalizeSwarmEvent("task:rejected", [task, rejectReport], 21);
    expect(out?.kind).toBe("reject");
    expect(out?.line).toBe("rejected t5 verdict=reject score=0.87 feedback=unsupported claim");
  });

  it("derives taskId from the report when the task object lacks one", () => {
    const out = normalizeSwarmEvent("task:verified", [{}, { taskId: "t6", verdict: "accept", score: 1 }], 22);
    expect(out?.taskId).toBe("t6");
  });

  it("missing verdict/score still emits a row (degrades gracefully, not null)", () => {
    const out = normalizeSwarmEvent("task:verified", [{ id: "t7" }, {}], 23);
    expect(out).toEqual({ at: 23, source: "manager", taskId: "t7", kind: "verify", line: "verified t7" });
  });

  it("no identifiable taskId anywhere -> null", () => {
    expect(normalizeSwarmEvent("task:verified", [{}, {}], 24)).toBeNull();
  });

  it("wrong-typed score (string instead of number) is dropped, not coerced", () => {
    const out = normalizeSwarmEvent("task:verified", [{ id: "t8" }, { score: "high", verdict: "accept" }], 25);
    expect(out?.line).toBe("verified t8 verdict=accept");
  });
});

describe("normalizeSwarmEvent: task:requeued / task:failed (2-arg -> [task, reason:string])", () => {
  it("requeued with a reason string", () => {
    const out = normalizeSwarmEvent("task:requeued", [{ id: "t9", assignedTo: "w1" }, "worker timed out"], 30);
    expect(out).toEqual({ at: 30, source: "w1", taskId: "t9", kind: "requeue", line: "requeued t9: worker timed out" });
  });

  it("failed with a reason string", () => {
    const out = normalizeSwarmEvent("task:failed", [{ id: "t10" }, "exceeded 3 requeues"], 31);
    expect(out).toEqual({ at: 31, source: "manager", taskId: "t10", kind: "fail", line: "failed t10: exceeded 3 requeues" });
  });

  it("missing reason still emits a row without the trailing colon text", () => {
    const out = normalizeSwarmEvent("task:requeued", [{ id: "t11" }, undefined], 32);
    expect(out?.line).toBe("requeued t11");
  });

  it("missing task id -> null", () => {
    expect(normalizeSwarmEvent("task:failed", [{}, "reason"], 33)).toBeNull();
  });
});

describe("normalizeSwarmEvent: task:escalated (2-arg -> [task, revisions:array])", () => {
  it("counts the revisions array", () => {
    const revisions = [{ attempt: 1, failedChecks: [], feedback: "no", at: 1 }, { attempt: 2, failedChecks: [], feedback: "no", at: 2 }];
    const out = normalizeSwarmEvent("task:escalated", [{ id: "t12" }, revisions], 40);
    expect(out).toEqual({ at: 40, source: "manager", taskId: "t12", kind: "escalate", line: "escalated t12 after 2 revisions" });
  });

  it("singular phrasing for exactly one revision", () => {
    const out = normalizeSwarmEvent("task:escalated", [{ id: "t13" }, [{}]], 41);
    expect(out?.line).toBe("escalated t13 after 1 revision");
  });

  it("non-array revisions payload omits the count but still emits", () => {
    const out = normalizeSwarmEvent("task:escalated", [{ id: "t14" }, "not an array"], 42);
    expect(out?.line).toBe("escalated t14");
  });
});

describe("normalizeSwarmEvent: worker:spawned (single-arg -> bare WorkerRecord)", () => {
  it("real WorkerRecord shape", () => {
    const out = normalizeSwarmEvent("worker:spawned", { workerId: "w-a", status: "starting" }, 50);
    expect(out).toEqual({ at: 50, source: "w-a", kind: "worker", line: "spawned w-a" });
  });

  it("missing workerId/id -> null", () => {
    expect(normalizeSwarmEvent("worker:spawned", { status: "starting" }, 51)).toBeNull();
  });
});

describe("normalizeSwarmEvent: worker:killed / worker:dead (2-arg -> [rec, reason])", () => {
  it("killed with reason", () => {
    const out = normalizeSwarmEvent("worker:killed", [{ workerId: "w-b" }, "operator request"], 60);
    expect(out).toEqual({ at: 60, source: "w-b", kind: "worker", line: "killed w-b: operator request" });
  });

  it("dead with reason", () => {
    const out = normalizeSwarmEvent("worker:dead", [{ workerId: "w-c" }, "no heartbeat for >5000ms"], 61);
    expect(out).toEqual({ at: 61, source: "w-c", kind: "worker", line: "dead w-c: no heartbeat for >5000ms" });
  });
});

describe("normalizeSwarmEvent: goal:planned (2-arg -> [goal, tasks:array])", () => {
  it("counts the materialized tasks", () => {
    const out = normalizeSwarmEvent("goal:planned", [{ id: "g1" }, [{ id: "t1" }, { id: "t2" }, { id: "t3" }]], 70);
    expect(out).toEqual({ at: 70, source: "manager", kind: "goal", line: "planned g1 (3 tasks)" });
  });

  it("missing goal id -> null", () => {
    expect(normalizeSwarmEvent("goal:planned", [{}, []], 71)).toBeNull();
  });
});

describe("normalizeSwarmEvent: goal:completed (single-arg -> bare Goal)", () => {
  it("real Goal shape", () => {
    const out = normalizeSwarmEvent("goal:completed", { id: "g2", status: "completed" }, 80);
    expect(out).toEqual({ at: 80, source: "manager", kind: "goal", line: "completed g2" });
  });
});

describe("normalizeSwarmEvent: goal:failed / goal:aborted (2-arg -> [goal, reason])", () => {
  it("failed with reason", () => {
    const out = normalizeSwarmEvent("goal:failed", [{ id: "g3" }, "one or more tasks failed verification"], 90);
    expect(out?.line).toBe("failed g3: one or more tasks failed verification");
  });

  it("aborted with reason", () => {
    const out = normalizeSwarmEvent("goal:aborted", [{ id: "g4" }, "operator request"], 91);
    expect(out?.line).toBe("aborted g4: operator request");
  });
});

describe("normalizeSwarmEvent: unknown event names and adversarial garbage", () => {
  it("unrecognized event name -> null", () => {
    expect(normalizeSwarmEvent("something:unheard-of", { id: "x" }, 1)).toBeNull();
  });

  it("a pre-stringified circular payload (a caller that JSON.stringify'd and caught the throw) still normalizes safely", () => {
    // Simulates a producer that tried to serialize a circular structure,
    // caught the TypeError, and forwarded the placeholder string instead.
    const placeholder = "[unserializable circular payload]";
    expect(normalizeSwarmEvent("task:dispatched", placeholder, 1)).toBeNull();
    expect(normalizeSwarmEvent("goal:completed", placeholder, 1)).toBeNull();
  });

  it("every event kind rejects primitive/garbage payloads without throwing", () => {
    const names = [
      "log",
      "task:dispatched",
      "task:verified",
      "task:rejected",
      "task:requeued",
      "task:escalated",
      "task:failed",
      "worker:spawned",
      "worker:killed",
      "worker:dead",
      "goal:planned",
      "goal:completed",
      "goal:failed",
      "goal:aborted",
    ];
    for (const name of names) {
      for (const bad of [null, undefined, 123, true, Symbol("x"), () => {}]) {
        expect(() => normalizeSwarmEvent(name, bad, 1)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// streamAppend — ring buffer honesty + scroll pin semantics
// ---------------------------------------------------------------------------

describe("streamAppend", () => {
  it("appends in order and starts undropped", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1, line: "a" }));
    s = streamAppend(s, ev({ at: 2, line: "b" }));
    expect(s.events.map((e) => e.line)).toEqual(["a", "b"]);
    expect(s.dropped).toBe(0);
  });

  it("ring-buffers at MAX_STREAM_EVENTS: 600 appended keeps the newest 500, dropped=100", () => {
    let s = streamInit();
    for (let i = 0; i < 600; i++) {
      s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    }
    expect(s.events.length).toBe(MAX_STREAM_EVENTS);
    expect(s.dropped).toBe(100);
    expect(s.events[0]!.line).toBe("line-100");
    expect(s.events[s.events.length - 1]!.line).toBe("line-599");
  });

  it("pin semantics: scroll>0 stays pinned on the same absolute event as new events arrive", () => {
    let s = streamInit();
    for (let i = 0; i < 10; i++) {
      s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    }
    // Scroll back 3 from the tail: bottom-of-view = index 10-1-3 = 6 ("line-6").
    s = streamKey(s, "up");
    s = streamKey(s, "up");
    s = streamKey(s, "up");
    expect(s.scroll).toBe(3);
    const pinnedLine = s.events[s.events.length - 1 - s.scroll]!.line;
    expect(pinnedLine).toBe("line-6");

    s = streamAppend(s, ev({ at: 10, line: "line-10" }));
    expect(s.scroll).toBe(4);
    const stillPinned = s.events[s.events.length - 1 - s.scroll]!.line;
    expect(stillPinned).toBe("line-6");
  });

  it("pin semantics also hold across a simultaneous ring-buffer eviction", () => {
    let s = streamInit();
    for (let i = 0; i < MAX_STREAM_EVENTS; i++) {
      s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    }
    for (let i = 0; i < 5; i++) s = streamKey(s, "up");
    expect(s.scroll).toBe(5);
    const pinnedLine = s.events[s.events.length - 1 - s.scroll]!.line;
    expect(pinnedLine).toBe(`line-${MAX_STREAM_EVENTS - 1 - 5}`);

    // This append evicts the oldest event (ring buffer already at cap).
    s = streamAppend(s, ev({ at: MAX_STREAM_EVENTS, line: "line-new" }));
    expect(s.dropped).toBe(1);
    expect(s.scroll).toBe(6);
    const stillPinned = s.events[s.events.length - 1 - s.scroll]!.line;
    expect(stillPinned).toBe(`line-${MAX_STREAM_EVENTS - 1 - 5}`);
  });

  it("at the live tail (scroll===0), appends do not touch scroll", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1 }));
    expect(s.scroll).toBe(0);
    s = streamAppend(s, ev({ at: 2 }));
    expect(s.scroll).toBe(0);
  });

  it("does not mutate the input state or event", () => {
    const s = deepFreeze(streamInit());
    const e = deepFreeze(ev({ at: 1 }));
    expect(() => streamAppend(s, e)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// streamKey — scroll navigation + filter cycling
// ---------------------------------------------------------------------------

describe("streamKey: scroll navigation", () => {
  function withEvents(n: number): ToolStreamState {
    let s = streamInit();
    for (let i = 0; i < n; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    return s;
  }

  it("up increments and down decrements, clamped at both ends", () => {
    let s = withEvents(5);
    s = streamKey(s, "down"); // already 0, clamps
    expect(s.scroll).toBe(0);
    s = streamKey(s, "up");
    s = streamKey(s, "up");
    expect(s.scroll).toBe(2);
    s = streamKey(s, "down");
    expect(s.scroll).toBe(1);
  });

  it("up cannot scroll past the oldest event", () => {
    let s = withEvents(3);
    for (let i = 0; i < 20; i++) s = streamKey(s, "up");
    expect(s.scroll).toBe(2); // length - 1
  });

  it("pgup/pgdn move by a full page, clamped", () => {
    let s = withEvents(100);
    s = streamKey(s, "pgup");
    expect(s.scroll).toBe(10);
    s = streamKey(s, "pgdn");
    expect(s.scroll).toBe(0);
    s = streamKey(s, "pgdn"); // clamps at 0
    expect(s.scroll).toBe(0);
  });

  it("home jumps to the oldest event, end jumps back to the live tail", () => {
    let s = withEvents(50);
    s = streamKey(s, "home");
    expect(s.scroll).toBe(49);
    s = streamKey(s, "end");
    expect(s.scroll).toBe(0);
  });

  it("with zero events, all navigation keys are no-ops at scroll 0", () => {
    const s = streamInit();
    for (const key of ["up", "down", "pgup", "pgdn", "home", "end"]) {
      expect(streamKey(s, key).scroll).toBe(0);
    }
  });

  it("unrecognized keys return the exact same state reference", () => {
    const s = withEvents(5);
    expect(streamKey(s, "z")).toBe(s);
    expect(streamKey(s, "\r")).toBe(s);
  });
});

describe("streamKey: filter cycling", () => {
  function withSources(...sources: string[]): ToolStreamState {
    let s = streamInit();
    sources.forEach((src, i) => {
      s = streamAppend(s, ev({ at: i, source: src, line: `from-${src}` }));
    });
    return s;
  }

  it("cycles null -> sorted present sources -> back to null", () => {
    let s = withSources("worker-b", "worker-a", "worker-c");
    expect(s.filter).toBeNull();
    s = streamKey(s, "f");
    expect(s.filter).toBe("worker-a");
    s = streamKey(s, "f");
    expect(s.filter).toBe("worker-b");
    s = streamKey(s, "f");
    expect(s.filter).toBe("worker-c");
    s = streamKey(s, "f");
    expect(s.filter).toBeNull();
  });

  it("only offers sources actually present — a filter never lands on an absent source", () => {
    const s = withSources("only-source");
    let cur = s;
    const seen = new Set<string | null>();
    for (let i = 0; i < 4; i++) {
      cur = streamKey(cur, "f");
      seen.add(cur.filter);
    }
    expect(seen).toEqual(new Set([null, "only-source"]));
  });

  it("with no events at all, 'f' is a no-op (stays null)", () => {
    const s = streamInit();
    expect(streamKey(s, "f").filter).toBeNull();
  });

  it("resets scroll to the live tail when the filter changes", () => {
    let s = withSources("a", "a", "a", "b");
    s = streamKey(s, "up");
    s = streamKey(s, "up");
    expect(s.scroll).toBe(2);
    s = streamKey(s, "f");
    expect(s.scroll).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// streamTick
// ---------------------------------------------------------------------------

describe("streamTick", () => {
  it("advances 0 -> 1 -> 2 -> 3 -> 0, wrapping mod 4", () => {
    let s = streamInit();
    const phases = [s.spinnerPhase];
    for (let i = 0; i < 5; i++) {
      s = streamTick(s);
      phases.push(s.spinnerPhase);
    }
    expect(phases).toEqual([0, 1, 2, 3, 0, 1]);
  });
});

// ---------------------------------------------------------------------------
// renderToolStream
// ---------------------------------------------------------------------------

describe("renderToolStream", () => {
  it("always returns exactly `height` rows even with zero events", () => {
    const s = streamInit();
    expect(renderToolStream(s, 40, 6, false).length).toBe(6);
  });

  it("every row is exactly `width` code points, including CJK/emoji content", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1, source: "工作者", line: "你好世界 🚀🔥 done" }));
    const rows = renderToolStream(s, 30, 5, false);
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect([...r].length).toBe(30);
    }
  });

  it("live-tail default shows the most recent events at the bottom", () => {
    let s = streamInit();
    for (let i = 0; i < 3; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    const rows = renderToolStream(s, 40, 3, false);
    expect(rows[rows.length - 1]).toContain("line-2");
  });

  it("shows an honest header with both numbers when more history exists than fits", () => {
    let s = streamInit();
    for (let i = 0; i < 20; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    const rows = renderToolStream(s, 40, 5, false);
    expect(rows[0]).toMatch(/more/);
    expect(rows[0]).toMatch(/dropped/);
  });

  it("ring-buffer honesty end-to-end: header renders both the hidden count and the dropped count", () => {
    let s = streamInit();
    for (let i = 0; i < 600; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    expect(s.dropped).toBe(100);
    const height = 10;
    const rows = renderToolStream(s, 60, height, false);
    expect(rows.length).toBe(height);
    const hiddenCount = MAX_STREAM_EVENTS - (height - 1); // one row reserved for the header
    expect(rows[0]).toContain(`${hiddenCount} more`);
    expect(rows[0]).toContain("100 dropped");
  });

  it("no header when everything fits and nothing was ever dropped", () => {
    let s = streamInit();
    for (let i = 0; i < 3; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    const rows = renderToolStream(s, 40, 10, false);
    expect(rows.some((r) => r.includes("dropped"))).toBe(false);
  });

  it("spinner glyph appears on the newest row only while active and at the live tail", () => {
    let s = streamInit();
    for (let i = 0; i < 3; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));

    const inactiveRows = renderToolStream(s, 40, 3, false);
    expect(inactiveRows[2]).not.toMatch(/[⠋⠙⠹⠸]/);

    const activeRows = renderToolStream(s, 40, 3, true);
    expect(activeRows[2]).toMatch(/[⠋⠙⠹⠸]/);
    // Older rows never carry the spinner, active or not.
    expect(activeRows[0]).not.toMatch(/[⠋⠙⠹⠸]/);
    expect(activeRows[1]).not.toMatch(/[⠋⠙⠹⠸]/);
  });

  it("no spinner on any row when scrolled back, even if active", () => {
    let s = streamInit();
    for (let i = 0; i < 10; i++) s = streamAppend(s, ev({ at: i, line: `line-${i}` }));
    s = streamKey(s, "up");
    s = streamKey(s, "up");
    const rows = renderToolStream(s, 40, 3, true);
    for (const r of rows) expect(r).not.toMatch(/[⠋⠙⠹⠸]/);
  });

  it("filter restricts which events are windowed", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1, source: "a", line: "from-a" }));
    s = streamAppend(s, ev({ at: 2, source: "b", line: "from-b" }));
    s = streamAppend(s, ev({ at: 3, source: "a", line: "from-a-2" }));
    s = { ...s, filter: "a" };
    const rows = renderToolStream(s, 40, 5, false).join("\n");
    expect(rows).toContain("from-a");
    expect(rows).toContain("from-a-2");
    expect(rows).not.toContain("from-b");
  });

  it("sanitizes raw ESC/CSI/BEL/backspace injection strings to U+FFFD, never forwarding real control bytes", () => {
    let s = streamInit();
    const hostile = "before\x1b[31mRED\x1b[0m\x07\x08after";
    s = streamAppend(s, ev({ at: 1, line: hostile }));
    const rows = renderToolStream(s, 80, 3, false);
    // Check each row individually -- joining rows with "\n" would introduce a
    // real control character of our own and defeat the assertion below.
    for (const r of rows) expect(r).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const joined = rows.join("|");
    expect(joined).toContain("\uFFFD");
    expect(joined).toContain("before");
    expect(joined).toContain("after");
  });

  it("sanitizes hostile content in the source field too", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1, source: "worker\x1b[2J", line: "x" }));
    const rows = renderToolStream(s, 60, 3, false);
    for (const r of rows) expect(r).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(rows.join("|")).toContain("\uFFFD");
  });

  it("does not mutate its inputs", () => {
    let s = streamInit();
    s = streamAppend(s, ev({ at: 1 }));
    const frozen = deepFreeze(s);
    expect(() => renderToolStream(frozen, 40, 5, true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fuzz: invariants across random append/key sequences
// ---------------------------------------------------------------------------

describe("fuzz", () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("events.length never exceeds MAX_STREAM_EVENTS, dropped is monotonic non-decreasing, scroll always finite and >= 0", () => {
    const rnd = mulberry32(999);
    let s = streamInit();
    let lastDropped = 0;
    const sources = ["w1", "w2", "w3"];
    for (let i = 0; i < 2000; i++) {
      const roll = rnd();
      if (roll < 0.7) {
        s = streamAppend(s, ev({ at: i, source: sources[Math.floor(rnd() * sources.length)]!, line: `l${i}` }));
      } else if (roll < 0.95) {
        const keys = ["up", "down", "pgup", "pgdn", "home", "end", "f", "z"];
        s = streamKey(s, keys[Math.floor(rnd() * keys.length)]!);
      } else {
        s = streamTick(s);
      }
      expect(s.events.length).toBeLessThanOrEqual(MAX_STREAM_EVENTS);
      expect(s.dropped).toBeGreaterThanOrEqual(lastDropped);
      lastDropped = s.dropped;
      expect(s.scroll).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.scroll)).toBe(true);
      expect(s.spinnerPhase).toBeGreaterThanOrEqual(0);
      expect(s.spinnerPhase).toBeLessThan(4);
    }
  });

  it("renderToolStream always returns exactly `height` rows of exactly `width` code points across random states", () => {
    const rnd = mulberry32(4242);
    let s = streamInit();
    for (let i = 0; i < 50; i++) {
      s = streamAppend(s, ev({ at: i, source: `w${i % 4}`, line: `payload-${i}-🚀` }));
      if (rnd() < 0.3) s = streamKey(s, "up");
      if (rnd() < 0.1) s = streamKey(s, "f");
    }
    for (const height of [0, 1, 2, 7, 15]) {
      for (const width of [1, 10, 42]) {
        const rows = renderToolStream(s, width, height, rnd() < 0.5);
        expect(rows.length).toBe(height);
        for (const r of rows) expect([...r].length).toBe(width);
      }
    }
  });
});
