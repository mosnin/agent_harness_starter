import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  BudgetSpec,
  ConsensusSpec,
  ContainerHandle,
  ContainerProvider,
  Goal,
  GoalUsage,
  ResourceLimits,
  RevisionEntry,
  SwarmMetrics,
  VerificationReport,
  WorkerResult,
  WorkerTask,
} from "../types";
import type { HeartbeatInfo, ManagerBus, WorkerRegistration } from "../bus/types";
import { VerificationGate } from "../verification/gate";
import { AntiRogueGuardrail } from "../verification/guardrails";
import type { GuardrailPolicy } from "../verification/guardrails";
import { majorityVote, type Vote } from "../../agents/swarm/consensus";
import { claimsToRefs, detectContradictions } from "../verification/contradiction";
import type { Contradiction } from "../verification/contradiction";
import { ProvenanceStore, buildProvenance } from "../verification/provenance";
import type { ProvenanceRecord } from "../verification/provenance";
import type { AdversarialVerifier } from "../verification/adversarial";
import type { StateStore, SwarmSnapshot } from "../persistence/state-store";
import { DeterministicPlanner, materializeTasks, type Planner } from "./planner";
import { budgetBreach, computeDemand, desiredWorkers, isReady, isStale, scheduleReady } from "./scheduler";

interface ReplicaOutcome {
  result: WorkerResult;
  report: VerificationReport;
  accepted: boolean;
}

interface ConsensusRound {
  outcomes: ReplicaOutcome[];
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export interface WorkerRecord {
  workerId: string;
  handle: ContainerHandle;
  capabilities: string[];
  status: "starting" | "idle" | "busy" | "killed" | "dead";
  lastHeartbeat: number;
  load: number;
  killReason?: string;
}

export interface ManagerConfig {
  provider: ContainerProvider;
  bus: ManagerBus;
  planner?: Planner;
  gate?: VerificationGate;
  guardrail?: AntiRogueGuardrail;
  /** Base URL workers use to reach the control plane. */
  managerUrl: string;
  /** Shared bus auth token; generated if omitted. */
  authToken?: string;
  /** Capabilities the swarm's workers collectively provide. */
  capabilities?: string[];
  /** How many worker containers to run in parallel. Default 3. */
  poolSize?: number;
  /** Docker image for workers (docker provider). */
  workerImage?: string;
  /** Per-worker resource ceilings. */
  workerLimits?: ResourceLimits;
  /** Per-worker anti-rogue policy. */
  guardrailPolicy?: GuardrailPolicy;
  model?: string;
  /** Max attempts per task before it's failed. Default 3. */
  maxAttempts?: number;
  /** If set, run every task redundantly with quorum agreement (anti-hallucination). */
  defaultConsensus?: ConsensusSpec;
  /** Treat a goal with cross-claim contradictions as failed instead of completed. */
  failOnContradiction?: boolean;
  /** Emit `task:escalated` once a task reaches this many failed attempts. */
  escalateAfter?: number;
  /** Independent skeptic that must fail to refute a result before it's accepted. */
  adversary?: AdversarialVerifier;
  /** Max tasks in flight per goal (backpressure). Default: unbounded. */
  maxInFlight?: number;
  /** Autoscale the worker pool to demand within these bounds. */
  autoscale?: { min: number; max: number };
  /** Mark a worker dead if it hasn't heartbeated within this window. Default 15s. */
  heartbeatTimeoutMs?: number;
  /** Requeue a task whose worker produced no result within this window. Default 90s. */
  taskTimeoutMs?: number;
  /** How often the health monitor runs. Default 5s. */
  monitorIntervalMs?: number;
  /** Max times a task may be requeued before it's failed. Default 3. */
  maxRequeues?: number;
  /** Resource ceilings applied to every goal (a breach aborts the goal). */
  defaultBudget?: BudgetSpec;
  /** Durable store; when set, goal/task state is persisted for crash recovery. */
  stateStore?: StateStore;
  /** Debounce window for persistence writes. Default 250ms. */
  persistDebounceMs?: number;
}

export interface ManagerEvents {
  "goal:planned": (goal: Goal, tasks: WorkerTask[]) => void;
  "worker:spawned": (rec: WorkerRecord) => void;
  "worker:killed": (rec: WorkerRecord, reason: string) => void;
  "task:dispatched": (task: WorkerTask) => void;
  "task:verified": (task: WorkerTask, report: VerificationReport) => void;
  "task:rejected": (task: WorkerTask, report: VerificationReport) => void;
  "task:failed": (task: WorkerTask, reason: string) => void;
  "task:requeued": (task: WorkerTask, reason: string) => void;
  "task:escalated": (task: WorkerTask, revisions: RevisionEntry[]) => void;
  "worker:dead": (rec: WorkerRecord, reason: string) => void;
  "goal:completed": (goal: Goal) => void;
  "goal:failed": (goal: Goal, reason: string) => void;
  "goal:aborted": (goal: Goal, reason: string) => void;
  "goal:contradiction": (goal: Goal, contradictions: Contradiction[]) => void;
  log: (workerId: string, line: string) => void;
}

/**
 * The manager agent. It is the only component that can spawn or destroy
 * workers, and the only component that decides whether a worker's output is
 * trustworthy. Workers are deliberately powerless: they receive one task, run
 * in an isolated container, and hand back a result that must clear the
 * verification gate and the anti-rogue guardrail before it counts. A worker
 * that fabricates evidence is rejected; a worker that behaves dangerously has
 * its container torn down mid-flight. This is what makes it structurally hard
 * for the swarm to hallucinate its way to "done" or to go rogue.
 */
export class SwarmManager extends EventEmitter {
  readonly authToken: string;
  private readonly provider: ContainerProvider;
  private readonly bus: ManagerBus;
  private readonly planner: Planner;
  private readonly gate: VerificationGate;
  private readonly guardrail: AntiRogueGuardrail;
  private readonly capabilities: string[];
  private readonly poolSize: number;
  private readonly maxAttempts: number;

  private workers = new Map<string, WorkerRecord>();
  private tasks = new Map<string, WorkerTask>();
  private goals = new Map<string, Goal>();
  private verifications: VerificationReport[] = [];
  private readonly provenance = new ProvenanceStore();
  private consensusRounds = new Map<string, ConsensusRound>();
  private readonly defaultConsensus?: ConsensusSpec;
  private readonly failOnContradiction: boolean;
  private readonly escalateAfter?: number;
  private readonly adversary?: AdversarialVerifier;
  private readonly maxInFlight: number;
  private readonly autoscale?: { min: number; max: number };
  private readonly heartbeatTimeoutMs: number;
  private readonly taskTimeoutMs: number;
  private readonly monitorIntervalMs: number;
  private readonly maxRequeues: number;
  private monitorTimer?: ReturnType<typeof setInterval>;
  private dispatchedAt = new Map<string, number>();
  private shuttingDown = false;
  private readonly defaultBudget?: BudgetSpec;
  private goalBudgets = new Map<string, BudgetSpec>();
  private goalUsage = new Map<string, { workerRuns: number; toolCalls: number; costUsd: number; startedAt: number }>();
  private readonly stateStore?: StateStore;
  private readonly persistDebounceMs: number;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private logs: Array<{ workerId: string; line: string; at: number }> = [];
  private readonly maxLogs = 1000;

  constructor(private readonly config: ManagerConfig) {
    super();
    // Each concurrent runGoal registers temporary terminal-event listeners;
    // lift the default cap so running many goals at once doesn't warn/leak.
    this.setMaxListeners(0);
    this.provider = config.provider;
    this.bus = config.bus;
    this.planner = config.planner ?? new DeterministicPlanner();
    this.gate = config.gate ?? new VerificationGate();
    this.guardrail = config.guardrail ?? new AntiRogueGuardrail(config.guardrailPolicy);
    this.capabilities = config.capabilities ?? ["general"];
    this.poolSize = config.poolSize ?? 3;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.defaultConsensus = config.defaultConsensus;
    this.failOnContradiction = config.failOnContradiction ?? false;
    this.escalateAfter = config.escalateAfter;
    this.adversary = config.adversary;
    this.maxInFlight = config.maxInFlight ?? Number.POSITIVE_INFINITY;
    this.autoscale = config.autoscale;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 15_000;
    this.taskTimeoutMs = config.taskTimeoutMs ?? 90_000;
    this.monitorIntervalMs = config.monitorIntervalMs ?? 5_000;
    this.maxRequeues = config.maxRequeues ?? 3;
    this.defaultBudget = config.defaultBudget;
    this.stateStore = config.stateStore;
    this.persistDebounceMs = config.persistDebounceMs ?? 250;
    this.authToken = config.authToken ?? randomBytes(24).toString("hex");

    this.bus.onRegister((r) => this.handleRegister(r));
    this.bus.onHeartbeat((h) => this.handleHeartbeat(h));
    this.bus.onResult((r) => void this.handleResult(r));
    this.bus.onLog((w, l) => this.recordLog(w, l));
    this.bus.onDeregister((w) => this.markDead(w));
  }

  // Typed event helpers.
  on<K extends keyof ManagerEvents>(e: K, l: ManagerEvents[K]): this {
    return super.on(e, l as (...args: unknown[]) => void);
  }
  emit<K extends keyof ManagerEvents>(e: K, ...args: Parameters<ManagerEvents[K]>): boolean {
    return super.emit(e, ...args);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Ensure the worker pool is up. Idempotent. Starts at `min` when autoscaling. */
  async ensurePool(): Promise<void> {
    const target = this.autoscale ? this.autoscale.min : this.poolSize;
    const missing = target - this.liveWorkers().length;
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < missing; i++) spawns.push(this.spawnWorker());
    await Promise.all(spawns);
    this.startMonitor();
  }

  private startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this.monitorTick(), this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  /**
   * Health loop: reap workers that stopped heartbeating (crashed containers) and
   * requeue tasks whose worker hung or died without ever reporting. This is what
   * keeps a swarm making progress when an isolation unit fails — a lost task is
   * re-dispatched to a healthy worker rather than stalling the whole goal.
   */
  private monitorTick(): void {
    const now = Date.now();

    // 1) Reap dead workers (stale heartbeat) and replace them.
    for (const rec of this.liveWorkers()) {
      if (rec.status === "starting") continue; // give new workers time to register
      if (isStale(rec.lastHeartbeat, now, this.heartbeatTimeoutMs)) {
        rec.status = "dead";
        this.emit("worker:dead", rec, `no heartbeat for >${this.heartbeatTimeoutMs}ms`);
        void this.teardownWorker(rec.workerId);
        void this.spawnWorker().catch(() => undefined); // keep the pool at strength
      }
    }

    // 2) Requeue tasks that were dispatched but never produced a result.
    for (const [taskId, at] of this.dispatchedAt) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "dispatched") {
        this.dispatchedAt.delete(taskId);
        continue;
      }
      if (task.consensus && (task.consensus.replicas ?? 1) > 1) continue; // round timer handles these
      if (isStale(at, now, this.taskTimeoutMs)) this.requeueTask(task, "worker produced no result in time");
    }
  }

  private requeueTask(task: WorkerTask, reason: string): void {
    this.dispatchedAt.delete(task.id);
    task.requeues = (task.requeues ?? 0) + 1;
    if (task.requeues > this.maxRequeues) {
      task.status = "failed";
      this.emit("task:failed", task, `${reason} (exceeded ${this.maxRequeues} requeues)`);
      this.checkGoalFailure(task.goalId);
      return;
    }
    task.status = "pending";
    this.emit("task:requeued", task, reason);
    this.dispatchReady(task.goalId);
  }

  // ── Budget accounting ────────────────────────────────────────────────────────

  private accountUsage(goalId: string, result: WorkerResult): void {
    const u = this.goalUsage.get(goalId);
    if (!u) return;
    u.workerRuns += 1;
    u.toolCalls += result.toolTrace.length;
    u.costUsd += result.costUsd ?? 0;
  }

  /** Returns true (and aborts the goal) if a budget ceiling has been breached. */
  private enforceBudget(goalId: string): boolean {
    const budget = this.goalBudgets.get(goalId);
    if (!budget) return false;
    const breach = budgetBreach(this.usageFor(goalId), budget);
    if (!breach) return false;
    this.abortGoal(goalId, `budget exceeded: ${breach}`);
    return true;
  }

  private usageFor(goalId: string): GoalUsage {
    const u = this.goalUsage.get(goalId);
    if (!u) return { workerRuns: 0, toolCalls: 0, costUsd: 0, wallClockMs: 0 };
    return {
      workerRuns: u.workerRuns,
      toolCalls: u.toolCalls,
      costUsd: u.costUsd,
      wallClockMs: Date.now() - u.startedAt,
    };
  }

  /** Live resource accounting for a goal. */
  getUsage(goalId: string): GoalUsage {
    return this.usageFor(goalId);
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  /** Build a serializable snapshot of all goal/task state. */
  snapshot(): SwarmSnapshot {
    const usage: Record<string, GoalUsage> = {};
    for (const goalId of this.goals.keys()) usage[goalId] = this.usageFor(goalId);
    return {
      version: 1,
      savedAt: Date.now(),
      goals: [...this.goals.values()],
      tasks: [...this.tasks.values()],
      usage,
    };
  }

  private schedulePersist(): void {
    if (!this.stateStore || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.stateStore!.save(this.snapshot()).catch(() => undefined);
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  /** Write the current state immediately (used on shutdown). */
  async flushState(): Promise<void> {
    if (!this.stateStore) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.stateStore.save(this.snapshot());
  }

  /**
   * Rehydrate goals/tasks/usage from the state store into a fresh manager, so a
   * restarted process can inspect (and report on) the prior run's state after a
   * crash. Returns false if there was nothing to restore.
   */
  async loadState(): Promise<boolean> {
    if (!this.stateStore) return false;
    const snap = await this.stateStore.load();
    if (!snap) return false;
    for (const g of snap.goals) this.goals.set(g.id, g);
    for (const t of snap.tasks) this.tasks.set(t.id, t);
    for (const [goalId, u] of Object.entries(snap.usage)) {
      this.goalUsage.set(goalId, {
        workerRuns: u.workerRuns,
        toolCalls: u.toolCalls,
        costUsd: u.costUsd,
        startedAt: Date.now() - u.wallClockMs,
      });
    }
    return true;
  }

  /** Terminate a goal that's still running (budget breach, cancellation). */
  private abortGoal(goalId: string, reason: string): void {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== "running") return;
    goal.status = "aborted";
    goal.completedAt = Date.now();
    for (const t of this.listTasks(goalId)) {
      if (t.status !== "verified" && t.status !== "failed") t.status = "failed";
    }
    this.emit("goal:aborted", goal, reason);
    this.schedulePersist();
  }

  private liveWorkers(): WorkerRecord[] {
    return [...this.workers.values()].filter((w) => w.status !== "killed" && w.status !== "dead");
  }

  /** Grow/shrink the pool toward demand within the autoscale envelope. */
  private autoscaleTick(goalId: string): void {
    if (!this.autoscale) return;
    const isVerified = (id: string) => this.tasks.get(id)?.status === "verified";
    const demand = computeDemand(
      [...this.tasks.values()].filter((t) => t.goalId === goalId),
      isVerified
    );
    const target = desiredWorkers(demand, this.autoscale.min, this.autoscale.max);
    void this.scaleTo(target);
  }

  private async scaleTo(target: number): Promise<void> {
    const live = this.liveWorkers();
    if (live.length < target) {
      const spawns: Promise<void>[] = [];
      for (let i = live.length; i < target; i++) spawns.push(this.spawnWorker());
      await Promise.all(spawns);
    } else if (live.length > target) {
      // Only retire idle workers — never interrupt a running task.
      const idle = live.filter((w) => w.status === "idle");
      let toStop = live.length - target;
      for (const w of idle) {
        if (toStop <= 0) break;
        await this.teardownWorker(w.workerId);
        toStop -= 1;
      }
    }
  }

  /**
   * Run a goal end-to-end: plan → dispatch → verify → synthesize. Resolves with
   * the completed (or failed) goal once every task reaches a terminal state.
   */
  async runGoal(
    objective: string,
    opts?: { timeoutMs?: number; budget?: BudgetSpec; signal?: AbortSignal }
  ): Promise<Goal> {
    const { done } = await this.startGoal(objective, opts);
    return done;
  }

  /**
   * Start a goal and return its id immediately, plus a `done` promise that
   * resolves when it finishes. Useful for request/response callers (MCP tools,
   * REST) that need the id to poll status while the goal runs in the background.
   */
  async startGoal(
    objective: string,
    opts?: { timeoutMs?: number; budget?: BudgetSpec; signal?: AbortSignal }
  ): Promise<{ goalId: string; done: Promise<Goal> }> {
    await this.ensurePool();

    const goalId = randomUUID();
    const budget = opts?.budget ?? this.defaultBudget;
    if (budget) this.goalBudgets.set(goalId, budget);
    this.goalUsage.set(goalId, { workerRuns: 0, toolCalls: 0, costUsd: 0, startedAt: Date.now() });

    const goal: Goal = {
      id: goalId,
      objective,
      status: "running",
      createdAt: Date.now(),
      taskIds: [],
    };
    this.goals.set(goalId, goal);

    // Wire cancellation: an aborted signal terminates the goal mid-flight.
    if (opts?.signal) {
      if (opts.signal.aborted) this.abortGoal(goalId, "cancelled before start");
      else
        opts.signal.addEventListener("abort", () => this.abortGoal(goalId, "cancelled via signal"), {
          once: true,
        });
    }

    const done = this.executeGoal(goalId, objective, opts?.timeoutMs ?? 10 * 60_000);
    return { goalId, done };
  }

  private async executeGoal(goalId: string, objective: string, timeoutMs: number): Promise<Goal> {
    const planned = await this.planner.plan(objective, this.capabilities);
    const tasks = materializeTasks(planned, goalId, this.maxAttempts, this.defaultConsensus);
    for (const t of tasks) this.tasks.set(t.id, t);

    const goal = this.goals.get(goalId)!;
    goal.taskIds = tasks.map((t) => t.id);

    // A signal may have aborted the goal while we were planning.
    if (goal.status !== "running") return goal;

    this.emit("goal:planned", goal, tasks);
    this.schedulePersist();
    this.dispatchReady(goalId);

    return await this.waitForGoal(goalId, timeoutMs);
  }

  /**
   * Cancel a running goal. Dispatch stops immediately, in-flight worker results
   * are ignored on arrival, and any non-terminal task is marked failed. Returns
   * false if the goal isn't running.
   */
  cancelGoal(goalId: string, reason = "cancelled by request"): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== "running") return false;
    this.abortGoal(goalId, reason);
    return true;
  }

  getGoal(id: string): Goal | undefined {
    return this.goals.get(id);
  }
  /** All goals this manager has run, newest first. */
  listGoals(): Goal[] {
    return [...this.goals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Re-run a prior goal's objective as a fresh goal. Returns the new goalId. */
  async replayGoal(id: string): Promise<string | undefined> {
    const goal = this.goals.get(id);
    if (!goal) return undefined;
    const { goalId, done } = await this.startGoal(goal.objective);
    void done.catch(() => undefined);
    return goalId;
  }
  listWorkers(): WorkerRecord[] {
    return [...this.workers.values()];
  }

  private recordLog(workerId: string, line: string): void {
    this.logs.push({ workerId, line, at: Date.now() });
    if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
    this.emit("log", workerId, line);
  }

  /** Recent activity log across all workers (newest last). */
  recentLogs(limit = 200): Array<{ workerId: string; line: string; at: number }> {
    return this.logs.slice(-limit);
  }

  /** Recent log lines for a single worker. */
  getWorkerLogs(workerId: string, limit = 200): Array<{ line: string; at: number }> {
    return this.logs.filter((l) => l.workerId === workerId).slice(-limit).map(({ line, at }) => ({ line, at }));
  }
  listTasks(goalId?: string): WorkerTask[] {
    const all = [...this.tasks.values()];
    return goalId ? all.filter((t) => t.goalId === goalId) : all;
  }
  listVerifications(): VerificationReport[] {
    return [...this.verifications];
  }
  /** Audit trail: every accepted result's claims + confirmed evidence. */
  listProvenance(goalId?: string): ProvenanceRecord[] {
    return goalId ? this.provenance.forGoal(goalId) : this.provenance.list();
  }
  getProvenance(taskId: string): ProvenanceRecord | undefined {
    return this.provenance.get(taskId);
  }
  /** Fraction of all accepted claims grounded in observed evidence (0..1). */
  groundingRate(): number {
    return this.provenance.groundingRate();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return; // idempotent — safe to call from multiple signals
    this.shuttingDown = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    for (const round of this.consensusRounds.values()) {
      if (round.timer) clearTimeout(round.timer);
    }
    this.consensusRounds.clear();
    await this.flushState().catch(() => undefined);
    await Promise.all([...this.workers.values()].map((w) => this.teardownWorker(w.workerId)));
    await this.bus.close();
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

  private async spawnWorker(): Promise<void> {
    const workerId = `w-${randomBytes(4).toString("hex")}`;
    const rec: WorkerRecord = {
      workerId,
      handle: {
        workerId,
        nativeId: "",
        kind: this.provider.kind,
        startedAt: Date.now(),
      },
      capabilities: this.capabilities,
      status: "starting",
      lastHeartbeat: Date.now(),
      load: 0,
    };
    this.workers.set(workerId, rec);
    const handle = await this.provider.spawn({
      workerId,
      capabilities: this.capabilities,
      managerUrl: this.config.managerUrl,
      authToken: this.authToken,
      model: this.config.model,
      image: this.config.workerImage,
      limits: this.config.workerLimits,
    });
    rec.handle = handle;
    this.emit("worker:spawned", rec);
  }

  private async teardownWorker(workerId: string): Promise<void> {
    const rec = this.workers.get(workerId);
    if (!rec) return;
    try {
      await this.provider.stop(rec.handle);
    } catch {
      /* already gone */
    }
    this.workers.delete(workerId);
  }

  /**
   * Kill a worker's container immediately and replace it. Used both by the
   * anti-rogue guardrail (on a `kill` finding) and by an operator via the
   * dashboard/REST control. Returns false if the worker id is unknown.
   */
  async killWorker(workerId: string, reason: string): Promise<boolean> {
    const rec = this.workers.get(workerId);
    if (!rec) return false;
    rec.status = "killed";
    rec.killReason = reason;
    this.emit("worker:killed", rec, reason);
    await this.teardownWorker(workerId);
    // Keep the pool at strength so remaining work still progresses.
    await this.spawnWorker().catch(() => undefined);
    return true;
  }

  /** Manually scale the worker pool to `target` (grows, or retires idle workers). */
  async scalePool(target: number): Promise<number> {
    await this.scaleTo(Math.max(0, Math.floor(target)));
    return this.liveWorkers().length;
  }

  /** Current live worker count. */
  workerCount(): number {
    return this.liveWorkers().length;
  }

  /** Aggregate metrics across the whole swarm — for the dashboard + monitoring. */
  metrics(): SwarmMetrics {
    const goals = [...this.goals.values()];
    const tasks = [...this.tasks.values()];
    const workers = [...this.workers.values()];
    const verifs = this.verifications;
    const accepted = verifs.filter((v) => v.verdict === "accept").length;
    const avgScore = verifs.length ? verifs.reduce((s, v) => s + v.score, 0) / verifs.length : 0;
    let toolCalls = 0;
    let costUsd = 0;
    for (const u of this.goalUsage.values()) {
      toolCalls += u.toolCalls;
      costUsd += u.costUsd;
    }
    const count = <T extends string>(items: { status: T }[], status: T) =>
      items.filter((i) => i.status === status).length;
    return {
      goals: {
        total: goals.length,
        completed: count(goals, "completed"),
        failed: count(goals, "failed"),
        aborted: count(goals, "aborted"),
        running: count(goals, "running"),
      },
      tasks: {
        total: tasks.length,
        verified: count(tasks, "verified"),
        failed: count(tasks, "failed"),
        pending: count(tasks, "pending"),
        dispatched: count(tasks, "dispatched"),
      },
      workers: {
        total: workers.length,
        idle: count(workers, "idle"),
        busy: count(workers, "busy"),
        killed: count(workers, "killed"),
        dead: count(workers, "dead"),
      },
      verification: {
        total: verifs.length,
        accepted,
        rejected: verifs.length - accepted,
        avgScore,
        groundingRate: this.groundingRate(),
      },
      usage: { toolCalls, costUsd },
    };
  }

  private handleRegister(reg: WorkerRegistration): void {
    const rec = this.workers.get(reg.workerId);
    if (rec) {
      rec.status = "idle";
      rec.capabilities = reg.capabilities;
      rec.lastHeartbeat = Date.now();
    }
  }

  private handleHeartbeat(hb: HeartbeatInfo): void {
    const rec = this.workers.get(hb.workerId);
    if (!rec) return;
    rec.lastHeartbeat = Date.now();
    rec.load = hb.load;
    if (rec.status !== "killed") rec.status = hb.load > 0 ? "busy" : "idle";
  }

  private markDead(workerId: string): void {
    const rec = this.workers.get(workerId);
    if (rec && rec.status !== "killed") rec.status = "dead";
  }

  // ── Dispatch & verification ──────────────────────────────────────────────────

  private dispatchReady(goalId: string): void {
    // Never dispatch into a goal that has been aborted/cancelled/completed.
    const g = this.goals.get(goalId);
    if (g && g.status !== "running") return;
    // Grow the pool to meet demand before selecting what to release.
    this.autoscaleTick(goalId);
    const isVerified = (id: string) => this.tasks.get(id)?.status === "verified";
    const candidates = [...this.tasks.values()].filter(
      (t) => t.goalId === goalId && isReady(t, isVerified)
    );
    const toDispatch = scheduleReady({
      candidates,
      inFlight: this.inFlightCount(goalId),
      maxInFlight: this.maxInFlight,
    });

    for (const task of toDispatch) {
      task.status = "dispatched";
      // Thread verified upstream results into the task input for grounding.
      task.input = { ...task.input, _dependencies: this.dependencyResults(task) };

      const replicas = task.consensus?.replicas ?? 1;
      if (task.consensus && replicas > 1) {
        // Start a fresh consensus round: N independent workers run this task.
        this.startConsensusRound(task);
        for (let i = 0; i < replicas; i++) this.bus.enqueueTask(task);
      } else {
        this.dispatchedAt.set(task.id, Date.now());
        this.bus.enqueueTask(task);
      }
      this.emit("task:dispatched", task);
    }
  }

  /** Number of a goal's tasks currently occupying dispatch capacity. */
  private inFlightCount(goalId: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.goalId === goalId && (t.status === "dispatched" || t.status === "reported")) n++;
    }
    return n;
  }

  private startConsensusRound(task: WorkerTask): void {
    const prior = this.consensusRounds.get(task.id);
    if (prior?.timer) clearTimeout(prior.timer);
    const round: ConsensusRound = { outcomes: [], settled: false };
    const timeout = task.consensus?.roundTimeoutMs ?? 45_000;
    round.timer = setTimeout(() => this.evaluateConsensus(task, true), timeout);
    round.timer.unref?.();
    this.consensusRounds.set(task.id, round);
  }

  private depsSatisfied(task: WorkerTask): boolean {
    return task.dependsOn.every((d) => this.tasks.get(d)?.status === "verified");
  }

  private dependencyResults(task: WorkerTask): Array<{ taskId: string; output: unknown }> {
    return task.dependsOn
      .map((d) => this.tasks.get(d))
      .filter((t): t is WorkerTask => !!t?.result)
      .map((t) => ({ taskId: t.id, output: t.result!.output }));
  }

  private async handleResult(result: WorkerResult): Promise<void> {
    const task = this.tasks.get(result.taskId);
    if (!task) return;
    // Ignore late/duplicate results for tasks that already reached a terminal
    // state (e.g. a requeued task's original worker finally reporting).
    if (task.status === "verified" || task.status === "failed") return;
    this.dispatchedAt.delete(result.taskId);

    // Account for this worker run and enforce the goal's budget ceilings.
    this.accountUsage(task.goalId, result);
    if (this.enforceBudget(task.goalId)) return; // goal aborted — stop processing

    // Evaluate this single result against behaviour + grounding.
    const { report, accepted, killed, blocked, reason } = await this.evaluateResult(result, task);

    // Consensus tasks accumulate replicas; single tasks resolve immediately.
    if (task.consensus && (task.consensus.replicas ?? 1) > 1) {
      this.accumulateConsensus(task, { result, report, accepted: accepted && !killed && !blocked });
      return;
    }

    task.result = result;
    task.status = "reported";
    if (killed) {
      this.rejectAndMaybeRetry(task, reason ?? "rogue behaviour");
      return;
    }
    if (blocked) {
      this.emit("task:rejected", task, report);
      this.rejectAndMaybeRetry(task, reason ?? "guardrail block", report);
      return;
    }
    if (accepted) {
      task.status = "verified";
      this.provenance.record(buildProvenance(result, report, task.goalId));
      this.emit("task:verified", task, report);
      this.onProgress(task.goalId);
    } else {
      this.emit("task:rejected", task, report);
      this.rejectAndMaybeRetry(task, report.feedback, report);
    }
  }

  /**
   * Does this task's output BECOME the goal's answer?
   *
   * The manager is the only component that can answer that: a worker sees one
   * task, and a `WorkerResult` records what was produced, never what role it
   * plays in the plan. This is deliberately the exact same predicate
   * {@link synthesize} uses to pick the goal's answer out of the finished
   * tasks — one definition, so "what the run returns" and "what a correctness
   * oracle is allowed to judge" cannot drift apart.
   *
   * False for every other task, including a fan-out subtask whose description
   * quotes the objective verbatim (`DeterministicPlanner` writes exactly
   * that). Those legitimately return prose, and an oracle told to judge them
   * against the objective's expected answer would refute correct work.
   *
   * When a plan contains no synthesis task at all, `synthesize()` returns a
   * COMPOSITE of every task's output and no single result is the answer — so
   * this is false everywhere and a correctness oracle abstains everywhere,
   * which is reported honestly per result rather than guessed at.
   */
  private static answersGoal(task: WorkerTask): boolean {
    return (task.input as { mode?: unknown } | undefined)?.mode === "synthesize";
  }

  /**
   * Run the anti-rogue guardrail + verification gate over one worker result.
   *
   * `task` is threaded in only so the gate can hand its (optional) external
   * verifier the REQUEST CONTEXT: a `WorkerResult` records what a worker
   * produced, never what it was asked, and a correctness oracle cannot
   * recompute an answer it has not seen the question for. Three facts go
   * across, and the third is what keeps the oracle from vetoing correct runs:
   *
   *  - `taskDescription` — the request this worker was handed;
   *  - `objective`       — the request the whole goal answers, read from the
   *    `Goal` rather than from the subtask, because a planner may paraphrase
   *    or drop it;
   *  - `isGoalAnswer`    — whether this result IS the goal's answer (see
   *    {@link answersGoal}) or intermediate work product.
   *
   * With no external verifier configured — the default — the gate ignores all
   * of it entirely.
   */
  private async evaluateResult(result: WorkerResult, task: WorkerTask): Promise<{
    report: VerificationReport;
    accepted: boolean;
    killed: boolean;
    blocked: boolean;
    reason?: string;
  }> {
    const findings = this.guardrail.inspect(result);
    const worst = AntiRogueGuardrail.worst(findings);
    if (worst === "kill") {
      await this.killWorker(result.workerId, findings.map((f) => f.rule).join(","));
    }
    const objective = this.goals.get(task.goalId)?.objective;
    const report = await this.gate.verify(result, {
      taskDescription: task.description,
      ...(objective === undefined ? {} : { objective }),
      isGoalAnswer: SwarmManager.answersGoal(task),
    });
    this.verifications.push(report);

    let accepted = report.verdict === "accept" && worst !== "kill" && worst !== "block";

    // Independent adversarial pass: a result must *survive* refutation, not just
    // pass grounding. Catches overreach the gate accepts.
    if (accepted && this.adversary) {
      const refutation = await this.adversary.refute(result);
      if (refutation.refuted) {
        accepted = false;
        report.verdict = "revise";
        report.checks.push({
          name: "adversarial-refutation",
          passed: false,
          weight: 2,
          detail: refutation.reasons.join("; "),
        });
        report.feedback = `Adversarial reviewer refuted this result: ${refutation.reasons.join("; ")}`;
      } else {
        report.checks.push({
          name: "adversarial-survived",
          passed: true,
          weight: 0,
          detail: "survived independent refutation",
        });
      }
    }

    return {
      report,
      accepted,
      killed: worst === "kill",
      blocked: worst === "block",
      reason:
        worst === "kill"
          ? `rogue behaviour: ${findings.map((f) => f.detail).join("; ")}`
          : worst === "block"
            ? `guardrail block: ${findings.map((f) => f.detail).join("; ")}`
            : undefined,
    };
  }

  // ── Consensus (redundant execution) ──────────────────────────────────────────

  private accumulateConsensus(task: WorkerTask, outcome: ReplicaOutcome): void {
    const round = this.consensusRounds.get(task.id);
    if (!round || round.settled) return;
    round.outcomes.push(outcome);
    if (round.outcomes.length >= (task.consensus?.replicas ?? 1)) {
      this.evaluateConsensus(task, false);
    }
  }

  /**
   * Decide a consensus task once all replicas have reported (or the round timed
   * out). A task is verified only if at least ceil(replicas * quorum) workers
   * both cleared the gate AND produced the same canonical output — so no single
   * worker can carry a task to "done", and a lone hallucinated answer is
   * outvoted by the grounded majority.
   */
  private evaluateConsensus(task: WorkerTask, timedOut: boolean): void {
    const round = this.consensusRounds.get(task.id);
    if (!round || round.settled) return;
    round.settled = true;
    if (round.timer) clearTimeout(round.timer);

    const spec = task.consensus!;
    const threshold = Math.max(1, Math.ceil(spec.replicas * (spec.quorum ?? 0.5)));
    const acceptedOutcomes = round.outcomes.filter((o) => o.accepted);

    task.status = "reported";

    if (acceptedOutcomes.length === 0) {
      this.rejectAndMaybeRetry(
        task,
        `consensus failed: no replica cleared verification${timedOut ? " (round timed out)" : ""}`
      );
      return;
    }

    // Vote over canonical outputs of the gate-passing replicas.
    const votes: Vote[] = acceptedOutcomes.map((o, i) => ({
      agentId: o.result.workerId || `replica-${i}`,
      value: canonicalize(o.result.output),
      weight: 1,
      timestamp: o.result.finishedAt,
    }));
    const vote = majorityVote<string>(votes);
    const winnerCount = Math.round(vote.confidence * acceptedOutcomes.length);

    if (winnerCount >= threshold) {
      // Adopt a representative winning result.
      const winner = acceptedOutcomes.find((o) => canonicalize(o.result.output) === vote.value)!;
      task.result = winner.result;
      task.status = "verified";
      this.provenance.record(buildProvenance(winner.result, winner.report, task.goalId));
      this.emit("task:verified", task, {
        ...winner.report,
        feedback: `consensus: ${winnerCount}/${spec.replicas} workers agreed (threshold ${threshold})`,
      });
      this.onProgress(task.goalId);
    } else {
      this.rejectAndMaybeRetry(
        task,
        `consensus not reached: top answer had ${winnerCount}/${spec.replicas} agreeing (need ${threshold})`
      );
    }
  }

  private rejectAndMaybeRetry(task: WorkerTask, feedback: string, report?: VerificationReport): void {
    task.attempts += 1;
    const failedChecks = (report?.checks ?? []).filter((c) => !c.passed).map((c) => c.name);
    const entry = {
      attempt: task.attempts,
      verdict: report?.verdict,
      score: report?.score,
      failedChecks,
      feedback,
      at: Date.now(),
    };
    task.revisions = [...(task.revisions ?? []), entry];

    // Escalate for visibility once a task has burned through half its budget —
    // a persistently-failing task is a signal an operator may need to see.
    if (this.escalateAfter && task.attempts === this.escalateAfter) {
      this.emit("task:escalated", task, task.revisions);
    }

    if (task.attempts >= task.maxAttempts) {
      task.status = "failed";
      this.emit("task:escalated", task, task.revisions);
      this.emit("task:failed", task, feedback);
      this.checkGoalFailure(task.goalId);
      return;
    }

    // Re-dispatch with structured, actionable feedback so the worker can correct
    // course rather than repeating the same ungrounded mistake.
    task.status = "pending";
    task.input = {
      ...task.input,
      _revisionFeedback: feedback,
      _revision: { attempt: task.attempts, failedChecks },
      _attempt: task.attempts,
    };
    this.dispatchReady(task.goalId);
  }

  private onProgress(goalId: string): void {
    this.schedulePersist();
    // Newly-verified task may unblock dependents.
    this.dispatchReady(goalId);

    const goal = this.goals.get(goalId);
    if (!goal) return;
    const tasks = this.listTasks(goalId);
    if (tasks.every((t) => t.status === "verified")) {
      // Cross-check the whole goal for internally contradictory claims — each
      // result may be individually grounded yet collectively inconsistent.
      const contradictions = this.findContradictions(tasks);
      goal.contradictions = contradictions;
      goal.completedAt = Date.now();

      if (contradictions.length > 0) {
        this.emit("goal:contradiction", goal, contradictions);
        if (this.failOnContradiction) {
          goal.status = "failed";
          this.emit("goal:failed", goal, `contradictory claims across results: ${describe(contradictions)}`);
          return;
        }
      }

      goal.status = "completed";
      goal.synthesis = this.synthesize(tasks);
      this.emit("goal:completed", goal);
    }
  }

  private findContradictions(tasks: WorkerTask[]): Contradiction[] {
    const entries = tasks
      .filter((t) => t.result)
      .map((t) => ({ taskId: t.id, workerId: t.result!.workerId, claims: t.result!.claims }));
    return detectContradictions(claimsToRefs(entries));
  }

  private checkGoalFailure(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== "running") return;
    const tasks = this.listTasks(goalId);
    if (tasks.some((t) => t.status === "failed")) {
      goal.status = "failed";
      goal.completedAt = Date.now();
      this.emit("goal:failed", goal, "one or more tasks failed verification after max attempts");
    }
  }

  private synthesize(tasks: WorkerTask[]): unknown {
    // Prefer the explicit synthesis task's output; else collect all outputs.
    // `answersGoal` IS this selection rule — shared so the result a
    // correctness oracle is allowed to judge is exactly the result the goal
    // returns (see `evaluateResult`).
    const synth = tasks.find((t) => SwarmManager.answersGoal(t));
    if (synth?.result) return synth.result.output;
    return tasks.filter((t) => t.result).map((t) => ({ task: t.description, output: t.result!.output }));
  }

  private waitForGoal(goalId: string, timeoutMs: number): Promise<Goal> {
    return new Promise<Goal>((resolve) => {
      const goal = this.goals.get(goalId)!;
      const finish = () => {
        cleanup();
        resolve(this.goals.get(goalId)!);
      };
      const onDone = (g: Goal) => g.id === goalId && finish();
      const onFail = (g: Goal) => g.id === goalId && finish();
      const onAbort = (g: Goal) => g.id === goalId && finish();
      this.on("goal:completed", onDone);
      this.on("goal:failed", onFail);
      this.on("goal:aborted", onAbort);
      const timer = setTimeout(() => {
        if (goal.status === "running") {
          goal.status = "aborted";
          goal.completedAt = Date.now();
        }
        finish();
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        this.off("goal:completed", onDone as never);
        this.off("goal:failed", onFail as never);
        this.off("goal:aborted", onAbort as never);
      };
    });
  }
}

/** Short human-readable summary of contradictions for logs/feedback. */
function describe(contradictions: Contradiction[]): string {
  return contradictions
    .slice(0, 3)
    .map((c) => `${c.subject} → {${c.conflicts.map((x) => x.value).join(" | ")}}`)
    .join("; ");
}

/** Stable string form of a worker output, used to group agreeing replicas. */
function canonicalize(v: unknown): string {
  if (typeof v === "string") return v.trim();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
