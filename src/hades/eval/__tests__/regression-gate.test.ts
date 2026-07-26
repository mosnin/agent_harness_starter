import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  renameSync as nodeRenameSync,
  mkdirSync as nodeMkdirSync,
  existsSync as nodeExistsSync,
  appendFileSync as nodeAppendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVAL_GATE_VERSION,
  EVAL_GATE_GENESIS,
  DEFAULT_NEVER_REGRESS_POLICY,
  normalizePolicy,
  policyHash,
  loadPolicy,
  savePolicy,
  evaluateNeverRegressGate,
  verifyGateVerdict,
  formatGateVerdict,
  GateVerdictJournal,
  GateJournalCorruptionError,
  GateJournalVerdictError,
  type NeverRegressPolicy,
  type GateVerdict,
  type GateFinding,
  type GateFsDeps,
  type GateWaiver,
} from "../regression-gate";

import { runEvalMeasurement } from "../measure";
import { verifyScorecard, type ScorecardRevision, type EvalScorecard } from "../scorecard";
import { EvalHistoryLedger } from "../history";
import { selectBaseline, type BaselineSelection } from "../compare";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { EvalTask, AgentRunner, AgentRunResult } from "../../bench/vtph";
import type { AdmitFn, RiskEvalSubject } from "../../trust/risk-eval";
import { sha256Hex } from "../../styx/certificate";

// ===========================================================================
// Fixtures — REAL runEvalMeasurement + REAL EVAL_TASKS + REAL scripted
// solvers + a REAL EvalHistoryLedger over a real mkdtempSync dir, exactly as
// the REAL-VS-MOCK contract requires. `now` is injected for determinism.
// ===========================================================================

function makeRevision(overrides: Partial<ScorecardRevision> = {}): ScorecardRevision {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    dirty: false,
    workTreeHash: "b".repeat(64),
    source: "git",
    committedAtMs: 1_700_000_000_000,
    branch: "claude/hermes-swarm-framework-vbhrot",
    ...overrides,
  };
}

function makeClock(stepMs = 1): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

type Override = "silent-wrong" | "declined-wrong" | "declined-correct";

/** A real, deterministic, non-model runner built from the real `faithful`
 *  scripted solver, with a controlled subset of tasks forced to a specific
 *  outcome kind so tests can construct EXACT, reproducible regressions
 *  rather than relying on chance. Wrong output is always `""` -- empty
 *  string reliably fails every real grader in `../../bench/eval-suite`
 *  (token-set / label / number / json / pairs graders all require non-empty
 *  structured content). */
function controlledRunner(overrides: Map<string, Override> = new Map()): AgentRunner {
  const faithful = scriptedSolvers().find((s) => s.label === "faithful")!;
  return async (task: EvalTask): Promise<AgentRunResult> => {
    const produced = faithful.answer(task);
    const provenance = produced.trace.map((t) => `${t.seq}:${t.kind}:${t.detail}`);
    const mode = overrides.get(task.id);
    if (mode === undefined) {
      return { output: produced.output, claimedVerified: true, tokensIn: 20, tokensOut: 40, usd: 0.0004, provenance };
    }
    if (mode === "silent-wrong") {
      return { output: "", claimedVerified: true, tokensIn: 20, tokensOut: 40, usd: 0.0004, provenance };
    }
    if (mode === "declined-wrong") {
      return { output: "", claimedVerified: false, tokensIn: 20, tokensOut: 40, usd: 0.0004, provenance };
    }
    return { output: produced.output, claimedVerified: false, tokensIn: 20, tokensOut: 40, usd: 0.0004, provenance };
  };
}

async function makeScorecard(opts: {
  sha: string;
  overrides?: Map<string, Override>;
  tasks?: EvalTask[];
  admit?: AdmitFn;
  epsilon?: number;
}): Promise<EvalScorecard> {
  return runEvalMeasurement({
    revision: makeRevision({ sha: opts.sha.padEnd(40, "0"), shortSha: opts.sha.slice(0, 7).padEnd(7, "0") }),
    tasks: opts.tasks,
    runner: controlledRunner(opts.overrides ?? new Map()),
    runnerLabel: "gate-test-runner",
    admit: opts.admit,
    epsilon: opts.epsilon,
    now: makeClock(),
  });
}

/** Builds a REAL `BaselineSelection` by appending a real faithful scorecard
 *  to a REAL `EvalHistoryLedger` over a real temp dir and running the REAL
 *  `selectBaseline` ("latest" strategy) over it.
 *
 *  NOTE: every entry persisted through `EvalHistoryLedger` round-trips
 *  through plain `JSON.stringify`/`JSON.parse` (`history.jsonl`), which is
 *  lossy for `NaN` (silently becomes `null`). An UNMEASURED risk lane
 *  legitimately contains `NaN` fields (`scorecard.ts`'s honest "nothing
 *  happened" sentinel), so persisting one would round-trip-corrupt the
 *  entry and make it fail its own `verifyScorecard` on read back -- not a
 *  regression-gate concern, just a fixture-construction detail. Every
 *  baseline entry here is therefore built with a REAL (trivial,
 *  always-abstain) `AdmitFn` so its risk lane is genuinely MEASURED and
 *  every field is a finite number, never `NaN`. */
const baselineAdmit: AdmitFn = async (subject: RiskEvalSubject) => ({
  accepted: false,
  domain: subject.domain,
  taskId: subject.taskId,
  score: 0,
  threshold: 1,
  pCorrect: 0,
  epsilon: 0.05,
  tier: "baseline-fixture",
  abstention: { code: "fixture-always-abstain", message: "deterministic baseline fixture -- always abstains" },
});

async function makeBaselineSelection(
  root: string,
  opts?: { tasks?: EvalTask[]; extraEntries?: number },
): Promise<{ selection: BaselineSelection; ledger: EvalHistoryLedger; baselineCard: EvalScorecard }> {
  const ledger = new EvalHistoryLedger({ root, now: makeClock() });
  const extra = opts?.extraEntries ?? 0;
  for (let i = 0; i < extra; i++) {
    const card = await makeScorecard({ sha: `e${i}`, tasks: opts?.tasks, admit: baselineAdmit, epsilon: 0.05 });
    ledger.append(card, { note: `extra-${i}` });
  }
  const baselineCard = await makeScorecard({ sha: "b", tasks: opts?.tasks, admit: baselineAdmit, epsilon: 0.05 });
  ledger.append(baselineCard, { note: "baseline" });
  const selection = selectBaseline(ledger.entries(), { strategy: "latest" });
  return { selection, ledger, baselineCard };
}

function customPolicy(overrides: Partial<NeverRegressPolicy> = {}): NeverRegressPolicy {
  return { ...DEFAULT_NEVER_REGRESS_POLICY, ...overrides };
}

function findByRule(v: GateVerdict, rule: string, taskId?: string | null): GateFinding | undefined {
  return v.findings.find((f) => f.rule === rule && (taskId === undefined || f.taskId === taskId));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// Constants + DEFAULT_NEVER_REGRESS_POLICY
// ===========================================================================

describe("constants", () => {
  it("EVAL_GATE_VERSION is 1", () => {
    expect(EVAL_GATE_VERSION).toBe(1);
  });

  it("EVAL_GATE_GENESIS is sha256Hex('hades.eval.gate.v1')", () => {
    expect(EVAL_GATE_GENESIS).toBe(sha256Hex("hades.eval.gate.v1"));
  });

  it("DEFAULT_NEVER_REGRESS_POLICY is zero-tolerance on the trust-critical metrics", () => {
    expect(DEFAULT_NEVER_REGRESS_POLICY.maxVerifiedCorrectDrop).toBe(0);
    expect(DEFAULT_NEVER_REGRESS_POLICY.maxSilentWrongIncrease).toBe(0);
    expect(DEFAULT_NEVER_REGRESS_POLICY.maxSilentWrongRateIncrease).toBe(0);
  });

  it("DEFAULT_NEVER_REGRESS_POLICY's fail-closed decisions are strict, missing-baseline being the deliberate exception", () => {
    expect(DEFAULT_NEVER_REGRESS_POLICY.onMissingBaseline).toBe("warn");
    expect(DEFAULT_NEVER_REGRESS_POLICY.onIncomparable).toBe("block");
    expect(DEFAULT_NEVER_REGRESS_POLICY.onInvalidScorecard).toBe("block");
    expect(DEFAULT_NEVER_REGRESS_POLICY.onChainBroken).toBe("block");
  });
});

// ===========================================================================
// normalizePolicy — total, hostile-input-safe
// ===========================================================================

describe("normalizePolicy", () => {
  it("is total over a non-object input and falls back to the strict default with a warning", () => {
    const { policy, warnings } = normalizePolicy("not a policy");
    expect(policy).toEqual(DEFAULT_NEVER_REGRESS_POLICY);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("is total over null / undefined / arrays without throwing", () => {
    expect(() => normalizePolicy(null)).not.toThrow();
    expect(() => normalizePolicy(undefined)).not.toThrow();
    expect(() => normalizePolicy([1, 2, 3])).not.toThrow();
    expect(normalizePolicy(null).policy.onInvalidScorecard).toBe("block");
  });

  it("rejects a wrong-typed numeric field and falls back to the strict default value", () => {
    const { policy, warnings } = normalizePolicy({ maxVerifiedCorrectDrop: "zero" });
    expect(policy.maxVerifiedCorrectDrop).toBe(0);
    expect(warnings.some((w) => w.includes("maxVerifiedCorrectDrop"))).toBe(true);
  });

  it("rejects a negative tolerance", () => {
    const { policy, warnings } = normalizePolicy({ maxSilentWrongIncrease: -5 });
    expect(policy.maxSilentWrongIncrease).toBe(0);
    expect(warnings.some((w) => w.includes("maxSilentWrongIncrease"))).toBe(true);
  });

  it("rejects NaN and Infinity thresholds", () => {
    const nanResult = normalizePolicy({ maxVtphRelativeDrop: Number.NaN });
    const infResult = normalizePolicy({ maxVtphRelativeDrop: Number.POSITIVE_INFINITY });
    expect(nanResult.policy.maxVtphRelativeDrop).toBe(DEFAULT_NEVER_REGRESS_POLICY.maxVtphRelativeDrop);
    expect(infResult.policy.maxVtphRelativeDrop).toBe(DEFAULT_NEVER_REGRESS_POLICY.maxVtphRelativeDrop);
    expect(nanResult.warnings.length).toBeGreaterThan(0);
    expect(infResult.warnings.length).toBeGreaterThan(0);
  });

  it("requires alpha strictly inside (0,1)", () => {
    expect(normalizePolicy({ alpha: 0 }).policy.alpha).toBe(0.05);
    expect(normalizePolicy({ alpha: 1 }).policy.alpha).toBe(0.05);
    expect(normalizePolicy({ alpha: -0.1 }).policy.alpha).toBe(0.05);
    expect(normalizePolicy({ alpha: 0.01 }).policy.alpha).toBe(0.01);
  });

  it("rejects a future version and falls back to the current supported version", () => {
    const { policy, warnings } = normalizePolicy({ version: 999 });
    expect(policy.version).toBe(EVAL_GATE_VERSION);
    expect(warnings.some((w) => w.toLowerCase().includes("future"))).toBe(true);
  });

  it("warns on unknown extra keys but never throws and still normalizes the rest", () => {
    const { policy, warnings } = normalizePolicy({ maxVerifiedCorrectDrop: 3, totallyUnknownField: "surprise" });
    expect(policy.maxVerifiedCorrectDrop).toBe(3);
    expect(warnings.some((w) => w.includes("totallyUnknownField"))).toBe(true);
  });

  it("truncates an oversized waiver array rather than accepting it unbounded", () => {
    const waivers = Array.from({ length: 600 }, (_, i) => ({ rule: `r${i}`, taskId: null, reason: "load-test", expiresAtMs: null, author: null }));
    const { policy, warnings } = normalizePolicy({ waivers });
    expect(policy.waivers.length).toBeLessThan(600);
    expect(warnings.some((w) => w.includes("waivers"))).toBe(true);
  });

  it("drops a waiver with a missing/empty rule", () => {
    const { policy, warnings } = normalizePolicy({ waivers: [{ rule: "", taskId: null, reason: "x", expiresAtMs: null, author: null }] });
    expect(policy.waivers).toHaveLength(0);
    expect(warnings.some((w) => w.includes("rule"))).toBe(true);
  });

  it("drops a waiver with a hostile taskId type rather than silently widening its scope", () => {
    const { policy } = normalizePolicy({ waivers: [{ rule: "vtph-relative-drop", taskId: 12345, reason: "x", expiresAtMs: null, author: null }] });
    expect(policy.waivers).toHaveLength(0);
  });

  it("normalizes a hostile expiresAtMs to fail-closed (already-expired), never to a permissive 'never expires'", () => {
    const { policy, warnings } = normalizePolicy({
      waivers: [{ rule: "vtph-relative-drop", taskId: null, reason: "x", expiresAtMs: "never", author: null }],
    });
    expect(policy.waivers).toHaveLength(1);
    expect(policy.waivers[0].expiresAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(warnings.some((w) => w.includes("expiresAtMs"))).toBe(true);
  });

  it("rejects an out-of-range riskEpsilonCeiling and disables the rule rather than fabricating a ceiling", () => {
    const { policy, warnings } = normalizePolicy({ riskEpsilonCeiling: 5 });
    expect(policy.riskEpsilonCeiling).toBeNull();
    expect(warnings.some((w) => w.includes("riskEpsilonCeiling"))).toBe(true);
  });

  it("is idempotent: normalizing an already-normalized policy yields the same policy", () => {
    const first = normalizePolicy({ maxVerifiedCorrectDrop: 2, alpha: 0.1 });
    const second = normalizePolicy(first.policy);
    expect(second.policy).toEqual(first.policy);
    expect(second.warnings).toHaveLength(0);
  });
});

// ===========================================================================
// policyHash
// ===========================================================================

describe("policyHash", () => {
  it("is deterministic and insertion-order independent", () => {
    const a = customPolicy({ maxVerifiedCorrectDrop: 1 });
    const bReordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as NeverRegressPolicy;
    expect(policyHash(a)).toBe(policyHash(bReordered));
  });

  it("changes when the waiver set changes -- waivers are part of the sealed policy identity", () => {
    const withoutWaiver = customPolicy();
    const withWaiver = customPolicy({
      waivers: [{ rule: "vtph-relative-drop", taskId: null, reason: "known flaky", expiresAtMs: null, author: "ci" }],
    });
    expect(policyHash(withoutWaiver)).not.toBe(policyHash(withWaiver));
  });

  it("changes when any tolerance changes", () => {
    expect(policyHash(customPolicy({ maxVerifiedCorrectDrop: 1 }))).not.toBe(policyHash(customPolicy({ maxVerifiedCorrectDrop: 2 })));
  });
});

// ===========================================================================
// loadPolicy / savePolicy
// ===========================================================================

describe("loadPolicy / savePolicy", () => {
  it("loadPolicy on an empty root returns the strict default with source 'default'", () => {
    const { policy, source, warnings } = loadPolicy(root);
    expect(source).toBe("default");
    expect(policy).toEqual(DEFAULT_NEVER_REGRESS_POLICY);
    expect(warnings).toHaveLength(0);
  });

  it("savePolicy then loadPolicy round-trips a custom policy with source 'file'", () => {
    const custom = customPolicy({ maxVerifiedCorrectDrop: 4, alpha: 0.1 });
    savePolicy(root, custom);
    const { policy, source, warnings } = loadPolicy(root);
    expect(source).toBe("file");
    expect(policy.maxVerifiedCorrectDrop).toBe(4);
    expect(policy.alpha).toBe(0.1);
    expect(warnings).toHaveLength(0);
  });

  it("savePolicy writes atomically via a tmp file + rename, never a direct write to the target", () => {
    const calls: string[] = [];
    const deps: GateFsDeps = {
      readFileSync: nodeReadFileSync,
      writeFileSync: ((...args: Parameters<typeof nodeWriteFileSync>) => {
        calls.push(`write:${String(args[0])}`);
        return nodeWriteFileSync(...args);
      }) as typeof nodeWriteFileSync,
      renameSync: ((...args: Parameters<typeof nodeRenameSync>) => {
        calls.push(`rename:${String(args[0])}->${String(args[1])}`);
        return nodeRenameSync(...args);
      }) as typeof nodeRenameSync,
      mkdirSync: nodeMkdirSync,
      existsSync: nodeExistsSync,
    };
    savePolicy(root, DEFAULT_NEVER_REGRESS_POLICY, deps);
    expect(calls[0]).toMatch(/^write:.*\.tmp-/);
    expect(calls[1]).toMatch(/^rename:.*\.tmp-.*->.*gate-policy\.json$/);
  });

  it("loadPolicy falls back to the default (never throws) when the file exists but readFileSync throws", () => {
    savePolicy(root, DEFAULT_NEVER_REGRESS_POLICY);
    const hostileDeps: GateFsDeps = {
      readFileSync: (() => {
        throw new Error("EACCES: permission denied");
      }) as typeof nodeReadFileSync,
      writeFileSync: nodeWriteFileSync,
      renameSync: nodeRenameSync,
      mkdirSync: nodeMkdirSync,
      existsSync: nodeExistsSync,
    };
    const { policy, source, warnings } = loadPolicy(root, hostileDeps);
    expect(source).toBe("default");
    expect(policy).toEqual(DEFAULT_NEVER_REGRESS_POLICY);
    expect(warnings.some((w) => w.includes("EACCES"))).toBe(true);
  });

  it("loadPolicy falls back to the default (never throws) on invalid JSON", () => {
    savePolicy(root, DEFAULT_NEVER_REGRESS_POLICY);
    const hostileDeps: GateFsDeps = {
      readFileSync: (() => "{ this is not json") as unknown as typeof nodeReadFileSync,
      writeFileSync: nodeWriteFileSync,
      renameSync: nodeRenameSync,
      mkdirSync: nodeMkdirSync,
      existsSync: nodeExistsSync,
    };
    const { policy, source, warnings } = loadPolicy(root, hostileDeps);
    expect(source).toBe("default");
    expect(policy).toEqual(DEFAULT_NEVER_REGRESS_POLICY);
    expect(warnings.some((w) => w.toLowerCase().includes("json"))).toBe(true);
  });

  it("loadPolicy normalizes a hand-edited nonsense policy file rather than crashing or trusting it blindly", () => {
    nodeMkdirSync(root, { recursive: true });
    nodeWriteFileSync(join(root, "gate-policy.json"), JSON.stringify({ maxVerifiedCorrectDrop: -99, onIncomparable: "yolo" }));
    const { policy, source, warnings } = loadPolicy(root);
    expect(source).toBe("file");
    expect(policy.maxVerifiedCorrectDrop).toBe(0);
    expect(policy.onIncomparable).toBe("block");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// evaluateNeverRegressGate — fail-closed structural checks (the "buy an
// ALLOW by deleting evidence" adversarial suite).
// ===========================================================================

describe("evaluateNeverRegressGate -- fail-closed structural checks", () => {
  it("a candidate that fails verifyScorecard always yields the configured non-allow decision (default: BLOCK), never ALLOW", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const tampered: EvalScorecard = { ...candidate, contentHash: "0".repeat(64) };
    expect(verifyScorecard(tampered).ok).toBe(false);

    const verdict = evaluateNeverRegressGate({ candidate: tampered, baseline: null, now: makeClock() });
    expect(verdict.decision).toBe("block");
    expect(findByRule(verdict, "scorecard-invalid")).toBeDefined();
    expect(verdict.delta).toBeNull();
  });

  it("onInvalidScorecard is configurable but a hostile scorecard never reaches ALLOW by default", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const tampered: EvalScorecard = { ...candidate, outcomes: [] };
    const verdict = evaluateNeverRegressGate({
      candidate: tampered,
      baseline: null,
      policy: customPolicy({ onInvalidScorecard: "warn" }),
      now: makeClock(),
    });
    expect(verdict.decision).toBe("warn");
  });

  it("a broken history chain (chainOk:false) always blocks under the default policy", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({ candidate, baseline: null, chainOk: false, now: makeClock() });
    expect(verdict.decision).toBe("block");
    expect(findByRule(verdict, "history-chain-broken")?.severity).toBe("block");
  });

  it("no baseline at all warns (the strict default's deliberate exception) but NEVER silently allows", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: null,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(verdict.decision).toBe("warn");
    expect(verdict.decision).not.toBe("allow");
    const f = findByRule(verdict, "baseline-missing")!;
    expect(f.severity).toBe("warn");
    expect(f.waived).toBe(false);
  });

  it("onMissingBaseline can be tightened to block, and the attack of simply dropping the baseline still never allows", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: null,
      policy: customPolicy({ onMissingBaseline: "block", requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(verdict.decision).toBe("block");
  });

  it("a baseline selection that failed (ok:false) is treated as baseline-missing", async () => {
    const failedSelection = selectBaseline([], { strategy: "latest" });
    expect(failedSelection.ok).toBe(false);
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: failedSelection,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(findByRule(verdict, "baseline-missing")).toBeDefined();
  });

  it("minBaselinePoolSize rejects a baseline pool that is technically 'ok' but too thin an evidence base", async () => {
    const { selection } = await makeBaselineSelection(root);
    expect(selection.ok).toBe(true);
    expect(selection.pool.length).toBe(1);
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ minBaselinePoolSize: 5, requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    const f = findByRule(verdict, "baseline-missing")!;
    expect(f).toBeDefined();
    expect(f.message).toContain("minBaselinePoolSize");
  });

  it("a suite swap (different suiteHash) is caught as incomparable and blocks by default -- the attacker cannot buy an ALLOW by comparing against a different suite", async () => {
    const smallTasks = EVAL_TASKS.slice(0, 10);
    const { selection } = await makeBaselineSelection(root, { tasks: smallTasks });
    const candidate = await makeScorecard({ sha: "c", tasks: EVAL_TASKS }); // full suite -- different suiteHash
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(verdict.decision).toBe("block");
    const f = findByRule(verdict, "incomparable")!;
    expect(f).toBeDefined();
    expect(f.message).toContain("suite-mismatch");
    expect(verdict.delta?.comparable).toBe(false);
  });

  it("a risk lane that was never measured always blocks when requireRiskLaneMeasured is on, even with an otherwise-passing candidate", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" }); // no admit fn -> risk.measured === false
    expect(candidate.risk.measured).toBe(false);
    const verdict = evaluateNeverRegressGate({ candidate, baseline: selection, now: makeClock() });
    const f = findByRule(verdict, "risk-lane-unmeasured")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("block");
    expect(verdict.decision).toBe("block");
  });

  it("disabling requireRiskLaneMeasured removes the risk-lane-unmeasured finding for an otherwise-clean candidate, which then allows", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(findByRule(verdict, "risk-lane-unmeasured")).toBeUndefined();
    expect(verdict.decision).toBe("allow");
    expect(verdict.findings).toHaveLength(0);
  });
});

// ===========================================================================
// evaluateNeverRegressGate — every metric rule, trip + just-under-threshold
// non-trip.
// ===========================================================================

describe("evaluateNeverRegressGate -- metric rules (trip + non-trip)", () => {
  it("verified-correct-drop trips past the tolerance and stays silent strictly under it (boundary is exclusive)", async () => {
    const { selection } = await makeBaselineSelection(root);
    const overrides = new Map<string, Override>([[EVAL_TASKS[0].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });

    const tripped = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    const tf = findByRule(tripped, "verified-correct-drop")!;
    expect(tf).toBeDefined();
    expect(tf.observed).toBe(1);
    expect(tf.threshold).toBe(0);
    expect(tf.severity).toBe("block");

    const permissive = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ maxVerifiedCorrectDrop: 2, requireRiskLaneMeasured: false, blockOnTaskRegression: false }),
      now: makeClock(),
    });
    expect(findByRule(permissive, "verified-correct-drop")).toBeUndefined();

    const boundary = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ maxVerifiedCorrectDrop: 1, requireRiskLaneMeasured: false, blockOnTaskRegression: false }),
      now: makeClock(),
    });
    expect(findByRule(boundary, "verified-correct-drop")).toBeUndefined();
  });

  it("vtph-relative-drop with requireSignificance: an insignificant discordance downgrades to WARN, a significant one stays BLOCK", async () => {
    const { selection } = await makeBaselineSelection(root);

    const oneOff = new Map<string, Override>([[EVAL_TASKS[0].id, "declined-wrong"]]);
    const smallDrop = await makeScorecard({ sha: "c", overrides: oneOff });
    const warnVerdict = evaluateNeverRegressGate({
      candidate: smallDrop,
      baseline: selection,
      policy: customPolicy({
        maxVerifiedCorrectDrop: 10,
        maxVtphRelativeDrop: 0.01,
        blockOnTaskRegression: false,
        requireRiskLaneMeasured: false,
        requireSignificance: true,
      }),
      now: makeClock(),
    });
    const warnFinding = findByRule(warnVerdict, "vtph-relative-drop")!;
    expect(warnFinding).toBeDefined();
    expect(warnVerdict.delta?.paired?.significant).toBe(false);
    expect(warnFinding.severity).toBe("warn");

    const many = new Map<string, Override>(EVAL_TASKS.slice(0, 10).map((t) => [t.id, "declined-wrong" as Override]));
    const bigDrop = await makeScorecard({ sha: "d", overrides: many });
    const blockVerdict = evaluateNeverRegressGate({
      candidate: bigDrop,
      baseline: selection,
      policy: customPolicy({
        maxVerifiedCorrectDrop: 20,
        maxVtphRelativeDrop: 0.01,
        blockOnTaskRegression: false,
        requireRiskLaneMeasured: false,
        requireSignificance: true,
      }),
      now: makeClock(),
    });
    const blockFinding = findByRule(blockVerdict, "vtph-relative-drop")!;
    expect(blockFinding).toBeDefined();
    expect(blockVerdict.delta?.paired?.significant).toBe(true);
    expect(blockFinding.severity).toBe("block");
  });

  it("vtph-relative-drop ignores significance and always blocks when requireSignificance is off", async () => {
    const { selection } = await makeBaselineSelection(root);
    const oneOff = new Map<string, Override>([[EVAL_TASKS[0].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides: oneOff });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({
        maxVerifiedCorrectDrop: 10,
        maxVtphRelativeDrop: 0.01,
        blockOnTaskRegression: false,
        requireRiskLaneMeasured: false,
        requireSignificance: false,
      }),
      now: makeClock(),
    });
    expect(findByRule(verdict, "vtph-relative-drop")?.severity).toBe("block");
  });

  it("silent-wrong-increase trips on any increase past the tolerance and not strictly under it", async () => {
    const { selection } = await makeBaselineSelection(root);
    const overrides = new Map<string, Override>([[EVAL_TASKS[1].id, "silent-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });

    const tripped = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false, blockOnTaskRegression: false, maxVerifiedCorrectDrop: 10 }),
      now: makeClock(),
    });
    const f = findByRule(tripped, "silent-wrong-increase")!;
    expect(f).toBeDefined();
    expect(f.observed).toBe(1);
    expect(f.severity).toBe("block");

    const permissive = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({
        requireRiskLaneMeasured: false,
        blockOnTaskRegression: false,
        maxVerifiedCorrectDrop: 10,
        maxSilentWrongIncrease: 1,
      }),
      now: makeClock(),
    });
    expect(findByRule(permissive, "silent-wrong-increase")).toBeUndefined();
  });

  it("silent-wrong-rate-increase trips independently of the absolute count rule", async () => {
    const { selection } = await makeBaselineSelection(root);
    const overrides = new Map<string, Override>([[EVAL_TASKS[2].id, "silent-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const expectedRateIncrease = 1 / EVAL_TASKS.length;

    const tripped = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({
        requireRiskLaneMeasured: false,
        blockOnTaskRegression: false,
        maxVerifiedCorrectDrop: 10,
        maxSilentWrongIncrease: 10,
        maxSilentWrongRateIncrease: expectedRateIncrease / 2,
      }),
      now: makeClock(),
    });
    const f = findByRule(tripped, "silent-wrong-rate-increase")!;
    expect(f).toBeDefined();
    expect(f.observed).toBeCloseTo(expectedRateIncrease, 10);

    const permissive = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({
        requireRiskLaneMeasured: false,
        blockOnTaskRegression: false,
        maxVerifiedCorrectDrop: 10,
        maxSilentWrongIncrease: 10,
        maxSilentWrongRateIncrease: expectedRateIncrease * 2,
      }),
      now: makeClock(),
    });
    expect(findByRule(permissive, "silent-wrong-rate-increase")).toBeUndefined();
  });

  it("risk-epsilon-ceiling trips when the candidate's own measured epsilon exceeds the configured ceiling, and not when it's comfortably under it", async () => {
    const { selection } = await makeBaselineSelection(root);
    const abstainAlways: AdmitFn = async (subject: RiskEvalSubject) => ({
      accepted: false,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 0,
      threshold: 1,
      pCorrect: 0,
      epsilon: 0.08,
      tier: "test-tier",
      abstention: { code: "always-abstain", message: "test fixture" },
    });
    const candidate = await makeScorecard({ sha: "c", admit: abstainAlways, epsilon: 0.08 });
    expect(candidate.risk.measured).toBe(true);
    expect(candidate.risk.epsilon).toBe(0.08);

    const tripped = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ riskEpsilonCeiling: 0.05 }),
      now: makeClock(),
    });
    const f = findByRule(tripped, "risk-epsilon-ceiling")!;
    expect(f).toBeDefined();
    expect(f.observed).toBe(0.08);
    expect(f.threshold).toBe(0.05);

    const permissive = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ riskEpsilonCeiling: 0.2 }),
      now: makeClock(),
    });
    expect(findByRule(permissive, "risk-epsilon-ceiling")).toBeUndefined();
  });

  it("task-regression produces exactly one finding per regressed taskId", async () => {
    const { selection } = await makeBaselineSelection(root);
    const overrides = new Map<string, Override>([
      [EVAL_TASKS[3].id, "declined-wrong"],
      [EVAL_TASKS[4].id, "silent-wrong"],
    ]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false, maxVerifiedCorrectDrop: 10, maxSilentWrongIncrease: 10, maxVtphRelativeDrop: 1 }),
      now: makeClock(),
    });
    const taskFindings = verdict.findings.filter((f) => f.rule === "task-regression");
    expect(taskFindings).toHaveLength(2);
    expect(taskFindings.map((f) => f.taskId).sort()).toEqual([EVAL_TASKS[3].id, EVAL_TASKS[4].id].sort());
    expect(taskFindings.every((f) => f.severity === "block")).toBe(true);
  });

  it("blockOnTaskRegression:false suppresses every task-regression finding even with real regressed tasks", async () => {
    const { selection } = await makeBaselineSelection(root);
    const overrides = new Map<string, Override>([[EVAL_TASKS[5].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ blockOnTaskRegression: false, requireRiskLaneMeasured: false, maxVerifiedCorrectDrop: 10, maxVtphRelativeDrop: 1 }),
      now: makeClock(),
    });
    expect(verdict.findings.filter((f) => f.rule === "task-regression")).toHaveLength(0);
  });

  it("an identical faithful candidate against its own faithful baseline is a clean ALLOW", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const verdict = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false }),
      now: makeClock(),
    });
    expect(verdict.decision).toBe("allow");
    expect(verdict.findings).toHaveLength(0);
    expect(verdict.delta?.comparable).toBe(true);
  });
});

// ===========================================================================
// Waivers — real governance, not an escape hatch.
// ===========================================================================

describe("evaluateNeverRegressGate -- waivers", () => {
  async function regressedVerdict(waivers: GateWaiver[], nowMs: () => number): Promise<GateVerdict> {
    const overrides = new Map<string, Override>([[EVAL_TASKS[6].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const { selection } = await makeBaselineSelection(root);
    return evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({ requireRiskLaneMeasured: false, waivers }),
      now: nowMs,
    });
  }

  it("a waiver with a non-empty reason downgrades the matching finding to info, waived:true, and the decision recomputes", async () => {
    const clock = makeClock();
    const v = await regressedVerdict(
      [{ rule: "verified-correct-drop", taskId: null, reason: "known flaky infra, tracked in TICKET-1", expiresAtMs: null, author: "ci" }],
      clock,
    );
    const f = findByRule(v, "verified-correct-drop")!;
    expect(f.severity).toBe("info");
    expect(f.waived).toBe(true);
    expect(f.waiverReason).toBe("known flaky infra, tracked in TICKET-1");
    // task-regression (block, default on) still fires for the same task -> overall stays block
    expect(v.decision).toBe("block");
  });

  it("waiving every tripped rule for a regression actually flips the decision", async () => {
    const clock = makeClock();
    const v = await regressedVerdict(
      [
        { rule: "verified-correct-drop", taskId: null, reason: "approved", expiresAtMs: null, author: "ci" },
        { rule: "task-regression", taskId: null, reason: "approved", expiresAtMs: null, author: "ci" },
        { rule: "vtph-relative-drop", taskId: null, reason: "approved", expiresAtMs: null, author: "ci" },
      ],
      clock,
    );
    expect(v.decision).toBe("allow");
    expect(v.findings.every((f) => f.severity === "info" && f.waived)).toBe(true);
    expect(v.findings.length).toBeGreaterThan(0);
  });

  it("a waiver requires a non-empty reason -- an empty-reason waiver never applies", async () => {
    const clock = makeClock();
    const v = await regressedVerdict([{ rule: "verified-correct-drop", taskId: null, reason: "", expiresAtMs: null, author: null }], clock);
    const f = findByRule(v, "verified-correct-drop")!;
    expect(f.waived).toBe(false);
    expect(f.severity).toBe("block");
  });

  it("an expired waiver (expiresAtMs < now) does not apply -- the finding stays at its original severity", async () => {
    const clock = makeClock();
    const v = await regressedVerdict(
      [{ rule: "verified-correct-drop", taskId: null, reason: "temporary", expiresAtMs: -1_000_000, author: null }],
      clock,
    );
    const f = findByRule(v, "verified-correct-drop")!;
    expect(f.waived).toBe(false);
    expect(f.severity).toBe("block");
  });

  it("a waiver can never upgrade a decision for a rule it does not name", async () => {
    const clock = makeClock();
    const v = await regressedVerdict(
      [{ rule: "silent-wrong-increase", taskId: null, reason: "unrelated rule", expiresAtMs: null, author: null }],
      clock,
    );
    // verified-correct-drop and task-regression were never waived
    expect(findByRule(v, "verified-correct-drop")?.severity).toBe("block");
    expect(v.decision).toBe("block");
  });

  it("a taskId-scoped waiver only applies to that exact task", async () => {
    const overrides = new Map<string, Override>([
      [EVAL_TASKS[7].id, "declined-wrong"],
      [EVAL_TASKS[8].id, "declined-wrong"],
    ]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const { selection } = await makeBaselineSelection(root);
    const v = evaluateNeverRegressGate({
      candidate,
      baseline: selection,
      policy: customPolicy({
        requireRiskLaneMeasured: false,
        maxVerifiedCorrectDrop: 10,
        maxVtphRelativeDrop: 1,
        waivers: [{ rule: "task-regression", taskId: EVAL_TASKS[7].id, reason: "approved for this task only", expiresAtMs: null, author: null }],
      }),
      now: makeClock(),
    });
    const waivedFinding = findByRule(v, "task-regression", EVAL_TASKS[7].id)!;
    const stillBlockingFinding = findByRule(v, "task-regression", EVAL_TASKS[8].id)!;
    expect(waivedFinding.waived).toBe(true);
    expect(stillBlockingFinding.waived).toBe(false);
    expect(v.decision).toBe("block");
  });

  it("the waiver set is embedded in policyHash, so a verdict cannot be silently reinterpreted under a different waiver set", async () => {
    const clock = makeClock();
    const v = await regressedVerdict(
      [{ rule: "verified-correct-drop", taskId: null, reason: "approved", expiresAtMs: null, author: null }],
      clock,
    );
    const policyWithoutWaiver = customPolicy({ requireRiskLaneMeasured: false });
    expect(v.policyHash).not.toBe(policyHash(policyWithoutWaiver));
  });
});

// ===========================================================================
// GateVerdict sealing / verifyGateVerdict
// ===========================================================================

describe("verifyGateVerdict", () => {
  it("accepts a genuine, unmutated verdict", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    expect(verifyGateVerdict(v)).toEqual({ ok: true, reason: null });
  });

  it("detects an unsupported version", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    const tampered: GateVerdict = { ...v, version: 999 };
    const result = verifyGateVerdict(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unsupported-version:999");
  });

  it("detects a flipped decision", async () => {
    const overrides = new Map<string, Override>([[EVAL_TASKS[9].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const { selection } = await makeBaselineSelection(root);
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    expect(v.decision).toBe("block");
    const tampered: GateVerdict = { ...v, decision: "allow" };
    const result = verifyGateVerdict(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("decision-mismatch");
  });

  it("detects an added finding (content-hash mismatch)", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    const forged: GateFinding = {
      rule: "forged-rule",
      severity: "info",
      message: "injected",
      observed: 0,
      threshold: 0,
      taskId: null,
      waived: false,
      waiverReason: null,
    };
    const tampered: GateVerdict = { ...v, findings: [...v.findings, forged] };
    const result = verifyGateVerdict(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content-hash-mismatch");
  });

  it("detects a swapped policyHash", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    const tampered: GateVerdict = { ...v, policyHash: policyHash(customPolicy({ maxVerifiedCorrectDrop: 999 })) };
    const result = verifyGateVerdict(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("content-hash-mismatch");
  });

  it("contentHash excludes itself from its own input (self-referential field)", async () => {
    const { selection } = await makeBaselineSelection(root);
    const candidate = await makeScorecard({ sha: "c" });
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    expect(v.contentHash).toHaveLength(64); // sha256 hex
    expect(verifyGateVerdict(v).ok).toBe(true);
  });
});

// ===========================================================================
// formatGateVerdict — aligned plain ASCII, CI-log legible.
// ===========================================================================

describe("formatGateVerdict", () => {
  it("produces plain ASCII lines with the decision, sha, and every finding's rule + message", async () => {
    const overrides = new Map<string, Override>([[EVAL_TASKS[10].id, "declined-wrong"]]);
    const candidate = await makeScorecard({ sha: "c", overrides });
    const { selection } = await makeBaselineSelection(root);
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    const lines = formatGateVerdict(v);
    const text = lines.join("\n");
    expect(text).toContain("BLOCK");
    expect(text).toContain(v.candidateSha);
    expect(text).toContain("verified-correct-drop");
    expect(text).toContain(v.contentHash);
    expect(lines.every((l) => /^[\x00-\x7F]*$/.test(l))).toBe(true); // plain ASCII only
  });

  it("an ALLOW verdict reports no findings cleanly", async () => {
    const candidate = await makeScorecard({ sha: "c" });
    const { selection } = await makeBaselineSelection(root);
    const v = evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
    const text = formatGateVerdict(v).join("\n");
    expect(text).toContain("ALLOW");
    expect(text).toContain("(none)");
  });
});

// ===========================================================================
// GateVerdictJournal
// ===========================================================================

describe("GateVerdictJournal", () => {
  async function makeVerdict(sha: string, overrides: Map<string, Override> = new Map()): Promise<GateVerdict> {
    const candidate = await makeScorecard({ sha, overrides });
    const { selection } = await makeBaselineSelection(join(root, "hist"));
    return evaluateNeverRegressGate({ candidate, baseline: selection, policy: customPolicy({ requireRiskLaneMeasured: false }), now: makeClock() });
  }

  it("append + verify: a real chain of verdicts self-verifies", async () => {
    const journal = new GateVerdictJournal({ root: join(root, "j1"), now: makeClock() });
    const v1 = await makeVerdict("c1");
    const v2 = await makeVerdict("c2", new Map([[EVAL_TASKS[11].id, "declined-wrong"]]));
    journal.append(v1);
    journal.append(v2);
    const result = journal.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.brokenAtIndex).toBeNull();
  });

  it("refuses to append a verdict that fails verifyGateVerdict", async () => {
    const journal = new GateVerdictJournal({ root: join(root, "j2"), now: makeClock() });
    const v = await makeVerdict("c1", new Map([[EVAL_TASKS[13].id, "declined-wrong"]]));
    expect(v.decision).not.toBe("allow");
    const tampered: GateVerdict = { ...v, decision: "allow" };
    expect(() => journal.append(tampered)).toThrow(GateJournalVerdictError);
  });

  it("list() filters by sha, decision, and limit; latest() returns the most recent match", async () => {
    const journal = new GateVerdictJournal({ root: join(root, "j3"), now: makeClock() });
    const v1 = await makeVerdict("c1");
    const v2 = await makeVerdict("c2", new Map([[EVAL_TASKS[12].id, "declined-wrong"]]));
    const v3 = await makeVerdict("c3");
    journal.append(v1);
    journal.append(v2);
    journal.append(v3);

    expect(journal.list().map((v) => v.candidateSha)).toEqual([v1.candidateSha, v2.candidateSha, v3.candidateSha]);
    expect(journal.list({ decision: "block" }).map((v) => v.candidateSha)).toEqual([v2.candidateSha]);
    expect(journal.list({ limit: 1 }).map((v) => v.candidateSha)).toEqual([v3.candidateSha]);
    expect(journal.latest()?.candidateSha).toBe(v3.candidateSha);
    expect(journal.latest(v1.candidateSha)?.candidateSha).toBe(v1.candidateSha);
    expect(journal.latest("does-not-exist")).toBeNull();
  });

  it("recovers from a truncated final line rather than throwing or losing prior entries", async () => {
    const jroot = join(root, "j4");
    const journal = new GateVerdictJournal({ root: jroot, now: makeClock() });
    const v1 = await makeVerdict("c1");
    journal.append(v1);

    const logPath = join(jroot, "gate-verdicts.jsonl");
    nodeAppendFileSync(logPath, JSON.stringify({ seq: 1, recordedAtMs: 2 }).slice(0, 10)); // truncated garbage, no trailing newline

    const reopened = new GateVerdictJournal({ root: jroot, now: makeClock() });
    expect(reopened.list()).toHaveLength(1);
    const result = reopened.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(1);

    const v2 = await makeVerdict("c2");
    expect(() => reopened.append(v2)).not.toThrow();
    expect(reopened.list()).toHaveLength(2);
  });

  it("raises (never silently skips) on mid-file corruption", async () => {
    const jroot = join(root, "j5");
    const journal = new GateVerdictJournal({ root: jroot, now: makeClock() });
    const v1 = await makeVerdict("c1");
    const v2 = await makeVerdict("c2");
    journal.append(v1);
    journal.append(v2);

    const logPath = join(jroot, "gate-verdicts.jsonl");
    const lines = (nodeReadFileSync(logPath, "utf8") as string).split("\n").filter((l: string) => l.length > 0);
    lines[1] = "{ not valid json at all";
    nodeWriteFileSync(logPath, lines.join("\n") + "\n");

    const reopened = new GateVerdictJournal({ root: jroot, now: makeClock() });
    expect(() => reopened.list()).toThrow(GateJournalCorruptionError);
    expect(() => reopened.verify()).toThrow(GateJournalCorruptionError);
  });

  it("retain compaction preserves an independently verifiable chain", async () => {
    const jroot = join(root, "j6");
    const journal = new GateVerdictJournal({ root: jroot, now: makeClock(), retain: 2 });
    for (let i = 0; i < 5; i++) {
      journal.append(await makeVerdict(`c${i}`));
    }
    expect(journal.list()).toHaveLength(2);
    const result = journal.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(2);

    // A fresh instance over the same root sees the same compacted, verifiable state.
    const reopened = new GateVerdictJournal({ root: jroot, now: makeClock() });
    expect(reopened.verify().ok).toBe(true);
    expect(reopened.list()).toHaveLength(2);
  });

  it("two GateVerdictJournal instances over the same root, alternating synchronous appends, land a chain verify() accepts", async () => {
    const jroot = join(root, "j7");
    const a = new GateVerdictJournal({ root: jroot, now: makeClock() });
    const b = new GateVerdictJournal({ root: jroot, now: makeClock() });

    const v1 = await makeVerdict("c1");
    const v2 = await makeVerdict("c2");
    const v3 = await makeVerdict("c3");
    const v4 = await makeVerdict("c4");

    a.append(v1);
    b.append(v2);
    a.append(v3);
    b.append(v4);

    const result = a.verify();
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(4);
    expect(b.list()).toHaveLength(4);
  });
});
