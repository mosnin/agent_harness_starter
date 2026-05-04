/**
 * Tool index — import this file to register all built-in tools.
 * Tools self-register on import via `registerTool` in their modules.
 *
 * Add your own tools by creating a file in src/agents/tools/ and importing it here.
 */

// Web tools
export * from "./web/tavily";
export * from "./web/browser";

// Sandbox tools
export * from "./sandbox/daytona";
export * from "./sandbox/modal";
export * from "./sandbox/shell";
export * from "./sandbox/files";

// Composio (3rd-party OAuth)
export * from "./composio/index";

// Registry helpers — use these to wire tools into agents
export { registerTool, getTool, getAllTools, getTools } from "./registry";
export type { ToolDefinition, ToolContext, ToolRegistry, SandboxToolConfig } from "./types";

// Tool permissions — per-agent access control
export { createToolPermissions, ToolPermissionsBuilder } from "./permissions";
export type { ToolPermissionRule, ToolPermissionSet } from "./permissions";

// Tool chaining — compose tools in sequence
export { createToolChain, ToolChainBuilder } from "./chain";

// Tool abstraction — standardized interface, output wrapping, selection
export { createAbstractTool, createRuleBasedSelector } from "./abstraction";
export type { ToolResult, AbstractToolConfig, ToolSelectorConfig } from "./abstraction";
