import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface WakeTask { job: string; profile: string; root: string; name: string; prompt: string }
export type WakeStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
export interface Wake {
  id: string; source: string; sourceId: string; task: WakeTask; dueAt: number;
  status: WakeStatus; owner?: string; fence: number; leaseUntil?: number;
  session?: string; error?: string; createdAt: number; updatedAt: number;
}
type Row = { id: string; source: string; source_id: string; payload: string; due_at: number; status: WakeStatus; owner: string | null; fence: number; lease_until: number | null; session: string | null; error: string | null; created_at: number; updated_at: number };

/** Local durable execution inbox. Queue claims are transactional across sidecars.
 * Expired work is quarantined: the current agent cannot yet reconcile arbitrary
 * effects after a crash, so replaying it automatically would be unsafe.
 */
export class WakeStore {
  private db: DatabaseSync;
  constructor(path: string, private now = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wakes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        payload TEXT NOT NULL, payload_hash TEXT NOT NULL, profile TEXT NOT NULL,
        job TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL,
        owner TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
        session TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(source, source_id));
      CREATE INDEX IF NOT EXISTS wakes_due ON wakes(status, due_at);
      CREATE INDEX IF NOT EXISTS wakes_job ON wakes(job, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS wakes_profile_running ON wakes(profile) WHERE status='running';`);
  }
  enqueue(source: string, sourceId: string, task: WakeTask, dueAt = this.now()): Wake {
    if (!source || !sourceId || !Number.isSafeInteger(dueAt) ||
      Object.values(task).some(value => typeof value !== "string" || !value.trim()) ||
      !task.job || !task.profile || !task.root || !task.name || !task.prompt)
      throw new Error("Invalid wake request");
    // Explicit field order makes identity independent of caller object order.
    const payload = JSON.stringify({ job: task.job, profile: task.profile, root: task.root, name: task.name, prompt: task.prompt });
    const hash = createHash("sha256").update(JSON.stringify([payload, dueAt])).digest("hex");
    const now = this.now();
    this.db.prepare(`INSERT INTO wakes (id,source,source_id,payload,payload_hash,profile,job,due_at,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(source,source_id) DO NOTHING`)
      .run(randomUUID(), source, sourceId, payload, hash, task.profile, task.job, dueAt, now, now);
    const row = this.db.prepare("SELECT * FROM wakes WHERE source=? AND source_id=?").get(source, sourceId) as Row & { payload_hash: string };
    if (row.payload_hash !== hash) throw new Error("Wake identity already exists with different content");
    return this.decode(row);
  }
  all(): Wake[] { return (this.db.prepare("SELECT * FROM wakes ORDER BY created_at,rowid").all() as Row[]).map(row => this.decode(row)); }
  history(job: string, limit = 100): Wake[] { return (this.db.prepare("SELECT * FROM wakes WHERE job=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(job, Math.max(1, Math.min(100, Math.floor(limit)))) as Row[]).reverse().map(row => this.decode(row)); }
  pending(job: string): boolean { return !!this.db.prepare("SELECT 1 FROM wakes WHERE job=? AND status IN ('queued','running') LIMIT 1").get(job); }
  get(id: string): Wake | undefined { const row = this.db.prepare("SELECT * FROM wakes WHERE id=?").get(id) as Row | undefined; return row && this.decode(row); }
  reconcileExpired(): number {
    const now = this.now();
    return Number(this.db.prepare(`UPDATE wakes SET status='interrupted',owner=NULL,lease_until=NULL,error=?,updated_at=?
      WHERE status='running' AND lease_until<=?`).run("Worker lease expired. Inspect the conversation and its changes before retrying.", now, now).changes);
  }
  claim(owner: string, leaseMs = 60_000): Wake | undefined {
    this.validateLease(owner, leaseMs);
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reconcileExpired();
      const row = this.db.prepare(`SELECT * FROM wakes w WHERE status='queued' AND due_at<=?
        AND NOT EXISTS (SELECT 1 FROM wakes active WHERE active.profile=w.profile AND active.status='running')
        ORDER BY due_at,created_at,id LIMIT 1`).get(now) as Row | undefined;
      if (row) this.db.prepare("UPDATE wakes SET status='running',owner=?,fence=fence+1,lease_until=?,updated_at=? WHERE id=?")
        .run(owner, now + leaseMs, now, row.id);
      this.db.exec("COMMIT");
      return row ? this.get(row.id) : undefined;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  renew(wake: Wake, leaseMs = 60_000): boolean {
    this.validateLease(wake.owner ?? "", leaseMs);
    const now = this.now();
    return this.db.prepare("UPDATE wakes SET lease_until=?,updated_at=? WHERE id=? AND owner=? AND fence=? AND status='running' AND lease_until>?")
      .run(now + leaseMs, now, wake.id, wake.owner!, wake.fence, now).changes === 1;
  }
  bind(wake: Wake, session: string): boolean {
    if (!session) throw new Error("Session is required");
    const now = this.now();
    return this.db.prepare("UPDATE wakes SET session=?,updated_at=? WHERE id=? AND owner=? AND fence=? AND status='running' AND lease_until>?")
      .run(session, now, wake.id, wake.owner ?? "", wake.fence, now).changes === 1;
  }
  settle(wake: Wake, status: "completed" | "failed" | "interrupted", error?: string): boolean {
    const now = this.now();
    return this.db.prepare("UPDATE wakes SET status=?,error=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=? AND fence=? AND status='running' AND lease_until>?")
      .run(status, error ?? null, now, wake.id, wake.owner ?? "", wake.fence, now).changes === 1;
  }
  cancel(id: string): boolean {
    return this.db.prepare("UPDATE wakes SET status='cancelled',owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status IN ('queued','running')")
      .run(this.now(), id).changes === 1;
  }
  interruptOwner(owner: string): void {
    this.db.prepare("UPDATE wakes SET status='interrupted',error=?,owner=NULL,lease_until=NULL,updated_at=? WHERE owner=? AND status='running'")
      .run("Hades closed during this run. Inspect its conversation before retrying.", this.now(), owner);
  }
  close() { this.db.close(); }
  private validateLease(owner: string, leaseMs: number) { if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new Error("Invalid worker lease"); }
  private decode(row: Row): Wake { return { id: row.id, source: row.source, sourceId: row.source_id, task: JSON.parse(row.payload), dueAt: row.due_at, status: row.status, owner: row.owner ?? undefined, fence: row.fence, leaseUntil: row.lease_until ?? undefined, session: row.session ?? undefined, error: row.error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at }; }
}
