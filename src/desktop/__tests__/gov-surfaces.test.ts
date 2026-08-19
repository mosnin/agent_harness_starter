import { describe, it, expect } from "vitest";
import {
  isGovCommand,
  isGovEvent,
  isGovAuditView,
  isGovIdentityView,
  isGovPolicyView,
  isGovTokenView,
  GOV_COMMAND_KINDS,
  GOV_EVENT_KINDS,
  type GovCommand,
} from "../ipc/gov-contract";
import { GovService, auditView, identityView, type GovReader } from "../core/gov-service";
import { createGovReader, type GovStackLike } from "../core/gov-wiring";
import {
  initGovPane,
  renderGovPane,
  auditVerdict,
  identityVerdict,
  airgapVerdict,
  shortKey,
  DEFAULT_WIDTH,
} from "../../swarm-runtime/tui/gov-pane";

/** A real ESC byte, built without embedding a control character in source. */
const ESC = String.fromCharCode(27);

const IDENTITY = {
  publicKeyHex: "ab".repeat(32),
  generation: 2,
  keySource: "persisted" as const,
  documentVerified: true,
  revokedCount: 1,
};

function reader(over: Partial<GovReader> = {}): GovReader {
  return {
    identity: () => IDENTITY,
    audit: () => ({ length: 5, headHash: "cd".repeat(32), verified: true }),
    policy: () => ({ rules: [], digest: "ef".repeat(32), isDefault: true }),
    tokens: () => [],
    airgap: () => ({ egressBlocked: false, enforcedBy: "not enforced" }),
    ...over,
  };
}

describe("gov contract", () => {
  it("accepts every declared command kind", () => {
    for (const kind of GOV_COMMAND_KINDS) {
      expect(isGovCommand({ kind })).toBe(true);
    }
  });

  it("rejects unknown kinds and prototype-polluting payloads", () => {
    expect(isGovCommand({ kind: "gov.mint" })).toBe(false);
    expect(isGovCommand({ kind: "gov.rotate" })).toBe(false);
    expect(isGovCommand(null)).toBe(false);
    expect(isGovCommand(JSON.parse('{"kind":"gov.identity","__proto__":{}}'))).toBe(false);
  });

  it("exposes NO mutating command - the lane is read-only by construction", () => {
    const forbidden = ["mint", "rotate", "revoke", "attenuate", "write", "save", "delete"];
    for (const k of GOV_COMMAND_KINDS) {
      for (const bad of forbidden) expect(k).not.toContain(bad);
    }
  });

  it("refuses an audit view claiming verified AND a break index", () => {
    expect(isGovAuditView({ length: 3, headHash: "x", verified: false, brokenAtIndex: 2 })).toBe(true);
    expect(isGovAuditView({ length: 3, headHash: "x", verified: true, brokenAtIndex: 2 })).toBe(false);
  });

  it("validates identity, policy and token views", () => {
    expect(isGovIdentityView(IDENTITY)).toBe(true);
    expect(isGovIdentityView({ ...IDENTITY, keySource: "stolen" })).toBe(false);
    expect(isGovPolicyView({ rules: [], digest: "d", isDefault: true })).toBe(true);
    expect(
      isGovPolicyView({
        rules: [{ id: "r", effect: "allow", resources: ["fs"], actions: ["read"] }],
        digest: "d",
        isDefault: false,
      })
    ).toBe(true);
    expect(isGovTokenView({ id: "t", subject: "s", grants: ["fs=read"], spent: false, airgapOnly: false })).toBe(true);
  });

  it("accepts every declared event kind", () => {
    const at = 1;
    const samples: Record<string, unknown> = {
      "gov.identity": { kind: "gov.identity", identity: IDENTITY, at },
      "gov.audit": { kind: "gov.audit", audit: { length: 0, headHash: "", verified: true }, at },
      "gov.policy": { kind: "gov.policy", policy: { rules: [], digest: "d", isDefault: true }, at },
      "gov.tokens": { kind: "gov.tokens", tokens: [], at },
      "gov.airgap": { kind: "gov.airgap", airgap: { egressBlocked: true, enforcedBy: "HADES_AIRGAP=1" }, at },
      "gov.error": { kind: "gov.error", op: "gov.audit", message: "boom", at },
    };
    for (const kind of GOV_EVENT_KINDS) expect(isGovEvent(samples[kind])).toBe(true);
  });
});

describe("GovService", () => {
  it("answers each command with exactly one valid event", async () => {
    const svc = new GovService({ reader: reader(), now: () => 42 });
    for (const kind of GOV_COMMAND_KINDS) {
      const events = await svc.handle({ kind } as GovCommand);
      expect(events).toHaveLength(1);
      expect(isGovEvent(events[0])).toBe(true);
      expect(events[0].at).toBe(42);
    }
  });

  it("verifies the chain by default when the flag is omitted", async () => {
    const seen: boolean[] = [];
    const svc = new GovService({
      reader: reader({
        audit: (v) => {
          seen.push(v);
          return { length: 1, headHash: "h", verified: true };
        },
      }),
    });
    await svc.handle({ kind: "gov.audit" });
    await svc.handle({ kind: "gov.audit", verify: false });
    expect(seen).toEqual([true, false]);
  });

  it("turns a throwing reader into gov.error rather than silence", async () => {
    const svc = new GovService({
      reader: reader({
        audit: () => {
          throw new Error("chain unreadable");
        },
      }),
      now: () => 7,
    });
    const [ev] = await svc.handle({ kind: "gov.audit" });
    expect(ev).toEqual({ kind: "gov.error", op: "gov.audit", message: "chain unreadable", at: 7 });
  });

  it("passes the subject filter through to the reader", async () => {
    let got: string | undefined = "unset";
    const svc = new GovService({ reader: reader({ tokens: (s) => ((got = s), []) }) });
    await svc.handle({ kind: "gov.tokens", subject: "worker-1" });
    expect(got).toBe("worker-1");
  });

  it("auditView omits brokenAtIndex when verified, keeps it when broken", () => {
    expect(auditView({ entries: 2, headSha256: "h", ok: true, brokenAt: 1 })).not.toHaveProperty("brokenAtIndex");
    expect(auditView({ entries: 2, headSha256: "h", ok: false, brokenAt: 1 }).brokenAtIndex).toBe(1);
    expect(isGovAuditView(auditView({ entries: 2, headSha256: "h", ok: true, brokenAt: 1 }))).toBe(true);
  });

  it("identityView reports rotation COUNT as generation (0 when never rotated)", () => {
    const v = identityView({
      publicKeyHex: "ab".repeat(32),
      source: "generated",
      rotationCount: 0,
      documentVerified: true,
      revokedCount: 0,
    });
    expect(v.generation).toBe(0);
    expect(isGovIdentityView(v)).toBe(true);
  });
});

describe("gov TUI pane", () => {
  const full = initGovPane({
    identity: IDENTITY,
    audit: { length: 12, headHash: "cd".repeat(32), verified: true },
    policy: { ruleCount: 3, digest: "ef".repeat(32), isDefault: false },
    airgap: { egressBlocked: true, enforcedBy: "HADES_AIRGAP=1" },
  });

  it("never emits a line wider than the requested width", () => {
    for (const w of [24, 40, DEFAULT_WIDTH, 100]) {
      for (const line of renderGovPane(full, w)) expect([...line].length).toBeLessThanOrEqual(w);
    }
  });

  it("names the failing index on a broken chain, never a bare count", () => {
    expect(auditVerdict({ length: 9, headHash: "h", verified: false, brokenAtIndex: 4 })).toBe("BROKEN at #4");
    expect(auditVerdict({ length: 9, headHash: "h", verified: false })).toContain("BROKEN");
    const broken = renderGovPane(
      initGovPane({ audit: { length: 9, headHash: "h", verified: false, brokenAtIndex: 4 } })
    ).join("\n");
    expect(broken).toContain("BROKEN at #4");
    expect(broken).not.toMatch(/\bverified\b/);
  });

  it("flags an unverified identity document", () => {
    expect(identityVerdict({ ...IDENTITY, documentVerified: false })).toBe("UNVERIFIED");
    expect(identityVerdict(IDENTITY)).toBe("verified");
  });

  it("states plainly when egress is not enforced", () => {
    expect(airgapVerdict({ egressBlocked: false, enforcedBy: "" })).toContain("not enforced");
    expect(airgapVerdict({ egressBlocked: false, enforcedBy: "" })).toContain("ALLOWED");
    expect(airgapVerdict({ egressBlocked: true, enforcedBy: "HADES_AIRGAP=1" })).toContain("blocked");
  });

  it("shows an error instead of possibly-stale values", () => {
    const out = renderGovPane(initGovPane({ identity: IDENTITY, error: "keystore locked" })).join("\n");
    expect(out).toContain("keystore locked");
    expect(out).not.toContain(shortKey(IDENTITY.publicKeyHex));
  });

  it("strips control characters so upstream text cannot inject escapes", () => {
    const out = renderGovPane(
      initGovPane({ airgap: { egressBlocked: false, enforcedBy: ESC + "[2Jmalicious" } })
    ).join("\n");
    expect(out).not.toContain(ESC);
    expect(out).toContain("malicious");
  });

  it("renders an empty state rather than a misleading blank box", () => {
    expect(renderGovPane(initGovPane()).join("\n")).toContain("no governance data reported");
  });

  it("abbreviates keys and never prints a full 64-char blob", () => {
    expect(shortKey("ab".repeat(32))).toBe("abababab…abababab");
    expect(shortKey("short")).toBe("short");
  });
});


describe("gov wiring over the real stack shape", () => {
  function stack(over: Partial<GovStackLike> = {}): GovStackLike {
    return {
      keystore: {
        load: () => ({ identity: { publicKeyHex: "ab".repeat(32) }, source: "persisted", rotations: [1, 2] }),
        revoked: () => ["k1"],
      },
      chain: {
        verify: () => ({ ok: true, entries: 4, head: { sha256: "cd".repeat(32) } }),
        entries: () => [1, 2, 3, 4],
      },
      policy: { load: () => ({ status: "absent" }) },
      ...over,
    } as GovStackLike;
  }

  const sealed = () => ({ sealed: true, unverifiableSeams: [] as unknown[] });

  it("does not open the stack until a command actually runs", async () => {
    let opened = 0;
    const reader = createGovReader({
      root: () => (opened++, stack()),
      probeAirgap: sealed,
    });
    expect(opened).toBe(0);
    await reader.identity();
    expect(opened).toBeGreaterThan(0);
  });

  it("reports rotation count as generation and never a private key", async () => {
    const v = await createGovReader({ root: () => stack(), probeAirgap: sealed }).identity();
    expect(v.generation).toBe(2);
    expect(v.revokedCount).toBe(1);
    expect(v.publicKeyHex).toBe("ab".repeat(32));
    expect(JSON.stringify(v)).not.toMatch(/private|secret|seed/i);
  });

  it("never claims a verified document when the chain fails", async () => {
    const broken = stack({ chain: { verify: () => ({ ok: false, entries: 4, brokenAt: 2 }) } as never });
    const v = await createGovReader({ root: () => broken, probeAirgap: sealed }).identity();
    expect(v.documentVerified).toBe(false);
  });

  it("carries brokenAtIndex through on a failed chain", async () => {
    const broken = stack({ chain: { verify: () => ({ ok: false, entries: 9, brokenAt: 3 }) } as never });
    const a = await createGovReader({ root: () => broken, probeAirgap: sealed }).audit(true);
    expect(a).toMatchObject({ verified: false, brokenAtIndex: 3, length: 9 });
    expect(isGovAuditView(a)).toBe(true);
  });

  it("reports the unverified path as NOT verified rather than as healthy", async () => {
    const a = await createGovReader({ root: () => stack(), probeAirgap: sealed }).audit(false);
    expect(a.verified).toBe(false);
    expect(a.length).toBe(4);
  });

  it("treats an unreadable policy as default rather than pretending it is in force", async () => {
    const p = await createGovReader({ root: () => stack(), probeAirgap: sealed }).policy();
    expect(p).toEqual({ rules: [], digest: "", isDefault: true });
    expect(isGovPolicyView(p)).toBe(true);
  });

  it("maps a loaded policy's rules faithfully", async () => {
    const withPolicy = stack({
      policy: {
        load: () => ({
          status: "ok",
          bundle: {
            doc: { rules: [{ id: "r1", effect: "deny", resources: ["net"], actions: ["connect"] }] },
            docSha256: "ff".repeat(32),
          },
        }),
      } as never,
    });
    const p = await createGovReader({ root: () => withPolicy, probeAirgap: sealed }).policy();
    expect(p.isDefault).toBe(false);
    expect(p.rules[0]).toEqual({ id: "r1", effect: "deny", resources: ["net"], actions: ["connect"] });
    expect(isGovPolicyView(p)).toBe(true);
  });

  it("names unverifiable seams instead of implying a perfect seal", async () => {
    const a = await createGovReader({
      root: () => stack(),
      probeAirgap: () => ({ sealed: true, unverifiableSeams: ["dns"] }),
    }).airgap();
    expect(a.egressBlocked).toBe(true);
    expect(a.enforcedBy).toContain("unverifiable");
  });

  it("reports not-enforced egress plainly", async () => {
    const a = await createGovReader({
      root: () => stack(),
      probeAirgap: () => ({ sealed: false, unverifiableSeams: [] }),
    }).airgap();
    expect(a).toEqual({ egressBlocked: false, enforcedBy: "not enforced" });
  });

  it("filters tokens by subject", async () => {
    const reader = createGovReader({
      root: () => stack(),
      probeAirgap: sealed,
      listTokens: () => [
        { id: "a", subject: "s1", grants: [], spent: false, airgapOnly: false },
        { id: "b", subject: "s2", grants: [], spent: false, airgapOnly: false },
      ],
    });
    expect((await reader.tokens()).length).toBe(2);
    expect((await reader.tokens("s2")).map((t) => t.id)).toEqual(["b"]);
  });
});
