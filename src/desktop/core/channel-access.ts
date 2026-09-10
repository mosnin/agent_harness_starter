/** Native decisions for identities authenticated by a channel transport. No message bodies are stored. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export interface ChannelIdentity { transport: "slack"; account: string; channel: string; user: string; profile: string }
export interface ChannelAccess extends ChannelIdentity { id: string; status: "pending" | "approved" | "blocked"; grant?: "configuration" | "pairing"; createdAt: number; expiresAt?: number; requiresApproval?: boolean }
export class ChannelAccessStore {
  private db: DatabaseSync;
  constructor(path: string, private changed: () => void = () => {}, private now = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS access (identity TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, profile TEXT NOT NULL, value TEXT NOT NULL)");
  }
  private key(i: ChannelIdentity) {
    if (i.transport !== "slack" || !/^T[A-Z0-9]{1,30}$/.test(i.account) || !/^[CG][A-Z0-9]{1,30}$/.test(i.channel) || !/^[UW][A-Z0-9]{1,30}$/.test(i.user) || !/^[\w.-]{1,100}$/.test(i.profile)) throw new Error("Invalid authenticated channel identity.");
    return JSON.stringify([i.transport, i.account, i.channel, i.user, i.profile]);
  }
  private put(row: ChannelAccess) { this.db.prepare("INSERT INTO access VALUES (?,?,?,?) ON CONFLICT(identity) DO UPDATE SET id=excluded.id,value=excluded.value").run(this.key(row), row.id, row.profile, JSON.stringify(row)); this.changed(); return row; }
  private get(id: string, profile: string): ChannelAccess { const row = this.db.prepare("SELECT value FROM access WHERE id=? AND profile=?").get(id, profile) as { value: string } | undefined; if (!row) throw new Error("Access request not found for this agent."); return JSON.parse(row.value); }
  list(profile: string): ChannelAccess[] { return (this.db.prepare("SELECT value FROM access WHERE profile=? ORDER BY rowid DESC").all(profile) as { value: string }[]).map(r => JSON.parse(r.value)); }
  authorize(identity: ChannelIdentity, configured: boolean): boolean {
    const key = this.key(identity), saved = this.db.prepare("SELECT value FROM access WHERE identity=?").get(key) as { value: string } | undefined;
    const row: ChannelAccess | undefined = saved && JSON.parse(saved.value);
    if (row?.status === "blocked") return false;
    if (row?.status === "approved" && row.grant === "pairing") return true;
    if (configured && !row?.requiresApproval) {
      if (row?.status !== "approved" || row.grant !== "configuration") this.put({ ...identity, id: row?.id ?? randomUUID(), status: "approved", grant: "configuration", createdAt: this.now() });
      return true;
    }
    if (row?.status === "pending" && row.expiresAt! > this.now()) return false;
    this.db.prepare("DELETE FROM access WHERE json_extract(value,'$.status')='pending' AND json_extract(value,'$.expiresAt')<=? AND COALESCE(json_extract(value,'$.requiresApproval'),0)=0").run(this.now());
    const count = this.db.prepare("SELECT COUNT(*) n FROM access").get() as { n: number };
    const pending = this.list(identity.profile).filter(r => r.status === "pending" && (r.expiresAt ?? 0) > this.now()).length;
    if ((count.n >= 1000 && !row) || pending >= 100) return false;
    this.put({ ...identity, id: randomUUID(), status: "pending", createdAt: this.now(), expiresAt: this.now() + 86_400_000, requiresApproval: row?.requiresApproval }); return false;
  }
  approve(id: string, profile: string) {
    const row = this.get(id, profile);
    if (row.status !== "pending" || !row.expiresAt || row.expiresAt <= this.now()) throw new Error("A fresh pending request is required. Ask this member to mention the agent again.");
    return this.put({ ...row, status: "approved", grant: "pairing", expiresAt: undefined, requiresApproval: undefined });
  }
  revoke(id: string, profile: string) { return this.put({ ...this.get(id, profile), status: "blocked", grant: undefined, expiresAt: undefined }); }
  /** Clearing a block grants no access. A new authenticated request must be approved. */
  reset(id: string, profile: string) { const row = this.get(id, profile); if (row.status !== "blocked") throw new Error("Only blocked access can be reset."); return this.put({ ...row, status: "pending", requiresApproval: true, expiresAt: 0 }); }
  close() { this.db.close(); }
}
