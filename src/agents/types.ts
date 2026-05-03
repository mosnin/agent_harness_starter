import type { ToolContext } from "@/tools/types";

/** Configuration for creating an agent. */
export interface AgentConfig {
  /** Display name for the agent. */
  name: string;
  /** System prompt / instructions. */
  instructions: string;
  /** OpenAI model to use (overrides config.openai.model). */
  model?: string;
  /** Tool names from the registry to make available to this agent. */
  tools?: string[];
  /** Whether this agent can hand off to other agents. */
  handoffs?: string[];
  /** Max LLM turns before giving up (prevents infinite loops). */
  maxTurns?: number;
  /** Temperature (0-2). */
  temperature?: number;
}

/** A single event emitted by the harness during a run. */
export type AgentEvent =
  | { type: "message_delta"; delta: string }
  | { type: "message_done"; content: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "handoff"; from: string; to: string }
  | { type: "error"; error: string }
  | { type: "done"; finalOutput: string };

/** Input for a single agent run. */
export interface RunInput {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  context?: ToolContext;
  signal?: AbortSignal;
}

/** Result of a completed agent run. */
export interface RunResult {
  finalOutput: string;
  messages: Array<{ role: string; content: string }>;
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
}
