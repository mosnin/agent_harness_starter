import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { McpClient, type JsonRpcMessage } from "../../hades/mcp/client";
import type { Tool } from "../../hades/agent/tools";
export interface DesktopMcpServer {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}
/** Explicitly configured local MCP server. No shell interpolation or inherited
 * cloud credentials. One child per agent turn; cancellation closes the transport. */
export async function connectMcp(
  server: DesktopMcpServer,
  cwd: string,
  signal: AbortSignal,
): Promise<{ tools: Tool[]; close: () => void }> {
  if (signal.aborted) throw new Error("Cancelled");
  const child = spawn(server.command, server.args, {
    cwd,
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
    },
    stdio: "pipe",
    detached: true,
  });
  const lines = createInterface({ input: child.stdout });
  let receive: (m: JsonRpcMessage) => void = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    lines.close();
    client.close();
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
    signal.removeEventListener("abort", close);
  };
  const client = new McpClient(
    {
      send: (message) => {
        if (closed) throw new Error("MCP server closed");
        child.stdin.write(JSON.stringify(message) + "\n");
      },
      onMessage: (handler) => {
        receive = handler;
      },
    },
    { timeoutMs: 20_000 },
  );
  lines.on("line", (line) => {
    if (line.length > 2_000_000) {
      close();
      return;
    }
    try {
      receive(JSON.parse(line));
    } catch {
      /* non-protocol stdout is ignored */
    }
  });
  child.on("error", () => close());
  child.on("exit", () => close());
  child.stderr.resume();
  signal.addEventListener("abort", close, { once: true });
  try {
    await client.initialize();
    const definitions = await client.listTools();
    return {
      close,
      tools: definitions.map((t) => ({
        name: `mcp_${server.name}_${t.name}`,
        description: `${t.description ?? t.name}. Input JSON matching: ${JSON.stringify(t.inputSchema ?? {})}`,
        run: async (input: string) => {
          const result = await client.callTool(t.name, JSON.parse(input));
          return {
            ok: !result.isError,
            output: JSON.stringify(result.content).slice(0, 100_000),
          };
        },
      })),
    };
  } catch (e) {
    close();
    throw e;
  }
}
