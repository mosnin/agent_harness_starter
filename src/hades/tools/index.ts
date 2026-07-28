/**
 * @module hades/tools
 *
 * The Phase 2 tool suite: the canonical catalog shapes, the eight shipped
 * tool factories (each real when its provider key + transport are present,
 * an honest deterministic "[mock]"-labelled fallback otherwise), the
 * enable/disable `ToolsetManager` behind `hades tools`, the calibrated STYX
 * output verifiers, and the chain-bench checkpoint.
 *
 * The canonical type identities for `CatalogEntry`/`ToolMode`/`ToolCategory`/
 * `FetchLike`/`ToolFactoryOptions` are the ones exported here (from
 * `./catalog`). The individual factory files carry structurally identical
 * local duplicates by design (zero cross-file coupling); do not re-export
 * those duplicates.
 */

// Canonical shapes + catalog
export { ToolCatalog, isValidToolId, BUILTIN_TOOL_SOURCE } from "./catalog";
export type { CatalogEntry, ToolMode, ToolCategory, FetchLike, ToolFactoryOptions } from "./catalog";

// Inherited tools: external MCP servers mounted into the catalog
export {
  MCP_TOOL_ID_PREFIX,
  MCP_UNVERIFIED_VERIFIER_ID,
  InMemoryMcpMountStore,
  JsonFileMcpMountStore,
  mcpCatalogEntries,
  mcpSource,
  mcpToolId,
  planMcpEntries,
  parseMcpToolInput,
  describeInputSchema,
  isValidMcpServerName,
  validateMountRecord,
} from "./mcp-catalog";
export type {
  McpMountRecord,
  McpMountStore,
  McpMountedTool,
  McpEntryPlan,
  SkippedMcpTool,
} from "./mcp-catalog";
export { mcpSwarmTools } from "./mcp-swarm-tools";

// Enable/disable management + persistence
export { ToolsetManager, InMemoryToolStateStore, JsonFileToolStateStore } from "./manager";
export type { ToolStateStore, ToolStatus, ToolsetManagerOptions } from "./manager";

// The eight tool factories (plus their independently useful, tested internals)
export { createWebSearchTool } from "./web-search";
export type { WebSearchOutput, WebSearchResultItem } from "./web-search";
export { createFetchExtractTool, extractHtml } from "./fetch-extract";
export type { ExtractKind, FetchExtractOutput } from "./fetch-extract";
export { createFileOpsTool } from "./file-ops";
export { createShellTool, tokenizeCommandLine, realSpawn } from "./shell";
export type { ShellPolicy, SpawnLike, SpawnResult } from "./shell";
export { createHttpTool, isForbiddenHost } from "./http";
// (image-gen's `mulberry32` is deliberately NOT re-exported here — the
// hierarchy module already exports a `mulberry32` through the main barrel;
// import it from "./image-gen" directly if you need this exact instance.)
export { createImageGenTool, renderProceduralSvg, fnv1a32 } from "./image-gen";
export type { ImageGenOutput } from "./image-gen";
export { createTtsTool, synthesizeWav, parseWavHeader } from "./tts";
export type { TtsOutput } from "./tts";
export { createVisionDescribeTool, sniffImage, isValidBase64 } from "./vision";
export type { VisionDescribeOutput, SniffResult } from "./vision";

// Central assembly (the product wiring)
export {
  defaultToolCatalog,
  defaultToolsetManager,
  realFetchLike,
  DEFAULT_CATALOG_TOOL_IDS,
  DEFAULT_SHELL_ALLOWED_COMMANDS,
} from "./default-catalog";
export type { DefaultCatalogOptions, DefaultToolsetOptions } from "./default-catalog";

// STYX verification + the Phase 2 checkpoint
export { toolVerifiers, calibrationTable } from "./verifiers";
export type { ToolVerdict, ToolOutputVerifier } from "./verifiers";
export { runToolchainBench } from "./chain-bench";
export type { ToolchainBenchResult, ToolchainBenchOptions } from "./chain-bench";
