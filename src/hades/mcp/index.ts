/**
 * @module hades/mcp
 *
 * Model Context Protocol, both directions: the client lets Hades call any MCP
 * tool server (inherit the ecosystem), and the server exposes Hades' own tools
 * and skills so any MCP agent — Claude, Hermes, anything — can plug into Hades.
 */
export { McpClient, McpProtocolError } from "./client";
// JsonRpcMessage is intentionally not re-exported here (name clashes with
// acp/*); import it from "./client" directly if needed.
export type {
  McpTransport,
  McpToolDef,
  McpContent,
  McpCallResult,
  McpClientOptions,
} from "./client";
export { McpServer, loopbackTransportPair } from "./server";
export type { McpServerTool, McpServerOptions } from "./server";
