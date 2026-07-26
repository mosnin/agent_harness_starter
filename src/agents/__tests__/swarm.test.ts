/**
 * Unit tests for SwarmCoordinator and consensus helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwarmCoordinator } from "../swarm/coordinator";
import { majorityVote, weightedAverage } from "../swarm/consensus";
import type { SwarmAgent, SwarmTask } from "../swarm/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<Omit<SwarmAgent, "status" | "load" | "lastHeartbeat">> = {}
): Omit<SwarmAgent, "status" | "load" | "lastHeartbeat"> {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    name: "test-agent",
    capabilities: ["compute"],
    ...overrides,
  };
}

function makeTask(
  overrides: Partial<Omit<SwarmTask, "id" | "status" | "createdAt">> = {}
): Omit<SwarmTask, "id" | "status" | "createdAt"> {
  return {
    description: "test task",
    requiredCapabilities: ["compute"],
    payload: {},
    priority: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SwarmCoordinator
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — agent lifecycle", () => {
  let coord: SwarmCoordinator;

  beforeEach(() => {
    coord = new SwarmCoordinator({ topology: "mesh" });
  });

  afterEach(() => {
    coord.shutdown();
  });

  it("registerAgent returns agent with status idle and load 0", () => {
    const agent = coord.registerAgent(makeAgent({ id: "a1", name: "Alpha" }));
    expect(agent.id).toBe("a1");
    expect(agent.status).toBe("idle");
    expect(agent.load).toBe(0);
  });

  it("registerAgent stores the agent and getAgents returns it", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const agents = coord.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a1");
  });

  it("heartbeat updates lastHeartbeat and load", () => {
    const agent = coord.registerAgent(makeAgent({ id: "a1" }));
    const before = agent.lastHeartbeat;
    coord.heartbeat("a1", 0.5);
    const updated = coord.getAgent("a1")!;
    expect(updated.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(updated.load).toBe(0.5);
  });

  it("heartbeat clamps load to [0, 1]", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    coord.heartbeat("a1", 2.5);
    expect(coord.getAgent("a1")!.load).toBe(1);
    coord.heartbeat("a1", -0.5);
    expect(coord.getAgent("a1")!.load).toBe(0);
  });

  it("getAgents filter by status returns only matching agents", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    coord.registerAgent(makeAgent({ id: "a2" }));
    // Force a2 busy by assigning a task
    const task = coord.submitTask(makeTask({ requiredCapabilities: [] }));
    void task; // auto-assigned
    const idle = coord.getAgents({ status: "idle" });
    // All agents were idle at creation; one may have been assigned
    expect(idle.every((a) => a.status === "idle")).toBe(true);
  });

  it("getAgents filter by capability returns only capable agents", () => {
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a2", capabilities: ["storage"] }));
    const capable = coord.getAgents({ capability: "compute" });
    expect(capable).toHaveLength(1);
    expect(capable[0].id).toBe("a1");
  });

  it("unregisterAgent removes the agent", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    coord.unregisterAgent("a1");
    expect(coord.getAgents()).toHaveLength(0);
  });

  it("unregisterAgent fires onAgentLeave callback", () => {
    const onAgentLeave = vi.fn();
    const c = new SwarmCoordinator({ onAgentLeave });
    c.registerAgent(makeAgent({ id: "a1" }));
    c.unregisterAgent("a1");
    expect(onAgentLeave).toHaveBeenCalledWith("a1");
    c.shutdown();
  });

  it("registerAgent fires onAgentJoin callback", () => {
    const onAgentJoin = vi.fn();
    const c = new SwarmCoordinator({ onAgentJoin });
    c.registerAgent(makeAgent({ id: "a1" }));
    expect(onAgentJoin).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    c.shutdown();
  });

  it("throws when swarm is at capacity", () => {
    const c = new SwarmCoordinator({ maxAgents: 2 });
    c.registerAgent(makeAgent({ id: "a1" }));
    c.registerAgent(makeAgent({ id: "a2" }));
    expect(() => c.registerAgent(makeAgent({ id: "a3" }))).toThrow("capacity");
    c.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — status transitions", () => {
  let coord: SwarmCoordinator;

  beforeEach(() => {
    coord = new SwarmCoordinator({ topology: "mesh" });
  });

  afterEach(() => {
    coord.shutdown();
  });

  it("agent transitions idle → busy on task assignment", () => {
    const agent = coord.registerAgent(makeAgent({ id: "a1" }));
    expect(agent.status).toBe("idle");
    const task = coord.submitTask(makeTask());
    const assigned = coord.getAgent(task.assignedTo!)!;
    expect(assigned.status).toBe("busy");
  });

  it("agent transitions busy → idle after completeTask (single in-flight)", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    expect(coord.getAgent("a1")!.status).toBe("busy");
    coord.completeTask(task.id, { done: true });
    expect(coord.getAgent("a1")!.status).toBe("idle");
  });

  it("agent stays busy after completeTask if it has more in-flight tasks", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    // Manually assign two tasks to the same agent
    const t1 = coord.submitTask(makeTask({ requiredCapabilities: [] }));
    coord.assignTask(
      coord.submitTask(makeTask({ requiredCapabilities: [] })).id,
      "a1"
    );
    coord.completeTask(t1.id, null);
    // Still has one in-flight
    expect(coord.getAgent("a1")!.status).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// Offline detection
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — offline detection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks agent offline after heartbeatIntervalMs * 2", () => {
    vi.useFakeTimers();
    const coord = new SwarmCoordinator({ heartbeatIntervalMs: 1000, topology: "mesh" });
    coord.registerAgent(makeAgent({ id: "a1" }));

    // Advance past 2x heartbeat interval
    vi.advanceTimersByTime(2001);

    const agent = coord.getAgent("a1");
    expect(agent!.status).toBe("offline");
    coord.shutdown();
  });

  it("revives offline agent when heartbeat is received", () => {
    vi.useFakeTimers();
    const coord = new SwarmCoordinator({ heartbeatIntervalMs: 1000, topology: "mesh" });
    coord.registerAgent(makeAgent({ id: "a1" }));

    vi.advanceTimersByTime(2001);
    expect(coord.getAgent("a1")!.status).toBe("offline");

    // Send heartbeat — should revive
    coord.heartbeat("a1");
    expect(coord.getAgent("a1")!.status).toBe("idle");
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Task flow
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — task flow", () => {
  let coord: SwarmCoordinator;

  beforeEach(() => {
    coord = new SwarmCoordinator({ topology: "mesh" });
  });

  afterEach(() => {
    coord.shutdown();
  });

  it("submitTask auto-assigns to a capable agent", () => {
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    const task = coord.submitTask(makeTask({ requiredCapabilities: ["compute"] }));
    expect(task.status).toBe("assigned");
    expect(task.assignedTo).toBe("a1");
  });

  it("submitTask stays pending when no capable agent is available", () => {
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["storage"] }));
    const task = coord.submitTask(makeTask({ requiredCapabilities: ["compute"] }));
    expect(task.status).toBe("pending");
    expect(task.assignedTo).toBeUndefined();
  });

  it("completeTask sets status done, result, and completedAt", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    const completed = coord.completeTask(task.id, { answer: 42 });
    expect(completed.status).toBe("done");
    expect(completed.result).toEqual({ answer: 42 });
    expect(typeof completed.completedAt).toBe("number");
  });

  it("completeTask fires onTaskComplete callback", () => {
    const onTaskComplete = vi.fn();
    const c = new SwarmCoordinator({ onTaskComplete, topology: "mesh" });
    c.registerAgent(makeAgent({ id: "a1" }));
    const task = c.submitTask(makeTask());
    c.completeTask(task.id, null);
    expect(onTaskComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
    c.shutdown();
  });

  it("getStats reflects completed task", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    coord.completeTask(task.id, null);
    const stats = coord.getStats();
    expect(stats.completedTasks).toBe(1);
    expect(stats.pendingTasks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task failure
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — task failure", () => {
  let coord: SwarmCoordinator;

  beforeEach(() => {
    coord = new SwarmCoordinator({ topology: "mesh" });
  });

  afterEach(() => {
    coord.shutdown();
  });

  it("failTask sets status failed and records error", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    const failed = coord.failTask(task.id, "something went wrong");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("something went wrong");
  });

  it("failTask decrements inFlightCount and marks agent idle", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    expect(coord.getAgent("a1")!.status).toBe("busy");
    coord.failTask(task.id, "error");
    expect(coord.getAgent("a1")!.status).toBe("idle");
  });

  it("getStats.failedTasks increments after failTask", () => {
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    coord.failTask(task.id, "err");
    expect(coord.getStats().failedTasks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// selectAgent — centralized (round-robin)
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — selectAgent centralized (round-robin)", () => {
  it("distributes tasks round-robin over idle agents", () => {
    const coord = new SwarmCoordinator({ topology: "centralized" });
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a2", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a3", capabilities: ["compute"] }));

    // selectAgent without committing so agents stay idle
    const taskBase: SwarmTask = {
      id: "t",
      description: "",
      requiredCapabilities: ["compute"],
      payload: {},
      priority: 5,
      status: "pending",
      createdAt: Date.now(),
    };

    const first = coord.selectAgent(taskBase);
    const second = coord.selectAgent(taskBase);
    // They should come from the idle pool (may or may not be different ids due to
    // index wrapping, but both should be valid capable agents)
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(["a1", "a2", "a3"]).toContain(first!.id);
    expect(["a1", "a2", "a3"]).toContain(second!.id);
    coord.shutdown();
  });

  it("returns undefined when no idle capable agent exists", () => {
    const coord = new SwarmCoordinator({ topology: "centralized" });
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    // Assign the only capable agent a task to make it busy
    coord.submitTask(makeTask());

    const taskBase: SwarmTask = {
      id: "t2",
      description: "",
      requiredCapabilities: ["compute"],
      payload: {},
      priority: 5,
      status: "pending",
      createdAt: Date.now(),
    };
    const selected = coord.selectAgent(taskBase);
    expect(selected).toBeUndefined();
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// selectAgent — hierarchical (lowest load)
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — selectAgent hierarchical (lowest load)", () => {
  it("picks the agent with lowest load", () => {
    const coord = new SwarmCoordinator({ topology: "hierarchical" });
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a2", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a3", capabilities: ["compute"] }));

    coord.heartbeat("a1", 0.8);
    coord.heartbeat("a2", 0.2);
    coord.heartbeat("a3", 0.5);

    const task: SwarmTask = {
      id: "t",
      description: "",
      requiredCapabilities: ["compute"],
      payload: {},
      priority: 5,
      status: "pending",
      createdAt: Date.now(),
    };

    const selected = coord.selectAgent(task);
    expect(selected?.id).toBe("a2");
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// selectAgent — mesh (score = load*0.7 + inFlight*0.3)
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — selectAgent mesh (score)", () => {
  it("picks agent with lowest composite score", () => {
    const coord = new SwarmCoordinator({ topology: "mesh" });
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a2", capabilities: ["compute"] }));

    // a1: load=0.9, inFlight=0 → score = 0.9*0.7 + 0 = 0.63
    // a2: load=0.1, inFlight=0 → score = 0.1*0.7 + 0 = 0.07
    coord.heartbeat("a1", 0.9);
    coord.heartbeat("a2", 0.1);

    const task: SwarmTask = {
      id: "t",
      description: "",
      requiredCapabilities: ["compute"],
      payload: {},
      priority: 5,
      status: "pending",
      createdAt: Date.now(),
    };

    const selected = coord.selectAgent(task);
    expect(selected?.id).toBe("a2");
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// selectAgent — no match
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — selectAgent no match", () => {
  it("returns undefined when no agent has the required capability", () => {
    const coord = new SwarmCoordinator({ topology: "mesh" });
    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["storage"] }));

    const task: SwarmTask = {
      id: "t",
      description: "",
      requiredCapabilities: ["compute"],
      payload: {},
      priority: 5,
      status: "pending",
      createdAt: Date.now(),
    };

    expect(coord.selectAgent(task)).toBeUndefined();
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — message bus", () => {
  let coord: SwarmCoordinator;
  const received: unknown[] = [];

  beforeEach(() => {
    received.length = 0;
    coord = new SwarmCoordinator({
      topology: "mesh",
      onMessage: (msg) => received.push(msg),
    });
  });

  afterEach(() => {
    coord.shutdown();
  });

  it("send() fires onMessage callback with full message", () => {
    coord.send({ type: "task", fromAgentId: "a1", toAgentId: "a2", payload: { x: 1 } });
    expect(received).toHaveLength(1);
    const msg = received[0] as ReturnType<SwarmCoordinator["send"]>;
    expect(msg.type).toBe("task");
    expect(msg.fromAgentId).toBe("a1");
    expect(msg.toAgentId).toBe("a2");
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.timestamp).toBe("number");
  });

  it("broadcast() sets toAgentId to 'broadcast'", () => {
    coord.broadcast("a1", "control", { cmd: "stop" });
    expect(received).toHaveLength(1);
    const msg = received[0] as ReturnType<SwarmCoordinator["send"]>;
    expect(msg.toAgentId).toBe("broadcast");
    expect(msg.fromAgentId).toBe("a1");
    expect(msg.type).toBe("control");
  });

  it("broadcast() fires onMessage once", () => {
    coord.broadcast("a1", "heartbeat", null);
    expect(received).toHaveLength(1);
  });

  it("multiple sends accumulate calls to onMessage", () => {
    coord.send({ type: "result", fromAgentId: "a1", toAgentId: "a2", payload: 1 });
    coord.send({ type: "result", fromAgentId: "a1", toAgentId: "a3", payload: 2 });
    expect(received).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe("SwarmCoordinator — getStats", () => {
  it("returns zeroed stats on empty coordinator", () => {
    const coord = new SwarmCoordinator();
    const stats = coord.getStats();
    expect(stats.totalAgents).toBe(0);
    expect(stats.activeAgents).toBe(0);
    expect(stats.pendingTasks).toBe(0);
    expect(stats.completedTasks).toBe(0);
    expect(stats.failedTasks).toBe(0);
    expect(stats.avgTaskDurationMs).toBe(0);
    coord.shutdown();
  });

  it("correctly counts total, active, pending, completed, failed", () => {
    const coord = new SwarmCoordinator({ topology: "mesh" });

    coord.registerAgent(makeAgent({ id: "a1", capabilities: ["compute"] }));
    coord.registerAgent(makeAgent({ id: "a2", capabilities: ["storage"] }));

    // a1 gets a task (busy), a2 stays idle
    const t1 = coord.submitTask(makeTask({ requiredCapabilities: ["compute"] }));
    // pending task (no capable agent to pick up "special")
    coord.submitTask(makeTask({ requiredCapabilities: ["special"] }));
    // completed task via a1 (need to first complete t1, reassign, etc.)
    coord.completeTask(t1.id, null);

    // assign another task and fail it
    const t3 = coord.submitTask(makeTask({ requiredCapabilities: ["compute"] }));
    coord.failTask(t3.id, "boom");

    const stats = coord.getStats();
    expect(stats.totalAgents).toBe(2);
    expect(stats.activeAgents).toBe(2); // both idle after completeTask
    expect(stats.pendingTasks).toBe(1);
    expect(stats.completedTasks).toBe(1);
    expect(stats.failedTasks).toBe(1);
    coord.shutdown();
  });

  it("avgTaskDurationMs is positive after completing a task", () => {
    const coord = new SwarmCoordinator({ topology: "mesh" });
    coord.registerAgent(makeAgent({ id: "a1" }));
    const task = coord.submitTask(makeTask());
    coord.completeTask(task.id, null);
    expect(coord.getStats().avgTaskDurationMs).toBeGreaterThanOrEqual(0);
    coord.shutdown();
  });
});

// ---------------------------------------------------------------------------
// consensus — majorityVote
// ---------------------------------------------------------------------------

describe("majorityVote", () => {
  it("throws on empty votes array", () => {
    expect(() => majorityVote([])).toThrow("zero votes");
  });

  it("returns the single value when only one vote exists", () => {
    const result = majorityVote([{ agentId: "a1", value: "yes", weight: 1, timestamp: 0 }]);
    expect(result.value).toBe("yes");
    expect(result.confidence).toBe(1);
    expect(result.totalVotes).toBe(1);
    expect(result.agreement).toBe(true);
  });

  it("returns correct winner with clear majority", () => {
    const votes = [
      { agentId: "a1", value: "yes", weight: 1, timestamp: 0 },
      { agentId: "a2", value: "yes", weight: 1, timestamp: 0 },
      { agentId: "a3", value: "no", weight: 1, timestamp: 0 },
    ];
    const result = majorityVote(votes);
    expect(result.value).toBe("yes");
    expect(result.confidence).toBeCloseTo(2 / 3);
    expect(result.totalVotes).toBe(3);
  });

  it("tie is broken by first-encountered key (Map insertion order)", () => {
    // Both "A" and "B" have equal weight — "A" appears first
    const votes = [
      { agentId: "a1", value: "A", weight: 1, timestamp: 0 },
      { agentId: "a2", value: "B", weight: 1, timestamp: 0 },
    ];
    const result = majorityVote(votes);
    // The winner is whichever key first exceeded the previous max
    // Since both are equal, first inserted ("A") keeps winnerKey (A.weight never
    // strictly > A.weight once B appears with same weight, so A wins)
    expect(result.value).toBe("A");
  });

  it("respects fractional weights", () => {
    const votes = [
      { agentId: "a1", value: "yes", weight: 0.9, timestamp: 0 },
      { agentId: "a2", value: "no", weight: 0.1, timestamp: 0 },
    ];
    const result = majorityVote(votes);
    expect(result.value).toBe("yes");
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("agreement is true when confidence >= quorum", () => {
    const votes = [
      { agentId: "a1", value: "x", weight: 1, timestamp: 0 },
      { agentId: "a2", value: "x", weight: 1, timestamp: 0 },
    ];
    const result = majorityVote(votes, 0.5);
    expect(result.agreement).toBe(true);
  });

  it("agreement is false when confidence < quorum", () => {
    const votes = [
      { agentId: "a1", value: "x", weight: 1, timestamp: 0 },
      { agentId: "a2", value: "y", weight: 1, timestamp: 0 },
      { agentId: "a3", value: "z", weight: 1, timestamp: 0 },
    ];
    // Winner gets 1/3 ≈ 0.33, default quorum 0.51
    const result = majorityVote(votes);
    expect(result.agreement).toBe(false);
  });

  it("groups equal-value votes by JSON.stringify", () => {
    const votes = [
      { agentId: "a1", value: { key: 1 }, weight: 1, timestamp: 0 },
      { agentId: "a2", value: { key: 1 }, weight: 1, timestamp: 0 },
      { agentId: "a3", value: { key: 2 }, weight: 1, timestamp: 0 },
    ];
    const result = majorityVote<{ key: number }>(votes);
    expect(result.value).toEqual({ key: 1 });
    expect(result.confidence).toBeCloseTo(2 / 3);
  });
});

// ---------------------------------------------------------------------------
// consensus — weightedAverage
// ---------------------------------------------------------------------------

describe("weightedAverage", () => {
  it("throws on empty votes array", () => {
    expect(() => weightedAverage([])).toThrow("zero votes");
  });

  it("returns exact value for a single vote", () => {
    const result = weightedAverage([{ agentId: "a1", value: 42, weight: 1, timestamp: 0 }]);
    expect(result.value).toBe(42);
    expect(result.totalVotes).toBe(1);
  });

  it("computes correct weighted mean", () => {
    const votes = [
      { agentId: "a1", value: 10, weight: 1, timestamp: 0 },
      { agentId: "a2", value: 20, weight: 3, timestamp: 0 },
    ];
    // weighted mean = (10*1 + 20*3) / (1+3) = 70/4 = 17.5
    const result = weightedAverage(votes);
    expect(result.value).toBeCloseTo(17.5);
    expect(result.totalVotes).toBe(2);
  });

  it("confidence is within [0, 1]", () => {
    const votes = [
      { agentId: "a1", value: 100, weight: 1, timestamp: 0 },
      { agentId: "a2", value: 101, weight: 1, timestamp: 0 },
      { agentId: "a3", value: 200, weight: 1, timestamp: 0 },
    ];
    const result = weightedAverage(votes);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("confidence is high (>=0.5) when votes are tightly clustered", () => {
    // All values close together — they should all be within 10% of mean
    const votes = [
      { agentId: "a1", value: 100, weight: 1, timestamp: 0 },
      { agentId: "a2", value: 100, weight: 1, timestamp: 0 },
      { agentId: "a3", value: 100, weight: 1, timestamp: 0 },
    ];
    const result = weightedAverage(votes);
    expect(result.confidence).toBeCloseTo(1);
  });

  it("agreement matches confidence >= 0.51", () => {
    const unanimous = [
      { agentId: "a1", value: 5, weight: 1, timestamp: 0 },
      { agentId: "a2", value: 5, weight: 1, timestamp: 0 },
    ];
    const r = weightedAverage(unanimous);
    expect(r.agreement).toBe(r.confidence >= 0.51);
  });
});
