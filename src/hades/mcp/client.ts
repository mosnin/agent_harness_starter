/**
 * A real **Model Context Protocol (MCP) client** speaking JSON-RPC 2.0 over an
 * INJECTABLE transport. By decoupling correlation/handshake logic from the byte
 * channel, Hades can connect to ANY MCP tool server (stdio, WebSocket, HTTP+SSE,
 * or an in-process mock) and inherit the whole MCP tool ecosystem instead of
 * rebuilding tool plumbing.
 *
 * The client is fully deterministic and side-effect-free at the boundary: all
 * I/O flows through the {@link McpTransport}, and all time flows through the
 * injectable timer functions. There is no real network, subprocess, clock, or
 * `Math.random` anywhere in this module — it is testable in-process against a
 * mock server that captures sent frames and hand-crafts responses.
 */

/** A single JSON-RPC 2.0 frame — request, response, or notification. */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * The byte channel the client speaks over. `send` emits an outbound frame;
 * `onMessage` (called exactly once, from the constructor) registers the sole
 * inbound handler through which ALL correlation is driven. `close` is optional.
 */
export interface McpTransport {
  send(msg: JsonRpcMessage): void | Promise<void>;
  /** Register the client's inbound handler. Called once. */
  onMessage(handler: (msg: JsonRpcMessage) => void): void;
  close?(): void;
}

/** A tool as advertised by the server's `tools/list`. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** One content block in a `tools/call` result (text, image, resource, ...). */
export interface McpContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** The normalized result of a `tools/call`. */
export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpClientOptions {
  clientName?: string; // default "hades"
  clientVersion?: string; // default "0.1.0"
  timeoutMs?: number; // per-request timeout, default 10000
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void;
}

/**
 * A JSON-RPC / MCP protocol failure. Carries the numeric `code` so callers can
 * distinguish a server-declared error (its own code) from a client-side timeout
 * (`-32000`) or a shutdown (`-32001`).
 */
export class McpProtocolError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    // Restore the prototype chain for `instanceof` under transpiled targets.
    Object.setPrototypeOf(this, McpProtocolError.prototype);
  }
}

/** MCP protocol version this client negotiates in `initialize`. */
const PROTOCOL_VERSION = "2024-11-05";

/** Reserved codes for client-originated failures (JSON-RPC server-error range). */
const CODE_TIMEOUT = -32000;
const CODE_CLOSED = -32001;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The MCP client. Construct with a transport (and optional overrides), then call
 * {@link initialize}, {@link listTools}, {@link callTool}, or the low-level
 * {@link request}. Requests are correlated by a monotonically increasing integer
 * id and time out via the injectable timer.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;

  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(transport: McpTransport, opts: McpClientOptions = {}) {
    this.transport = transport;
    this.clientName = opts.clientName ?? "hades";
    this.clientVersion = opts.clientVersion ?? "0.1.0";
    this.timeoutMs = opts.timeoutMs ?? 10000;
    // Bind the ambient timer functions so `this` is not required at call time.
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((t) => clearTimeout(t));

    // Register the SOLE inbound handler, exactly once, in the constructor.
    this.transport.onMessage((msg) => this.handleInbound(msg));
  }

  /**
   * Route an inbound frame to its pending request by id. Notifications (no id)
   * and responses to unknown/expired ids are ignored safely — never throw out of
   * the transport's callback.
   */
  private handleInbound(msg: JsonRpcMessage): void {
    if (msg == null || typeof msg !== "object") return;
    const { id } = msg;
    // Only correlate integer ids we actually issued. Notifications and unknown
    // ids fall through harmlessly.
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    if (entry.timer !== undefined) this.clearTimeoutFn(entry.timer);

    if (msg.error) {
      const { code, message } = msg.error;
      entry.reject(
        new McpProtocolError(
          typeof code === "number" ? code : CODE_TIMEOUT,
          typeof message === "string" ? message : "unknown protocol error",
        ),
      );
      return;
    }
    entry.resolve(msg.result);
  }

  /**
   * Low-level request/response. Assigns the next integer id, sends the frame,
   * and returns a promise that settles when the matching response arrives or the
   * per-request timeout fires (whichever is first).
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new McpProtocolError(CODE_CLOSED, "client is closed"));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.setTimeoutFn(() => {
        // On timeout, drop the pending entry so a late response is ignored.
        if (this.pending.delete(id)) {
          reject(new McpProtocolError(CODE_TIMEOUT, "request timed out"));
        }
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      // Send AFTER registering the pending entry so a synchronous mock response
      // (delivered inside `send`) still finds its correlation slot.
      try {
        const maybe = this.transport.send({ jsonrpc: "2.0", id, method, params });
        // If send is async and rejects, fail the request rather than leak it.
        if (maybe && typeof (maybe as Promise<void>).then === "function") {
          (maybe as Promise<void>).catch((err) => {
            const entry = this.pending.get(id);
            if (entry) {
              this.pending.delete(id);
              if (entry.timer !== undefined) this.clearTimeoutFn(entry.timer);
              entry.reject(
                err instanceof Error
                  ? err
                  : new McpProtocolError(CODE_TIMEOUT, "transport send failed"),
              );
            }
          });
        }
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          if (entry.timer !== undefined) this.clearTimeoutFn(entry.timer);
        }
        reject(
          err instanceof Error
            ? err
            : new McpProtocolError(CODE_TIMEOUT, "transport send failed"),
        );
      }
    });
  }

  /** Emit an id-less JSON-RPC notification (fire-and-forget, no correlation). */
  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    // Notifications carry no id; failures are non-fatal.
    void Promise.resolve(
      this.transport.send({ jsonrpc: "2.0", method, params }),
    ).catch(() => {
      /* notifications are best-effort */
    });
  }

  /**
   * Perform the MCP `initialize` handshake, then emit the required
   * `notifications/initialized` notification. Resolves with the server's
   * declared name/version/capabilities.
   */
  async initialize(): Promise<{
    serverName?: string;
    serverVersion?: string;
    capabilities?: unknown;
  }> {
    const result = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: {},
    })) as
      | {
          serverInfo?: { name?: string; version?: string };
          capabilities?: unknown;
        }
      | undefined;

    // Per MCP, the client confirms readiness with an id-less notification.
    this.notify("notifications/initialized", {});

    return {
      serverName: result?.serverInfo?.name,
      serverVersion: result?.serverInfo?.version,
      capabilities: result?.capabilities,
    };
  }

  /** `tools/list` → the server's advertised tools (defaults to `[]`). */
  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list")) as
      | { tools?: McpToolDef[] }
      | undefined;
    const tools = result?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  /**
   * `tools/call` with `{ name, arguments }`. Normalizes the response to a
   * {@link McpCallResult} (empty content defaults to `[]`).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as { content?: McpContent[]; isError?: boolean } | undefined;
    return {
      content: Array.isArray(result?.content) ? result!.content : [],
      isError: result?.isError,
    };
  }

  /**
   * Reject every pending request and tear down the transport. Idempotent — a
   * second call is a no-op.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) this.clearTimeoutFn(entry.timer);
      entry.reject(new McpProtocolError(CODE_CLOSED, "client closed"));
    }

    this.transport.close?.();
  }
}
