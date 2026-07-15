import type { InboundMessage, OutboundReply } from "../../../swarm-runtime/gateway/gateway";
import type { DeliveryTarget, PlatformConnector } from "../connector";

/** A signal-cli receive envelope. */
export interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    dataMessage?: { message?: string };
  };
}

/** Injectable transport around signal-cli (exec or JSON-RPC daemon). */
export interface SignalTransport {
  /** Drain queued incoming envelopes (signal-cli receive). */
  receive(): Promise<SignalEnvelope[]>;
  send(recipient: string, text: string): Promise<void>;
}

export interface SignalConnectorOptions {
  pollIntervalMs?: number;
}

export function parseSignal(source: string, message: string): InboundMessage {
  return { platform: "signal", user: source, channel: source, text: message };
}

/**
 * Signal connector via signal-cli. Signal is delivered by draining the local
 * signal-cli queue, so this polls `receive`, normalizes each data message,
 * routes it, and replies via `send`. All signal-cli interaction is behind
 * {@link SignalTransport}, so it tests with a fake transport — no registered
 * number required.
 */
export class SignalConnector implements PlatformConnector {
  readonly platform = "signal" as const;
  private handler?: (msg: InboundMessage) => Promise<OutboundReply>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly transport: SignalTransport,
    private readonly opts: SignalConnectorOptions = {}
  ) {}

  async start(handler: (msg: InboundMessage) => Promise<OutboundReply>): Promise<void> {
    this.handler = handler;
    this.timer = setInterval(() => void this.pollOnce(), this.opts.pollIntervalMs ?? 2000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.handler = undefined;
  }
  async send(target: DeliveryTarget, text: string): Promise<void> {
    await this.transport.send(String(target.channel ?? target.user), text);
  }

  /** Drain one batch of incoming envelopes. Public for deterministic testing. */
  async pollOnce(): Promise<void> {
    if (!this.handler) return;
    for (const env of await this.transport.receive()) {
      const source = env.envelope?.source ?? env.envelope?.sourceNumber;
      const message = env.envelope?.dataMessage?.message;
      if (!source || !message) continue; // receipts, typing, empty → skip
      const msg = parseSignal(source, message);
      const reply = await this.handler(msg);
      if (reply.text) await this.transport.send(source, reply.text);
    }
  }
}

/** JSON-RPC transport for a signal-cli daemon (`signal-cli --daemon --http`). */
export function createSignalJsonRpcTransport(
  rpcUrl: string,
  account: string,
  fetchImpl: typeof fetch = fetch
): SignalTransport {
  const call = async (method: string, params: Record<string, unknown>) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as { result?: unknown };
  };
  return {
    async receive() {
      const r = await call("receive", { account });
      return (r.result as SignalEnvelope[]) ?? [];
    },
    async send(recipient, text) {
      await call("send", { account, recipient: [recipient], message: text });
    },
  };
}
