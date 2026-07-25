/**
 * Federated Node Link — the authenticated, replay-proof, reconnecting channel
 * that carries A2A federation *between machines*.
 *
 * This is the security boundary of the cluster: every envelope that crosses a
 * {@link FederationLink} is ed25519-signed by its sender, verified against a
 * pinned public key (never trust-on-first-use), checked against a per-peer
 * monotonic sequence counter and a time-windowed nonce cache, and delivered at
 * most once even across a network partition and reconnect.
 *
 * Framing is length-prefixed (see {@link socketWire}) so a single logical
 * frame survives arbitrary TCP chunk boundaries. Reliability is layered on
 * top of the wire with a small application-level ack: every "reliable" kind
 * (`hello`, `welcome`, `gossip`, `offer`, `accept`, `result`, `bye`) is kept in
 * a bounded, drop-oldest queue until the peer acks it; on reconnect the queue
 * is re-flushed in seq order, and the receiver's strict per-peer seq check
 * silently (but countably) discards anything it already saw — so a mid-stream
 * disconnect resumes with no duplicates and no gaps.
 */
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import * as ed from "@noble/ed25519";
import { jsonCodec, type Wire, type Codec } from "../../hades/a2a/remote-transport";
import { sign, verify, canonicalize, toHex, fromHex } from "../../agents/federation/crypto";

// @noble/ed25519's *synchronous* entry points (used below only to derive a
// public key from a private key without an await) delegate to a pluggable
// `hashes.sha512`. The async entry points (used by ../../agents/federation/crypto
// for actual signing/verification) don't need this — but the sync ones throw
// ("hashes.sha512 not set") until it's wired up. Node's own `crypto` module
// provides a real, standard SHA-512, so this is real hashing, not a stub.
type Sha512Fn = NonNullable<typeof ed.hashes.sha512>;
if (ed.hashes.sha512 === undefined) {
  // @noble's .d.ts brands this return type for its own TS-version compatibility
  // shims (see TRet<Bytes> above); the cast below changes no runtime behavior —
  // the digest itself is real Node crypto SHA-512.
  ed.hashes.sha512 = ((msg: Uint8Array): Uint8Array => {
    const digest = createHash("sha512").update(msg).digest();
    const out = new Uint8Array(digest.length);
    out.set(digest);
    return out;
  }) as Sha512Fn;
}

// ---------------------------------------------------------------------------
// Envelope model
// ---------------------------------------------------------------------------

export type FederatedKind =
  | "hello"
  | "welcome"
  | "gossip"
  | "offer"
  | "accept"
  | "result"
  | "ack"
  | "ping"
  | "pong"
  | "bye";

const FEDERATED_KINDS: ReadonlySet<string> = new Set<FederatedKind>([
  "hello",
  "welcome",
  "gossip",
  "offer",
  "accept",
  "result",
  "ack",
  "ping",
  "pong",
  "bye",
]);

/**
 * Kinds that participate in the reliable, ack-tracked, reconnect-resumed
 * queue — the application data plane. `hello`/`welcome`/`ack`/`ping`/`pong`/`bye`
 * are deliberately *not* reliable: they are transport/handshake plumbing that
 * is always re-sent fresh on every connection attempt (see `resumeHandshake`),
 * never needs cross-reconnect resend of its own, and — critically — must not
 * share a sequence counter with the data plane. If it did, a hello/ack/ping
 * sent *during* a reconnect would consume a higher sequence number than a
 * still-unacked, pre-disconnect data message; when that stale (lower-numbered)
 * message is then resent, the peer would wrongly reject it as a replay of
 * something already superseded. Keeping control traffic on its own sequence
 * stream (see `nextControlSeq` / `lastControlSeqSeen`) makes the data plane's
 * resume-without-duplication guarantee immune to control-plane churn.
 */
const RELIABLE_KINDS: ReadonlySet<FederatedKind> = new Set<FederatedKind>(["gossip", "offer", "accept", "result"]);

export interface FederatedEnvelope<T = unknown> {
  v: 1;
  id: string;
  kind: FederatedKind;
  fromNodeId: string;
  toNodeId: string | "*";
  seq: number;
  ts: number;
  nonce: string;
  payload: T;
  sig: string;
  publicKeyHex: string;
}

function isEnvelopeShape(v: unknown): v is FederatedEnvelope {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.v === "number" &&
    typeof r.id === "string" &&
    typeof r.kind === "string" &&
    FEDERATED_KINDS.has(r.kind) &&
    typeof r.fromNodeId === "string" &&
    r.fromNodeId.length > 0 &&
    typeof r.toNodeId === "string" &&
    r.toNodeId.length > 0 &&
    typeof r.seq === "number" &&
    Number.isFinite(r.seq) &&
    typeof r.ts === "number" &&
    Number.isFinite(r.ts) &&
    typeof r.nonce === "string" &&
    r.nonce.length > 0 &&
    "payload" in r &&
    typeof r.sig === "string" &&
    r.sig.length > 0 &&
    typeof r.publicKeyHex === "string" &&
    r.publicKeyHex.length > 0
  );
}

// ---------------------------------------------------------------------------
// Identity + signing
// ---------------------------------------------------------------------------

export interface NodeIdentity {
  nodeId: string;
  publicKeyHex: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Builds a {@link NodeIdentity} from a raw ed25519 seed (hex-encoded, 32 bytes). */
export function localIdentity(nodeId: string, privateKeyHex: string): NodeIdentity {
  if (!nodeId) throw new Error("localIdentity: nodeId must be non-empty");
  const privateKey = fromHex(privateKeyHex);
  if (privateKey.length !== 32) {
    throw new Error(`localIdentity: private key must be 32 bytes, got ${privateKey.length}`);
  }
  // getPublicKey is synchronous in @noble/ed25519 — needed because NodeIdentity
  // exposes publicKeyHex as a plain (non-async) property.
  const publicKeyHex = toHex(ed.getPublicKey(privateKey));
  return {
    nodeId,
    publicKeyHex,
    sign(bytes: Uint8Array): Promise<Uint8Array> {
      return sign(bytes, privateKey);
    },
  };
}

/** Signs an envelope body with a {@link NodeIdentity}, producing the final wire envelope. */
export async function signEnvelope(
  id: NodeIdentity,
  e: Omit<FederatedEnvelope, "sig" | "publicKeyHex">
): Promise<FederatedEnvelope> {
  const bytes = canonicalize(e);
  const sigBytes = await id.sign(bytes);
  return { ...e, sig: toHex(sigBytes), publicKeyHex: id.publicKeyHex };
}

/**
 * Verifies an envelope's signature and structure. `expectedPublicKeyHex` is
 * the key the caller *already trusts* for `e.fromNodeId` (from a pin, or the
 * envelope's own self-asserted key on first contact) — if `e.publicKeyHex`
 * doesn't match it, that is a key-substitution attempt and is rejected as
 * `"key-mismatch"` *before* any signature math runs.
 */
export async function verifyEnvelope(
  e: FederatedEnvelope,
  expectedPublicKeyHex: string
): Promise<{ ok: boolean; reason?: "bad-signature" | "key-mismatch" | "malformed" | "version" }> {
  if (!isEnvelopeShape(e)) return { ok: false, reason: "malformed" };
  if (e.v !== 1) return { ok: false, reason: "version" };
  if (e.publicKeyHex !== expectedPublicKeyHex) return { ok: false, reason: "key-mismatch" };

  const { sig, publicKeyHex, ...rest } = e;
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  let msgBytes: Uint8Array;
  try {
    sigBytes = fromHex(sig);
    pubBytes = fromHex(publicKeyHex);
    msgBytes = canonicalize(rest);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) return { ok: false, reason: "malformed" };

  try {
    const valid = await verify(sigBytes, msgBytes, pubBytes);
    return valid ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

export interface PeerTrustPolicy {
  isTrusted(nodeId: string, publicKeyHex: string): boolean;
  pin(nodeId: string, publicKeyHex: string): void;
  revoke(nodeId: string): void;
  pinned(): Array<{ nodeId: string; publicKeyHex: string }>;
}

/**
 * A known-hosts-style trust policy: a node is trusted only if its id is
 * pinned to *exactly* the public key presented. There is no trust-on-first-use
 * — an unpinned node is always untrusted, which is what makes key-substitution
 * attacks (a valid signature from the wrong key) detectable rather than
 * silently accepted.
 */
export function pinnedTrust(seed: Array<{ nodeId: string; publicKeyHex: string }> = []): PeerTrustPolicy {
  const pins = new Map<string, string>();
  for (const s of seed) pins.set(s.nodeId, s.publicKeyHex);
  return {
    isTrusted(nodeId: string, publicKeyHex: string): boolean {
      const pinned = pins.get(nodeId);
      return pinned !== undefined && pinned === publicKeyHex;
    },
    pin(nodeId: string, publicKeyHex: string): void {
      pins.set(nodeId, publicKeyHex);
    },
    revoke(nodeId: string): void {
      pins.delete(nodeId);
    },
    pinned(): Array<{ nodeId: string; publicKeyHex: string }> {
      return [...pins.entries()].map(([nodeId, publicKeyHex]) => ({ nodeId, publicKeyHex }));
    },
  };
}

// ---------------------------------------------------------------------------
// Wire: length-prefixed framing over node:net
// ---------------------------------------------------------------------------

const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB

/** Extra, optional lifecycle hooks a {@link Wire} produced by {@link socketWire} exposes. */
interface SocketWireExtras {
  /** Fires once, when the underlying socket closes (cleanly or on error). */
  onClose(handler: (err?: Error) => void): void;
  /** Idempotent: tears down the underlying socket. */
  close(): void;
}

/**
 * Wraps a real `node:net.Socket` in the {@link Wire} interface using
 * length-prefixed framing: each frame is a 4-byte big-endian length prefix
 * followed by that many bytes of UTF-8 payload. Frames reassemble correctly
 * across arbitrary TCP chunk boundaries (including a chunk split mid-header
 * or mid-payload), and a frame whose declared length exceeds `maxFrameBytes`
 * is rejected — the socket is torn down — *before* any buffer sized to that
 * length is ever allocated.
 */
export function socketWire(socket: Socket, opts?: { maxFrameBytes?: number }): Wire {
  const maxFrameBytes = opts?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  let frameHandler: ((frame: string) => void) | undefined;
  let closeHandler: ((err?: Error) => void) | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let expectedLength = -1;
  let destroyed = false;

  function fail(err: Error): void {
    if (destroyed) return;
    destroyed = true;
    buffer = Buffer.alloc(0);
    socket.destroy(err);
  }

  function onData(chunk: Buffer): void {
    if (destroyed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (expectedLength === -1) {
        if (buffer.length < LENGTH_PREFIX_BYTES) return;
        const len = buffer.readUInt32BE(0);
        buffer = buffer.subarray(LENGTH_PREFIX_BYTES);
        if (len > maxFrameBytes) {
          fail(new Error(`socketWire: frame length ${len} exceeds maxFrameBytes ${maxFrameBytes}`));
          return;
        }
        expectedLength = len;
      }
      if (buffer.length < expectedLength) return;
      const body = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);
      expectedLength = -1;
      try {
        frameHandler?.(body.toString("utf8"));
      } catch {
        // A throwing handler must never take down the socket's read loop.
      }
    }
  }

  socket.on("data", onData);
  // Without a listener, an 'error' event on a Socket throws — swallow it here;
  // 'close' (always emitted after 'error') is what drives closeHandler.
  socket.on("error", () => undefined);
  socket.on("close", () => {
    destroyed = true;
    closeHandler?.();
  });

  const wire: Wire & SocketWireExtras = {
    send(frame: string): void {
      if (destroyed || socket.destroyed) return;
      const payload = Buffer.from(frame, "utf8");
      const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
      header.writeUInt32BE(payload.length, 0);
      try {
        socket.write(Buffer.concat([header, payload]));
      } catch {
        // Writing to a half-closed socket must not throw out of the caller.
      }
    },
    onFrame(handler: (frame: string) => void): void {
      frameHandler = handler;
    },
    onClose(handler: (err?: Error) => void): void {
      closeHandler = handler;
    },
    close(): void {
      if (destroyed) return;
      destroyed = true;
      socket.destroy();
    },
  };
  return wire;
}

// ---------------------------------------------------------------------------
// FederationLink
// ---------------------------------------------------------------------------

export interface LinkStats {
  sent: number;
  received: number;
  rejected: Record<string, number>;
  queued: number;
  dropped: number;
  reconnects: number;
  lastRttMs?: number;
}

export interface FederationLinkOptions {
  identity: NodeIdentity;
  wire: Wire;
  codec?: Codec;
  trust: PeerTrustPolicy;
  now?: () => number;
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
  maxFrameBytes?: number;
  sendQueueLimit?: number;
  replayWindowMs?: number;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  reconnect?: {
    attempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    reconnectWire?: () => Promise<Wire>;
  };
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HandshakeResult {
  ok: boolean;
  peerNodeId?: string;
  reason?: string;
}

interface HandshakeWaiter {
  resolve: (r: HandshakeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One authenticated, replay-proof, reconnecting link to exactly one federated
 * peer. Construct with an already-connected {@link Wire}; call
 * {@link FederationLink.handshake} to authenticate the peer; {@link FederationLink.send}
 * / {@link FederationLink.request} to talk to it; {@link FederationLink.serve} to
 * handle its messages; {@link FederationLink.close} to tear down cleanly.
 *
 * **Bounded queue / drop policy**: outbound "reliable" envelopes (every kind
 * except `ack`/`ping`/`pong`) sit in an unacked queue, bounded to
 * `sendQueueLimit` entries, until the peer acks them or they are resent after
 * a reconnect. When the queue is full, the *oldest* entry is evicted to make
 * room for the newest — `stats().dropped` counts every eviction and a
 * `"drop"` event carries the discarded envelope. This bounds memory under a
 * peer that stops acking; it does not affect the reconnect no-duplicate /
 * no-skip guarantee, which only concerns envelopes that were still queued
 * (i.e. not evicted) at the moment of disconnect.
 */
export class FederationLink extends EventEmitter {
  private readonly identity: NodeIdentity;
  private readonly codec: Codec;
  private readonly trust: PeerTrustPolicy;
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
  private readonly sendQueueLimit: number;
  private readonly replayWindowMs: number;
  private readonly heartbeatMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectOpts?: FederationLinkOptions["reconnect"];

  private wire: Wire;
  private appHandler?: (e: FederatedEnvelope) => unknown | Promise<unknown>;

  private peerNodeId: string | undefined;
  private peerPublicKeyHex: string | undefined;

  // Two independent, strictly-monotonic sequence streams per peer — see the
  // RELIABLE_KINDS doc comment above for why control traffic must not share
  // the data plane's counter.
  private nextReliableSeq = 1;
  private nextControlSeq = 1;
  private lastReliableSeqSeen = 0;
  private lastControlSeqSeen = 0;
  private readonly seenNonces = new Map<string, number>();
  private readonly unacked = new Map<number, FederatedEnvelope>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private handshakeWaiters: HandshakeWaiter[] = [];
  private readonly pendingSleepResolvers = new Set<() => void>();

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  private degraded = false;
  private reconnecting = false;
  private closed = false;

  private readonly statCounts: { sent: number; received: number; rejected: Record<string, number>; dropped: number; reconnects: number; lastRttMs?: number } = {
    sent: 0,
    received: 0,
    rejected: {},
    dropped: 0,
    reconnects: 0,
    lastRttMs: undefined,
  };

  constructor(opts: FederationLinkOptions) {
    super();
    this.identity = opts.identity;
    this.codec = opts.codec ?? jsonCodec;
    this.trust = opts.trust;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.sendQueueLimit = opts.sendQueueLimit ?? 1000;
    this.replayWindowMs = opts.replayWindowMs ?? 5 * 60_000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.reconnectOpts = opts.reconnect;
    this.wire = opts.wire;
    this.attachWire(this.wire);
  }

  // -- public API -----------------------------------------------------------

  async handshake(): Promise<HandshakeResult> {
    if (this.closed) return { ok: false, reason: "closed" };
    if (this.peerNodeId !== undefined) return { ok: true, peerNodeId: this.peerNodeId };
    return new Promise<HandshakeResult>((resolve) => {
      const timer = this.schedule(() => {
        this.handshakeWaiters = this.handshakeWaiters.filter((w) => w.timer !== timer);
        resolve({ ok: false, reason: "handshake-timeout" });
      }, this.requestTimeoutMs);
      this.handshakeWaiters.push({ resolve, timer });
      void this.sendControl("hello", "*", { nodeId: this.identity.nodeId });
    });
  }

  async send<T>(kind: FederatedKind, to: string | "*", payload: T): Promise<void> {
    if (this.closed) throw new Error("FederationLink: link is closed");
    if (RELIABLE_KINDS.has(kind)) {
      await this.sendReliable(kind, to, payload);
    } else {
      await this.sendControl(kind, to, payload);
    }
  }

  async request<TReq, TRes>(kind: FederatedKind, to: string, payload: TReq): Promise<TRes> {
    if (this.closed) throw new Error("FederationLink: link is closed");
    const envelope = await this.sendReliable(kind, to, payload);
    return new Promise<TRes>((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pendingRequests.delete(envelope.id);
        reject(new Error(`FederationLink: request "${kind}" to "${to}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(envelope.id, {
        resolve: (v) => resolve(v as TRes),
        reject,
        timer,
      });
    });
  }

  serve(handler: (e: FederatedEnvelope) => unknown | Promise<unknown>): void {
    this.appHandler = handler;
  }

  stats(): LinkStats {
    return {
      sent: this.statCounts.sent,
      received: this.statCounts.received,
      rejected: { ...this.statCounts.rejected },
      queued: this.unacked.size,
      dropped: this.statCounts.dropped,
      reconnects: this.statCounts.reconnects,
      lastRttMs: this.statCounts.lastRttMs,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;

    const peer = this.peerNodeId;
    if (peer !== undefined) {
      try {
        const bye = await this.buildEnvelope("bye", peer, {});
        this.wire.send(this.encodeEnvelope(bye));
        this.statCounts.sent++;
      } catch {
        // best-effort — the peer may already be unreachable
      }
    }

    this.closed = true;
    this.reconnecting = false;

    for (const resolve of [...this.pendingSleepResolvers]) resolve();
    this.pendingSleepResolvers.clear();

    for (const t of [...this.timers]) this.clearTimeoutFn(t);
    this.timers.clear();
    this.heartbeatTimer = undefined;
    this.heartbeatTimeoutTimer = undefined;

    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("FederationLink: closed"));
    }
    this.pendingRequests.clear();

    this.resolveHandshake({ ok: false, reason: "closed" });

    const hooked = this.wire as Partial<SocketWireExtras>;
    if (typeof hooked.close === "function") {
      try {
        hooked.close();
      } catch {
        // best-effort
      }
    }

    this.emit("peer:down", { peerNodeId: peer, reason: "closed" });
  }

  // -- wire plumbing ----------------------------------------------------------

  private attachWire(wire: Wire): void {
    wire.onFrame((frame) => {
      void this.onFrame(frame);
    });
    const hooked = wire as Partial<SocketWireExtras>;
    if (typeof hooked.onClose === "function") {
      hooked.onClose(() => {
        if (this.closed) return;
        this.handleLinkDown();
      });
    }
  }

  private encodeEnvelope(e: FederatedEnvelope): string {
    return this.codec.encode(e as unknown as Parameters<Codec["encode"]>[0]);
  }

  private decodeEnvelope(frame: string): unknown {
    return this.codec.decode(frame) as unknown;
  }

  // -- outbound ---------------------------------------------------------------

  private async buildEnvelope<T>(kind: FederatedKind, to: string | "*", payload: T): Promise<FederatedEnvelope> {
    const seq = RELIABLE_KINDS.has(kind) ? this.nextReliableSeq++ : this.nextControlSeq++;
    const base: Omit<FederatedEnvelope, "sig" | "publicKeyHex"> = {
      v: 1,
      id: randomUUID(),
      kind,
      fromNodeId: this.identity.nodeId,
      toNodeId: to,
      seq,
      ts: this.now(),
      nonce: randomBytes(12).toString("hex"),
      payload,
    };
    return signEnvelope(this.identity, base);
  }

  private async sendReliable<T>(kind: FederatedKind, to: string | "*", payload: T): Promise<FederatedEnvelope> {
    const e = await this.buildEnvelope(kind, to, payload);
    this.enqueueUnacked(e);
    this.transmit(e);
    return e;
  }

  private async sendControl<T>(kind: FederatedKind, to: string | "*", payload: T): Promise<void> {
    const e = await this.buildEnvelope(kind, to, payload);
    this.transmit(e);
  }

  private enqueueUnacked(e: FederatedEnvelope): void {
    if (this.unacked.size >= this.sendQueueLimit) {
      const oldestKey = this.unacked.keys().next().value as number | undefined;
      if (oldestKey !== undefined) {
        const dropped = this.unacked.get(oldestKey);
        this.unacked.delete(oldestKey);
        this.statCounts.dropped++;
        if (dropped) this.emit("drop", dropped);
      }
    }
    this.unacked.set(e.seq, e);
  }

  private transmit(e: FederatedEnvelope): void {
    if (this.closed) return;
    try {
      this.wire.send(this.encodeEnvelope(e));
      this.statCounts.sent++;
    } catch {
      this.handleLinkDown();
    }
  }

  private flushUnacked(): void {
    const inOrder = [...this.unacked.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, e] of inOrder) this.transmit(e);
  }

  // -- inbound ------------------------------------------------------------

  private recordRejected(reason: string): void {
    this.statCounts.rejected[reason] = (this.statCounts.rejected[reason] ?? 0) + 1;
  }

  private evictExpiredNonces(): void {
    const cutoff = this.now() - this.replayWindowMs;
    for (const [nonce, ts] of this.seenNonces) {
      if (ts < cutoff) this.seenNonces.delete(nonce);
    }
  }

  private reject(e: FederatedEnvelope, reason: string): void {
    this.recordRejected(reason);
    this.emit("rejected", { envelope: e, reason });
  }

  private async onFrame(frame: string): Promise<void> {
    if (this.closed) return;

    let decoded: unknown;
    try {
      decoded = this.decodeEnvelope(frame);
    } catch {
      this.recordRejected("malformed");
      return;
    }
    if (!isEnvelopeShape(decoded)) {
      this.recordRejected("malformed");
      return;
    }
    const e = decoded;

    if (e.v !== 1) {
      this.reject(e, "version");
      return;
    }
    if (e.toNodeId !== "*" && e.toNodeId !== this.identity.nodeId) {
      this.reject(e, "misdirected");
      return;
    }

    let expectedKey: string;
    if (this.peerNodeId !== undefined) {
      if (e.fromNodeId !== this.peerNodeId) {
        this.reject(e, "wrong-peer");
        return;
      }
      expectedKey = this.peerPublicKeyHex as string;
    } else if (e.kind === "hello" || e.kind === "welcome") {
      // First contact: the envelope's own asserted key is what we check the
      // signature against; whether that key is actually *trusted* for this
      // nodeId is decided below by the pinned trust policy, not here.
      expectedKey = e.publicKeyHex;
    } else {
      this.reject(e, "not-handshaken");
      return;
    }

    const verdict = await verifyEnvelope(e, expectedKey);
    if (!verdict.ok) {
      this.reject(e, verdict.reason ?? "malformed");
      return;
    }

    if (!this.trust.isTrusted(e.fromNodeId, e.publicKeyHex)) {
      this.reject(e, "untrusted");
      return;
    }

    const reliable = RELIABLE_KINDS.has(e.kind);
    const lastSeqSeen = reliable ? this.lastReliableSeqSeen : this.lastControlSeqSeen;

    this.evictExpiredNonces();
    if (this.seenNonces.has(e.nonce)) {
      this.reject(e, "replay-nonce");
      this.reAckIfKnownRetransmit(e);
      return;
    }
    if (this.peerNodeId !== undefined && e.seq <= lastSeqSeen) {
      this.reject(e, "replay-seq");
      this.reAckIfKnownRetransmit(e);
      return;
    }

    this.seenNonces.set(e.nonce, this.now());
    if (this.peerNodeId !== undefined) {
      if (reliable) this.lastReliableSeqSeen = Math.max(this.lastReliableSeqSeen, e.seq);
      else this.lastControlSeqSeen = Math.max(this.lastControlSeqSeen, e.seq);
    }
    this.statCounts.received++;

    if (this.closed) return;
    await this.dispatch(e);
  }

  /**
   * A rejected replay from our *bound* peer is, by definition, something we
   * already accepted once — so its seq is <= the relevant lastSeqSeen. Re-ack
   * it (without re-delivering) so the sender's unacked queue converges
   * instead of resending the same already-delivered envelope on every future
   * reconnect. Only reliable kinds are ack-tracked in the first place.
   */
  private reAckIfKnownRetransmit(e: FederatedEnvelope): void {
    if (this.peerNodeId === undefined || e.fromNodeId !== this.peerNodeId) return;
    if (!RELIABLE_KINDS.has(e.kind)) return;
    void this.sendControl("ack", e.fromNodeId, { ackSeq: e.seq });
  }

  private async dispatch(e: FederatedEnvelope): Promise<void> {
    switch (e.kind) {
      case "hello":
        await this.handleHello(e);
        break;
      case "welcome":
        await this.handleWelcome(e);
        break;
      case "ack":
        this.handleAck(e);
        break;
      case "ping":
        void this.sendControl("pong", e.fromNodeId, e.payload);
        break;
      case "pong":
        this.handlePong(e);
        break;
      case "bye":
        this.handleBye(e);
        break;
      case "result":
        this.handleResult(e);
        break;
      default: {
        // gossip / offer / accept, or any future app-level kind
        this.emit("message", e);
        if (this.appHandler) {
          try {
            const value = await this.appHandler(e);
            if (!this.closed) void this.sendReliable("result", e.fromNodeId, { requestId: e.id, ok: true, value });
          } catch (err) {
            if (!this.closed) {
              void this.sendReliable("result", e.fromNodeId, {
                requestId: e.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        break;
      }
    }
    if (!this.closed && RELIABLE_KINDS.has(e.kind)) {
      void this.sendControl("ack", e.fromNodeId, { ackSeq: e.seq });
    }
  }

  private async handleHello(e: FederatedEnvelope): Promise<void> {
    if (this.peerNodeId === undefined) this.bindPeer(e.fromNodeId, e.publicKeyHex);
    await this.sendControl("welcome", e.fromNodeId, { nodeId: this.identity.nodeId });
    this.resolveHandshake({ ok: true, peerNodeId: this.peerNodeId });
    this.onPeerUp();
  }

  private async handleWelcome(e: FederatedEnvelope): Promise<void> {
    if (this.peerNodeId === undefined) this.bindPeer(e.fromNodeId, e.publicKeyHex);
    this.resolveHandshake({ ok: true, peerNodeId: this.peerNodeId });
    this.onPeerUp();
  }

  private bindPeer(nodeId: string, publicKeyHex: string): void {
    this.peerNodeId = nodeId;
    this.peerPublicKeyHex = publicKeyHex;
  }

  private handleAck(e: FederatedEnvelope): void {
    const payload = e.payload as { ackSeq?: unknown } | undefined;
    const ackSeq = payload && typeof payload.ackSeq === "number" ? payload.ackSeq : undefined;
    if (ackSeq !== undefined) this.unacked.delete(ackSeq);
  }

  private handlePong(e: FederatedEnvelope): void {
    const payload = e.payload as { sentAt?: unknown } | undefined;
    const sentAt = payload && typeof payload.sentAt === "number" ? payload.sentAt : undefined;
    if (sentAt !== undefined) this.statCounts.lastRttMs = Math.max(0, this.now() - sentAt);
    this.cancelTimer(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = undefined;
    if (this.degraded) {
      this.degraded = false;
      this.emit("peer:up", { peerNodeId: this.peerNodeId });
    }
    this.scheduleNextHeartbeat();
  }

  private handleBye(e: FederatedEnvelope): void {
    this.emit("peer:down", { peerNodeId: this.peerNodeId ?? e.fromNodeId, reason: "bye" });
  }

  private handleResult(e: FederatedEnvelope): void {
    const payload = e.payload as { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown } | undefined;
    const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : undefined;
    if (requestId === undefined) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return; // reply to a plain send(), or a request we already gave up on
    this.pendingRequests.delete(requestId);
    this.cancelTimer(pending.timer);
    if (payload && payload.ok === false) {
      pending.reject(new Error(typeof payload.error === "string" ? payload.error : "remote error"));
    } else {
      pending.resolve(payload ? payload.value : undefined);
    }
  }

  // -- liveness: heartbeat, degrade, reconnect -----------------------------

  private onPeerUp(): void {
    this.degraded = false;
    this.startHeartbeat();
    this.flushUnacked();
    this.emit("peer:up", { peerNodeId: this.peerNodeId });
  }

  private startHeartbeat(): void {
    this.cancelTimer(this.heartbeatTimer);
    this.scheduleNextHeartbeat();
  }

  private scheduleNextHeartbeat(): void {
    if (this.closed) return;
    this.cancelTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.schedule(() => this.sendHeartbeatPing(), this.heartbeatMs);
  }

  private sendHeartbeatPing(): void {
    if (this.closed || this.peerNodeId === undefined) return;
    const sentAt = this.now();
    void this.sendControl("ping", this.peerNodeId, { sentAt });
    this.cancelTimer(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = this.schedule(() => this.onHeartbeatTimeout(), this.heartbeatMs);
  }

  private onHeartbeatTimeout(): void {
    if (this.closed) return;
    if (!this.degraded) {
      this.degraded = true;
      this.emit("peer:degraded", { peerNodeId: this.peerNodeId });
    }
    this.beginReconnect();
  }

  private handleLinkDown(): void {
    if (this.closed) return;
    if (!this.degraded) {
      this.degraded = true;
      this.emit("peer:degraded", { peerNodeId: this.peerNodeId });
    }
    this.beginReconnect();
  }

  private beginReconnect(): void {
    if (this.closed || this.reconnecting) return;
    const opts = this.reconnectOpts;
    if (!opts || !opts.reconnectWire) {
      this.emit("peer:down", { peerNodeId: this.peerNodeId, reason: "no-reconnect-configured" });
      return;
    }
    this.reconnecting = true;
    void this.runReconnectLoop(opts);
  }

  private async runReconnectLoop(opts: NonNullable<FederationLinkOptions["reconnect"]>): Promise<void> {
    const reconnectWire = opts.reconnectWire as () => Promise<Wire>;
    for (let attempt = 0; attempt < opts.attempts; attempt++) {
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      const capped = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
      const jittered = capped * (0.5 + Math.random() * 0.5);
      await this.sleep(jittered);
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try {
        const newWire = await reconnectWire();
        this.wire = newWire;
        this.attachWire(newWire);
        const resumed = await this.resumeHandshake();
        if (resumed.ok) {
          this.statCounts.reconnects++;
          this.reconnecting = false;
          this.onPeerUp();
          return;
        }
      } catch {
        // swallow and retry
      }
    }
    this.reconnecting = false;
    if (!this.closed) {
      this.emit("peer:down", { peerNodeId: this.peerNodeId, reason: "reconnect-exhausted" });
    }
  }

  private async resumeHandshake(): Promise<HandshakeResult> {
    return new Promise<HandshakeResult>((resolve) => {
      const timer = this.schedule(() => {
        this.handshakeWaiters = this.handshakeWaiters.filter((w) => w.timer !== timer);
        resolve({ ok: false, reason: "resume-timeout" });
      }, this.requestTimeoutMs);
      this.handshakeWaiters.push({ resolve, timer });
      void this.sendControl("hello", this.peerNodeId ?? "*", { nodeId: this.identity.nodeId, resume: true });
    });
  }

  private resolveHandshake(result: HandshakeResult): void {
    const waiters = this.handshakeWaiters;
    this.handshakeWaiters = [];
    for (const w of waiters) {
      this.cancelTimer(w.timer);
      w.resolve(result);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wrapped = (): void => {
        this.pendingSleepResolvers.delete(wrapped);
        resolve();
      };
      this.pendingSleepResolvers.add(wrapped);
      this.schedule(wrapped, ms);
    });
  }

  // -- timers -----------------------------------------------------------------

  private schedule(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = this.setTimeoutFn(() => {
      this.timers.delete(t);
      cb();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private cancelTimer(t: ReturnType<typeof setTimeout> | undefined): void {
    if (t === undefined) return;
    this.timers.delete(t);
    this.clearTimeoutFn(t);
  }
}
