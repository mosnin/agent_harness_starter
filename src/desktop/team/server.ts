import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { TeamStore, TeamError } from "./store";
export class TeamServer {
  private server: Server;
  private rates = new Map<string, { at: number; count: number }>();
  constructor(readonly store: TeamStore) {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 15_000; this.server.headersTimeout = 10_000;
  }
  async listen(port = 0, host = "127.0.0.1") {
    if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Use a TLS reverse proxy for remote team access. The team service binds to loopback.");
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, () => { this.server.removeListener("error", reject); resolve(); }); });
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  private async body(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new TeamError(415, "Send JSON.");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      const b = Buffer.from(chunk); bytes += b.length; chunks.push(b);
      if (bytes > 180_000) throw new TeamError(413, "Message is too large.");
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new TeamError(400, "Invalid JSON."); }
  }
  private send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(data));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      // This is a desktop-to-service API. Browsers get no credentialed CORS path.
      if (req.headers.origin) throw new TeamError(403, "Browser-origin requests are not accepted.");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return this.send(res, 200, { service: "hades-team", version: 1 });
      const ip = req.socket.remoteAddress ?? "local", now = Date.now();
      const rate = this.rates.get(ip) ?? { at: now, count: 0 };
      if (now - rate.at > 60_000) { rate.at = now; rate.count = 0; }
      if (++rate.count > 600) throw new TeamError(429, "Too many requests. Wait a moment.");
      this.rates.set(ip, rate);
      if (this.rates.size > 10_000) for (const [key, row] of this.rates) if (now - row.at > 60_000) this.rates.delete(key);
      if (req.method === "POST" && url.pathname === "/join") {
        const body = await this.body(req); return this.send(res, 200, this.store.join(body.invite, body.name));
      }
      const member = this.store.authenticate((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (req.method === "GET" && url.pathname === "/team") return this.send(res, 200, this.store.snapshot(member));
      if (req.method === "GET" && url.pathname === "/messages") return this.send(res, 200, this.store.messages(member, url.searchParams.get("channel") ?? "", Number(url.searchParams.get("after") ?? 0), url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined));
      if (req.method !== "POST") throw new TeamError(404, "Unknown team action.");
      const body = await this.body(req);
      this.store.authenticate((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const result = url.pathname === "/invite" ? this.store.invite(member)
        : url.pathname === "/revoke" ? this.store.revoke(member, body.member)
        : url.pathname === "/channels" ? this.store.createChannel(member, body.name)
        : url.pathname === "/messages" ? this.store.send(member, body)
        : url.pathname === "/read" ? this.store.markRead(member, body.channel, body.seq)
        : undefined;
      if (result === undefined) throw new TeamError(404, "Unknown team action.");
      this.send(res, 200, result);
    } catch (error) {
      this.send(res, error instanceof TeamError ? error.status : 500, { error: error instanceof TeamError ? error.message : "Team service could not complete the request." });
    }
  }
  async close() { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
