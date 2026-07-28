#!/usr/bin/env node
/**
 * A real, dependency-free **stdio MCP server** for tests and smoke runs.
 *
 * Why this exists (same reasoning as `scripts/stub-llm.mjs`): the MCP mount
 * path is only worth anything if the SHIPPED code can spawn a foreign process,
 * complete the JSON-RPC handshake, list that process's tools, call one, and get
 * a real answer back. A unit test against an in-process fake proves the
 * plumbing compiles; it does not prove a subprocess is ever spawned, that the
 * newline framing survives chunk boundaries, or that a dead server is reported
 * honestly instead of silently mocked. This file closes that gap with no
 * network, no key, and no build step.
 *
 * It speaks the MCP stdio transport exactly as the spec describes it:
 * newline-delimited JSON-RPC 2.0 frames on stdin/stdout, with diagnostics (if
 * any) on stderr. Implemented methods:
 *
 *   initialize                -> { protocolVersion, serverInfo, capabilities }
 *   notifications/initialized -> (notification: no reply, by contract)
 *   ping                      -> {}
 *   tools/list                -> { tools: [echo, upper, sum] }
 *   tools/call                -> { content: [{type:"text",text}], isError? }
 *   anything else             -> JSON-RPC error -32601
 *
 * Failure modes are selectable so the honest-error paths can be tested for
 * real rather than asserted about:
 *
 *   --crash        exit(3) immediately, after one line on stderr. Models a
 *                  server that dies on startup (bad config, missing key).
 *   --hang         accept frames, never answer. Models a wedged server; the
 *                  client's per-request timeout must fire.
 *   --noise        print a non-JSON banner line to stdout before serving.
 *                  Real servers do this; the client must not choke on it.
 *   --fail-tool    every tools/call answers isError:true. Models a tool-level
 *                  failure, which MCP reports as a RESULT, not a protocol error.
 *
 * Usage:
 *   node scripts/mcp-echo-server.mjs [--crash|--hang|--noise|--fail-tool]
 */

const flags = new Set(process.argv.slice(2));

if (flags.has("--crash")) {
  process.stderr.write("mcp-echo-server: refusing to start (--crash)\n");
  process.exit(3);
}

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "echo",
    description: "Return the given text verbatim.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo back." } },
      required: ["text"],
    },
  },
  {
    name: "upper",
    description: "Uppercase the given text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to uppercase." } },
      required: ["text"],
    },
  },
  {
    name: "sum",
    description: "Add two numbers and return the total.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(id, text, isError) {
  ok(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
}

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (flags.has("--fail-tool")) {
    // MCP convention: a TOOL failure is a normal result flagged isError, not a
    // JSON-RPC protocol error. Exercised so the mount layer's mapping of
    // isError -> { ok:false } is tested against a real server, not a fixture.
    textResult(id, `mcp-echo-server: tool "${String(name)}" deliberately failed (--fail-tool)`, true);
    return;
  }

  switch (name) {
    case "echo":
      textResult(id, String(args.text ?? ""));
      return;
    case "upper":
      textResult(id, String(args.text ?? "").toUpperCase());
      return;
    case "sum": {
      const a = Number(args.a);
      const b = Number(args.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        textResult(id, 'sum: both "a" and "b" must be finite numbers', true);
        return;
      }
      textResult(id, String(a + b));
      return;
    }
    default:
      textResult(id, `unknown tool: ${String(name)}`, true);
  }
}

function handle(msg) {
  if (msg === null || typeof msg !== "object") return;
  const { id, method } = msg;

  // A frame with a method but no id is a notification: no reply, ever.
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    if (isNotification) return;
    ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "hades-echo-mcp", version: "0.1.0" },
      capabilities: { tools: {} },
    });
    return;
  }

  if (typeof method === "string" && method.startsWith("notifications/")) return;

  if (isNotification) return;

  if (method === "ping") {
    ok(id, {});
    return;
  }
  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    callTool(id, msg.params);
    return;
  }
  fail(id, -32601, `method not found: ${String(method)}`);
}

if (flags.has("--noise")) {
  // Real servers print banners. The client must skip un-parseable stdout lines
  // rather than treating them as protocol frames.
  process.stdout.write("mcp-echo-server ready (this line is deliberately not JSON)\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (flags.has("--hang")) return; // read and drop: the client must time out
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed inbound line is not fatal; a real server keeps serving.
        process.stderr.write("mcp-echo-server: ignoring malformed inbound line\n");
      }
    }
    nl = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
