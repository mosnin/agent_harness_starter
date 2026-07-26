/**
 * Kind-routing for `src/hades/schedule/**` task execution.
 *
 * `SchedulerRunner` (`./runner`) drives exactly ONE `JobExecutor` per
 * process — it has no notion of "different task kinds get handled
 * differently". `ExecutorRegistry` is that missing router: it is itself a
 * `JobExecutor` (so it drops straight into `SchedulerRunnerOptions.executor`
 * or `ScheduleCommandDeps.executor` with zero changes to the runner), and it
 * dispatches every `execute()` call to whichever delegate `JobExecutor` was
 * `register()`-ed for `job.task.kind` — case-sensitive, exact match.
 *
 * Three invariants this module exists to hold, all in service of the
 * repo-wide "never fabricate evidence" rule:
 *
 *  1. **Unknown kind is an honest failure, not a crash.** A job whose
 *     `task.kind` has no registered handler gets back `ok: false` naming the
 *     unknown kind AND the full sorted list of kinds that ARE registered —
 *     the same "quote the resolved detail as fact, not a guess" style
 *     `BuiltinNoteExecutor` (`../cli/schedule-command.ts`) already uses for
 *     its own "no handler" branch.
 *  2. **A delegate's exception can never escape to the runner.** Whether a
 *     delegate throws synchronously or its returned promise rejects, this
 *     registry catches it, reports it through the injected `onError` hook
 *     (so callers can log/alert on a specific job+kind+message), and maps it
 *     to the same honest `{ ok: false, output: "", detail }` shape a
 *     well-behaved executor would have returned for a real failure —
 *     `SchedulerRunner.fireOne`'s `executor.execute()` throw path exists as
 *     defense in depth, not as this module's error-handling strategy.
 *  3. **Verification evidence is never synthesized here.** A successful
 *     delegate result — `verification` field, `decision`, `certificate`,
 *     all of it — is returned to the caller exactly as the delegate produced
 *     it. This registry never adds, edits, or removes that field; it is a
 *     pure router, not a source of trust.
 *
 * @module hades/schedule/executor-registry
 */

import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./runner";
import type { ScheduledJob } from "./store";

// ===========================================================================
// Locked public types
// ===========================================================================

export interface ExecutorRegistryOptions {
  /** Observes a delegate executor's exception AFTER it has already been
   *  mapped to an honest `ok:false` result — never used to alter that
   *  result, purely for logging/alerting on a specific job+kind+message. */
  onError?: (jobId: string, kind: string, message: string) => void;
}

// ===========================================================================
// Small local helpers
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// ExecutorRegistry
// ===========================================================================

export class ExecutorRegistry implements JobExecutor {
  private readonly executors = new Map<string, JobExecutor>();
  private readonly onError?: (jobId: string, kind: string, message: string) => void;

  constructor(opts?: ExecutorRegistryOptions) {
    this.onError = opts?.onError;
  }

  /**
   * Register `executor` as the handler for `kind`. `kind` must be a
   * non-empty, non-whitespace-only string. Registering a second handler for
   * a kind that already has one — even the exact same `executor` instance —
   * is a caller bug and throws; there is no "last registration wins" or
   * silent-overwrite behavior anywhere in this module.
   *
   * @throws {Error} if `kind` is empty/whitespace-only, or already registered.
   */
  register(kind: string, executor: JobExecutor): void {
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new Error(`ExecutorRegistry.register: kind must be a non-empty, non-whitespace string, got ${JSON.stringify(kind)}`);
    }
    if (this.executors.has(kind)) {
      throw new Error(`ExecutorRegistry.register: an executor is already registered for kind "${kind}"`);
    }
    this.executors.set(kind, executor);
  }

  /** Every registered kind, sorted lexicographically. Empty array if nothing is registered. */
  kinds(): string[] {
    return [...this.executors.keys()].sort();
  }

  /** Whether a handler is currently registered for exactly this kind (case-sensitive). */
  has(kind: string): boolean {
    return this.executors.has(kind);
  }

  /**
   * Route `job` to whichever delegate is registered for `job.task.kind`
   * (exact, case-sensitive match). An unmatched kind, or a delegate that
   * throws/rejects, is always reported as an honest `ok:false` result —
   * this method itself never throws.
   */
  async execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult> {
    const kind = job.task.kind;
    const delegate = this.executors.get(kind);

    if (!delegate) {
      const known = this.kinds();
      const knownList = known.length > 0 ? known.map((k) => `"${k}"`).join(", ") : "(none registered)";
      return {
        ok: false,
        output: "",
        detail: `ExecutorRegistry: no executor registered for task kind "${kind}" (registered kinds: ${knownList})`,
      };
    }

    try {
      // Returned exactly as the delegate produced it — including its
      // `verification` field (present or absent) verbatim. No field of this
      // result is inspected, added, or rewritten on the success path.
      return await delegate.execute(job, ctx);
    } catch (err) {
      const message = errorMessage(err);
      this.onError?.(job.id, kind, message);
      return {
        ok: false,
        output: "",
        detail: `ExecutorRegistry: executor registered for task kind "${kind}" threw: ${message}`,
      };
    }
  }
}
