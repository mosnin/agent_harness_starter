import { describe, expect, it, vi } from "vitest";
import { devBridge, tauriBridge, type TauriApi } from "../ui/bridge";
import type { AppEvent } from "../ipc/contract";
import type { SwarmFactory, SwarmHandle } from "../core/sidecar";

// ---------------------------------------------------------------------------
// A scripted fake SwarmHandle, mirroring the one in sidecar.test.ts: enough
// to drive runtime.start -> goal.dispatch through a real Sidecar and see
// task/verification events come out the other side of the bridge.
// ---------------------------------------------------------------------------

function emptyMetrics() {
  return {
    goals: { total: 0, completed: 0, failed: 0, aborted: 0, running: 0 },
    tasks: { total: 0, verified: 0, failed: 0, pending: 0, dispatched: 0 },
    workers: { total: 0, idle: 0, busy: 0, killed: 0, dead: 0 },
    verification: { total: 0, accepted: 0, rejected: 0, avgScore: 0, groundingRate: 0 },
    usage: { toolCalls: 0, costUsd: 0 },
  };
}

function makeFakeFactory(): { factory: SwarmFactory; closed: { value: boolean } } {
  const closed = { value: false };
  let snap = {
    workers: [{ workerId: "w1", status: "idle", capabilities: ["general"] }],
    tasks: [] as unknown[],
    goals: [] as unknown[],
    verifications: [] as unknown[],
    metrics: emptyMetrics(),
  };

  const handle: SwarmHandle = {
    async dispatchGoal(objective: string) {
      const goalId = "goal-1";
      snap = {
        ...snap,
        goals: [{ id: goalId, objective, status: "completed" }],
        tasks: [
          {
            id: "t1",
            description: "do the thing",
            status: "verified",
            requiredCapabilities: ["general"],
            attempts: 1,
            maxAttempts: 3,
            dependsOn: [],
          },
        ],
        verifications: [
          {
            taskId: "t1",
            workerId: "w1",
            verdict: "accept",
            score: 0.92,
            checks: [{ name: "grounded", passed: true, weight: 1, detail: "cited evidence" }],
            feedback: "",
            at: 1,
          },
        ],
      };
      return { goalId };
    },
    snapshot() {
      return snap;
    },
    on() {
      /* no progress events needed for these tests — the bridge polls via handle() itself */
    },
    async close() {
      closed.value = true;
    },
  };

  return { factory: async () => handle, closed };
}

describe("devBridge", () => {
  it("send(runtime.start) then send(goal.dispatch) delivers runtime.status and task/verification events via onEvent", async () => {
    const { factory } = makeFakeFactory();
    const bridge = devBridge({ factory });
    const events: AppEvent[] = [];
    bridge.onEvent((e) => events.push(e));

    await bridge.start();
    bridge.send({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    // Sidecar.handle is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    bridge.send({ kind: "goal.dispatch", objective: "ship the thing" });
    await Promise.resolve();
    await Promise.resolve();

    const statusEvt = events.find((e) => e.kind === "runtime.status");
    expect(statusEvt).toEqual({ kind: "runtime.status", running: true, mode: "inline", poolSize: 1 });

    const taskEvt = events.find((e): e is Extract<AppEvent, { kind: "task.upsert" }> => e.kind === "task.upsert");
    expect(taskEvt?.task.status).toBe("verified");

    const verifEvt = events.find(
      (e): e is Extract<AppEvent, { kind: "verification" }> => e.kind === "verification"
    );
    expect(verifEvt?.report.verdict).toBe("accept");

    await bridge.stop();
  });

  it("the unsubscribe function returned by onEvent stops further delivery", async () => {
    const { factory } = makeFakeFactory();
    const bridge = devBridge({ factory });
    const events: AppEvent[] = [];
    const unsubscribe = bridge.onEvent((e) => events.push(e));

    await bridge.start();
    bridge.send({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBeGreaterThan(0);
    unsubscribe();
    const countAfterUnsub = events.length;

    bridge.send({ kind: "goal.dispatch", objective: "should not be observed" });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.length).toBe(countAfterUnsub);

    await bridge.stop();
  });

  it("stop() closes the underlying sidecar/swarm handle", async () => {
    const { factory, closed } = makeFakeFactory();
    const bridge = devBridge({ factory });

    await bridge.start();
    bridge.send({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(closed.value).toBe(false);
    await bridge.stop();
    expect(closed.value).toBe(true);
  });

  it("multiple onEvent listeners all receive the same events", async () => {
    const { factory } = makeFakeFactory();
    const bridge = devBridge({ factory });
    const a: AppEvent[] = [];
    const b: AppEvent[] = [];
    bridge.onEvent((e) => a.push(e));
    bridge.onEvent((e) => b.push(e));

    await bridge.start();
    bridge.send({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);

    await bridge.stop();
  });
});

describe("tauriBridge", () => {
  function makeFakeTauri(): {
    tauri: TauriApi;
    invokeCalls: Array<{ cmd: string; args: unknown }>;
    push: (payload: unknown) => void;
    unlistenCalled: { value: boolean };
  } {
    const invokeCalls: Array<{ cmd: string; args: unknown }> = [];
    const unlistenCalled = { value: false };
    let handler: ((ev: { payload: unknown }) => void) | undefined;

    const tauri: TauriApi = {
      invoke: vi.fn(async (cmd: string, args: unknown) => {
        invokeCalls.push({ cmd, args });
        return undefined;
      }),
      listen: vi.fn(async (_event: string, cb: (ev: { payload: unknown }) => void) => {
        handler = cb;
        return () => {
          unlistenCalled.value = true;
        };
      }),
    };

    return {
      tauri,
      invokeCalls,
      unlistenCalled,
      push: (payload: unknown) => handler?.({ payload }),
    };
  }

  it("send() invokes hades_command with the command", () => {
    const { tauri, invokeCalls } = makeFakeTauri();
    const bridge = tauriBridge(tauri);

    bridge.send({ kind: "goal.dispatch", objective: "ship the thing" });

    expect(invokeCalls).toEqual([
      { cmd: "hades_command", args: { cmd: { kind: "goal.dispatch", objective: "ship the thing" } } },
    ]);
  });

  it("start() wires listen(hades_event, ...) and a pushed payload reaches onEvent decoded", async () => {
    const { tauri, push } = makeFakeTauri();
    const bridge = tauriBridge(tauri);
    const events: AppEvent[] = [];
    bridge.onEvent((e) => events.push(e));

    await bridge.start();
    expect(tauri.listen).toHaveBeenCalledWith("hades_event", expect.any(Function));

    const runtimeStatus: AppEvent = { kind: "runtime.status", running: true, mode: "inline", poolSize: 2 };
    push(runtimeStatus);

    expect(events).toEqual([runtimeStatus]);
  });

  it("drops a malformed pushed payload instead of dispatching it", async () => {
    const { tauri, push } = makeFakeTauri();
    const bridge = tauriBridge(tauri);
    const events: AppEvent[] = [];
    bridge.onEvent((e) => events.push(e));

    await bridge.start();
    push({ kind: "not.a.real.event" });

    expect(events).toEqual([]);
  });

  it("stop() calls the unlisten function returned by listen()", async () => {
    const { tauri, unlistenCalled } = makeFakeTauri();
    const bridge = tauriBridge(tauri);

    await bridge.start();
    expect(unlistenCalled.value).toBe(false);
    await bridge.stop();
    expect(unlistenCalled.value).toBe(true);
  });

  it("missing __TAURI__ (no injected api, none on globalThis) throws a clear error from start()", async () => {
    const original = (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
    delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;

    try {
      const bridge = tauriBridge();
      await expect(bridge.start()).rejects.toThrow(/__TAURI__/);
    } finally {
      if (original !== undefined) {
        (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__ = original;
      }
    }
  });

  it("missing __TAURI__ never throws synchronously from send() — it's swallowed", () => {
    const original = (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;
    delete (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__;

    try {
      const bridge = tauriBridge();
      expect(() => bridge.send({ kind: "runtime.stop" })).not.toThrow();
    } finally {
      if (original !== undefined) {
        (globalThis as unknown as { __TAURI__?: unknown }).__TAURI__ = original;
      }
    }
  });
});
