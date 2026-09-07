/** One durable team service, many authenticated desktop clients. */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
export type Member = { id: string; name: string; role: "owner" | "member"; revoked: number };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export class TeamError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function value(v: unknown, name: string, max = 100) {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new TeamError(400, `Invalid ${name}`);
  return v.trim();
}
export class TeamStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_by TEXT NOT NULL REFERENCES members(id));
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, channel TEXT NOT NULL REFERENCES channels(id), member TEXT NOT NULL REFERENCES members(id), content TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to TEXT REFERENCES messages(id), agent TEXT, request_id TEXT NOT NULL, UNIQUE(member, request_id));
      CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages(channel, seq);
      CREATE TABLE IF NOT EXISTS read_cursors (member TEXT NOT NULL REFERENCES members(id), channel TEXT NOT NULL REFERENCES channels(id), seq INTEGER NOT NULL, PRIMARY KEY(member, channel));
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('id', ?)").run(randomUUID());
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private audit(actor: string, action: string, target: string) { this.db.prepare("INSERT INTO audit(actor,action,target,at) VALUES(?,?,?,?)").run(actor, action, target, Date.now()); }
  initialized() { return Boolean(this.db.prepare("SELECT id FROM members LIMIT 1").get()); }
  /** Bootstrap is callable only by the host application, never over HTTP. */
  create(name: string, owner: string) {
    return this.transaction(() => {
      if (this.initialized()) throw new TeamError(409, "This team already exists.");
      const token = secret(), id = randomUUID();
      this.db.prepare("INSERT INTO settings VALUES('name',?)").run(value(name, "team name", 80));
      this.db.prepare("INSERT INTO members(id,name,role,token_hash) VALUES(?,?,'owner',?)").run(id, value(owner, "your name", 80), digest(token));
      this.db.prepare("INSERT INTO channels VALUES(?,?,?)").run(randomUUID(), "general", id);
      this.audit(id, "team.create", id);
      return { token, member: { id, name: owner, role: "owner" } };
    });
  }
  authenticate(token: string): Member {
    if (!/^[\w-]{43}$/.test(token)) throw new TeamError(401, "Reconnect to your team.");
    const member = this.db.prepare("SELECT id,name,role,revoked FROM members WHERE token_hash=? AND revoked=0").get(digest(token)) as Member | undefined;
    if (!member) throw new TeamError(401, "Your team access has expired or was revoked.");
    return member;
  }
  private owner(member: Member) { if (member.role !== "owner") throw new TeamError(403, "Only the team owner can manage membership."); }
  private channel(id: string) { if (!this.db.prepare("SELECT id FROM channels WHERE id=?").get(id)) throw new TeamError(404, "Channel not found."); }
  snapshot(member: Member) {
    return {
      id: (this.db.prepare("SELECT value FROM settings WHERE key='id'").get() as any).value,
      name: (this.db.prepare("SELECT value FROM settings WHERE key='name'").get() as any)?.value,
      member,
      members: this.db.prepare("SELECT id,name,role FROM members WHERE revoked=0 ORDER BY name").all(),
      channels: this.db.prepare(`SELECT c.id,c.name,COALESCE(r.seq,0) AS readSeq,
        (SELECT COUNT(*) FROM messages m WHERE m.channel=c.id AND m.seq>COALESCE(r.seq,0) AND m.member<>?) AS unread
        FROM channels c LEFT JOIN read_cursors r ON r.channel=c.id AND r.member=? ORDER BY c.name`).all(member.id, member.id),
    };
  }
  invite(member: Member) {
    this.owner(member);
    const token = secret(), expires = Date.now() + 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM invites WHERE expires<? OR used=1").run(Date.now());
    this.db.prepare("INSERT INTO invites(hash,expires) VALUES(?,?)").run(digest(token), expires);
    this.audit(member.id, "invite.create", digest(token));
    return { invite: token, expires };
  }
  join(invite: string, name: string) {
    value(invite, "invitation", 100); value(name, "name", 80);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT hash FROM invites WHERE hash=? AND used=0 AND expires>?").get(digest(invite), Date.now());
      if (!row) throw new TeamError(403, "Invitation is invalid, used, or expired.");
      const token = secret(), id = randomUUID();
      this.db.prepare("UPDATE invites SET used=1 WHERE hash=?").run(digest(invite));
      this.db.prepare("INSERT INTO members(id,name,role,token_hash) VALUES(?,?,'member',?)").run(id, name, digest(token));
      this.audit(id, "member.join", id);
      return { token, member: { id, name, role: "member" } };
    });
  }
  revoke(member: Member, id: string) {
    this.owner(member);
    if (id === member.id) throw new TeamError(400, "The owner cannot remove their own access.");
    this.db.prepare("UPDATE members SET revoked=1 WHERE id=? AND role<>'owner'").run(id);
    this.audit(member.id, "member.revoke", id);
    return true;
  }
  createChannel(member: Member, name: string) {
    name = value(name, "channel name", 60);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new TeamError(400, "Use lowercase letters, numbers, hyphens or underscores.");
    if (this.db.prepare("SELECT id FROM channels WHERE name=?").get(name)) throw new TeamError(409, "That channel already exists.");
    const id = randomUUID(); this.db.prepare("INSERT INTO channels VALUES(?,?,?)").run(id, name, member.id);
    this.audit(member.id, "channel.create", id); return { id, name };
  }
  messages(member: Member, channel: string, after = 0, before?: number) {
    this.channel(channel);
    if (!Number.isSafeInteger(after) || after < 0 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new TeamError(400, "Invalid history cursor");
    const columns = "m.seq,m.id,m.channel,m.content,m.created_at AS at,m.reply_to AS replyTo,m.agent,u.id AS member,u.name AS sender";
    if (before !== undefined) return this.db.prepare(`SELECT ${columns} FROM messages m JOIN members u ON u.id=m.member WHERE m.channel=? AND m.seq<? ORDER BY m.seq DESC LIMIT 100`).all(channel, before).reverse();
    if (!after) return this.db.prepare(`SELECT ${columns} FROM messages m JOIN members u ON u.id=m.member WHERE m.channel=? ORDER BY m.seq DESC LIMIT 100`).all(channel).reverse();
    return this.db.prepare(`SELECT ${columns} FROM messages m JOIN members u ON u.id=m.member WHERE m.channel=? AND m.seq>? ORDER BY m.seq LIMIT 100`).all(channel, after);
  }
  send(member: Member, data: Record<string, unknown>) {
    const channel = value(data.channel, "channel"), content = value(data.content, "message", 40_000), requestId = value(data.requestId, "message identifier");
    const replyTo = data.replyTo ? value(data.replyTo, "reply") : null;
    const agent = data.agent ? value(data.agent, "agent name", 80) : null;
    this.channel(channel);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id,channel,content,reply_to,agent FROM messages WHERE member=? AND request_id=?").get(member.id, requestId) as any;
      if (existing) {
        if (existing.channel !== channel || existing.content !== content || existing.reply_to !== replyTo || existing.agent !== agent) throw new TeamError(409, "Message identifier was already used for different content.");
        return { id: existing.id, duplicate: true };
      }
      if (replyTo && !this.db.prepare("SELECT id FROM messages WHERE id=? AND channel=?").get(replyTo, channel)) throw new TeamError(400, "Reply must belong to this channel.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO messages(id,channel,member,content,created_at,reply_to,agent,request_id) VALUES(?,?,?,?,?,?,?,?)").run(id, channel, member.id, content, Date.now(), replyTo, agent, requestId);
      return { id, duplicate: false };
    });
  }
  markRead(member: Member, channel: string, seq: number) {
    this.channel(channel);
    const max = Number((this.db.prepare("SELECT MAX(seq) AS n FROM messages WHERE channel=?").get(channel) as any).n ?? 0);
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max) throw new TeamError(400, "Invalid read position");
    this.db.prepare("INSERT INTO read_cursors VALUES(?,?,?) ON CONFLICT(member,channel) DO UPDATE SET seq=MAX(seq,excluded.seq)").run(member.id, channel, seq);
    return true;
  }
  close() { this.db.close(); }
}
