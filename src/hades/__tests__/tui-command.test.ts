import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  runTuiCommand,
  runTuiInteractive,
  snapshotToTuiState,
  createSwarmController,
} from "../cli/tui-command";
import type { SwarmHandle } from "../../desktop/core/sidecar";

/** A scripted fake `SwarmHandle` — no real swarm, no timers, no I/O. */
function fakeHandle(overrides: Partial<SwarmHandle> = {}): SwarmHandle & {
  dispatchGoal: ReturnType<typeof vi.fn>;
  cancelGoal: ReturnType<typeof vi.fn>;
  scalePool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchGoal: vi.fn(async (objective: string) => ({ goalId: `goal-${objective}` })),
    cancelGoal: vi.fn(async () => undefined),
    scalePool: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    snapshot: () => ({
      workers: [{ workerId: "w1", status: "idle", capabilities: ["general"] }],
      tasks: [{ description: "write the report", status: "pending" }],
      metrics: {
        goals: { total: 1, completed: 0, failed: 0, aborted: 0, running: 1 },
        tasks: { total: 1, verified: 0, failed: 0, pending: 1, dispatched: 0 },
        workers: { total: 1, idle: 1, busy: 0, killed: 0, dead: 0 },
        verification: { total: 0, accepted: 0, rejected: 0, avgScore: 0, groundingRate: 0.5 },
        usage: { toolCalls: 0, costUsd: 0 },
      },
    }),
    ...overrides,
  } as SwarmHandle & {
    dispatchGoal: ReturnType<typeof vi.fn>;
    cancelGoal: ReturnType<typeof vi.fn>;
    scalePool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

/** Captures every `write()` call instead of touching a real terminal. */
function fakeStdout(): { stream: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const stream = {
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

describe("runTuiCommand", () => {
  it("--help returns usage mentioning keybindings, code 0, terminal-free", async () => {
    const res = await runTuiCommand(["--help"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("Keybindings");
    expect(text).toContain("q       quit");
    expect(text).toContain("scale worker pool");
  });

  it("unknown subcommand -> code 1 with guidance", async () => {
    const res = await runTuiCommand(["bogus"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Unknown tui argument: bogus");
  });

  it("no args delegates to the interactive loop (once path returns cleanly)", async () => {
    const handle = fakeHandle();
    const { stream } = fakeStdout();
    const res = await runTuiCommand([], {
      factory: () => handle,
      once: true,
      stdout: stream,
    });
    expect(res.code).toBe(0);
    expect(res.lines).toEqual([]);
  });
});

describe("runTuiInteractive (once path)", () => {
  it("renders exactly one real frame containing the swarm state and returns 0 without hanging", async () => {
    const handle = fakeHandle();
    const out = fakeStdout();
    const code = await runTuiInteractive({ factory: () => handle, once: true, stdout: out.stream });

    expect(code).toBe(0);
    const frame = out.text();
    expect(frame).toContain("w1");
    expect(frame).toContain("idle");
    expect(frame).toContain("write the report");
    expect(frame).toContain("WORKERS (1)");
    expect(frame).toContain("TASKS (1)");
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("never touches stdin / raw mode in the once path (it never enters it)", async () => {
    const handle = fakeHandle();
    const out = fakeStdout();
    const setRawMode = vi.fn();
    const fakeStdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode,
      resume: vi.fn(),
      pause: vi.fn(),
      setEncoding: vi.fn(),
    }) as unknown as NodeJS.ReadStream;

    await runTuiInteractive({ factory: () => handle, once: true, stdout: out.stream, stdin: fakeStdin });

    expect(setRawMode).not.toHaveBeenCalled();
  });
});

describe("snapshotToTuiState", () => {
  it("maps workers + tasks + metrics, dropping malformed entries", () => {
    const state = snapshotToTuiState(
      {
        workers: [
          { workerId: "w1", status: "busy", capabilities: ["code"] },
          { garbage: true }, // no workerId/status -> dropped
        ],
        tasks: [
          { description: "ship it", status: "verified" },
          { status: "pending" }, // no description -> dropped
        ],
        metrics: {
          goals: { total: 2, completed: 1, failed: 0, aborted: 0, running: 1 },
          tasks: { total: 2, verified: 1, failed: 0, pending: 1, dispatched: 0 },
          workers: { total: 1, idle: 0, busy: 1, killed: 0, dead: 0 },
          verification: { total: 1, accepted: 1, rejected: 0, avgScore: 0.9, groundingRate: 0.75 },
          usage: { toolCalls: 3, costUsd: 0.01 },
        },
      },
      "inline",
      [{ workerId: "w1", line: "hello" }]
    );

    expect(state.mode).toBe("inline");
    expect(state.workers).toEqual([{ workerId: "w1", status: "busy", capabilities: ["code"] }]);
    expect(state.tasks).toEqual([{ description: "ship it", status: "verified" }]);
    expect(state.groundingRate).toBe(0.75);
    expect(state.logs).toEqual([{ workerId: "w1", line: "hello" }]);
  });

  it("tolerates a snapshot with no workers/tasks/metrics", () => {
    const state = snapshotToTuiState({ workers: [], tasks: [] }, "inline");
    expect(state.workers).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.metrics).toBeUndefined();
    expect(state.groundingRate).toBeUndefined();
  });
});

describe("createSwarmController", () => {
  it("dispatchGoal reaches the handle, and cancel targets the most recently dispatched goal", async () => {
    const handle = fakeHandle();
    const controller = createSwarmController(handle);

    controller.dispatchGoal("write the report");
    // dispatchGoal is fire-and-forget (async); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.dispatchGoal).toHaveBeenCalledWith("write the report");

    controller.cancel();
    await Promise.resolve();
    expect(handle.cancelGoal).toHaveBeenCalledWith("goal-write the report");
  });

  it("scalePool turns a relative delta into an absolute size on the handle", async () => {
    const handle = fakeHandle();
    const controller = createSwarmController(handle, { poolSize: 2 });

    controller.scalePool(1);
    await Promise.resolve();
    expect(handle.scalePool).toHaveBeenLastCalledWith(3);

    controller.scalePool(-5); // clamps at 0, never negative
    await Promise.resolve();
    expect(handle.scalePool).toHaveBeenLastCalledWith(0);
  });

  it("cancel is a no-op until a goal has been dispatched", async () => {
    const handle = fakeHandle();
    const controller = createSwarmController(handle);
    controller.cancel();
    await Promise.resolve();
    expect(handle.cancelGoal).not.toHaveBeenCalled();
  });
});
