import { describe, it, expect, afterEach } from "vitest";
import { createInlineSwarm } from "../../../swarm-runtime/factory";
import type { SwarmManager } from "../../../swarm-runtime/manager/manager";
import type { WorkerTask } from "../../../swarm-runtime/types";
import { BackendManager } from "../manager";
import { FakeBackend } from "../fake-backend";
import type { BackendDescriptor } from "../descriptor";
import { ROUTE_BANDIT_STATE_VERSION, type RouteBanditState } from "../route-bandit";
import type { BanditSnapshotStore } from "../bandit-provisioner";
import type { OutcomeFeedEvent } from "../outcome-feed";
import { SwarmLearningLoop, type SwarmLearningEvent } from "../swarm-learning";

// ===========================================================================
// Fixtures
// ===========================================================================

function descriptor(name: string): BackendDescriptor {
  return {
    name,
    kind: "fake",
    capabilities: ["general"],
    cost: { perRunningHourUsd: 1, perHibernatedHourUsd: 0.1, perProvisionUsd: 0.05, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
  };
}

function memoryStore(): BanditSnapshotStore & { saved: RouteBanditState[] } {
  const saved: RouteBanditState[] = [];
  return {
    saved,
    async load() {
      return saved.length > 0 ? saved[saved.length - 1] : undefined;
    },
    async save(state: RouteBanditState) {
      saved.push(state);
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

// ===========================================================================
// Real end-to-end: a real createInlineSwarm goal, driving real bandit learning
// ===========================================================================

describe("SwarmLearningLoop — real inline swarm end-to-end", () => {
  it("bandit arms move via real verified outcomes from a real goal run to completion", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });

    // A real BackendManager + real FakeBackend, independent of the swarm's
    // own worker pool — this is the routing substrate the bandit learns
    // over, per the LOCKED CONTRACT: resolveBackend maps observed
    // WorkerTask.result.workerId values onto it.
    const backendManager = new BackendManager();
    backendManager.register(new FakeBackend({ name: "swarm-primary" }), descriptor("swarm-primary"));

    const observedWorkerIds = new Set<string>();
    const workerToBackend = new Map<string, string>();
    // Real attribution: only resolvable once a task carries a real result
    // (i.e. at a terminal event, never at dispatch — a WorkerTask has no
    // workerId of its own before it is reported). This module never
    // fabricates the mapping; it reads exactly what the real manager wrote
    // onto `task.result.workerId`.
    const resolveBackend = (t: WorkerTask): string | undefined => {
      const workerId = t.result?.workerId;
      if (!workerId) return undefined;
      observedWorkerIds.add(workerId);
      if (!workerToBackend.has(workerId)) workerToBackend.set(workerId, "swarm-primary");
      return workerToBackend.get(workerId);
    };

    const store = memoryStore();
    const events: SwarmLearningEvent[] = [];
    const loop = await SwarmLearningLoop.attach({
      manager: backendManager,
      swarm,
      resolveBackend,
      store,
      onEvent: (e) => events.push(e),
    });

    expect(loop.status().attached).toBe(true);

    const goal = await swarm.runGoal("Describe the module architecture", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");

    // Let the feed's async persistBestEffort()/onEvent chain settle.
    await tick();
    await tick();

    // ---------------------------------------------------------------------
    // (a) arms[backend].pulls / .verified moved ONLY via real task:verified
    //     events — this run's default executor grounds every claim, so
    //     nothing was rejected and verified === pulls.
    // ---------------------------------------------------------------------
    const status = loop.status();
    const arm = status.arms["swarm-primary"];
    expect(arm).toBeDefined();
    expect(arm.pulls).toBeGreaterThan(0);
    expect(arm.verified).toBe(arm.pulls);
    expect(status.counts.duplicate).toBe(0);

    // Real, actually-observed worker ids (the manager's own `w-<hex>`
    // naming, per `manager.ts`'s `spawnWorker` — never fabricated by this
    // test), each mapped through to the single registered backend.
    expect(observedWorkerIds.size).toBeGreaterThan(0);
    for (const wid of observedWorkerIds) {
      expect(wid).toMatch(/^w-[0-9a-f]+$/);
    }

    // ---------------------------------------------------------------------
    // (b) the injected in-memory BanditSnapshotStore received a valid
    //     ROUTE_BANDIT_STATE_VERSION snapshot after each recorded outcome.
    // ---------------------------------------------------------------------
    const feedEvents = events.filter((e) => e.type === "feed");
    const recordedFeedEvents = feedEvents.filter((e) => (e.detail as unknown as OutcomeFeedEvent).type === "recorded");
    expect(recordedFeedEvents.length).toBe(arm.pulls);
    expect(store.saved.length).toBeGreaterThanOrEqual(recordedFeedEvents.length);
    for (const snapshot of store.saved) {
      expect(snapshot.version).toBe(ROUTE_BANDIT_STATE_VERSION);
      expect(snapshot.arms["swarm-primary"]).toBeDefined();
      expect(Number.isInteger(snapshot.arms["swarm-primary"].pulls)).toBe(true);
    }
    // The final persisted snapshot's arm state matches the live bandit.
    const finalSnapshot = store.saved[store.saved.length - 1];
    expect(finalSnapshot.arms["swarm-primary"]).toEqual({
      pulls: arm.pulls,
      verified: arm.verified,
      totalElapsedMs: arm.totalElapsedMs,
      totalUsd: arm.totalUsd,
    });

    // ---------------------------------------------------------------------
    // (c) status().counts reconciles exactly with the feed events observed.
    // ---------------------------------------------------------------------
    const reconciled = { recorded: 0, skipped: 0, duplicate: 0 };
    for (const e of feedEvents) {
      const inner = e.detail as unknown as OutcomeFeedEvent;
      reconciled[inner.type] += 1;
    }
    expect(status.counts).toEqual(reconciled);

    // ---------------------------------------------------------------------
    // (d) detach() persists finally; a second detach() is a no-op.
    // ---------------------------------------------------------------------
    const savedCountBeforeDetach = store.saved.length;
    await loop.detach();
    expect(loop.status().attached).toBe(false);
    expect(store.saved.length).toBe(savedCountBeforeDetach + 1);
    expect(events.filter((e) => e.type === "detached")).toHaveLength(1);
    expect(events.find((e) => e.type === "detached")?.detail).toMatchObject({ saved: true });

    await loop.detach();
    expect(store.saved.length).toBe(savedCountBeforeDetach + 1); // unchanged
    expect(events.filter((e) => e.type === "detached")).toHaveLength(1); // still exactly one

    // Detaching really stopped listening: a synthetic post-detach event
    // reaching the real swarm's emitter must not move the bandit. Emitted
    // through the untyped `EventEmitter` surface (bypassing `SwarmManager`'s
    // narrow typed `emit`) purely so this test can synthesize the event —
    // the shape mirrors exactly what `manager.ts` itself emits.
    const pullsAfterDetach = loop.bandit().arm("swarm-primary").pulls;
    const rawEmitter = swarm as unknown as { emit(event: string, ...args: unknown[]): boolean };
    rawEmitter.emit(
      "task:verified",
      { id: "post-detach-task", result: { workerId: "w-should-not-count" } },
      { taskId: "post-detach-task", workerId: "w-should-not-count", verdict: "accept", score: 1, checks: [], feedback: "", at: Date.now() }
    );
    await tick();
    expect(loop.bandit().arm("swarm-primary").pulls).toBe(pullsAfterDetach);
  });

  it("attaching a SECOND SwarmLearningLoop from a persisted snapshot resumes learning where the first left off", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 2 });

    const backendManager = new BackendManager();
    backendManager.register(new FakeBackend({ name: "resumed" }), descriptor("resumed"));
    const resolveBackend = (t: WorkerTask): string | undefined => (t.result?.workerId ? "resumed" : undefined);

    const store = memoryStore();
    const firstLoop = await SwarmLearningLoop.attach({ manager: backendManager, swarm, resolveBackend, store });

    const goal = await swarm.runGoal("Analyze the objective", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
    await tick();
    await tick();

    const pullsAfterFirstRun = firstLoop.bandit().arm("resumed").pulls;
    expect(pullsAfterFirstRun).toBeGreaterThan(0);
    await firstLoop.detach();

    // A brand-new loop, new bandit, same manager + same persisted store —
    // must hydrate the first loop's real learned history, not start blind.
    const secondBackendManager = new BackendManager();
    secondBackendManager.register(new FakeBackend({ name: "resumed" }), descriptor("resumed"));
    const events: SwarmLearningEvent[] = [];
    const secondLoop = await SwarmLearningLoop.attach({
      manager: secondBackendManager,
      swarm,
      resolveBackend,
      store,
      onEvent: (e) => events.push(e),
    });

    expect(secondLoop.bandit().arm("resumed").pulls).toBe(pullsAfterFirstRun);
    expect(events.find((e) => e.type === "snapshot-loaded")?.detail).toMatchObject({ armCount: 1 });

    await secondLoop.detach();
  });
});
