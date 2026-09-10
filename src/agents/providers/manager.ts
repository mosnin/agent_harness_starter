/**
 * Multi-provider LLM manager — automatic failover, load balancing, cost tracking.
 *
 * Wraps multiple LLM provider configurations and routes requests based on
 * strategy. On error, automatically falls over to the next provider.
 *
 * Supported strategies:
 *   "round-robin"   — rotate evenly across providers
 *   "latency"       — prefer the fastest provider (EMA over last 10 calls)
 *   "cost"          — prefer the cheapest provider based on token pricing
 *   "primary"       — always use first, failover to rest on error
 *
 * @example
 *   import { createProviderManager } from "hades-agent/providers";
 *
 *   const providers = createProviderManager({
 *     providers: [
 *       { name: "gpt-4o",       model: "gpt-4o",          apiKey: process.env.OPENAI_API_KEY! },
 *       { name: "claude-sonnet", model: "claude-sonnet-4-6", apiKey: process.env.ANTHROPIC_API_KEY! },
 *       { name: "gpt-4o-mini",  model: "gpt-4o-mini",     apiKey: process.env.OPENAI_API_KEY! },
 *     ],
 *     strategy: "latency",
 *   });
 *
 *   // Use the selected model name in createAgent:
 *   const { model, apiKey } = await providers.select();
 *   const agent = createAgent({ name: "MyAgent", model, instructions: "..." });
 */

export type ProviderStrategy = "round-robin" | "latency" | "cost" | "primary";

export interface ProviderConfig {
  /** Human-readable name for logs */
  name: string;
  /** Model identifier (e.g. "gpt-4o", "claude-sonnet-4-6") */
  model: string;
  /** API key for this provider */
  apiKey: string;
  /** Base URL override (for Ollama, proxies, etc.) */
  baseUrl?: string;
  /** Cost per 1K input tokens in USD. Used by "cost" strategy. */
  inputCostPer1k?: number;
  /** Cost per 1K output tokens in USD. */
  outputCostPer1k?: number;
}

export interface ProviderStats {
  name: string;
  model: string;
  callCount: number;
  errorCount: number;
  /** Exponential moving average latency in ms */
  avgLatencyMs: number;
  lastUsedAt: number | null;
  isHealthy: boolean;
}

export interface SelectedProvider {
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ProviderManager {
  /**
   * Select the best provider based on the configured strategy.
   * Returns the provider config to pass to createAgent().
   */
  select(): Promise<SelectedProvider>;
  /**
   * Report the outcome of a call to update strategy state.
   * Call this after each agent run.
   */
  report(providerName: string, outcome: { latencyMs: number; success: boolean }): void;
  /** Get stats for all providers */
  stats(): ProviderStats[];
  /** Mark a provider as unhealthy (skip until clearFault is called) */
  markUnhealthy(providerName: string): void;
  /** Clear a fault so the provider is eligible again */
  clearFault(providerName: string): void;
}

// ── Internal state per provider ───────────────────────────────────────────────

interface ProviderState {
  config: ProviderConfig;
  callCount: number;
  errorCount: number;
  avgLatencyMs: number; // EMA, alpha = 0.2
  lastUsedAt: number | null;
  isHealthy: boolean;
  faultAt: number | null; // timestamp when fault was set
}

const EMA_ALPHA = 0.2;
const FAULT_RESET_MS = 5 * 60 * 1000; // 5 minutes

export interface ProviderManagerConfig {
  providers: ProviderConfig[];
  strategy?: ProviderStrategy;
}

export function createProviderManager(config: ProviderManagerConfig): ProviderManager {
  if (!config.providers || config.providers.length === 0) {
    throw new Error("createProviderManager: at least one provider is required");
  }

  const strategy: ProviderStrategy = config.strategy ?? "primary";

  const states = new Map<string, ProviderState>(
    config.providers.map((p) => [
      p.name,
      {
        config: p,
        callCount: 0,
        errorCount: 0,
        avgLatencyMs: 0,
        lastUsedAt: null,
        isHealthy: true,
        faultAt: null,
      },
    ])
  );

  // Ordered list of names preserving the original insertion order
  const names = config.providers.map((p) => p.name);

  let roundRobinIndex = 0;

  function autoHealFaults(): void {
    const now = Date.now();
    for (const state of states.values()) {
      if (!state.isHealthy && state.faultAt !== null && now - state.faultAt >= FAULT_RESET_MS) {
        state.isHealthy = true;
        state.faultAt = null;
      }
    }
  }

  function healthyProviders(): ProviderState[] {
    autoHealFaults();
    return names.map((n) => states.get(n)!).filter((s) => s.isHealthy);
  }

  function toSelected(state: ProviderState): SelectedProvider {
    return {
      name: state.config.name,
      model: state.config.model,
      apiKey: state.config.apiKey,
      baseUrl: state.config.baseUrl,
    };
  }

  async function select(): Promise<SelectedProvider> {
    const healthy = healthyProviders();
    if (healthy.length === 0) {
      throw new Error("createProviderManager: no healthy providers available");
    }

    switch (strategy) {
      case "round-robin": {
        const idx = roundRobinIndex % healthy.length;
        roundRobinIndex = (roundRobinIndex + 1) % healthy.length;
        return toSelected(healthy[idx]);
      }

      case "latency": {
        // Pick provider with lowest EMA latency; treat 0 as "unobserved" → try it first
        const sorted = [...healthy].sort((a, b) => {
          const la = a.callCount === 0 ? -1 : a.avgLatencyMs;
          const lb = b.callCount === 0 ? -1 : b.avgLatencyMs;
          return la - lb;
        });
        return toSelected(sorted[0]);
      }

      case "cost": {
        const sorted = [...healthy].sort((a, b) => {
          const ca = a.config.inputCostPer1k ?? Infinity;
          const cb = b.config.inputCostPer1k ?? Infinity;
          return ca - cb;
        });
        return toSelected(sorted[0]);
      }

      case "primary":
      default: {
        // Always return the first healthy provider in original order
        return toSelected(healthy[0]);
      }
    }
  }

  function report(
    providerName: string,
    outcome: { latencyMs: number; success: boolean }
  ): void {
    const state = states.get(providerName);
    if (!state) return;

    state.callCount++;
    state.lastUsedAt = Date.now();

    if (!outcome.success) {
      state.errorCount++;
    }

    // EMA latency update
    if (state.callCount === 1) {
      state.avgLatencyMs = outcome.latencyMs;
    } else {
      state.avgLatencyMs =
        EMA_ALPHA * outcome.latencyMs + (1 - EMA_ALPHA) * state.avgLatencyMs;
    }
  }

  function markUnhealthy(providerName: string): void {
    const state = states.get(providerName);
    if (!state) return;
    state.isHealthy = false;
    state.faultAt = Date.now();
  }

  function clearFault(providerName: string): void {
    const state = states.get(providerName);
    if (!state) return;
    state.isHealthy = true;
    state.faultAt = null;
  }

  function allStats(): ProviderStats[] {
    autoHealFaults();
    return names.map((name) => {
      const s = states.get(name)!;
      return {
        name: s.config.name,
        model: s.config.model,
        callCount: s.callCount,
        errorCount: s.errorCount,
        avgLatencyMs: s.avgLatencyMs,
        lastUsedAt: s.lastUsedAt,
        isHealthy: s.isHealthy,
      };
    });
  }

  return { select, report, stats: allStats, markUnhealthy, clearFault };
}
