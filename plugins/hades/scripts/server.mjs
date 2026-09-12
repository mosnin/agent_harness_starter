import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const browserOnly = process.argv.includes("--browser");
const prefix = browserOnly ? "hades_browser" : "hades";
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const tools = [
  {
    name: prefix + "_delegate",
    description: browserOnly
      ? "Delegate a browser task to the user’s paired Hades Browser. Uses its tabs, accounts and permissions; runs in a Hades conversation. Return task ID for status."
      : "Delegate work to Hades in a durable conversation. It can use configured apps, coding agents, workspace and computer tools. Pending approvals remain in Hades. Reuse requestId after uncertain responses.",
    inputSchema: schema(
      { requestId: string, input: string, root: string, profile: string },
      ["requestId", "input"],
    ),
  },
  {
    name: prefix + "_status",
    description:
      "Read the actual conversation progress, pending approvals, delegated tasks and outputs. Admission is not completion.",
    inputSchema: schema({ id: string }, ["id"]),
  },
  {
    name: prefix + "_continue",
    description:
      "Send follow-up instructions to this plugin’s existing task. Use a fresh requestId per message; reuse it on uncertain responses.",
    inputSchema: schema({ id: string, requestId: string, input: string }, [
      "id",
      "requestId",
      "input",
    ]),
  },
  {
    name: prefix + "_cancel",
    description:
      "Stop the conversation and its delegated tasks, preserving saved work.",
    inputSchema: schema({ id: string }, ["id"]),
  },
];
async function call(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error("Unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Expected arguments");
  if (
    Object.keys(args).some((k) => !(k in tool.inputSchema.properties)) ||
    tool.inputSchema.required.some(
      (k) => typeof args[k] !== "string" || !args[k].trim(),
    )
  )
    throw new Error("Invalid tool arguments");
  const path =
    process.env.HADES_RUNTIME_DESCRIPTOR ||
    join(
      process.env.HADES_DATA_DIR || join(homedir(), ".hades"),
      "browser-runtime.json",
    );
  const info = await stat(path);
  if (
    process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())
  )
    throw new Error(
      "Hades descriptor must be private and owned by your account",
    );
  const descriptor = JSON.parse(await readFile(path, "utf8"));
  const endpoint = new URL(descriptor.endpoint);
  if (
    descriptor.version !== 1 ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !/^[a-f0-9]{64}$/.test(descriptor.token)
  )
    throw new Error("Invalid local Hades descriptor");
  const operation = name.slice(prefix.length + 1);
  const response = await fetch(new URL("/conversation", endpoint), {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer " + descriptor.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...args,
      operation,
      ...(operation === "delegate" && browserOnly ? { browserOnly: true } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  if (body.length > 2_000_000)
    throw new Error("Response too large; inspect the task in Hades");
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Invalid Hades response");
  }
  if (!response.ok) throw new Error(data.error || "Hades request failed");
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
async function handle(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    typeof request.method !== "string" ||
    request.jsonrpc !== "2.0"
  ) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      }) + "\n",
    );
    return;
  }
  if (request.id === undefined) return;
  try {
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: prefix, version: "0.1.0" },
      };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      try {
        result = await call(
          request.params?.name,
          request.params?.arguments ?? {},
        );
      } catch (error) {
        result = {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error.code === "ENOENT"
                  ? "Open the updated Hades app to connect."
                  : error.message,
            },
          ],
        };
      }
    } else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
    );
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: "Request failed" },
      }) + "\n",
    );
  }
}
const lines = createInterface({ input: process.stdin });
let pending = 0;
lines.on("line", (line) => {
  if (line.length > 131072 || pending >= 32) {
    process.stderr.write("Rejected oversized or excessive request\n");
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n",
    );
    return;
  }
  pending++;
  void handle(request).finally(() => pending--);
});
