/**
 * GatewayService — turns `GatewayCommand`s into `GatewayEvent`s for the
 * desktop sidecar, projecting the real platform gateway
 * (`src/hades/gateway/process.ts`'s `GatewayProcess`) and pairing guard
 * (`src/hades/gateway/pairing.ts`'s `PairingGuard`) into the wire-safe
 * `GatewayStatusView` / `GatewayPairCodeView` (`../ipc/gateway-contract.ts`).
 *
 * This module imports ONLY types from `../ipc/gateway-contract` — no runtime
 * import of `src/hades` anywhere. Instead it declares its own structural seam
 * types (`GatewayStatusSource`, `PairingSource`, `EngineProbeSource`) that
 * the real `GatewayProcess.status()` / `PairingGuard.issuePairingCode()`
 * already satisfy without wrapping — see the doc comments on each seam below
 * for exactly how they line up with the real classes.
 *
 * Both `gateway.status.get` and `gateway.pair.issue` need their source seam
 * configured to do anything: an absent seam is reported as an honest
 * `gateway.error` ("no gateway attached to this sidecar" /
 * "no pairing seam attached to this sidecar"), never a fabricated empty
 * status or pairing code. A THROWING seam is caught and reported the same
 * way — `handle()` never rejects, and it calls `emit` exactly once per
 * command, carrying only `err.message` (never a stack trace) into the
 * emitted `gateway.error`.
 */

import type {
  GatewayCommand,
  GatewayCountersView,
  GatewayEvent,
  GatewayProbeView,
  GatewayStatusView,
} from "../ipc/gateway-contract";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The subset of `GatewayProcess` this service needs. Structural on purpose:
 * a real `GatewayProcess` instance's `.status(): GatewayStatus` method
 * (`../../hades/gateway/process.ts`) already returns
 * `{ running, startedAt?, platforms: PlatformProbe[], counters }`, which
 * satisfies this interface field-for-field without wrapping —
 * `PlatformProbe` (`{ platform, mode: "real" | "offline", detail }`) is
 * structurally identical to `GatewayProbeView`.
 */
export interface GatewayStatusSource {
  status(): {
    running: boolean;
    startedAt?: number;
    platforms: GatewayProbeView[];
    counters: GatewayCountersView;
  };
}

/**
 * The subset of `PairingGuard` this service needs. Structural on purpose: a
 * real `PairingGuard` instance's `.issuePairingCode(level)` method
 * (`../../hades/gateway/pairing.ts`) already returns `{ code, expiresAt }`
 * for `level: "trusted" | "owner"` (its wider `Exclude<TrustLevel,
 * "blocked">` parameter accepts exactly this narrower union), which
 * satisfies this interface without wrapping.
 */
export interface PairingSource {
  issuePairingCode(level: "trusted" | "owner"): { code: string; expiresAt: number };
}

/**
 * Reports which inference engine this sidecar is actually configured to run
 * against, or `undefined` when no engine probe was wired up for this
 * sidecar. Never invoked with arguments — it is a snapshot read, not a
 * command.
 */
export interface EngineProbeSource {
  (): { requested: string; mode: "real" | "mock"; detail: string } | undefined;
}

export interface GatewayServiceOptions {
  /** A live, attached gateway process. Required for `gateway.status.get` to succeed. */
  source?: GatewayStatusSource;
  /** A live, attached pairing guard. Required for `gateway.pair.issue` to succeed. */
  pairing?: PairingSource;
  /** Optional inference-engine probe, projected verbatim into `GatewayStatusView.engine`. */
  engineProbe?: EngineProbeSource;
  /** ms clock, default `() => Date.now()`. Injectable for deterministic tests. */
  now?: () => number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GatewayService {
  private readonly source?: GatewayStatusSource;
  private readonly pairing?: PairingSource;
  private readonly engineProbe?: EngineProbeSource;
  private readonly now: () => number;

  constructor(opts: GatewayServiceOptions = {}) {
    this.source = opts.source;
    this.pairing = opts.pairing;
    this.engineProbe = opts.engineProbe;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Handle one `GatewayCommand`, calling `emit` exactly once with the
   * resulting `GatewayEvent`. Never rejects: any error thrown by `source` or
   * `pairing` becomes a `gateway.error` event instead of propagating.
   */
  async handle(cmd: GatewayCommand, emit: (e: GatewayEvent) => void): Promise<void> {
    switch (cmd.kind) {
      case "gateway.status.get":
        this.handleStatusGet(emit);
        return;
      case "gateway.pair.issue":
        this.handlePairIssue(cmd.level, emit);
        return;
      default: {
        // Exhaustiveness guard: a new GatewayCommand kind added upstream
        // without a case here fails to compile.
        const _exhaustive: never = cmd;
        void _exhaustive;
      }
    }
  }

  private handleStatusGet(emit: (e: GatewayEvent) => void): void {
    if (!this.source) {
      emit({ kind: "gateway.error", message: "no gateway attached to this sidecar", at: this.now() });
      return;
    }

    let raw: {
      running: boolean;
      startedAt?: number;
      platforms: GatewayProbeView[];
      counters: GatewayCountersView;
    };
    try {
      raw = this.source.status();
    } catch (err) {
      emit({ kind: "gateway.error", message: errorMessage(err), at: this.now() });
      return;
    }

    let engine: GatewayStatusView["engine"] = null;
    if (this.engineProbe) {
      try {
        engine = this.engineProbe() ?? null;
      } catch (err) {
        emit({ kind: "gateway.error", message: errorMessage(err), at: this.now() });
        return;
      }
    }

    const status: GatewayStatusView = {
      running: raw.running,
      startedAt: raw.startedAt ?? null,
      platforms: raw.platforms,
      counters: { ...raw.counters },
      engine,
      at: this.now(),
    };
    emit({ kind: "gateway.status", status });
  }

  private handlePairIssue(level: "trusted" | "owner", emit: (e: GatewayEvent) => void): void {
    if (!this.pairing) {
      emit({ kind: "gateway.error", message: "no pairing seam attached to this sidecar", at: this.now() });
      return;
    }

    let issued: { code: string; expiresAt: number };
    try {
      issued = this.pairing.issuePairingCode(level);
    } catch (err) {
      emit({ kind: "gateway.error", message: errorMessage(err), at: this.now() });
      return;
    }

    emit({
      kind: "gateway.paircode",
      pair: { code: issued.code, level, expiresAt: issued.expiresAt, at: this.now() },
    });
  }
}
