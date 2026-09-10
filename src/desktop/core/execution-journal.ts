import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Event = Record<string, any>;
export interface SessionProgress {
  stream: string;
  tools: Event[];
  journal: Event[];
  approval?: Event;
  usage?: Event;
  error?: string;
  interrupted?: boolean;
  running?: boolean;
}
const MAX_EVENTS = 512;
const MAX_BYTES = 8 * 1024 * 1024;
const kinds = new Set(["desktop.started", "desktop.tool", "desktop.hook", "desktop.approval", "desktop.approval.resolved", "desktop.usage", "desktop.error", "desktop.done"]);

/** Private local review evidence, separate from metadata-only ActivityStore.
 * Bounded excerpts are not an effect replay queue. No credentials or images are
 * stored; old excerpts are evicted at 512/session, 4096 total, or 8 MiB total.
 * Streaming text is checkpointed at most four times/second, so a crash can lose
 * the last 250 ms of the partial stream, but never a committed tool event. */
export class ExecutionJournal {
  private db: DatabaseSync;
  private streamTimes = new Map<string, number>();
  constructor(private path: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, profile TEXT NOT NULL,
        session TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(profile,session,id);
      CREATE TABLE IF NOT EXISTS streams(profile TEXT NOT NULL,session TEXT NOT NULL,
        at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(profile,session));`);
    this.privateFiles();
  }
  private privateFiles() {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
  }
  private redact(value: unknown, max: number, secrets: readonly string[]) {
    if (typeof value !== "string") return undefined;
    let s = value;
    for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join("[redacted]");
    s = s.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
    return s.length > max ? s.slice(0, max) + "\n[excerpt truncated]" : s;
  }
  record(profile: string, event: Event, secrets: readonly string[] = []) {
    if (!kinds.has(event.kind) || typeof event.session !== "string") return;
    const clean: Event = { kind: event.kind, session: event.session, at: Date.now() };
    for (const key of ["tool", "hook", "name", "phase", "status", "message", "input", "output"]) {
      const value = this.redact(event[key], key === "output" ? 8192 : key === "input" ? 4096 : 1024, secrets);
      if (value !== undefined) clean[key] = value;
    }
    for (const key of ["ok", "allow", "cancelled", "costMeasured", "usageComplete"])
      if (typeof event[key] === "boolean") clean[key] = event[key];
    for (const key of ["tokensIn", "tokensOut", "cachedInputTokens", "usd"])
      if (typeof event[key] === "number" && Number.isFinite(event[key]) && event[key] >= 0) clean[key] = event[key];
    // Approval IDs are live capabilities. They never survive a process restart.
    const body = JSON.stringify(clean);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO events(profile,session,at,body,bytes) VALUES(?,?,?,?,?)")
        .run(profile, event.session, clean.at, body, Buffer.byteLength(body));
      this.db.prepare("DELETE FROM events WHERE profile=? AND session=? AND id NOT IN (SELECT id FROM events WHERE profile=? AND session=? ORDER BY id DESC LIMIT ?)")
        .run(profile, event.session, profile, event.session, MAX_EVENTS);
      this.db.exec(`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 4096);
        DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id,SUM(bytes) OVER (ORDER BY id DESC) total FROM events) WHERE total>${MAX_BYTES});`);
      if (["desktop.started", "desktop.done"].includes(event.kind) || (event.kind === "desktop.tool" && event.status === "done"))
        this.db.prepare("DELETE FROM streams WHERE profile=? AND session=?").run(profile, event.session);
      this.db.exec("COMMIT");
      this.privateFiles();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  checkpointStream(profile: string, session: string, stream: string, secrets: readonly string[] = []) {
    const key = `${profile}:${session}`, now = Date.now();
    if (now - (this.streamTimes.get(key) ?? 0) < 250) return;
    this.streamTimes.set(key, now);
    if (this.streamTimes.size > 256) this.streamTimes.delete(this.streamTimes.keys().next().value!);
    this.db.prepare("INSERT INTO streams(profile,session,at,body) VALUES(?,?,?,?) ON CONFLICT(profile,session) DO UPDATE SET at=excluded.at,body=excluded.body")
      .run(profile, session, now, this.redact(stream, 32_000, secrets) ?? "");
    this.db.exec("DELETE FROM streams WHERE rowid NOT IN (SELECT rowid FROM streams ORDER BY at DESC LIMIT 256)");
    this.privateFiles();
  }
  restore(profile: string, session: string): SessionProgress | undefined {
    const rows = this.db.prepare("SELECT body FROM events WHERE profile=? AND session=? ORDER BY id").all(profile, session) as { body: string }[];
    if (!rows.length) return undefined;
    const state: SessionProgress = { stream: "", tools: [], journal: [] };
    for (const row of rows) applyJournalEvent(state, JSON.parse(row.body));
    const stream = this.db.prepare("SELECT body FROM streams WHERE profile=? AND session=?").get(profile, session) as { body: string } | undefined;
    if (state.running) {
      state.interrupted = true;
      state.running = false;
      state.stream = stream?.body ?? "";
      state.error = state.error ?? "This run was interrupted. Review its recorded actions before continuing; pending approvals were cancelled and no actions were replayed.";
      state.tools = state.tools.map(event => event.status === "running" ? { ...event, status: "interrupted" } : event);
    }
    state.approval = undefined;
    return state;
  }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}

export function applyJournalEvent(state: SessionProgress, event: Event) {
  if (event.kind === "desktop.delta") state.stream = (state.stream + event.chunk).slice(-32_000);
  if (event.kind === "desktop.started") {
    state.stream = ""; state.error = undefined; state.approval = undefined; state.usage = undefined;
    state.interrupted = false; state.running = true;
  }
  if (event.kind === "desktop.tool") {
    state.running = true;
    state.tools.push(event); state.tools = state.tools.slice(-MAX_EVENTS);
    if (event.status === "done") state.stream = "";
  }
  if (event.kind === "desktop.approval") { state.approval = event; state.running = true; }
  if (event.kind === "desktop.approval.resolved") state.approval = undefined;
  if (event.kind === "desktop.usage") state.usage = event;
  if (event.kind === "desktop.error") state.error = event.message;
  if (event.kind === "desktop.done") { state.stream = ""; state.approval = undefined; state.running = false; }
  if (kinds.has(event.kind)) { state.journal.push(event); state.journal = state.journal.slice(-MAX_EVENTS); }
}
