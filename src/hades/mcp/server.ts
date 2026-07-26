/**
 * A real **Model Context Protocol (MCP) server** — the mirror image of the
 * client in {@link file://./client.ts}. Where the client lets Hades *consume*
 * any MCP tool server, this server lets Hades *become* one: other agents
 * (Claude, Hermes, or any MCP client) speak JSON-RPC 2.0 to it over an injected
 * {@link McpTransport} and gain access to Hades' registered tools and skills.
 *
 * Like the client, it is deterministic and side-effect-free at the boundary:
 * every byte flows through the transport, there is no network, subprocess,
 * clock, or randomness. It is exercised in-process against the *real*
 * {@link McpClient} via {@link loopbackTransportPair}, which wires a client-side
 * and server-side transport back to back.
 *
 * Protocol shape (matched exactly to the client):
 *  - `initialize`  → `{ protocolVersion, serverInfo:{name,version}, capabilities:{tools:{}} }`
 *  - `tools/list`  → `{ tools: McpToolDef[] }`
 *  - `tools/call`  → `{ content:[{type:"text",text}], isError? }`
 *  - unknown method → JSON-RPC error `-32601` (method not found)
 *  - malformed `tools/call` params → JSON-RPC error `-32602` (invalid params)
 *  - unknown tool in a *well-formed* `tools/call` → a normal result with
 *    `isError:true` (so the caller sees the failure as tool output, matching the
 *    MCP convention that tool-level errors are results, not protocol errors)
 *  - notifications (a frame with a `method` but no `id`, e.g.
 *    `notifications/initialized`) are accepted silently with no reply.
 *
 * The handler NEVER throws out of the transport callback: any internal failure
 * is converted into a JSON-RPC error response (or swallowed for notifications).
 */

import type { McpTransport, McpToolDef, JsonRpcMessage } from "./client";

/** MCP protocol version this server advertises in `initialize`. */
const PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC standard error codes used by the server. */
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL_ERROR = -32603;

/**
 * A tool other agents can invoke through `tools/call`. `run` receives the
 * decoded `arguments` object and returns text (optionally flagged as an error);
 * it may be sync or async.
 */
export interface McpServerTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  run: (
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError?: boolean }> | { text: string; isError?: boolean };
}

export interface McpServerOptions {
  serverName?: string; // default "hades"
  serverVersion?: string; // default "0.1.0"
}

/** The input schema advertised for tools adapted from a Hades `ToolRegistry`. */
const REGISTRY_TOOL_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string", description: "The raw string input passed to the Hades tool." },
  },
  required: ["input"],
} as const;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The MCP server. Construct with a transport (and optional name/version),
 * register tools (directly or by adapting a Hades {@link ToolRegistry}), then
 * call {@link serve} to begin handling inbound JSON-RPC frames.
 */
export class McpServer {
  private readonly transport: McpTransport;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly registry = new Map<string, McpServerTool>();
  private serving = false;

  constructor(transport: McpTransport, opts: McpServerOptions = {}) {
    this.transport = transport;
    this.serverName = opts.serverName ?? "hades";
    this.serverVersion = opts.serverVersion ?? "0.1.0";
  }

  /** Register a tool other agents can call. Later registrations override earlier. */
  register(tool: McpServerTool): void {
    this.registry.set(tool.name, tool);
  }

  /**
   * Adapt a Hades {@link ToolRegistry}: expose each `Tool` as an MCP tool whose
   * single `input` string argument is threaded straight through to the tool.
   * The Hades `{ ok, output }` shape maps to `{ text: output, isError: !ok }`.
   */
  registerToolRegistry(registry: {
    list(): Array<{ name: string; description: string }>;
    run(call: { tool: string; input: string }): Promise<{ ok: boolean; output: string }>;
  }): void {
    for (const def of registry.list()) {
      const name = def.name;
      this.register({
        name,
        description: def.description,
        inputSchema: REGISTRY_TOOL_SCHEMA,
        run: async (args) => {
          // The MCP contract passes tool inputs as `args.input` (a string).
          const raw = args?.input;
          const input = typeof raw === "string" ? raw : raw === undefined ? "" : String(raw);
          const res = await registry.run({ tool: name, input });
          return { text: res.output, isError: !res.ok };
        },
      });
    }
  }

  /** The advertised tool definitions, sorted by name for determinism. */
  tools(): McpToolDef[] {
    return [...this.registry.values()]
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Begin serving: wires `transport.onMessage` to the JSON-RPC handler. */
  serve(): void {
    if (this.serving) return;
    this.serving = true;
    this.transport.onMessage((msg) => {
      // Never let a handler rejection escape the transport callback.
      void this.handleInbound(msg).catch(() => {
        /* swallowed — handleInbound already converts failures to error frames */
      });
    });
  }

  /**
   * Route one inbound frame. Requests (have an `id`) get exactly one response;
   * notifications (a `method` but no `id`) are accepted silently; anything else
   * (a stray response, garbage) is ignored.
   */
  private async handleInbound(msg: JsonRpcMessage): Promise<void> {
    if (msg == null || typeof msg !== "object") return;

    const { id, method } = msg;
    const hasId = id !== undefined && id !== null;

    // A frame with a method but no id is a notification — accept, do not reply.
    if (typeof method === "string" && !hasId) return;

    // Without an id we cannot correlate a response, and without a method there
    // is nothing to dispatch: ignore stray/garbage frames rather than reply.
    if (!hasId) return;
    if (typeof method !== "string") {
      this.sendError(id!, CODE_INVALID_PARAMS, "missing method");
      return;
    }

    try {
      switch (method) {
        case "initialize":
          this.sendResult(id!, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: this.serverName, version: this.serverVersion },
            capabilities: { tools: {} },
          });
          return;

        case "tools/list":
          this.sendResult(id!, { tools: this.tools() });
          return;

        case "tools/call":
          await this.handleToolsCall(id!, msg.params);
          return;

        default:
          this.sendError(id!, CODE_METHOD_NOT_FOUND, `method not found: ${method}`);
          return;
      }
    } catch (err) {
      // Defensive: any unexpected throw becomes a protocol error, not a crash.
      this.sendError(id!, CODE_INTERNAL_ERROR, messageOf(err));
    }
  }

  /** Handle a `tools/call` request: validate params, run the tool, reply. */
  private async handleToolsCall(id: number | string, params: unknown): Promise<void> {
    if (params == null || typeof params !== "object" || Array.isArray(params)) {
      this.sendError(id, CODE_INVALID_PARAMS, "invalid params: expected an object");
      return;
    }
    const p = params as { name?: unknown; arguments?: unknown };
    if (typeof p.name !== "string") {
      this.sendError(id, CODE_INVALID_PARAMS, "invalid params: 'name' must be a string");
      return;
    }

    // `arguments` is optional; when present it must be a plain object.
    let args: Record<string, unknown> = {};
    if (p.arguments !== undefined && p.arguments !== null) {
      if (typeof p.arguments !== "object" || Array.isArray(p.arguments)) {
        this.sendError(id, CODE_INVALID_PARAMS, "invalid params: 'arguments' must be an object");
        return;
      }
      args = p.arguments as Record<string, unknown>;
    }

    const tool = this.registry.get(p.name);
    if (!tool) {
      // Unknown-tool is a tool-level failure, surfaced as a result (isError), so
      // the caller reads it as tool output rather than a transport error.
      this.sendResult(id, {
        content: [{ type: "text", text: `unknown tool: ${p.name}` }],
        isError: true,
      });
      return;
    }

    try {
      const res = await tool.run(args);
      this.sendResult(id, {
        content: [{ type: "text", text: res.text }],
        isError: res.isError === true ? true : undefined,
      });
    } catch (err) {
      // A tool that throws is also a tool-level failure, not a protocol one.
      this.sendResult(id, {
        content: [{ type: "text", text: `error: ${messageOf(err)}` }],
        isError: true,
      });
    }
  }

  private sendResult(id: number | string, result: unknown): void {
    this.safeSend({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.safeSend({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Send, swallowing transport failures so a broken channel cannot crash us. */
  private safeSend(msg: JsonRpcMessage): void {
    try {
      const maybe = this.transport.send(msg);
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        (maybe as Promise<void>).catch(() => {
          /* best-effort: outbound send failed */
        });
      }
    } catch {
      /* best-effort: transport.send threw synchronously */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Loopback transport pair
 * ------------------------------------------------------------------ */

/**
 * One end of an in-process, back-to-back transport link. Frames sent on this
 * endpoint are delivered to the peer's inbound handler. If the peer has not yet
 * registered a handler, frames are buffered and flushed on registration, so the
 * client and server can be constructed in either order.
 */
class LoopbackEndpoint implements McpTransport {
  peer!: LoopbackEndpoint;
  private handler: ((msg: JsonRpcMessage) => void) | undefined;
  private inbox: JsonRpcMessage[] = [];
  private closed = false;

  send(msg: JsonRpcMessage): void {
    if (this.closed) return;
    this.peer.receive(msg);
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.handler = handler;
    const buffered = this.inbox;
    this.inbox = [];
    for (const m of buffered) this.dispatch(m);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  /** Receive a frame from the peer's `send`. */
  private receive(msg: JsonRpcMessage): void {
    if (this.closed) return;
    if (this.handler) this.dispatch(msg);
    else this.inbox.push(msg);
  }

  /** Invoke the registered handler, isolating its faults from the sender. */
  private dispatch(msg: JsonRpcMessage): void {
    try {
      this.handler?.(msg);
    } catch {
      /* an endpoint handler must never break its peer's send() */
    }
  }
}

/**
 * A loopback transport PAIR wiring a client transport to a server transport
 * in-process. Use it to embed an {@link McpServer} inside the same process as an
 * {@link McpClient} (for tests and local composition):
 *
 * ```ts
 * const pair = loopbackTransportPair();
 * const server = new McpServer(pair.server); server.register(...); server.serve();
 * const client = new McpClient(pair.client); await client.initialize();
 * ```
 */
export function loopbackTransportPair(): { client: McpTransport; server: McpTransport } {
  const client = new LoopbackEndpoint();
  const server = new LoopbackEndpoint();
  client.peer = server;
  server.peer = client;
  return { client, server };
}
