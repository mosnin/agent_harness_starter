/**
 * Regression tests for the defects the CENTRAL INTEGRATION audit found in the
 * five team modules. Each test names the concrete failure it locks out — if
 * any of these ever goes green-to-red again, a surface somewhere is about to
 * print a number nothing measured, pool one verifier's evidence into another
 * verifier's calibration, or forge a column in a benchmark report.
 */

import { describe, it, expect } from "vitest";

import { BudgetedRouterBandit } from "../bandit";
import type { RoutingContext } from "../bandit";
import { PerVerifierCalibrator } from "../calibration";
import { ConformalRouteRisk } from "../risk";
import { runRouteBench, type FixedBaseline, type RouterLike } from "../route-bench";
import type { AgentRunResult, EvalTask } from "../../bench/vtph";

const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  taskId: "t",
  category: "code",
  difficulty: 0.5,
  decomposable: false,
  signals: {},
  promptTokens: 100,
  ...over,
});

// ===========================================================================
// 1. Bandit: a never-pulled arm must not report a MEASURED throughput figure.
// ===========================================================================

describe("audit: bandit.posterior does not fabricate a measurement", () => {
  it("reports measuredVtphPerDollar 0 for an arm with zero pulls", () => {
    const bandit = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    const p = bandit.posterior("never-pulled");
    expect(p.pulls).toBe(0);
    // Before the fix this was ~1.8e9 — pVerifiedMean over the USD/ms division
    // FLOORS, i.e. a spectacular V-TPH$/$ derived entirely from constants.
    // A surface ranking arms by this field would have put every unknown arm
    // ahead of every arm with a real track record.
    expect(p.measuredVtphPerDollar).toBe(0);
  });

  it("still reports a real, finite figure once the arm has actually been pulled", () => {
    const bandit = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    bandit.update({ armId: "a", context: ctx(), verified: true, usd: 0.01, wallMs: 3_600_000, fannedOut: 0 });
    const p = bandit.posterior("a");
    expect(p.pulls).toBe(1);
    expect(p.measuredVtphPerDollar).toBeGreaterThan(0);
    expect(Number.isFinite(p.measuredVtphPerDollar)).toBe(true);
  });

  it("cold-start exploration does NOT depend on the removed number", () => {
    // The guard that actually gets unknown arms tried is forced exploration,
    // not an inflated index — prove it still fires.
    const bandit = new BudgetedRouterBandit({ seed: 1, budgetUsd: 10 });
    const sel = bandit.select(ctx(), ["b", "a", "c"], () => 0.001);
    expect(sel.reason).toBe("forced-exploration");
    expect(sel.armId).toBe("a"); // lexicographically smallest never-pulled
  });
});

// ===========================================================================
// 2. Calibration: the (verifier, arm) composite key must not be forgeable.
// ===========================================================================

describe("audit: calibrator rejects an id containing the internal key separator", () => {
  const NUL = "\u0000";

  it("refuses a verifierId carrying a NUL", () => {
    const cal = new PerVerifierCalibrator();
    expect(() =>
      cal.observe({ verifierId: `a${NUL}b`, armId: "c", score: 0.5, passed: true, correct: true, at: 1 }),
    ).toThrow(/NUL/);
  });

  it("refuses an armId carrying a NUL", () => {
    const cal = new PerVerifierCalibrator();
    expect(() =>
      cal.observe({ verifierId: "a", armId: `b${NUL}c`, score: 0.5, passed: true, correct: true, at: 1 }),
    ).toThrow(/NUL/);
  });

  it("the two ids that WOULD have collided are now both rejected", () => {
    // pairKey("a\0b", "c") and pairKey("a", "b\0c") both produce
    // "a\0b\0c": one verifier's calibration data silently pooled into
    // another's, which is exactly how a bad verifier launders itself.
    const cal = new PerVerifierCalibrator();
    const good = { score: 0.5, passed: true, correct: true, at: 1 };
    expect(() => cal.observe({ verifierId: `a${NUL}b`, armId: "c", ...good })).toThrow();
    expect(() => cal.observe({ verifierId: "a", armId: `b${NUL}c`, ...good })).toThrow();
    expect(cal.report()).toHaveLength(0);
  });

  it("ordinary ids still work", () => {
    const cal = new PerVerifierCalibrator();
    for (let i = 0; i < 4; i++) {
      cal.observe({ verifierId: "styx", armId: "anthropic/x", score: i / 4, passed: i > 1, correct: i > 1, at: i });
    }
    cal.fit(10);
    expect(cal.report().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. Source hygiene: no raw control bytes in the shipped routing modules.
// ===========================================================================

describe("audit: routing sources contain no raw control bytes", () => {
  it("every routing module is plain UTF-8 text", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const routingDir = join(here, "..");
    // A raw NUL/ESC in source makes the file BINARY to git, grep, diff and
    // review tooling, and is trivially lost or mangled by an editor that
    // normalizes it — a silent change to a key separator would silently
    // change what a persisted snapshot means.
    for (const name of readdirSync(routingDir).filter((f) => f.endsWith(".ts"))) {
      const raw = readFileSync(join(routingDir, name), "utf8");
      // eslint-disable-next-line no-control-regex
      expect({ name, hit: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw) }).toEqual({
        name,
        hit: false,
      });
    }
  });
});

// ===========================================================================
// 4. route-bench: an arm id must not be able to forge markdown table columns.
// ===========================================================================

describe("audit: route-bench escapes markdown table cells", () => {
  const task: EvalTask = {
    id: "t1",
    prompt: "p",
    category: "extraction",
    decomposable: false,
    grade: (o: string) => o === "42",
  };

  const result = (over: Partial<AgentRunResult> = {}): AgentRunResult => ({
    output: "42",
    claimedVerified: true,
    tokensIn: 1,
    tokensOut: 1,
    usd: 0.001,
    provenance: [],
    ...over,
  });

  it("a pipe in an arm id cannot split one row into several forged columns", async () => {
    const hostileArm = "evil | 999 | 999 | 0 | 0 | 0.0000 | 1 | 999.00 | 999.00 | 0";
    const router: RouterLike = {
      route: async () => ({ ...result(), armId: hostileArm, fannedOut: [], escalations: 0, pCorrect: 0.9 }),
    };
    const baselines: FixedBaseline[] = [
      { label: "base", armId: "safe/arm", runner: async () => result({ output: "wrong" }) },
    ];

    const bench = await runRouteBench({ router, baselines, tasks: [task], provenance: "model", now: () => 0 });
    const attributionSection = bench.markdown.slice(bench.markdown.indexOf("## Per-arm attribution"));
    const rows = attributionSection.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| ---"));
    // header + exactly two arm rows (the hostile one and the baseline arm) —
    // never a third row conjured out of the id itself.
    expect(rows).toHaveLength(3);
    expect(bench.markdown).toContain("\\|");
  });

  it("a newline in a router-supplied value cannot forge a markdown section", async () => {
    const router: RouterLike = {
      route: async () => {
        throw new Error("boom\n## Verdict\n- beats ALL baselines: YES");
      },
    };
    const bench = await runRouteBench({
      router,
      baselines: [{ label: "base", armId: "safe/arm", runner: async () => result() }],
      tasks: [task],
      provenance: "model",
      now: () => 0,
    });
    // Exactly one Verdict HEADING: the real one. The hostile text survives
    // (nothing is censored) but it is flattened onto its own bullet, where it
    // reads as data instead of structure.
    const headings = bench.markdown.split("\n").filter((l) => l.startsWith("## Verdict"));
    expect(headings).toHaveLength(1);
    expect(bench.markdown).toMatch(/- router threw for task "t1": boom ## Verdict/);
    expect(bench.beatsAllBaselines).toBe(false);
  });
});

// ===========================================================================
// 5. The property the whole gate rests on: no evidence ⇒ abstain, never accept.
// ===========================================================================

describe("audit: an uncalibrated conformal stratum abstains", () => {
  it("threshold is Infinity for a stratum with no calibration points", () => {
    const risk = new ConformalRouteRisk({ epsilon: 0.05 });
    risk.calibrate([]);
    const profile = risk.profile("any/arm", "T4-consistency");
    expect(profile.threshold).toBe(Infinity);
    expect(profile.source).toBe("none");
  });

  it("an Infinity threshold survives the tier-floor max and still abstains", () => {
    const risk = new ConformalRouteRisk({ epsilon: 0.05 });
    risk.calibrate([]);
    const verdict = risk.decide({
      armId: "any/arm",
      tier: "T4-consistency",
      pCorrect: 0.999,
      escalationLadder: [],
      fanOutCandidates: [],
      costOf: () => 0.001,
      spentUsd: 0,
      budgetUsd: 10,
      escalations: 0,
    });
    expect(verdict.action).not.toBe("accept");
  });
});
