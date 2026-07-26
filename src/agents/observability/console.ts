/**
 * Console ObservabilityAdapter — logs all events to stdout.
 * Good default for development. Replace with a real backend in production.
 */

import type {
  ObservabilityAdapter,
  RunSpan,
  ToolSpan,
  UsageEvent,
} from "./types";

export class ConsoleAdapter implements ObservabilityAdapter {
  onRunStart(span: RunSpan) {
    console.info(`[obs] run.start  runId=${span.runId} agent=${span.agentName} model=${span.model}`);
  }

  onRunComplete(span: RunSpan, result: { finalOutput: string; durationMs: number }) {
    console.info(
      `[obs] run.done   runId=${span.runId} agent=${span.agentName} ${result.durationMs}ms`
    );
  }

  onRunError(span: RunSpan, error: Error, durationMs: number) {
    console.error(
      `[obs] run.error  runId=${span.runId} agent=${span.agentName} ${durationMs}ms`,
      error.message
    );
  }

  onToolCall(span: ToolSpan) {
    console.info(
      `[obs] tool.call  runId=${span.runId} tool=${span.toolName} callId=${span.callId}`
    );
  }

  onToolResult(span: ToolSpan, _result: unknown, durationMs: number) {
    console.info(
      `[obs] tool.done  runId=${span.runId} tool=${span.toolName} ${durationMs}ms`
    );
  }

  onHandoff(from: string, to: string, runId: string) {
    console.info(`[obs] handoff    runId=${runId} ${from} → ${to}`);
  }

  onUsage(event: UsageEvent) {
    console.info(
      `[obs] usage      runId=${event.runId} in=${event.inputTokens} out=${event.outputTokens} total=${event.totalTokens}`
    );
  }
}
