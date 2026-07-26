/**
 * @module swarm-runtime/distributed/cluster-node
 *
 * Phase 18 — the per-machine half of the multi-node manager.
 *
 * A {@link ClusterNode} is the object that actually runs on one machine in a
 * cluster: it joins SWIM membership ({@link ClusterMembership}), advertises
 * its live capacity, and executes leased tasks on a REAL local
 * {@link SwarmManager} — the same manager class used for a single-machine
 * swarm, with its real worker pool and real {@link VerificationGate}. There is
 * no separate "distributed executor": a leased task is driven through
 * `manager.startGoal()` exactly like any other goal, using a
 * {@link LeasedTaskPlanner} that materializes precisely the one task the
 * lease names. This is what makes the trust properties of the single-machine
 * swarm (grounding checks, anti-rogue guardrails) apply unmodified in the
 * clustered case — the cluster layer never bypasses the gate.
 *
 * ── Routing a lease through a live manager ────────────────────────────────
 * `SwarmManager` picks its `Planner` once, in its constructor, and the field
 * is `private readonly` — there is no supported API to hand it a different
 * planner per call. `private`/`readonly` are compile-time-only in TypeScript,
 * so `execute()` installs a fresh {@link LeasedTaskPlanner} onto the *same*
 * manager instance immediately before calling `startGoal()`, through a plain
 * property write on a differently-typed view of the object (an accepted,
 * narrow use of the erasure of TS visibility — never a `Function`/`eval`
 * trick, never touching anything but the one documented field). Reading the
 * manager's source shows this is safe: `startGoal` reads `this.planner`
 * exactly once, synchronously, as part of invoking `executeGoal()` — and that
 * read happens on the same synchronous turn that follows `startGoal`'s own
 * `await ensurePool()`, i.e. before `startGoal`'s promise can resolve. So as
 * long as nothing else swaps the planner while a `startGoal()` call is
 * in-flight, each call sees exactly the planner installed for it. `execute()`
 * therefore serializes "install planner → call startGoal → planner consumed"
 * behind a small internal mutex (`withPlanningLock`); everything downstream
 * of that hand-off — dispatch, worker execution, gate verification — runs
 * fully concurrently across leased tasks, sharing the one real worker pool.
 *
 * ── Identity across the hand-off ───────────────────────────────────────────
 * The manager mints its own internal task id (`materializeTasks` assigns a
 * fresh `randomUUID()`), which is *not* the cluster-wide `lease.taskId`. Every
 * outcome this module returns relabels `result.taskId` / `report.taskId` to
 * `lease.taskId` before handing it back, so a downstream `FederatedResultEntry`
 * built directly from a {@link LeasedTaskOutcome} satisfies the ledger's
 * `result.taskId === entry.taskId` / `report.taskId === entry.taskId`
 * invariant without any extra plumbing.
 *
 * ── Crash vs. graceful leave ───────────────────────────────────────────────
 * `crash()` is a hard stop: no membership update, no more renewals, in-flight
 * leases are simply abandoned (never handed back) — this is deliberate, since
 * a real crash can't hand anything back either. It is the leader's job (a
 * different component) to notice this node has gone silent via SWIM
 * suspect/dead timeouts and reclaim the lease once it expires.
 * `drain()`/`leave()` are the opposite: they update membership honestly (a
 * real `left` gossip entry) and hand back whatever didn't finish in time.
 */

import { EventEmitter } from "node:events";

import type { WorkerResult, WorkerTask, VerificationReport, Goal } from "../types";
import { SwarmManager } from "../manager/manager";
import type { Planner, PlannedTask } from "../manager/planner";
import type { VerificationGate } from "../verification/gate";
import {
  ClusterMembership,
  type GossipDigest,
  type NodeDescriptor,
  type NodeState,
} from "./membership";
import type { Lease } from "./lease-ledger";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  type CertificatePayload,
  type VerificationCertificate,
} from "../../hades/styx/certificate";

/** The real gate every leased task is verified against — `manager.startGoal`
 *  routes through it unmodified; kept as a type-only reference so this
 *  module's dependency on the real gate (not a mock) is explicit and
 *  type-checked. */
export type LeasedTaskGate = VerificationGate;

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export interface LeasedTaskOutcome {
  taskId: string;
  nodeId: string;
  fencing: number;
  result: WorkerResult;
  report: VerificationReport;
  certificate?: VerificationCertificate;
  outputText: string;
  startedAt: number;
  finishedAt: number;
}

export interface ClusterNodeSnapshot {
  nodeId: string;
  health: "alive" | "draining" | "left" | "crashed";
  inFlight: Array<{ taskId: string; fencing: number; startedAt: number }>;
  liveWorkers: number;
  load: number;
  completed: number;
  handedBack: number;
  abandoned: number;
  epoch: number;
  leaderId: string | null;
}

export interface ClusterNodeOptions {
  descriptor: NodeDescriptor;
  manager: SwarmManager;
  membership?: ClusterMembership;
  certificateAuthority?: CertificateAuthority;
  now?: () => number;
  maxConcurrentTasks?: number;
  leaseRenewMs?: number;
  taskTimeoutMs?: number;
  drainTimeoutMs?: number;
  /**
   * The conformal bound recorded on issued certificates. Defaults to 0 —
   * this layer runs no conformal calibration, so it will not name a bound it
   * did not establish. Pass a value only if YOUR calibration justifies it.
   */
  epsilon?: number;
}

export interface ClusterNodeEvents {
  "task:started": (taskId: string) => void;
  "task:completed": (outcome: LeasedTaskOutcome) => void;
  "task:handback": (taskId: string, reason: string) => void;
  "task:abandoned": (taskId: string, reason: string) => void;
  "node:draining": (reason: string) => void;
  "node:crashed": (reason: string) => void;
  "lease:renew-due": (taskId: string, fencing: number) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_RENEW_MS = 5_000;
const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
/**
 * `CertificatePayload.epsilon` means "the conformal bound the abstention gate
 * enforced" — i.e. a claimed ceiling on P(this output is wrong). The swarm's
 * `VerificationGate` enforces an `acceptThreshold` on a weighted grounding
 * score; it runs NO conformal calibration and establishes NO such bound. So
 * the default here is 0, matching the convention `hades/mcp/cert-handoff.ts`
 * documents for the same situation: the gate already applied its own accept
 * bar before returning "accept", and this layer adds no further conformal
 * slack it could honestly name. A nonzero default would be a fabricated
 * guarantee — and a consequential one, because downstream consumers
 * (`hades/skills/synthesize.ts`) admit a certificate on `pCorrect >= 1 -
 * epsilon`, so an invented epsilon would widen a real admission gate on the
 * strength of a bound nobody computed. Callers that HAVE run a real
 * calibration may pass their own `epsilon`; doing so is an explicit assertion
 * about their own evidence, not this module's.
 */
const DEFAULT_EPSILON = 0;
const DEFAULT_MAX_CONCURRENT_TASKS = 4;

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface InFlightEntry {
  taskId: string;
  fencing: number;
  startedAt: number;
  lastRenewAt: number;
  goalId?: string;
  promise: Promise<LeasedTaskOutcome>;
  resolve: (outcome: LeasedTaskOutcome) => void;
  reject: (err: Error) => void;
  /** Detaches any manager listeners / timers this execution installed. Safe
   *  to call more than once and safe to call before anything was attached. */
  cleanup: () => void;
}

function compositeKey(taskId: string, fencing: number): string {
  return `${taskId}::${fencing}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Deterministic, key-sorted JSON — matches the canonicalization style used
 *  across the distributed layer (membership checksums, lease-ledger
 *  signatures) so output text is stable regardless of property insertion
 *  order. Independent from `VerifiedResultLedger`'s private helper of the
 *  same shape; the certificate binds whatever string this produces, and the
 *  ledger is handed that exact string, so the two never need to agree on an
 *  algorithm — only on the resulting bytes for a given call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    return out === undefined ? "null" : out;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Canonical text form of a worker's output — what the certificate binds. */
function canonicalOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function syntheticResult(taskId: string, workerId: string, errorMessage: string, at: number): WorkerResult {
  return { taskId, workerId, output: null, claims: [], toolTrace: [], startedAt: at, finishedAt: at, error: errorMessage };
}

function syntheticReport(taskId: string, workerId: string, feedback: string, at: number): VerificationReport {
  return {
    taskId,
    workerId,
    verdict: "reject",
    score: 0,
    checks: [{ name: "cluster-node-synthetic", passed: false, weight: 1, detail: feedback }],
    feedback,
    at,
  };
}

/**
 * Installs `planner` as `manager`'s active planner for the next `startGoal()`
 * call. `SwarmManager.planner` is declared `private readonly`, but that is a
 * compile-time annotation only — see the module doc comment for why this
 * write is safe under `execute()`'s planning mutex.
 */
function installPlanner(manager: SwarmManager, planner: Planner): void {
  (manager as unknown as { planner: Planner }).planner = planner;
}

// ---------------------------------------------------------------------------
// LeasedTaskPlanner
// ---------------------------------------------------------------------------

/**
 * A `Planner` that ignores the objective/capabilities it's called with and
 * always returns exactly one `PlannedTask` that materializes the leased
 * `WorkerTask` verbatim (description, requiredCapabilities, input, and — if
 * present — its consensus policy). This is what makes the leased task pass
 * through the manager's real dispatch → worker pool → verification gate
 * pipeline unmodified: nothing about the task is synthesized or summarized.
 */
export class LeasedTaskPlanner implements Planner {
  constructor(private readonly task: WorkerTask) {}

  async plan(_objective: string, _capabilities: string[]): Promise<PlannedTask[]> {
    const t = this.task;
    const planned: PlannedTask = {
      description: t.description,
      requiredCapabilities: [...t.requiredCapabilities],
      input: { ...t.input },
      dependsOn: [],
      priority: t.priority,
    };
    if (t.consensus) planned.consensus = t.consensus;
    return [planned];
  }
}

// ---------------------------------------------------------------------------
// ClusterNode
// ---------------------------------------------------------------------------

export class ClusterNode extends EventEmitter {
  readonly nodeId: string;

  private readonly descriptor: NodeDescriptor;
  private readonly manager: SwarmManager;
  private readonly membership_: ClusterMembership;
  private readonly certificateAuthority: CertificateAuthority;
  private readonly nowFn: () => number;
  private readonly maxConcurrentTasks: number;
  private readonly leaseRenewMs: number;
  private readonly taskTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly epsilon: number;

  private health: ClusterNodeSnapshot["health"] = "alive";
  private isShutDown = false;
  private started = false;

  private readonly inFlight = new Map<string, InFlightEntry>();
  private completedCount = 0;
  private handedBackCount = 0;
  private abandonedCount = 0;

  private renewalTimer?: ReturnType<typeof setInterval>;
  private planningMutex: Promise<void> = Promise.resolve();

  constructor(opts: ClusterNodeOptions) {
    super();
    this.setMaxListeners(0);

    this.descriptor = opts.descriptor;
    this.nodeId = opts.descriptor.nodeId;
    this.manager = opts.manager;
    this.nowFn = opts.now ?? Date.now;

    const maxConcurrentTasks = opts.maxConcurrentTasks ?? opts.descriptor.capacity.maxWorkers ?? DEFAULT_MAX_CONCURRENT_TASKS;
    if (opts.maxConcurrentTasks !== undefined && !(opts.maxConcurrentTasks > 0)) {
      throw new RangeError("ClusterNode: maxConcurrentTasks must be > 0");
    }
    this.maxConcurrentTasks = Math.max(0, maxConcurrentTasks);

    const leaseRenewMs = opts.leaseRenewMs ?? DEFAULT_LEASE_RENEW_MS;
    if (!(leaseRenewMs > 0)) throw new RangeError("ClusterNode: leaseRenewMs must be > 0");
    this.leaseRenewMs = leaseRenewMs;

    const taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    if (!(taskTimeoutMs > 0)) throw new RangeError("ClusterNode: taskTimeoutMs must be > 0");
    this.taskTimeoutMs = taskTimeoutMs;

    const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (!(drainTimeoutMs > 0)) throw new RangeError("ClusterNode: drainTimeoutMs must be > 0");
    this.drainTimeoutMs = drainTimeoutMs;

    this.epsilon = opts.epsilon ?? DEFAULT_EPSILON;

    this.membership_ = opts.membership ?? new ClusterMembership({ self: opts.descriptor, now: this.nowFn });
    this.certificateAuthority = opts.certificateAuthority ?? new CertificateAuthority(generatePrivateKeyHex());
  }

  // Typed event helpers, mirroring the pattern used by SwarmManager.
  on<K extends keyof ClusterNodeEvents>(e: K, l: ClusterNodeEvents[K]): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  emit<K extends keyof ClusterNodeEvents>(e: K, ...args: Parameters<ClusterNodeEvents[K]>): boolean {
    return super.emit(e, ...args);
  }

  private now(): number {
    return this.nowFn();
  }

  // ── Public API ────────────────────────────────────────────────────────

  membership(): ClusterMembership {
    return this.membership_;
  }

  async start(): Promise<void> {
    const self: NodeState = this.membership_.self();
    if (self.descriptor.nodeId !== this.nodeId) {
      throw new Error(
        `ClusterNode ${this.nodeId}: injected membership's self id "${self.descriptor.nodeId}" does not match this node`
      );
    }
    await this.manager.ensurePool();
    this.syncMembershipLoad();
    if (!this.started) {
      this.started = true;
      this.startRenewalTicker();
    }
  }

  join(peer: NodeDescriptor): void {
    this.membership_.join(peer);
  }

  gossip(): GossipDigest {
    return this.membership_.digest();
  }

  ingest(d: GossipDigest): void {
    this.membership_.apply(d);
  }

  canAccept(task: WorkerTask): boolean {
    if (this.isShutDown) return false;
    if (this.health !== "alive") return false;
    if (this.inFlight.size >= this.maxConcurrentTasks) return false;
    const have = new Set(this.descriptor.capabilities);
    return task.requiredCapabilities.every((c) => have.has(c));
  }

  async execute(lease: Lease, task: WorkerTask): Promise<LeasedTaskOutcome> {
    if (lease.nodeId !== this.nodeId) {
      throw new Error(`ClusterNode ${this.nodeId}: lease ${lease.taskId}#${lease.fencing} is granted to "${lease.nodeId}", not this node`);
    }
    if (!this.canAccept(task)) {
      throw new Error(
        `ClusterNode ${this.nodeId}: cannot accept task ${task.id} (health=${this.health}, inFlight=${this.inFlight.size}/${this.maxConcurrentTasks})`
      );
    }
    const key = compositeKey(lease.taskId, lease.fencing);
    if (this.inFlight.has(key)) {
      throw new Error(`ClusterNode ${this.nodeId}: lease ${lease.taskId}#${lease.fencing} is already executing`);
    }

    const startedAt = this.now();
    let resolveFn!: (o: LeasedTaskOutcome) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<LeasedTaskOutcome>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const entry: InFlightEntry = {
      taskId: lease.taskId,
      fencing: lease.fencing,
      startedAt,
      lastRenewAt: startedAt,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      cleanup: () => undefined,
    };
    this.inFlight.set(key, entry);
    this.syncMembershipLoad();
    this.emit("task:started", lease.taskId);

    void this.runLeasedTask(entry, key, lease, task).catch((err) => {
      // Safety net: an unexpected internal failure (e.g. the planner throwing,
      // or manager.startGoal rejecting) must still settle the caller's promise
      // rather than leaving it dangling.
      if (this.inFlight.delete(key)) this.syncMembershipLoad();
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    });

    return promise;
  }

  renewals(): Array<{ taskId: string; fencing: number; dueAt: number }> {
    return [...this.inFlight.values()]
      .map((e) => ({ taskId: e.taskId, fencing: e.fencing, dueAt: e.lastRenewAt + this.leaseRenewMs }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.fencing - b.fencing);
  }

  async drain(reason: string): Promise<{ handedBack: string[]; completed: string[] }> {
    if (this.health === "crashed") {
      throw new Error(`ClusterNode ${this.nodeId}: cannot drain a crashed node`);
    }
    if (this.health === "left") {
      return { handedBack: [], completed: [] };
    }

    this.health = "draining";
    this.emit("node:draining", reason);

    const startingTaskIds = [...this.inFlight.values()].map((e) => e.taskId);
    const trackers = [...this.inFlight.values()].map((e) => e.promise.then(() => undefined, () => undefined));

    await Promise.race([Promise.all(trackers), sleep(this.drainTimeoutMs)]);

    const stillInFlightIds = new Set([...this.inFlight.values()].map((e) => e.taskId));
    const completed = startingTaskIds.filter((id) => !stillInFlightIds.has(id));

    // Hands back whatever remains (lossless — every straggler is accounted
    // for), transitions to "left", and performs a real membership leave.
    await this.leave(reason);

    return { handedBack: [...stillInFlightIds], completed };
  }

  async leave(reason: string): Promise<GossipDigest> {
    if (this.health === "crashed") {
      throw new Error(`ClusterNode ${this.nodeId}: cannot leave a crashed node`);
    }
    this.clearRenewalTicker();
    this.releaseInFlight("handback", reason);
    this.health = "left";
    this.syncMembershipLoad();
    return this.membership_.leave();
  }

  crash(reason: string): void {
    if (this.health === "crashed") return; // idempotent
    this.health = "crashed";
    this.clearRenewalTicker();
    // Deliberately no membership update and no hand-back: a real crash can't
    // do either. The leader must discover this via SWIM suspect/dead timeout
    // and reclaim the lease once it expires.
    this.releaseInFlight("abandon", reason);
    this.emit("node:crashed", reason);
  }

  snapshot(): ClusterNodeSnapshot {
    const view = this.membership_.election();
    return {
      nodeId: this.nodeId,
      health: this.health,
      inFlight: [...this.inFlight.values()]
        .map((e) => ({ taskId: e.taskId, fencing: e.fencing, startedAt: e.startedAt }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.fencing - b.fencing),
      liveWorkers: this.manager.workerCount(),
      load: this.maxConcurrentTasks > 0 ? this.inFlight.size / this.maxConcurrentTasks : this.inFlight.size,
      completed: this.completedCount,
      handedBack: this.handedBackCount,
      abandoned: this.abandonedCount,
      epoch: view.epoch,
      leaderId: view.leaderId,
    };
  }

  async shutdown(): Promise<void> {
    if (this.isShutDown) return; // idempotent
    this.isShutDown = true;
    this.clearRenewalTicker();
    this.releaseInFlight("abandon", "node shutdown");
  }

  // ── Internal: lease execution ────────────────────────────────────────

  private async withPlanningLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.planningMutex;
    let release!: () => void;
    this.planningMutex = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async runLeasedTask(entry: InFlightEntry, key: string, lease: Lease, task: WorkerTask): Promise<void> {
    const plannedTask = new LeasedTaskPlanner(task);
    const objective = `leased-task:${lease.taskId}#${lease.fencing}`;

    const { goalId } = await this.withPlanningLock(async () => {
      installPlanner(this.manager, plannedTask);
      return this.manager.startGoal(objective);
    });
    entry.goalId = goalId;

    // The entry may already have been abandoned (crash) or handed back
    // (drain/leave) while planning was in flight — nothing left to track.
    if (!this.inFlight.has(key)) return;

    await new Promise<void>((doneWaiting) => {
      let settled = false;
      let lastReport: VerificationReport | undefined;

      const cleanupListeners = () => {
        this.manager.off("task:verified", onVerified);
        this.manager.off("task:rejected", onRejected);
        this.manager.off("task:failed", onFailed);
        this.manager.off("goal:aborted", onGoalAborted);
        clearTimeout(timeoutTimer);
      };
      entry.cleanup = cleanupListeners;

      const finish = (outcome: LeasedTaskOutcome) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (this.inFlight.delete(key)) {
          this.completedCount += 1;
          this.syncMembershipLoad();
          this.emit("task:completed", outcome);
          entry.resolve(outcome);
        }
        doneWaiting();
      };

      const onVerified = (t: WorkerTask, report: VerificationReport) => {
        if (t.goalId !== goalId) return;
        void this.finalizeAccepted(lease, t, report, entry.startedAt).then(finish);
      };
      const onRejected = (t: WorkerTask, report: VerificationReport) => {
        if (t.goalId !== goalId) return;
        lastReport = report; // non-terminal — may still be retried by the manager
      };
      const onFailed = (t: WorkerTask, reason: string) => {
        if (t.goalId !== goalId) return;
        const result = t.result ?? syntheticResult(t.id, "unknown", reason, this.now());
        const report = lastReport ?? syntheticReport(t.id, result.workerId, `task failed: ${reason}`, this.now());
        finish(this.buildNonAcceptOutcome(lease, result, report, entry.startedAt));
      };
      const onGoalAborted = (g: Goal, reason: string) => {
        if (g.id !== goalId) return;
        const result = syntheticResult(task.id, "unknown", `goal aborted: ${reason}`, this.now());
        const report = lastReport ?? syntheticReport(task.id, "unknown", `goal aborted before task completed: ${reason}`, this.now());
        finish(this.buildNonAcceptOutcome(lease, result, report, entry.startedAt));
      };

      const timeoutTimer = setTimeout(() => {
        const result = syntheticResult(task.id, "unknown", `execution exceeded taskTimeoutMs=${this.taskTimeoutMs}`, this.now());
        const report =
          lastReport ?? syntheticReport(task.id, "unknown", `cluster-node timed out waiting for the manager after ${this.taskTimeoutMs}ms`, this.now());
        finish(this.buildNonAcceptOutcome(lease, result, report, entry.startedAt));
      }, this.taskTimeoutMs);
      timeoutTimer.unref?.();

      this.manager.on("task:verified", onVerified);
      this.manager.on("task:rejected", onRejected);
      this.manager.on("task:failed", onFailed);
      this.manager.on("goal:aborted", onGoalAborted);

      // Re-check after attaching: an externally-triggered crash/handback
      // between the `inFlight.has` check above and here (both synchronous,
      // so only possible if a listener we just registered synchronously fired
      // — it can't) would otherwise leak these listeners.
      if (!this.inFlight.has(key)) {
        cleanupListeners();
        doneWaiting();
      }
    });
  }

  private async finalizeAccepted(
    lease: Lease,
    managerTask: WorkerTask,
    managerReport: VerificationReport,
    startedAt: number
  ): Promise<LeasedTaskOutcome> {
    const finishedAt = this.now();
    const result: WorkerResult = { ...(managerTask.result as WorkerResult), taskId: lease.taskId };
    const report: VerificationReport = { ...managerReport, taskId: lease.taskId };
    const outputText = canonicalOutputText(result.output);
    const certificate = await this.issueCertificate(lease.taskId, outputText, report, result, finishedAt);
    return {
      taskId: lease.taskId,
      nodeId: lease.nodeId,
      fencing: lease.fencing,
      result,
      report,
      certificate,
      outputText,
      startedAt,
      finishedAt,
    };
  }

  private buildNonAcceptOutcome(
    lease: Lease,
    result: WorkerResult,
    report: VerificationReport,
    startedAt: number
  ): LeasedTaskOutcome {
    const finishedAt = this.now();
    const r: WorkerResult = { ...result, taskId: lease.taskId };
    const rep: VerificationReport = { ...report, taskId: lease.taskId };
    return {
      taskId: lease.taskId,
      nodeId: lease.nodeId,
      fencing: lease.fencing,
      result: r,
      report: rep,
      certificate: undefined,
      outputText: canonicalOutputText(r.output),
      startedAt,
      finishedAt,
    };
  }

  /**
   * Mint the ed25519 certificate for an ACCEPTED outcome. Every payload field
   * is populated honestly from something that actually happened here —
   * nothing is invented:
   *
   *  - `outputSha256`     = sha256 of the exact `outputText` returned on the
   *                         outcome, so `certifiesOutput` fails on any
   *                         mutation of the bytes the caller received.
   *  - `verifierTier`     = the REAL verifier that produced the verdict.
   *  - `ensembleScore`    = the gate's own score, verbatim.
   *  - `pCorrect`         = the same gate score. This layer runs no separate
   *                         calibration step, and inventing a distinct
   *                         "calibrated" figure would be worse than reusing
   *                         the one number that was actually computed — the
   *                         same choice `hades/mcp/cert-handoff.ts` documents.
   *  - `epsilon`          = {@link DEFAULT_EPSILON} (0) unless the caller
   *                         asserted their own calibrated bound.
   *  - `traceSha256`      = sha256 of the REAL tool trace this result carries.
   */
  private async issueCertificate(
    taskId: string,
    outputText: string,
    report: VerificationReport,
    result: WorkerResult,
    issuedAt: number
  ): Promise<VerificationCertificate> {
    const traceSha256 = sha256Hex(canonicalOutputText(result.toolTrace));
    const payload: CertificatePayload = {
      outputSha256: sha256Hex(outputText),
      taskId,
      verifierTier: "T1-swarm-verification-gate",
      ensembleScore: report.score,
      pCorrect: report.score,
      epsilon: this.epsilon,
      traceSha256,
      verifierVersions: ["swarm-runtime.verification-gate@1"],
      issuedAt,
    };
    return this.certificateAuthority.issue(payload);
  }

  // ── Internal: lifecycle ─────────────────────────────────────────────

  private syncMembershipLoad(): void {
    const load = this.maxConcurrentTasks > 0 ? this.inFlight.size / this.maxConcurrentTasks : this.inFlight.size;
    this.membership_.markLocalLoad(load, this.manager.workerCount());
  }

  private startRenewalTicker(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => this.renewalTick(), this.leaseRenewMs);
    this.renewalTimer.unref?.();
  }

  private clearRenewalTicker(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
    }
  }

  private renewalTick(): void {
    if (this.health === "crashed" || this.health === "left") return;
    const now = this.now();
    for (const entry of this.inFlight.values()) {
      entry.lastRenewAt = now;
      this.emit("lease:renew-due", entry.taskId, entry.fencing);
    }
  }

  /** Detaches + settles every currently in-flight entry, either as a
   *  hand-back (drain/leave — the caller may safely retry the lease
   *  elsewhere) or an abandonment (crash/shutdown — no such promise is
   *  made). Returns the taskIds released, in insertion order. */
  private releaseInFlight(mode: "handback" | "abandon", reason: string): string[] {
    const entries = [...this.inFlight.values()];
    this.inFlight.clear();
    const ids: string[] = [];
    for (const entry of entries) {
      entry.cleanup();
      ids.push(entry.taskId);
      if (mode === "handback") {
        this.handedBackCount += 1;
        this.emit("task:handback", entry.taskId, reason);
        entry.reject(new Error(`ClusterNode ${this.nodeId}: task ${entry.taskId}#${entry.fencing} handed back (${reason})`));
      } else {
        this.abandonedCount += 1;
        this.emit("task:abandoned", entry.taskId, reason);
        entry.reject(new Error(`ClusterNode ${this.nodeId}: task ${entry.taskId}#${entry.fencing} abandoned — node crashed (${reason})`));
      }
    }
    if (entries.length > 0) this.syncMembershipLoad();
    return ids;
  }
}
