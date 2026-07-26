import type { AgentEndpoint } from "./bus";
import type { A2AMessage, AgentAddress } from "./types";

export interface RpcOptions {
  /** Reject if no response arrives in this many ms. 0/Infinity = no timeout. */
  timeoutMs?: number;
}

export type RpcHandler = (payload: unknown, from: AgentAddress, msg: A2AMessage) => unknown | Promise<unknown>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RpcPeerOptions {
  defaultTimeoutMs?: number;
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
}

/**
 * Request/response RPC over A2A. Wrapping an {@link AgentEndpoint}, a peer can
 * both `serve` (answer `request` messages) and `request` (send one and await the
 * correlated response). Correlation is by `correlationId`; a handler that throws
 * is surfaced to the caller as a rejected promise via an `error` message; a
 * request that isn't answered in time rejects with a timeout. All timers are
 * injectable, so timeout behavior tests deterministically.
 */
export class RpcPeer {
  private pending = new Map<string, Pending>();
  private handler?: RpcHandler;
  private readonly off: () => void;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly endpoint: AgentEndpoint,
    private readonly opts: RpcPeerOptions = {}
  ) {
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((t) => clearTimeout(t));
    this.off = endpoint.on((m) => void this.dispatch(m));
  }

  /** Register the handler that answers inbound requests. */
  serve(handler: RpcHandler): this {
    this.handler = handler;
    return this;
  }

  /** Send a request and await the correlated response. */
  request<Res = unknown>(to: AgentAddress, payload: unknown, opts: RpcOptions = {}): Promise<Res> {
    const msg = this.endpoint.factory.request(to, payload);
    const cid = msg.correlationId!;
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30000;

    const promise = new Promise<Res>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        entry.timer = this.setTimeoutFn(() => {
          this.pending.delete(cid);
          reject(new Error(`A2A request to ${to.agentId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(cid, entry);
    });

    void this.endpoint.send(msg);
    return promise;
  }

  private async dispatch(m: A2AMessage): Promise<void> {
    if (m.kind === "request") {
      if (!this.handler) return;
      try {
        const result = await this.handler(m.payload, m.from, m);
        void this.endpoint.send(this.endpoint.factory.respond(m.from, m.correlationId!, result, "response"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void this.endpoint.send(this.endpoint.factory.respond(m.from, m.correlationId!, { error: message }, "error"));
      }
      return;
    }

    if (m.kind === "response" || m.kind === "error") {
      const cid = m.correlationId;
      const entry = cid ? this.pending.get(cid) : undefined;
      if (!entry || !cid) return;
      this.pending.delete(cid);
      if (entry.timer) this.clearTimeoutFn(entry.timer);
      if (m.kind === "error") {
        entry.reject(new Error((m.payload as { error?: string })?.error ?? "A2A remote error"));
      } else {
        entry.resolve(m.payload);
      }
    }
  }

  /** Number of in-flight requests awaiting a response. */
  inFlight(): number {
    return this.pending.size;
  }

  close(): void {
    this.off();
    for (const entry of this.pending.values()) {
      if (entry.timer) this.clearTimeoutFn(entry.timer);
      entry.reject(new Error("RPC peer closed"));
    }
    this.pending.clear();
  }
}
