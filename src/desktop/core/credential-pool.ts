import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import type { ChatRequest, ModelClient } from "../../hades/models/client";
import { HttpProviderError } from "../../hades/models/client";

type Provider = "openai" | "openrouter" | "anthropic";
interface Entry { id: string; profile: string; provider: Provider; account: string; label: string; enabled: boolean; createdAt: number; lastUsed?: number; cooldownUntil?: number; rejected?: boolean; error?: string }
export class CredentialPool {
  private db: DatabaseSync;
  private closed = false;
  private active = new Set<AbortController>();
  constructor(path: string, private secret: (account: string) => string | undefined, private now = Date.now) {
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, profile TEXT NOT NULL, provider TEXT NOT NULL, body TEXT NOT NULL)");
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }
  private check() { if (this.closed) throw new Error("Credential pool is closed"); }
  private profile(id: string) { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid credential profile"); }
  private entries(profile: string, provider?: string): Entry[] {
    this.check(); this.profile(profile);
    return (this.db.prepare("SELECT body FROM credentials WHERE profile=? ORDER BY rowid").all(profile) as { body: string }[])
      .map(row => JSON.parse(row.body)).filter(entry => !provider || entry.provider === provider);
  }
  private entry(id: string, profile: string) { const entry = this.entries(profile).find(e => e.id === id); if (!entry) throw new Error("Credential belongs to another profile or was removed"); return entry; }
  private save(entry: Entry) { this.db.prepare("INSERT INTO credentials(id,profile,provider,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(entry.id, entry.profile, entry.provider, JSON.stringify(entry)); }
  list(profile: string) {
    return this.entries(profile).map(entry => {
      const key = this.secret(entry.account);
      return { ...entry, configured: Boolean(key), masked: key ? "••••" + (key.length > 8 ? key.slice(-4) : "") : undefined,
        status: !entry.enabled ? "disabled" : !key ? "missing" : entry.rejected ? "rejected" : (entry.cooldownUntil ?? 0) > this.now() ? "cooling_down" : "ready" };
    });
  }
  accounts() { this.check(); return (this.db.prepare("SELECT body FROM credentials").all() as { body: string }[]).map(row => (JSON.parse(row.body) as Entry).account); }
  add(profile: string, provider: unknown, label: unknown) {
    this.check(); this.profile(profile);
    if (typeof provider !== "string" || !["openai", "openrouter", "anthropic"].includes(provider)) throw new Error("Choose an API-key provider; Codex uses its subscription login");
    if (typeof label !== "string" || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new Error("Name this credential (up to 80 characters)");
    if (this.entries(profile, String(provider)).length >= 8 || (this.db.prepare("SELECT count(*) AS n FROM credentials").get() as { n: number }).n >= 128) throw new Error("Credential pool limit reached");
    const id = randomUUID(), entry: Entry = { id, profile, provider: provider as Provider, label: label.trim(), account: `pool:${profile}:${provider}:${id}`, enabled: false, createdAt: this.now() };
    if (entry.account.length > 120) throw new Error("Profile identifier is too long for Keychain");
    this.save(entry); return { ...entry };
  }
  update(id: string, profile: string, enabled: unknown) {
    if (typeof enabled !== "boolean") throw new Error("Choose whether to enable this credential");
    const entry = this.entry(id, profile);
    if (enabled && !this.secret(entry.account)) throw new Error("Save this key in Keychain before enabling it");
    entry.enabled = enabled; entry.rejected = false; entry.cooldownUntil = undefined; entry.error = undefined; this.save(entry); return this.list(profile).find(e => e.id === id);
  }
  remove(id: string, profile: string) { const entry = this.entry(id, profile); this.db.prepare("DELETE FROM credentials WHERE id=? AND profile=?").run(id, profile); return { account: entry.account }; }
  /** Rotate only after a definitive, pre-response HTTP credential/rate-limit rejection.
   * Timeouts, stream failures and ambiguous outcomes never trigger another request. */
  client(profile: string, provider: string, factory: (key: string) => ModelClient, fallback: () => ModelClient): ModelClient {
    this.profile(profile);
    if (!["openai", "openrouter", "anthropic"].includes(provider)) throw new Error("Invalid credential provider");
    return { chat: async (request: ChatRequest) => {
      this.check();
      const controller = new AbortController(); this.active.add(controller);
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      const input = { ...request, signal };
      const invoke = async (client: ModelClient) => {
        try {
          signal.throwIfAborted();
          const result = await abortable(client.chat(input), signal);
          signal.throwIfAborted(); this.check(); return result;
        } finally { try { client.close?.(); } catch { /* Cleanup cannot replace an inference outcome. */ } }
      };
      try {
        signal.throwIfAborted();
        const enabled = this.entries(profile, provider).filter(e => e.enabled);
        if (!enabled.length) return await invoke(fallback());
        const candidates = enabled.filter(e => this.secret(e.account) && !e.rejected && (e.cooldownUntil ?? 0) <= this.now()).sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
        if (!candidates.length) throw new Error("No ready credentials in this pool. Review rejected keys or wait for rate-limit recovery.");
        let last: unknown, attempts = 0;
        for (const candidate of candidates) {
          signal.throwIfAborted(); this.check();
          const live = this.entries(profile, provider).find(e => e.id === candidate.id);
          const key = live && this.secret(live.account);
          if (!live?.enabled || !key || live.rejected || (live.cooldownUntil ?? 0) > this.now()) continue;
          if (++attempts > 3) break;
          live.lastUsed = this.now(); this.save(live);
          const client = factory(key);
          try { return await invoke(client); }
          catch (error) {
            last = error;
            if (this.closed || signal.aborted || !(error instanceof HttpProviderError) || ![401, 403, 429].includes(error.status)) throw error;
            const current = this.entries(profile, provider).find(e => e.id === live.id);
            // A late rejection for an old key cannot invalidate a replacement.
            if (current?.enabled && this.secret(current.account) === key) {
              current.rejected = error.status !== 429;
              current.cooldownUntil = error.status === 429 ? this.now() + Math.max(1000, Math.min(300000, error.retryAfterMs ?? 60000)) : undefined;
              current.error = error.status === 429 ? "Provider rate limit; waiting before reuse" : "Provider rejected this credential; save a valid key and enable it again";
              this.save(current);
            }
          }
        }
        throw last ?? new Error("The selected credentials were removed or disabled");
      } finally { this.active.delete(controller); }
    } };
  }

  close() { if (!this.closed) { this.closed = true; for (const active of this.active) active.abort(new Error("Credential pool is closed")); this.active.clear(); this.db.close(); } }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Credential request cancelled"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
