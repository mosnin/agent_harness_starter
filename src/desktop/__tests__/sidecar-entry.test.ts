import { describe, it, expect } from "vitest";
import { runSidecar } from "../sidecar-entry";
import { decodeEvent, encodeCommand } from "../ipc/contract";
import type { AppEvent, Command, RunView, TaskView, WorkerView } from "../ipc/contract";
import type { SwarmFactory, SwarmHandle } from "../core/sidecar";

// ---------------------------------------------------------------------------
// A scripted fake swarm handle/factory. No real engine (`buildSwarm` /
// `SwarmManager`) is ever touched by this test — that's the whole point of
// `Sidecar` accepting a `factory` override. The fake is intentionally a
// little bit stateful (dispatchGoal populates what snapshot() later reports)
// so the resulting AppEvent stream reads like a real, if instant, goal run.
// ---------------------------------------------------------------------------

function makeFakeHandle(): SwarmHandle & { closed: boolean } {
  const worker: WorkerView = { id: "w-1", status: "idle", capabilities: ["general"] };
  const task: TaskView = {
    id: "t-1",
    description: "do the thing",
    status: "verified",
    requiredCapabilities: [],
    attempts: 1,
    maxAttempts: 3,
  };
  const goals: RunView[] = [];

  const handle: SwarmHandle & { closed: boolean } = {
    closed: false,
    dispatchGoal(objective: string) {
      const goalId = "g-fake-1";
      // Simulate a goal that finishes instantly, so the next poll() sees it
      // as "completed" even though `handle` (below) already emitted a
      // "running" upsert synchronously right after dispatch.
      goals.push({ goalId, objective, status: "completed" });
      return { goalId };
    },
    snapshot() {
      return {
        workers: [worker],
        tasks: [task],
        goals: [...goals],
        verifications: [],
      };
    },
    close() {
      handle.closed = true;
    },
  };
  return handle;
}

function makeFakeFactory(): { factory: SwarmFactory; handle: SwarmHandle & { closed: boolean } } {
  const handle = makeFakeHandle();
  const factory: SwarmFactory = ({ mode, poolSize }) => {
    void mode;
    void poolSize;
    return handle;
  };
  return { factory, handle };
}

/** Feeds an async iterable of already-newline-terminated command lines. */
async function* fakeInput(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sidecar-entry / runSidecar", () => {
  it("turns a start/dispatch/stop command sequence into a sensible AppEvent stream", async () => {
    const { factory, handle } = makeFakeFactory();

    const commands: Command[] = [
      { kind: "runtime.start", mode: "inline", poolSize: 2 },
      { kind: "goal.dispatch", objective: "ship the feature" },
      { kind: "runtime.stop" },
    ];

    const outputLines: string[] = [];
    await runSidecar(fakeInput(commands.map(encodeCommand)), (line) => outputLines.push(line), {
      factory,
    });

    expect(outputLines.length).toBeGreaterThan(0);

    // Every emitted line must be valid, decodable AppEvent JSON — this is
    // the contract's own codec doing the checking, not a hand-rolled shape
    // check, so it catches anything the sidecar got structurally wrong.
    const events: AppEvent[] = outputLines.map((line) => decodeEvent(line));

    // Sensible order, part 1: runtime.start must be reflected before
    // anything else — the very first event is the runtime coming up.
    expect(events[0]).toMatchObject({ kind: "runtime.status", running: true, mode: "inline", poolSize: 2 });

    // Sensible order, part 2: the dispatched goal shows up as a run.upsert
    // strictly after the runtime came up, and strictly before the runtime
    // goes back down.
    const runIndices = events.reduce<number[]>((acc, e, i) => {
      if (e.kind === "run.upsert") acc.push(i);
      return acc;
    }, []);
    expect(runIndices.length).toBeGreaterThan(0);
    for (const i of runIndices) {
      expect(i).toBeGreaterThan(0);
      expect(i).toBeLessThan(events.length - 1);
      expect(events[i]).toMatchObject({ kind: "run.upsert", run: { goalId: "g-fake-1" } });
    }

    // A worker.upsert and task.upsert must have made it through too (the
    // fake snapshot always reports one of each).
    expect(events.some((e) => e.kind === "worker.upsert")).toBe(true);
    expect(events.some((e) => e.kind === "task.upsert")).toBe(true);

    // Sensible order, part 3: the very last event is the runtime shutting
    // back down, and the fake handle actually got torn down.
    expect(events[events.length - 1]).toMatchObject({ kind: "runtime.status", running: false });
    expect(handle.closed).toBe(true);
  });

  it("turns a malformed input line into a log AppEvent instead of crashing", async () => {
    const { factory } = makeFakeFactory();

    const lines = [
      "not json at all\n",
      "{\"kind\":\"totally.unknown\"}\n",
      encodeCommand({ kind: "runtime.stop" }),
    ];

    const outputLines: string[] = [];
    await expect(
      runSidecar(fakeInput(lines), (line) => outputLines.push(line), { factory })
    ).resolves.toBeUndefined();

    expect(outputLines.length).toBeGreaterThan(0);
    const events: AppEvent[] = outputLines.map((line) => decodeEvent(line));

    // Both bad lines become log events, in order, before anything else.
    expect(events[0].kind).toBe("log");
    expect(events[1].kind).toBe("log");
    if (events[0].kind === "log") expect(events[0].line).toMatch(/malformed command/i);
    if (events[1].kind === "log") expect(events[1].line).toMatch(/malformed command/i);

    // The well-formed runtime.stop that follows is still processed — a
    // malformed line never aborts the stream.
    expect(events.some((e) => e.kind === "runtime.status" && e.running === false)).toBe(true);
  });

  it("line-buffers a raw chunk stream that splits a command across chunk boundaries", async () => {
    const { factory } = makeFakeFactory();
    const full = encodeCommand({ kind: "runtime.stop" });
    const splitAt = Math.floor(full.length / 2);

    async function* chunkedInput(): AsyncGenerator<string> {
      yield full.slice(0, splitAt);
      yield full.slice(splitAt);
    }

    const outputLines: string[] = [];
    await runSidecar(chunkedInput(), (line) => outputLines.push(line), { factory });

    const events: AppEvent[] = outputLines.map((line) => decodeEvent(line));
    expect(events.some((e) => e.kind === "runtime.status" && e.running === false)).toBe(true);
  });
});
