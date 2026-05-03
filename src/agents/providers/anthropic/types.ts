/**
 * Anthropic Managed Agents — type definitions.
 *
 * Anthropic Managed Agents is a fully managed infrastructure for running
 * Claude as an autonomous agent with built-in Bash, file I/O, web search,
 * and MCP tool support — no sandboxing code needed on your end.
 *
 * Docs: https://platform.claude.com/docs/en/managed-agents/overview
 * Beta: requires `anthropic-beta: managed-agents-2026-04-01` header (set automatically by the SDK)
 */

/** Configuration for an Anthropic Managed Agent session. */
export interface AnthropicAgentConfig {
  /**
   * The Anthropic Managed Agent ID.
   * Create one at: https://platform.claude.com/agents
   * Or via the API: POST /v1/agents
   * Falls back to ANTHROPIC_AGENT_ID env var.
   */
  agentId?: string;

  /**
   * The environment ID (the container config: packages, network rules, files).
   * Create one at: https://platform.claude.com/environments
   * Or via the API: POST /v1/environments
   * Falls back to ANTHROPIC_ENVIRONMENT_ID env var.
   */
  environmentId?: string;

  /**
   * Vault IDs for MCP authentication (OAuth credentials managed by Anthropic).
   * See: https://platform.claude.com/docs/en/managed-agents/vaults
   */
  vaultIds?: string[];

  /**
   * If set, the same Anthropic session is reused across calls.
   * If unset, a new session is created for each run.
   * Useful for maintaining conversation history server-side.
   */
  sessionId?: string;

  /**
   * Pin the session to a specific agent version.
   * Omit to always use the latest version.
   */
  agentVersion?: number;

  /** Abort signal forwarded to the streaming request. */
  signal?: AbortSignal;
}

/** A single event in the Anthropic Managed Agents SSE stream. */
export interface AnthropicSessionEvent {
  type: string;
  [key: string]: unknown;
}
