/* ------------------------------------------------------------------ *
 * gate-journal.test.ts — the CAPTURE half of the closed learning loop.
 *
 * Covers three things the forge downstream depends on and cannot check for
 * itself:
 *
 *  1. The journal REUSES `TrajectoryRecorder` — trajectories it emits are
 *     the same objects the recorder builds, so there is one trajectory
 *     format in this codebase, not two.
 *  2. Attaching a gate verdict does NOT disturb the trajectory bytes a
 *     certificate is issued over. This is the trap the module header calls
 *     out: had the attestation been stored as a field ON the trajectory,
 *     every forge attempt would fail `hash-mismatch` forever. The test here
 *     issues a real certificate over a journaled trajectory and proves it
 *     still binds.
 *  3. `outcome` is derived and tamper-evident. A journal file is editable
 *     by anything that can write a file; hand-editing `"verified"` onto a
 *     rejected run must be caught at load, not laundered into a skill.
 *
 * REAL-VS-MOCK POLICY: real ed25519 / sha256 crypto, an in-memory `JournalFs`
 * double for persistence, a counter clock. No network, no real filesystem,
 * no API key.
 * ------------------------------------------------------------------ */
import { describe, expect, it } from "vitest";

import {
  GateJournal,
  JOURNAL_PATH_ENV,
  appendJournal,
  attestGateVerdict,
  classifyGateVerdict,
  gateReportToVerdict,
  isKnownGateVerdict,
  loadJournal,
  resolveJournalPath,
  saveJournal,
  tallyJournal,
  validateJournaledRun,
  type JournalFs,
  type JournaledRun,
} from "../research/gate-journal";
import { TrajectoryRecorder } from "../research/recorder";
import {
  CertificateAuthority,
  generatePrivateKeyHex,
  sha256Hex,
  verifyCertificate,
} from "../styx/certificate";
import { canonicalTrajectoryJson, verifyTrajectoryForSynthesis } from "../skills/synthesize";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

class MemFs implements JournalFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readFile(p: string): string | null {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  writeFile(p: string, c: string): void {
    this.files.set(p, c);
  }
  mkdirp(d: string): void {
    this.dirs.add(d);
  }
}

function clock(start = 1_000) {
  let t = start;
  return () => ++t;
}

const ca = new CertificateAuthority(generatePrivateKeyHex((n: number) => new Uint8Array(n).fill(23)));

/** Drive one complete run through the journal, ending on the given verdict. */
function runOnce(journal: GateJournal, goalId: string, verdict: "accept" | "revise" | "reject") {
  journal.beginGoal(goalId, `objective for ${goalId}`, "test-model");
  journal.beginTask(goalId, "t1", "gather evidence", "research");
  journal.recordTool(goalId, "t1", { tool: "read_file", ok: true, summary: "Read the spec." });
  journal.recordTool(goalId, "t1", { tool: "write_file", ok: true, summary: "Wrote the answer." });
  journal.endTask(goalId, "t1", true);
  return journal.completeGoal(goalId, {
    verdict,
    score: 0.9,
    reasons: ["deterministic grounding checks"],
    taskId: "t1",
    at: 5_000,
  });
}

// ===========================================================================
// Verdict classification
// ===========================================================================

describe("classifyGateVerdict", () => {
  it("maps the three gate verdicts onto the journal's vocabulary", () => {
    expect(classifyGateVerdict("accept")).toBe("verified");
    expect(classifyGateVerdict("revise")).toBe("declined");
    expect(classifyGateVerdict("reject")).toBe("refuted");
  });

  it("fails toward refusing to learn on an unrecognized verdict", () => {
    // A future gate that grows a fourth verdict must not be silently treated
    // as a skill source.
    expect(classifyGateVerdict("escalate")).toBe("refuted");
    expect(classifyGateVerdict("")).toBe("refuted");
    expect(isKnownGateVerdict("escalate")).toBe(false);
  });
});

describe("attestGateVerdict", () => {
  it("derives `outcome` rather than accepting one", () => {
    const a = attestGateVerdict({ verdict: "reject", score: 0.1, reasons: ["refuted by reference"], at: 7 });
    expect(a.outcome).toBe("refuted");
    expect(a.gateVerdict).toBe("reject");
  });

  it("never persists an empty reasons list — an unexplained verdict is not auditable", () => {
    const a = attestGateVerdict({ verdict: "accept", score: 1, reasons: ["", "   "], at: 7 });
    expect(a.reasons).toHaveLength(1);
    expect(a.reasons[0]).toContain('verdict "accept"');
  });
});

describe("gateReportToVerdict", () => {
  it("carries a real gate report's checks and feedback into the journal's reasons", () => {
    const input = gateReportToVerdict({
      verdict: "accept",
      score: 0.88,
      checks: [
        { name: "citation-grounding", passed: true, detail: "3/3 claims cited" },
        { name: "contradiction", passed: false, detail: "1 soft contradiction" },
      ],
      feedback: "All grounding checks passed.",
      taskId: "t1",
      at: 42,
    });

    expect(input.verdict).toBe("accept");
    expect(input.score).toBe(0.88);
    expect(input.reasons).toEqual([
      "pass citation-grounding: 3/3 claims cited",
      "FAIL contradiction: 1 soft contradiction",
      "All grounding checks passed.",
    ]);
    expect(input.taskId).toBe("t1");
    expect(input.at).toBe(42);
  });

  it("downgrades an unrecognized verdict to reject and says so, rather than silently", () => {
    const input = gateReportToVerdict({ verdict: "escalate", score: 0.5 });
    expect(input.verdict).toBe("reject");
    expect(input.reasons[0]).toContain('unrecognized verdict "escalate"');
    expect(input.reasons[0]).toContain("never evidence that a run was certified");
    expect(classifyGateVerdict(input.verdict)).toBe("refuted");
  });
});

// ===========================================================================
// GateJournal — capture
// ===========================================================================

describe("GateJournal", () => {
  it("delegates recording to the injected TrajectoryRecorder (one trajectory format, not two)", () => {
    const recorder = new TrajectoryRecorder(clock());
    const journal = new GateJournal(recorder, clock());
    const run = runOnce(journal, "g1", "accept");

    expect(run).toBeDefined();
    expect(run?.trajectory.objective).toBe("objective for g1");
    expect(run?.trajectory.tasks[0].tools.map((t) => t.tool)).toEqual(["read_file", "write_file"]);
    // The trajectory came out of the recorder's own completed set.
    expect(recorder.size()).toBe(1);
    expect(recorder.all()[0]).toBe(run?.trajectory);
  });

  it("derives trajectory.success from the gate verdict, not from the executor's opinion", () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    expect(runOnce(journal, "ok", "accept")?.trajectory.success).toBe(true);
    expect(runOnce(journal, "meh", "revise")?.trajectory.success).toBe(false);
    expect(runOnce(journal, "bad", "reject")?.trajectory.success).toBe(false);
  });

  it("journals nothing for an unknown goal instead of throwing inside run completion", () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = journal.completeGoal("never-began", { verdict: "accept", score: 1, reasons: ["x"], at: 1 });
    expect(run).toBeUndefined();
    expect(journal.size()).toBe(0);
  });

  it("tallies by outcome and exposes only verified runs to the forge", () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    runOnce(journal, "a", "accept");
    runOnce(journal, "b", "revise");
    runOnce(journal, "c", "reject");
    runOnce(journal, "d", "accept");

    expect(journal.tally()).toEqual({ total: 4, verified: 2, declined: 1, refuted: 1, invalid: 0 });
    expect(journal.verified().map((r) => r.trajectory.goalId)).toEqual(["a", "d"]);
  });
});

// ===========================================================================
// The hashing trap — attaching a verdict must not disturb the signed bytes
// ===========================================================================

describe("GateJournal + certificate binding", () => {
  it("keeps trajectory bytes certifiable after the verdict is attached", async () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = runOnce(journal, "g1", "accept") as JournaledRun;

    // Issue a REAL certificate over the finalized trajectory, exactly as a
    // deployment would after the gate decided.
    const certificate = await ca.issue({
      outputSha256: sha256Hex("answer"),
      taskId: "t1",
      verifierTier: "T1-reference",
      ensembleScore: 0.97,
      pCorrect: 0.99,
      epsilon: 0.02,
      traceSha256: sha256Hex(canonicalTrajectoryJson(run.trajectory)),
      verifierVersions: ["verify.reference-recompute@1.0.0"],
      issuedAt: 9_000,
    });

    expect(journal.attachCertificate("g1", certificate)).toEqual({ ok: true });

    // The whole point: after journaling AND attaching, synthesis's own
    // independent recomputation still matches. If the attestation had been
    // stored as a field on the trajectory, this would be `hash-mismatch`.
    const stored = journal.entries()[0];
    expect(await verifyCertificate(certificate)).toBe(true);
    const verdict = await verifyTrajectoryForSynthesis({
      trajectory: stored.trajectory,
      certificate: stored.gate.certificate!,
    });
    expect(verdict.ok).toBe(true);
  });

  it("refuses a certificate that does not bind these exact trajectory bytes", async () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    runOnce(journal, "g1", "accept");
    runOnce(journal, "g2", "accept");

    const forOther = await ca.issue({
      outputSha256: sha256Hex("answer"),
      taskId: "t1",
      verifierTier: "T1-reference",
      ensembleScore: 0.97,
      pCorrect: 0.99,
      epsilon: 0.02,
      traceSha256: sha256Hex(canonicalTrajectoryJson(journal.entries()[1].trajectory)),
      verifierVersions: ["verify.reference-recompute@1.0.0"],
      issuedAt: 9_000,
    });

    const result = journal.attachCertificate("g1", forOther);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not bind this trajectory");
    expect(journal.entries()[0].gate.certificate).toBeUndefined();
  });

  it("REFUSES to attach a certificate to a refuted run — the shape a later edit would launder", async () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = runOnce(journal, "bad", "reject") as JournaledRun;
    const certificate = await ca.issue({
      outputSha256: sha256Hex("answer"),
      taskId: "t1",
      verifierTier: "T1-reference",
      ensembleScore: 0.97,
      pCorrect: 0.99,
      epsilon: 0.02,
      traceSha256: sha256Hex(canonicalTrajectoryJson(run.trajectory)),
      verifierVersions: ["verify.reference-recompute@1.0.0"],
      issuedAt: 9_000,
    });

    // This used to be allowed on the reasoning that it "changes nothing about
    // whether that run can become a skill" — true of the entry as written, and
    // false of the entry as EDITED. `outcome` and `gateVerdict` are two plain
    // strings in a plaintext file; flip both and a refuted run holding a valid
    // certificate becomes a verified run holding a valid certificate, and
    // nothing downstream can tell the difference because the signature really
    // does verify and really does bind these exact trajectory bytes. Since the
    // gate issues a certificate only on ACCEPT, refusing here removes the only
    // material that edit needs and costs no real capability.
    const result = journal.attachCertificate("bad", certificate);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('gate outcome "refuted"');
    expect(journal.entries()[0].gate.outcome).toBe("refuted");
    expect(journal.entries()[0].gate.certificate).toBeUndefined();
    expect(journal.verified()).toEqual([]);
  });

  it("REFUSES a capture() that pairs a certificate with a non-verified verdict", async () => {
    // `capture()` is the API a run-loop integration reaches for, and unlike
    // `completeGoal` it takes the trajectory AND the verdict from the caller —
    // so it is the other door onto the same shape.
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const seed = runOnce(journal, "seed", "accept") as JournaledRun;
    const certificate = await ca.issue({
      outputSha256: sha256Hex("answer"),
      taskId: "t1",
      verifierTier: "T1-reference",
      ensembleScore: 0.97,
      pCorrect: 0.99,
      epsilon: 0.02,
      traceSha256: sha256Hex(canonicalTrajectoryJson(seed.trajectory)),
      verifierVersions: ["verify.reference-recompute@1.0.0"],
      issuedAt: 9_000,
    });

    const before = journal.entries().length;
    const refused = journal.capture(seed.trajectory, {
      verdict: "reject",
      score: 0.1,
      reasons: ["grounding failed"],
      certificate,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("issued only on ACCEPT");
    // Journals NOTHING — a refused capture must not leave a partial entry.
    expect(journal.entries()).toHaveLength(before);

    // The same capture WITHOUT a certificate is perfectly legal: a refuted run
    // is real evidence and belongs in the journal. It just cannot be forged
    // from, which `forgeFromVerified` enforces on the verdict.
    const kept = journal.capture(seed.trajectory, {
      verdict: "reject",
      score: 0.1,
      reasons: ["grounding failed"],
    });
    expect(kept.ok).toBe(true);
    expect(journal.entries()).toHaveLength(before + 1);
    expect(journal.verified()).toHaveLength(1);
  });
});

// ===========================================================================
// Validation — a journal file is untrusted input
// ===========================================================================

describe("validateJournaledRun", () => {
  it("refuses an entry whose stored outcome disagrees with its raw verdict", () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = runOnce(journal, "g1", "reject") as JournaledRun;

    // Exactly the edit an attacker (or a careless script) would make.
    const tampered = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
    (tampered.gate as Record<string, unknown>).outcome = "verified";

    const result = validateJournaledRun(tampered, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.code).toBe("verdict-mismatch");
      expect(result.problem.index).toBe(3);
      expect(result.problem.detail).toContain("derived field");
      expect(result.problem.detail).toContain("refused rather than repaired");
    }
  });

  it("accepts a well-formed entry and normalizes nothing away", () => {
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = runOnce(journal, "g1", "accept") as JournaledRun;
    const result = validateJournaledRun(JSON.parse(JSON.stringify(run)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run.gate.outcome).toBe("verified");
      expect(result.run.gate.reasons).toEqual(["deterministic grounding checks"]);
      expect(result.run.trajectory.tasks[0].tools).toHaveLength(2);
    }
  });

  it("names the specific structural problem rather than a generic failure", () => {
    const cases: Array<[unknown, string]> = [
      [42, "not-an-object"],
      [{ gate: {} }, "bad-trajectory"],
      [{ trajectory: { goalId: "g", objective: "o", success: true, startedAt: 1, tasks: [] } }, "bad-attestation"],
    ];
    for (const [value, code] of cases) {
      const result = validateJournaledRun(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.code).toBe(code);
    }
  });
});

// ===========================================================================
// Persistence
// ===========================================================================

describe("journal persistence", () => {
  it("round-trips through save/load", () => {
    const fs = new MemFs();
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    runOnce(journal, "a", "accept");
    runOnce(journal, "b", "reject");

    saveJournal("/data/journal.json", journal.entries(), fs);
    const loaded = loadJournal("/data/journal.json", fs);

    expect(loaded.exists).toBe(true);
    expect(loaded.problems).toEqual([]);
    expect(loaded.runs.map((r) => `${r.trajectory.goalId}:${r.gate.outcome}`)).toEqual(["a:verified", "b:refuted"]);
  });

  it("reports a missing file as absent, not as an error", () => {
    const loaded = loadJournal("/nope.json", new MemFs());
    expect(loaded).toEqual({ exists: false, runs: [], problems: [] });
  });

  it("reports malformed JSON without throwing and without inventing entries", () => {
    const fs = new MemFs();
    fs.writeFile("/j.json", "{not json");
    const loaded = loadJournal("/j.json", fs);
    expect(loaded.exists).toBe(true);
    expect(loaded.runs).toEqual([]);
    expect(loaded.error).toContain("malformed JSON");
  });

  it("keeps the good entries in a partly-bad file but always surfaces the bad ones", () => {
    const fs = new MemFs();
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const good = runOnce(journal, "good", "accept") as JournaledRun;
    fs.writeFile("/j.json", JSON.stringify([good, { nonsense: true }]));

    const loaded = loadJournal("/j.json", fs);
    expect(loaded.runs.map((r) => r.trajectory.goalId)).toEqual(["good"]);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0].index).toBe(1);
    expect(tallyJournal(loaded.runs, loaded.problems.length)).toEqual({
      total: 1,
      verified: 1,
      declined: 0,
      refuted: 0,
      invalid: 1,
    });
  });

  it("appends without destroying what is already there", () => {
    const fs = new MemFs();
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const first = runOnce(journal, "a", "accept") as JournaledRun;
    const second = runOnce(journal, "b", "revise") as JournaledRun;

    expect(appendJournal("/j.json", [first], fs)).toEqual({ appended: 1, total: 1 });
    expect(appendJournal("/j.json", [second], fs)).toEqual({ appended: 1, total: 2 });
    expect(loadJournal("/j.json", fs).runs.map((r) => r.trajectory.goalId)).toEqual(["a", "b"]);
  });

  it("refuses to append over an unparseable journal rather than overwriting it", () => {
    const fs = new MemFs();
    fs.writeFile("/j.json", "corrupt");
    const journal = new GateJournal(new TrajectoryRecorder(clock()), clock());
    const run = runOnce(journal, "a", "accept") as JournaledRun;

    const result = appendJournal("/j.json", [run], fs);
    expect(result.appended).toBe(0);
    expect(result.reason).toContain("refusing to append");
    // The original bytes survive — the evidence of the break is not destroyed.
    expect(fs.readFile("/j.json")).toBe("corrupt");
  });
});

// ===========================================================================
// Capture is opt-in
// ===========================================================================

describe("resolveJournalPath", () => {
  it("is off by default and names the VARIABLE, not a value, as the unmet requirement", () => {
    const resolved = resolveJournalPath({});
    expect(resolved.enabled).toBe(false);
    expect(resolved.path).toBeUndefined();
    expect(resolved.unmetRequirement).toContain(`$${JOURNAL_PATH_ENV}`);
    expect(resolved.unmetRequirement).toContain("opt-in");
  });

  it("treats a blank value as unset rather than as a path", () => {
    expect(resolveJournalPath({ [JOURNAL_PATH_ENV]: "   " }).enabled).toBe(false);
  });

  it("enables capture when the variable names a path", () => {
    const resolved = resolveJournalPath({ [JOURNAL_PATH_ENV]: " /var/hades/journal.json " });
    expect(resolved.enabled).toBe(true);
    expect(resolved.path).toBe("/var/hades/journal.json");
    expect(resolved.unmetRequirement).toBeUndefined();
  });
});
