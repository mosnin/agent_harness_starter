import type { CapabilityMinter, CapabilityToken } from "./tokens";

/**
 * A team's least-privilege policy. A role only ever receives the intersection of
 * what it *requests*, what the team *allows*, and (if present) its *per-role*
 * allow-list — minus anything explicitly *denied*. There is no path to more
 * privilege than the policy grants, which is what makes a Hades team safer than
 * a pool of workers that all share the manager's authority.
 */
export interface TeamPolicy {
  team: string;
  /** Capabilities allowed team-wide (`*` = all). */
  allow: string[];
  /** Optional per-role narrowing (role gets allow ∩ perRole[role]). */
  perRole?: Record<string, string[]>;
  /** Explicit denials — win over everything. */
  deny?: string[];
}

function allowsCap(list: string[], cap: string): boolean {
  return list.includes("*") || list.includes(cap);
}

/**
 * Compute the capabilities a role actually gets under a policy: deny-by-default
 * intersection of requested ∩ team-allow ∩ per-role, minus deny. Pure.
 */
export function scopedCapabilities(policy: TeamPolicy, role: string, requested: string[]): string[] {
  const denied = new Set(policy.deny ?? []);
  const roleAllow = policy.perRole?.[role];
  return requested.filter((cap) => {
    if (denied.has(cap)) return false;
    if (!allowsCap(policy.allow, cap)) return false;
    if (roleAllow && !allowsCap(roleAllow, cap)) return false;
    return true;
  });
}

/** Applies a {@link TeamPolicy} to grant and mint least-privilege tokens. */
export class LeastPrivilege {
  constructor(private readonly policy: TeamPolicy) {}

  grantsFor(role: string, requested: string[]): string[] {
    return scopedCapabilities(this.policy, role, requested);
  }

  wouldGrant(role: string, cap: string): boolean {
    return this.grantsFor(role, [cap]).length === 1;
  }

  /** Capabilities the policy stripped from a role's request (audit visibility). */
  strippedFor(role: string, requested: string[]): string[] {
    const granted = new Set(this.grantsFor(role, requested));
    return requested.filter((c) => !granted.has(c));
  }

  /**
   * Mint one least-privilege token per roster member: each member's role
   * capabilities are scoped down by the policy before the token is minted.
   */
  mintScopedTokens(
    minter: CapabilityMinter,
    roster: Array<{ agentId: string; role: string; capabilities: string[] }>,
    ttlMs?: number
  ): Map<string, CapabilityToken> {
    const out = new Map<string, CapabilityToken>();
    for (const m of roster) {
      const caps = this.grantsFor(m.role, m.capabilities);
      out.set(m.agentId, minter.mint({ agentId: m.agentId, team: this.policy.team, capabilities: caps, ttlMs }));
    }
    return out;
  }
}
