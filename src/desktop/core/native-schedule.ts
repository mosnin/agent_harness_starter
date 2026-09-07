import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "../../hades/schedule/runner";
import type { ScheduledJob, JobStore } from "../../hades/schedule/store";
import { JsonFileJobStore } from "../../hades/schedule/store";
import { systemClock } from "../../hades/schedule/clock";

export interface NativeScheduledRequest { sourceId: string; input: string; root?: string; profile?: string }
export interface NativeScheduledResult { session: string; answer: string; error?: string; tokens: number }
export type NativeScheduledRunner = (input: NativeScheduledRequest, signal?: AbortSignal) => Promise<NativeScheduledResult>;

/** Manual advanced schedules use the same scoped runner and approvals as chat.
 * Nominal fire instants are durable idempotency keys. Unknown/crashed attempts
 * are refused rather than replayed. This records execution, never verification. */
export class NativeScheduleExecutor implements JobExecutor {
  private db: DatabaseSync;
  private active = new Map<string, AbortController>();
  private closed = false;
  constructor(private path: string, private run: NativeScheduledRunner, private signal?: AbortSignal) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS executions(source TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, at INTEGER NOT NULL);`);
    this.privateFiles();
  }
  private privateFiles() {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
  }
  async execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult> {
    if (job.task.kind !== "swarm.goal") return { ok: false, output: "", detail: "Native schedule executor only handles swarm.goal" };
    if (this.closed || this.signal?.aborted) return { ok: false, output: "", detail: "Scheduled execution cancelled" };
    const sourceId = `advanced-schedule:${job.id}:${ctx.scheduledFor}`;
    const request: NativeScheduledRequest = { sourceId, input: job.task.input, ...(job.task.root ? { root: job.task.root } : {}), ...(job.task.profile ? { profile: job.task.profile } : {}) };
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const prior = this.db.prepare("SELECT fingerprint,state,result FROM executions WHERE source=?").get(sourceId) as { fingerprint: string; state: string; result?: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { ok: false, output: "", detail: "Scheduled execution identity conflicts with its recorded instructions or authority" };
      if (prior.state === "done" && prior.result) return JSON.parse(prior.result);
      return { ok: false, output: "", detail: "This scheduled attempt is running or was interrupted with an uncertain result. Review its conversation before starting a new attempt; no actions were replayed." };
    }
    if (this.active.has(job.id)) return { ok: false, output: "", detail: "This scheduled job is already running" };
    // Keep every idempotency tombstone; deleting old keys would authorize replay.
    if (Number((this.db.prepare("SELECT COUNT(*) n FROM executions").get() as any).n) >= 2000)
      return { ok: false, output: "", detail: "Scheduled execution history is full. Archive the data directory before starting more scheduled work." };
    this.db.prepare("INSERT INTO executions(source,fingerprint,state,at) VALUES(?,?,'running',?)").run(sourceId, fingerprint, Date.now());
    this.privateFiles();
    const controller = new AbortController();
    this.active.set(job.id, controller);
    const abort = () => controller.abort();
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.signal?.aborted) abort();
    let result: JobExecutionResult;
    try {
      const completed = await this.run(request, controller.signal);
      result = controller.signal.aborted
        ? { ok: false, output: "", detail: `Scheduled execution cancelled; review conversation ${completed.session}` }
        : completed.error
          ? { ok: false, output: completed.answer.slice(0, 8192), detail: completed.error.slice(0, 2048) }
          : { ok: true, output: completed.answer.slice(0, 8192), detail: `Native agent conversation ${completed.session}; ${completed.tokens} recorded tokens. Execution completed; no independent verification certificate supplied.` };
    } catch (error) {
      result = { ok: false, output: "", detail: (error instanceof Error ? error.message : "Native scheduled execution failed").slice(0, 2048) };
    } finally {
      this.signal?.removeEventListener("abort", abort);
      this.active.delete(job.id);
    }
    // A lost write leaves the 'running' tombstone, conservatively preventing replay.
    this.db.prepare("UPDATE executions SET state='done',result=? WHERE source=?").run(JSON.stringify(result), sourceId);
    return result;
  }
  stop() { this.closed = true; for (const controller of this.active.values()) controller.abort(); }
  close() {
    this.stop();
    if (this.active.size) throw new Error("Wait for scheduled executions to settle before closing their journal");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close();
  }
}

/** Reload at each synchronous store operation so a long run's receipt cannot
 * overwrite a toggle or CLI edit made while it was awaiting approval. */
export function freshScheduleStore(path: string): JobStore {
  const open = () => new JsonFileJobStore(path, systemClock);
  return {
    list: () => open().list(), get: id => open().get(id), add: input => open().add(input),
    update: (id, patch, revision) => open().update(id, patch, revision),
    remove: id => open().remove(id), recordRun: (id, run) => open().recordRun(id, run),
    loadReport: () => open().loadReport(),
  };
}
