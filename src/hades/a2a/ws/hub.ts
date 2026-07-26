/**
 * The distributed A2A relay: a plain `node:http` server that upgrades every
 * connection on `path` (default `/a2a`) to a WebSocket via {@link acceptWebSocket}
 * and rebroadcasts every inbound TEXT frame to every live connection —
 * including the sender.
 *
 * Broadcasting to the sender is deliberate, not an oversight: `RemoteA2ATransport`
 * (see `../remote-transport.ts`) treats its own wire as the single source of
 * routing truth — it decodes and routes on *receipt*, not on publish — so a
 * frame a node sent must come back to it over the wire exactly like it does for
 * every other node, or that node's own locally-registered agents would never
 * receive it (see remote-transport.ts's module docs on loopback parity). The
 * hub is intentionally dumb: it has no notion of agent addresses, teams, or
 * routing — that logic lives once, in `RemoteA2ATransport`, on both ends.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { acceptWebSocket, connectWebSocket } from "./socket";
import type { WsSocket } from "./socket";
import type { Wire } from "../remote-transport";

export class A2AHubServer {
  private readonly path: string;
  private readonly log: (line: string) => void;
  private readonly connections = new Set<WsSocket>();
  private server: http.Server | null = null;

  constructor(opts: { path?: string; log?: (line: string) => void } = {}) {
    this.path = opts.path ?? "/a2a";
    this.log = opts.log ?? (() => {});
  }

  listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    if (this.server) {
      return Promise.reject(new Error("A2AHubServer.listen: already listening"));
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("A2AHubServer: not found (this endpoint only speaks WebSocket)");
      });

      server.on("upgrade", (req, socket, head) => {
        let pathname: string;
        try {
          pathname = new URL(req.url ?? "/", "http://internal").pathname;
        } catch {
          pathname = req.url ?? "/";
        }
        if (pathname !== this.path) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
        }

        // node's http typings widen the upgrade socket to stream.Duplex; at
        // runtime it is always the underlying net.Socket the connection was
        // accepted on, which is what acceptWebSocket's contract requires.
        const ws = acceptWebSocket(req, socket as import("node:net").Socket, head);
        if (!ws) {
          this.log("rejected an invalid WebSocket upgrade");
          return;
        }

        this.connections.add(ws);
        this.log(`connection opened (${this.connections.size} total)`);

        ws.onMessage((text) => this.relay(text));
        ws.onClose((info) => {
          this.connections.delete(ws);
          this.log(`connection closed code=${info.code} clean=${info.clean} (${this.connections.size} total)`);
        });
        ws.onError((e) => {
          this.log(`connection error: ${e.message}`);
        });
      });

      const onListenError = (err: Error) => reject(err);
      server.once("error", onListenError);
      server.listen(port, host, () => {
        server.removeListener("error", onListenError);
        this.server = server;
        const addr = server.address() as AddressInfo | null;
        resolve({ port: addr ? addr.port : port });
      });
    });
  }

  /** Rebroadcast one text frame to every live connection, including whichever connection sent it. Prunes anything that fails to accept the write. */
  private relay(text: string): void {
    const dead: WsSocket[] = [];
    for (const conn of this.connections) {
      if (!conn.isOpen()) {
        dead.push(conn);
        continue;
      }
      try {
        conn.sendText(text);
      } catch (e) {
        this.log(`relay failed on a connection, pruning it: ${e instanceof Error ? e.message : String(e)}`);
        dead.push(conn);
      }
    }
    for (const d of dead) this.connections.delete(d);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    const pending = [...this.connections].map((c) => c.close());
    this.connections.clear();
    await Promise.all(pending);
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}

type WireStatus = "connected" | "reconnecting" | "closed";

interface TimerLike {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
const REAL_TIMERS: TimerLike = { setTimeout, clearTimeout };

export interface WebSocketWireOpts {
  /** Reconnect (with exponential backoff) after an unexpected disconnect. Default true. */
  reconnect?: boolean;
  /** Bound on frames queued while disconnected. Overflow drops the OLDEST queued frame and increments {@link WebSocketWire.droppedFrames}. Default 1000. */
  maxQueuedFrames?: number;
  timers?: TimerLike;
  log?: (line: string) => void;
  onStatus?: (s: WireStatus) => void;
}

export interface WebSocketWire extends Wire {
  close(): Promise<void>;
  status(): WireStatus;
  /** Total frames ever dropped from the outbound queue due to `maxQueuedFrames` overflow. Monotonic, never silently reset. */
  droppedFrames(): number;
}

const DEFAULT_MAX_QUEUED_FRAMES = 1000;
const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 5_000;

/**
 * A {@link Wire} (the seam `RemoteA2ATransport` is built on) backed by a real
 * WebSocket connection to an {@link A2AHubServer}. `send` writes a TEXT frame
 * over the socket; `onFrame`'s handler fires for every TEXT frame the hub
 * relays back (including the sender's own — see this module's docs on
 * loopback parity). While disconnected, `send` queues frames (bounded by
 * `maxQueuedFrames`, dropping the oldest on overflow) and reconnects with
 * exponential backoff, flushing the queue in order once reconnected.
 *
 * The returned promise resolves only once the *initial* connection succeeds —
 * a caller that can't reach the hub at all gets a rejected promise, not a
 * silently-reconnecting wire.
 */
export async function webSocketWire(url: string, opts: WebSocketWireOpts = {}): Promise<WebSocketWire> {
  const reconnect = opts.reconnect ?? true;
  const maxQueuedFrames = opts.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  const timers = opts.timers ?? REAL_TIMERS;
  const log = opts.log ?? (() => {});

  let frameHandler: ((frame: string) => void) | undefined;
  let socket: WsSocket | null = null;
  let status: WireStatus = "closed";
  let queue: string[] = [];
  let dropped = 0;
  let closed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(s: WireStatus): void {
    if (status === s) return;
    status = s;
    opts.onStatus?.(s);
  }

  function enqueue(frame: string): void {
    queue.push(frame);
    if (queue.length > maxQueuedFrames) {
      queue.shift();
      dropped++;
      log(`webSocketWire: outbound queue overflow, dropped oldest frame (total dropped: ${dropped})`);
    }
  }

  function flushQueue(): void {
    if (!socket || !socket.isOpen()) return;
    const toSend = queue;
    queue = [];
    for (let i = 0; i < toSend.length; i++) {
      try {
        socket.sendText(toSend[i]);
      } catch (e) {
        // Socket died mid-flush: put this frame and everything after it back
        // at the front of the queue, preserving original order, and stop.
        queue = [...toSend.slice(i), ...queue];
        log(`webSocketWire: flush interrupted: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    setStatus("reconnecting");
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      connectOnce().catch((e) => {
        log(`webSocketWire: reconnect attempt failed: ${e instanceof Error ? e.message : String(e)}`);
        scheduleReconnect();
      });
    }, delay);
  }

  function wireUpSocket(s: WsSocket): void {
    s.onMessage((text) => frameHandler?.(text));
    s.onClose((info) => {
      if (socket !== s) return; // stale handler from a superseded connection
      socket = null;
      if (closed) {
        setStatus("closed");
        return;
      }
      log(`webSocketWire: connection closed code=${info.code} clean=${info.clean}`);
      if (reconnect) {
        scheduleReconnect();
      } else {
        setStatus("closed");
      }
    });
    s.onError((e) => {
      log(`webSocketWire: socket error: ${e.message}`);
    });
  }

  async function connectOnce(): Promise<void> {
    const s = await connectWebSocket(url, { timers });
    socket = s;
    backoffMs = INITIAL_BACKOFF_MS;
    wireUpSocket(s);
    setStatus("connected");
    flushQueue();
  }

  await connectOnce();

  return {
    send(frame: string): void {
      if (closed) return;
      if (socket && socket.isOpen()) {
        try {
          socket.sendText(frame);
          return;
        } catch (e) {
          log(`webSocketWire: send failed, queueing: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      enqueue(frame);
    },
    onFrame(handler: (frame: string) => void): void {
      frameHandler = handler;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (reconnectTimer) {
        timers.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const s = socket;
      socket = null;
      if (s) {
        await s.close();
      }
      setStatus("closed");
    },
    status(): WireStatus {
      return status;
    },
    droppedFrames(): number {
      return dropped;
    },
  };
}
