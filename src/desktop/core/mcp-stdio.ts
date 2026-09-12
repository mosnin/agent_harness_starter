import { spawn } from "node:child_process";
import { McpClient, type JsonRpcMessage } from "../../hades/mcp/client";
import type { Tool, ToolResult } from "../../hades/agent/tools";
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
      CONTEXT_MODE_PROJECT_DIR: cwd,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
    },
    stdio: "pipe",
    detached: true,
  });
  let frameParts: Buffer[] = [];
  let frameBytes = 0;
  let receive: (m: JsonRpcMessage) => void = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    frameParts = [];
    frameBytes = 0;
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
    // Discovery stays quick; interactive capture/pointing tools can wait for a person.
    { timeoutMs: 20_000, toolTimeoutMs: 180_000 },
  );
  // Bound bytes before decoding/parsing, including a server that never sends a newline.
  child.stdout.on("data", (chunk: Buffer) => {
    let start = 0;
    while (!closed && start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      frameBytes += part.length;
      if (frameBytes > MAX_MCP_FRAME_BYTES) {
        close();
        return;
      }
      frameParts.push(part);
      if (newline < 0) break;
      const line = Buffer.concat(frameParts, frameBytes).toString("utf8");
      frameParts = [];
      frameBytes = 0;
      try {
        const message = JSON.parse(line);
        // McpClient normalizes content but otherwise drops structuredContent.
        if (
          message?.result &&
          Object.hasOwn(message.result, "structuredContent")
        ) {
          message.result.content = [
            ...(Array.isArray(message.result.content)
              ? message.result.content
              : []),
            {
              type: "structuredContent",
              value: message.result.structuredContent,
            },
          ];
        }
        receive(message);
      } catch {
        /* non-protocol stdout is ignored */
      }
      start = newline + 1;
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
          return mcpToolResult(result.content, !result.isError);
        },
      })),
    };
  } catch (e) {
    close();
    throw e;
  }
}

// Matches desktop image attachments; allow bounded metadata beside five images.
const MAX_IMAGE_URL_CHARS = 8_000_000;
const MAX_IMAGES = 5;
const MAX_MCP_FRAME_BYTES = MAX_IMAGES * MAX_IMAGE_URL_CHARS + 200_000;
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function mcpToolResult(content: unknown[], ok: boolean): ToolResult {
  const images: string[] = [];
  const blocks = content.map((block: unknown) => {
    if (
      !block ||
      typeof block !== "object" ||
      !("type" in block) ||
      block.type !== "image"
    )
      return block;
    const image = block as { mimeType?: unknown; data?: unknown };
    const mime = image.mimeType;
    const data = image.data;
    let reason: string | undefined;
    if (typeof mime !== "string" || !IMAGE_MIMES.has(mime))
      reason = "unsupported image MIME type";
    else if (typeof data !== "string" || !data.length)
      reason = "missing image base64";
    else if (images.length >= MAX_IMAGES) reason = "maximum five images";
    else if (data.length + `data:${mime};base64,`.length > MAX_IMAGE_URL_CHARS)
      reason = "image exceeds 6 MB limit";
    else if (
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
      Buffer.from(data, "base64").toString("base64") !== data
    )
      reason = "invalid image base64";
    if (reason) {
      ok = false;
      return { type: "image", omitted: reason };
    }
    images.push(`data:${mime};base64,${data}`);
    return { type: "image", mimeType: mime, imageIndex: images.length - 1 };
  });
  const output = JSON.stringify(blocks);
  const text =
    output.length > 100_000
      ? output.slice(0, 100_000) +
        "\n[MCP text output truncated at 100000 characters]"
      : output;
  return { ok, output: text, ...(images.length ? { images } : {}) };
}
