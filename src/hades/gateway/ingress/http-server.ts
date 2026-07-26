import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** A normalized inbound request handed to a route, after raw-body capture. */
export interface IngressRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** The exact, unparsed request body bytes — signature checks run on this. */
  rawBody: Buffer;
}

/** What a route handler returns; the server writes this verbatim. */
export interface IngressResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** One method+path binding the server dispatches matching requests to. */
export interface IngressRoute {
  method: "GET" | "POST";
  path: string;
  handle(req: IngressRequest): Promise<IngressResponse>;
}

export interface WebhookIngressServerOptions {
  routes: IngressRoute[];
  /** Hard cap on request body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Diagnostic sink. Never receives secret material — callers must not log it either. */
  log?: (line: string) => void;
  /** Injected clock (ms since epoch), for deterministic tests. Default Date.now. */
  now?: () => number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

type BodyReadResult = { kind: "ok"; body: Buffer } | { kind: "too-large" } | { kind: "aborted" };

/**
 * A minimal, dependency-free inbound webhook HTTP server built directly on
 * `node:http`. It owns exactly the concerns every webhook receiver needs and
 * nothing else: raw-body capture with a hard size cap enforced mid-stream
 * (never after buffering an unbounded body), method/path routing with
 * correct 404/405 semantics, a crash-proof route dispatch boundary (a
 * throwing handler yields a generic 500, never a stack trace or a dead
 * process), and a built-in `GET /healthz`.
 *
 * Signature verification and platform-specific parsing live in
 * {@link ../ingress/signatures} and {@link ../ingress/routes} respectively —
 * this class only ever sees bytes and routes them.
 */
export class WebhookIngressServer {
  private readonly routesByPath: Map<string, Map<string, IngressRoute>>;
  private readonly maxBodyBytes: number;
  private readonly log: (line: string) => void;
  private readonly nowFn: () => number;
  private readonly startedAtMs: number;

  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private closePromise?: Promise<void>;

  constructor(opts: WebhookIngressServerOptions) {
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.log = opts.log ?? (() => {});
    this.nowFn = opts.now ?? Date.now;
    this.startedAtMs = this.nowFn();

    const healthzRoute: IngressRoute = {
      method: "GET",
      path: "/healthz",
      handle: async () => ({
        status: 200,
        body: JSON.stringify({ ok: true, uptimeMs: Math.max(0, this.nowFn() - this.startedAtMs) }),
      }),
    };

    this.routesByPath = new Map();
    this.registerRoute(healthzRoute);
    for (const route of opts.routes) this.registerRoute(route);
  }

  private registerRoute(route: IngressRoute): void {
    const path = normalizePath(route.path);
    let byMethod = this.routesByPath.get(path);
    if (!byMethod) {
      byMethod = new Map();
      this.routesByPath.set(path, byMethod);
    }
    byMethod.set(route.method, route);
  }

  /** Start listening. Resolves with the real bound port (useful for `listen(0)`). */
  async listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    if (this.server) throw new Error("WebhookIngressServer is already listening");
    this.closePromise = undefined;

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("clientError", (_err: Error, socket: Socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    server.on("error", (err: Error) => this.log(`ingress server error: ${errMessage(err)}`));

    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const addr = server.address();
    const boundPort = addr && typeof addr === "object" ? addr.port : port;
    return { port: boundPort };
  }

  /** The bound address, or null when not listening. */
  address(): { port: number } | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr !== "object") return null;
    return { port: addr.port };
  }

  /**
   * Stop listening. Idempotent — safe to call more than once or when never
   * started. Force-destroys any tracked (including idle keep-alive) sockets
   * so the underlying `server.close()` callback fires promptly instead of
   * waiting on connections the client left open.
   */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const server = this.server;
    if (!server) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
    try {
      await this.closePromise;
    } finally {
      this.server = undefined;
    }
    return this.closePromise;
  }

  // ── request handling ──────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://ingress.invalid");
    } catch {
      this.writeJson(res, 400, { error: "bad request" });
      return;
    }
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // Capture (and cap) the raw body before any routing decision so a
    // keep-alive socket is never left with an unread, unbounded tail.
    const bodyResult = await this.readRawBody(req, res);
    if (bodyResult.kind === "too-large") return; // 413 already written, socket destroyed.
    if (bodyResult.kind === "aborted") return; // client is gone; nothing to answer.

    const byMethod = this.routesByPath.get(path);
    if (!byMethod) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }
    const route = byMethod.get(method);
    if (!route) {
      const allow = [...byMethod.keys()].sort().join(", ");
      this.writeJson(res, 405, { error: "method not allowed" }, { Allow: allow });
      return;
    }

    const ingressReq: IngressRequest = {
      method,
      path,
      query: url.searchParams,
      headers: flattenHeaders(req.headers),
      rawBody: bodyResult.body,
    };

    try {
      const result = await route.handle(ingressReq);
      const headers = { "content-type": "application/json", ...(result.headers ?? {}) };
      res.writeHead(result.status, headers);
      res.end(result.body ?? "");
    } catch (err) {
      // Never leak a stack trace, error message, or any secret material to
      // the caller — log a bounded message server-side, answer generically.
      this.log(`ingress route handler threw for ${method} ${path}: ${errMessage(err)}`);
      if (!res.headersSent) {
        this.writeJson(res, 500, { error: "internal error" });
      } else {
        res.destroy();
      }
    }
  }

  /**
   * Stream the request body into memory up to `maxBodyBytes`. If the cap is
   * exceeded mid-stream, it never waits to finish buffering the (potentially
   * unbounded) body: it stops consuming immediately, writes a 413, and
   * destroys the request's socket once that response has actually been
   * flushed (so the caller still gets a real 413 rather than a truncated
   * connection reset).
   *
   * `error`/`aborted` handlers stay attached for the request's lifetime
   * (rather than being unsubscribed once we've settled) purely so a stray
   * event after destroy never becomes an unhandled 'error' that would crash
   * the process — once `settled` is true they're inert no-ops.
   */
  private readRawBody(req: IncomingMessage, res: ServerResponse): Promise<BodyReadResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const finish = (result: BodyReadResult) => {
        if (settled) return;
        settled = true;
        req.off("data", onData);
        req.off("end", onEnd);
        resolve(result);
      };

      const onData = (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          try {
            if (!res.headersSent) {
              res.writeHead(413, { "content-type": "application/json" });
              res.once("finish", () => req.destroy());
              res.once("error", () => req.destroy());
              res.end(JSON.stringify({ error: "payload too large" }));
            } else {
              req.destroy();
            }
          } catch (err) {
            this.log(`ingress: failed to write 413: ${errMessage(err)}`);
            req.destroy();
          }
          finish({ kind: "too-large" });
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => finish({ kind: "ok", body: Buffer.concat(chunks, total) });
      // Intentionally never unsubscribed — see doc comment above.
      const onError = () => finish({ kind: "aborted" });
      const onAborted = () => finish({ kind: "aborted" });

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("aborted", onAborted);
    });
  }

  private writeJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
    res.end(JSON.stringify(body));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Node's IncomingMessage.headers may repeat as arrays; flatten to strings. */
function flattenHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
