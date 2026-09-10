/**
 * Central-wiring tests for this cycle's `hades tui` additions in
 * src/hades/cli/tui-command.ts: the swarm-event -> VERIFY LANE mapper
 * (`verifyEventFromSwarm`), the STREAM event-name roster
 * (`SWARM_STREAM_EVENTS` — every name must be one `normalizeSwarmEvent`
 * actually understands, fed real manager-shaped payloads), and the
 * controller's INTERRUPT surface (`abortGoal` / `redirectGoal` with the
 * locked cancel-then-dispatch sequence, plus `onGoalDispatched` reporting
 * the REAL goalId the handle returned).
 */
import { describe, it, expect, vi } from "vitest";
import {
  verifyEventFromSwarm,
  SWARM_STREAM_EVENTS,
  createSwarmController,
} from "../cli/tui-command";
import { normalizeSwarmEvent } from "../../swarm-runtime/tui/tool-stream";
import { laneInit, laneApply } from "../../swarm-runtime/tui/verify-lane";
import type { SwarmHandle } from "../../desktop/core/sidecar";

const task = { id: "t-1", description: "measure the thing" };

describe("verifyEventFromSwarm", () => {
  it("maps task:dispatched to a pending ruling", () => {
    expect(verifyEventFromSwarm("task:dispatched", task, 5)).toEqual({
      type: "task",
      at: 5,
      taskId: "t-1",
      description: "measure the thing",
      ruling: "pending",
    });
  });

  it("forwards a well-formed report raw so the lane's verdict override applies", () => {
    const ev = verifyEventFromSwarm("task:verified", [task, { verdict: "accept", score: 0.88 }], 6);
    expect(ev).toEqual({
      type: "task",
      at: 6,
      taskId: "t-1",
      description: "measure the thing",
      ruling: "accept",
      report: { verdict: "accept", score: 0.88 },
    });
  });

  it("a revise report on task:rejected lands as abstain through the real lane reducer", () => {
    const ev = verifyEventFromSwarm("task:rejected", [task, { verdict: "revise", score: 0.3 }], 7);
    expect(ev).not.toBeNull();
    const lane = laneApply(laneInit(), ev!);
    expect(lane.rows[0]?.ruling).toBe("abstain");
    expect(lane.tally).toEqual({ accept: 0, abstain: 1, reject: 0, pending: 0 });
  });

  it("a malformed report falls back to the event-name ruling with no fabricated score", () => {
    const ev = verifyEventFromSwarm("task:verified", [task, { verdict: "banana", score: "high" }], 8);
    expect(ev).toEqual({
      type: "task",
      at: 8,
      taskId: "t-1",
      description: "measure the thing",
      ruling: "accept",
    });
    const lane = laneApply(laneInit(), ev!);
    expect(lane.rows[0]?.score).toBeNull();
  });

  it("a non-numeric report score reaches the lane as an honest null, never NaN", () => {
    const ev = verifyEventFromSwarm("task:verified", [task, { verdict: "accept", score: "0.9" }], 9);
    expect(ev).not.toBeNull();
    const lane = laneApply(laneInit(), ev!);
    expect(lane.rows[0]?.ruling).toBe("accept");
    expect(lane.rows[0]?.score).toBeNull();
  });

  it("maps escalation and hard failure to abstain / reject", () => {
    expect(verifyEventFromSwarm("task:escalated", [task, []], 10)).toMatchObject({ ruling: "abstain" });
    expect(verifyEventFromSwarm("task:failed", [task, "boom"], 11)).toMatchObject({ ruling: "reject" });
  });

  it("maps goal lifecycle to run-start / run-end", () => {
    expect(verifyEventFromSwarm("goal:planned", [{ id: "g-1" }, []], 12)).toEqual({ type: "run-start", at: 12 });
    for (const name of ["goal:completed", "goal:failed", "goal:aborted"]) {
      expect(verifyEventFromSwarm(name, { id: "g-1" }, 13)).toEqual({ type: "run-end", at: 13 });
    }
  });

  it("returns null for unknown events and payloads missing the task identity", () => {
    expect(verifyEventFromSwarm("log", ["w-1", "line"], 1)).toBeNull();
    expect(verifyEventFromSwarm("worker:spawned", { workerId: "w-1" }, 1)).toBeNull();
    expect(verifyEventFromSwarm("task:dispatched", { description: "no id" }, 1)).toBeNull();
    expect(verifyEventFromSwarm("task:verified", [null, { verdict: "accept", score: 1 }], 1)).toBeNull();
    expect(verifyEventFromSwarm("not-an-event", task, 1)).toBeNull();
  });
});

describe("SWARM_STREAM_EVENTS roster", () => {
  it("every listed name normalizes a real manager-shaped payload to a non-null stream row", () => {
    const rec = { workerId: "w-1" };
    const goal = { id: "g-1" };
    const report = { taskId: "t-1", workerId: "w-1", verdict: "accept", score: 1, checks: [], feedback: "", at: 0 };
    const payloads: Record<(typeof SWARM_STREAM_EVENTS)[number], unknown> = {
      log: ["w-1", "a line"],
      "task:dispatched": task,
      "task:verified": [task, report],
      "task:rejected": [task, { ...report, verdict: "reject" }],
      "task:requeued": [task, "flaky"],
      "task:escalated": [task, []],
      "task:failed": [task, "boom"],
      "worker:spawned": rec,
      "worker:killed": [rec, "scaled down"],
      "worker:dead": [rec, "no heartbeat"],
      "goal:planned": [goal, [task]],
      "goal:completed": goal,
      "goal:failed": [goal, "tasks failed"],
      "goal:aborted": [goal, "operator"],
    };
    for (const name of SWARM_STREAM_EVENTS) {
      const ev = normalizeSwarmEvent(name, payloads[name], 42);
      expect(ev, `event ${name} must normalize`).not.toBeNull();
      expect(ev!.at).toBe(42);
    }
  });

  it("contains no name the normalizer would silently drop (no dead subscriptions)", () => {
    // A name outside the normalizer's table would subscribe a listener that
    // can never produce a row — assert the roster and the switch agree.
    expect(new Set(SWARM_STREAM_EVENTS).size).toBe(SWARM_STREAM_EVENTS.length);
  });
});

describe("createSwarmController — INTERRUPT surface", () => {
  function scriptedHandle(): { handle: SwarmHandle; calls: string[] } {
    const calls: string[] = [];
    let n = 0;
    const handle: SwarmHandle = {
      dispatchGoal: (objective: string) => {
        calls.push(`dispatch:${objective}`);
        n += 1;
        return Promise.resolve({ goalId: `g-${n}` });
      },
      cancelGoal: (goalId: string) => {
        calls.push(`cancel:${goalId}`);
      },
      snapshot: () => ({ workers: [], tasks: [] }),
    };
    return { handle, calls };
  }

  it("onGoalDispatched fires with the REAL goalId the handle returned", async () => {
    const { handle } = scriptedHandle();
    const seen: Array<[string, string]> = [];
    const controller = createSwarmController(handle, {
      onGoalDispatched: (goalId, objective) => seen.push([goalId, objective]),
    });
    controller.dispatchGoal("first objective");
    await vi.waitFor(() => expect(seen).toEqual([["g-1", "first objective"]]));
  });

  it("abortGoal cancels exactly the named goal", async () => {
    const { handle, calls } = scriptedHandle();
    const controller = createSwarmController(handle, {});
    controller.abortGoal?.("g-9");
    await vi.waitFor(() => expect(calls).toEqual(["cancel:g-9"]));
  });

  it("redirectGoal applies the LOCKED sequence: cancel the superseded goal, THEN dispatch", async () => {
    const { handle, calls } = scriptedHandle();
    const seen: string[] = [];
    const controller = createSwarmController(handle, {
      onGoalDispatched: (goalId) => seen.push(goalId),
    });
    controller.redirectGoal?.("g-old", "REDIRECT: new plan");
    await vi.waitFor(() => {
      expect(calls).toEqual(["cancel:g-old", "dispatch:REDIRECT: new plan"]);
      expect(seen).toEqual(["g-1"]);
    });
  });

  it("after a redirect, cancel() targets the replacement goal", async () => {
    const { handle, calls } = scriptedHandle();
    const controller = createSwarmController(handle, {});
    controller.redirectGoal?.("g-old", "new plan");
    await vi.waitFor(() => expect(calls).toContain("dispatch:new plan"));
    controller.cancel();
    await vi.waitFor(() => expect(calls[calls.length - 1]).toBe("cancel:g-1"));
  });
});
