/**
 * Per-tool execution telemetry — tracks call count, avg execution time, errors.
 *
 * Wrap any ToolDefinition array with telemetry to get live stats on which tools
 * are called most, which are slowest, and which are failing.
 *
 * @example
 *   import { createToolTelemetry } from "@agent-harness/core/tools";
 *
 *   const telemetry = createToolTelemetry();
 *
 *   const agent = createCustomHarness({
 *     tools: telemetry.wrap(myTools),
 *     plugins: [telemetry.plugin()],
 *   });
 *
 *   // After runs:
 *   console.log(telemetry.getStats());
 */

import type { ToolDefinition } from "./types";
import type { HarnessPlugin } from "../types";

export interface ToolStats {
  callCount: number;
  errorCount: number;
  /** Running mean execution time in milliseconds */
  avgExecutionTimeMs: number;
  lastCalledAt: number | null;
  lastError: string | null;
}

export interface TelemetryReport {
  tools: Record<string, ToolStats>;
  totalCalls: number;
  totalErrors: number;
  /** Top N tools by call count */
  topByCallCount: Array<{ name: string; callCount: number }>;
  /** Top N tools by avg execution time */
  topByLatency: Array<{ name: string; avgMs: number }>;
}

export interface ToolTelemetry {
  /** Wrap tool definitions to add telemetry tracking */
  wrap(tools: ToolDefinition[]): ToolDefinition[];
  /** Get current stats for all tracked tools */
  getStats(toolName?: string): TelemetryReport | ToolStats | null;
  /** Reset all stats */
  reset(): void;
  /** HarnessPlugin that logs tool stats to console on run completion */
  plugin(options?: { logOnComplete?: boolean }): HarnessPlugin;
}

export function createToolTelemetry(): ToolTelemetry {
  const stats = new Map<string, ToolStats>();

  function getOrCreate(name: string): ToolStats {
    if (!stats.has(name)) {
      stats.set(name, { callCount: 0, errorCount: 0, avgExecutionTimeMs: 0, lastCalledAt: null, lastError: null });
    }
    return stats.get(name)!;
  }

  function updateAvg(current: number, n: number, newValue: number): number {
    // Running mean: avg_n = avg_{n-1} + (newValue - avg_{n-1}) / n
    return current + (newValue - current) / n;
  }

  const telemetry: ToolTelemetry = {
    wrap(tools: ToolDefinition[]): ToolDefinition[] {
      return tools.map((tool) => ({
        ...tool,
        execute: async (input: unknown, ctx: unknown) => {
          const s = getOrCreate(tool.name);
          const start = Date.now();
          s.lastCalledAt = start;
          s.callCount++;
          try {
            const result = await tool.execute(input as Record<string, unknown>, ctx as import("./types").ToolContext);
            const durationMs = Date.now() - start;
            s.avgExecutionTimeMs = updateAvg(s.avgExecutionTimeMs, s.callCount, durationMs);
            return result;
          } catch (err) {
            s.errorCount++;
            s.lastError = err instanceof Error ? err.message : String(err);
            throw err;
          }
        },
      }));
    },

    getStats(toolName?: string): TelemetryReport | ToolStats | null {
      if (toolName) return stats.get(toolName) ?? null;

      const tools: Record<string, ToolStats> = {};
      let totalCalls = 0;
      let totalErrors = 0;
      for (const [name, s] of stats) {
        tools[name] = { ...s };
        totalCalls += s.callCount;
        totalErrors += s.errorCount;
      }

      const sorted = [...stats.entries()].sort((a, b) => b[1].callCount - a[1].callCount);
      const topByCallCount = sorted.slice(0, 5).map(([name, s]) => ({ name, callCount: s.callCount }));
      const topByLatency = [...stats.entries()]
        .filter(([, s]) => s.callCount > 0)
        .sort((a, b) => b[1].avgExecutionTimeMs - a[1].avgExecutionTimeMs)
        .slice(0, 5)
        .map(([name, s]) => ({ name, avgMs: Math.round(s.avgExecutionTimeMs) }));

      return { tools, totalCalls, totalErrors, topByCallCount, topByLatency };
    },

    reset(): void { stats.clear(); },

    plugin(options: { logOnComplete?: boolean } = {}): HarnessPlugin {
      return {
        name: "tool-telemetry",
        onComplete: async () => {
          if (options.logOnComplete) {
            const report = telemetry.getStats() as TelemetryReport;
            console.log("[agent-harness] Tool telemetry:", JSON.stringify(report, null, 2));
          }
        },
      };
    },
  };

  return telemetry;
}
