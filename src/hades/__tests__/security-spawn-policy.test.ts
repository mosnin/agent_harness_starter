import { describe, it, expect } from "vitest";
import { applySpawnPolicy, checkSpawnRequest } from "../security/spawn-policy";
import type { SpawnPolicy } from "../security/spawn-policy";

describe("applySpawnPolicy", () => {
  it("hardens by default: no network, read-only root, caps dropped", () => {
    const { limits, egressAllowlist } = applySpawnPolicy({});
    expect(limits.noNetwork).toBe(true);
    expect(limits.readOnlyRootFs).toBe(true);
    expect(limits.dropAllCapabilities).toBe(true);
    expect(egressAllowlist).toEqual([]);
  });

  it("clamps resources to policy maxima with warnings", () => {
    const policy: SpawnPolicy = { maxCpus: 2, maxMemoryMb: 1024, maxTimeoutMs: 60000 };
    const { limits, warnings } = applySpawnPolicy(policy, { cpus: 8, memoryMb: 4096, timeoutMs: 999999 });
    expect(limits.cpus).toBe(2);
    expect(limits.memory).toBe("1024m");
    expect(limits.timeoutMs).toBe(60000);
    expect(warnings.length).toBe(3);
  });

  it("keeps network OFF when requested but no allowlist exists", () => {
    const { limits, warnings } = applySpawnPolicy({}, { network: true });
    expect(limits.noNetwork).toBe(true);
    expect(warnings.some((w) => w.includes("no egress allowlist"))).toBe(true);
  });

  it("opens network only with an explicit request AND an allowlist", () => {
    const policy: SpawnPolicy = { egressAllowlist: ["api.internal", "registry.npmjs.org"] };
    const denied = applySpawnPolicy(policy, {}); // not requested
    expect(denied.limits.noNetwork).toBe(true);

    const opened = applySpawnPolicy(policy, { network: true });
    expect(opened.limits.noNetwork).toBe(false);
    expect(opened.egressAllowlist).toEqual(["api.internal", "registry.npmjs.org"]);
  });

  it("applies safe defaults when nothing is requested", () => {
    const { limits } = applySpawnPolicy({});
    expect(limits.cpus).toBe(1);
    expect(limits.memory).toBe("512m");
    expect(limits.timeoutMs).toBe(300000);
  });
});

describe("checkSpawnRequest (fail-closed gate)", () => {
  it("passes a compliant request and rejects violations", () => {
    const policy: SpawnPolicy = { maxCpus: 4, maxMemoryMb: 2048, egressAllowlist: ["h"] };
    expect(checkSpawnRequest(policy, { cpus: 2, memoryMb: 1024 })).toEqual({ ok: true, violations: [] });

    const bad = checkSpawnRequest(policy, { cpus: 8, memoryMb: 9999, network: true });
    expect(bad.ok).toBe(false); // resource caps exceeded (network itself is fine — allowlist present)
    expect(bad.violations).toEqual(["cpus exceeds max 4", "memoryMb exceeds max 2048"]);

    const noEgress = checkSpawnRequest({}, { network: true });
    expect(noEgress.ok).toBe(false);
    expect(noEgress.violations).toContain("network requested without egress allowlist");
  });
});
