/** Slack Socket Mode with a durable inbox. Credentials stay in the sidecar.
 * A remote message uses the same agent and approval boundary as a local turn.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SlackConfig { profile: string; root: string; channels: string[]; users: string[] }
export interface SlackJob { id: string; team: string; channel: string; thread: string; user: string; input: string; profile: string; root: string; session?: string; message?: string; answer?: string; status: string; error?: string }
type Socket = Pick<WebSocket, "addEventListener" | "send" | "close" | "readyState">;
type Execute = (job: SlackJob, bind: (session: string) => void) => Promise<string>;
export class SlackBot {
  private db: DatabaseSync;
  private botToken = "";
  private appToken = "";
  private socket?: Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private connecting = false;
  private working = false;
  private generation = 0;
  private retries = 0;
  private team = "";
  private bot = "";
  private config?: SlackConfig;
  private connection = "Disconnected";
  private closed = false;
  constructor(dir: string, private execute: Execute, private emit: () => void = () => {}, private fetcher: typeof fetch = fetch,
    private createSocket: (url: string) => Socket = url => new WebSocket(url)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "slack.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, session TEXT NOT NULL)");
    const saved = this.db.prepare("SELECT value FROM settings WHERE id=1").get() as { value: string } | undefined;
    if (saved) this.config = JSON.parse(saved.value);
    for (const job of this.jobs()) if (job.status === "running") this.put({ ...job, status: "failed", error: "Hades restarted during this turn. Open the conversation to inspect it before starting another request." });
  }
  credentials(bot: string, app: string) {
    if (this.working) throw new Error("Wait for the active Slack turn before changing credentials.");
    if (this.enabled) this.disconnect();
    this.botToken = bot; this.appToken = app;
  }
  configure(config: SlackConfig) {
    if (this.enabled || this.working) throw new Error("Disconnect Slack and wait for active work before changing its workspace.");
    if (!config.profile || !config.root || !Array.isArray(config.channels) || !Array.isArray(config.users) ||
      !config.channels.length || !config.users.length || config.channels.length > 100 || config.users.length > 100 ||
      config.channels.some(x => !/^[CG][A-Z0-9]{1,30}$/.test(x)) || config.users.some(x => !/^[UW][A-Z0-9]{1,30}$/.test(x)))
      throw new Error("Choose a project and agent, and allow at least one Slack channel ID and member ID.");
    this.config = { ...config, channels: [...new Set(config.channels)], users: [...new Set(config.users)] };
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES (1, ?)").run(JSON.stringify(this.config));
    return this.status();
  }
  jobs(): SlackJob[] { return (this.db.prepare("SELECT value FROM inbox ORDER BY rowid DESC LIMIT 200").all() as { value: string }[]).map(r => JSON.parse(r.value)); }
  private put(job: SlackJob) { this.db.prepare("INSERT INTO inbox VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(job.id, JSON.stringify(job)); this.emit(); }
  private get(id: string): SlackJob | undefined { const row = this.db.prepare("SELECT value FROM inbox WHERE id=?").get(id) as { value: string } | undefined; return row && JSON.parse(row.value); }
  status() { return { connected: this.connection === "Connected", enabled: this.enabled, connection: this.connection, config: this.config, team: this.team, hasBotToken: !!this.botToken, hasAppToken: !!this.appToken, jobs: this.jobs() }; }
  private async api(method: string, body: object = {}, app = false): Promise<any> {
    const response = await this.fetcher(`https://slack.com/api/${method}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${app ? this.appToken : this.botToken}` }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}.`);
    const value = await response.json();
    if (!value.ok) throw new Error(`Slack ${method}: ${/^[a-z_]{1,80}$/.test(value.error) ? value.error : "request_failed"}.`);
    return value;
  }
  async channels() {
    let cursor = ""; const channels: Array<{ id: string; name: string }> = [];
    do { const page = await this.api("users.conversations", { types: "public_channel,private_channel", exclude_archived: true, limit: 100, cursor });
      channels.push(...(page.channels ?? []).map((c: any) => ({ id: c.id, name: c.name }))); cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor && channels.length < 1000);
    return channels;
  }
  async connect() {
    if (this.closed) throw new Error("Slack service has closed.");
    if (this.working && !this.enabled) throw new Error("Wait for the active Slack turn to stop before reconnecting.");
    if (!this.config) throw new Error("Save the Slack workspace settings first.");
    if (!this.botToken.startsWith("xoxb-") || !this.appToken.startsWith("xapp-")) throw new Error("Save a Slack bot token and Socket Mode app token first.");
    if (this.enabled) return this.status();
    this.enabled = true; const generation = ++this.generation;
    try { await this.open(generation); } catch (e) { if (generation === this.generation) this.disconnect(); throw e; }
    return this.status();
  }
  private async open(generation: number) {
    if (!this.enabled || generation !== this.generation || this.connecting) return;
    this.connecting = true;
    try {
      this.connection = "Connecting"; this.emit();
      const auth = await this.api("auth.test");
      const opened = await this.api("apps.connections.open", {}, true);
      if (!this.enabled || generation !== this.generation) return;
      if (!/^[A-Z0-9]+$/.test(auth.team_id) || !/^[A-Z0-9]+$/.test(auth.user_id)) throw new Error("Slack returned an invalid workspace identity.");
      const url = new URL(opened.url);
      if (url.protocol !== "wss:" || !url.hostname.endsWith(".slack.com") || url.username || url.password) throw new Error("Slack returned an unexpected Socket Mode address.");
      this.team = auth.team_id; this.bot = auth.user_id;
      const socket = this.createSocket(url.href); this.socket = socket;
      socket.addEventListener("message", event => {
        if (generation !== this.generation || socket !== this.socket) return;
        const raw = (event as MessageEvent).data;
        if (typeof raw !== "string" || raw.length > 256_000) return;
        try {
          const envelope = JSON.parse(raw);
          if (envelope.type === "hello") { clearTimeout(this.helloTimer); this.connection = "Connected"; this.retries = 0; this.emit(); void this.drain(); return; }
          if (envelope.type === "disconnect") { socket.close(); return; }
          if (envelope.type === "events_api") this.ingest(envelope.payload);
          // Persist before acknowledging. A crash before ack is safely deduplicated.
          if (typeof envelope.envelope_id === "string") socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        } catch { this.connection = "Could not accept a Slack event"; this.emit(); }
      });
      const retry = () => {
        if (!this.enabled || generation !== this.generation || this.socket !== socket) return;
        this.socket = undefined; clearTimeout(this.helloTimer); socket.close(); this.connection = "Reconnecting"; this.emit();
        this.schedule(generation);
      };
      socket.addEventListener("close", retry); socket.addEventListener("error", retry);
      this.helloTimer = setTimeout(retry, 20_000); this.helloTimer.unref();
    } finally { this.connecting = false; }
  }
  private schedule(generation: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.open(generation).catch(() => { if (this.enabled && generation === this.generation) { this.connection = "Connection failed; retrying"; this.emit(); this.schedule(generation); } }); }, Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5)));
    this.timer.unref();
  }
  /** Only explicitly mentioned agents in configured channels and by allowed members. */
  ingest(payload: any) {
    const e = payload?.event, c = this.config;
    if (!this.enabled || !c || payload.team_id !== this.team || payload.type !== "event_callback" ||
      e?.type !== "app_mention" || e.bot_id || e.subtype || e.user === this.bot || !c.channels.includes(e.channel) || !c.users.includes(e.user)) return;
    if (typeof payload.event_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.event_id) ||
      typeof e.text !== "string" || e.text.length > 40_000 || !/^\d{1,20}\.\d{1,20}$/.test(e.ts) ||
      (e.thread_ts !== undefined && !/^\d{1,20}\.\d{1,20}$/.test(e.thread_ts))) return;
    if (!e.text.includes(`<@${this.bot}>`)) return;
    const input = e.text.split(`<@${this.bot}>`).join("").trim(); if (!input) return;
    const id = `${this.team}-${payload.event_id}`;
    if (this.get(id)) return;
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE json_extract(value, '$.status') IN ('queued','running')").get() as { count: number };
    if (pending.count >= 100) throw new Error("Slack queue is full");
    this.put({ id, team: this.team, channel: e.channel, thread: e.thread_ts ?? e.ts, user: e.user, input, profile: c.profile, root: c.root, status: "queued" });
    void this.drain();
  }
  private async drain() {
    if (this.working || !this.enabled || this.connection !== "Connected") return;
    this.working = true;
    try {
      while (this.enabled) {
        const row = this.db.prepare("SELECT value FROM inbox WHERE json_extract(value, '$.status')='queued' ORDER BY rowid LIMIT 1").get() as { value: string } | undefined;
        if (!row) break;
        const job: SlackJob = JSON.parse(row.value);
        const config = this.config!;
        if (job.team !== this.team || job.root !== config.root || job.profile !== config.profile || !config.channels.includes(job.channel) || !config.users.includes(job.user)) {
          this.put({ ...job, status: "failed", error: "This request no longer matches the connected workspace or access settings." }); continue;
        }
        const threadKey = JSON.stringify([job.team, job.channel, job.thread, job.profile, job.root]);
        job.session = (this.db.prepare("SELECT session FROM threads WHERE id=?").get(threadKey) as { session: string } | undefined)?.session;
        job.status = "running"; this.put(job);
        try {
          const posted = await this.api("chat.postMessage", { channel: job.channel, thread_ts: job.thread, text: "Working in Hades. File changes and commands may need approval in the desktop app.", unfurl_links: false, unfurl_media: false });
          if (typeof posted.ts !== "string") throw new Error("Slack did not confirm the progress message.");
          job.message = posted.ts; this.put(job);
          if (!this.enabled) throw new Error("Slack disconnected before the agent started.");
          job.answer = await this.execute(job, session => { job.session = session; this.db.prepare("INSERT OR REPLACE INTO threads VALUES (?, ?)").run(threadKey, session); this.put(job); });
          job.status = "ready"; this.put(job);
          if (this.enabled && job.team === this.team) await this.publish(job.id);
        } catch (e) {
          job.status = job.answer ? "ready" : "failed";
          job.error = e instanceof Error ? e.message : "Slack request failed";
          this.put(job);
          if (!job.answer && job.message && this.enabled && job.team === this.team) await this.api("chat.update", { channel: job.channel, ts: job.message, text: "Hades could not complete this request. Open its conversation in the desktop app for details." }).catch(() => {});
        }
      }
    } finally { this.working = false; if (this.closed) this.db.close(); }
  }
  async publish(id: string) {
    const job = this.get(id);
    if (!job || job.status !== "ready" || !job.message || !job.answer) throw new Error("No completed reply to publish.");
    if (!this.enabled || this.team !== job.team) throw new Error("Reconnect to the original Slack workspace before publishing.");
    const answer = job.answer.length > 35_000 ? job.answer.slice(0, 35_000) + "\n[Full response saved in the Hades conversation.]" : job.answer;
    // Updating an existing message is retryable even after an ambiguous network failure.
    await this.api("chat.update", { channel: job.channel, ts: job.message, text: answer });
    this.put({ ...job, status: "sent", error: undefined });
    return true;
  }
  disconnect() {
    const changed = this.enabled || this.connection !== "Disconnected";
    this.enabled = false; ++this.generation; clearTimeout(this.timer); clearTimeout(this.helloTimer);
    const socket = this.socket; this.socket = undefined; socket?.close();
    this.connection = "Disconnected"; if (changed && !this.closed) this.emit();
    return true;
  }
  close() { if (this.closed) return; this.disconnect(); this.closed = true; if (!this.working) this.db.close(); }
}
