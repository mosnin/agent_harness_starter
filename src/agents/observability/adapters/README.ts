/**
 * Custom observability adapter stubs — reference implementations for
 * connecting agent telemetry to your own monitoring stack.
 *
 * Copy and adapt these files to create a custom ObservabilityAdapter:
 *
 *   1. Implement the ObservabilityAdapter interface from "../types"
 *   2. Wire in your telemetry backend (Datadog, OpenTelemetry, etc.)
 *   3. Call setObservabilityAdapter() at app startup (e.g. src/instrumentation.ts)
 *
 * Built-in adapters live in the parent directory:
 *   - ConsoleAdapter (console.ts) — default, logs to stdout
 *
 * Example skeleton for an OpenTelemetry adapter:
 *
 *   import { trace, SpanStatusCode } from "@opentelemetry/api";
 *   import type { ObservabilityAdapter, RunSpan } from "../types";
 *
 *   export class OpenTelemetryAdapter implements ObservabilityAdapter {
 *     private tracer = trace.getTracer("agent-harness");
 *     private spans = new Map<string, ReturnType<typeof this.tracer.startSpan>>();
 *
 *     onRunStart(span: RunSpan) {
 *       const otelSpan = this.tracer.startSpan(`agent.run:${span.agentName}`);
 *       otelSpan.setAttribute("agent.name", span.agentName);
 *       otelSpan.setAttribute("agent.model", span.model);
 *       this.spans.set(span.runId, otelSpan);
 *     }
 *
 *     onRunComplete(span: RunSpan, result: { finalOutput: string; durationMs: number }) {
 *       const otelSpan = this.spans.get(span.runId);
 *       if (otelSpan) { otelSpan.setStatus({ code: SpanStatusCode.OK }); otelSpan.end(); }
 *     }
 *
 *     onRunError(span: RunSpan, error: Error) {
 *       const otelSpan = this.spans.get(span.runId);
 *       if (otelSpan) { otelSpan.recordException(error); otelSpan.end(); }
 *     }
 *
 *     onUsage(event: import("../types").UsageEvent) {
 *       // emit token usage metrics to your metrics backend
 *     }
 *   }
 *
 * All hooks are optional — implement only what you need.
 * Errors inside adapter hooks are swallowed by safeEmit() and will
 * never crash an agent run.
 */

export {};
