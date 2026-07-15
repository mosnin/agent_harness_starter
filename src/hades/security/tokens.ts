/**
 * Per-agent capability tokens — the non-human-identity (NHI) primitive. Every
 * team member gets a token scoping exactly what it may do, minted per membership
 * and expiring. This is the base for the deny-by-default A2A/spawn checks that
 * make Hades more locked-down than a flat worker pool. Signing is layered on in
 * the next iteration; here it's mint + scope + expiry.
 */

export interface CapabilityToken {
  tokenId: string;
  agentId: string;
  team: string;
  /** Capabilities this agent is authorized for (`*` = all). */
  capabilities: string[];
  issuedAt: number;
  /** Absolute expiry (ms); omit for non-expiring. */
  expiresAt?: number;
  /** Signature over the token body (set by the signer in iter 22). */
  signature?: string;
}

export interface MinterOptions {
  now?: () => number;
  /** Default token lifetime (ms). Omit for non-expiring by default. */
  ttlMs?: number;
  /** Deterministic id generator for tests. */
  idGen?: () => string;
}

export interface MintInput {
  agentId: string;
  team: string;
  capabilities: string[];
  ttlMs?: number;
}

/** Mints capability tokens for agents joining a team. */
export class CapabilityMinter {
  private readonly now: () => number;
  private readonly defaultTtl?: number;
  private readonly idGen: () => string;
  private seq = 0;

  constructor(opts: MinterOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.defaultTtl = opts.ttlMs;
    this.idGen = opts.idGen ?? (() => `tok-${++this.seq}`);
  }

  mint(input: MintInput): CapabilityToken {
    const issuedAt = this.now();
    const ttl = input.ttlMs ?? this.defaultTtl;
    return {
      tokenId: this.idGen(),
      agentId: input.agentId,
      team: input.team,
      capabilities: [...input.capabilities],
      issuedAt,
      ...(ttl != null ? { expiresAt: issuedAt + ttl } : {}),
    };
  }

  /** Mint one token per roster member, keyed by agentId. */
  mintForTeam(team: string, members: Array<{ agentId: string; capabilities: string[] }>, ttlMs?: number): Map<string, CapabilityToken> {
    const out = new Map<string, CapabilityToken>();
    for (const m of members) out.set(m.agentId, this.mint({ agentId: m.agentId, team, capabilities: m.capabilities, ttlMs }));
    return out;
  }
}

export interface CheckerOptions {
  now?: () => number;
}

/** Validates tokens and authorizes capabilities (deny-by-default). */
export class CapabilityChecker {
  private readonly now: () => number;

  constructor(opts: CheckerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Not expired (and structurally present). */
  isValid(token: CapabilityToken): boolean {
    if (!token.tokenId || !token.agentId) return false;
    if (token.expiresAt != null && this.now() >= token.expiresAt) return false;
    return true;
  }

  /** True iff the token is valid AND grants the capability (or holds `*`). */
  authorize(token: CapabilityToken, capability: string): boolean {
    if (!this.isValid(token)) return false;
    return token.capabilities.includes("*") || token.capabilities.includes(capability);
  }

  /** Throw unless authorized — for guard call sites. */
  assert(token: CapabilityToken, capability: string): void {
    if (!this.isValid(token)) throw new Error(`token ${token.tokenId} invalid or expired`);
    if (!this.authorize(token, capability)) {
      throw new Error(`agent ${token.agentId} not authorized for capability: ${capability}`);
    }
  }
}
