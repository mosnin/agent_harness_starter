import { DatabaseSync } from "node:sqlite";

/** Operational metadata only. Never persist prompts, arguments, tool output,
 * credentials, or arbitrary provider errors in the activity feed. */
export class ActivityStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
        profile TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        tool TEXT, tokens_in INTEGER, tokens_out INTEGER);
      CREATE INDEX IF NOT EXISTS activity_profile ON activity(profile,id);`);
  }
  record(profile: string, event: Record<string, unknown>) {
    const kind = event.kind;
    if (!["desktop.tool", "desktop.approval", "desktop.error", "desktop.done", "desktop.usage"].includes(String(kind))) return;
    if (typeof event.session !== "string") return;
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const tool = typeof event.tool === "string" && /^[\w.-]{1,160}$/.test(event.tool) ? event.tool : null;
    const status = (kind === "desktop.error" || event.ok === false) ? "error" : kind === "desktop.approval" ? "approval" : event.status === "running" ? "running" : "recorded";
    this.db.prepare("INSERT INTO activity(at,profile,session,kind,status,tool,tokens_in,tokens_out) VALUES(?,?,?,?,?,?,?,?)")
      .run(Date.now(), profile, event.session, String(kind).replace("desktop.", ""), status, tool, count(event.tokensIn), count(event.tokensOut));
  }
  list(profile: string, options: { before?: number; errors?: boolean; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
    return this.db.prepare(`SELECT id,at,session,kind,status,tool,tokens_in AS tokensIn,tokens_out AS tokensOut FROM activity
      WHERE profile=? AND id<? AND (?=0 OR status='error') ORDER BY id DESC LIMIT ?`)
      .all(profile, options.before ?? Number.MAX_SAFE_INTEGER, options.errors ? 1 : 0, limit);
  }
  usage(profile: string) {
    return this.db.prepare("SELECT COUNT(*) AS turns,COALESCE(SUM(tokens_in),0) AS tokensIn,COALESCE(SUM(tokens_out),0) AS tokensOut,MIN(at) AS since FROM activity WHERE profile=? AND kind='usage'").get(profile);
  }
  close() { this.db.close(); }
}
