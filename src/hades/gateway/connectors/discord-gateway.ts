/**
 * Discord Gateway v10 WebSocket client state machine — the inbound half of
 * Discord that {@link ../connectors/discord.ts DiscordConnector} never had.
 *
 * Implements HELLO → IDENTIFY/RESUME → heartbeat/ACK → READY, plus the full
 * reconnection policy Discord's docs require of a well-behaved client:
 *
 *  - Heartbeats start at `heartbeat_interval * jitter` after HELLO, then run
 *    on a steady interval carrying the last-seen sequence number.
 *  - A server-sent Heartbeat request (opcode 1) forces an immediate,
 *    out-of-cycle heartbeat without disturbing the steady schedule.
 *  - A heartbeat sent while the previous one is still un-ACKed is a "zombie"
 *    connection: the socket is closed with a resumable code and the client
 *    reconnects with RESUME — never a fresh IDENTIFY — as long as a session
 *    is held.
 *  - RECONNECT (opcode 7) and INVALID_SESSION (opcode 9, `d: true`) drive an
 *    immediate RESUME. INVALID_SESSION with `d: false` discards the session
 *    and re-IDENTIFYs after a random 1-5s delay.
 *  - Close codes are policed: 4004/4010/4011/4012/4013/4014 are fatal (the
 *    client gives up, no reconnect); every other close — 4xxx or a bare
 *    network drop — is resumable and drives capped exponential backoff with
 *    injected jitter.
 *
 * The whole machine runs over an injectable {@link DiscordSocket} and
 * injectable timers/random, so every one of the above is deterministically
 * testable without a real network connection or real clock.
 *
 * {@link attachDiscordConnector} is the glue that makes a bot token alone
 * enough to bring Discord online: it forwards MESSAGE_CREATE dispatches into
 * an existing {@link DiscordConnector}'s `ingest()`.
 *
 * @module hades/gateway/connectors/discord-gateway
 */
import type { DiscordConnector, DiscordMessagePayload } from "./discord";

/** A minimal WebSocket-shaped duplex the gateway client speaks over. */
export interface DiscordSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(h: (data: string) => void): void;
  onClose(h: (code: number, reason: string) => void): void;
  onError(h: (err: Error) => void): void;
}

/** Opens one gateway connection. Called again on every (re)connect. */
export type DiscordSocketFactory = (url: string) => Promise<DiscordSocket>;

export type DiscordGatewayState =
  | "idle"
  | "connecting"
  | "identifying"
  | "resuming"
  | "ready"
  | "reconnect-wait"
  | "closed"
  | "failed";

/** A gateway Dispatch (opcode 0) event, as delivered to consumers. */
export interface DiscordDispatch {
  t: string;
  s: number | null;
  d: unknown;
}

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const DISCORD_DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Fatal close codes: the client must not reconnect after these. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Minimal timer surface, injectable so tests never touch a real clock. */
export interface DiscordGatewayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface DiscordGatewayOptions {
  token: string;
  socketFactory: DiscordSocketFactory;
  intents?: number;
  /** Default: wss://gateway.discord.gg/?v=10&encoding=json */
  gatewayUrl?: string;
  onDispatch: (e: DiscordDispatch) => void;
  onStateChange?: (s: DiscordGatewayState) => void;
  log?: (line: string) => void;
  timers?: DiscordGatewayTimers;
  random?: () => number;
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

function withGatewayParams(url: string): string {
  if (/[?&]v=/.test(url)) return url;
  // Discord's `resume_gateway_url` has no path component of its own
  // (e.g. "wss://gateway-us-east1-b.discord.gg"); give it one before
  // appending the query string so the result is an unambiguous URL.
  const hasPathOrQuery = /^wss?:\/\/[^/?]+[/?]/.test(url);
  const base = hasPathOrQuery ? url : `${url}/`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}v=10&encoding=json`;
}

function defaultTimers(): DiscordGatewayTimers {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

interface RawGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * A full Discord Gateway v10 client: connection lifecycle, heartbeating,
 * zombie detection, session resume, and close-code-driven backoff. See the
 * module doc for the exact behaviors implemented.
 */
export class DiscordGatewayClient {
  private readonly token: string;
  private readonly socketFactory: DiscordSocketFactory;
  private readonly intents: number;
  private readonly baseGatewayUrl: string;
  private readonly onStateChangeOpt?: (s: DiscordGatewayState) => void;
  private readonly logFn?: (line: string) => void;
  private readonly timers: DiscordGatewayTimers;
  private readonly random: () => number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxReconnectAttempts?: number;
  private readonly baseReconnectDelayMs = 1000;

  private currentState: DiscordGatewayState = "idle";
  private socket: DiscordSocket | null = null;
  private generation = 0;
  private stopped = true;

  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private lastSeq: number | null = null;

  private heartbeatIntervalMs: number | null = null;
  private awaitingAck = false;
  private reconnectAttempts = 0;

  private pendingTimers = new Set<unknown>();
  private heartbeatTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private invalidSessionTimer: unknown = null;

  private stats = { sent: 0, acked: 0, missedInARow: 0 };
  private dispatchListeners = new Set<(e: DiscordDispatch) => void>();

  constructor(opts: DiscordGatewayOptions) {
    this.token = opts.token;
    this.socketFactory = opts.socketFactory;
    this.intents = opts.intents ?? DISCORD_DEFAULT_INTENTS;
    this.baseGatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;
    this.onStateChangeOpt = opts.onStateChange;
    this.logFn = opts.log;
    this.timers = opts.timers ?? defaultTimers();
    this.random = opts.random ?? Math.random;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 60_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts;
    this.dispatchListeners.add(opts.onDispatch);
  }

  state(): DiscordGatewayState {
    return this.currentState;
  }

  sessionInfo(): { sessionId: string | null; resumeGatewayUrl: string | null; lastSeq: number | null } {
    return { sessionId: this.sessionId, resumeGatewayUrl: this.resumeGatewayUrl, lastSeq: this.lastSeq };
  }

  heartbeatStats(): { sent: number; acked: number; missedInARow: number } {
    return { ...this.stats };
  }

  /**
   * Extra subscription point (beyond the locked constructor-level
   * `onDispatch`) used internally by {@link attachDiscordConnector} so more
   * than one consumer can observe dispatches. Returns an unsubscribe fn.
   */
  onDispatchEvent(listener: (e: DiscordDispatch) => void): () => void {
    this.dispatchListeners.add(listener);
    return () => {
      this.dispatchListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.currentState !== "idle" && this.currentState !== "closed" && this.currentState !== "failed") {
      // Already running (or already mid-connect) — no-op.
      return;
    }
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.clearAllTimers();
    const sock = this.socket;
    this.socket = null;
    this.awaitingAck = false;
    if (sock) {
      try {
        sock.close(1000, "client stop");
      } catch (err) {
        this.log(`error closing socket during stop: ${this.describeError(err)}`);
      }
    }
    this.setState("closed");
  }

  // ---- connection lifecycle -------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const staleSocket = this.socket;
    const myGen = ++this.generation;
    this.socket = null;
    this.clearHeartbeatTimer();
    this.awaitingAck = false;
    if (staleSocket) {
      try {
        staleSocket.close(4000, "reconnecting");
      } catch (err) {
        this.log(`error closing previous socket: ${this.describeError(err)}`);
      }
    }
    this.setState("connecting");

    const useResumeUrl = this.sessionId !== null && this.resumeGatewayUrl !== null;
    const url = withGatewayParams(useResumeUrl ? this.resumeGatewayUrl! : this.baseGatewayUrl);

    let socket: DiscordSocket;
    try {
      socket = await this.socketFactory(url);
    } catch (err) {
      if (myGen !== this.generation || this.stopped) return;
      this.log(`failed to open gateway socket: ${this.describeError(err)}`);
      this.scheduleReconnect();
      return;
    }

    if (myGen !== this.generation || this.stopped) {
      try {
        socket.close(1000, "superseded");
      } catch {
        /* best-effort */
      }
      return;
    }

    this.socket = socket;
    this.wireSocket(socket, myGen);
  }

  private wireSocket(socket: DiscordSocket, gen: number): void {
    socket.onMessage((data) => {
      if (gen !== this.generation) return;
      this.handleMessage(data);
    });
    socket.onClose((code, reason) => {
      if (gen !== this.generation) return;
      this.handleUnexpectedClose(code, reason);
    });
    socket.onError((err) => {
      if (gen !== this.generation) return;
      this.log(`gateway socket error: ${this.describeError(err)}`);
    });
  }

  /** Bumps the generation and closes the current socket without reconnecting yet. */
  private abandonSocket(reason: string): void {
    this.clearHeartbeatTimer();
    this.generation++;
    const sock = this.socket;
    this.socket = null;
    this.awaitingAck = false;
    if (sock) {
      try {
        sock.close(4000, reason);
      } catch (err) {
        this.log(`error closing socket: ${this.describeError(err)}`);
      }
    }
  }

  private handleUnexpectedClose(code: number, reason: string): void {
    this.clearHeartbeatTimer();
    this.socket = null;
    this.awaitingAck = false;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.log(`gateway closed with fatal code ${code}${reason ? ` (${reason})` : ""}; giving up`);
      this.generation++;
      this.setState("failed");
      return;
    }
    this.log(`gateway closed with code ${code}${reason ? ` (${reason})` : ""}; scheduling reconnect`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.maxReconnectAttempts !== undefined && this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.generation++;
      this.log(`exceeded maxReconnectAttempts (${this.maxReconnectAttempts}); giving up`);
      this.setState("failed");
      return;
    }
    const attempt = this.reconnectAttempts++;
    const cappedBase = Math.min(this.baseReconnectDelayMs * 2 ** attempt, this.maxReconnectDelayMs);
    const delay = cappedBase * this.random();
    this.setState("reconnect-wait");
    const gen = this.generation;
    this.reconnectTimer = this.setTimer(() => {
      if (gen !== this.generation) return;
      void this.connect().catch((err) => this.log(`scheduled reconnect failed to start: ${this.describeError(err)}`));
    }, delay);
  }

  // ---- inbound frame handling -------------------------------------------------

  private handleMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.log("received malformed JSON payload from gateway, skipping");
      return;
    }
    if (typeof payload !== "object" || payload === null || typeof (payload as { op?: unknown }).op !== "number") {
      this.log("received gateway payload with missing/invalid opcode, skipping");
      return;
    }
    const msg = payload as RawGatewayPayload;
    switch (msg.op) {
      case OP.HELLO:
        this.handleHello(msg.d);
        break;
      case OP.DISPATCH:
        if (typeof msg.t === "string") {
          this.handleDispatch(msg.t, typeof msg.s === "number" ? msg.s : null, msg.d);
        } else {
          this.log("received DISPATCH with missing event name, skipping");
        }
        break;
      case OP.HEARTBEAT:
        this.sendHeartbeat(false);
        break;
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false;
        this.stats.acked++;
        this.stats.missedInARow = 0;
        break;
      case OP.RECONNECT:
        this.log("gateway sent RECONNECT, reconnecting with RESUME");
        void this.connect().catch((err) => this.log(`reconnect after RECONNECT failed to start: ${this.describeError(err)}`));
        break;
      case OP.INVALID_SESSION:
        this.handleInvalidSession(msg.d === true);
        break;
      default:
        this.log(`received unknown gateway opcode ${msg.op}, skipping`);
    }
  }

  private handleHello(d: unknown): void {
    const raw = (d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      this.heartbeatIntervalMs = raw;
    } else {
      this.log("received HELLO with invalid heartbeat_interval, using fallback");
      this.heartbeatIntervalMs = 41_250;
    }

    this.clearHeartbeatTimer();
    const jitterDelay = this.heartbeatIntervalMs * this.random();
    this.heartbeatTimer = this.setTimer(() => this.sendHeartbeat(true), jitterDelay);

    if (this.sessionId !== null) {
      this.setState("resuming");
      this.send({ op: OP.RESUME, d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq } });
    } else {
      this.setState("identifying");
      this.send({
        op: OP.IDENTIFY,
        d: {
          token: this.token,
          intents: this.intents,
          properties: {
            os: typeof process !== "undefined" && process.platform ? process.platform : "unknown",
            browser: "hades",
            device: "hades",
          },
        },
      });
    }
  }

  private handleDispatch(t: string, s: number | null, d: unknown): void {
    if (s !== null) {
      this.lastSeq = this.lastSeq === null ? s : Math.max(this.lastSeq, s);
    }
    if (t === "READY") {
      const rd = d as { session_id?: string; resume_gateway_url?: string } | null;
      if (rd?.session_id) this.sessionId = rd.session_id;
      if (rd?.resume_gateway_url) this.resumeGatewayUrl = rd.resume_gateway_url;
      this.reconnectAttempts = 0;
      this.setState("ready");
    } else if (t === "RESUMED") {
      this.reconnectAttempts = 0;
      this.setState("ready");
    }

    const event: DiscordDispatch = { t, s, d };
    for (const listener of this.dispatchListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(`dispatch listener threw: ${this.describeError(err)}`);
      }
    }
  }

  private handleInvalidSession(resumable: boolean): void {
    if (resumable) {
      this.log("received INVALID_SESSION (resumable), reconnecting with RESUME");
      void this.connect().catch((err) => this.log(`reconnect after INVALID_SESSION failed to start: ${this.describeError(err)}`));
      return;
    }

    this.log("received INVALID_SESSION (not resumable), discarding session and re-identifying after a delay");
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.abandonSocket("invalid session");
    this.setState("reconnect-wait");
    const delay = 1000 + this.random() * 4000;
    const gen = this.generation;
    this.invalidSessionTimer = this.setTimer(() => {
      if (gen !== this.generation) return;
      void this.connect().catch((err) => this.log(`re-identify after INVALID_SESSION failed to start: ${this.describeError(err)}`));
    }, delay);
  }

  // ---- heartbeating -------------------------------------------------

  private sendHeartbeat(scheduled: boolean): void {
    if (scheduled && this.awaitingAck) {
      this.handleZombie();
      return;
    }
    if (!this.socket) return;
    this.send({ op: OP.HEARTBEAT, d: this.lastSeq });
    this.stats.sent++;
    if (scheduled) {
      this.awaitingAck = true;
      if (this.heartbeatIntervalMs !== null) {
        this.heartbeatTimer = this.setTimer(() => this.sendHeartbeat(true), this.heartbeatIntervalMs);
      }
    }
  }

  private handleZombie(): void {
    this.stats.missedInARow++;
    this.log("zombie connection detected (no ACK since previous heartbeat); reconnecting with RESUME");
    void this.connect().catch((err) => this.log(`reconnect after zombie detection failed to start: ${this.describeError(err)}`));
  }

  // ---- send / log helpers -------------------------------------------------

  private send(payload: unknown): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(payload));
  }

  private setState(s: DiscordGatewayState): void {
    if (this.currentState === s) return;
    this.currentState = s;
    this.onStateChangeOpt?.(s);
  }

  private redact(text: string): string {
    if (!this.token) return text;
    return text.split(this.token).join("[REDACTED_TOKEN]");
  }

  private log(line: string): void {
    this.logFn?.(this.redact(line));
  }

  private describeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return this.redact(msg);
  }

  // ---- timer bookkeeping -------------------------------------------------

  private setTimer(fn: () => void, ms: number): unknown {
    let handle: unknown;
    handle = this.timers.setTimeout(() => {
      this.pendingTimers.delete(handle);
      fn();
    }, ms);
    this.pendingTimers.add(handle);
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.pendingTimers.delete(handle);
  }

  private clearHeartbeatTimer(): void {
    this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearAllTimers(): void {
    for (const h of Array.from(this.pendingTimers)) {
      this.timers.clearTimeout(h);
    }
    this.pendingTimers.clear();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.invalidSessionTimer = null;
  }
}

/**
 * Wires MESSAGE_CREATE dispatches from a {@link DiscordGatewayClient} into an
 * existing {@link DiscordConnector}'s `ingest()`. This is the piece that
 * makes a bot token alone bring Discord fully online: connect the gateway,
 * attach the connector, done. Each ingest call is isolated — a throw (sync
 * or async) is logged and does not stop later dispatches from flowing.
 * Returns a detach function that stops forwarding.
 */
export function attachDiscordConnector(
  client: DiscordGatewayClient,
  connector: DiscordConnector,
  log?: (line: string) => void,
): () => void {
  const unsubscribe = client.onDispatchEvent((e) => {
    if (e.t !== "MESSAGE_CREATE") return;
    try {
      Promise.resolve(connector.ingest(e.d as DiscordMessagePayload)).catch((err: unknown) => {
        log?.(`attachDiscordConnector: ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      log?.(`attachDiscordConnector: ingest threw synchronously: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return unsubscribe;
}
