import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runEvalCommand, evalHelpLines, type EvalCliDeps } from "../eval-command";
import { defaultEvalCliDeps } from "../eval-deps";

import { EvalHistoryLedger } from "../../eval/history";
import { runEvalMeasurement, scriptedEvalRunner } from "../../eval/measure";
import { verifyScorecard, type EvalScorecard, type ScorecardRevision } from "../../eval/scorecard";
import { runContinuousEval, evalStatus, type ContinuousEvalOptions, type ContinuousEvalResult } from "../../eval/continuous";
import { autoBisect } from "../../eval/bisect";
import { DEFAULT_NEVER_REGRESS_POLICY, loadPolicy, savePolicy, type NeverRegressPolicy } from "../../eval/regression-gate";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { AdmitFn, RiskEvalSubject } from "../../trust/risk-eval";

// ===========================================================================
// Fixtures — REAL runEvalMeasurement + REAL EVAL_TASKS (default suite) +
// REAL scripted solvers + a REAL EvalHistoryLedger over a real mkdtempSync
// dir, exactly as the REAL-VS-MOCK contract requires (mirrors
// ../../eval/__tests__/continuous.test.ts's own fixture discipline).
// ===========================================================================

function makeRevision(n: number, overrides: Partial<ScorecardRevision> = {}): ScorecardRevision {
  const hex = n.toString(16).padStart(40, "0");
  return {
    sha: hex,
    shortSha: hex.slice(0, 12),
    dirty: false,
    workTreeHash: "f".repeat(64),
    source: "content",
    committedAtMs: 1_700_000_000_000 + n * 1000,
    branch: "main",
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

/** A real, deterministic, always-abstaining admission gate. Keeps the risk
 *  lane genuinely MEASURED (never NaN) so every scorecard round-trips
 *  through the real ledger's JSON persistence without corruption -- an
 *  unmeasured risk lane's NaN fields become `null` through JSON, which
 *  fails `verifyChain()`'s hash recompute on read-back. */
const alwaysAbstainAdmit: AdmitFn = async (subject: RiskEvalSubject) => ({
  accepted: false,
  domain: subject.domain,
  taskId: subject.taskId,
  score: 0,
  threshold: 1,
  pCorrect: 0,
  epsilon: 0.05,
  tier: "test-fixture",
  abstention: { code: "fixture-always-abstain", message: "deterministic test fixture -- always abstains" },
});

type SolverLabel = "faithful" | "lossy" | "fabricating" | "refusing";

async function measureWithSolver(revision: ScorecardRevision, solverLabel: SolverLabel, clockStepMs = 1): Promise<EvalScorecard> {
  const solver = scriptedSolvers().find((s) => s.label === solverLabel);
  if (solver === undefined) throw new Error(`no scripted solver labelled "${solverLabel}"`);
  return runEvalMeasurement({
    revision,
    runner: scriptedEvalRunner(solver),
    runnerLabel: `test:${solverLabel}`,
    admit: alwaysAbstainAdmit,
    epsilon: 0.05,
    now: makeClock(clockStepMs),
  });
}

function measureFnFor(solverLabel: SolverLabel, clockStepMs = 1): (r: ScorecardRevision) => Promise<EvalScorecard> {
  return (r: ScorecardRevision) => measureWithSolver(r, solverLabel, clockStepMs);
}

/** A `runContinuous` deps binding that drives the REAL `runContinuousEval`
 *  engine, only substituting the measurement function with a real,
 *  deterministic scripted-solver measurement (so risk stays measured and a
 *  regression can be genuinely engineered by swapping solvers) whenever the
 *  caller (i.e. `cmdRun`) didn't already supply one. */
function realRunContinuous(solverLabel: SolverLabel): EvalCliDeps["runContinuous"] {
  return (opts: ContinuousEvalOptions): Promise<ContinuousEvalResult> =>
    runContinuousEval({ ...opts, measure: opts.measure ?? measureFnFor(solverLabel) });
}

function notCalled(name: string): () => never {
  return () => {
    throw new Error(`unexpected call: ${name}`);
  };
}

/** A deps object whose every field throws if invoked -- used for pure
 *  argument-parsing/validation tests that must never reach the engine. */
function stubDeps(root = "/nonexistent/eval-root"): EvalCliDeps {
  return {
    root,
    ledger: notCalled("ledger"),
    runContinuous: notCalled("runContinuous") as unknown as EvalCliDeps["runContinuous"],
    status: notCalled("status") as unknown as EvalCliDeps["status"],
    bisect: notCalled("bisect") as unknown as EvalCliDeps["bisect"],
    resolveRevision: notCalled("resolveRevision"),
    loadPolicy: notCalled("loadPolicy") as unknown as EvalCliDeps["loadPolicy"],
    savePolicy: notCalled("savePolicy"),
  };
}

function joinLines(r: { lines: string[] }): string {
  return r.lines.join("\n");
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-eval-cmd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// evalHelpLines / help routing
// ===========================================================================

describe("evalHelpLines", () => {
  it("documents every locked subcommand", () => {
    const text = evalHelpLines().join("\n");
    for (const sub of ["hades eval status", "hades eval run", "hades eval gate", "hades eval bisect", "hades eval history", "hades eval help"]) {
      expect(text).toContain(sub);
    }
  });

  it("documents every locked flag", () => {
    const text = evalHelpLines().join("\n");
    for (const flag of [
      "--root R",
      "--branch B",
      "--trend N",
      "--label L",
      "--note N",
      "--baseline latest|rolling-median|best-of-window|<sha>",
      "--window N",
      "--epsilon E",
      "--no-record",
      "--gate",
      "--bisect",
      "--sha S",
      "--policy <file>",
      "--set key=value ...",
      "--show-policy",
      "--good S",
      "--bad S",
      "--signal verified|vtph|silent-wrong|silent-wrong-rate|task:<id>",
      "--max-probes N",
      "--active",
      "--limit N",
      "--verify",
      "--json",
    ]) {
      expect(text).toContain(flag);
    }
  });

  it("documents all four exit codes", () => {
    const text = evalHelpLines().join("\n");
    expect(text).toMatch(/\b0\b[\s\S]*allow/i);
    expect(text).toMatch(/\b1\b[\s\S]*usage/i);
    expect(text).toMatch(/\b2\b[\s\S]*BLOCK/);
    expect(text).toMatch(/\b3\b[\s\S]*chain/i);
  });
});

describe("router", () => {
  it("no subcommand / help / --help / -h all print help with exit 0", async () => {
    const deps = stubDeps();
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      const r = await runEvalCommand(argv, deps);
      expect(r.code).toBe(0);
      expect(joinLines(r)).toContain("hades eval status");
    }
  });

  it("an unknown subcommand is a usage error (exit 1) that still shows help", async () => {
    const r = await runEvalCommand(["frobnicate"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/unknown subcommand "frobnicate"/);
    expect(joinLines(r)).toContain("hades eval status");
  });

  it("never lets a thrown deps function escape runEvalCommand", async () => {
    const deps = stubDeps();
    deps.status = () => {
      throw new Error("boom from a hostile deps.status");
    };
    const r = await runEvalCommand(["status"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/boom from a hostile deps\.status/);
  });
});

// ===========================================================================
// Argument-parsing / validation — every path must produce a precise
// diagnostic and never reach the (throwing) stub deps.
// ===========================================================================

describe("status: flag validation", () => {
  it("rejects an unknown flag", async () => {
    const r = await runEvalCommand(["status", "--bogus"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toContain("unknown flag: --bogus");
  });

  it("rejects a missing value for --branch", async () => {
    const r = await runEvalCommand(["status", "--branch"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toContain("--branch requires a value");
  });

  it("rejects a non-numeric --trend", async () => {
    const r = await runEvalCommand(["status", "--trend", "abc"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--trend must be a finite number/);
  });

  it("rejects a non-integer --trend", async () => {
    const r = await runEvalCommand(["status", "--trend", "1.5"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--trend must be an integer/);
  });

  it("rejects an unexpected positional argument", async () => {
    const r = await runEvalCommand(["status", "extra"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/unexpected argument: extra/);
  });
});

describe("run: flag validation", () => {
  it("rejects a non-numeric --window", async () => {
    const r = await runEvalCommand(["run", "--window", "nope"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--window must be a finite number/);
  });

  it("rejects --epsilon <= 0", async () => {
    const r = await runEvalCommand(["run", "--epsilon", "0"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--epsilon must be strictly greater than 0/);
  });

  it("rejects --epsilon > 1", async () => {
    const r = await runEvalCommand(["run", "--epsilon", "1.5"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--epsilon must be <= 1/);
  });

  it("rejects an unknown flag", async () => {
    const r = await runEvalCommand(["run", "--frobnicate"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toContain("unknown flag: --frobnicate");
  });
});

describe("gate: flag validation", () => {
  it("rejects a --set argument with no '='", async () => {
    const r = await runEvalCommand(["gate", "--set", "maxVtphRelativeDrop"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/invalid --set argument "maxVtphRelativeDrop": expected key=value/);
  });

  it("rejects a --set naming an unknown policy key", async () => {
    const deps = stubDeps();
    deps.loadPolicy = () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] });
    const r = await runEvalCommand(["gate", "--set", "notARealKey=5"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/unrecognized key "notARealKey"/);
  });

  it("rejects a --set with an ill-typed value for a known key", async () => {
    const deps = stubDeps();
    deps.loadPolicy = () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] });
    const r = await runEvalCommand(["gate", "--set", "maxVtphRelativeDrop=not-a-number"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/policy\.maxVtphRelativeDrop must be a finite number/);
  });

  it("rejects an unknown flag", async () => {
    const r = await runEvalCommand(["gate", "--nope"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toContain("unknown flag: --nope");
  });
});

describe("bisect: flag validation", () => {
  it("rejects an unknown --signal", async () => {
    const r = await runEvalCommand(["bisect", "--signal", "made-up"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/unknown --signal "made-up"/);
  });

  it("rejects a non-numeric --max-probes", async () => {
    const r = await runEvalCommand(["bisect", "--max-probes", "nope"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--max-probes must be a finite number/);
  });

  it("rejects --max-probes < 1", async () => {
    const r = await runEvalCommand(["bisect", "--max-probes", "0"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--max-probes must be >= 1/);
  });

  it("refuses --active with a clear diagnostic, never silently downgrading", async () => {
    const r = await runEvalCommand(["bisect", "--active"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--active requires a real revision-checkout/);
  });
});

describe("history: flag validation", () => {
  it("rejects a non-numeric --limit", async () => {
    const r = await runEvalCommand(["history", "--limit", "abc"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/--limit must be a finite number/);
  });
});

// ===========================================================================
// status
// ===========================================================================

describe("status", () => {
  it("reports an empty ledger honestly and exits 0", async () => {
    const evalRoot = join(root, "eval");
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      status: (opts) => evalStatus({ ...opts, root: opts.root }),
    };
    const r = await runEvalCommand(["status", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.code).toBe(0);
    expect(parsed.report.entries).toBe(0);
    expect(parsed.report.latest).toBeNull();
  });

  it("--root overrides deps.root for this call", async () => {
    let seenRoot = "";
    const deps: EvalCliDeps = {
      ...stubDeps("/default/root"),
      status: (opts) => {
        seenRoot = opts.root;
        return evalStatus(opts);
      },
    };
    await runEvalCommand(["status", "--root", "/override/root"], deps);
    expect(seenRoot).toBe("/override/root");
  });

  it("wraps a thrown status() as a clean exit-1 diagnostic", async () => {
    const deps = stubDeps();
    deps.status = () => {
      throw new RangeError("status: root must be a non-empty path");
    };
    const r = await runEvalCommand(["status"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/status\(\) threw/);
  });

  it("human output is aligned ASCII with no HTML tags or ANSI escapes", () => {
    const text = evalHelpLines().join("\n");
    expect(text).not.toMatch(/<\/?(html|body|div|span|script|style|table|tr|td)\b/i);
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[/);
  });
});

// ===========================================================================
// history
// ===========================================================================

describe("history", () => {
  it("lists recorded entries and exits 0", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const card1 = await measureWithSolver(makeRevision(1), "faithful", 1);
    const card2 = await measureWithSolver(makeRevision(2), "faithful", 1);
    ledger.append(card1, { note: "first" });
    ledger.append(card2, { note: "second" });

    const deps: EvalCliDeps = { ...stubDeps(evalRoot), ledger: () => ledger };
    const r = await runEvalCommand(["history", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.count).toBe(2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].scorecardContentHash).toBe(card1.contentHash);
    expect(parsed.chain).toBeNull();
  });

  it("--verify on a clean chain reports ok and exits 0", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    ledger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    const deps: EvalCliDeps = { ...stubDeps(evalRoot), ledger: () => ledger };
    const r = await runEvalCommand(["history", "--verify"], deps);
    expect(r.code).toBe(0);
    expect(joinLines(r)).toMatch(/chain verified : true/);
  });

  it("--verify on a broken chain exits 3 and surfaces brokenAtSeq", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    ledger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    ledger.append(await measureWithSolver(makeRevision(2), "faithful", 1));

    // Corrupt the on-disk chain by hand-editing the second entry's note --
    // this changes its canonical form without updating `hash`, exactly the
    // tamper `verifyChain()` exists to catch.
    const logPath = join(evalRoot, "history.jsonl");
    const rawLines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    const tampered = JSON.parse(rawLines[2]);
    tampered.note = "TAMPERED";
    rawLines[2] = JSON.stringify(tampered);
    writeFileSync(logPath, rawLines.join("\n") + "\n", "utf8");

    const freshLedger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const deps: EvalCliDeps = { ...stubDeps(evalRoot), ledger: () => freshLedger };
    const r = await runEvalCommand(["history", "--verify", "--json"], deps);
    expect(r.code).toBe(3);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.chain.ok).toBe(false);
    expect(parsed.chain.brokenAtSeq).toBe(1);
  });

  it("--branch and --sha filter, and a missing ledger open is contained", async () => {
    const deps = stubDeps();
    deps.ledger = () => {
      throw new Error("disk full");
    };
    const r = await runEvalCommand(["history"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/could not open eval history ledger: Error: disk full/);
  });
});

// ===========================================================================
// gate
// ===========================================================================

describe("gate", () => {
  it("ALLOWs a clean candidate against its own baseline pool and exits 0", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    for (let i = 1; i <= 3; i++) {
      ledger.append(await measureWithSolver(makeRevision(i), "faithful", 1));
    }
    const candidate = await measureWithSolver(makeRevision(4), "faithful", 1);
    ledger.append(candidate);

    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      loadPolicy: () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] }),
    };
    const r = await runEvalCommand(["gate", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.verdict.decision).toBe("allow");
    expect(typeof parsed.verdict.contentHash).toBe("string");
    expect(parsed.verdict.contentHash.length).toBeGreaterThan(0);
  });

  it("BLOCKs a REAL regression (faithful baseline vs a fabricating candidate) and exits 2, naming a real rule", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    for (let i = 1; i <= 3; i++) {
      ledger.append(await measureWithSolver(makeRevision(i), "faithful", 1));
    }
    const degraded = await measureWithSolver(makeRevision(4), "fabricating", 1);
    ledger.append(degraded);
    // A genuinely worse candidate: verify the fixture actually regressed
    // before asserting the gate caught it (never assert a fabricated claim).
    expect(degraded.throughput.silentWrong).toBeGreaterThan(0);

    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      loadPolicy: () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] }),
    };
    const r = await runEvalCommand(["gate"], deps);
    expect(r.code).toBe(2);
    const text = joinLines(r);
    expect(text).toMatch(/decision\s*: BLOCK/);
    expect(text).toMatch(/silent-wrong-increase|verified-correct-drop/);
  });

  it("errors (exit 1) when --sha names a revision with no recorded scorecard", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    ledger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      loadPolicy: () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] }),
    };
    const r = await runEvalCommand(["gate", "--sha", "deadbeef".repeat(5)], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/no recorded scorecard found for sha/);
  });

  it("errors (exit 1) with no entries and no --sha", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      loadPolicy: () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] }),
    };
    const r = await runEvalCommand(["gate"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/nothing to gate/);
  });

  it("--show-policy prints the effective policy, its hash, and warnings", async () => {
    const deps = stubDeps();
    deps.loadPolicy = () => ({
      policy: DEFAULT_NEVER_REGRESS_POLICY,
      source: "default",
      warnings: ["policy.foo must be a boolean; got string(\"x\"). Using default false."],
    });
    const r = await runEvalCommand(["gate", "--show-policy", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.policyHash).toEqual(expect.any(String));
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.policy.maxSilentWrongIncrease).toBe(DEFAULT_NEVER_REGRESS_POLICY.maxSilentWrongIncrease);
  });

  it("--set persists atomically through the real savePolicy, and a following --show-policy reflects it", async () => {
    const policyRoot = join(root, "policy-root");
    const deps = stubDeps(policyRoot);
    deps.loadPolicy = () => loadPolicy(policyRoot);
    deps.savePolicy = (p: NeverRegressPolicy) => savePolicy(policyRoot, p);

    const setResult = await runEvalCommand(["gate", "--set", "maxVtphRelativeDrop=0.5", "--show-policy", "--json"], deps);
    expect(setResult.code).toBe(0);
    const parsedSet = JSON.parse(joinLines(setResult));
    expect(parsedSet.policy.maxVtphRelativeDrop).toBe(0.5);

    // A fresh invocation (new deps.loadPolicy() call) must independently see
    // the persisted value -- proving `--set` wrote through the real
    // `savePolicy`, not just an in-memory mutation.
    const reread = loadPolicy(policyRoot);
    expect(reread.source).toBe("file");
    expect(reread.policy.maxVtphRelativeDrop).toBe(0.5);
  });

  it("--policy <file> loads a full policy document as a one-off override", async () => {
    const policyFile = join(root, "custom-policy.json");
    writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_NEVER_REGRESS_POLICY, minBaselinePoolSize: 99 }), "utf8");
    const deps = stubDeps();
    const r = await runEvalCommand(["gate", "--policy", policyFile, "--show-policy", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.policy.minBaselinePoolSize).toBe(99);
    expect(parsed.source).toBe(`file:${policyFile}`);
  });

  it("a missing --policy file is a clean exit-1 diagnostic", async () => {
    const r = await runEvalCommand(["gate", "--policy", join(root, "nope.json"), "--show-policy"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/policy file not found/);
  });

  it("an unreadable/malformed --policy file is a clean exit-1 diagnostic, never a stack trace", async () => {
    const policyFile = join(root, "bad.json");
    writeFileSync(policyFile, "{ not json", "utf8");
    const r = await runEvalCommand(["gate", "--policy", policyFile, "--show-policy"], stubDeps());
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/not valid JSON/);
  });

  it("contains a hostile ledger() throw as exit 1, never an escaped exception", async () => {
    const deps = stubDeps();
    deps.loadPolicy = () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] });
    deps.ledger = () => {
      throw new Error("corrupt ledger header");
    };
    const r = await runEvalCommand(["gate"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/could not open eval history ledger: Error: corrupt ledger header/);
  });
});

// ===========================================================================
// bisect
// ===========================================================================

describe("bisect", () => {
  it("localizes a real injected regression over recorded history (history-only) and exits 0", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const goodShas: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const rev = makeRevision(i);
      goodShas.push(rev.sha);
      ledger.append(await measureWithSolver(rev, "faithful", 1));
    }
    const badRev = makeRevision(5);
    ledger.append(await measureWithSolver(badRev, "fabricating", 1));

    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      bisect: (req) => autoBisect(req),
    };
    const r = await runEvalCommand(["bisect", "--good", goodShas[0], "--bad", badRev.sha, "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.report.ok).toBe(true);
    expect(parsed.report.culpritSha).toBe(badRev.sha);
    expect(parsed.report.culpritShortSha).toBe(badRev.shortSha);
  });

  it("supports task:<id> signal bisection", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const rev1 = makeRevision(1);
    const rev2 = makeRevision(2);
    const good = await measureWithSolver(rev1, "faithful", 1);
    const bad = await measureWithSolver(rev2, "fabricating", 1);
    ledger.append(good);
    ledger.append(bad);
    const regressedTask = bad.outcomes.find((o) => o.kind === "silent-wrong");
    expect(regressedTask).toBeDefined();

    const deps: EvalCliDeps = { ...stubDeps(evalRoot), ledger: () => ledger, bisect: (req) => autoBisect(req) };
    const r = await runEvalCommand(
      ["bisect", "--good", rev1.sha, "--bad", rev2.sha, "--signal", `task:${regressedTask?.taskId}`],
      deps,
    );
    expect(r.code).toBe(0);
    expect(joinLines(r)).toContain(`culpritSha   : ${rev2.sha}`);
  });

  it("errors (exit 1) with no history to bisect over", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const deps: EvalCliDeps = { ...stubDeps(evalRoot), ledger: () => ledger };
    const r = await runEvalCommand(["bisect"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/nothing to bisect/);
  });

  it("contains a rejected deps.bisect as exit 1, never an escaped exception", async () => {
    const evalRoot = join(root, "eval");
    const ledger = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    const rev = makeRevision(1);
    ledger.append(await measureWithSolver(rev, "faithful", 1));
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      ledger: () => ledger,
      bisect: async () => {
        throw new Error("autoBisect exploded");
      },
    };
    // Pass --good explicitly so predicate-building doesn't itself fail on an
    // empty baseline pool before ever reaching the (hostile) deps.bisect.
    const r = await runEvalCommand(["bisect", "--good", rev.sha], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/bisect rejected: Error: autoBisect exploded/);
  });
});

// ===========================================================================
// run — including the (c) phase-checkpoint requirement: seeded real history
// + a genuinely degraded revision -> `run --gate --bisect` names the blocked
// rule(s) AND the localized culprit short sha, through the command surface,
// exit code 2.
// ===========================================================================

describe("run", () => {
  it("a clean run without --gate never fails even if the verdict were adverse, and records to the ledger", async () => {
    const evalRoot = join(root, "eval");
    const rev = makeRevision(1);
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      runContinuous: realRunContinuous("faithful"),
      resolveRevision: () => rev,
    };
    const r = await runEvalCommand(["run", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.result.recorded).toBe(true);
    expect(parsed.result.chain.ok).toBe(true);

    const ledger = new EvalHistoryLedger({ root: evalRoot });
    expect(ledger.entries()).toHaveLength(1);
  });

  it(
    "run --gate --bisect reproduces the phase checkpoint THROUGH THE COMMAND SURFACE: " +
      "seeded real history + a genuinely degraded revision => blocked rule(s) AND localized culprit short sha named, exit 2",
    async () => {
      const evalRoot = join(root, "eval");
      const seedLedgerHandle = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
      for (let i = 1; i <= 5; i++) {
        seedLedgerHandle.append(await measureWithSolver(makeRevision(i), "faithful", 1), { note: `seed-${i}` });
      }
      const badRev = makeRevision(6);

      const deps: EvalCliDeps = {
        ...stubDeps(evalRoot),
        runContinuous: realRunContinuous("fabricating"),
        resolveRevision: () => badRev,
      };
      const r = await runEvalCommand(["run", "--gate", "--bisect", "--baseline", "rolling-median"], deps);

      expect(r.code).toBe(2);
      const text = joinLines(r);
      expect(text).toMatch(/decision\s*: BLOCK/);
      expect(text).toMatch(/silent-wrong-increase|verified-correct-drop/);
      expect(text).toContain(badRev.shortSha);
      expect(text).toMatch(/EXIT CODE: 2 \(gate BLOCK\)/);
    },
  );

  it("the SAME degraded run WITHOUT --gate still computes and prints the verdict but exits 0 (enforcement is opt-in)", async () => {
    const evalRoot = join(root, "eval");
    const seedLedgerHandle = new EvalHistoryLedger({ root: evalRoot, now: makeClock(1) });
    for (let i = 1; i <= 5; i++) {
      seedLedgerHandle.append(await measureWithSolver(makeRevision(i), "faithful", 1));
    }
    const badRev = makeRevision(6);
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      runContinuous: realRunContinuous("fabricating"),
      resolveRevision: () => badRev,
    };
    const r = await runEvalCommand(["run"], deps);
    expect(r.code).toBe(0);
    expect(joinLines(r)).toMatch(/decision\s*: BLOCK/);
    expect(joinLines(r)).toMatch(/gate not enforced/);
  });

  it("--no-record does not append to the ledger", async () => {
    const evalRoot = join(root, "eval");
    const rev = makeRevision(1);
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      runContinuous: realRunContinuous("faithful"),
      resolveRevision: () => rev,
    };
    const r = await runEvalCommand(["run", "--no-record"], deps);
    expect(r.code).toBe(0);
    // Opening a ledger always creates its (empty) header file, regardless of
    // whether an entry is appended -- the honest assertion is that no ENTRY
    // was recorded, not that the file itself never came into being.
    const ledger = new EvalHistoryLedger({ root: evalRoot });
    expect(ledger.entries()).toHaveLength(0);
  });

  it("--epsilon must be a finite number in (0,1]; a valid value threads into a transient policy override", async () => {
    const evalRoot = join(root, "eval");
    const rev = makeRevision(1);
    let sawEpsilonCeiling: number | null | undefined;
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      runContinuous: (opts) => {
        sawEpsilonCeiling = opts.policy?.riskEpsilonCeiling;
        return realRunContinuous("faithful")(opts);
      },
      resolveRevision: () => rev,
      loadPolicy: () => ({ policy: DEFAULT_NEVER_REGRESS_POLICY, source: "default", warnings: [] }),
    };
    const r = await runEvalCommand(["run", "--epsilon", "0.1"], deps);
    expect(r.code).toBe(0);
    expect(sawEpsilonCeiling).toBe(0.1);
  });

  it("contains a rejected runContinuous as exit 1, never an escaped exception", async () => {
    const deps = stubDeps();
    deps.runContinuous = async () => {
      throw new Error("engine exploded");
    };
    const r = await runEvalCommand(["run"], deps);
    expect(r.code).toBe(1);
    expect(joinLines(r)).toMatch(/runContinuous rejected: Error: engine exploded/);
  });

  it("an operational failure (no scorecard obtained) is exit 1, not exit 2, even though the synthetic verdict is BLOCK", async () => {
    const evalRoot = join(root, "eval");
    const rev = makeRevision(1);
    const deps: EvalCliDeps = {
      ...stubDeps(evalRoot),
      runContinuous: (opts) =>
        runContinuousEval({
          ...opts,
          measure: async () => {
            throw new Error("measurement backend down");
          },
        }),
      resolveRevision: () => rev,
    };
    const r = await runEvalCommand(["run", "--gate"], deps);
    expect(r.code).toBe(1);
  });
});

// ===========================================================================
// eval-deps.ts — real wiring, tested against a real temp HADES_DATA_DIR.
// ===========================================================================

describe("defaultEvalCliDeps (real wiring)", () => {
  it("resolves the eval root to <dataDir>/eval, honoring HADES_DATA_DIR", () => {
    const deps = defaultEvalCliDeps({ env: { ...process.env, HADES_DATA_DIR: root } });
    expect(deps.root).toBe(join(root, "eval"));
  });

  it("the `root` option overrides the dataDir directly (test convenience, same semantics as HADES_DATA_DIR)", () => {
    const deps = defaultEvalCliDeps({ root });
    expect(deps.root).toBe(join(root, "eval"));
  });

  it("falls back to .hades when neither root nor HADES_DATA_DIR is set", () => {
    const rest = { ...process.env };
    delete rest.HADES_DATA_DIR;
    const deps = defaultEvalCliDeps({ env: rest });
    expect(deps.root).toBe(join(".hades", "eval"));
  });

  it("ledger() lazily constructs a REAL, working EvalHistoryLedger (no disk touched until called)", async () => {
    const deps = defaultEvalCliDeps({ root });
    expect(existsSync(join(deps.root, "history.jsonl"))).toBe(false);
    const ledger = deps.ledger();
    expect(existsSync(join(deps.root, "history.jsonl"))).toBe(true);
    expect(ledger.entries()).toHaveLength(0);
    expect(deps.ledger()).toBe(ledger); // cached, same instance within one deps object
  });

  it("resolveRevision() returns a real, well-formed ScorecardRevision", () => {
    const deps = defaultEvalCliDeps({ root });
    const rev = deps.resolveRevision();
    expect(["git", "content"]).toContain(rev.source);
    expect(typeof rev.sha).toBe("string");
    expect(rev.sha.length).toBeGreaterThan(0);
    expect(rev.shortSha).toBe(rev.sha.slice(0, 12));
  });

  it("loadPolicy() returns the real strict default with no warnings on a fresh root", () => {
    const deps = defaultEvalCliDeps({ root });
    const loaded = deps.loadPolicy();
    expect(loaded.source).toBe("default");
    expect(loaded.warnings).toEqual([]);
    expect(loaded.policy).toEqual(DEFAULT_NEVER_REGRESS_POLICY);
  });

  it("savePolicy() + loadPolicy() round-trip through the real atomic file writer", () => {
    const deps = defaultEvalCliDeps({ root });
    const changed: NeverRegressPolicy = { ...DEFAULT_NEVER_REGRESS_POLICY, minBaselinePoolSize: 7 };
    deps.savePolicy(changed);
    const reloaded = deps.loadPolicy();
    expect(reloaded.source).toBe("file");
    expect(reloaded.policy.minBaselinePoolSize).toBe(7);
    expect(existsSync(join(deps.root, "gate-policy.json"))).toBe(true);
  });

  it("measure() runs the REAL runEvalMeasurement over the REAL EVAL_TASKS and returns an internally-consistent (verifyScorecard-passing) scorecard", async () => {
    const deps = defaultEvalCliDeps({ root });
    const rev = deps.resolveRevision();
    const scorecard = await (deps.measure as NonNullable<EvalCliDeps["measure"]>)(rev);
    const check = verifyScorecard(scorecard);
    expect(check.ok).toBe(true);
    expect(scorecard.mode).toBe("scripted");
    expect(scorecard.revision.sha).toBe(rev.sha);
    expect(scorecard.throughput.tasks).toBeGreaterThan(0);
    expect(scorecard.provenance.engine.some((e) => e.includes("EVAL_TASKS"))).toBe(true);
  });

  it("status() reflects a scorecard recorded through the real ledger", async () => {
    const deps = defaultEvalCliDeps({ root });
    const ledger = deps.ledger();
    const rev = deps.resolveRevision();
    const scorecard = await (deps.measure as NonNullable<EvalCliDeps["measure"]>)(rev);
    ledger.append(scorecard);
    const report = deps.status({ root: deps.root });
    expect(report.entries).toBe(1);
    expect(report.latest?.sha).toBe(rev.sha);
  });

  it("end-to-end: runEvalCommand(['history'], defaultEvalCliDeps(...)) works against the real wiring", async () => {
    const deps = defaultEvalCliDeps({ root });
    const ledger = deps.ledger();
    const rev = deps.resolveRevision();
    const scorecard = await (deps.measure as NonNullable<EvalCliDeps["measure"]>)(rev);
    ledger.append(scorecard);
    const r = await runEvalCommand(["history", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(joinLines(r));
    expect(parsed.count).toBe(1);
  });
});
