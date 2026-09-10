/**
 * RFC 6455 handshake + a live post-handshake WebSocket duplex, built directly
 * on `node:net` / `node:http` / `node:crypto` — no `ws` dependency.
 *
 * `computeAccept` implements the handshake's core cryptographic step (section
 * 4.2.2). `connectWebSocket` drives the client side of the handshake through a
 * real `http.request` Upgrade; `acceptWebSocket` drives the server side against
 * an `http.Server`'s `upgrade` event. Both hand off the raw socket to
 * {@link WsSocket}, which owns framing (via `frame.ts`), auto-answers pings,
 * and performs the full closing handshake.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type * as net from "node:net";
import {
  FrameParser,
  MessageAssembler,
  WS_OPCODES,
  WsProtocolError,
  encodeClose,
  encodeFrame,
  parseClose,
} from "./frame";
import type { WsFrame } from "./frame";

/** The magic GUID RFC 6455 concatenates onto the client's key before hashing (section 1.3). */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `base64(sha1(key + WS_GUID))` — the value both sides compute independently and must agree on. */
export function computeAccept(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID, "utf8").digest("base64");
}

interface TimerLike {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}
const REAL_TIMERS: TimerLike = { setTimeout, clearTimeout };

export interface WsSocketOpts {
  socket: net.Socket;
  /** true for a client socket (RFC 6455 requires the client to mask every frame it sends). */
  maskOutbound: boolean;
  /** true for a server socket (RFC 6455 requires the server to reject unmasked inbound frames). */
  requireMaskedInbound: boolean;
  timers?: TimerLike;
  closeTimeoutMs?: number;
  /** Bytes already read past the HTTP headers (e.g. `http.request`'s `upgrade` event `head`) that belong to the WS stream. */
  initialData?: Buffer;
}

export interface WsCloseInfo {
  code: number;
  reason: string;
  /** true iff the full closing handshake completed (both sides exchanged CLOSE); false on an abrupt/timeout/error close. */
  clean: boolean;
}

/**
 * A live, post-handshake WebSocket connection wrapping a `net.Socket`. Framing,
 * fragmentation reassembly, ping/pong, and the closing handshake are all
 * handled internally; consumers only ever see text messages in and text
 * messages out.
 */
export class WsSocket {
  private readonly socket: net.Socket;
  private readonly maskOutbound: boolean;
  private readonly parser: FrameParser;
  private readonly assembler: MessageAssembler;
  private readonly timers: TimerLike;
  private readonly closeTimeoutMs: number;

  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<(info: WsCloseInfo) => void> = [];
  private errorHandlers: Array<(e: Error) => void> = [];

  private open = true;
  private closeSent = false;
  private closeFinalized = false;
  private closingResolve: (() => void) | null = null;
  private closingPromise: Promise<void> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsSocketOpts) {
    this.socket = opts.socket;
    this.maskOutbound = opts.maskOutbound;
    this.timers = opts.timers ?? REAL_TIMERS;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 3000;
    this.parser = new FrameParser({ requireMasked: opts.requireMaskedInbound });
    this.assembler = new MessageAssembler();

    this.socket.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    this.socket.on("error", (e: Error) => this.handleSocketError(e));
    this.socket.on("close", () => this.handleSocketClose());
    this.socket.on("end", () => {
      // The peer sent a bare TCP FIN with no WS-level CLOSE frame (an abrupt
      // disconnect). Sockets handed off via an HTTP Upgrade are not
      // guaranteed to auto-destroy on a lone FIN the way a plain net.Socket
      // does, which would otherwise leave this connection (and anything
      // awaiting `close()`/the server's own shutdown) hanging forever. Any
      // bytes that preceded the FIN have already reached `handleChunk` (the
      // 'data' event always fires first), so tearing down here is safe;
      // `handleSocketClose` finalizes it as an unclean close.
      if (!this.socket.destroyed) this.socket.destroy();
    });

    if (opts.initialData && opts.initialData.length > 0) {
      // Feed synchronously post-construction; queueMicrotask lets the caller
      // finish wiring handlers (onMessage/onClose/etc.) before delivery fires.
      const initial = opts.initialData;
      queueMicrotask(() => {
        if (this.open) this.handleChunk(initial);
      });
    }
  }

  private nextMaskKey(): Buffer | undefined {
    return this.maskOutbound ? crypto.randomBytes(4) : undefined;
  }

  sendText(text: string): void {
    if (!this.open) throw new Error("WsSocket: cannot send, connection is not open");
    this.socket.write(encodeFrame({ opcode: WS_OPCODES.TEXT, payload: Buffer.from(text, "utf8"), maskKey: this.nextMaskKey() }));
  }

  sendPing(payload: Buffer = Buffer.alloc(0)): void {
    if (!this.open) throw new Error("WsSocket: cannot send, connection is not open");
    this.socket.write(encodeFrame({ opcode: WS_OPCODES.PING, payload, maskKey: this.nextMaskKey() }));
  }

  private sendPong(payload: Buffer): void {
    if (!this.open) return;
    this.socket.write(encodeFrame({ opcode: WS_OPCODES.PONG, payload, maskKey: this.nextMaskKey() }));
  }

  /** Full closing handshake: send CLOSE, wait for the peer's CLOSE echo, then destroy. Times out to a force-destroy so callers never hang. */
  close(code = 1000, reason = ""): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = new Promise<void>((resolve) => {
      this.closingResolve = resolve;
      if (!this.open) {
        resolve();
        return;
      }
      this.closeSent = true;
      try {
        this.socket.write(encodeFrame({ opcode: WS_OPCODES.CLOSE, payload: encodeClose(code, reason), maskKey: this.nextMaskKey() }));
      } catch {
        // Best-effort: if we can't even write the close frame, fall straight to the timeout below.
      }
      this.closeTimer = this.timers.setTimeout(() => {
        this.closeTimer = null;
        this.finalizeClose(1006, "close handshake timed out", false);
      }, this.closeTimeoutMs);
    });
    return this.closingPromise;
  }

  isOpen(): boolean {
    return this.open;
  }

  onMessage(h: (text: string) => void): void {
    this.messageHandlers.push(h);
  }
  onClose(h: (info: WsCloseInfo) => void): void {
    this.closeHandlers.push(h);
  }
  onError(h: (e: Error) => void): void {
    this.errorHandlers.push(h);
  }

  private handleChunk(chunk: Buffer): void {
    if (!this.open) return;
    let frames: WsFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (e) {
      this.failConnection(e);
      return;
    }
    for (const f of frames) {
      if (!this.open) return;
      try {
        this.handleFrame(f);
      } catch (e) {
        this.failConnection(e);
        return;
      }
    }
  }

  private handleFrame(f: WsFrame): void {
    if (f.opcode === WS_OPCODES.PING) {
      this.sendPong(f.payload);
      return;
    }
    if (f.opcode === WS_OPCODES.PONG) {
      return;
    }
    if (f.opcode === WS_OPCODES.CLOSE) {
      this.handleCloseFrame(f);
      return;
    }
    const assembled = this.assembler.pushFrame(f);
    if (assembled && assembled.opcode === WS_OPCODES.TEXT) {
      const text = assembled.payload.toString("utf8");
      for (const h of this.messageHandlers) h(text);
    }
    // BINARY messages assemble correctly but are not exposed — WsSocket's contract is text-only (A2A frames are JSON text).
  }

  private handleCloseFrame(f: WsFrame): void {
    let code = 1005;
    let reason = "";
    if (f.payload.length > 0) {
      const parsed = parseClose(f.payload); // throws WsProtocolError on malformed payload, handled by handleChunk's catch
      code = parsed.code;
      reason = parsed.reason;
    }
    if (!this.closeSent) {
      this.closeSent = true;
      try {
        this.socket.write(encodeFrame({ opcode: WS_OPCODES.CLOSE, payload: encodeClose(code === 1005 ? 1000 : code, ""), maskKey: this.nextMaskKey() }));
      } catch {
        // Ignore — we're closing regardless.
      }
    }
    this.finalizeClose(code, reason, true);
  }

  private failConnection(err: unknown): void {
    const protocolError = err instanceof WsProtocolError;
    const code = protocolError ? err.code : 1002;
    const message = err instanceof Error ? err.message : String(err);
    if (this.open) {
      try {
        this.socket.write(encodeFrame({ opcode: WS_OPCODES.CLOSE, payload: encodeClose(code, message.slice(0, 100)), maskKey: this.nextMaskKey() }));
      } catch {
        // Ignore — destroying immediately below regardless.
      }
    }
    for (const h of this.errorHandlers) h(err instanceof Error ? err : new Error(message));
    this.finalizeClose(code, message, false);
    this.socket.destroy();
  }

  private handleSocketError(e: Error): void {
    for (const h of this.errorHandlers) h(e);
    // 'close' always follows 'error' on a net.Socket; final cleanup happens there.
  }

  private handleSocketClose(): void {
    // Covers the TCP-level close: either the natural conclusion of a clean
    // handshake (finalizeClose already ran and this is a no-op) or an abrupt
    // peer disconnect (finalizeClose has not run yet — report it unclean).
    this.finalizeClose(1006, "", false);
  }

  private finalizeClose(code: number, reason: string, clean: boolean): void {
    if (this.closeFinalized) return;
    this.closeFinalized = true;
    this.open = false;
    if (this.closeTimer) {
      this.timers.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
    for (const h of this.closeHandlers) h({ code, reason, clean });
    if (this.closingResolve) {
      this.closingResolve();
      this.closingResolve = null;
    }
  }
}

/**
 * Drive the client side of the RFC 6455 handshake over a real `http.request`
 * Upgrade, then hand the raw socket to {@link WsSocket}. Rejects if the server
 * never upgrades, or if its `Sec-WebSocket-Accept` doesn't match what
 * {@link computeAccept} derives from the key we sent (a forged/broken server).
 */
export function connectWebSocket(
  url: string,
  opts: { timeoutMs?: number; timers?: TimerLike } = {}
): Promise<WsSocket> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      reject(new Error(`connectWebSocket: unsupported protocol '${parsed.protocol}' (expected ws: or wss:)`));
      return;
    }

    const key = crypto.randomBytes(16).toString("base64");
    const timers = opts.timers ?? REAL_TIMERS;
    const timeoutMs = opts.timeoutMs ?? 10_000;

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80,
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });

    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`connectWebSocket: handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on("upgrade", (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      timers.clearTimeout(timer);

      const acceptHeader = res.headers["sec-websocket-accept"];
      const expected = computeAccept(key);
      if (typeof acceptHeader !== "string" || acceptHeader !== expected) {
        socket.destroy();
        reject(new Error("connectWebSocket: server returned an invalid Sec-WebSocket-Accept header"));
        return;
      }

      resolve(
        new WsSocket({
          socket,
          maskOutbound: true,
          requireMaskedInbound: false,
          timers,
          initialData: head && head.length > 0 ? head : undefined,
        })
      );
    });

    req.on("response", (res) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      res.resume();
      reject(new Error(`connectWebSocket: server responded with HTTP ${res.statusCode} instead of upgrading`));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

/**
 * Drive the server side of the RFC 6455 handshake from an `http.Server`'s
 * `upgrade` event. Validates `Upgrade: websocket`, `Connection: Upgrade`
 * (case-insensitively, tolerant of a multi-token Connection header),
 * `Sec-WebSocket-Version: 13`, and a present `Sec-WebSocket-Key`; on failure
 * writes `400 Bad Request`, destroys the socket, and returns `null`. On
 * success writes the `101 Switching Protocols` response and returns a live
 * {@link WsSocket}.
 */
export function acceptWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer
): WsSocket | null {
  const upgradeHeader = String(req.headers["upgrade"] ?? "").toLowerCase();
  const connectionHeader = String(req.headers["connection"] ?? "").toLowerCase();
  const version = req.headers["sec-websocket-version"];
  const key = req.headers["sec-websocket-key"];

  const connectionHasUpgrade = connectionHeader
    .split(",")
    .map((t) => t.trim())
    .includes("upgrade");

  const valid =
    upgradeHeader === "websocket" &&
    connectionHasUpgrade &&
    version === "13" &&
    typeof key === "string" &&
    key.length > 0;

  if (!valid) {
    if (socket.writable) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    socket.destroy();
    return null;
  }

  const accept = computeAccept(key);
  const responseHead =
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n";
  socket.write(responseHead);

  return new WsSocket({
    socket,
    maskOutbound: false,
    requireMaskedInbound: true,
    initialData: head && head.length > 0 ? head : undefined,
  });
}
