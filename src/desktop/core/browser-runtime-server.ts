import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserRuntimeDescriptor {
  version: 1;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: number;
}

/** Same-user discovery. No general desktop RPC is exposed to the browser. */
export class BrowserRuntimeServer {
  private server?: Server;
  private descriptor?: BrowserRuntimeDescriptor;
  private closed = false;
  private pairing = false;
  readonly path: string;

  constructor(dataDir: string, private readonly dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    this.path = join(dataDir, "browser-runtime.json");
  }

  async start(): Promise<void> {
    if (this.server || this.closed) return;
    const token = randomBytes(32).toString("hex");
    const server = createServer((request, response) => {
      void this.handle(request, response, token).catch(() => this.reply(response, 500, { error: "The Agent could not complete this request." }));
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.unref();
    if (this.closed) { server.close(); return; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Agent discovery did not bind to loopback.");
    const descriptor: BrowserRuntimeDescriptor = { version: 1, endpoint: `http://127.0.0.1:${address.port}`, token, pid: process.pid, startedAt: Date.now() };
    this.descriptor = descriptor;
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
      if (this.closed) return;
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(() => undefined); }
  }

  close(): void {
    this.closed = true;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    const token = this.descriptor?.token;
    void readFile(this.path, "utf8").then(async raw => {
      if (token && JSON.parse(raw).token === token) await unlink(this.path);
    }).catch(() => undefined);
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const supplied = Buffer.from(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    const expected = Buffer.from(token);
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      this.reply(response, 403, { error: "Agent connection is not authorized." }); return;
    }
    const port = this.server?.address();
    if (!port || typeof port === "string" || request.headers.host !== `127.0.0.1:${port.port}`) {
      this.reply(response, 403, { error: "Invalid local destination." }); return;
    }
    if (request.method !== "POST" || !["/readiness", "/pair", "/helm-draft"].includes(request.url ?? "")) {
      this.reply(response, 404, { error: "Unknown Agent operation." }); return;
    }
    const chunks: Buffer[] = [];
    let bytes=0;
    const limit=request.url==="/helm-draft"?131072:16384;
    for await (const chunk of request) {
      bytes+=chunk.length;
      if (bytes > limit) { this.reply(response, 413, { error: "Request is too large." }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const raw=Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown>;
    try { body = raw ? JSON.parse(raw) : {}; } catch { this.reply(response, 400, { error: "Invalid request." }); return; }
    if (!body || typeof body !== "object" || Array.isArray(body)) { this.reply(response, 400, { error: "Invalid request." }); return; }
    if(request.url==="/helm-draft") {
      try { this.reply(response,200,await this.dispatch("browser.helmDraft",body)); }
      catch { this.reply(response,400,{error:"Could not save this Helm draft. Check notebook size and request identity; no coding task was started."}); }
      return;
    }
    if (request.url === "/readiness") {
      this.reply(response, 200, await this.dispatch("browser.readiness", {})); return;
    }
    if (this.pairing) { this.reply(response, 409, { error: "Agent connection is already in progress." }); return; }
    let endpoint: URL;
    try { endpoint = new URL(String(body.endpoint)); } catch { this.reply(response, 400, { error: "Invalid Browser connection." }); return; }
    if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || typeof body.token !== "string" || !/^[a-f0-9]{64}$/i.test(body.token)) {
      this.reply(response, 400, { error: "Browser connection must use a local paired endpoint." }); return;
    }
    this.pairing = true;
    try {
      if (body.profileId !== undefined && (typeof body.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.profileId))) {
        this.reply(response,400,{error:"Choose an available Agent profile."}); return;
      }
      this.reply(response, 200, await this.dispatch("browser.pair", { endpoint: endpoint.href, token: body.token, ...(body.profileId ? {profile:body.profileId} : {}) }));
    }
    finally { this.pairing = false; }
  }
}
