/**
 * Governance service — the desktop/TUI side of `gov.*`.
 *
 * Answers {@link GovCommand}s from the REAL governance stack
 * (`src/hades/gov/**`) rooted at the same `<dataDir>/gov` the `hades gov` CLI
 * writes, so all three surfaces report one identity, one audit chain and one
 * policy. Shapes are mapped to the wire views in `../ipc/gov-contract.ts`.
 *
 * ## Read-only by construction
 *
 * {@link GovReader} exposes only queries. There is deliberately no way to
 * mint a capability token, rotate or revoke a key, or write policy through
 * this service — those stay on the CLI (see the gov-contract header for why).
 * The port shape is the enforcement: a renderer cannot ask for what the
 * interface cannot express.
 *
 * ## Failure is reported, never smoothed over
 *
 * Every handler is wrapped so a throwing reader becomes a `gov.error` event
 * naming the failing op. Nothing here ever substitutes a comfortable default
 * for a fact it could not establish — in particular a chain that cannot be
 * verified is never reported as verified, and an air-gap verdict that cannot
 * be measured is an error rather than `egressBlocked: false`.
 */

import type {
  GovCommand,
  GovEvent,
  GovIdentityView,
  GovAuditView,
  GovPolicyView,
  GovTokenView,
  GovAirgapView,
} from "../ipc/gov-contract";

/**
 * The read-only slice of the governance stack this service needs. Central
 * wiring (`./gov-wiring.ts`) implements it over the real engine; tests
 * implement it with plain objects.
 */
export interface GovReader {
  identity(): GovIdentityView | Promise<GovIdentityView>;
  /** `verify` re-walks the hash chain; false returns length/head only. */
  audit(verify: boolean): GovAuditView | Promise<GovAuditView>;
  policy(): GovPolicyView | Promise<GovPolicyView>;
  /** `subject` filters to one subject when provided. */
  tokens(subject?: string): GovTokenView[] | Promise<GovTokenView[]>;
  airgap(): GovAirgapView | Promise<GovAirgapView>;
}

export interface GovServiceOptions {
  reader: GovReader;
  now?: () => number;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

export class GovService {
  private readonly reader: GovReader;
  private readonly now: () => number;

  constructor(opts: GovServiceOptions) {
    this.reader = opts.reader;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Handle one command. Never throws and never returns an empty array — a
   * caller awaiting a reply always gets exactly one event, success or
   * `gov.error`, so a renderer can never hang on silence.
   */
  async handle(cmd: GovCommand): Promise<GovEvent[]> {
    const at = this.now();
    try {
      switch (cmd.kind) {
        case "gov.identity":
          return [{ kind: "gov.identity", identity: await this.reader.identity(), at }];
        case "gov.audit":
          // Default to VERIFYING. A caller that omits the flag gets the
          // stronger answer, never the cheaper-but-weaker one.
          return [{ kind: "gov.audit", audit: await this.reader.audit(cmd.verify ?? true), at }];
        case "gov.policy":
          return [{ kind: "gov.policy", policy: await this.reader.policy(), at }];
        case "gov.tokens":
          return [{ kind: "gov.tokens", tokens: await this.reader.tokens(cmd.subject), at }];
        case "gov.airgap":
          return [{ kind: "gov.airgap", airgap: await this.reader.airgap(), at }];
        default: {
          const exhaustive: never = cmd;
          void exhaustive;
          return [
            {
              kind: "gov.error",
              op: "unknown",
              message: `unsupported gov command: ${String((cmd as { kind?: unknown }).kind)}`,
              at,
            },
          ];
        }
      }
    } catch (err) {
      return [{ kind: "gov.error", op: cmd.kind, message: errMsg(err), at }];
    }
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers — exported so the wiring and its tests share one definition
// of how engine shapes become wire views.
// ---------------------------------------------------------------------------

/**
 * Derive the identity view. `generation` is the ROTATION COUNT, so a
 * never-rotated key reports 0 rather than a fabricated 1.
 */
export function identityView(input: {
  publicKeyHex: string;
  source: GovIdentityView["keySource"];
  rotationCount: number;
  documentVerified: boolean;
  revokedCount: number;
  createdAt?: number;
}): GovIdentityView {
  return {
    publicKeyHex: input.publicKeyHex,
    generation: input.rotationCount,
    keySource: input.source,
    documentVerified: input.documentVerified,
    revokedCount: input.revokedCount,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

/**
 * Derive the audit view from the engine's `AuditVerification`.
 *
 * `brokenAt` is only carried when the chain actually failed — the contract's
 * guard rejects a payload claiming both `verified: true` and a break index,
 * so emitting both would be caught rather than rendered.
 */
export function auditView(input: {
  entries: number;
  headSha256?: string;
  ok: boolean;
  brokenAt?: number;
}): GovAuditView {
  return {
    length: input.entries,
    headHash: input.headSha256 ?? "",
    verified: input.ok,
    ...(input.ok || input.brokenAt === undefined ? {} : { brokenAtIndex: input.brokenAt }),
  };
}
