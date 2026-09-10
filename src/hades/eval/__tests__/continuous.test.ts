import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVAL_CONTINUOUS_VERSION,
  runContinuousEval,
  evalStatus,
  formatContinuousResult,
  formatEvalStatus,
  type ContinuousEvent,
  type ContinuousEventKind,
  type ContinuousEvalResult,
  type ContinuousEvalOptions,
} from "../continuous";

import { runEvalMeasurement, scriptedEvalRunner } from "../measure";
import { EvalHistoryLedger } from "../history";
import type { EvalScorecard, ScorecardRevision } from "../scorecard";
import { GateVerdictJournal } from "../regression-gate";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { AdmitFn, RiskEvalSubject } from "../../trust/risk-eval";
import * as bisectModule from "../bisect";

// ===========================================================================
// Fixtures — REAL runEvalMeasurement + REAL EVAL_TASKS (default suite) +
// REAL scripted solvers + a REAL EvalHistoryLedger over a real mkdtempSync
// dir, exactly as the REAL-VS-MOCK contract requires. `now` is injected only
// for determinism; every scorecard produced below is genuine real-engine
// output.
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
 *  unmeasured risk lane's NaN fields become `null` through JSON, which would
 *  fail `verifyScorecard` on read-back (see `regression-gate.test.ts`'s
 *  identical fixture and its documentation of this exact hazard). */
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

/** Real measurement over the real default `EVAL_TASKS`, through one of the
 *  real deterministic scripted solvers, with a real (always-abstain) risk
 *  lane so persistence never corrupts. `clockStepMs` drives a fresh,
 *  self-contained deterministic clock -- controlling it lets tests engineer
 *  an EXACT, reproducible `wallClockMs` (and therefore `vtph`) without any
 *  wall-clock flakiness, using only the real, documented `now` injection
 *  seam every module in this stack already exposes. */
async function measureWithSolver(
  revision: ScorecardRevision,
  solverLabel: SolverLabel,
  clockStepMs = 1,
): Promise<EvalScorecard> {
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

// Accumulates every `ContinuousEventKind` observed across the WHOLE suite so
// requirement (e) ("every event kind is emitted at least once across the
// suite") can be verified by one assertion at the end.
const seenEventKinds = new Set<ContinuousEventKind>();

async function runTracked(opts: ContinuousEvalOptions): Promise<ContinuousEvalResult> {
  const r = await runContinuousEval(opts);
  for (const e of r.events) seenEventKinds.add(e.kind);
  return r;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-continuous-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ===========================================================================
// Locked surface
// ===========================================================================

describe("locked surface", () => {
  it("exposes EVAL_CONTINUOUS_VERSION = 1", () => {
    expect(EVAL_CONTINUOUS_VERSION).toBe(1);
  });
});

// ===========================================================================
// (a) THE PHASE CHECKPOINT
// ===========================================================================

describe("phase checkpoint", () => {
  it(
    "catches, blocks, and localizes an injected regression in one runContinuousEval call",
    async () => {
      const N = 10;
      // A SINGLE shared ledger-recordedAtMs clock spans the seed phase and
      // the final `runContinuousEval` call below, so `autoBisect`'s
      // recorded-time chain-ordering fallback (there is no real git
      // ancestry for these synthetic shas) sees the entries in true
      // insertion order -- exactly what "revision K, then a later revision"
      // means for a chain that has no real git commits behind it.
      const sharedClock = makeClock(1);
      const seedLedger = new EvalHistoryLedger({ root, now: sharedClock });

      // Seed N>=10 revisions measured by the REAL engine with a faithful runner.
      let firstGoodCard: EvalScorecard | null = null;
      for (let i = 0; i < N; i++) {
        const rev = makeRevision(i + 1);
        const card = await measureWithSolver(rev, "faithful", 1);
        if (firstGoodCard === null) firstGoodCard = card;
        seedLedger.append(card, { note: `seed-good-${i}` });
      }
      expect(firstGoodCard).not.toBeNull();

      // Measure revision K with a genuinely degraded (fabricating) runner --
      // real verified-throughput drop and real silent-wrong increase, no
      // hand-written numbers.
      const revK = makeRevision(N + 1);
      const cardK = await measureWithSolver(revK, "fabricating", 1);
      seedLedger.append(cardK, { note: "seed-bad-K" });

      expect(cardK.throughput.verifiedCorrect).toBeLessThan(firstGoodCard!.throughput.verifiedCorrect);
      expect(cardK.throughput.silentWrong).toBeGreaterThan(firstGoodCard!.throughput.silentWrong);

      // Measure a LATER revision (the regression is still present at HEAD)
      // through `runContinuousEval` itself, with bisectOnBlock:true.
      const revLater = makeRevision(N + 2);
      const result = await runTracked({
        root,
        resolve: () => revLater,
        measure: measureFnFor("fabricating", 1),
        bisectOnBlock: true,
        now: sharedClock,
      });

      expect(result.verdict.decision).toBe("block");
      const ruleNames = result.verdict.findings.map((f) => f.rule);
      expect(ruleNames).toContain("verified-correct-drop");
      expect(ruleNames).toContain("silent-wrong-increase");

      expect(result.bisect).not.toBeNull();
      expect(result.bisect!.ok).toBe(true);
      expect(result.bisect!.culpritSha).toBe(revK.sha);
      expect(result.bisect!.confidence).toBe("exact");
      expect(result.bisect!.lastGoodSha).not.toBeNull();

      // The event stream actually narrates this: gate blocked, then bisect ran.
      const gateEv = result.events.find((e) => e.kind === "gate-evaluated");
      expect(gateEv?.decision).toBe("block");
      expect(result.events.some((e) => e.kind === "bisect-started")).toBe(true);
      const bisectEv = result.events.find((e) => e.kind === "bisect-finished");
      expect(bisectEv?.detail?.culpritSha).toBe(revK.sha);
    },
    30_000,
  );
});

// ===========================================================================
// (b) Idempotence / dedupe
// ===========================================================================

describe("idempotence / dedupe (skipIfRecorded)", () => {
  it("skips re-measuring a clean already-recorded revision, but still produces a valid read-only verdict/trend; a dirty worktree is never treated as a duplicate", async () => {
    const rev = makeRevision(1);
    let measureCalls = 0;
    const measure = async (r: ScorecardRevision): Promise<EvalScorecard> => {
      measureCalls += 1;
      return measureWithSolver(r, "faithful", 1);
    };

    const first = await runTracked({ root, resolve: () => rev, measure, now: makeClock(1) });
    expect(first.recorded).toBe(true);
    expect(first.skipped).toBe(false);
    expect(measureCalls).toBe(1);

    const second = await runTracked({
      root,
      resolve: () => rev,
      measure,
      skipIfRecorded: true,
      now: makeClock(1),
    });
    expect(second.skipped).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.skippedReason).not.toBeNull();
    expect(measureCalls).toBe(1); // measure was NOT called again
    expect(second.scorecard).not.toBeNull();
    expect(second.scorecard!.scorecardId).toBe(first.scorecard!.scorecardId);
    expect(second.verdict.decision).toBeDefined();
    expect(second.trend.length).toBeGreaterThan(0);
    expect(second.chain.ok).toBe(true);

    // A dirty worktree at the SAME sha must never be treated as a duplicate.
    const dirtyRev: ScorecardRevision = { ...rev, dirty: true };
    const third = await runTracked({
      root,
      resolve: () => dirtyRev,
      measure,
      skipIfRecorded: true,
      now: makeClock(1),
    });
    expect(third.skipped).toBe(false);
    expect(measureCalls).toBe(2);
  });

  it("does not skip when the ledger's current (most-recently-recorded) suiteHash/mode differs from what was recorded for this sha", async () => {
    // The dedupe check must decide whether to skip WITHOUT invoking
    // `measure()` (that is the whole point of skipping) -- so it infers
    // "current suite" from the most recently recorded entry in the ledger,
    // mirroring `selectBaseline`'s own suite-inference convention. This
    // test exercises that convention directly: once a DIFFERENT revision
    // with a DIFFERENT suite becomes the most-recent entry, a sha whose own
    // recorded suiteHash no longer matches "current" must not be deduped.
    const revA = makeRevision(1);
    let measureCalls = 0;
    const measureFull = async (r: ScorecardRevision): Promise<EvalScorecard> => {
      measureCalls += 1;
      return measureWithSolver(r, "faithful", 1);
    };
    await runTracked({ root, resolve: () => revA, measure: measureFull, now: makeClock(1) });
    expect(measureCalls).toBe(1);

    const { EVAL_TASKS } = await import("../../bench/eval-suite");
    const smallerSuite = EVAL_TASKS.slice(0, 5);
    const measureSmaller = async (r: ScorecardRevision): Promise<EvalScorecard> => {
      measureCalls += 1;
      const solver = scriptedSolvers().find((s) => s.label === "faithful")!;
      return runEvalMeasurement({
        revision: r,
        tasks: smallerSuite,
        runner: scriptedEvalRunner(solver),
        admit: alwaysAbstainAdmit,
        now: makeClock(1),
      });
    };
    const revB = makeRevision(2);
    await runTracked({ root, resolve: () => revB, measure: measureSmaller, now: makeClock(1) });
    expect(measureCalls).toBe(2);

    const again = await runTracked({
      root,
      resolve: () => revA,
      measure: measureFull,
      skipIfRecorded: true,
      now: makeClock(1),
    });
    expect(again.skipped).toBe(false);
    expect(measureCalls).toBe(3);
  });
});

// ===========================================================================
// (c) Failure containment
// ===========================================================================

describe("failure containment", () => {
  it("contains a measure() that throws: error event + honest non-allow verdict, function does not reject", async () => {
    const rev = makeRevision(1);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: async () => {
        throw new Error("boom-measure");
      },
      now: makeClock(1),
    });
    expect(result.scorecard).toBeNull();
    expect(result.entry).toBeNull();
    expect(result.recorded).toBe(false);
    expect(result.verdict.decision).toBe("block");
    expect(result.verdict.decision).not.toBe("allow");
    expect(result.events.some((e) => e.kind === "error" && e.message.includes("boom-measure"))).toBe(true);
    expect(result.changepoint).toBeDefined();
    expect(result.trend).toEqual([]);
  });

  it("contains a tampered candidate scorecard: ledger.append() throws HistoryScorecardError, and the gate independently blocks via scorecard-invalid", async () => {
    const rev = makeRevision(1);
    const measure = async (r: ScorecardRevision): Promise<EvalScorecard> => {
      const card = await measureWithSolver(r, "faithful", 1);
      // Hand-tamper a throughput field without resealing -- fails verifyScorecard.
      return { ...card, throughput: { ...card.throughput, verifiedCorrect: card.throughput.verifiedCorrect + 999 } };
    };
    const result = await runTracked({ root, resolve: () => rev, measure, now: makeClock(1) });
    expect(result.verdict.decision).toBe("block");
    expect(result.verdict.findings.some((f) => f.rule === "scorecard-invalid")).toBe(true);
    expect(result.recorded).toBe(false);
    expect(result.events.some((e) => e.kind === "error" && e.message.includes("ledger.append"))).toBe(true);
  });

  it("contains a HistoryLockError from a held lock: error event + honest non-allow verdict, no throw", async () => {
    const ledger = new EvalHistoryLedger({ root, lockTimeoutMs: 50, now: makeClock(1) });
    // Hold the lock externally AFTER the ledger's own header write completed,
    // so the SUBSEQUENT append() inside runContinuousEval times out.
    mkdirSync(join(root, ".lock"));
    try {
      const rev = makeRevision(1);
      const result = await runTracked({
        root,
        resolve: () => rev,
        ledger,
        measure: measureFnFor("faithful", 1),
        now: makeClock(1),
      });
      expect(result.recorded).toBe(false);
      expect(result.verdict.decision).not.toBe("allow");
      expect(result.events.some((e) => e.kind === "error" && e.message.toLowerCase().includes("lock"))).toBe(true);
    } finally {
      rmSync(join(root, ".lock"), { recursive: true, force: true });
    }
  }, 10_000);

  it("contains mid-file history corruption (HistoryCorruptionError): entries/append/verifyChain all degrade honestly", async () => {
    const seedLedger = new EvalHistoryLedger({ root, now: makeClock(1) });
    seedLedger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    seedLedger.append(await measureWithSolver(makeRevision(2), "faithful", 1));

    const historyPath = join(root, "history.jsonl");
    const lines = readFileSync(historyPath, "utf8").split("\n");
    // lines[0]=header, lines[1]=entry seq0 (NOT the last real entry) -- corrupt it.
    lines[1] = "{not valid json at all";
    writeFileSync(historyPath, lines.join("\n"));

    const rev = makeRevision(3);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.recorded).toBe(false);
    expect(result.verdict.decision).not.toBe("allow");
    expect(result.chain.ok).toBe(false);
    expect(result.events.filter((e) => e.kind === "error").length).toBeGreaterThan(0);
  });

  it("contains a future-version history header (HistoryVersionError)", async () => {
    new EvalHistoryLedger({ root, now: makeClock(1) }); // writes a real v1 header
    const historyPath = join(root, "history.jsonl");
    writeFileSync(historyPath, `${JSON.stringify({ version: 999 })}\n`);

    const rev = makeRevision(1);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.recorded).toBe(false);
    expect(result.verdict.decision).not.toBe("allow");
    expect(result.chain.ok).toBe(false);
    expect(result.events.some((e) => e.kind === "error")).toBe(true);
  });

  it("contains a corrupted-but-parseable chain (verifyChain().ok===false, no throw): error event + honest non-allow verdict", async () => {
    const seedLedger = new EvalHistoryLedger({ root, now: makeClock(1) });
    seedLedger.append(await measureWithSolver(makeRevision(1), "faithful", 1), { note: "orig" });
    seedLedger.append(await measureWithSolver(makeRevision(2), "faithful", 1));

    const historyPath = join(root, "history.jsonl");
    const lines = readFileSync(historyPath, "utf8").split("\n");
    const parsed = JSON.parse(lines[1]) as { note: string };
    parsed.note = "TAMPERED";
    lines[1] = JSON.stringify(parsed);
    writeFileSync(historyPath, lines.join("\n"));

    const rev = makeRevision(3);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.chain.ok).toBe(false);
    expect(result.chain.reason).toBe("hash-mismatch");
    expect(result.verdict.decision).not.toBe("allow");
    expect(result.events.some((e) => e.kind === "error" && e.message.toLowerCase().includes("chain"))).toBe(true);
  });

  it("contains a malformed gate-policy.json: falls back to the strict default policy with an error event, never throws", async () => {
    writeFileSync(join(root, "gate-policy.json"), "{ this is not valid json");
    const rev = makeRevision(1);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.events.some((e) => e.kind === "error" && e.message.toLowerCase().includes("policy"))).toBe(true);
    expect(result.verdict).toBeDefined();
    // Recording still proceeds normally -- the fallback is honest, not fatal.
    expect(result.recorded).toBe(true);
  });

  it("contains an autoBisect that throws: error event, bisect stays null, verdict/decision unaffected, no throw", async () => {
    const N = 10;
    const sharedClock = makeClock(1);
    const seedLedger = new EvalHistoryLedger({ root, now: sharedClock });
    for (let i = 0; i < N; i++) {
      seedLedger.append(await measureWithSolver(makeRevision(i + 1), "faithful", 1));
    }
    const revK = makeRevision(N + 1);
    seedLedger.append(await measureWithSolver(revK, "fabricating", 1));

    const spy = vi.spyOn(bisectModule, "autoBisect").mockImplementationOnce(async () => {
      throw new Error("boom-bisect");
    });
    try {
      const revLater = makeRevision(N + 2);
      const result = await runTracked({
        root,
        resolve: () => revLater,
        measure: measureFnFor("fabricating", 1),
        bisectOnBlock: true,
        now: sharedClock,
      });
      expect(result.verdict.decision).toBe("block");
      expect(result.bisect).toBeNull();
      expect(result.events.some((e) => e.kind === "error" && e.message.includes("boom-bisect"))).toBe(true);
      expect(result.events.some((e) => e.kind === "bisect-started")).toBe(true);
      expect(result.events.some((e) => e.kind === "bisect-finished")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

// ===========================================================================
// (d) record:false is a true dry run
// ===========================================================================

describe("dry run (record:false)", () => {
  it("performs zero writes to the ledger file (byte-identical before/after) yet still produces a full verdict + trend, and never touches the gate journal", async () => {
    const seedLedger = new EvalHistoryLedger({ root, now: makeClock(1) });
    for (let i = 0; i < 3; i++) {
      seedLedger.append(await measureWithSolver(makeRevision(i + 1), "faithful", 1));
    }
    const historyPath = join(root, "history.jsonl");
    const before = readFileSync(historyPath);

    const rev = makeRevision(4);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      record: false,
      now: makeClock(1),
    });

    const after = readFileSync(historyPath);
    expect(Buffer.compare(before, after)).toBe(0);
    expect(result.recorded).toBe(false);
    expect(result.entry).toBeNull();
    expect(result.verdict).toBeDefined();
    expect(result.trend.length).toBeGreaterThan(0);
    expect(result.scorecard).not.toBeNull();
    expect(existsSync(join(root, "gate-verdicts.jsonl"))).toBe(false);
  });
});

// ===========================================================================
// (e) Event stream: ordering, onEvent safety, and cross-suite completeness
// ===========================================================================

describe("event stream", () => {
  it("is ordered and monotone in atMs under the injected clock; onEvent throwing never breaks the run", async () => {
    const rev = makeRevision(1);
    const observed: ContinuousEvent[] = [];
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
      onEvent: (e) => {
        observed.push(e);
        throw new Error("onEvent boom -- must never break the run");
      },
    });
    expect(result.events.length).toBeGreaterThan(5);
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i].atMs).toBeGreaterThanOrEqual(result.events[i - 1].atMs);
    }
    expect(observed.length).toBe(result.events.length);
    expect(result.verdict).toBeDefined(); // the run completed normally despite onEvent throwing
  });

  it("gate-evaluated events carry the decision field matching the final verdict", async () => {
    const result = await runTracked({
      root,
      resolve: () => makeRevision(1),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    const ev = result.events.find((e) => e.kind === "gate-evaluated");
    expect(ev).toBeDefined();
    expect(ev!.decision).toBe(result.verdict.decision);
  });

  // This MUST run after every other test in the file has had a chance to
  // populate `seenEventKinds` via `runTracked` -- see file-level comment.
  it("every ContinuousEventKind is emitted at least once across the suite (checked last)", () => {
    const allKinds: ContinuousEventKind[] = [
      "revision-resolved",
      "duplicate-skipped",
      "measure-started",
      "measure-finished",
      "recorded",
      "baseline-selected",
      "gate-evaluated",
      "bisect-started",
      "bisect-finished",
      "trend-computed",
      "error",
    ];
    for (const k of allKinds) {
      expect(seenEventKinds.has(k), `expected event kind "${k}" to have been observed somewhere in the suite`).toBe(true);
    }
  });
});

// ===========================================================================
// (f) Cross-process reality
// ===========================================================================

describe("cross-process reality", () => {
  it("two runContinuousEval calls against the same root, each opening its OWN EvalHistoryLedger instance, leave a chain verifyChain() accepts with contiguous seq", async () => {
    const r1 = await runTracked({
      root,
      resolve: () => makeRevision(1),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    const r2 = await runTracked({
      root,
      resolve: () => makeRevision(2),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });

    expect(r1.entry).not.toBeNull();
    expect(r2.entry).not.toBeNull();
    expect(r1.entry!.seq).toBe(0);
    expect(r2.entry!.seq).toBe(1);
    expect(r2.chain.ok).toBe(true);
    expect(r2.chain.entries).toBe(2);

    const finalLedger = new EvalHistoryLedger({ root });
    const verify = finalLedger.verifyChain();
    expect(verify.ok).toBe(true);
    expect(verify.entries).toBe(2);
  });
});

// ===========================================================================
// (g) evalStatus — strictly read-only
// ===========================================================================

describe("evalStatus", () => {
  it("is correct on an empty root (no history.jsonl) without ever creating one", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "hades-continuous-empty-"));
    try {
      expect(existsSync(join(emptyRoot, "history.jsonl"))).toBe(false);
      const status = evalStatus({ root: emptyRoot });
      expect(status.entries).toBe(0);
      expect(status.latest).toBeNull();
      expect(status.latestVerdict).toBeNull();
      expect(status.chain.ok).toBe(true);
      expect(status.baseline.ok).toBe(false);
      expect(status.changepoint.detected).toBe(false);
      expect(status.policySource).toBe("default");
      expect(existsSync(join(emptyRoot, "history.jsonl"))).toBe(false);
      expect(existsSync(join(emptyRoot, "gate-verdicts.jsonl"))).toBe(false);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("is correct on a root with only a header (ledger initialized, zero entries)", () => {
    new EvalHistoryLedger({ root });
    const status = evalStatus({ root });
    expect(status.entries).toBe(0);
    expect(status.latest).toBeNull();
    expect(status.chain.ok).toBe(true);
  });

  it("is correct on a compacted ledger", async () => {
    const ledger = new EvalHistoryLedger({ root, now: makeClock(1) });
    for (let i = 0; i < 5; i++) {
      ledger.append(await measureWithSolver(makeRevision(i + 1), "faithful", 1));
    }
    const { removed } = ledger.compact(2);
    expect(removed).toBe(3);

    const status = evalStatus({ root });
    expect(status.entries).toBe(2);
    expect(status.chain.ok).toBe(true);
    expect(status.latest).not.toBeNull();
    expect(status.latest!.seq).toBe(4);
  });

  it("reports latestVerdict:null with a warning when the gate journal file is missing, even though history entries exist", async () => {
    const ledger = new EvalHistoryLedger({ root, now: makeClock(1) });
    ledger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    expect(existsSync(join(root, "gate-verdicts.jsonl"))).toBe(false);

    const status = evalStatus({ root });
    expect(status.latest).not.toBeNull();
    expect(status.latestVerdict).toBeNull();
    expect(status.warnings.some((w) => w.includes("gate-verdicts.jsonl"))).toBe(true);
    expect(existsSync(join(root, "gate-verdicts.jsonl"))).toBe(false);
  });

  it("never writes: history.jsonl and gate-verdicts.jsonl are byte-identical before/after, even when both already exist", async () => {
    const result = await runTracked({
      root,
      resolve: () => makeRevision(1),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.recorded).toBe(true);
    const historyPath = join(root, "history.jsonl");
    const journalPath = join(root, "gate-verdicts.jsonl");
    expect(existsSync(journalPath)).toBe(true);

    const beforeH = readFileSync(historyPath);
    const beforeJ = readFileSync(journalPath);
    const status = evalStatus({ root });
    expect(status.latestVerdict).not.toBeNull();
    const afterH = readFileSync(historyPath);
    const afterJ = readFileSync(journalPath);
    expect(Buffer.compare(beforeH, afterH)).toBe(0);
    expect(Buffer.compare(beforeJ, afterJ)).toBe(0);
  });

  it("appends every recorded run's verdict to the real GateVerdictJournal under root", async () => {
    const rev = makeRevision(1);
    const result = await runTracked({
      root,
      resolve: () => rev,
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.recorded).toBe(true);
    const journal = new GateVerdictJournal({ root });
    const verify = journal.verify();
    expect(verify.ok).toBe(true);
    expect(verify.entries).toBe(1);
    const latest = journal.latest(rev.sha);
    expect(latest).not.toBeNull();
    expect(latest!.contentHash).toBe(result.verdict.contentHash);
  });
});

// ===========================================================================
// (h) Trend/changepoint wired to T1's real functions; slow drift the
// pairwise gate misses but the changepoint catches.
// ===========================================================================

describe("trend + changepoint", () => {
  it(
    "a slow multi-revision V-TPH$ drift that never trips the pairwise gate is still reported by changepoint.detected",
    async () => {
      const STEPS = 24;
      const ledger = new EvalHistoryLedger({ root, now: makeClock(1) });
      let clockStep = 1.0;
      for (let i = 0; i < STEPS; i++) {
        const rev = makeRevision(i + 1);
        const card = await measureWithSolver(rev, "faithful", clockStep);
        ledger.append(card, { note: `drift-${i}` });
        clockStep *= 1.008; // ~0.8% wall-clock growth per step -- well under the 2% pairwise threshold
      }

      const lastRev = makeRevision(STEPS + 1);
      const result = await runTracked({
        root,
        resolve: () => lastRev,
        measure: measureFnFor("faithful", clockStep),
        baseline: { strategy: "latest", excludeSha: lastRev.sha },
        now: makeClock(1),
      });

      // Pairwise gate: comparing against the immediately-preceding revision,
      // the single-step vtph drop is tiny -- ALLOW, no vtph finding at all.
      expect(result.baseline.ok).toBe(true);
      expect(result.verdict.decision).toBe("allow");
      expect(result.verdict.findings.find((f) => f.rule === "vtph-relative-drop")).toBeUndefined();
      expect(result.verdict.findings.filter((f) => f.severity !== "info").length).toBe(0);

      // Changepoint: computed over the WHOLE recorded trend -- the
      // cumulative drift across all `STEPS` revisions is real (genuinely
      // computed from the injected-but-real deterministic clock) and large
      // enough to trip CUSUM, even though no single pairwise step did.
      expect(result.trend.length).toBeGreaterThanOrEqual(STEPS + 1);
      expect(result.changepoint.detected).toBe(true);
      expect(result.changepoint.direction).toBe("regressed");
      expect(result.changepoint.atIndex).not.toBeNull();
    },
    30_000,
  );
});

// ===========================================================================
// Baseline / policy honesty
// ===========================================================================

describe("baseline / policy honesty", () => {
  it("the first-ever revision (empty history) is baseline-missing and decision defaults to warn -- never a silent allow", async () => {
    const result = await runTracked({
      root,
      resolve: () => makeRevision(1),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.baseline.ok).toBe(false);
    expect(result.verdict.decision).toBe("warn");
    expect(result.verdict.decision).not.toBe("allow");
    expect(result.verdict.findings.some((f) => f.rule === "baseline-missing")).toBe(true);
  });

  it("an unchanged (identical faithful) candidate against a real baseline genuinely ALLOWs", async () => {
    const ledger = new EvalHistoryLedger({ root, now: makeClock(1) });
    ledger.append(await measureWithSolver(makeRevision(1), "faithful", 1));
    const result = await runTracked({
      root,
      resolve: () => makeRevision(2),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    expect(result.baseline.ok).toBe(true);
    expect(result.verdict.decision).toBe("allow");
  });
});

// ===========================================================================
// (i) Formatting — aligned plain ASCII, terminal-only
// ===========================================================================

describe("formatting", () => {
  it("formatContinuousResult renders aligned ASCII sections with no HTML/markup", async () => {
    const result = await runTracked({
      root,
      resolve: () => makeRevision(1),
      measure: measureFnFor("faithful", 1),
      now: makeClock(1),
    });
    const lines = formatContinuousResult(result);
    expect(lines[0]).toBe("HADES CONTINUOUS EVAL");
    expect(lines.every((l) => typeof l === "string")).toBe(true);
    expect(lines.some((l) => l.startsWith("revision"))).toBe(true);
    expect(lines.some((l) => l === "GATE VERDICT")).toBe(true);
    expect(lines.some((l) => l === "TREND")).toBe(true);
    expect(lines.some((l) => l.startsWith("EVENTS ("))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/<[a-zA-Z][^>]*>/);
  });

  it("formatContinuousResult renders a BISECT section when a bisect report is present", async () => {
    const N = 10;
    const sharedClock = makeClock(1);
    const seedLedger = new EvalHistoryLedger({ root, now: sharedClock });
    for (let i = 0; i < N; i++) {
      seedLedger.append(await measureWithSolver(makeRevision(i + 1), "faithful", 1));
    }
    seedLedger.append(await measureWithSolver(makeRevision(N + 1), "fabricating", 1));
    const result = await runTracked({
      root,
      resolve: () => makeRevision(N + 2),
      measure: measureFnFor("fabricating", 1),
      bisectOnBlock: true,
      now: sharedClock,
    });
    const lines = formatContinuousResult(result);
    expect(lines.some((l) => l === "BISECT")).toBe(true);
    expect(lines.some((l) => l.includes("confidence"))).toBe(true);
  }, 30_000);

  it("formatEvalStatus renders aligned ASCII sections", () => {
    const lines = formatEvalStatus(evalStatus({ root }));
    expect(lines[0]).toBe("HADES EVAL STATUS");
    expect(lines.some((l) => l === "LATEST ENTRY")).toBe(true);
    expect(lines.some((l) => l === "LATEST VERDICT")).toBe(true);
    expect(lines.some((l) => l === "TREND")).toBe(true);
  });
});
