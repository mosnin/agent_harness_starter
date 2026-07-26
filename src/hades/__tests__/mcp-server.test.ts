import { describe, it, expect } from "vitest";
import { McpClient, McpProtocolError } from "../mcp/client";
import { McpServer, loopbackTransportPair } from "../mcp/server";
import { builtinRegistry } from "../agent/tools";

/**
 * End-to-end interop suite: every test drives the REAL {@link McpClient} against
 * a REAL {@link McpServer} over an in-process {@link loopbackTransportPair}.
 * Nothing here mocks the protocol — the same JSON-RPC frames that would cross a
 * socket cross the loopback, so a green run proves genuine client<->server
 * interoperability, not just that each half agrees with a hand-rolled stub.
 */
function connect(configure: (server: McpServer) => void, opts?: { serverName?: string }) {
  const pair = loopbackTransportPair();
  const server = new McpServer(pair.server, { serverName: opts?.serverName });
  configure(server);
  server.serve();
  const client = new McpClient(pair.client, { timeoutMs: 1000 });
  return { client, server };
}

describe("McpServer <-> McpClient interop over loopback", () => {
  it("initialize handshake exposes the server name/version", async () => {
    const { client } = connect(() => {}, { serverName: "hades" });
    const info = await client.initialize();
    expect(info.serverName).toBe("hades");
    expect(info.serverVersion).toBe("0.1.0");
    expect(info.capabilities).toEqual({ tools: {} });
  });

  it("tools/list returns registered tools (sorted, with schema)", async () => {
    const { client } = connect((s) => {
      s.register({ name: "zebra", description: "z", run: () => ({ text: "" }) });
      s.register({
        name: "alpha",
        description: "a",
        inputSchema: { type: "object" },
        run: () => ({ text: "" }),
      });
    });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["alpha", "zebra"]);
    expect(tools[0]).toMatchObject({ name: "alpha", description: "a", inputSchema: { type: "object" } });
  });

  it("tools/call runs a tool and returns its text through the client", async () => {
    const { client } = connect((s) => {
      s.register({
        name: "echo",
        run: (args) => ({ text: `hi ${String(args.who)}` }),
      });
    });
    await client.initialize();
    const res = await client.callTool("echo", { who: "hermes" });
    expect(res.content).toEqual([{ type: "text", text: "hi hermes" }]);
    expect(res.isError).toBeUndefined();
  });

  it("supports async tool run functions", async () => {
    const { client } = connect((s) => {
      s.register({
        name: "slow",
        run: async (args) => {
          await Promise.resolve();
          return { text: `done:${String(args.n)}` };
        },
      });
    });
    await client.initialize();
    const res = await client.callTool("slow", { n: 7 });
    expect(res.content[0].text).toBe("done:7");
  });

  it("a tool that flags an error returns isError:true", async () => {
    const { client } = connect((s) => {
      s.register({ name: "boom", run: () => ({ text: "nope", isError: true }) });
    });
    await client.initialize();
    const res = await client.callTool("boom", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("nope");
  });

  it("a tool that throws is surfaced as a tool-level error result (not a protocol crash)", async () => {
    const { client } = connect((s) => {
      s.register({
        name: "throws",
        run: () => {
          throw new Error("kaboom");
        },
      });
    });
    await client.initialize();
    const res = await client.callTool("throws", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("kaboom");
  });

  it("calling an unknown tool returns isError:true, not a protocol error", async () => {
    const { client } = connect(() => {});
    await client.initialize();
    const res = await client.callTool("nope", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown tool: nope");
  });

  it("an unknown method rejects with McpProtocolError -32601", async () => {
    const { client } = connect(() => {});
    await client.initialize();
    await expect(client.request("does/not/exist")).rejects.toMatchObject({
      name: "McpProtocolError",
      code: -32601,
    });
    await expect(client.request("does/not/exist")).rejects.toBeInstanceOf(McpProtocolError);
  });

  it("malformed tools/call params reject with McpProtocolError -32602", async () => {
    const { client } = connect((s) => {
      s.register({ name: "x", run: () => ({ text: "" }) });
    });
    await client.initialize();
    // Missing `name` in params.
    await expect(client.request("tools/call", { arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("registerToolRegistry exposes a builtinRegistry() and a real calc call returns '5'", async () => {
    const { client } = connect((s) => {
      s.registerToolRegistry(builtinRegistry());
    });
    await client.initialize();

    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("calc");
    expect(names).toContain("uppercase");

    const calc = await client.callTool("calc", { input: "2+3" });
    expect(calc.content[0].text).toBe("5");
    expect(calc.isError).toBeUndefined();

    // A failing Hades tool result maps to isError:true across the wire.
    const bad = await client.callTool("calc", { input: "1/0" });
    expect(bad.isError).toBe(true);
  });

  it("notifications (id-less frames like notifications/initialized) are accepted silently", async () => {
    const { client } = connect((s) => {
      s.register({ name: "ping", run: () => ({ text: "pong" }) });
    });
    // initialize() itself fires notifications/initialized; if the server replied
    // to it, that stray frame would not derail subsequent correlated requests.
    await client.initialize();
    // Still fully functional afterward.
    const res = await client.callTool("ping", {});
    expect(res.content[0].text).toBe("pong");
  });
});
