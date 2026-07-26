/**
 * End-to-end proof: the desktop sidecar genuinely drives the REAL swarm.
 *
 * Every other `src/desktop/__tests__/sidecar.test.ts` test scripts a fake
 * `SwarmHandle` so `Sidecar`'s own logic is deterministic and isolated. This
 * file is the opposite: it wires `Sidecar` to `realSwarmFactory()`, which
 * builds an actual `SwarmManager` (`src/swarm-runtime/manager/manager.ts`)
 * via `buildSwarm({ mode: "inline" })` (`src/swarm-runtime/server/build-swarm.ts`).
 * No mocks of the engine anywhere in this file.
 *
 * It stays headless, key-free, and offline because inline mode with no
 * `SWARM_API_KEY`/`OPENAI_API_KEY` set falls back to the engine's own
 * deterministic, non-network defaults:
 *  - `DeterministicPlanner` (`src/swarm-runtime/manager/planner.ts`) plans
 *    the goal without an LLM.
 *  - `DemoExecutor` (`src/swarm-runtime/worker/executor.ts`) is what each
 *    inline `WorkerRuntime` runs when no executor is injected — a mock
 *    executor that does real, traceable "tool calls" (deterministic text
 *    analysis) and emits grounded claims, so it exercises the full
 *    verification gate honestly without pretending to be an LLM.
 *
 * That means this test proves the wiring — Sidecar -> SwarmHandle ->
 * SwarmManager -> planner -> workers -> verification gate -> snapshot ->
 * IPC view mapping -> AppEvent stream -> reducer — actually works, without
 * needing network access or API keys.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Sidecar, realSwarmFactory } from "../core/sidecar";
import { isAppEvent, type AppEvent } from "../ipc/contract";
import { initialState, reduce, selectors } from "../core/app-store";

const POOL_SIZE = 2;

/** Poll a condition against the real (not faked) event stream until it holds. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("e2e: sidecar drives the real inline swarm headlessly (no display, no keys, mock executor)", () => {
  let sidecar: Sidecar | undefined;

  afterEach(async () => {
    // Belt-and-suspenders: even if a test already sent runtime.stop, close()
    // is idempotent-safe (no-op once the handle is already torn down) and
    // guarantees no swarm handle, worker, or timer survives the test.
    await sidecar?.close();
    sidecar = undefined;
  });

  it(
    "runtime.start -> goal.dispatch -> runtime.stop against realSwarmFactory() produces a coherent AppEvent stream and reduces to sane AppState",
    async () => {
      const events: AppEvent[] = [];
      sidecar = new Sidecar({
        // The real engine factory — not a scripted fake. This is the crux of
        // the "does it actually work" proof.
        factory: realSwarmFactory(),
        emit: (e) => events.push(e),
      });

      const startedAt = Date.now();

      await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: POOL_SIZE });
      await sidecar.handle({
        kind: "goal.dispatch",
        objective: "Summarize the repo architecture in one sentence.",
      });

      // The inline swarm runs entirely on in-process promises/microtasks (no
      // real network, no real container boundary), so a goal through the
      // deterministic planner + mock DemoExecutor finishes in well under a
      // second in practice. Give it a generous but bounded real-time budget
      // rather than a fixed sleep, and poll the actual emitted stream.
      await waitFor(() => events.some((e) => e.kind === "run.upsert" && e.run.status !== "running"), {
        timeoutMs: 8000,
      });

      await sidecar.handle({ kind: "runtime.stop" });

      await waitFor(() => events.some((e) => e.kind === "runtime.status" && e.running === false), {
        timeoutMs: 5000,
      });

      const elapsedMs = Date.now() - startedAt;

      // ── 1. Every emitted line is a well-formed AppEvent per the wire contract ──
      for (const e of events) {
        expect(isAppEvent(e)).toBe(true);
      }

      // ── 2. The stream is real and coherent ──────────────────────────────────
      const runtimeStatuses = events.filter(
        (e): e is Extract<AppEvent, { kind: "runtime.status" }> => e.kind === "runtime.status"
      );
      expect(runtimeStatuses.some((e) => e.running === true)).toBe(true);
      expect(runtimeStatuses.some((e) => e.running === false)).toBe(true);
      // Terminal stop status must come after the initial start status, and it
      // must be the last runtime.status observed.
      const firstStartIdx = events.findIndex((e) => e.kind === "runtime.status" && e.running === true);
      const lastStopIdx = events.map((e) => e.kind).lastIndexOf("runtime.status");
      expect(firstStartIdx).toBeGreaterThanOrEqual(0);
      expect(events[lastStopIdx]).toEqual(
        expect.objectContaining({ kind: "runtime.status", running: false })
      );
      expect(lastStopIdx).toBeGreaterThan(firstStartIdx);

      const taskEvents = events.filter((e): e is Extract<AppEvent, { kind: "task.upsert" }> => e.kind === "task.upsert");
      expect(taskEvents.length).toBeGreaterThan(0);

      const metricsEvents = events.filter((e): e is Extract<AppEvent, { kind: "metrics" }> => e.kind === "metrics");
      expect(metricsEvents.length).toBeGreaterThan(0);

      const runEvents = events.filter((e): e is Extract<AppEvent, { kind: "run.upsert" }> => e.kind === "run.upsert");
      expect(runEvents.length).toBeGreaterThan(0);
      // The goal reached a real terminal state (completed/failed/cancelled) —
      // it did not just sit "running" forever, and there is exactly one goal.
      const goalIds = new Set(runEvents.map((e) => e.run.goalId));
      expect(goalIds.size).toBe(1);
      const finalRunStatus = runEvents[runEvents.length - 1].run.status;
      expect(["completed", "failed", "cancelled"]).toContain(finalRunStatus);
      // With the deterministic planner + the mock DemoExecutor's grounded,
      // high-confidence claims, the verification gate should accept every
      // task and the goal should genuinely complete — this is the "does it
      // actually work" bar, not just "did it terminate somehow".
      expect(finalRunStatus).toBe("completed");

      // Worker activity was real too: at least one worker.upsert was emitted
      // for the pool `runtime.start` requested.
      const workerEvents = events.filter(
        (e): e is Extract<AppEvent, { kind: "worker.upsert" }> => e.kind === "worker.upsert"
      );
      expect(workerEvents.length).toBeGreaterThan(0);
      expect(new Set(workerEvents.map((e) => e.worker.id)).size).toBeLessThanOrEqual(POOL_SIZE);

      // ── 3. Feed the collected events through the real reducer ──────────────
      let state = initialState();
      for (const e of events) state = reduce(state, e);

      expect(state.running).toBe(false); // reflects the post-stop runtime.status
      expect(state.tasks.length).toBeGreaterThan(0);
      expect(state.tasks.every((t) => t.status === "verified")).toBe(true);
      expect(state.runs.length).toBe(1);
      expect(state.runs[0].status).toBe("completed");

      // selectors.liveWorkerCount reflects the pool runtime.start asked for:
      // the sidecar never emits a final worker snapshot after stop (onStop
      // only closes the handle and emits runtime.status), so the reduced
      // state still reflects the workers as last observed while running —
      // exactly POOL_SIZE of them, none killed/dead.
      expect(state.workers.length).toBe(POOL_SIZE);
      expect(selectors.liveWorkerCount(state)).toBe(POOL_SIZE);

      // No NaN/Infinity anywhere in the reduced metrics — every field the
      // real engine's SwarmMetrics fed through toMetricsView is finite.
      expect(state.metrics).not.toBeNull();
      const metrics = state.metrics!;
      for (const [key, value] of Object.entries(metrics)) {
        expect(Number.isFinite(value), `metrics.${key} should be finite, got ${value}`).toBe(true);
        expect(Number.isNaN(value), `metrics.${key} should not be NaN`).toBe(false);
      }
      expect(metrics.goalsCompleted).toBe(1);
      expect(metrics.goalsTotal).toBe(1);
      expect(metrics.verifiedTasks).toBe(state.tasks.length);
      expect(metrics.rejectedTasks).toBe(0);

      // No silent-wrong contradictions: with the mock (but honestly grounded)
      // DemoExecutor and a single goal, every verification report on record
      // should be an outright "accept" — no rejects/revises hiding behind a
      // goal that nonetheless reports "completed".
      expect(state.verifications.length).toBeGreaterThan(0);
      expect(state.verifications.every((v) => v.verdict === "accept")).toBe(true);

      // ── 4. Sanity on timing: this genuinely ran the real engine end to end
      // inline (no fixed sleeps drove the assertions above), and did so well
      // inside the bounded budget.
      expect(elapsedMs).toBeLessThan(8000);
    },
    15_000
  );

  it("runtime.stop before any goal is dispatched still cleanly tears down the real swarm (no hang, no leaked handle)", async () => {
    const events: AppEvent[] = [];
    sidecar = new Sidecar({ factory: realSwarmFactory(), emit: (e) => events.push(e) });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await waitFor(() => events.some((e) => e.kind === "worker.upsert"), { timeoutMs: 5000 });

    await sidecar.handle({ kind: "runtime.stop" });

    for (const e of events) expect(isAppEvent(e)).toBe(true);
    expect(events[events.length - 1]).toEqual({
      kind: "runtime.status",
      running: false,
      mode: "inline",
      poolSize: 1,
    });
  }, 10_000);
});
