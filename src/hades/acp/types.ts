/**
 * Agent Client Protocol (ACP) — minimal type surface.
 *
 * ACP is the JSON-RPC protocol an editor (client) speaks to an agent so the
 * agent can drive a coding session inside the editor. Hades implements the agent
 * side: `initialize` handshake, `session/new`, `session/prompt` (with streamed
 * `session/update` notifications), and `session/cancel`. Everything rides an
 * injectable transport so it tests without stdio.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** A block of content in a prompt or an agent message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string };

// ── JSON-RPC envelopes ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ── ACP method params/results ────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
}
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    promptCapabilities?: { image?: boolean; audio?: boolean };
    /** Whether the agent will request permission before edits (see iter 24). */
    editApproval?: boolean;
  };
}

export interface NewSessionParams {
  cwd?: string;
  mcpServers?: unknown[];
}
export interface NewSessionResult {
  sessionId: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}
export type StopReason = "end_turn" | "cancelled" | "refusal" | "max_tokens";
export interface PromptResult {
  stopReason: StopReason;
}

export interface CancelParams {
  sessionId: string;
}

/** The `session/update` notification the agent streams to the client. */
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; status: "pending" | "in_progress" | "completed" | "failed" }
  | { sessionUpdate: "plan"; entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> };

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

/** JSON-RPC error codes used by the adapter. */
export const RpcErrors = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
