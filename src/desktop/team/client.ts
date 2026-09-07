import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { TeamStore, value } from "./store";
import { TeamServer } from "./server";
export function teamEndpoint(input: string) {
  const u = new URL(input);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/" || (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new Error("Use an HTTPS team server, or a loopback HTTP address for this Mac.");
  return u.origin;
}
/** Credential is held in the sidecar, restored by Rust from macOS Keychain. */
export class TeamClient {
  private endpoint = "";
  private token = "";
  private server?: TeamServer;
  private store?: TeamStore;
  private config: { endpoint: string; localPort?: number } = { endpoint: "" };
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(join(dir, "connection.json"))) this.config = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8"));
    if (this.config.endpoint) this.endpoint = teamEndpoint(this.config.endpoint);
  }
  address() { return this.endpoint; }
  publisher(teamId: string) { const endpoint = this.endpoint, token = this.token; return async (body: unknown) => {
    if (!teamId || (await this.call("/team", undefined, endpoint, token)).id !== teamId) throw new Error("The team at this address has changed. Reply was not published.");
    return this.call("/messages", body, endpoint, token);
  }; }
  credentials() { return { token: this.token }; }
  restore(token: string) { this.token = token; }
  private save() {
    const path = join(this.dir, "connection.json");
    writeFileSync(path + ".tmp", JSON.stringify(this.config), { mode: 0o600 }); renameSync(path + ".tmp", path);
  }
  private async local(port = 0) {
    if (this.server) return this.endpoint;
    const store = new TeamStore(join(this.dir, "team.sqlite"));
    const server = new TeamServer(store);
    try { const endpoint = await server.listen(port); this.store = store; this.server = server; return endpoint; }
    catch (error) { store.close(); throw error; }
  }
  async create(name: string, owner: string) {
    value(name, "team name", 80); value(owner, "name", 80);
    if (this.config.endpoint && this.token) throw new Error("Disconnect from the current team before creating another.");
    const endpoint = await this.local(this.config.localPort ?? 0);
    if (this.store!.initialized()) {
      if (!this.token) throw new Error("A team already exists on this Mac. Restore its Keychain access or join with an owner-issued invitation.");
    } else this.token = this.store!.create(name, owner).token;
    this.endpoint = endpoint; this.config = { endpoint, localPort: Number(new URL(endpoint).port) }; this.save();
    return this.credentials();
  }
  async join(endpoint: string, invite: string, name: string) {
    endpoint = teamEndpoint(endpoint);
    const health = await this.call("/health", undefined, endpoint, "");
    if (health.service !== "hades-team" || health.version !== 1) throw new Error("This address is not a compatible Hades team server.");
    const result = await this.call("/join", { invite, name }, endpoint, "");
    await this.close();
    this.endpoint = endpoint; this.token = result.token; this.config = { endpoint }; this.save();
    return this.credentials();
  }
  private async ensure() {
    if (!this.endpoint || !this.token) throw new Error("Create or join a team first.");
    if (this.config.localPort && !this.server) this.endpoint = await this.local(this.config.localPort);
  }
  async call(path: string, body?: unknown, endpoint = this.endpoint, token = this.token) {
    const response = await fetch(endpoint + path, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (Number(response.headers.get("content-length")) > 8_000_000) throw new Error("Team response is too large.");
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error("Team response is too large.");
    const result = JSON.parse(text);
    if (!response.ok) throw new Error(result.error ?? `Team request failed (${response.status}).`);
    return result;
  }
  async status() {
    if (!this.endpoint || !this.token) return { connected: false, endpoint: this.endpoint };
    try { await this.ensure(); return { connected: true, endpoint: this.endpoint, local: !!this.config.localPort, ...await this.call("/team") }; }
    catch (error) { return { connected: false, endpoint: this.endpoint, message: error instanceof Error ? error.message : "Team unavailable" }; }
  }
  async request(method: string, args: Record<string, any>) {
    await this.ensure();
    switch (method) {
      case "messages": return this.call(`/messages?channel=${encodeURIComponent(value(args.channel, "channel"))}&after=${Number(args.after ?? 0)}${args.before ? `&before=${Number(args.before)}` : ""}`);
      case "send": return this.call("/messages", args);
      case "invite": return this.call("/invite", {});
      case "channel": return this.call("/channels", args);
      case "revoke": return this.call("/revoke", args);
      case "read": return this.call("/read", args);
      default: throw new Error("Unknown team action");
    }
  }
  async disconnect() { await this.close(); this.token = ""; this.endpoint = ""; this.config = { endpoint: "" }; this.save(); return true; }
  async close() { if (this.server) await this.server.close(); this.server = undefined; this.store?.close(); this.store = undefined; }
}
