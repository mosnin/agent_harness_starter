/**
 * The **HTTP transport** for the MCP client: one JSON-RPC request per HTTP
 * POST, against an MCP "Streamable HTTP" endpoint.
 *
 * WHY THIS EXISTS. Stdio covers locally-spawned servers, which is most of the
 * ecosystem, but a growing share of MCP servers are hosted endpoints. Since the
 * whole point of speaking MCP is inheriting tools we did not write
 * (`.plans/HADES_BEYOND_HERMES.md`, Phase 1), leaving hosted servers out would
 * leave a chunk of that inheritance on the table.
 *
 * WHAT THIS SUPPORTS — AND, HONESTLY, WHAT IT DOES NOT.
 *  - Supported: the request/response half of Streamable HTTP. Every client
 *    request is POSTed; the response body is parsed either as a single JSON-RPC
 *    frame (`application/json`) or as an SSE payload whose `data:` lines each
 *    carry one frame (which is how many servers answer a single POST).
 *    `Mcp-Session-Id` is captured from the first response and echoed on every
 *    later request, so session-scoped servers work.
 *  - NOT supported: the long-lived server->client stream (the separate `GET`
 *    that stays open for server-initiated requests/notifications). Doing that
 *    honestly needs a streaming reader; the {@link McpFetchLike} seam this
 *    module is built on buffers a whole body. A server that requires that
 *    channel will fail LOUDLY here (its POST either errors or never returns a
 *    parsable frame, and the client's request times out) rather than appearing
 *    to work. It is deliberately never silently degraded.
 *
 * Every byte goes through the injected {@link McpFetchLike}, never a reached-for
 * global `fetch`, so this transport is fully testable in-process — the tests
 * point it at a real in-process {@link McpServer} through a fake fetch and get
 * genuine protocol traffic with no network.
 */

import { McpProtocolError, type JsonRpcMessage, type McpTransport } from "./client";
import { MCP_TRANSPORT_ERROR_CODE } from "./stdio-transport";

/**
 * The narrow fetch shape this transport needs. Structurally identical to
 * `tools/catalog.ts`'s `FetchLike` and deliberately re-declared here rather
 * than imported: `mcp/` is the lower layer and must not depend on `tools/`
 * (the dependency runs the other way — the tool catalog mounts MCP servers).
 */
export type McpFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

export interface HttpTransportOptions {
  /** Endpoint URL of the MCP server. */
  url: string;
  /** The fetch implementation. Required — there is no global fallback. */
  fetchFn: McpFetchLike;
  /** Extra request headers (e.g. Authorization). Values are never logged. */
  headers?: Record<string, string>;
}

/** Case-insensitive header lookup (fetch impls differ on key casing). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Pull JSON-RPC frames out of a response body. Accepts a bare JSON object, a
 * JSON array (batch), or an SSE stream whose `data:` lines each hold a frame.
 * Returns `[]` when nothing parsable is present — the caller decides whether
 * that is an error (it is, for a request; it is not, for a notification).
 */
export function parseHttpFrames(body: string): JsonRpcMessage[] {
  const text = body.trim();
  if (text === "") return [];

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((f): f is JsonRpcMessage => f !== null && typeof f === "object");
    }
    if (parsed !== null && typeof parsed === "object") return [parsed as JsonRpcMessage];
    return [];
  } catch {
    // Not plain JSON: try SSE framing (`event:`/`data:` lines).
  }

  const frames: JsonRpcMessage[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (parsed !== null && typeof parsed === "object") frames.push(parsed as JsonRpcMessage);
    } catch {
      /* a non-JSON data line is not a frame */
    }
  }
  return frames;
}

/**
 * An {@link McpTransport} that POSTs each outbound frame and dispatches the
 * frames found in the response body. `send` returns a promise; the client
 * rejects the corresponding request if it rejects, so an HTTP 401/404/500 (or
 * an unparsable body) becomes an honest per-request failure instead of a hang.
 */
export class HttpMcpTransport implements McpTransport {
  private readonly url: string;
  private readonly fetchFn: McpFetchLike;
  private readonly baseHeaders: Record<string, string>;

  private handler: ((msg: JsonRpcMessage) => void) | undefined;
  private sessionId: string | undefined;
  private closed = false;

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.fetchFn = opts.fetchFn;
    this.baseHeaders = { ...(opts.headers ?? {}) };
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new McpProtocolError(MCP_TRANSPORT_ERROR_CODE, "transport is closed");
    }

    const isNotification = msg.id === undefined;
    const headers: Record<string, string> = {
      ...this.baseHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
    };

    let response: { status: number; headers: Record<string, string>; text(): Promise<string> };
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
      });
    } catch (err) {
      throw new McpProtocolError(
        MCP_TRANSPORT_ERROR_CODE,
        `POST ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const session = headerValue(response.headers ?? {}, "mcp-session-id");
    if (session !== undefined && session !== "") this.sessionId = session;

    const body = await response.text().catch(() => "");

    if (response.status >= 400) {
      throw new McpProtocolError(
        MCP_TRANSPORT_ERROR_CODE,
        `POST ${this.url} returned HTTP ${response.status}${
          body.trim() === "" ? "" : `: ${body.trim().slice(0, 300)}`
        }`
      );
    }

    const frames = parseHttpFrames(body);
    if (frames.length === 0) {
      // A notification legitimately gets an empty 202. A REQUEST with no frame
      // in the body means the server answers on a channel this transport does
      // not hold open — say so, rather than leaving the caller to time out.
      if (isNotification) return;
      throw new McpProtocolError(
        MCP_TRANSPORT_ERROR_CODE,
        `POST ${this.url} returned HTTP ${response.status} with no JSON-RPC frame in the body ` +
          "(this transport does not hold the server->client SSE stream open, so a server that " +
          "answers only on that channel is not supported)"
      );
    }

    const handler = this.handler;
    if (!handler) return;
    for (const frame of frames) {
      try {
        handler(frame);
      } catch {
        /* the client's inbound handler is documented never to throw */
      }
    }
  }

  close(): void {
    this.closed = true;
  }
}
