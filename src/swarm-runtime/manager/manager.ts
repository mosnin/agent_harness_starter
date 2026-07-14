import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  ConsensusSpec,
  ContainerHandle,
  ContainerProvider,
  Goal,
  ResourceLimits,
  VerificationReport,
  WorkerResult,
  WorkerTask,
} from "../types";
import type { HeartbeatInfo, ManagerBus, WorkerRegistration } from "../bus/types";
import { VerificationGate } from "../verification/gate";
import { AntiRogueGuardrail } from "../verification/guardrails";
import type { GuardrailPolicy } from "../verification/guardrails";
import { majorityVote, type Vote } from "../../agents/swarm/consensus";
import { DeterministicPlanner, materializeTasks, type Planner } from "./planner";

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
}

export interface ManagerEvents {
  "goal:planned": (goal: Goal, tasks: WorkerTask[]) => void;
  "worker:spawned": (rec: WorkerRecord) => void;
  "worker:killed": (rec: WorkerRecord, reason: string) => void;
  "task:dispatched": (task: WorkerTask) => void;
  "task:verified": (task: WorkerTask, report: VerificationReport) => void;
  "task:rejected": (task: WorkerTask, report: VerificationReport) => void;
  "task:failed": (task: WorkerTask, reason: string) => void;
  "goal:completed": (goal: Goal) => void;
  "goal:failed": (goal: Goal, reason: string) => void;
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
  private consensusRounds = new Map<string, ConsensusRound>();
  private readonly defaultConsensus?: ConsensusSpec;

  constructor(private readonly config: ManagerConfig) {
    super();
    this.provider = config.provider;
    this.bus = config.bus;
    this.planner = config.planner ?? new DeterministicPlanner();
    this.gate = config.gate ?? new VerificationGate();
    this.guardrail = config.guardrail ?? new AntiRogueGuardrail(config.guardrailPolicy);
    this.capabilities = config.capabilities ?? ["general"];
    this.poolSize = config.poolSize ?? 3;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.defaultConsensus = config.defaultConsensus;
    this.authToken = config.authToken ?? randomBytes(24).toString("hex");

    this.bus.onRegister((r) => this.handleRegister(r));
    this.bus.onHeartbeat((h) => this.handleHeartbeat(h));
    this.bus.onResult((r) => void this.handleResult(r));
    this.bus.onLog((w, l) => this.emit("log", w, l));
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

  /** Ensure the worker pool is up. Idempotent. */
  async ensurePool(): Promise<void> {
    const missing = this.poolSize - this.workers.size;
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < missing; i++) spawns.push(this.spawnWorker());
    await Promise.all(spawns);
  }

  /**
   * Run a goal end-to-end: plan → dispatch → verify → synthesize. Resolves with
   * the completed (or failed) goal once every task reaches a terminal state.
   */
  async runGoal(objective: string, opts?: { timeoutMs?: number }): Promise<Goal> {
    await this.ensurePool();

    const goalId = randomUUID();
    const planned = await this.planner.plan(objective, this.capabilities);
    const tasks = materializeTasks(planned, goalId, this.maxAttempts, this.defaultConsensus);
    for (const t of tasks) this.tasks.set(t.id, t);

    const goal: Goal = {
      id: goalId,
      objective,
      status: "running",
      createdAt: Date.now(),
      taskIds: tasks.map((t) => t.id),
    };
    this.goals.set(goalId, goal);
    this.emit("goal:planned", goal, tasks);

    this.dispatchReady(goalId);

    return await this.waitForGoal(goalId, opts?.timeoutMs ?? 10 * 60_000);
  }

  getGoal(id: string): Goal | undefined {
    return this.goals.get(id);
  }
  listWorkers(): WorkerRecord[] {
    return [...this.workers.values()];
  }
  listTasks(goalId?: string): WorkerTask[] {
    const all = [...this.tasks.values()];
    return goalId ? all.filter((t) => t.goalId === goalId) : all;
  }
  listVerifications(): VerificationReport[] {
    return [...this.verifications];
  }

  async shutdown(): Promise<void> {
    for (const round of this.consensusRounds.values()) {
      if (round.timer) clearTimeout(round.timer);
    }
    this.consensusRounds.clear();
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

  /** Kill a rogue worker's container immediately and replace it. */
  private async killWorker(workerId: string, reason: string): Promise<void> {
    const rec = this.workers.get(workerId);
    if (!rec) return;
    rec.status = "killed";
    rec.killReason = reason;
    this.emit("worker:killed", rec, reason);
    await this.teardownWorker(workerId);
    // Keep the pool at strength so remaining work still progresses.
    await this.spawnWorker().catch(() => undefined);
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
    for (const task of this.tasks.values()) {
      if (task.goalId !== goalId) continue;
      if (task.status !== "pending") continue;
      if (!this.depsSatisfied(task)) continue;
      task.status = "dispatched";
      // Thread verified upstream results into the task input for grounding.
      task.input = { ...task.input, _dependencies: this.dependencyResults(task) };

      const replicas = task.consensus?.replicas ?? 1;
      if (task.consensus && replicas > 1) {
        // Start a fresh consensus round: N independent workers run this task.
        this.startConsensusRound(task);
        for (let i = 0; i < replicas; i++) this.bus.enqueueTask(task);
      } else {
        this.bus.enqueueTask(task);
      }
      this.emit("task:dispatched", task);
    }
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

    // Evaluate this single result against behaviour + grounding.
    const { report, accepted, killed, blocked, reason } = await this.evaluateResult(result);

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
      this.rejectAndMaybeRetry(task, reason ?? "guardrail block");
      return;
    }
    if (accepted) {
      task.status = "verified";
      this.emit("task:verified", task, report);
      this.onProgress(task.goalId);
    } else {
      this.emit("task:rejected", task, report);
      this.rejectAndMaybeRetry(task, report.feedback);
    }
  }

  /** Run the anti-rogue guardrail + verification gate over one worker result. */
  private async evaluateResult(result: WorkerResult): Promise<{
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
    const report = await this.gate.verify(result);
    this.verifications.push(report);
    return {
      report,
      accepted: report.verdict === "accept" && worst !== "kill" && worst !== "block",
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

  private rejectAndMaybeRetry(task: WorkerTask, feedback: string): void {
    task.attempts += 1;
    if (task.attempts >= task.maxAttempts) {
      task.status = "failed";
      this.emit("task:failed", task, feedback);
      this.checkGoalFailure(task.goalId);
      return;
    }
    // Re-dispatch with the verifier's feedback so the worker can correct course.
    task.status = "pending";
    task.input = { ...task.input, _revisionFeedback: feedback, _attempt: task.attempts };
    this.dispatchReady(task.goalId);
  }

  private onProgress(goalId: string): void {
    // Newly-verified task may unblock dependents.
    this.dispatchReady(goalId);

    const goal = this.goals.get(goalId);
    if (!goal) return;
    const tasks = this.listTasks(goalId);
    if (tasks.every((t) => t.status === "verified")) {
      goal.status = "completed";
      goal.completedAt = Date.now();
      goal.synthesis = this.synthesize(tasks);
      this.emit("goal:completed", goal);
    }
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
    const synth = tasks.find((t) => (t.input as { mode?: string }).mode === "synthesize");
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
      this.on("goal:completed", onDone);
      this.on("goal:failed", onFail);
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
      };
    });
  }
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
