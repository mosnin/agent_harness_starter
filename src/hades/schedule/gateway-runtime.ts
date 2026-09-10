/**
 * The gateway <-> scheduler co-runtime: one lifecycle object that runs a
 * real {@link SchedulerRunner} alongside a real {@link GatewayProcess}, with
 * the gateway's own live {@link PlatformConnector}s registered directly as
 * the {@link VerifiedDeliveryRouter}'s `OutboundSender`s.
 *
 * ## Why this file does not reimplement anything
 *
 * `SchedulerRunner` already owns a correct, tested poll loop (`start`/`stop`
 * in `./runner.ts`) and `VerifiedDeliveryRouter` already owns a correct,
 * tested verified-delivery pipeline (`./delivery.ts`), and `PlatformConnector`
 * already structurally satisfies `OutboundSender` (see the compile-time proof
 * in `./delivery.ts`). So this module is pure composition: it constructs the
 * router from the gateway's real connectors with zero adapter code, hands it
 * to a real `SchedulerRunner`, and calls that runner's own `start(pollMs)` —
 * there is no second polling loop anywhere in this file. The only "new"
 * logic here is lifecycle glue: ordering `stop()` correctly, keeping an
 * honest running tally of what actually happened, and OS signal wiring.
 *
 * ## Where the outcome tally actually comes from
 *
 * `ScheduledGatewayRuntimeStatus.outcomes` must never be a synthesized/guessed
 * count. The one place a fire's *final* `RunOutcome` is unambiguous — for
 * every code path in `SchedulerRunner` (delivered, abstained, withheld,
 * failed, or an overlap "skipped") — is the exact `JobRunRecord` handed to
 * `JobStore.recordRun`. `SchedulerEvent`'s own `"delivery"` kind, by
 * contrast, only carries a free-text `detail` string (e.g. `"delivered via
 * slack: ..."`) that does not reliably distinguish delivered from abstained
 * from failed without parsing prose — exactly the kind of fragile inference
 * this codebase's "no fabricated numbers" rule is meant to rule out. So this
 * module wraps the injected `store` in a transparent, pass-through decorator
 * that taps `recordRun`'s real `run.outcome` field and increments the tally
 * from that alone, after the real store has already accepted the write.
 *
 * The same wrapping approach (transparent pass-through, tap-only) is applied
 * to `executor`, paired with the store tap, to track "is there a fire whose
 * executor has started but whose outcome is not yet recorded" — the signal
 * `stop()` awaits before it lets the gateway close its connectors, so a
 * send can never race a closing transport. Neither wrapper touches
 * `deliverer`: per the locked contract, a caller-supplied `deliverer` is
 * used verbatim (that is the seam an integrator uses to interpose their own
 * `JobDeliverer`, e.g. a receipt-ledger-backed one), so it is never wrapped,
 * decorated, or otherwise altered by this module.
 *
 * `SchedulerRunner`'s own module doc notes that its per-job overlap guard
 * "is itself reset on every fresh construction" — so `start()` constructs a
 * brand new `SchedulerRunner` on every transition from stopped to running,
 * exactly mirroring that intended semantics (a runtime that was fully
 * stopped and is starting again gets a clean overlap guard, not one carrying
 * stale in-flight bookkeeping from a previous run).
 */

import { GatewayProcess } from "../gateway/process";
import type { GatewayStatus } from "../gateway/process";
import type { PlatformConnector } from "../gateway/connector";
import type { JobStore, RunOutcome } from "./store";
import { SchedulerRunner } from "./runner";
import type { JobExecutor, SchedulerEvent, TickReport } from "./runner";
import { VerifiedDeliveryRouter } from "./delivery";
import type { JobDeliverer, VerifiedDeliveryOptions } from "./delivery";
import { systemClock } from "./clock";
import type { Clock } from "./clock";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface ScheduledGatewayRuntimeOptions {
  gateway: GatewayProcess;
  connectors: PlatformConnector[];
  store: JobStore;
  executor: JobExecutor;
  clock?: Clock;
  pollMs?: number;
  onUnverified?: "notify" | "withhold";
  maxAttempts?: number;
  backoff?: (attempt: number) => Promise<void>;
  deliverer?: JobDeliverer;
  onEvent?: (e: ScheduledGatewayRuntimeEvent) => void;
}

export type ScheduledGatewayRuntimeEvent = {
  kind: "started" | "stopped" | "scheduler";
  at: number;
  detail: string;
  scheduler?: SchedulerEvent;
};

export interface ScheduledGatewayRuntimeStatus {
  running: boolean;
  startedAt?: number;
  outcomes: Record<RunOutcome, number>;
  schedulerEvents: number;
  lastSchedulerEventAt?: number;
  jobs: number;
  gateway: GatewayStatus;
}

// ===========================================================================
// Small internals
// ===========================================================================

const DEFAULT_POLL_MS = 30_000;

/** All five real `RunOutcome` values, each starting truthfully at zero. */
function zeroOutcomes(): Record<RunOutcome, number> {
  return { delivered: 0, abstained: 0, withheld: 0, failed: 0, skipped: 0 };
}

/**
 * Transparent pass-through `JobStore` decorator. Every method delegates to
 * `inner` untouched; `recordRun` additionally reports the exact `run.outcome`
 * that was just durably written, AFTER `inner.recordRun` has returned
 * successfully (if `inner.recordRun` throws, nothing is tallied — a run
 * that was never actually persisted must never be counted). Deliberately
 * typed off `JobStore`'s own method signatures (`Parameters`/`ReturnType`)
 * rather than importing `NewJobInput`/`JobRunRecord`/`ScheduledJob` — this
 * module only takes `JobStore` and `RunOutcome` from `./store`.
 *
 * Separately from the tally, `onSettled` marks the end of an in-flight fire
 * for the drain bookkeeping, and its rules are deliberately different:
 *
 *  - It fires even when `inner.recordRun` THROWS (the error still
 *    propagates). `SchedulerRunner.safeRecordRun` swallows a hostile store's
 *    throw into `TickReport.errors` and moves on — if the drain marker were
 *    only cleared on a successful write, one failed persist would leave a
 *    phantom in-flight fire behind and `stop()` would hang forever.
 *  - It does NOT fire for an `outcome === "skipped"` record. The only
 *    producer of a `"skipped"` run is `SchedulerRunner`'s overlap guard,
 *    which records it for a job whose PREVIOUS fire is still genuinely in
 *    flight — treating that bookkeeping write as "the fire finished" would
 *    release the drain while the real send is still racing a connector
 *    `stop()`, the exact bug the drain exists to prevent.
 */
class TallyingJobStore implements JobStore {
  constructor(
    private readonly inner: JobStore,
    private readonly onRecorded: (jobId: string, outcome: RunOutcome) => void,
    private readonly onSettled: (jobId: string) => void,
  ) {}

  list(): ReturnType<JobStore["list"]> {
    return this.inner.list();
  }

  get(id: string): ReturnType<JobStore["get"]> {
    return this.inner.get(id);
  }

  add(input: Parameters<JobStore["add"]>[0]): ReturnType<JobStore["add"]> {
    return this.inner.add(input);
  }

  update(
    id: string,
    patch: Parameters<JobStore["update"]>[1],
    expectedRevision?: Parameters<JobStore["update"]>[2],
  ): ReturnType<JobStore["update"]> {
    return this.inner.update(id, patch, expectedRevision);
  }

  remove(id: string): ReturnType<JobStore["remove"]> {
    return this.inner.remove(id);
  }

  recordRun(id: string, run: Parameters<JobStore["recordRun"]>[1]): ReturnType<JobStore["recordRun"]> {
    try {
      const updated = this.inner.recordRun(id, run);
      this.onRecorded(id, run.outcome);
      return updated;
    } finally {
      // See the class doc: settle even on a store throw (SchedulerRunner
      // swallows it and the fire IS over), but never for an overlap
      // "skipped" record (the real fire it reports on is still running).
      if (run.outcome !== "skipped") this.onSettled(id);
    }
  }

  loadReport(): ReturnType<JobStore["loadReport"]> {
    return this.inner.loadReport();
  }
}

/**
 * Transparent pass-through `JobExecutor` decorator: delegates `execute`
 * verbatim to `inner`, additionally reporting that a fire for `job.id` has
 * begun (before awaiting `inner.execute`, so the report reflects the true
 * start of work, not its completion). Paired with {@link TallyingJobStore}'s
 * `recordRun` tap, this brackets exactly the span `stop()` must drain before
 * it is safe to close the gateway's connectors — including the delivery
 * attempt, which happens strictly after `execute` returns and strictly
 * before `recordRun` is called, for every code path in `SchedulerRunner`.
 */
class TrackingExecutor implements JobExecutor {
  constructor(
    private readonly inner: JobExecutor,
    private readonly onStart: (jobId: string) => void,
  ) {}

  execute(
    job: Parameters<JobExecutor["execute"]>[0],
    ctx: Parameters<JobExecutor["execute"]>[1],
  ): ReturnType<JobExecutor["execute"]> {
    this.onStart(job.id);
    return this.inner.execute(job, ctx);
  }
}

// ===========================================================================
// ScheduledGatewayRuntime
// ===========================================================================

export class ScheduledGatewayRuntime {
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly deliverer: JobDeliverer;
  private readonly trackingExecutor: TrackingExecutor;
  private readonly tallyingStore: TallyingJobStore;

  private readonly tally: Record<RunOutcome, number> = zeroOutcomes();
  private schedulerEvents = 0;
  private lastSchedulerEventAt: number | undefined;

  private running = false;
  private startedAt: number | undefined;
  private runner: SchedulerRunner | undefined;

  /** Per-job count of fires whose `execute()` has started but whose outcome
   *  has not yet settled at the store — the exact bookkeeping `stop()`
   *  drains to zero before closing the gateway. A refcount (not a set)
   *  because a manual `runOnce` can legitimately overlap a tick fire of the
   *  same job id. */
  private readonly inFlightFires = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];
  private idleCheckScheduled = false;

  constructor(private readonly opts: ScheduledGatewayRuntimeOptions) {
    if (!opts || !Array.isArray(opts.connectors)) {
      throw new TypeError("ScheduledGatewayRuntime: opts.connectors must be an array of PlatformConnector");
    }
    if (!opts.gateway) {
      throw new TypeError("ScheduledGatewayRuntime: opts.gateway is required");
    }
    if (!opts.store) {
      throw new TypeError("ScheduledGatewayRuntime: opts.store is required");
    }
    if (!opts.executor) {
      throw new TypeError("ScheduledGatewayRuntime: opts.executor is required");
    }

    this.clock = opts.clock ?? systemClock;
    const rawPollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.pollMs = Number.isFinite(rawPollMs) && rawPollMs > 0 ? rawPollMs : DEFAULT_POLL_MS;

    // The one and only adapter-free wiring: the gateway's own connectors,
    // handed straight to VerifiedDeliveryRouter as OutboundSenders. Used
    // verbatim when the caller supplies their own deliverer — see the
    // module doc for why that seam is never wrapped.
    this.deliverer =
      opts.deliverer ??
      new VerifiedDeliveryRouter({
        senders: opts.connectors,
        clock: this.clock,
        onUnverified: opts.onUnverified,
        maxAttempts: opts.maxAttempts,
        backoff: opts.backoff,
      } satisfies VerifiedDeliveryOptions);

    this.trackingExecutor = new TrackingExecutor(opts.executor, (jobId) => this.markStart(jobId));
    this.tallyingStore = new TallyingJobStore(
      opts.store,
      (_jobId, outcome) => {
        this.tally[outcome] += 1;
      },
      (jobId) => this.markSettled(jobId),
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Idempotent: a second call while already running is a no-op that just
   * returns the current status (mirrors `GatewayProcess.start()`'s own
   * idempotency, which this method also delegates into). Starts the gateway
   * first, then constructs a fresh `SchedulerRunner` and arms its real
   * `start(pollMs)` poll loop — never a second, hand-rolled loop here.
   */
  async start(): Promise<ScheduledGatewayRuntimeStatus> {
    if (this.running) {
      return this.status();
    }

    await this.opts.gateway.start();

    this.runner = new SchedulerRunner({
      store: this.tallyingStore,
      clock: this.clock,
      executor: this.trackingExecutor,
      deliverer: this.deliverer,
      onEvent: (e) => this.handleSchedulerEvent(e),
    });
    this.runner.start(this.pollMs);

    this.running = true;
    this.startedAt = this.clock.now();
    this.emit({
      kind: "started",
      at: this.startedAt,
      detail: `scheduled gateway runtime started (pollMs=${this.pollMs})`,
    });

    return this.status();
  }

  /**
   * Idempotent, and safe to call before `start()` (a no-op). Stops the
   * `SchedulerRunner`'s poll loop FIRST — so no new tick can begin — then
   * awaits every already-in-flight fire (executor started but outcome not
   * yet recorded; see {@link TrackingExecutor} / {@link TallyingJobStore})
   * to actually finish, and only THEN stops the gateway. That ordering is
   * the whole point: a send can never race a connector `stop()` closing out
   * from under it.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;

    this.runner?.stop();
    await this.drain();
    await this.opts.gateway.stop();

    this.emit({
      kind: "stopped",
      at: this.clock.now(),
      detail: "scheduled gateway runtime stopped",
    });
  }

  /**
   * Fire one tick immediately, delegating to the real `SchedulerRunner.tick()`
   * — the exact same tick logic the poll loop uses. Works whether or not the
   * poll loop is currently running; lazily constructs a runner on first use
   * if `start()` has never been called (so a caller can drive ticks by hand
   * without ever starting the gateway or the poll loop).
   */
  async tickNow(): Promise<TickReport> {
    return this.ensureRunner().tick();
  }

  status(): ScheduledGatewayRuntimeStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      outcomes: { ...this.tally },
      schedulerEvents: this.schedulerEvents,
      lastSchedulerEventAt: this.lastSchedulerEventAt,
      jobs: this.opts.store.list().length,
      gateway: this.opts.gateway.status(),
    };
  }

  /**
   * Register SIGINT + SIGTERM handlers on `proc` that call `stop()`, and
   * return an uninstaller that removes exactly those two handlers. Never
   * touches the global `process` object unless the caller hands it in here
   * — mirrors `GatewayProcess.installSignalHandlers` exactly.
   */
  installSignalHandlers(proc: { on(sig: string, cb: () => void): unknown }): () => void {
    const onSignal = (): void => {
      void this.stop();
    };
    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
    return () => {
      const removable = proc as unknown as {
        off?: (sig: string, cb: () => void) => unknown;
        removeListener?: (sig: string, cb: () => void) => unknown;
      };
      const remove = removable.off ?? removable.removeListener;
      remove?.call(proc, "SIGINT", onSignal);
      remove?.call(proc, "SIGTERM", onSignal);
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureRunner(): SchedulerRunner {
    if (!this.runner) {
      this.runner = new SchedulerRunner({
        store: this.tallyingStore,
        clock: this.clock,
        executor: this.trackingExecutor,
        deliverer: this.deliverer,
        onEvent: (e) => this.handleSchedulerEvent(e),
      });
    }
    return this.runner;
  }

  private handleSchedulerEvent(e: SchedulerEvent): void {
    this.schedulerEvents += 1;
    this.lastSchedulerEventAt = e.at;
    this.emit({ kind: "scheduler", at: e.at, detail: e.detail, scheduler: e });
  }

  private emit(e: ScheduledGatewayRuntimeEvent): void {
    this.opts.onEvent?.(e);
  }

  private markStart(jobId: string): void {
    this.inFlightFires.set(jobId, (this.inFlightFires.get(jobId) ?? 0) + 1);
  }

  private markSettled(jobId: string): void {
    const count = this.inFlightFires.get(jobId);
    if (count === undefined) return;
    if (count <= 1) this.inFlightFires.delete(jobId);
    else this.inFlightFires.set(jobId, count - 1);
    if (this.inFlightFires.size === 0) this.scheduleIdleCheck();
  }

  /**
   * Resolve drain waiters on a macrotask, not synchronously: when a tick is
   * firing a multi-instant catch-up backlog, the moment between one instant's
   * `recordRun` and the next instant's `execute()` looks idle even though the
   * tick is still mid-backlog. The next `execute()` (and its `markStart`)
   * happens on the microtask queue ahead of any `setTimeout(0)` macrotask, so
   * re-checking after one macrotask never releases the drain mid-backlog.
   */
  private scheduleIdleCheck(): void {
    if (this.idleCheckScheduled || this.idleWaiters.length === 0) return;
    this.idleCheckScheduled = true;
    setTimeout(() => {
      this.idleCheckScheduled = false;
      if (this.inFlightFires.size !== 0) return;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }, 0);
  }

  private async drain(): Promise<void> {
    if (this.inFlightFires.size === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
      // A fire may have settled before this waiter registered (waiters were
      // empty then, so no check was armed) — re-arm rather than strand it.
      if (this.inFlightFires.size === 0) this.scheduleIdleCheck();
    });
  }
}
