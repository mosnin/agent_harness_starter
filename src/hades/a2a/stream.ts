import type { AgentEndpoint } from "./bus";
import type { A2AMessage, AgentAddress } from "./types";

/**
 * An ordered, lossless async queue with completion + error signals. Producers
 * `push`/`end`/`fail`; consumers iterate. Buffers when the consumer is slow;
 * exposes `size()` and a `highWaterMark` overflow flag so a coordinator can see
 * a lagging consumer (the backpressure signal).
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(e: Error) => void> = [];
  private done = false;
  private error?: Error;
  private highWater = false;

  constructor(private readonly highWaterMark = Infinity) {}

  push(value: T): void {
    if (this.done || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.rejecters.shift();
      waiter({ value, done: false });
    } else {
      this.buffer.push(value);
      if (this.buffer.length > this.highWaterMark) this.highWater = true;
    }
  }
  end(): void {
    this.done = true;
    while (this.waiters.length) {
      this.rejecters.shift();
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }
  fail(err: Error): void {
    this.error = err;
    while (this.rejecters.length) {
      this.waiters.shift();
      this.rejecters.shift()!(err);
    }
  }

  size(): number {
    return this.buffer.length;
  }
  overflowed(): boolean {
    return this.highWater;
  }

  async *iterator(): AsyncGenerator<T> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        if (this.buffer.length <= this.highWaterMark) this.highWater = false;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push(resolve);
        this.rejecters.push(reject);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export type StreamHandler = (
  payload: unknown,
  from: AgentAddress,
  msg: A2AMessage
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export interface StreamPeerOptions {
  /** Buffer depth before the client queue flags overflow. */
  highWaterMark?: number;
}

/**
 * Streaming A2A: a request whose reply is a *sequence* of chunks. `serveStream`
 * turns an async-iterable handler into a stream of `stream` messages terminated
 * by `stream_end` (or an `error`); `requestStream` sends the request and returns
 * an async generator that yields chunks in order, completes on `stream_end`, and
 * throws on `error`. Delivery is ordered and lossless (buffered), with a
 * high-water-mark overflow signal for lagging consumers.
 */
export class StreamPeer {
  private streams = new Map<string, AsyncQueue<unknown>>();
  private handler?: StreamHandler;
  private readonly off: () => void;

  constructor(
    private readonly endpoint: AgentEndpoint,
    private readonly opts: StreamPeerOptions = {}
  ) {
    this.off = endpoint.on((m) => void this.dispatch(m));
  }

  serveStream(handler: StreamHandler): this {
    this.handler = handler;
    return this;
  }

  requestStream<T = unknown>(to: AgentAddress, payload: unknown): AsyncGenerator<T> {
    const msg = this.endpoint.factory.request(to, payload);
    const cid = msg.correlationId!;
    const queue = new AsyncQueue<unknown>(this.opts.highWaterMark ?? Infinity);
    this.streams.set(cid, queue);
    void this.endpoint.send(msg);
    return queue.iterator() as AsyncGenerator<T>;
  }

  private async dispatch(m: A2AMessage): Promise<void> {
    if (m.kind === "request" && this.handler) {
      const cid = m.correlationId!;
      try {
        const iterable = await this.handler(m.payload, m.from, m);
        for await (const chunk of iterable) {
          void this.endpoint.send(this.endpoint.factory.respond(m.from, cid, chunk, "stream"));
        }
        void this.endpoint.send(this.endpoint.factory.respond(m.from, cid, null, "stream_end"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void this.endpoint.send(this.endpoint.factory.respond(m.from, cid, { error: message }, "error"));
      }
      return;
    }

    const cid = m.correlationId;
    if (!cid) return;
    const queue = this.streams.get(cid);
    if (!queue) return;
    if (m.kind === "stream") queue.push(m.payload);
    else if (m.kind === "stream_end") {
      queue.end();
      this.streams.delete(cid);
    } else if (m.kind === "error") {
      queue.fail(new Error((m.payload as { error?: string })?.error ?? "A2A stream error"));
      this.streams.delete(cid);
    }
  }

  close(): void {
    this.off();
    for (const q of this.streams.values()) q.fail(new Error("stream peer closed"));
    this.streams.clear();
  }
}
