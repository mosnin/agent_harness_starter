/**
 * Resilience primitives for workflow steps: retries, timeouts, circuit breakers,
 * error handling, and resource management.
 *
 * These wrap any WorkflowStep with production-grade failure handling without
 * requiring the user to change their agent configs.
 *
 * Usage:
 *   import { retry, timeout, fallback } from "@/agents/workflow/resilience";
 *
 *   const robustStep = retry(
 *     timeout(agentStep("search", searchAgent), 30_000),
 *     { maxAttempts: 3, backoff: "exponential" }
 *   );
 */

import type { WorkflowContext, WorkflowStep } from "./types";
import { WorkflowError } from "../errors";

// ── Retry ─────────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Backoff strategy. Default: "exponential". */
  backoff?: "fixed" | "linear" | "exponential";
  /** Base delay in ms. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay in ms (caps exponential). Default: 30_000. */
  maxDelayMs?: number;
  /** Only retry when this predicate returns true. Default: retry all errors. */
  retryWhen?: (error: Error, attempt: number) => boolean;
  /** Called before each retry (use for logging). */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

function computeDelay(
  attempt: number,
  backoff: string,
  base: number,
  max: number
): number {
  let delay: number;
  switch (backoff) {
    case "linear": delay = base * attempt; break;
    case "exponential": delay = base * Math.pow(2, attempt - 1); break;
    default: delay = base; // fixed
  }
  return Math.min(delay, max);
}

/**
 * Wrap a step with automatic retry on failure.
 */
export function retry(step: WorkflowStep, config: RetryConfig = {}): WorkflowStep {
  const {
    maxAttempts = 3,
    backoff = "exponential",
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    retryWhen,
    onRetry,
  } = config;

  return {
    name: step.name,
    type: step.type,
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      let lastError: Error = new Error("Unknown error");
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await step.execute(ctx);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt === maxAttempts) break;
          if (retryWhen && !retryWhen(lastError, attempt)) break;
          const delay = computeDelay(attempt, backoff, baseDelayMs, maxDelayMs);
          onRetry?.(lastError, attempt, delay);
          // Check abort signal before sleeping
          if (ctx.signal?.aborted) throw lastError;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            ctx.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(lastError);
            }, { once: true });
          });
        }
      }
      throw lastError;
    },
  };
}

// ── Timeout ───────────────────────────────────────────────────────────────────

export class TimeoutError extends WorkflowError {
  constructor(stepName: string, ms: number) {
    super(`Step "${stepName}" timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Wrap a step so it throws TimeoutError if it takes longer than `ms` milliseconds.
 */
export function timeout(step: WorkflowStep, ms: number): WorkflowStep {
  return {
    name: step.name,
    type: step.type,
    execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      return new Promise<WorkflowContext>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(step.name, ms)), ms);
        step.execute(ctx).then(
          (result) => { clearTimeout(timer); resolve(result); },
          (err) => { clearTimeout(timer); reject(err); }
        );
      });
    },
  };
}

// ── Fallback ──────────────────────────────────────────────────────────────────

/**
 * Run the primary step; if it throws, run the fallbackStep instead.
 * The error is captured in ctx.stepOutputs[`${primary.name}.__error`].
 */
export function fallback(primary: WorkflowStep, fallbackStep: WorkflowStep): WorkflowStep {
  return {
    name: primary.name,
    type: primary.type,
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      try {
        return await primary.execute(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.stepOutputs[`${primary.name}.__error`] = {
          stepName: primary.name,
          output: msg,
          durationMs: 0,
          metadata: { error: msg },
        };
        return fallbackStep.execute(ctx);
      }
    },
  };
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds to wait in open state before trying half-open. Default: 60_000. */
  resetTimeoutMs?: number;
  /** Called when the circuit state changes. */
  onStateChange?: (from: CircuitState, to: CircuitState, stepName: string) => void;
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  wrap(step: WorkflowStep): WorkflowStep;
  reset(): void;
}

export class CircuitBreakerOpenError extends WorkflowError {
  constructor(stepName: string) {
    super(`Circuit breaker open for step "${stepName}". Too many recent failures.`);
    this.name = "CircuitBreakerOpenError";
  }
}

export function createCircuitBreaker(config: CircuitBreakerConfig = {}): CircuitBreaker {
  const {
    failureThreshold = 5,
    resetTimeoutMs = 60_000,
    onStateChange,
  } = config;

  let state: CircuitState = "closed";
  let failures = 0;
  let openedAt: number | null = null;

  function transition(to: CircuitState, stepName: string) {
    const from = state;
    state = to;
    if (from !== to) onStateChange?.(from, to, stepName);
  }

  return {
    get state() { return state; },

    reset() {
      state = "closed";
      failures = 0;
      openedAt = null;
    },

    wrap(step: WorkflowStep): WorkflowStep {
      return {
        name: step.name,
        type: step.type,
        async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
          if (state === "open") {
            if (openedAt !== null && Date.now() - openedAt >= resetTimeoutMs) {
              transition("half-open", step.name);
            } else {
              throw new CircuitBreakerOpenError(step.name);
            }
          }

          try {
            const result = await step.execute(ctx);
            if (state === "half-open") {
              transition("closed", step.name);
              failures = 0;
            }
            return result;
          } catch (err) {
            failures++;
            if (failures >= failureThreshold) {
              openedAt = Date.now();
              transition("open", step.name);
            }
            throw err;
          }
        },
      };
    },
  };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

/**
 * Resource manager: limit how many workflow steps run concurrently.
 * Useful for rate-limiting API calls or protecting downstream services.
 */
export class ConcurrencyLimiter {
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Run a function while holding a concurrency slot.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Wrap a WorkflowStep so it respects this limiter.
   */
  wrapStep(step: WorkflowStep): WorkflowStep {
    return {
      name: step.name,
      type: step.type,
      execute: (ctx: WorkflowContext) => this.run(() => step.execute(ctx)),
    };
  }
}

// ── Error handler ─────────────────────────────────────────────────────────────

export interface ErrorHandlerConfig {
  /** Called on any step error. Return a message string to substitute, or rethrow. */
  handle: (error: Error, stepName: string, ctx: WorkflowContext) => string | Promise<string> | never;
}

/**
 * Wrap a step so errors are caught and handled gracefully.
 * The handler can return a fallback message or rethrow.
 */
export function onError(step: WorkflowStep, config: ErrorHandlerConfig): WorkflowStep {
  return {
    name: step.name,
    type: step.type,
    async execute(ctx: WorkflowContext): Promise<WorkflowContext> {
      try {
        return await step.execute(ctx);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const fallback = await Promise.resolve(config.handle(error, step.name, ctx));
        ctx.currentMessage = fallback;
        ctx.stepOutputs[step.name] = {
          stepName: step.name,
          output: fallback,
          durationMs: 0,
          metadata: { handledError: error.message },
        };
        ctx.log.push({ stepName: step.name, startedAt: Date.now(), durationMs: 0, status: "error", error: error.message });
        return ctx;
      }
    },
  };
}
