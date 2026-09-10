/**
 * Secure-by-default spawn policy. Every containerized team member is brought up
 * **locked down** — no network, read-only root, all Linux capabilities dropped,
 * and resource ceilings — unless a request explicitly (and within policy) opens
 * something up. Network is the sharpest example: it stays OFF unless the caller
 * asks for it *and* the policy provides an egress allowlist. This is the "more
 * secure than Hermes" default: a spawned agent can't reach the network or the
 * host filesystem by accident.
 */

export interface SpawnPolicy {
  maxCpus?: number;
  maxMemoryMb?: number;
  maxTimeoutMs?: number;
  /** Default network posture when nothing is requested. Default: no network. */
  defaultNoNetwork?: boolean;
  /** Hosts a member may reach *if* network is opened. Empty = none. */
  egressAllowlist?: string[];
  /** Harden the root filesystem read-only. Default true. */
  readOnlyRootFs?: boolean;
  /** Drop all Linux capabilities. Default true. */
  dropAllCapabilities?: boolean;
}

export interface SpawnRequest {
  cpus?: number;
  memoryMb?: number;
  timeoutMs?: number;
  /** Explicitly request network access (still gated by the allowlist). */
  network?: boolean;
}

export interface HardenedLimits {
  cpus: number;
  memory: string;
  timeoutMs: number;
  noNetwork: boolean;
  readOnlyRootFs: boolean;
  dropAllCapabilities: boolean;
}

export interface HardenedSpawn {
  limits: HardenedLimits;
  /** Effective egress allowlist (empty when noNetwork). */
  egressAllowlist: string[];
  /** What the policy clamped or denied (audit visibility). */
  warnings: string[];
}

const DEFAULTS = {
  cpus: 1,
  memoryMb: 512,
  timeoutMs: 5 * 60 * 1000,
};

/**
 * Apply the policy to a (possibly absent) request, returning hardened limits.
 * Ceilings clamp requested values (recording a warning); network opens only when
 * explicitly requested AND an egress allowlist exists; fs/caps are hardened by
 * default. Pure.
 */
export function applySpawnPolicy(policy: SpawnPolicy, request: SpawnRequest = {}): HardenedSpawn {
  const warnings: string[] = [];

  const clamp = (label: string, requested: number | undefined, dflt: number, max: number | undefined): number => {
    let v = requested ?? dflt;
    if (max != null && v > max) {
      warnings.push(`${label} ${v} clamped to policy max ${max}`);
      v = max;
    }
    return v;
  };

  const cpus = clamp("cpus", request.cpus, DEFAULTS.cpus, policy.maxCpus);
  const memoryMb = clamp("memoryMb", request.memoryMb, DEFAULTS.memoryMb, policy.maxMemoryMb);
  const timeoutMs = clamp("timeoutMs", request.timeoutMs, DEFAULTS.timeoutMs, policy.maxTimeoutMs);

  const allowlist = policy.egressAllowlist ?? [];
  const networkRequested = request.network === true;
  let noNetwork: boolean;
  if (!networkRequested) {
    noNetwork = policy.defaultNoNetwork ?? true;
  } else if (allowlist.length === 0) {
    warnings.push("network requested but denied: policy has no egress allowlist");
    noNetwork = true;
  } else {
    noNetwork = false;
  }

  return {
    limits: {
      cpus,
      memory: `${memoryMb}m`,
      timeoutMs,
      noNetwork,
      readOnlyRootFs: policy.readOnlyRootFs ?? true,
      dropAllCapabilities: policy.dropAllCapabilities ?? true,
    },
    egressAllowlist: noNetwork ? [] : allowlist,
    warnings,
  };
}

export interface PolicyCheck {
  ok: boolean;
  violations: string[];
}

/** Reject a request that exceeds hard caps (for a strict, fail-closed gate). */
export function checkSpawnRequest(policy: SpawnPolicy, request: SpawnRequest): PolicyCheck {
  const violations: string[] = [];
  if (policy.maxCpus != null && (request.cpus ?? 0) > policy.maxCpus) violations.push(`cpus exceeds max ${policy.maxCpus}`);
  if (policy.maxMemoryMb != null && (request.memoryMb ?? 0) > policy.maxMemoryMb)
    violations.push(`memoryMb exceeds max ${policy.maxMemoryMb}`);
  if (policy.maxTimeoutMs != null && (request.timeoutMs ?? 0) > policy.maxTimeoutMs)
    violations.push(`timeoutMs exceeds max ${policy.maxTimeoutMs}`);
  if (request.network && (policy.egressAllowlist ?? []).length === 0) violations.push("network requested without egress allowlist");
  return { ok: violations.length === 0, violations };
}
