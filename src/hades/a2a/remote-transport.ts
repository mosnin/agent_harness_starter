/**
 * Cross-process A2A transport.
 *
 * This transport has the **same routing semantics** as {@link InMemoryA2ATransport}
 * — direct messages are dispatched by an O(1) `Map.get(agentId)` lookup, and only
 * broadcasts fan out (team-scoped via {@link deliversTo}) — but every message is
 * serialized and pushed across an injectable {@link Wire} before it is routed.
 *
 * With the default {@link loopbackWire} the wire delivers frames synchronously in
 * the same process (a co-located hub), so behaviour is indistinguishable from the
 * in-memory bus *except* that each message survives an encode/decode round-trip,
 * which proves wire-safety. Swap {@link loopbackWire} for a WebSocket (or any
 * transport implementing {@link Wire}) and the exact same code becomes genuinely
 * distributed with identical routing semantics.
 */
import { deliversTo, isBroadcast } from "./types";
import type { A2AMessage, AgentAddress } from "./types";
import type { A2ATransport } from "./bus";

/** Serializes/deserializes an A2A envelope for transmission over a {@link Wire}. */
export interface Codec {
  encode(msg: A2AMessage): string;
  decode(frame: string): A2AMessage;
}

/** Default codec: plain JSON. Non-JSON fields (functions, `undefined`) are dropped. */
export const jsonCodec: Codec = {
  encode(msg: A2AMessage): string {
    return JSON.stringify(msg);
  },
  decode(frame: string): A2AMessage {
    return JSON.parse(frame) as A2AMessage;
  },
};

/**
 * The byte pipe under the transport. `send` pushes a frame out; `onFrame`
 * registers the handler that receives inbound frames. In production this is a
 * socket; in tests {@link loopbackWire} models a co-located hub.
 */
export interface Wire {
  send(frame: string): void;
  onFrame(handler: (frame: string) => void): void;
}

/**
 * A wire whose `send` delivers the frame to the registered `onFrame` handler
 * **synchronously**, in-process. Models a co-located hub; swap for a WebSocket
 * in production without changing the transport.
 */
export function loopbackWire(): Wire {
  let handler: ((frame: string) => void) | undefined;
  return {
    send(frame: string): void {
      handler?.(frame);
    },
    onFrame(h: (frame: string) => void): void {
      handler = h;
    },
  };
}

interface Sub {
  address: AgentAddress;
  handler: (msg: A2AMessage) => void;
}

/**
 * A2A transport that routes over an injectable, serialized {@link Wire}. Routing
 * is identical to {@link InMemoryA2ATransport} — O(1) direct dispatch, team-scoped
 * broadcast fan-out — but every published message crosses the wire (encode →
 * send → onFrame → decode) before it is routed, so it is always wire-safe.
 */
export class RemoteA2ATransport implements A2ATransport {
  private subs = new Map<string, Sub>();
  private readonly codec: Codec;
  private readonly wire: Wire;
  /** Instrumentation: number of subscriber comparisons made during routing. */
  routeScans = 0;

  constructor(opts: { codec?: Codec; wire?: Wire } = {}) {
    this.codec = opts.codec ?? jsonCodec;
    this.wire = opts.wire ?? loopbackWire();
    // Subscribe to the wire exactly once; inbound frames are decoded and routed.
    this.wire.onFrame((frame) => this.route(this.codec.decode(frame)));
  }

  register(address: AgentAddress, handler: (msg: A2AMessage) => void): () => void {
    this.subs.set(address.agentId, { address, handler });
    return () => this.subs.delete(address.agentId);
  }

  /** Encode and push over the wire; the frame comes back via onFrame and is routed. */
  publish(msg: A2AMessage): void {
    this.wire.send(this.codec.encode(msg));
  }

  /** Route a decoded frame with the same semantics as the in-memory transport. */
  private route(msg: A2AMessage): void {
    if (isBroadcast(msg.to)) {
      // Broadcast: fan out (unavoidable), skipping the sender and off-team subs.
      for (const sub of this.subs.values()) {
        this.routeScans++;
        if (sub.address.agentId === msg.from.agentId) continue;
        if (deliversTo(msg.to, sub.address)) sub.handler(msg);
      }
      return;
    }
    // Direct message: O(1) lookup — no scan over the roster.
    this.routeScans++;
    const sub = this.subs.get(msg.to.agentId);
    if (sub && sub.address.agentId !== msg.from.agentId) sub.handler(msg);
  }

  /** Currently connected agent ids (for tests / diagnostics). */
  members(): string[] {
    return [...this.subs.keys()];
  }
  size(): number {
    return this.subs.size;
  }
}
