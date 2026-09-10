import type { JsonRpcMessage } from "./types";

/**
 * Injectable ACP transport. Production frames JSON-RPC over the editor's stdio
 * (or a socket); tests use {@link InMemoryAcpTransport} to wire a client and
 * agent together in-process — no stdio, no editor.
 */
export interface AcpTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  close(): Promise<void>;
}

/**
 * A pair of in-memory transports whose outputs cross-feed each other, so an
 * {@link AcpServer} and a test client can exchange JSON-RPC in-process. Delivery
 * is async (queued on the microtask queue) to mimic a real link.
 */
export class InMemoryAcpTransport implements AcpTransport {
  private handler?: (message: JsonRpcMessage) => void;
  private peer?: InMemoryAcpTransport;
  private closed = false;
  readonly sent: JsonRpcMessage[] = [];

  static pair(): [InMemoryAcpTransport, InMemoryAcpTransport] {
    const a = new InMemoryAcpTransport();
    const b = new InMemoryAcpTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("transport closed");
    this.sent.push(message);
    const peer = this.peer;
    await Promise.resolve();
    peer?.handler?.(message);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
