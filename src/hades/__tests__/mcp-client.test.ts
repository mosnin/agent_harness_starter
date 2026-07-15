import { describe, it, expect } from "vitest";
import {
  McpClient,
  McpProtocolError,
  type JsonRpcMessage,
  type McpTransport,
} from "../mcp/client";

/* ------------------------------------------------------------------ *
 * In-process mock MCP server. The TEST plays the server: every frame  *
 * the client sends is captured in `sent`, and the test hand-crafts    *
 * responses which it delivers by invoking the client's registered     *
 * inbound handler. No subprocess, no network, no keys — pure objects.  *
 * ------------------------------------------------------------------ */
class MockTransport implements McpTransport {
  sent: JsonRpcMessage[] = [];
  closed = false;
  private handler: ((msg: JsonRpcMessage) => void) | undefined;
  onMessageCalls = 0;
  /** Optional hook: when set, runs synchronously inside `send`. */
  onSend?: (msg: JsonRpcMessage, t: MockTransport) => void;

  send(msg: JsonRpcMessage): void {
    this.sent.push(msg);
    this.onSend?.(msg, this);
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): void {
    this.onMessageCalls++;
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }

  /** Deliver an inbound frame from the "server" to the client. */
  deliver(msg: JsonRpcMessage): void {
    if (!this.handler) throw new Error("no handler registered");
    this.handler(msg);
  }

  /** The most recent request frame carrying the given method. */
  lastOf(method: string): JsonRpcMessage | undefined {
    return [...this.sent].reverse().find((m) => m.method === method);
  }
}

/**
 * A manual clock so timeouts are deterministic: the client's injected
 * setTimeout registers callbacks here, and the test fires them explicitly.
 */
function fakeClock() {
  let seq = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeoutFn: (cb: () => void, _ms: number) => {
      const id = seq++;
      timers.set(id, cb);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => {
      timers.delete(t as unknown as number);
    },
    /** Fire every currently-registered timer (simulating time elapsing). */
    fireAll: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
    pendingCount: () => timers.size,
  };
}

function makeClient(extra?: Partial<Parameters<typeof McpClient>[1]>) {
  const transport = new MockTransport();
  const clock = fakeClock();
  const client = new McpClient(transport, {
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...extra,
  });
  return { transport, clock, client };
}

describe("McpClient", () => {
  it("registers its inbound handler exactly once in the constructor", () => {
    const { transport } = makeClient();
    expect(transport.onMessageCalls).toBe(1);
  });

  it("initialize sends correct params, parses serverInfo, emits initialized notification", async () => {
    const { transport, client } = makeClient({
      clientName: "hades",
      clientVersion: "0.1.0",
    });

    // Server answers the initialize request synchronously on send.
    transport.onSend = (msg, t) => {
      if (msg.method === "initialize" && msg.id !== undefined) {
        t.deliver({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "mock-server", version: "9.9.9" },
            capabilities: { tools: {} },
          },
        });
      }
    };

    const info = await client.initialize();

    const init = transport.lastOf("initialize")!;
    expect(init.jsonrpc).toBe("2.0");
    expect(typeof init.id).toBe("number");
    expect(init.params).toMatchObject({
      protocolVersion: "2024-11-05",
      clientInfo: { name: "hades", version: "0.1.0" },
      capabilities: {},
    });

    expect(info.serverName).toBe("mock-server");
    expect(info.serverVersion).toBe("9.9.9");
    expect(info.capabilities).toEqual({ tools: {} });

    // The id-less `notifications/initialized` must follow the handshake.
    const note = transport.lastOf("notifications/initialized");
    expect(note).toBeDefined();
    expect(note!.id).toBeUndefined();
  });

  it("listTools returns the server's tools, and defaults to [] when absent", async () => {
    const { transport, client } = makeClient();

    transport.onSend = (msg, t) => {
      if (msg.method === "tools/list") {
        t.deliver({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [
              { name: "echo", description: "echoes", inputSchema: { type: "object" } },
              { name: "add" },
            ],
          },
        });
      }
    };

    const tools = await client.listTools();
    expect(transport.lastOf("tools/list")!.method).toBe("tools/list");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: "echo",
      description: "echoes",
      inputSchema: { type: "object" },
    });

    // Now a server that omits `tools` entirely → [].
    const c2 = makeClient();
    c2.transport.onSend = (msg, t) => {
      if (msg.method === "tools/list") {
        t.deliver({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    };
    expect(await c2.client.listTools()).toEqual([]);
  });

  it("callTool round-trips arguments and parses content + isError", async () => {
    const { transport, client } = makeClient();

    transport.onSend = (msg, t) => {
      if (msg.method === "tools/call") {
        // Echo the arguments back inside the content to prove round-trip.
        const p = msg.params as { name: string; arguments: Record<string, unknown> };
        t.deliver({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(p.arguments) }],
            isError: true,
          },
        });
      }
    };

    const res = await client.callTool("search", { query: "mcp", limit: 3 });

    const call = transport.lastOf("tools/call")!;
    expect(call.params).toEqual({
      name: "search",
      arguments: { query: "mcp", limit: 3 },
    });

    expect(res.content).toEqual([
      { type: "text", text: JSON.stringify({ query: "mcp", limit: 3 }) },
    ]);
    expect(res.isError).toBe(true);
  });

  it("callTool defaults content to [] when the server omits it", async () => {
    const { transport, client } = makeClient();
    transport.onSend = (msg, t) => {
      if (msg.method === "tools/call") {
        t.deliver({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    };
    const res = await client.callTool("noop", {});
    expect(res.content).toEqual([]);
    expect(res.isError).toBeUndefined();
  });

  it("a server error response rejects with McpProtocolError carrying the code", async () => {
    const { transport, client } = makeClient();
    transport.onSend = (msg, t) => {
      t.deliver({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
    };

    await expect(client.request("tools/list")).rejects.toMatchObject({
      name: "McpProtocolError",
      code: -32601,
      message: "Method not found",
    });
    await expect(client.request("tools/list")).rejects.toBeInstanceOf(
      McpProtocolError,
    );
  });

  it("a request times out via the injected timer → McpProtocolError(-32000)", async () => {
    const { client, clock } = makeClient();

    const p = client.request("tools/list"); // no response will arrive
    expect(clock.pendingCount()).toBe(1);

    clock.fireAll(); // simulate the timeout elapsing

    await expect(p).rejects.toMatchObject({
      code: -32000,
      message: "request timed out",
    });
  });

  it("correlates out-of-order responses (id 2 answered before id 1)", async () => {
    const { transport, client } = makeClient();

    const p1 = client.request("m1");
    const p2 = client.request("m2");

    const id1 = transport.sent[0].id!;
    const id2 = transport.sent[1].id!;
    expect(id1).not.toBe(id2);

    // Answer the SECOND request first, then the first.
    transport.deliver({ jsonrpc: "2.0", id: id2, result: { v: "two" } });
    transport.deliver({ jsonrpc: "2.0", id: id1, result: { v: "one" } });

    expect(await p1).toEqual({ v: "one" });
    expect(await p2).toEqual({ v: "two" });
  });

  it("ignores inbound frames with unknown ids and id-less notifications", async () => {
    const { transport, client } = makeClient();
    const p = client.request("m1");
    const id = transport.sent[0].id!;

    // Noise: unknown id, and a notification without id — both harmless.
    transport.deliver({ jsonrpc: "2.0", id: 99999, result: { junk: true } });
    transport.deliver({ jsonrpc: "2.0", method: "notifications/progress" });

    // The real response still resolves the pending request.
    transport.deliver({ jsonrpc: "2.0", id, result: { ok: 1 } });
    expect(await p).toEqual({ ok: 1 });
  });

  it("close() rejects all pending requests and closes the transport", async () => {
    const { transport, client } = makeClient();
    const p1 = client.request("a");
    const p2 = client.request("b");

    client.close();

    await expect(p1).rejects.toBeInstanceOf(McpProtocolError);
    await expect(p2).rejects.toMatchObject({ code: -32001 });
    expect(transport.closed).toBe(true);

    // Requests after close reject immediately without touching the transport.
    const before = transport.sent.length;
    await expect(client.request("c")).rejects.toBeInstanceOf(McpProtocolError);
    expect(transport.sent.length).toBe(before);
  });

  it("assigns monotonically increasing integer ids", async () => {
    const { transport, client } = makeClient();
    client.request("a");
    client.request("b");
    client.request("c");
    const ids = transport.sent.map((m) => m.id as number);
    expect(ids).toEqual([1, 2, 3]);
  });
});
