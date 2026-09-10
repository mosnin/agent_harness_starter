/**
 * Real-stack wiring for the desktop/TUI governance lane.
 *
 * The only module that connects `GovService` (`./gov-service.ts`) to the
 * genuine governance engine (`src/hades/gov/**`). It is deliberately the
 * single place that knows both shapes, so the service stays testable with a
 * plain object and the engine stays free of desktop concerns.
 *
 * The stack is opened at the SAME `<dataDir>/gov` root the `hades gov` CLI
 * uses, via the same `defaultGovDeps()` factory, so the desktop app, the TUI
 * and the terminal report one identity, one hash-chained audit log and one
 * policy — never three drifting views of the same thing.
 *
 * Laziness is load-bearing, not hygiene: `defaultGovDeps().root()` mints a key
 * on a virgin data dir and takes a lock. It is therefore called on the FIRST
 * gov command, never at construction, so merely starting the sidecar never
 * creates an identity for a user who never opened the governance view.
 */

import type { GovReader } from "./gov-service";
import { GovService } from "./gov-service";
import { auditView, identityView } from "./gov-service";
import type {
  GovAirgapView,
  GovAuditView,
  GovIdentityView,
  GovPolicyView,
  GovTokenView,
} from "../ipc/gov-contract";

/** The subset of `GovCommandDeps` this wiring needs; matched structurally. */
export interface GovStackLike {
  keystore: {
    load(): {
      identity: { publicKeyHex?: string; publicKey?: string };
      source: string;
      rotations: readonly unknown[];
    };
    revoked?(): readonly unknown[];
  };
  chain: {
    verify(): { ok: boolean; entries: number; head?: { sha256: string }; brokenAt?: number };
    entries?(): readonly unknown[];
  };
  policy: {
    load(): {
      status: string;
      bundle?: { doc: { rules: readonly { id: string; effect: string; resources: readonly string[]; actions: readonly string[] }[] }; docSha256: string };
    };
  };
}

export interface GovWiringOptions {
  /** Lazy accessor for the real stack; called on the first command only. */
  root: () => GovStackLike;
  /** Real `probeAirgap()`; injected so tests never engage a real seal. */
  probeAirgap: () => { sealed: boolean; unverifiableSeams: readonly unknown[] };
  /** Capability tokens are not enumerable from the stack; see `tokens()`. */
  listTokens?: () => GovTokenView[];
}

/** One of the two ed25519 public-key field spellings the engine may expose. */
function publicKeyOf(identity: { publicKeyHex?: string; publicKey?: string }): string {
  return identity.publicKeyHex ?? identity.publicKey ?? "";
}

function normalizeSource(source: string): GovIdentityView["keySource"] {
  return source === "env" || source === "persisted" || source === "generated" || source === "ephemeral"
    ? source
    : "ephemeral";
}

/**
 * Build the read-only {@link GovReader} over the real stack.
 *
 * Note what is NOT smoothed over here:
 *  - `documentVerified` comes from the chain verdict the engine computed; it
 *    is never defaulted to true.
 *  - a policy that failed to load (`status !== "ok"`) reports `isDefault:
 *    true` with zero rules and an empty digest rather than pretending an
 *    unreadable document is in force.
 *  - `tokens()` returns [] when no enumerator is injected, because the
 *    capability issuer intentionally does not keep a queryable registry of
 *    minted bearer tokens. An empty list means "none enumerable here", and
 *    the pane says so rather than implying none exist.
 */
export function createGovReader(opts: GovWiringOptions): GovReader {
  return {
    identity(): GovIdentityView {
      const stack = opts.root();
      const loaded = stack.keystore.load();
      const chainOk = stack.chain.verify().ok;
      return identityView({
        publicKeyHex: publicKeyOf(loaded.identity),
        source: normalizeSource(loaded.source),
        rotationCount: loaded.rotations.length,
        documentVerified: chainOk,
        revokedCount: stack.keystore.revoked?.().length ?? 0,
      });
    },

    audit(verify: boolean): GovAuditView {
      const stack = opts.root();
      if (!verify) {
        // Cheap path: length only. `verified: false` here means NOT CHECKED,
        // and the pane renders it as BROKEN-unknown rather than as health —
        // which is the conservative direction for a security surface.
        const entries = stack.chain.entries?.().length ?? 0;
        return { length: entries, headHash: "", verified: false };
      }
      const v = stack.chain.verify();
      return auditView({
        entries: v.entries,
        headSha256: v.head?.sha256,
        ok: v.ok,
        brokenAt: v.brokenAt,
      });
    },

    policy(): GovPolicyView {
      const result = opts.root().policy.load();
      if (result.status !== "ok" || !result.bundle) {
        return { rules: [], digest: "", isDefault: true };
      }
      return {
        rules: result.bundle.doc.rules.map((r) => ({
          id: r.id,
          effect: r.effect === "deny" ? "deny" : "allow",
          resources: [...r.resources],
          actions: [...r.actions],
        })),
        digest: result.bundle.docSha256,
        isDefault: false,
      };
    },

    tokens(subject?: string): GovTokenView[] {
      const all = opts.listTokens?.() ?? [];
      return subject === undefined ? all : all.filter((t) => t.subject === subject);
    },

    airgap(): GovAirgapView {
      const report = opts.probeAirgap();
      const unverifiable = report.unverifiableSeams.length;
      return {
        egressBlocked: report.sealed,
        enforcedBy: report.sealed
          ? unverifiable > 0
            ? `sealed (${unverifiable} seam(s) unverifiable)`
            : "sealed (all seams verified)"
          : "not enforced",
      };
    },
  };
}

/** Compose the real {@link GovService}. Nothing is opened until a command runs. */
export function createRealGovService(opts: GovWiringOptions): GovService {
  return new GovService({ reader: createGovReader(opts) });
}
