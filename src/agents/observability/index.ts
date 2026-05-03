/**
 * Observability singleton — exposes a single ObservabilityAdapter instance
 * that the harness uses for all telemetry hooks.
 *
 * Swap in your own adapter by calling setObservabilityAdapter() at startup,
 * e.g. in src/instrumentation.ts:
 *
 *   import { setObservabilityAdapter } from "@/agents/observability";
 *   import { DatadogAdapter } from "./my-adapters/datadog";
 *   setObservabilityAdapter(new DatadogAdapter());
 */

import { ConsoleAdapter } from "./console";
import type { ObservabilityAdapter } from "./types";

let _adapter: ObservabilityAdapter = new ConsoleAdapter();

export function setObservabilityAdapter(adapter: ObservabilityAdapter) {
  _adapter = adapter;
}

export function getObservabilityAdapter(): ObservabilityAdapter {
  return _adapter;
}

/** Fire-and-forget wrapper — never throws, never blocks the agent run. */
export async function safeEmit<K extends keyof ObservabilityAdapter>(
  hook: K,
  ...args: Parameters<NonNullable<ObservabilityAdapter[K]>>
): Promise<void> {
  try {
    const fn = _adapter[hook] as ((...a: unknown[]) => void | Promise<void>) | undefined;
    if (fn) await fn.apply(_adapter, args as unknown[]);
  } catch {
    // Observability failures must never crash the agent
  }
}

export type { ObservabilityAdapter, RunSpan, ToolSpan, UsageEvent } from "./types";
