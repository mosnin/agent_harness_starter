/**
 * @module swarm-runtime/distributed/federation-router
 *
 * Phase 19 — the cluster data plane.
 *
 * `FederationRouter` is the one object on a machine that owns the whole
 * federated fan-out: exactly one authenticated {@link FederationLink} per
 * peer node, all sharing this node's {@link NodeIdentity} and
 * {@link PeerTrustPolicy}. It does not reimplement anything the link already
 * gives us for free — framing, ed25519 signing/verification, per-peer
 * sequence numbers, nonce-based replay defence, the bounded unacked queue,
 * and reconnect-and-resume all come straight from `./federation-link`. This
 * module is purely about *what* travels over that already-secure channel:
 *
 *  - **Gossip**: `broadcastGossip()` ships this node's `ClusterMembership`
 *    digest to every connected peer; an inbound digest is fed straight into
 *    the *real* `ClusterMembership.apply()`, and every entry that merge
 *    rejects is surfaced via `envelope:rejected` — never swallowed.
 *  - **Offers**: `offer()` is a `FederationLink.request()` round trip — the
 *    receiving side's registered `onOffer` handler decides accept/refuse,
 *    and its return value becomes the link's automatic `"result"` reply. A
 *    timeout resolves to a refusal (`refusal: "unknown"`) rather than
 *    throwing into a scheduler that has to keep going regardless.
 *  - **Results**: `sendResult()` ships a `FederatedResultEntry` — the
 *    caller's own certificate included, verbatim, never re-derived here —
 *    to a peer; the receiving side dedupes by `${taskId}#${nodeId}#${fencing}`
 *    so a resend after a partition (or an honest at-least-once retry) can
 *    never double-deliver into `onResult`.
 *
 * ── Wire-kind reuse note ───────────────────────────────────────────────────
 * `FederationLink` reserves the literal `"result"` kind for its own request/
 * response plumbing: any envelope of a kind *not* one of
 * `hello/welcome/ack/ping/pong/bye/result` is handed to the link's `serve()`
 * handler and, once that handler resolves, the link automatically wraps the
 * return value in a `"result"` envelope addressed back to the sender (see
 * `FederationLink.dispatch`'s default branch). That is exactly the
 * request/response contract `offer()` rides: it calls
 * `link.request("offer", ...)`, the peer's `serve()` handler (installed
 * below) invokes the registered `onOffer` callback and returns the resulting
 * `ClusterAccept`, and the link's own machinery ships that back as the
 * `"result"` reply `request()` is waiting on. `sendResult()` therefore
 * cannot use the literal `"result"` kind for its own payload — that kind is
 * spoken-for by the link. It reuses the `"accept"` kind (a fire-and-forget
 * `send()`, not a `request()`) purely as a wire-level envelope tag for
 * shipping a `FederatedResultEntry`; nothing about that kind's *name*
 * constrains what travels in `payload` — the two logical channels
 * (`ClusterAccept` values vs. `FederatedResultEntry` blobs) are told apart
 * by direction (one is a request's resolved value, the other is a distinct
 * inbound envelope) and by shape-validating the payload before trusting it.
 */

import { EventEmitter } from "node:events";

import {
  FederationLink,
  type FederationLinkOptions,
  type FederatedEnvelope,
  type FederatedKind,
  type NodeIdentity,
  localIdentity,
  type PeerTrustPolicy,
  pinnedTrust,
  type LinkStats,
} from "./federation-link";
import type { Wire, Codec } from "../../hades/a2a/remote-transport";
import type { ClusterMembership, GossipDigest, NodeDescriptor } from "./membership";
import type { Lease, FederatedResultEntry } from "./lease-ledger";
import type { WorkerTask } from "../types";

// Re-exported so consumers can construct real identities without reaching
// into federation-link directly; not part of the LOCKED CONTRACT surface but
// harmless (same objects, same module).
export { localIdentity, pinnedTrust };

// ---------------------------------------------------------------------------
// Public types (locked contract)
// ---------------------------------------------------------------------------

export interface ClusterOffer {
  taskId: string;
  task: WorkerTask;
  lease: Lease;
  fromNodeId: string;
  deadlineAt: number;
}

export interface ClusterAccept {
  taskId: string;
  fencing: number;
  nodeId: string;
  accepted: boolean;
  refusal?: "capacity" | "capability" | "draining" | "stale-fencing" | "unknown";
  at: number;
}

export type PeerPhase = "connecting" | "ready" | "degraded" | "closed";

export interface PeerStatus {
  nodeId: string;
  phase: PeerPhase;
  publicKeyHex: string;
  stats: LinkStats;
  lastSeenAt: number;
}

export interface FederationRouterStats {
  peers: number;
  ready: number;
  gossipSent: number;
  gossipReceived: number;
  offersSent: number;
  offersAccepted: number;
  offersRefused: number;
  resultsSent: number;
  resultsReceived: number;
  resultsDeduped: number;
  rejected: Record<string, number>;
}

export interface FederationRouterOptions {
  identity: NodeIdentity;
  trust: PeerTrustPolicy;
  membership: ClusterMembership;
  now?: () => number;
  codec?: Codec;
  requestTimeoutMs?: number;
  sendQueueLimit?: number;
  linkFactory?: (opts: FederationLinkOptions) => FederationLink;
}

// ---------------------------------------------------------------------------
// Internal shape guards — never trust a decoded `unknown` payload just
// because it made it past the link's signature/trust/replay checks. Those
// checks prove *who* sent it and that it wasn't tampered with in transit;
// they say nothing about whether the sender is honestly speaking the
// application-level protocol this router expects.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isGossipDigestShape(v: unknown): v is GossipDigest {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.senderId === "string" &&
    typeof v.sentAt === "number" &&
    Number.isFinite(v.sentAt) &&
    typeof v.epoch === "number" &&
    Array.isArray(v.entries) &&
    typeof v.checksum === "string"
  );
}

function isLeaseShape(v: unknown): v is Lease {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.taskId === "string" &&
    v.taskId.length > 0 &&
    typeof v.nodeId === "string" &&
    v.nodeId.length > 0 &&
    typeof v.fencing === "number" &&
    Number.isFinite(v.fencing) &&
    typeof v.attempt === "number" &&
    typeof v.grantedAt === "number" &&
    typeof v.expiresAt === "number"
  );
}

function isClusterOfferShape(v: unknown): v is ClusterOffer {
  if (!isPlainObject(v)) return false;
  if (typeof v.taskId !== "string" || v.taskId.length === 0) return false;
  if (typeof v.fromNodeId !== "string" || v.fromNodeId.length === 0) return false;
  if (typeof v.deadlineAt !== "number" || !Number.isFinite(v.deadlineAt)) return false;
  if (!isPlainObject(v.task) || typeof v.task.id !== "string") return false;
  if (!isLeaseShape(v.lease)) return false;
  return true;
}

function isClusterAcceptShape(v: unknown): v is ClusterAccept {
  if (!isPlainObject(v)) return false;
  return (
    typeof v.taskId === "string" &&
    typeof v.fencing === "number" &&
    typeof v.nodeId === "string" &&
    typeof v.accepted === "boolean" &&
    typeof v.at === "number"
  );
}

function isFederatedResultEntryShape(v: unknown): v is FederatedResultEntry {
  if (!isPlainObject(v)) return false;
  if (typeof v.taskId !== "string" || v.taskId.length === 0) return false;
  if (typeof v.nodeId !== "string" || v.nodeId.length === 0) return false;
  if (typeof v.fencing !== "number" || !Number.isFinite(v.fencing)) return false;
  const result = v.result;
  if (!isPlainObject(result) || result.taskId !== v.taskId) return false;
  const report = v.report;
  if (!isPlainObject(report) || report.taskId !== v.taskId) return false;
  if (v.certificate !== undefined) {
    const cert = v.certificate;
    if (!isPlainObject(cert)) return false;
    if (typeof cert.signature !== "string" || typeof cert.publicKey !== "string") return false;
    if (!isPlainObject(cert.payload)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// pairedWires — a REAL in-process duplex Wire pair for tests / same-host
// federation. Honours exactly the same send/onFrame/onClose/close contract
// FederationLink's socketWire does; injects latency/drops/partitions at the
// framed-string level without touching signing, sequencing, or the codec —
// those all still run, unmodified, inside FederationLink on both ends.
// ---------------------------------------------------------------------------

/** Small, seedable PRNG (mulberry32) — deterministic so fault injection in
 *  tests is reproducible run to run, not flaky. Not used for anything
 *  security-sensitive (that's all real crypto, upstream in federation-link). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PairedWireExtras {
  onClose(handler: (err?: Error) => void): void;
  close(): void;
}

export function pairedWires(opts?: { latencyMs?: number; dropRate?: number; seed?: number }): {
  a: Wire;
  b: Wire;
  partition(): void;
  heal(): void;
} {
  const latencyMs = Math.max(0, opts?.latencyMs ?? 0);
  const dropRate = Math.min(1, Math.max(0, opts?.dropRate ?? 0));
  const rng = mulberry32(opts?.seed ?? 0x5eed_5eed);

  let partitioned = false;
  let closedA = false;
  let closedB = false;

  let frameHandlerA: ((frame: string) => void) | undefined;
  let frameHandlerB: ((frame: string) => void) | undefined;
  let closeHandlerA: ((err?: Error) => void) | undefined;
  let closeHandlerB: ((err?: Error) => void) | undefined;

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function deliver(frame: string, target: () => ((frame: string) => void) | undefined): void {
    // Drop decision is made "on the wire" at send time, deterministically
    // from the seeded RNG, matching real packet loss (a dropped packet never
    // arrives at all, it doesn't arrive-then-get-discarded downstream).
    if (dropRate > 0 && rng() < dropRate) return;
    const deliverNow = (): void => {
      if (partitioned) return; // partitioned after send but before arrival: drop in flight, like a real cut link
      target()?.(frame);
    };
    if (latencyMs > 0) {
      const t = setTimeout(() => {
        pendingTimers.delete(t);
        deliverNow();
      }, latencyMs);
      pendingTimers.add(t);
    } else {
      // Still genuinely async (never same-tick), like any real transport,
      // so callers can't accidentally depend on synchronous delivery.
      const t = setTimeout(deliverNow, 0);
      pendingTimers.add(t);
    }
  }

  const a: Wire & PairedWireExtras = {
    send(frame: string): void {
      if (closedA || partitioned) return;
      deliver(frame, () => frameHandlerB);
    },
    onFrame(handler: (frame: string) => void): void {
      frameHandlerA = handler;
    },
    onClose(handler: (err?: Error) => void): void {
      closeHandlerA = handler;
    },
    close(): void {
      if (closedA) return;
      closedA = true;
      closeHandlerA?.();
    },
  };

  const b: Wire & PairedWireExtras = {
    send(frame: string): void {
      if (closedB || partitioned) return;
      deliver(frame, () => frameHandlerA);
    },
    onFrame(handler: (frame: string) => void): void {
      frameHandlerB = handler;
    },
    onClose(handler: (err?: Error) => void): void {
      closeHandlerB = handler;
    },
    close(): void {
      if (closedB) return;
      closedB = true;
      closeHandlerB?.();
    },
  };

  return {
    a,
    b,
    partition(): void {
      partitioned = true;
    },
    heal(): void {
      partitioned = false;
    },
  };
}

// ---------------------------------------------------------------------------
// FederationRouter
// ---------------------------------------------------------------------------

interface PeerRecord {
  nodeId: string;
  link: FederationLink;
  status: PeerStatus;
  /**
   * True once a deliberate `disconnect()`/`close()` has started tearing this
   * peer down. A simultaneous bidirectional handshake means a link can fire
   * "peer:up" more than once (once reacting to the peer's `hello`, again
   * reacting to the peer's `welcome`-reply to *our* `hello`) — if a second,
   * late "peer:up" lands while a close is already in flight, it must not be
   * allowed to resurrect `status.phase` back to "ready" out from under the
   * close in progress. This flag is the source of truth for "are we
   * deliberately tearing this down", independent of `status.phase`.
   */
  closing: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class FederationRouter extends EventEmitter {
  private readonly identity: NodeIdentity;
  private readonly trust: PeerTrustPolicy;
  private readonly membership: ClusterMembership;
  private readonly now: () => number;
  private readonly codec?: Codec;
  private readonly requestTimeoutMs: number;
  private readonly sendQueueLimit?: number;
  private readonly linkFactory: (opts: FederationLinkOptions) => FederationLink;

  private readonly peerRecords = new Map<string, PeerRecord>();
  private offerHandler?: (o: ClusterOffer) => Promise<ClusterAccept> | ClusterAccept;
  private resultHandler?: (e: FederatedResultEntry, fromNodeId: string) => void | Promise<void>;
  private readonly seenResultKeys = new Set<string>();
  private closed = false;

  private readonly statCounts: FederationRouterStats = {
    peers: 0,
    ready: 0,
    gossipSent: 0,
    gossipReceived: 0,
    offersSent: 0,
    offersAccepted: 0,
    offersRefused: 0,
    resultsSent: 0,
    resultsReceived: 0,
    resultsDeduped: 0,
    rejected: {},
  };

  constructor(opts: FederationRouterOptions) {
    super();
    this.identity = opts.identity;
    this.trust = opts.trust;
    this.membership = opts.membership;
    this.now = opts.now ?? (() => Date.now());
    this.codec = opts.codec;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sendQueueLimit = opts.sendQueueLimit;
    this.linkFactory = opts.linkFactory ?? ((linkOpts) => new FederationLink(linkOpts));
  }

  // -- public API -------------------------------------------------------

  async connect(
    peer: NodeDescriptor,
    wire: Wire,
    reconnect?: { attempts: number; baseDelayMs: number; maxDelayMs: number; reconnectWire?: () => Promise<Wire> }
  ): Promise<PeerStatus> {
    if (this.closed) throw new Error("FederationRouter: router is closed");

    const existing = this.peerRecords.get(peer.nodeId);
    if (existing) {
      await existing.link.close();
      this.peerRecords.delete(peer.nodeId);
    }

    const status: PeerStatus = {
      nodeId: peer.nodeId,
      phase: "connecting",
      publicKeyHex: peer.publicKeyHex,
      stats: { sent: 0, received: 0, rejected: {}, queued: 0, dropped: 0, reconnects: 0 },
      lastSeenAt: this.now(),
    };

    const linkOpts: FederationLinkOptions = {
      identity: this.identity,
      wire,
      trust: this.trust,
      now: this.now,
      codec: this.codec,
      requestTimeoutMs: this.requestTimeoutMs,
      sendQueueLimit: this.sendQueueLimit,
      reconnect,
    };
    const link = this.linkFactory(linkOpts);
    const record: PeerRecord = { nodeId: peer.nodeId, link, status, closing: false };
    this.peerRecords.set(peer.nodeId, record);
    this.statCounts.peers = this.peerRecords.size;

    this.wireLinkEvents(record);
    link.serve(this.buildServeHandler(record));

    const hs = await link.handshake();
    if (!hs.ok || (hs.peerNodeId !== undefined && hs.peerNodeId !== peer.nodeId)) {
      status.phase = "closed";
      const reason = !hs.ok ? hs.reason ?? "handshake-failed" : "peer-identity-mismatch";
      this.recordRejected(reason);
      this.emit("envelope:rejected", reason, peer.nodeId);
      this.emit("peer:closed", peer.nodeId, reason);
      this.peerRecords.delete(peer.nodeId);
      this.statCounts.peers = this.peerRecords.size;
      await link.close().catch(() => undefined);
      throw new Error(`FederationRouter: connect to "${peer.nodeId}" failed (${reason})`);
    }

    // Under normal operation the link's own "peer:up" event (see
    // `wireLinkEvents`) has already flipped `status.phase` to "ready" and
    // emitted "peer:ready" — FederationLink calls `resolveHandshake()` then
    // `onPeerUp()` synchronously, in that order, strictly before the
    // continuation of this `await link.handshake()` runs. The check below is
    // a defensive fallback only, so connect() never returns a stale
    // "connecting" status even if that internal ordering ever changes.
    if (status.phase !== "ready") {
      status.phase = "ready";
      status.lastSeenAt = this.now();
      this.recomputeReady();
      this.emit("peer:ready", this.snapshotStatus(record));
    }
    return this.snapshotStatus(record);
  }

  async disconnect(nodeId: string, reason: string): Promise<void> {
    const record = this.peerRecords.get(nodeId);
    if (!record) return;
    // Flip `closing` (and `status.phase`) to "closed" *before* tearing down
    // the link: FederationLink.close() itself emits a "peer:down" event
    // synchronously, and the listener installed in `wireLinkEvents` no-ops
    // once `closing` is set — this is what keeps a caller-initiated
    // disconnect from also producing a second, link-generated "peer:closed"
    // with a different reason string (see `PeerRecord.closing`).
    record.closing = true;
    record.status.phase = "closed";
    this.peerRecords.delete(nodeId);
    this.recomputeReady();
    await record.link.close();
    this.emit("peer:closed", nodeId, reason);
  }

  async broadcastGossip(): Promise<{ sent: string[]; failed: Array<{ nodeId: string; error: string }> }> {
    const digest = this.membership.digest();
    const sent: string[] = [];
    const failed: Array<{ nodeId: string; error: string }> = [];

    // Fan out concurrently and independently: one peer's slow/blackholed
    // link must never delay delivery to a healthy peer. `FederationLink.send`
    // for a reliable kind only awaits local signing + the (non-blocking,
    // fire-and-forget) transmit call — it never waits on an ack — so this
    // resolves promptly even against a peer that never acknowledges anything.
    await Promise.all(
      [...this.peerRecords.values()].map(async (record) => {
        try {
          await record.link.send("gossip", record.nodeId, digest);
          this.statCounts.gossipSent++;
          sent.push(record.nodeId);
        } catch (err) {
          failed.push({ nodeId: record.nodeId, error: err instanceof Error ? err.message : String(err) });
        }
      })
    );

    return { sent, failed };
  }

  async offer(nodeId: string, offer: ClusterOffer): Promise<ClusterAccept> {
    const record = this.peerRecords.get(nodeId);
    if (!record) {
      const refusal: ClusterAccept = {
        taskId: offer.taskId,
        fencing: offer.lease.fencing,
        nodeId,
        accepted: false,
        refusal: "unknown",
        at: this.now(),
      };
      this.statCounts.offersRefused++;
      return refusal;
    }

    this.statCounts.offersSent++;
    try {
      const raw = await record.link.request<ClusterOffer, unknown>("offer", nodeId, offer);
      if (!isClusterAcceptShape(raw)) {
        this.statCounts.offersRefused++;
        return { taskId: offer.taskId, fencing: offer.lease.fencing, nodeId, accepted: false, refusal: "unknown", at: this.now() };
      }
      if (raw.accepted) this.statCounts.offersAccepted++;
      else this.statCounts.offersRefused++;
      return raw;
    } catch {
      // Timeout, or the link was closed mid-flight — the scheduler must get
      // a concrete refusal back, never an unhandled rejection.
      this.statCounts.offersRefused++;
      return { taskId: offer.taskId, fencing: offer.lease.fencing, nodeId, accepted: false, refusal: "unknown", at: this.now() };
    }
  }

  async sendResult(nodeId: string, entry: FederatedResultEntry): Promise<void> {
    const record = this.peerRecords.get(nodeId);
    if (!record || record.status.phase === "closed") {
      throw new Error(`FederationRouter: no such connected peer "${nodeId}"`);
    }
    // Fire-and-forget at the transport level (queued + acked by the link);
    // the local dedupe key is recorded on *receipt*, not on send, so a
    // resend of the same entry (our own retry, or the link's own reconnect
    // resume) is always safe to attempt again from the sender's side.
    await record.link.send("accept", nodeId, entry);
    this.statCounts.resultsSent++;
  }

  onOffer(handler: (o: ClusterOffer) => Promise<ClusterAccept> | ClusterAccept): void {
    this.offerHandler = handler;
  }

  onResult(handler: (e: FederatedResultEntry, fromNodeId: string) => void | Promise<void>): void {
    this.resultHandler = handler;
  }

  peers(): PeerStatus[] {
    return [...this.peerRecords.values()]
      .map((record) => this.snapshotStatus(record))
      .sort((x, y) => x.nodeId.localeCompare(y.nodeId));
  }

  stats(): FederationRouterStats {
    return {
      ...this.statCounts,
      peers: this.peerRecords.size,
      ready: [...this.peerRecords.values()].filter((r) => r.status.phase === "ready").length,
      rejected: { ...this.statCounts.rejected },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const records = [...this.peerRecords.values()];
    this.peerRecords.clear();
    await Promise.all(
      records.map(async (record) => {
        // See `disconnect()`: pre-flip `closing`/`status.phase` so the
        // link's own "peer:down" emission (from `link.close()`) is
        // swallowed by the listener guard instead of double-firing
        // "peer:closed" here.
        record.closing = true;
        record.status.phase = "closed";
        await record.link.close().catch(() => undefined);
        this.emit("peer:closed", record.nodeId, "router-closed");
      })
    );
    this.statCounts.peers = 0;
    this.statCounts.ready = 0;
  }

  // -- internal -----------------------------------------------------------

  private recordRejected(reason: string): void {
    this.statCounts.rejected[reason] = (this.statCounts.rejected[reason] ?? 0) + 1;
  }

  private recomputeReady(): void {
    this.statCounts.peers = this.peerRecords.size;
    this.statCounts.ready = [...this.peerRecords.values()].filter((r) => r.status.phase === "ready").length;
  }

  private snapshotStatus(record: PeerRecord): PeerStatus {
    record.status.stats = record.link.stats();
    return { ...record.status };
  }

  private wireLinkEvents(record: PeerRecord): void {
    const { link, status, nodeId } = record;

    link.on("peer:up", () => {
      // A simultaneous bidirectional handshake can fire "peer:up" more than
      // once on the same link (see `PeerRecord.closing`'s doc comment) — once
      // a deliberate teardown has started, a late one must never resurrect
      // this peer's status.
      if (record.closing) return;
      const wasDegraded = status.phase === "degraded";
      status.phase = "ready";
      status.lastSeenAt = this.now();
      this.recomputeReady();
      if (wasDegraded || status.phase === "ready") {
        this.emit("peer:ready", this.snapshotStatus(record));
      }
    });

    link.on("peer:degraded", () => {
      if (record.closing) return;
      status.phase = "degraded";
      this.recomputeReady();
      this.emit("peer:degraded", nodeId, "heartbeat-timeout");
    });

    link.on("peer:down", (payload: unknown) => {
      if (status.phase === "closed") return;
      status.phase = "closed";
      this.recomputeReady();
      const reason =
        isPlainObject(payload) && typeof payload.reason === "string" ? payload.reason : "link-down";
      this.emit("peer:closed", nodeId, reason);
    });

    link.on("rejected", (payload: unknown) => {
      const reason =
        isPlainObject(payload) && typeof payload.reason === "string" ? payload.reason : "unknown";
      const envelope = isPlainObject(payload) ? (payload.envelope as Partial<FederatedEnvelope> | undefined) : undefined;
      const fromNodeId = envelope && typeof envelope.fromNodeId === "string" ? envelope.fromNodeId : nodeId;
      this.recordRejected(reason);
      this.emit("envelope:rejected", reason, fromNodeId);
    });
  }

  private buildServeHandler(record: PeerRecord): (e: FederatedEnvelope) => Promise<unknown> {
    return async (e: FederatedEnvelope): Promise<unknown> => {
      record.status.lastSeenAt = this.now();

      switch (e.kind as FederatedKind) {
        case "gossip":
          return this.handleGossipEnvelope(e);
        case "offer":
          return this.handleOfferEnvelope(e);
        case "accept":
          return this.handleResultEnvelope(e);
        default:
          // Any other kind reaching the generic serve handler (there
          // currently is none, since hello/welcome/ack/ping/pong/bye/result
          // are all intercepted inside FederationLink itself) is simply
          // not part of this router's application protocol.
          this.recordRejected("unhandled-kind");
          this.emit("envelope:rejected", "unhandled-kind", e.fromNodeId);
          return { ok: false };
      }
    };
  }

  private handleGossipEnvelope(e: FederatedEnvelope): unknown {
    this.statCounts.gossipReceived++;
    if (!isGossipDigestShape(e.payload)) {
      this.recordRejected("malformed-gossip");
      this.emit("envelope:rejected", "malformed-gossip", e.fromNodeId);
      return { ok: false };
    }
    const digest = e.payload;

    let result;
    try {
      result = this.membership.apply(digest);
    } catch (err) {
      this.recordRejected("gossip-apply-threw");
      this.emit("envelope:rejected", "gossip-apply-threw", e.fromNodeId);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    for (const rej of result.rejected) {
      this.recordRejected(rej.reason);
      this.emit("envelope:rejected", rej.reason, e.fromNodeId);
    }
    this.emit("gossip:received", digest, e.fromNodeId);
    return { ok: true, applied: result.applied, rejected: result.rejected.length };
  }

  private async handleOfferEnvelope(e: FederatedEnvelope): Promise<ClusterAccept> {
    if (!isClusterOfferShape(e.payload)) {
      this.recordRejected("malformed-offer");
      this.emit("envelope:rejected", "malformed-offer", e.fromNodeId);
      return { taskId: "", fencing: 0, nodeId: this.identity.nodeId, accepted: false, refusal: "unknown", at: this.now() };
    }
    const offer = e.payload;

    if (!this.offerHandler) {
      return {
        taskId: offer.taskId,
        fencing: offer.lease.fencing,
        nodeId: this.identity.nodeId,
        accepted: false,
        refusal: "capacity",
        at: this.now(),
      };
    }

    try {
      const accept = await this.offerHandler(offer);
      return accept;
    } catch {
      return {
        taskId: offer.taskId,
        fencing: offer.lease.fencing,
        nodeId: this.identity.nodeId,
        accepted: false,
        refusal: "unknown",
        at: this.now(),
      };
    }
  }

  private async handleResultEnvelope(e: FederatedEnvelope): Promise<unknown> {
    if (!isFederatedResultEntryShape(e.payload)) {
      this.recordRejected("malformed-result");
      this.emit("envelope:rejected", "malformed-result", e.fromNodeId);
      return { ok: false };
    }
    const entry = e.payload;

    // IMPERSONATION GUARD. `e.fromNodeId` is AUTHENTICATED — the link verified
    // an ed25519 signature over the envelope against that peer's pinned public
    // key before this handler ever ran. `entry.nodeId` is just a field in the
    // payload, i.e. whatever the sender typed. If a peer ships a result
    // claiming to come from a DIFFERENT node, refuse it here rather than
    // relaying an attributable claim nobody actually made.
    //
    // This matters because the downstream `VerifiedResultLedger` verifies that
    // the certificate is well-signed and binds the output, but it does not (and
    // structurally cannot, since it never sees the membership roster) check
    // that the ISSUING key belongs to `entry.nodeId`. So a trusted-but-hostile
    // peer could otherwise mint its own certificate over its own output, label
    // it with a victim node's id, and have the coordinator attribute — and
    // accept — that work as the victim's. The router is the layer that holds
    // both facts at once (who really sent this frame, and who it claims to be
    // from), so the check belongs here.
    if (entry.nodeId !== e.fromNodeId) {
      this.recordRejected("result-node-mismatch");
      this.emit("envelope:rejected", "result-node-mismatch", e.fromNodeId);
      return { ok: false };
    }

    this.statCounts.resultsReceived++;

    const key = `${entry.taskId}#${entry.nodeId}#${entry.fencing}`;
    if (this.seenResultKeys.has(key)) {
      this.statCounts.resultsDeduped++;
      return { ok: true, deduped: true };
    }
    this.seenResultKeys.add(key);

    this.emit("result:received", entry, e.fromNodeId);
    if (this.resultHandler) {
      try {
        await this.resultHandler(entry, e.fromNodeId);
      } catch {
        // A throwing consumer must never take down the link's dispatch loop
        // or prevent the automatic ack from going out.
      }
    }
    return { ok: true };
  }
}
