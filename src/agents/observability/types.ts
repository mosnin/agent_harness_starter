/**
 * ObservabilityAdapter — pluggable hooks for tracing, logging, and metrics.
 *
 * Implement this interface to send events to Datadog, OpenTelemetry,
 * LangSmith, Braintrust, your own logging stack, etc.
 *
 * All hooks are optional — implement only what you need.
 */

export interface RunSpan {
  runId: string;
  agentName: string;
  model: string;
  startedAt: Date;
  userId?: string;
  meta?: Record<string, unknown>;
}

export interface ToolSpan {
  runId: string;
  agentName: string;
  toolName: string;
  callId: string;
  input: unknown;
  startedAt: Date;
}

export interface UsageEvent {
  runId: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  userId?: string;
}

export interface ObservabilityAdapter {
  /** Called at the start of every agent run. */
  onRunStart?(span: RunSpan): void | Promise<void>;

  /** Called when a run completes successfully. */
  onRunComplete?(
    span: RunSpan,
    result: { finalOutput: string; durationMs: number }
  ): void | Promise<void>;

  /** Called when a run fails. */
  onRunError?(
    span: RunSpan,
    error: Error,
    durationMs: number
  ): void | Promise<void>;

  /** Called just before a tool is executed. */
  onToolCall?(span: ToolSpan): void | Promise<void>;

  /** Called after a tool returns its result. */
  onToolResult?(
    span: ToolSpan,
    result: unknown,
    durationMs: number
  ): void | Promise<void>;

  /** Called when a handoff occurs between agents. */
  onHandoff?(from: string, to: string, runId: string): void | Promise<void>;

  /** Called with token usage data after each run. */
  onUsage?(event: UsageEvent): void | Promise<void>;
}
