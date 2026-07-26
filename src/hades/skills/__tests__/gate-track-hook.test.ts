/* ------------------------------------------------------------------ *
 * gate-track-hook.test.ts
 *
 * REAL-VS-MOCK POLICY: every test drives the real `SkillTrackRecordStore`
 * (an in-memory `TrackRecordFs` double, the same one `track-record.test.ts`
 * uses, standing in only for the disk — never a mock of `record`/`load`/
 * `verifyChain` themselves). The "real gate" test at the bottom drives a
 * real `VerificationGate` with a deterministic injected `Judge` (no network,
 * no randomness) to prove `GatedSkillUse` values built from genuine
 * `VerificationReport`s map through `GateTrackRecorder` correctly, and that
 * the resulting `wilsonLower`/`brier` match independent recomputation via
 * the exported `brierScore`/`wilsonLowerBound`. No fabricated numbers are
 * asserted anywhere — every expected value is either a literal derived from
 * the fixture inputs or a recomputation through the real math.
 * ------------------------------------------------------------------ */
import { describe, expect, it } from "vitest";

import {
  GateTrackRecorder,
  gateUseToOutcome,
  type GatedSkillUse,
  type RecordReport,
} from "../gate-track-hook";
import {
  SkillTrackRecordStore,
  brierScore,
  wilsonLowerBound,
  type TrackRecordFs,
} from "../track-record";
import { VerificationGate, type Judge } from "../../../swarm-runtime/verification/gate";
import type { WorkerResult } from "../../../swarm-runtime/types";

// ===========================================================================
// helpers
// ===========================================================================

/** Shared in-memory TrackRecordFs, so multiple store instances can see the same bytes. */
function makeSharedFs(): { fs: TrackRecordFs; files: Map<string, string> } {
  const files = new Map<string, string>();
  const fs: TrackRecordFs = {
    readFile(p) {
      return files.has(p) ? (files.get(p) as string) : null;
    },
    writeFile(p, c) {
      files.set(p, c);
    },
    mkdirp() {
      /* no-op */
    },
  };
  return { fs, files };
}

function makeStore(fs: TrackRecordFs, now: () => number = () => 1_000): SkillTrackRecordStore {
  return new SkillTrackRecordStore({ path: "/virtual/skill-track.json", fs, now, window: 20 });
}

function use(partial: Partial<GatedSkillUse> & Pick<GatedSkillUse, "skillNames" | "verdict">): GatedSkillUse {
  return {
    pCorrect: 0.8,
    taskId: "task-1",
    at: 1_000,
    ...partial,
  };
}

function fanOut(report: RecordReport): number {
  return report.recorded.length + report.skipped.length;
}

// ===========================================================================
// gateUseToOutcome — pure mapping
// ===========================================================================

describe("gateUseToOutcome", () => {
  it("maps accept -> success:true, predictedP=pCorrect, at passed through", () => {
    const g = use({ skillNames: ["a"], verdict: "accept", pCorrect: 0.73, at: 555 });
    const outcome = gateUseToOutcome(g, "a");
    expect(outcome).toEqual({ skillName: "a", predictedP: 0.73, success: true, at: 555 });
  });

  it("maps reject -> success:false", () => {
    const g = use({ skillNames: ["a"], verdict: "reject", pCorrect: 0.2, at: 900 });
    const outcome = gateUseToOutcome(g, "a");
    expect(outcome).toEqual({ skillName: "a", predictedP: 0.2, success: false, at: 900 });
  });

  it("maps abstain -> null", () => {
    const g = use({ skillNames: ["a"], verdict: "abstain" });
    expect(gateUseToOutcome(g, "a")).toBeNull();
  });

  it("passes certSha256 through when present", () => {
    const g = use({ skillNames: ["a"], verdict: "accept", certSha256: "deadbeef" });
    expect(gateUseToOutcome(g, "a")?.certSha256).toBe("deadbeef");
  });

  it("omits certSha256 (no key at all) when absent", () => {
    const g = use({ skillNames: ["a"], verdict: "accept" });
    const outcome = gateUseToOutcome(g, "a")!;
    expect("certSha256" in outcome).toBe(false);
  });

  it("is unconditional: does not validate or clamp an out-of-range pCorrect", () => {
    const g = use({ skillNames: ["a"], verdict: "accept", pCorrect: 1.7 });
    expect(gateUseToOutcome(g, "a")).toEqual({ skillName: "a", predictedP: 1.7, success: true, at: 1_000 });
  });

  it("maps a use with multiple skillNames independently per skillName argument", () => {
    const g = use({ skillNames: ["a", "b", "c"], verdict: "reject", pCorrect: 0.4 });
    expect(gateUseToOutcome(g, "b")).toEqual({ skillName: "b", predictedP: 0.4, success: false, at: 1_000 });
  });
});

// ===========================================================================
// GateTrackRecorder.record — honesty: invalid-use / no-skills / invalid-p / abstain
// ===========================================================================

describe("GateTrackRecorder.record — honesty checks (no store append)", () => {
  it("skips with no-skills for an empty skillNames array, one row total", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec.record(use({ skillNames: [], verdict: "accept" }));
    expect(report.recorded).toEqual([]);
    expect(report.skipped).toEqual([{ skillName: "", reason: "no-skills", detail: expect.any(String) }]);
  });

  it("skips every named skill with abstain, one row per skill, visible and counted", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec.record(use({ skillNames: ["a", "b", "c"], verdict: "abstain" }));
    expect(report.recorded).toEqual([]);
    expect(report.skipped).toHaveLength(3);
    for (const row of report.skipped) {
      expect(row.reason).toBe("abstain");
      expect(["a", "b", "c"]).toContain(row.skillName);
    }
  });

  it.each([NaN, Infinity, -Infinity, -0.0001, 1.0001, 5])(
    "skips with invalid-p (never clamps) for pCorrect=%s, fanned out per skill",
    (p) => {
      const { fs } = makeSharedFs();
      const rec = new GateTrackRecorder({ store: makeStore(fs) });
      const report = rec.record(use({ skillNames: ["a", "b"], verdict: "accept", pCorrect: p }));
      expect(report.recorded).toEqual([]);
      expect(report.skipped).toHaveLength(2);
      for (const row of report.skipped) {
        expect(row.reason).toBe("invalid-p");
        expect(row.detail).toContain(String(p));
      }
    },
  );

  it("prefers abstain over invalid-p: a garbage pCorrect on an abstention is still honestly 'abstain'", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec.record(use({ skillNames: ["a"], verdict: "abstain", pCorrect: NaN }));
    expect(report.skipped).toEqual([{ skillName: "a", reason: "abstain", detail: expect.any(String) }]);
  });

  it.each([
    ["empty taskId", { taskId: "" }],
    ["whitespace-only taskId", { taskId: "   " }],
    ["bad verdict", { verdict: "revise" as unknown as GatedSkillUse["verdict"] }],
    ["non-finite at", { at: NaN }],
    ["skillNames with an empty string entry", { skillNames: ["a", ""] }],
    ["pCorrect wrong type", { pCorrect: "0.9" as unknown as number }],
  ])("skips with invalid-use for %s, a single row (not fanned out)", (_label, overrides) => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec.record(use({ skillNames: ["a", "b"], verdict: "accept", ...overrides }));
    expect(report.recorded).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe("invalid-use");
  });

  it("skillNames not an array at all is invalid-use, not a crash", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const bad = { ...use({ skillNames: ["a"], verdict: "accept" }), skillNames: "a" as unknown as string[] };
    const report = rec.record(bad);
    expect(report.skipped).toEqual([{ skillName: "", reason: "invalid-use", detail: expect.any(String) }]);
  });
});

// ===========================================================================
// GateTrackRecorder.record — verdict x cert x skillNames-count matrix (comprehensiveness a)
// ===========================================================================

describe("GateTrackRecorder.record — full verdict x cert x skillNames matrix", () => {
  const verdicts: Array<GatedSkillUse["verdict"]> = ["accept", "reject", "abstain"];
  const certVariants: Array<string | undefined> = [undefined, "cert-abc123"];
  const skillCounts = [0, 1, 3];

  for (const verdict of verdicts) {
    for (const cert of certVariants) {
      for (const count of skillCounts) {
        it(`verdict=${verdict} cert=${cert ?? "none"} skillNames.length=${count}`, () => {
          const { fs } = makeSharedFs();
          const rec = new GateTrackRecorder({ store: makeStore(fs) });
          const skillNames = Array.from({ length: count }, (_, i) => `skill-${i}`);
          const report = rec.record(
            use({
              skillNames,
              verdict,
              ...(cert !== undefined ? { certSha256: cert } : {}),
            }),
          );

          if (count === 0) {
            expect(report.skipped).toEqual([{ skillName: "", reason: "no-skills", detail: expect.any(String) }]);
            expect(report.recorded).toEqual([]);
            return;
          }

          expect(fanOut(report)).toBe(count);

          if (verdict === "abstain") {
            expect(report.recorded).toEqual([]);
            expect(report.skipped.every((s) => s.reason === "abstain")).toBe(true);
            return;
          }

          // accept / reject with a valid store: every row recorded.
          expect(report.skipped).toEqual([]);
          expect(report.recorded).toHaveLength(count);
          for (const row of report.recorded) {
            expect(skillNames).toContain(row.skillName);
            if (cert !== undefined) {
              expect(row.certSha256).toBe(cert);
            } else {
              expect(row.certSha256).toBeUndefined();
            }
          }
        });
      }
    }
  }
});

// ===========================================================================
// Idempotency — duplicate-cert across independent recorder/store instances
// ===========================================================================

describe("GateTrackRecorder — idempotency derives from the store, not memory", () => {
  it("a second recorder over the same persisted bytes skips a repeated cert as duplicate", () => {
    const { fs } = makeSharedFs();

    const rec1 = new GateTrackRecorder({ store: makeStore(fs) });
    const first = rec1.record(
      use({ skillNames: ["searcher"], verdict: "accept", certSha256: "cert-xyz", pCorrect: 0.9 }),
    );
    expect(first.recorded).toEqual([{ skillName: "searcher", certSha256: "cert-xyz" }]);

    // Brand-new recorder AND brand-new store instance, but same underlying fs bytes.
    const rec2 = new GateTrackRecorder({ store: makeStore(fs) });
    const second = rec2.record(
      use({ skillNames: ["searcher"], verdict: "accept", certSha256: "cert-xyz", pCorrect: 0.9, at: 2_000 }),
    );
    expect(second.recorded).toEqual([]);
    expect(second.skipped).toEqual([
      { skillName: "searcher", reason: "duplicate", detail: expect.stringContaining("cert-xyz") },
    ]);

    // And the chain still has exactly one entry — the duplicate truly never wrote.
    const finalStore = makeStore(fs);
    expect(finalStore.entries("searcher")).toHaveLength(1);
  });

  it("a reject verdict with the same cert as a prior accept is still caught as duplicate (cert identity, not verdict)", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    rec.record(use({ skillNames: ["s"], verdict: "accept", certSha256: "same-cert" }));
    const second = rec.record(use({ skillNames: ["s"], verdict: "reject", certSha256: "same-cert", at: 2_000 }));
    expect(second.skipped[0].reason).toBe("duplicate");
  });

  it("recordAll dedupes certless uses within a batch via (taskId, skillName, at)", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const a = use({ skillNames: ["s"], verdict: "accept", taskId: "t1", at: 500, pCorrect: 0.7 });
    const dup = use({ skillNames: ["s"], verdict: "accept", taskId: "t1", at: 500, pCorrect: 0.7 });
    const report = rec.recordAll([a, dup]);
    expect(report.recorded).toHaveLength(1);
    expect(report.skipped).toEqual([{ skillName: "s", reason: "duplicate", detail: expect.any(String) }]);
  });

  it("recordAll does NOT dedupe two certless uses that differ only in `at` (genuinely distinct outcomes)", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const a = use({ skillNames: ["s"], verdict: "accept", taskId: "t1", at: 500, pCorrect: 0.7 });
    const b = use({ skillNames: ["s"], verdict: "accept", taskId: "t1", at: 700, pCorrect: 0.7 });
    const report = rec.recordAll([a, b]);
    expect(report.recorded).toHaveLength(2);
    expect(report.skipped).toEqual([]);
  });

  it("plain record() calls (no shared batch) do not falsely dedupe two certless uses at different times", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const r1 = rec.record(use({ skillNames: ["s"], verdict: "accept", taskId: "t1", at: 500 }));
    const r2 = rec.record(use({ skillNames: ["s"], verdict: "reject", taskId: "t2", at: 900, pCorrect: 0.3 }));
    expect(r1.recorded).toHaveLength(1);
    expect(r2.recorded).toHaveLength(1);
  });
});

// ===========================================================================
// Tamper test — refuses to write onto a broken chain, bytes unchanged
// ===========================================================================

describe("GateTrackRecorder — refuses a corrupted store, never destroys it", () => {
  it("byte-tampering the persisted chain makes a fresh recorder skip store-integrity, and file bytes stay identical", () => {
    const { fs, files } = makeSharedFs();
    const path = "/virtual/skill-track.json";

    const rec1 = new GateTrackRecorder({ store: makeStore(fs) });
    rec1.record(use({ skillNames: ["planner"], verdict: "accept", certSha256: "c1", pCorrect: 0.9 }));

    const beforeTamper = files.get(path)!;
    // Flip `success` on the persisted entry without recomputing its hash —
    // a classic tamper: the JSON still parses, but the chain no longer verifies.
    const tampered = beforeTamper.replace('"success":true', '"success":false');
    expect(tampered).not.toBe(beforeTamper);
    files.set(path, tampered);
    const tamperedBytes = files.get(path)!;

    const rec2 = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec2.record(
      use({ skillNames: ["planner"], verdict: "accept", certSha256: "c2", pCorrect: 0.9, at: 3_000 }),
    );

    expect(report.recorded).toEqual([]);
    expect(report.skipped).toEqual([
      { skillName: "planner", reason: "store-integrity", detail: expect.any(String) },
    ]);

    // The store's own bytes must be byte-identical after the refused write —
    // the recorder must never have called persist().
    expect(files.get(path)).toBe(tamperedBytes);
  });

  it("an unreadable (non-JSON) envelope skips every skillName with store-integrity and never writes", () => {
    const { fs, files } = makeSharedFs();
    const path = "/virtual/skill-track.json";
    files.set(path, "{ this is not valid json ][");
    const garbageBytes = files.get(path)!;

    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const report = rec.record(use({ skillNames: ["a", "b"], verdict: "accept" }));

    expect(report.recorded).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    for (const row of report.skipped) {
      expect(row.reason).toBe("store-integrity");
    }
    expect(files.get(path)).toBe(garbageBytes);
  });

  it("a tampered chain for skill A does not block writes to a healthy skill B in the same store", () => {
    const { fs, files } = makeSharedFs();
    const path = "/virtual/skill-track.json";

    const rec1 = new GateTrackRecorder({ store: makeStore(fs) });
    rec1.record(use({ skillNames: ["broken-skill"], verdict: "accept", certSha256: "c1", pCorrect: 0.9 }));
    rec1.record(use({ skillNames: ["healthy-skill"], verdict: "accept", certSha256: "c2", pCorrect: 0.9, at: 1_500 }));

    const before = files.get(path)!;
    const tampered = before.replace('"skillName":"broken-skill","predictedP":0.9,"success":true', (m) =>
      m.replace("true", "false"),
    );
    expect(tampered).not.toBe(before);
    files.set(path, tampered);

    const rec2 = new GateTrackRecorder({ store: makeStore(fs) });
    const brokenReport = rec2.record(
      use({ skillNames: ["broken-skill"], verdict: "accept", certSha256: "c3", pCorrect: 0.9, at: 2_500 }),
    );
    expect(brokenReport.recorded).toEqual([]);
    expect(brokenReport.skipped[0].reason).toBe("store-integrity");

    const rec3 = new GateTrackRecorder({ store: makeStore(fs) });
    const healthyReport = rec3.record(
      use({ skillNames: ["healthy-skill"], verdict: "accept", certSha256: "c4", pCorrect: 0.85, at: 3_000 }),
    );
    expect(healthyReport.skipped).toEqual([]);
    expect(healthyReport.recorded).toEqual([{ skillName: "healthy-skill", certSha256: "c4" }]);
  });
});

// ===========================================================================
// TrackRecordValidationError from store.record — caught, never thrown out
// ===========================================================================

describe("GateTrackRecorder — TrackRecordValidationError from the store is caught, not thrown", () => {
  it("a non-monotonic `at` for a skill is surfaced as a skipped row, not an exception", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });

    const first = rec.record(use({ skillNames: ["s"], verdict: "accept", at: 1_000, pCorrect: 0.9 }));
    expect(first.recorded).toHaveLength(1);

    // `at` goes backwards relative to the skill's last recorded `at` — the
    // real store's own monotonicity rule, not something this module enforces
    // itself, so this exercises the actual TrackRecordValidationError path.
    let threw = false;
    let report: RecordReport;
    try {
      report = rec.record(use({ skillNames: ["s"], verdict: "reject", at: 500, pCorrect: 0.2 }));
    } catch {
      threw = true;
      report = { recorded: [], skipped: [] };
    }
    expect(threw).toBe(false);
    expect(report!.recorded).toEqual([]);
    expect(report!.skipped).toEqual([
      { skillName: "s", reason: "invalid-use", detail: expect.stringContaining("at") },
    ]);
  });
});

// ===========================================================================
// recordAll — mixed batch accounting invariant (comprehensiveness e)
// ===========================================================================

describe("GateTrackRecorder.recordAll — accounting invariant over a mixed batch", () => {
  it("recorded + skipped exactly totals the per-use skillName fan-out across a mixed batch", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });

    const uses: GatedSkillUse[] = [
      use({ skillNames: ["a", "b"], verdict: "accept", certSha256: "cert-1", taskId: "t1", at: 100, pCorrect: 0.9 }),
      use({ skillNames: [], verdict: "accept", taskId: "t2", at: 200 }), // no-skills: 1 row
      use({ skillNames: ["c"], verdict: "abstain", taskId: "t3", at: 300 }), // abstain: 1 row
      use({ skillNames: ["d", "e", "f"], verdict: "reject", taskId: "t4", at: 400, pCorrect: 0.1 }), // 3 rows
      use({ skillNames: ["g"], verdict: "accept", taskId: "t5", at: 500, pCorrect: 5 }), // invalid-p: 1 row
      // Same skill "a" + same cert as the very first use -> duplicate is
      // scoped per-skill (store.entries("a")), not global-per-cert.
      use({ skillNames: ["a"], verdict: "accept", certSha256: "cert-1", taskId: "t6", at: 600, pCorrect: 0.5 }),
    ];

    const report = rec.recordAll(uses);

    const expectedFanOut = 2 + 1 + 1 + 3 + 1 + 1; // = 9
    expect(fanOut(report)).toBe(expectedFanOut);

    // Spot-check the reasons landed where expected.
    const reasonFor = (skillName: string) => report.skipped.find((s) => s.skillName === skillName)?.reason;
    expect(reasonFor("c")).toBe("abstain");
    expect(reasonFor("g")).toBe("invalid-p");
    expect(reasonFor("a")).toBe("duplicate");
    expect(report.skipped.filter((s) => s.reason === "no-skills")).toHaveLength(1);
    expect(report.recorded.map((r) => r.skillName).sort()).toEqual(["a", "b", "d", "e", "f"]);
  });

  it("store.verifyChain().ok holds after every successful batch", () => {
    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const store = makeStore(fs);

    const uses: GatedSkillUse[] = [
      use({ skillNames: ["x", "y"], verdict: "accept", taskId: "t1", at: 100, pCorrect: 0.9, certSha256: "c1" }),
      use({ skillNames: ["y"], verdict: "reject", taskId: "t2", at: 200, pCorrect: 0.3, certSha256: "c2" }),
      use({ skillNames: ["x"], verdict: "accept", taskId: "t3", at: 300, pCorrect: 0.7, certSha256: "c3" }),
    ];
    rec.recordAll(uses);

    // Re-load an independent store view over the same bytes and verify.
    expect(store.load().ok).toBe(true);
    expect(store.verifyChain().ok).toBe(true);
    expect(store.verifyChain("x").ok).toBe(true);
    expect(store.verifyChain("y").ok).toBe(true);
  });
});

// ===========================================================================
// Real VerificationGate integration (REAL-VS-MOCK requirement)
// ===========================================================================

describe("GateTrackRecorder — integration with a real VerificationGate", () => {
  /** Deterministic judge: no network, no randomness, a fixed score per call index. */
  function makeDeterministicJudge(scores: number[]): Judge {
    let i = 0;
    return {
      async assess() {
        const score = scores[Math.min(i, scores.length - 1)];
        i++;
        return { score, rationale: `deterministic fixture score ${score}` };
      },
    };
  }

  function wellGroundedResult(taskId: string): WorkerResult {
    return {
      taskId,
      workerId: "w1",
      output: "The file has 42 lines.",
      claims: [
        { statement: "The file a.txt has 42 lines.", evidence: ["wc output: 42 a.txt"], confidence: 0.9 },
      ],
      toolTrace: [{ tool: "wc", args: { file: "a.txt" }, ok: true, output: "42 a.txt", at: 0 }],
      startedAt: 0,
      finishedAt: 1,
    };
  }

  function fabricatedResult(taskId: string): WorkerResult {
    return {
      taskId,
      workerId: "w1",
      output: "Revenue was $9.2M in Q3.",
      claims: [
        {
          statement: "Q3 revenue was $9.2M.",
          evidence: ["financial_report showed 9200000 for Q3 revenue"],
          confidence: 0.95,
        },
      ],
      toolTrace: [{ tool: "read_file", args: { file: "notes.txt" }, ok: true, output: "meeting notes about lunch", at: 0 }],
      startedAt: 0,
      finishedAt: 1,
    };
  }

  it("drives a real gate to accept + reject, records both, and wilsonLower/brier match real recomputation", async () => {
    const judge = makeDeterministicJudge([0.95, 0.1]);
    const gate = new VerificationGate({ judge });

    const acceptReport = await gate.verify(wellGroundedResult("gate-task-accept"));
    expect(acceptReport.verdict).toBe("accept");

    const rejectReport = await gate.verify(fabricatedResult("gate-task-reject"));
    expect(rejectReport.verdict).toBe("reject");

    // Map real gate verdicts -> GatedSkillUse, same shape an integrator's
    // run-loop boundary would build: gate's "accept"/"reject" pass straight
    // through (this module's contract has no "revise", which is the
    // integrator's mapping decision, not this test's concern).
    const skillName = "grounded-search";
    const acceptUse: GatedSkillUse = {
      skillNames: [skillName],
      verdict: acceptReport.verdict as "accept",
      pCorrect: acceptReport.score,
      taskId: acceptReport.taskId,
      at: acceptReport.at,
    };
    const rejectUse: GatedSkillUse = {
      skillNames: [skillName],
      verdict: rejectReport.verdict as "reject",
      pCorrect: rejectReport.score,
      taskId: rejectReport.taskId,
      at: Math.max(rejectReport.at, acceptReport.at), // preserve store's non-decreasing `at` rule
    };

    const { fs } = makeSharedFs();
    const store = makeStore(fs);
    const rec = new GateTrackRecorder({ store });

    const r1 = rec.record(acceptUse);
    expect(r1.recorded).toEqual([{ skillName }]);
    const r2 = rec.record(rejectUse);
    expect(r2.recorded).toEqual([{ skillName }]);

    const summary = store.summary(skillName)!;
    expect(summary.n).toBe(2);
    expect(summary.successRate).toBe(0.5);

    // Independent recomputation straight from the real ledger entries,
    // through the same exported pure math the store itself uses.
    const entries = store.entries(skillName);
    expect(entries).toHaveLength(2);
    expect(entries[0].predictedP).toBe(acceptReport.score);
    expect(entries[0].success).toBe(true);
    expect(entries[1].predictedP).toBe(rejectReport.score);
    expect(entries[1].success).toBe(false);

    const recomputedBrier = brierScore(entries);
    const successes = entries.filter((e) => e.success).length;
    const recomputedWilson = wilsonLowerBound(successes, entries.length);

    expect(summary.brier).toBe(recomputedBrier);
    expect(summary.recentBrier).toBe(recomputedBrier);
    expect(summary.wilsonLower).toBe(recomputedWilson);

    expect(store.verifyChain(skillName).ok).toBe(true);
  });

  it("a real gate 'reject' verdict (worker error) still produces a well-formed GatedSkillUse the recorder accepts", async () => {
    const gate = new VerificationGate();
    const erroredResult: WorkerResult = {
      taskId: "gate-task-errored",
      workerId: "w2",
      output: "",
      claims: [],
      toolTrace: [],
      startedAt: 0,
      finishedAt: 1,
      error: "worker crashed",
    };
    const report = await gate.verify(erroredResult);
    expect(report.verdict).toBe("reject");

    const { fs } = makeSharedFs();
    const rec = new GateTrackRecorder({ store: makeStore(fs) });
    const gatedUse: GatedSkillUse = {
      skillNames: ["fragile-skill"],
      verdict: "reject",
      pCorrect: report.score,
      taskId: report.taskId,
      at: report.at,
    };
    const result = rec.record(gatedUse);
    expect(result.recorded).toEqual([{ skillName: "fragile-skill" }]);
    expect(result.skipped).toEqual([]);
  });
});
