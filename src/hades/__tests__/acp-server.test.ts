import { describe, it, expect } from "vitest";
import { AcpServer } from "../acp/server";
import { InMemoryAcpTransport } from "../acp/transport";
import { ACP_PROTOCOL_VERSION, RpcErrors } from "../acp/types";
import type { AcpPromptHandler } from "../acp/server";
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  SessionNotificationParams,
} from "../acp/types";

/** Minimal ACP test client over the paired transport. */
function makeClient(client: InMemoryAcpTransport) {
  let nextId = 1;
  const pending = new Map<number | string, (r: JsonRpcResponse) => void>();
  const notifications: SessionNotificationParams[] = [];
  client.onMessage((m: JsonRpcMessage) => {
    if ("id" in m && (m as JsonRpcResponse).id !== undefined && !("method" in m)) {
      pending.get((m as JsonRpcResponse).id)?.(m as JsonRpcResponse);
    } else if ("method" in m && m.method === "session/update") {
      notifications.push(m.params as SessionNotificationParams);
    }
  });
  return {
    notifications,
    request(method: string, params?: unknown): Promise<JsonRpcResponse> {
      const id = nextId++;
      return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
        void client.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string, params?: unknown): Promise<void> {
      return client.send({ jsonrpc: "2.0", method, params });
    },
  };
}

const echoHandler: AcpPromptHandler = async (ctx) => {
  const text = ctx.prompt.map((b) => (b.type === "text" ? b.text : "")).join(" ");
  await ctx.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } });
  return { stopReason: "end_turn" };
};

function boot(handler: AcpPromptHandler = echoHandler, opts: Partial<Parameters<typeof AcpServer>[1]> = {}) {
  const [agentSide, clientSide] = InMemoryAcpTransport.pair();
  let n = 0;
  const server = new AcpServer(agentSide, { onPrompt: handler, newSessionId: () => `s${++n}`, now: () => 1, ...opts });
  server.start();
  return { server, client: makeClient(clientSide) };
}

describe("AcpServer", () => {
  it("completes the initialize handshake", async () => {
    const { client } = boot();
    const res = await client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    expect(res.result).toMatchObject({ protocolVersion: ACP_PROTOCOL_VERSION });
    expect((res.result as { agentCapabilities: unknown }).agentCapabilities).toBeDefined();
  });

  it("requires initialize before session/new", async () => {
    const { client } = boot();
    const res = await client.request("session/new", {});
    expect(res.error?.code).toBe(RpcErrors.InvalidRequest);
  });

  it("creates a session and streams updates on prompt", async () => {
    const { server, client } = boot();
    await client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    const created = await client.request("session/new", { cwd: "/repo" });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    expect(sessionId).toBe("s1");

    const res = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(res.result).toEqual({ stopReason: "end_turn" });
    expect(client.notifications).toHaveLength(1);
    expect(client.notifications[0].sessionId).toBe(sessionId);
    expect(client.notifications[0].update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "echo: hello" },
    });
    expect(server.session(sessionId)?.turns).toBe(1);
  });

  it("rejects a prompt for an unknown session", async () => {
    const { client } = boot();
    await client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    const res = await client.request("session/prompt", { sessionId: "nope", prompt: [] });
    expect(res.error?.code).toBe(RpcErrors.InvalidParams);
  });

  it("honors a session/cancel notification mid-prompt", async () => {
    // Handler emits, waits a tick (giving cancel time to land), then checks.
    const handler: AcpPromptHandler = async (ctx) => {
      await ctx.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      await new Promise((r) => setTimeout(r, 5));
      if (ctx.isCancelled()) return { stopReason: "cancelled" };
      return { stopReason: "end_turn" };
    };
    const { client } = boot(handler);
    await client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    const created = await client.request("session/new", {});
    const sessionId = (created.result as { sessionId: string }).sessionId;

    const promptP = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await client.notify("session/cancel", { sessionId });
    const res = await promptP;
    expect(res.result).toEqual({ stopReason: "cancelled" });
  });

  it("returns MethodNotFound for unknown methods", async () => {
    const { client } = boot();
    const res = await client.request("session/teleport", {});
    expect(res.error?.code).toBe(RpcErrors.MethodNotFound);
  });

  it("surfaces handler errors as an internal error", async () => {
    const { client } = boot(async () => {
      throw new Error("handler boom");
    });
    await client.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    const created = await client.request("session/new", {});
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const res = await client.request("session/prompt", { sessionId, prompt: [] });
    expect(res.error?.code).toBe(RpcErrors.InternalError);
    expect(res.error?.message).toContain("handler boom");
  });
});
