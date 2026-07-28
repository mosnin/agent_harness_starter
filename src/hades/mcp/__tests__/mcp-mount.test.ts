/**
 * Mounting an external MCP server, proved against a REAL server process.
 *
 * The point of this suite is that nothing here is a stand-in for the thing
 * being tested. `scripts/mcp-echo-server.mjs` is a genuine stdio MCP server; it
 * is spawned as a genuine subprocess by the shipped `realStdioSpawn`, spoken to
 * by the shipped `McpClient`, and its answers are the answers asserted on. The
 * failure paths are real too: a command that does not exist, a server that
 * exits during the handshake, a server that never replies. No network, no key,
 * no fixture pretending to be a server.
 *
 * The transport unit tests at the top use a fake child handle on purpose —
 * chunk-boundary framing and "the process died" are easier to drive by hand
 * than by racing a real process, and the real-process tests below cover the
 * same code paths end to end.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { McpClient, type JsonRpcMessage, type McpTransport } from "../client";
import { McpServer } from "../server";
import { HttpMcpTransport, parseHttpFrames, type McpFetchLike } from "../http-transport";
import {
  callMcpServerTool,
  declaredEnvKeys,
  describeMcpEndpoint,
  listMcpServerTools,
  unmetEnvRequirements,
  type McpServerSpec,
  type McpStdioServerSpec,
} from "../mount";
import {
  StdioMcpTransport,
  realStdioSpawn,
  type StdioProcessHandle,
  type StdioSpawnLike,
} from "../stdio-transport";

const ECHO_SERVER = fileURLToPath(new URL("../../../../scripts/mcp-echo-server.mjs", import.meta.url));

/** A stdio spec pointing at the real in-repo echo server. */
function echoSpec(extraArgs: string[] = [], overrides: Partial<McpStdioServerSpec> = {}): McpStdioServerSpec {
  return {
    name: "echo",
    transport: "stdio",
    command: process.execPath,
    args: [ECHO_SERVER, ...extraArgs],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Transport: framing and death, driven by a fake child
 * ------------------------------------------------------------------ */

class FakeChild implements StdioProcessHandle {
  readonly written: string[] = [];
  killCount = 0;
  private stdoutCb: ((chunk: string) => void) | undefined;
  private stderrCb: ((chunk: string) => void) | undefined;
  private exitCb: ((code: number | null, signal: string | null) => void) | undefined;
  private errorCb: ((err: Error) => void) | undefined;
  writeThrows: string | undefined;

  write(frame: string): void {
    if (this.writeThrows !== undefined) throw new Error(this.writeThrows);
    this.written.push(frame);
  }
  onStdout(cb: (chunk: string) => void): void {
    this.stdoutCb = cb;
  }
  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb;
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  kill(): void {
    this.killCount += 1;
  }

  emitStdout(chunk: string): void {
    this.stdoutCb?.(chunk);
  }
  emitStderr(chunk: string): void {
    this.stderrCb?.(chunk);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    this.exitCb?.(code, signal);
  }
  emitError(err: Error): void {
    this.errorCb?.(err);
  }
}

describe("StdioMcpTransport framing", () => {
  it("reassembles a frame split across chunk boundaries", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    const seen: JsonRpcMessage[] = [];
    transport.onMessage((msg) => seen.push(msg));

    child.emitStdout('{"jsonrpc":"2.0",');
    expect(seen).toHaveLength(0);
    child.emitStdout('"id":1,"result":{"ok":true}}\n');

    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("splits several frames arriving in one chunk", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    const seen: JsonRpcMessage[] = [];
    transport.onMessage((msg) => seen.push(msg));

    child.emitStdout('{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":2}\n');
    expect(seen.map((m) => m.id)).toEqual([1, 2]);
  });

  it("keeps non-JSON stdout as diagnosable noise instead of dispatching or throwing", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    const seen: JsonRpcMessage[] = [];
    transport.onMessage((msg) => seen.push(msg));

    child.emitStdout("starting up, one moment\n");
    child.emitStdout('{"jsonrpc":"2.0","id":7,"result":{}}\n');

    expect(seen.map((m) => m.id)).toEqual([7]);
    expect(transport.noiseLines()).toEqual(["starting up, one moment"]);
  });

  it("a dead child is announced through onFatal and every later send throws", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    const reasons: string[] = [];
    transport.onFatal((reason) => reasons.push(reason));

    child.emitStderr("boom: missing config\n");
    child.emitExit(2);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("exit code 2");
    expect(transport.failure).toContain("exit code 2");
    expect(transport.stderrTail()).toBe("boom: missing config");
    expect(() => transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).toThrow(/exit code 2/);
  });

  it("a fatal listener registered after the death still fires (it cannot miss it)", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    child.emitError(new Error("spawn nope ENOENT"));

    const reasons: string[] = [];
    transport.onFatal((reason) => reasons.push(reason));
    expect(reasons[0]).toContain("ENOENT");
  });

  it("an INTENTIONAL close is not reported as a failure when the child then exits", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    const reasons: string[] = [];
    transport.onFatal((reason) => reasons.push(reason));

    transport.close();
    child.emitExit(0);

    expect(reasons).toEqual([]);
    expect(transport.failure).toBeUndefined();
    expect(child.killCount).toBe(1);
  });

  it("refuses to buffer an unbounded un-terminated frame, and says why", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child, { maxFrameBytes: 64 });
    const reasons: string[] = [];
    transport.onFatal((reason) => reasons.push(reason));

    child.emitStdout("x".repeat(100)); // no newline, ever
    expect(reasons[0]).toContain("without a newline-terminated frame");
  });

  it("a failing stdin write becomes a transport failure, not a silent drop", () => {
    const child = new FakeChild();
    const transport = new StdioMcpTransport(child);
    child.writeThrows = "EPIPE";
    expect(() => transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).toThrow(/EPIPE/);
    expect(transport.failure).toContain("EPIPE");
  });
});

/* ------------------------------------------------------------------ *
 * The real thing: a spawned MCP server process
 * ------------------------------------------------------------------ */

describe("mounting a real stdio MCP server (spawned subprocess)", () => {
  it("lists the server's tools and identity", async () => {
    const result = await listMcpServerTools(echoSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools.map((t) => t.name).sort()).toEqual(["echo", "sum", "upper"]);
    expect(result.server).toEqual({ name: "hades-echo-mcp", version: "0.1.0" });
    // The schema comes back intact — it is what the catalog turns into an
    // argument hint for the model.
    const sum = result.tools.find((t) => t.name === "sum");
    expect(sum?.inputSchema).toMatchObject({ type: "object", required: ["a", "b"] });
  });

  it("calls a tool and returns the server's REAL answer", async () => {
    const upper = await callMcpServerTool(echoSpec(), "upper", { text: "inherited" });
    expect(upper).toMatchObject({ ok: true, isError: false, text: "INHERITED" });

    const sum = await callMcpServerTool(echoSpec(), "sum", { a: 19, b: 23 });
    expect(sum).toMatchObject({ ok: true, isError: false, text: "42" });
  });

  it("a tool-level failure is a SUCCESSFUL call carrying isError, not a connection failure", async () => {
    const result = await callMcpServerTool(echoSpec(["--fail-tool"]), "echo", { text: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("deliberately failed");
  });

  it("an unknown tool comes back as the server's own isError result", async () => {
    const result = await callMcpServerTool(echoSpec(), "no_such_tool", {});
    expect(result).toMatchObject({ ok: true, isError: true });
    if (!result.ok) return;
    expect(result.text).toContain("unknown tool");
  });

  it("a server that prints a non-JSON banner still works", async () => {
    const result = await listMcpServerTools(echoSpec(["--noise"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools).toHaveLength(3);
  });

  it("a command that does not exist fails honestly — named, diagnosed, never mocked", async () => {
    const spec: McpServerSpec = {
      name: "ghost",
      transport: "stdio",
      command: "/nonexistent/definitely-not-an-mcp-server",
      args: [],
    };
    const result = await listMcpServerTools(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('MCP server "ghost"');
    expect(result.error).toContain("/nonexistent/definitely-not-an-mcp-server");
    expect(result.error).toMatch(/ENOENT|could not be started/);
    // The honesty property: no fabricated tool list came back with it.
    expect(result).not.toHaveProperty("tools");
  });

  it("a server that dies during the handshake quotes its own stderr", async () => {
    const result = await listMcpServerTools(echoSpec(["--crash"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("the server process ended");
    expect(result.error).toContain("exit code 3");
    expect(result.error).toContain("refusing to start (--crash)");
  });

  it("a wedged server fails on the request timeout instead of hanging forever", async () => {
    const started = Date.now();
    const result = await listMcpServerTools(echoSpec(["--hang"], { timeoutMs: 400 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("an unmet env requirement is reported BY NAME and nothing is ever spawned", async () => {
    let spawns = 0;
    const countingSpawn: StdioSpawnLike = (cmd, args, opts) => {
      spawns += 1;
      return realStdioSpawn()(cmd, args, opts);
    };
    const spec = echoSpec([], { requiresEnv: ["ACME_MCP_TOKEN"] });
    const result = await listMcpServerTools(spec, { env: {}, spawnStdio: countingSpawn });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("unmet requirement");
    expect(result.error).toContain("ACME_MCP_TOKEN");
    expect(spawns).toBe(0);
  });

  it("a met env requirement lets the same mount through", async () => {
    const spec = echoSpec([], { requiresEnv: ["ACME_MCP_TOKEN"] });
    const result = await listMcpServerTools(spec, { env: { ACME_MCP_TOKEN: "s3cret" } });
    expect(result.ok).toBe(true);
    // And the requirement is discoverable by NAME for the catalog's KEYS column.
    expect(declaredEnvKeys(spec)).toEqual(["ACME_MCP_TOKEN"]);
  });

  it("describeMcpEndpoint prints the endpoint and never an env value", () => {
    expect(describeMcpEndpoint(echoSpec())).toContain("stdio: ");
    const http: McpServerSpec = {
      name: "hosted",
      transport: "http",
      url: "https://example.invalid/mcp",
      headerEnv: { Authorization: "ACME_TOKEN" },
    };
    const described = describeMcpEndpoint(http);
    expect(described).toBe("http: https://example.invalid/mcp");
    expect(described).not.toContain("ACME_TOKEN");
    expect(unmetEnvRequirements(http, {})).toEqual(["ACME_TOKEN"]);
    expect(unmetEnvRequirements(http, { ACME_TOKEN: "v" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The HTTP transport, against a real in-process McpServer
 * ------------------------------------------------------------------ */

/** Wire a real {@link McpServer} behind a fetch-shaped function. No network. */
function fetchBackedByRealServer(opts: {
  status?: number;
  body?: string;
  sse?: boolean;
  onRequest?: () => void;
} = {}): { fetchFn: McpFetchLike; calls: number } {
  let outbound: JsonRpcMessage[] = [];
  let inbound: ((msg: JsonRpcMessage) => void) | undefined;

  const serverTransport: McpTransport = {
    send: (msg) => {
      outbound.push(msg);
    },
    onMessage: (handler) => {
      inbound = handler;
    },
  };
  const server = new McpServer(serverTransport, { serverName: "hosted-mcp", serverVersion: "9.9.9" });
  server.register({
    name: "shout",
    description: "Uppercase text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (args) => ({ text: String(args.text ?? "").toUpperCase() }),
  });
  server.serve();

  const state = { calls: 0 };
  const fetchFn: McpFetchLike = async (_url, init) => {
    state.calls += 1;
    opts.onRequest?.();
    if (opts.status !== undefined && opts.status >= 400) {
      return { status: opts.status, headers: {}, text: async () => opts.body ?? "denied" };
    }
    if (opts.body !== undefined) {
      return { status: 200, headers: {}, text: async () => opts.body as string };
    }

    outbound = [];
    inbound?.(JSON.parse(init?.body ?? "{}") as JsonRpcMessage);
    // The server's tool handler is async; give it a few turns to answer.
    for (let i = 0; i < 20 && outbound.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const payload = outbound.length === 0 ? "" : JSON.stringify(outbound[0]);
    if (payload === "") {
      const empty: Record<string, string> = {};
      return { status: 202, headers: empty, text: async () => "" };
    }
    const headers: Record<string, string> = {
      "content-type": opts.sse ? "text/event-stream" : "application/json",
      "mcp-session-id": "sess-1",
    };
    const body = opts.sse ? `event: message\ndata: ${payload}\n\n` : payload;
    return { status: 200, headers, text: async () => body };
  };

  return {
    fetchFn,
    get calls() {
      return state.calls;
    },
  };
}

describe("mounting an HTTP MCP server", () => {
  const httpSpec: McpServerSpec = { name: "hosted", transport: "http", url: "https://example.invalid/mcp" };

  it("lists and calls over plain JSON responses", async () => {
    const { fetchFn } = fetchBackedByRealServer();
    const listed = await listMcpServerTools(httpSpec, { fetchFn });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.tools.map((t) => t.name)).toEqual(["shout"]);
    expect(listed.server).toEqual({ name: "hosted-mcp", version: "9.9.9" });

    const called = await callMcpServerTool(httpSpec, "shout", { text: "hosted" }, { fetchFn });
    expect(called).toMatchObject({ ok: true, text: "HOSTED" });
  });

  it("accepts an SSE-framed response body for a single POST", async () => {
    const { fetchFn } = fetchBackedByRealServer({ sse: true });
    const called = await callMcpServerTool(httpSpec, "shout", { text: "sse" }, { fetchFn });
    expect(called).toMatchObject({ ok: true, text: "SSE" });
  });

  it("an HTTP error is surfaced with its status and body, never swallowed", async () => {
    const { fetchFn } = fetchBackedByRealServer({ status: 401, body: "bad token" });
    const listed = await listMcpServerTools(httpSpec, { fetchFn });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toContain("HTTP 401");
    expect(listed.error).toContain("bad token");
  });

  it("a response with no frame names the unsupported-stream limitation instead of hanging", async () => {
    const { fetchFn } = fetchBackedByRealServer({ body: "" });
    const listed = await listMcpServerTools(httpSpec, { fetchFn });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toContain("no JSON-RPC frame");
    expect(listed.error).toContain("SSE stream");
  });

  it("with no fetch transport at all, an http mount fails honestly rather than mocking", async () => {
    const listed = await listMcpServerTools(httpSpec, {});
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toContain("no HTTP transport is available");
  });

  it("a missing header env var is refused BEFORE any request is sent", async () => {
    const backing = fetchBackedByRealServer();
    const spec: McpServerSpec = {
      name: "hosted",
      transport: "http",
      url: "https://example.invalid/mcp",
      headerEnv: { Authorization: "ACME_TOKEN" },
    };
    const listed = await listMcpServerTools(spec, { fetchFn: backing.fetchFn, env: {} });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error).toContain("ACME_TOKEN");
    expect(backing.calls).toBe(0);
  });

  it("sends the configured header from the environment, and echoes the session id back", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const captureFetch: McpFetchLike = async (_url, init) => {
      seen.push(init?.headers);
      const request = JSON.parse(init?.body ?? "{}") as JsonRpcMessage;
      return {
        status: 200,
        headers: { "Mcp-Session-Id": "abc123" },
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result:
              request.method === "initialize"
                ? { serverInfo: { name: "hosted-mcp", version: "1" }, capabilities: {} }
                : { tools: [] },
          }),
      };
    };
    const spec: McpServerSpec = {
      name: "hosted",
      transport: "http",
      url: "https://example.invalid/mcp",
      headerEnv: { Authorization: "ACME_TOKEN" },
    };
    const listed = await listMcpServerTools(spec, { fetchFn: captureFetch, env: { ACME_TOKEN: "Bearer t" } });
    expect(listed.ok).toBe(true);
    expect(seen[0]?.Authorization).toBe("Bearer t");
    // The session id from the first response is echoed on the second request.
    expect(seen[1]?.["mcp-session-id"]).toBe("abc123");
  });

  it("parseHttpFrames handles json, batches, and SSE payloads", () => {
    expect(parseHttpFrames('{"jsonrpc":"2.0","id":1}')).toHaveLength(1);
    expect(parseHttpFrames('[{"jsonrpc":"2.0","id":1},{"jsonrpc":"2.0","id":2}]')).toHaveLength(2);
    expect(parseHttpFrames('event: message\ndata: {"jsonrpc":"2.0","id":3}\n\n')[0].id).toBe(3);
    expect(parseHttpFrames("")).toEqual([]);
    expect(parseHttpFrames("not a frame")).toEqual([]);
  });

  it("closing the HTTP transport stops further sends", async () => {
    const { fetchFn } = fetchBackedByRealServer();
    const transport = new HttpMcpTransport({ url: "https://example.invalid/mcp", fetchFn });
    const client = new McpClient(transport, { timeoutMs: 500 });
    client.close();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow(/closed/);
  });
});
