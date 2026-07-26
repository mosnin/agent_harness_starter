/**
 * policy.test.ts
 *
 * REAL-VS-MOCK POLICY: every crypto-touching assertion (the composition
 * tests near the bottom) uses a real `GovIdentity` and the real
 * `CapabilityIssuer`/`CapabilityEnforcer` from `../capability` — nothing is
 * mocked. The bulk of this file exercises `PolicyEngine` directly, which is
 * itself pure/deterministic given an injected `now`/`req.at`, so there is
 * nothing to mock there either: every clock value in every test is an
 * explicit number, never `Date.now()`.
 */

import { describe, it, expect } from "vitest";

import {
  PolicyEngine,
  parsePolicyDocument,
  DEFAULT_GOV_POLICY,
  type PolicyDocument,
  type PolicyRule,
  type PolicyRequest,
  type PolicyAuditSink,
  type PolicyCondition,
} from "../policy";
import { GovIdentity } from "../identity";
import { CapabilityIssuer, CapabilityEnforcer } from "../capability";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseReq(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return { subject: "agent:alice", action: "fs:read", resource: "fs:/workspace/x", at: 1000, ...overrides };
}

function rule(overrides: Partial<PolicyRule> & Pick<PolicyRule, "id" | "effect">): PolicyRule {
  return { subjects: ["*"], actions: ["*"], resources: ["**"], ...overrides };
}

function doc(rules: PolicyRule[], overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return { schema: "hades.gov.policy.v1", name: "test", version: 1, defaultEffect: "deny", rules, ...overrides };
}

class MemoryAuditSink implements PolicyAuditSink {
  records: Array<{ at: number; actor: string; action: string; resource: string; outcome: "allow" | "deny" | "info"; code?: string; payload?: unknown }> = [];
  record(input: { at: number; actor: string; action: string; resource: string; outcome: "allow" | "deny" | "info"; code?: string; payload?: unknown }): void {
    this.records.push(input);
  }
}

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe("PolicyEngine basic matching", () => {
  it("allows via an explicit matching allow rule", () => {
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow" })]));
    const d = engine.evaluate(baseReq());
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("r1");
  });

  it("falls back to defaultEffect when no rule matches at all", () => {
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow", actions: ["net:egress"] })]));
    const d = engine.evaluate(baseReq());
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBeUndefined();
    expect(d.reason).toMatch(/default effect/);
  });

  it("empty-policy document denies by default (defaultEffect deny, zero rules)", () => {
    const engine = PolicyEngine.compile(doc([]));
    const d = engine.evaluate(baseReq());
    expect(d.effect).toBe("deny");
    expect(d.trace).toEqual([]);
  });

  it("subject/action/resource wildcards ('*' and resource '**') match broadly", () => {
    const engine = PolicyEngine.compile(
      doc([rule({ id: "r1", effect: "allow", subjects: ["*"], actions: ["*"], resources: ["fs:/workspace/**"] })]),
    );
    expect(engine.evaluate(baseReq({ resource: "fs:/workspace/a/b/c.txt" })).effect).toBe("allow");
    expect(engine.evaluate(baseReq({ resource: "fs:/other/a.txt" })).effect).toBe("deny");
  });

  it("a resource '*' entry matches only single-segment resources, never multi-segment paths", () => {
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow", resources: ["*"] })]));
    expect(engine.evaluate(baseReq({ resource: "spawn" })).effect).toBe("allow");
    expect(engine.evaluate(baseReq({ resource: "fs:/workspace/x" })).effect).toBe("deny");
  });

  it("net: resource host segments are matched case-insensitively", () => {
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow", actions: ["net:egress"], resources: ["net:API.EXAMPLE.COM"] })]));
    const d = engine.evaluate(baseReq({ action: "net:egress", resource: "net:api.example.com" }));
    expect(d.effect).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Bar (1): truth table over matched/unmatched x allow/deny x priority x specificity
// ---------------------------------------------------------------------------

describe("PolicyEngine truth table — deterministic winner selection", () => {
  const cases: Array<{
    name: string;
    rules: PolicyRule[];
    req: PolicyRequest;
    expectEffect: "allow" | "deny";
    expectRuleId: string | undefined;
  }> = [
    {
      name: "single unmatched rule -> default deny",
      rules: [rule({ id: "r1", effect: "allow", actions: ["spawn"] })],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: undefined,
    },
    {
      name: "single matched allow -> allow",
      rules: [rule({ id: "r1", effect: "allow" })],
      req: baseReq(),
      expectEffect: "allow",
      expectRuleId: "r1",
    },
    {
      name: "single matched deny -> deny",
      rules: [rule({ id: "r1", effect: "deny" })],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: "r1",
    },
    {
      name: "equal priority: deny-overrides beats allow regardless of order",
      rules: [rule({ id: "allow", effect: "allow" }), rule({ id: "deny", effect: "deny" })],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: "deny",
    },
    {
      name: "equal priority: deny-overrides beats allow even when deny is declared first",
      rules: [rule({ id: "deny", effect: "deny" }), rule({ id: "allow", effect: "allow" })],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: "deny",
    },
    {
      name: "higher priority allow beats lower priority deny",
      rules: [rule({ id: "deny", effect: "deny", priority: 0 }), rule({ id: "allow", effect: "allow", priority: 10 })],
      req: baseReq(),
      expectEffect: "allow",
      expectRuleId: "allow",
    },
    {
      name: "higher priority deny beats lower priority allow",
      rules: [rule({ id: "allow", effect: "allow", priority: 5 }), rule({ id: "deny", effect: "deny", priority: 10 })],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: "deny",
    },
    {
      name: "equal priority + equal effect: more specific (fewer wildcards) wins",
      rules: [
        rule({ id: "broad", effect: "allow", resources: ["**"] }),
        rule({ id: "narrow", effect: "allow", resources: ["fs:/workspace/x"] }),
      ],
      req: baseReq(),
      expectEffect: "allow",
      expectRuleId: "narrow",
    },
    {
      name: "equal priority + equal effect + equal specificity: earlier rule index wins",
      rules: [rule({ id: "first", effect: "allow" }), rule({ id: "second", effect: "allow" })],
      req: baseReq(),
      expectEffect: "allow",
      expectRuleId: "first",
    },
    {
      name: "a rule that fails its condition does not count as matched",
      rules: [
        rule({ id: "conditioned", effect: "allow", conditions: [{ kind: "identity-role", role: "admin" }] }),
        rule({ id: "fallback", effect: "allow", priority: -1 }),
      ],
      req: baseReq({ subjectRoles: [] }),
      expectEffect: "allow",
      expectRuleId: "fallback",
    },
    {
      name: "three-way: deny beats allow beats (unreached) lower-priority deny",
      rules: [
        rule({ id: "low-deny", effect: "deny", priority: -5 }),
        rule({ id: "mid-allow", effect: "allow", priority: 0 }),
        rule({ id: "top-deny", effect: "deny", priority: 0 }),
      ],
      req: baseReq(),
      expectEffect: "deny",
      expectRuleId: "top-deny",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const engine = PolicyEngine.compile(doc(c.rules));
      const d = engine.evaluate(c.req);
      expect(d.effect).toBe(c.expectEffect);
      expect(d.ruleId).toBe(c.expectRuleId);
    });
  }

  it("obligations accumulate from every matched rule sharing the winning priority+effect, in rule order", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "a", effect: "allow", obligations: [{ kind: "audit", level: "summary" }] }),
        rule({ id: "b", effect: "allow", obligations: [{ kind: "confirm", prompt: "p" }] }),
        rule({ id: "c", effect: "deny", priority: -1, obligations: [{ kind: "abstain", reason: "unreached" }] }),
      ]),
    );
    const d = engine.evaluate(baseReq());
    expect(d.effect).toBe("allow");
    expect(d.obligations).toEqual([{ kind: "audit", level: "summary" }, { kind: "confirm", prompt: "p" }]);
  });

  it("obligations from a rule that did not win (lower priority) are excluded", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "loser", effect: "allow", priority: 0, obligations: [{ kind: "abstain", reason: "should not appear" }] }),
        rule({ id: "winner", effect: "deny", priority: 10, obligations: [{ kind: "audit", level: "full" }] }),
      ]),
    );
    const d = engine.evaluate(baseReq());
    expect(d.obligations).toEqual([{ kind: "audit", level: "full" }]);
  });
});

// ---------------------------------------------------------------------------
// Bar (2): explain() trace for EVERY rule, deterministic across runs/orderings
// ---------------------------------------------------------------------------

describe("PolicyEngine.explain — full, deterministic trace", () => {
  it("includes a trace step for every rule, matched and unmatched", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "matches", effect: "allow" }),
        rule({ id: "wrong-action", effect: "allow", actions: ["spawn"] }),
        rule({ id: "wrong-resource", effect: "allow", resources: ["net:*"] }),
        rule({ id: "fails-condition", effect: "allow", conditions: [{ kind: "identity-role", role: "admin" }] }),
      ]),
    );
    const d = engine.explain(baseReq());
    expect(d.trace).toHaveLength(4);
    expect(d.trace.map((t) => t.ruleId)).toEqual(["matches", "wrong-action", "wrong-resource", "fails-condition"]);
    expect(d.trace[0]).toMatchObject({ ruleId: "matches", matched: true });
    expect(d.trace[1]).toMatchObject({ ruleId: "wrong-action", matched: false });
    expect(d.trace[2]).toMatchObject({ ruleId: "wrong-resource", matched: false });
    expect(d.trace[3].matched).toBe(false);
    expect(d.trace[3].failedCondition).toEqual({ kind: "identity-role", role: "admin" });
  });

  it("names the SPECIFIC failed condition, not just 'condition failed'", () => {
    const engine = PolicyEngine.compile(
      doc([rule({ id: "r1", effect: "allow", conditions: [{ kind: "risk-budget", minRemaining: 0.5 }] })]),
    );
    const d = engine.explain(baseReq({ riskRemaining: 0.1 }));
    expect(d.trace[0].failedCondition).toEqual({ kind: "risk-budget", minRemaining: 0.5 });
    expect(d.trace[0].reason).toMatch(/risk-budget/);
  });

  it("is stable across repeated calls and across documents built with different JSON key orderings", () => {
    const literalA = { id: "r1", effect: "allow", subjects: ["*"], actions: ["*"], resources: ["*"] };
    const literalB = { resources: ["*"], actions: ["*"], subjects: ["*"], effect: "allow", id: "r1" };
    const docA = doc([literalA as PolicyRule]);
    const docB = doc([literalB as PolicyRule]);

    const parsedA = parsePolicyDocument(JSON.parse(JSON.stringify(docA)));
    const parsedB = parsePolicyDocument(JSON.parse(JSON.stringify(docB)));
    expect(parsedA.ok).toBe(true);
    expect(parsedB.ok).toBe(true);
    if (!parsedA.ok || !parsedB.ok) throw new Error("unreachable");

    const engineA = PolicyEngine.compile(parsedA.doc);
    const engineB = PolicyEngine.compile(parsedB.doc);

    const traceA1 = engineA.explain(baseReq()).trace;
    const traceA2 = engineA.explain(baseReq()).trace;
    const traceB = engineB.explain(baseReq()).trace;
    expect(traceA1).toEqual(traceA2);
    expect(traceA1).toEqual(traceB);
  });

  it("explain() never mutates rate-limit state (pure dry-run), evaluate() does", () => {
    const engine = PolicyEngine.compile(
      doc([rule({ id: "r1", effect: "allow", conditions: [{ kind: "rate-limit", maxPerWindow: 1, windowMs: 1000 }] })]),
    );
    // Calling explain repeatedly must never consume the budget.
    for (let i = 0; i < 5; i++) {
      expect(engine.explain(baseReq({ at: 100 })).effect).toBe("allow");
    }
    // The real evaluate() call still has full budget available.
    expect(engine.evaluate(baseReq({ at: 100 })).effect).toBe("allow");
    // And is now exhausted for a second evaluate() within the window.
    expect(engine.evaluate(baseReq({ at: 150 })).effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Bar (3): every condition kind — satisfied / violated / boundary
// ---------------------------------------------------------------------------

describe("PolicyEngine conditions — satisfied / violated / boundary per kind", () => {
  function engineWith(cond: PolicyCondition): PolicyEngine {
    return PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow", conditions: [cond] })]));
  }

  describe("time-window", () => {
    const cond: PolicyCondition = { kind: "time-window", startMs: 1000, endMs: 2000 };
    it("satisfied strictly inside the window", () => {
      expect(engineWith(cond).evaluate(baseReq({ at: 1500 })).effect).toBe("allow");
    });
    it("violated before the window", () => {
      expect(engineWith(cond).evaluate(baseReq({ at: 999 })).effect).toBe("deny");
    });
    it("violated at/after the window end", () => {
      expect(engineWith(cond).evaluate(baseReq({ at: 2000 })).effect).toBe("deny");
    });
    it("boundary: start is inclusive", () => {
      expect(engineWith(cond).evaluate(baseReq({ at: 1000 })).effect).toBe("allow");
    });
    it("boundary: end - 1 is the last satisfied instant", () => {
      expect(engineWith(cond).evaluate(baseReq({ at: 1999 })).effect).toBe("allow");
    });
  });

  describe("airgap", () => {
    it("required=true satisfied when airgapped", () => {
      expect(engineWith({ kind: "airgap", required: true }).evaluate(baseReq({ airgapped: true })).effect).toBe("allow");
    });
    it("required=true violated when not airgapped", () => {
      expect(engineWith({ kind: "airgap", required: true }).evaluate(baseReq({ airgapped: false })).effect).toBe("deny");
    });
    it("required=false satisfied when not airgapped", () => {
      expect(engineWith({ kind: "airgap", required: false }).evaluate(baseReq({ airgapped: false })).effect).toBe("allow");
    });
    it("boundary: airgapped omitted entirely counts as not-airgapped", () => {
      expect(engineWith({ kind: "airgap", required: false }).evaluate(baseReq({})).effect).toBe("allow");
      expect(engineWith({ kind: "airgap", required: true }).evaluate(baseReq({})).effect).toBe("deny");
    });
  });

  describe("capability", () => {
    const cond: PolicyCondition = { kind: "capability", resource: "fs:write:/workspace/x" };
    it("satisfied when a held capability covers the resource", () => {
      expect(engineWith(cond).evaluate(baseReq({ capabilities: ["fs:write:/workspace/**"] })).effect).toBe("allow");
    });
    it("violated when no held capability covers it", () => {
      expect(engineWith(cond).evaluate(baseReq({ capabilities: ["fs:read:/workspace/**"] })).effect).toBe("deny");
    });
    it("boundary: capabilities omitted entirely violates", () => {
      expect(engineWith(cond).evaluate(baseReq({})).effect).toBe("deny");
    });
  });

  describe("arg-equals", () => {
    const cond: PolicyCondition = { kind: "arg-equals", arg: "env", value: "prod" };
    it("satisfied on exact match", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { env: "prod" } })).effect).toBe("allow");
    });
    it("violated on mismatch", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { env: "dev" } })).effect).toBe("deny");
    });
    it("boundary: type mismatch (number 1 vs string '1') violates (strict ===)", () => {
      const numCond: PolicyCondition = { kind: "arg-equals", arg: "n", value: 1 };
      expect(engineWith(numCond).evaluate(baseReq({ args: { n: "1" } })).effect).toBe("deny");
      expect(engineWith(numCond).evaluate(baseReq({ args: { n: 1 } })).effect).toBe("allow");
    });
  });

  describe("arg-matches", () => {
    const cond: PolicyCondition = { kind: "arg-matches", arg: "key", pattern: "^[a-z]+$" };
    it("satisfied when the regex matches", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { key: "abc" } })).effect).toBe("allow");
    });
    it("violated when the regex does not match", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { key: "ABC" } })).effect).toBe("deny");
    });
    it("boundary: an invalid regex pattern fails closed rather than throwing", () => {
      const bad: PolicyCondition = { kind: "arg-matches", arg: "key", pattern: "(" };
      expect(() => engineWith(bad).evaluate(baseReq({ args: { key: "abc" } }))).not.toThrow();
      expect(engineWith(bad).evaluate(baseReq({ args: { key: "abc" } })).effect).toBe("deny");
    });
  });

  describe("risk-budget", () => {
    const cond: PolicyCondition = { kind: "risk-budget", minRemaining: 0.3 };
    it("satisfied when comfortably above the floor", () => {
      expect(engineWith(cond).evaluate(baseReq({ riskRemaining: 0.9 })).effect).toBe("allow");
    });
    it("violated when below the floor", () => {
      expect(engineWith(cond).evaluate(baseReq({ riskRemaining: 0.1 })).effect).toBe("deny");
    });
    it("boundary: exactly at minRemaining is satisfied (>=)", () => {
      expect(engineWith(cond).evaluate(baseReq({ riskRemaining: 0.3 })).effect).toBe("allow");
    });
  });

  describe("identity-role", () => {
    const cond: PolicyCondition = { kind: "identity-role", role: "orchestrator" };
    it("satisfied when the subject holds the role", () => {
      expect(engineWith(cond).evaluate(baseReq({ subjectRoles: ["orchestrator", "reader"] })).effect).toBe("allow");
    });
    it("violated when the subject lacks the role", () => {
      expect(engineWith(cond).evaluate(baseReq({ subjectRoles: ["reader"] })).effect).toBe("deny");
    });
    it("boundary: subjectRoles omitted entirely violates", () => {
      expect(engineWith(cond).evaluate(baseReq({})).effect).toBe("deny");
    });
  });

  describe("rate-limit", () => {
    const cond: PolicyCondition = { kind: "rate-limit", maxPerWindow: 2, windowMs: 1000 };
    it("satisfied for calls within the budget, violated on the N+1th call within the window, satisfied again just outside it", () => {
      const engine = engineWith(cond);
      // Calls 1 and 2 (the Nth call) succeed.
      expect(engine.evaluate(baseReq({ at: 0 })).effect).toBe("allow");
      expect(engine.evaluate(baseReq({ at: 100 })).effect).toBe("allow");
      // Call 3 (N+1th), still inside the window, is refused.
      expect(engine.evaluate(baseReq({ at: 200 })).effect).toBe("deny");
      // A call at exactly windowMs after the FIRST grant has fully aged that
      // grant out of the sliding window (only call #2 at t=100 remains
      // active, so budget is 1/2) and succeeds.
      expect(engine.evaluate(baseReq({ at: 1000 })).effect).toBe("allow");
    });
    it("is scoped per (rule, subject) — a different subject gets its own independent budget", () => {
      const engine = engineWith(cond);
      expect(engine.evaluate(baseReq({ subject: "agent:a", at: 0 })).effect).toBe("allow");
      expect(engine.evaluate(baseReq({ subject: "agent:a", at: 10 })).effect).toBe("allow");
      expect(engine.evaluate(baseReq({ subject: "agent:a", at: 20 })).effect).toBe("deny");
      expect(engine.evaluate(baseReq({ subject: "agent:b", at: 20 })).effect).toBe("allow");
    });
  });

  describe("resource-under", () => {
    const cond: PolicyCondition = { kind: "resource-under", root: "/data" };
    it("satisfied for a path genuinely under the root", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/data/foo/bar.txt" } })).effect).toBe("allow");
    });
    it("violated for a sibling directory", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/other/foo.txt" } })).effect).toBe("deny");
    });
    it("boundary: defeats '..' traversal out of the root", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/data/../etc/passwd" } })).effect).toBe("deny");
    });
    it("boundary: defeats percent-encoded traversal", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/data/%2e%2e/%2e%2e/etc/passwd" } })).effect).toBe("deny");
    });
    it("boundary: defeats prefix confusion ('/data-evil' is NOT under '/data')", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/data-evil/x" } })).effect).toBe("deny");
    });
    it("boundary: the root itself is under the root", () => {
      expect(engineWith(cond).evaluate(baseReq({ args: { path: "/data" } })).effect).toBe("allow");
    });
  });
});

// ---------------------------------------------------------------------------
// Bar (4): parsePolicyDocument — strict rejection, never throws
// ---------------------------------------------------------------------------

describe("parsePolicyDocument", () => {
  function validRule(id = "r1"): Record<string, unknown> {
    return { id, effect: "allow", subjects: ["*"], actions: ["*"], resources: ["*"] };
  }
  function validDoc(rules: unknown[] = [validRule()]): Record<string, unknown> {
    return { schema: "hades.gov.policy.v1", name: "n", version: 1, defaultEffect: "deny", rules };
  }

  it("accepts a well-formed document", () => {
    const r = parsePolicyDocument(validDoc());
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong schema string", () => {
    const r = parsePolicyDocument({ ...validDoc(), schema: "hades.gov.policy.v2" } as object);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("schema"))).toBe(true);
  });

  it("rejects a non-integer version", () => {
    const r = parsePolicyDocument({ ...validDoc(), version: 1.5 } as object);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects duplicate rule ids", () => {
    const r = parsePolicyDocument(validDoc([validRule("dup"), validRule("dup")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("duplicate") && e.includes("dup"))).toBe(true);
  });

  it("rejects an unknown condition kind", () => {
    const rule = { ...(validRule() as object), conditions: [{ kind: "time-travel", at: 1 }] };
    const r = parsePolicyDocument(validDoc([rule]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("unknown condition kind"))).toBe(true);
  });

  it("rejects an unknown obligation kind", () => {
    const rule = { ...(validRule() as object), obligations: [{ kind: "teleport" }] };
    const r = parsePolicyDocument(validDoc([rule]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("unknown obligation kind"))).toBe(true);
  });

  it("rejects a non-array rules field", () => {
    const r = parsePolicyDocument({ ...validDoc(), rules: "nope" } as object);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("$.rules"))).toBe(true);
  });

  it("rejects null-prototype objects instead of crashing or silently accepting them", () => {
    const nullProtoRule = Object.assign(Object.create(null), validRule());
    const r1 = parsePolicyDocument(validDoc([nullProtoRule]));
    expect(r1.ok).toBe(false);

    const nullProtoDoc = Object.assign(Object.create(null), validDoc());
    const r2 = parsePolicyDocument(nullProtoDoc);
    expect(r2.ok).toBe(false);
  });

  it("rejects a rule with empty subjects/actions/resources", () => {
    const rule = { id: "r1", effect: "allow", subjects: [], actions: ["*"], resources: ["*"] };
    const r = parsePolicyDocument(validDoc([rule]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes(".subjects"))).toBe(true);
  });

  it("never throws on wildly malformed input", () => {
    const inputs: unknown[] = [null, undefined, 42, "string", [], () => {}, new Date(), Symbol("x")];
    for (const input of inputs) {
      expect(() => parsePolicyDocument(input)).not.toThrow();
      expect(parsePolicyDocument(input).ok).toBe(false);
    }
  });

  it("parses and compiles a 10k-rule document without pathological slowdown", () => {
    const rules = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${i}`,
      effect: i % 2 === 0 ? "allow" : "deny",
      subjects: ["*"],
      actions: [`action:${i}`],
      resources: ["*"],
    }));
    const started = Date.now();
    const r = parsePolicyDocument(validDoc(rules));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const engine = PolicyEngine.compile(r.doc);
    const d = engine.evaluate(baseReq({ action: "action:9999" }));
    const elapsedMs = Date.now() - started;
    expect(d.effect).toBe("deny"); // action:9999 is odd -> deny rule
    expect(d.trace).toHaveLength(10_000);
    expect(elapsedMs).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Bar (5): lint() — real defects on hand-built fixtures
// ---------------------------------------------------------------------------

describe("PolicyEngine.lint", () => {
  it("flags a rule shadowed by an earlier broader deny", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "broad-deny", effect: "deny", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/data/**"] }),
        rule({ id: "narrow-allow", effect: "allow", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/data/secret.txt"] }),
      ]),
    );
    const findings = engine.lint();
    const shadow = findings.find((f) => f.code === "shadowed-rule");
    expect(shadow).toBeDefined();
    expect(shadow?.ruleIds).toEqual(["narrow-allow", "broad-deny"]);
  });

  it("flags two rules that contradict on an identical matcher", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "allow-x", effect: "allow", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/x"] }),
        rule({ id: "deny-x", effect: "deny", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/x"] }),
      ]),
    );
    const findings = engine.lint();
    const contradiction = findings.find((f) => f.code === "contradictory-rules");
    expect(contradiction).toBeDefined();
    expect(contradiction?.ruleIds.sort()).toEqual(["allow-x", "deny-x"]);
  });

  it("flags an unreachable rule that sits after a dominant catch-all", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "catch-all-deny", effect: "deny", subjects: ["*"], actions: ["*"], resources: ["*"] }),
        rule({ id: "never-reached", effect: "allow", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/x"] }),
      ]),
    );
    const findings = engine.lint();
    const unreachable = findings.find((f) => f.code === "unreachable-rule");
    expect(unreachable).toBeDefined();
    expect(unreachable?.ruleIds).toEqual(["never-reached", "catch-all-deny"]);
  });

  it("flags an unbounded '*' wildcard allow on a destructive action", () => {
    const engine = PolicyEngine.compile(
      doc([rule({ id: "yolo", effect: "allow", subjects: ["*"], actions: ["fs:write"], resources: ["*"] })]),
    );
    const findings = engine.lint();
    expect(findings.some((f) => f.code === "unbounded-wildcard" && f.ruleIds.includes("yolo"))).toBe(true);
  });

  it("flags a document whose defaultEffect is allow", () => {
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "deny" })], { defaultEffect: "allow" }));
    const findings = engine.lint();
    expect(findings.some((f) => f.code === "no-deny-default")).toBe(true);
  });

  it("also flags duplicate-id and empty-matcher on directly-compiled (not parsed) documents", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "dup", effect: "allow" }),
        rule({ id: "dup", effect: "deny" }),
        { id: "empty", effect: "allow", subjects: [], actions: ["*"], resources: ["*"] },
      ]),
    );
    const findings = engine.lint();
    expect(findings.some((f) => f.code === "duplicate-id")).toBe(true);
    expect(findings.some((f) => f.code === "empty-matcher" && f.ruleIds.includes("empty"))).toBe(true);
  });

  it("a clean, well-scoped least-privilege document lints with zero findings", () => {
    const engine = PolicyEngine.compile(
      doc([
        rule({ id: "read-workspace", effect: "allow", subjects: ["*"], actions: ["fs:read"], resources: ["fs:/workspace/**"] }),
      ]),
    );
    expect(engine.lint()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bar (7): composition with a capability decision — independent layers
// ---------------------------------------------------------------------------

describe("composition with capability.ts — policy and capability are independent gates", () => {
  it("a request the capability layer allows is still DENIED overall when policy denies it", () => {
    const issuerIdentity = GovIdentity.generate();
    const subjectIdentity = GovIdentity.generate();
    const issuer = new CapabilityIssuer(issuerIdentity, { now: () => 1000 });
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [issuerIdentity.publicKeyHex()], now: () => 1000 });

    const token = issuer.mint({
      subject: subjectIdentity.agentId(),
      grants: [{ resource: "net:evil.example.com", actions: ["*"] }],
      ttlMs: 60_000,
    });
    const capReq = { subject: subjectIdentity.agentId(), action: "net:egress", resource: "net:evil.example.com", at: 1000 };
    const capDecision = enforcer.authorize([token], capReq);
    expect(capDecision.allow).toBe(true); // capability layer says yes

    // Policy layer independently says no (nothing allows net:egress here).
    const policy = PolicyEngine.compile(doc([rule({ id: "deny-egress", effect: "deny", actions: ["net:egress"] })]));
    const policyDecision = policy.evaluate({ subject: subjectIdentity.agentId(), action: "net:egress", resource: "net:evil.example.com", at: 1000 });
    expect(policyDecision.effect).toBe("deny");

    // Overall authorization is the conjunction — a caller MUST check both,
    // and policy alone is enough to block even though capability allowed it.
    const overallAllowed = capDecision.allow && policyDecision.effect === "allow";
    expect(overallAllowed).toBe(false);
  });

  it("a policy require-capability obligation surfaces so the caller must separately check the token", () => {
    const policy = PolicyEngine.compile(
      doc([rule({ id: "allow-with-cap", effect: "allow", actions: ["tool:invoke"], obligations: [{ kind: "require-capability", resource: "tool:bash" }] })]),
    );
    const decision = policy.evaluate({ subject: "agent:alice", action: "tool:invoke", resource: "tool:bash", at: 1000 });
    expect(decision.effect).toBe("allow");
    expect(decision.obligations).toEqual([{ kind: "require-capability", resource: "tool:bash" }]);

    // Policy allowing does NOT itself grant the capability — a caller that
    // ignores the obligation and skips the capability check is a caller
    // bug, not something either layer can silently paper over: without a
    // real capability chain, enforcement independently denies.
    const enforcer = new CapabilityEnforcer({ trustedIssuerPublicKeys: [], now: () => 1000 });
    const capDecision = enforcer.authorize(
      [
        {
          schema: "hades.gov.capability.v1",
          tokenId: "cap:fake",
          issuer: "agent:nobody",
          issuerPublicKey: "0".repeat(64),
          subject: "agent:alice",
          grants: [{ resource: "tool:bash", actions: ["*"] }],
          caveats: [],
          issuedAt: 0,
          expiresAt: 999999,
          depth: 0,
          nonce: "n",
          signature: "deadbeef",
          signerPublicKey: "0".repeat(64),
        },
      ],
      { subject: "agent:alice", action: "tool:invoke", resource: "tool:bash", at: 1000 },
    );
    expect(capDecision.allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bar (8): DEFAULT_GOV_POLICY
// ---------------------------------------------------------------------------

describe("DEFAULT_GOV_POLICY", () => {
  it("lints clean", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    expect(engine.lint()).toEqual([]);
  });

  it("denies net egress under air-gap even with a held capability", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    const d = engine.evaluate({
      subject: "agent:alice",
      action: "net:egress",
      resource: "net:api.example.com",
      at: 1000,
      airgapped: true,
      capabilities: ["net:*"],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("deny-net-egress-airgapped");
  });

  it("allows net egress to an allowlisted host when not air-gapped and holding the capability", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    const d = engine.evaluate({
      subject: "agent:alice",
      action: "net:egress",
      resource: "net:api.example.com",
      at: 1000,
      airgapped: false,
      capabilities: ["net:*"],
    });
    expect(d.effect).toBe("allow");
  });

  it("denies unscoped fs writes (outside the scratch subtree)", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    const d = engine.evaluate({
      subject: "agent:alice",
      action: "fs:write",
      resource: "fs:/etc/passwd",
      args: { path: "/etc/passwd" },
      at: 1000,
      riskRemaining: 1,
    });
    expect(d.effect).toBe("deny");
  });

  it("allows a scoped scratch write with sufficient risk budget", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    const d = engine.evaluate({
      subject: "agent:alice",
      action: "fs:write",
      resource: "fs:/workspace/scratch/out.txt",
      args: { path: "/workspace/scratch/out.txt" },
      at: 1000,
      riskRemaining: 1,
    });
    expect(d.effect).toBe("allow");
  });

  it("denies spawn for a subject without the orchestrator role", () => {
    const engine = PolicyEngine.compile(DEFAULT_GOV_POLICY);
    const d = engine.evaluate({
      subject: "agent:alice",
      action: "spawn",
      resource: "spawn:worker-1",
      at: 1000,
      subjectRoles: [],
      riskRemaining: 1,
    });
    expect(d.effect).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// PolicyEngine.denyAll
// ---------------------------------------------------------------------------

describe("PolicyEngine.denyAll", () => {
  it("denies absolutely everything and names the reason", () => {
    const engine = PolicyEngine.denyAll("policy store: absent policy");
    const d = engine.evaluate(baseReq());
    expect(d.effect).toBe("deny");
    expect(d.reason).toBe("policy store: absent policy");
    expect(d.obligations).toEqual([]);
    expect(engine.explain(baseReq()).effect).toBe("deny");
  });

  it("digest() and document() still work on a deny-all engine", () => {
    const engine = PolicyEngine.denyAll("x");
    expect(engine.document().defaultEffect).toBe("deny");
    expect(typeof engine.digest()).toBe("string");
    expect(engine.digest().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Audit sink wiring
// ---------------------------------------------------------------------------

describe("PolicyAuditSink wiring", () => {
  it("records evaluate() decisions but not explain() dry-runs", () => {
    const audit = new MemoryAuditSink();
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow" })]), { now: () => 42, audit });
    engine.explain(baseReq());
    expect(audit.records).toHaveLength(0);
    engine.evaluate(baseReq());
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ at: 42, actor: "agent:alice", outcome: "allow", code: "r1" });
  });

  it("a throwing audit sink never breaks the decision", () => {
    const audit: PolicyAuditSink = {
      record: () => {
        throw new Error("boom");
      },
    };
    const engine = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow" })]), { audit });
    expect(() => engine.evaluate(baseReq())).not.toThrow();
    expect(engine.evaluate(baseReq()).effect).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// digest()
// ---------------------------------------------------------------------------

describe("PolicyEngine.digest", () => {
  it("is stable for the same document and changes when the document changes", () => {
    const e1 = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow" })]));
    const e2 = PolicyEngine.compile(doc([rule({ id: "r1", effect: "allow" })]));
    const e3 = PolicyEngine.compile(doc([rule({ id: "r1", effect: "deny" })]));
    expect(e1.digest()).toBe(e2.digest());
    expect(e1.digest()).not.toBe(e3.digest());
  });
});
