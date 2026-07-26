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
export { createSwarmTaskTool, SWARM_TASK_INPUT_SCHEMA } from "./swarm-task-tool";
export type {
  SwarmTaskRequest,
  SwarmSessionPort,
  SwarmSessionFactory,
  VerifiedSwarmResult,
} from "./swarm-task-tool";
export {
  realSwarmSessionFactory,
  adaptSwarmManager,
  registerSwarmTaskTool,
  registerCertifiedSwarmTool,
} from "./swarm-session";
// Phase 6 ecosystem exit: the ed25519 STYX certificate handoff across the MCP
// boundary, plus the certified wrapper tool + end-to-end demo that proves it.
export {
  HANDOFF_VERSION,
  issueHandoffCertificate,
  encodeHandoff,
  decodeHandoff,
  verifyHandoffAtBoundary,
} from "./cert-handoff";
export type { CertifiedHandoff, HandoffIssueInput, HandoffVerdict } from "./cert-handoff";
export { certifiedSwarmTool, runEcosystemDemo } from "./ecosystem-demo";
export type { EcosystemDemoReport, EcosystemDemoOptions } from "./ecosystem-demo";
