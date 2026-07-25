/**
 * The `"swarm.goal"` task kind: a `JobExecutor` that drives a real
 * {@link GatewayAgentEngine} (`../gateway/agent-handler`) so a scheduled job
 * can produce genuine STYX verification evidence — or honestly abstain.
 *
 * `BuiltinNoteExecutor` (`../cli/schedule-command.ts`) is the honest,
 * zero-evidence baseline: it echoes `task.input` and attaches nothing, so a
 * `"note"` job can never be delivered as verified by `VerifiedDeliveryRouter`
 * (`./delivery`). `SwarmJobExecutor` is the richer sibling: it hands the job
 * to a real engine — either the self-announcing {@link echoEngine} mock
 * (`mode: "mock"`, no evidence, output visibly `"[mock] "`-prefixed) or the
 * STYX-certified {@link verifiedSwarmEngine} the gateway resolves when
 * `HADES_GATEWAY_ENGINE=swarm` and a provider key are both present
 * (`mode: "real"`, a genuine `GateDecision` + `VerificationCertificate`
 * riding along on success) — and forwards whatever evidence that engine
 * actually returned, verbatim, never synthesizing a decision or certificate
 * of its own.
 *
 * The engine and its {@link EngineProbe} are constructor-injected: this
 * module never calls `resolveGatewayEngine` and never reads `process.env`
 * itself — wiring the real environment-driven choice into a running
 * scheduler is the integrator's job (`hades gateway` / `schedule-command`
 * wiring), not this executor's.
 *
 * @module hades/schedule/swarm-executor
 */

import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./runner";
import type { ScheduledJob } from "./store";
import type { AgentTurn, AgentTurnResult, GatewayAgentEngine } from "../gateway/agent-handler";
import type { EngineProbe } from "../gateway/engine-select";

// ===========================================================================
// Locked public types
// ===========================================================================

/** The one task kind this executor handles. Any other `task.kind` is
 *  honestly rejected — see {@link SwarmJobExecutor.execute}. */
export const SWARM_TASK_KIND = "swarm.goal" as const;

export interface SwarmJobExecutorOptions {
  engine: GatewayAgentEngine;
  probe: EngineProbe;
  /** Max time to wait for `engine.respond()` before honestly failing the
   *  execution. Default 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Timer seam — tests inject a fake scheduler so no suite ever sleeps on
   *  the wall clock. Defaults to the real global `setTimeout`. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Timer seam paired with `setTimeoutFn`. Defaults to the real global
   *  `clearTimeout`. */
  clearTimeoutFn?: (h: unknown) => void;
}

// ===========================================================================
// scheduledTurn — pure, deterministic
// ===========================================================================

/**
 * Build the {@link AgentTurn} for one execution of `job`, purely from `job`
 * and `ctx` — no clock reads, no randomness, no I/O. `sessionId` embeds
 * `ctx.scheduledFor` (not `ctx.firedAt`) so the SAME nominal fire instant
 * always maps to the SAME session on replay (e.g. a misfire "catch-up" run
 * that fires late), while two genuinely different scheduled instants for the
 * same job get different sessions rather than colliding into one.
 */
export function scheduledTurn(job: ScheduledJob, ctx: JobExecutionContext): AgentTurn {
  return {
    sessionId: `sched:${job.id}:${ctx.scheduledFor}`,
    identityId: `sched:${job.id}`,
    platform: "scheduler",
    user: job.delivery?.user ?? "scheduler",
    text: job.task.input,
    switchedChannel: false,
  };
}

// ===========================================================================
// Small local helpers
// ===========================================================================

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_TIMEOUT_MS = 120_000;

// ===========================================================================
// SwarmJobExecutor
// ===========================================================================

export class SwarmJobExecutor implements JobExecutor {
  private readonly engine: GatewayAgentEngine;
  private readonly probe: EngineProbe;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;

  constructor(opts: SwarmJobExecutorOptions) {
    this.engine = opts.engine;
    this.probe = opts.probe;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));
  }

  /**
   * Reject any task kind other than {@link SWARM_TASK_KIND} honestly. Run
   * `engine.respond(scheduledTurn(job, ctx))` under a real timeout race
   * (never a wall-clock sleep in tests — the timer functions are injected).
   * A timeout or a `respond()` rejection is ALWAYS mapped to `ok: false`
   * carrying the real message — never a fabricated success. On success, the
   * `verification` field is attached ONLY when the engine actually returned
   * a `decision` or `certificate`; it is never invented here.
   */
  async execute(job: ScheduledJob, ctx: JobExecutionContext): Promise<JobExecutionResult> {
    if (job.task.kind !== SWARM_TASK_KIND) {
      return {
        ok: false,
        output: "",
        detail: `SwarmJobExecutor: task kind "${job.task.kind}" is not "${SWARM_TASK_KIND}"; this executor only handles swarm goal tasks`,
      };
    }

    const turn = scheduledTurn(job, ctx);

    let result: AgentTurnResult;
    try {
      result = await this.raceWithTimeout(turn);
    } catch (err) {
      return { ok: false, output: "", detail: errorMessage(err) };
    }

    return {
      ok: true,
      output: result.text,
      detail: `engine=${this.probe.mode} (${this.probe.detail})`,
      verification:
        result.decision || result.certificate
          ? { decision: result.decision, certificate: result.certificate }
          : undefined,
    };
  }

  /**
   * Race `engine.respond(turn)` against `timeoutMs` using the injected timer
   * seam. Whichever settles first wins; the loser is a guaranteed no-op — a
   * `respond()` resolution that arrives AFTER the timeout already rejected
   * never resolves this promise a second time (no double-settle, no
   * unhandled-rejection warning), so a late engine reply can never clobber
   * the timeout failure the caller already received.
   */
  private raceWithTimeout(turn: AgentTurn): Promise<AgentTurnResult> {
    return new Promise<AgentTurnResult>((resolve, reject) => {
      let settled = false;

      const timer = this.setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SwarmJobExecutor: engine.respond() timed out after ${this.timeoutMs}ms for session "${turn.sessionId}"`));
      }, this.timeoutMs);

      this.engine.respond(turn).then(
        (r) => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          resolve(r);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.clearTimeoutFn(timer);
          reject(err);
        },
      );
    });
  }
}
