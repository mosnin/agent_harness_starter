import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scriptedSessions,
  runConvergenceBench,
  USER_MODEL_FILENAME,
  type ConvergenceReport,
} from "../user-model-bench";
import { UserModelStore } from "../user-model-store";
import { auditUserModel } from "../user-model-verifier";

// ===========================================================================
// Scratch dir plumbing
// ===========================================================================

const dirs: string[] = [];
function scratchDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "user-model-bench-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function beliefOf(report: ConvergenceReport, attribute: string) {
  return report.beliefs.find((b) => b.attribute === attribute);
}

// ===========================================================================
// scriptedSessions — the fixture itself
// ===========================================================================

describe("scriptedSessions", () => {
  it("returns at least 8 sessions spanning at least 60 simulated days", () => {
    const sessions = scriptedSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(8);
    const first = Math.min(...sessions.map((s) => s.startedAt));
    const last = Math.max(...sessions.map((s) => s.endedAt ?? s.startedAt));
    expect((last - first) / (24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(60);
  });

  it("is a pure, deterministic function — two calls produce identical output", () => {
    const a = scriptedSessions();
    const b = scriptedSessions();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("includes at least one assistant-only session with zero user messages", () => {
    const sessions = scriptedSessions();
    const assistantOnly = sessions.filter((s) => s.messages.length > 0 && s.messages.every((m) => m.role === "assistant"));
    expect(assistantOnly.length).toBeGreaterThanOrEqual(1);
  });

  it("includes an injection-attempt session with fenced false claims", () => {
    const sessions = scriptedSessions();
    const injection = sessions.find((s) => s.messages.some((m) => m.content.includes("```") && m.content.includes("SYSTEM OVERRIDE")));
    expect(injection).toBeDefined();
  });
});

// ===========================================================================
// runConvergenceBench — the real end-to-end pipeline
// ===========================================================================

describe("runConvergenceBench", () => {
  it("converges to the scripted ground truth through the real pipeline", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    expect(report.sessionsRun).toBe(scriptedSessions().length);
    expect(report.assertionsExtracted).toBeGreaterThan(0);
    expect(report.converged).toBe(true);
    expect(typeof report.durationMs).toBe("number");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures the genuine correction arc: identity.location revised to lisbon with berlin superseded", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    const location = beliefOf(report, "identity.location");
    expect(location).toBeDefined();
    expect(location!.value).toBe("lisbon");
    expect(location!.status).toBe("asserted");
    expect(location!.revisions).toBeGreaterThanOrEqual(1);

    // supersededValues isn't on the locked ConvergenceReport.beliefs shape,
    // so confirm it directly against the real, reloaded model.
    const store = new UserModelStore({ path: path.join(workDir, USER_MODEL_FILENAME) });
    const modelLocation = store.model.get("identity.location");
    expect(modelLocation?.supersededValues).toContain("berlin");
  });

  it("keeps the noisy one-off contradiction from displacing the established stack.primary belief", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    const stack = beliefOf(report, "stack.primary");
    expect(stack).toBeDefined();
    expect(stack!.value).toBe("typescript");
    expect(stack!.status).toBe("asserted");
  });

  it("counts zero assertions contributed by the injection-attempt session", async () => {
    const workDir = scratchDir();
    // Re-derive independently: run extraction on just the injection session
    // and confirm it alone contributes nothing, corroborating the report's
    // own (already-measured) assertionsExtracted total.
    const { extractBeliefAssertions } = await import("../belief-extraction");
    const injectionSession = scriptedSessions().find((s) => s.messages.some((m) => m.content.includes("SYSTEM OVERRIDE")))!;
    const assertions = await extractBeliefAssertions(injectionSession);
    expect(assertions).toHaveLength(0);

    const report = await runConvergenceBench({ workDir });
    expect(report.converged).toBe(true);
  });

  it("demonstrates the certified fact's confidence exceeds the T4 cap while every uncertified belief stays at or under it", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    const T4_CAP = 0.6;
    const certified = beliefOf(report, "project.current");
    expect(certified).toBeDefined();
    expect(certified!.confidence).toBeGreaterThan(T4_CAP);

    for (const b of report.beliefs) {
      if (b.attribute === "project.current") continue;
      expect(b.confidence).toBeLessThanOrEqual(T4_CAP + 1e-9);
    }
  });

  it("passes its own independent audit with zero findings", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    expect(report.audit.verifierId).toBe("verify.user-model");
    expect(report.audit.passed).toBe(true);
    expect(report.audit.findings).toEqual([]);
    expect(report.audit.beliefsAudited).toBe(report.beliefs.length);
  });

  it("records exactly one quarantine, matching the single scripted noisy contradiction", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });
    expect(report.quarantines).toBe(1);
  });

  it("actually reloads the store from disk between sessions: loadIssues is empty and beliefs survived", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });

    const store = new UserModelStore({ path: path.join(workDir, USER_MODEL_FILENAME) });
    expect(store.loadIssues()).toEqual([]);
    expect(store.model.all().length).toBe(report.beliefs.length);
    for (const expected of report.beliefs) {
      const reloaded = store.model.get(expected.attribute);
      expect(reloaded).toBeDefined();
      expect(reloaded!.value).toBe(expected.value);
    }
  });

  it("throws a TypeError when workDir is missing or empty", async () => {
    await expect(runConvergenceBench({ workDir: "" })).rejects.toThrow(TypeError);
    await expect(runConvergenceBench({} as unknown as { workDir: string })).rejects.toThrow(TypeError);
  });

  it("is deterministic: two runs with the same clock produce identical reports modulo durationMs", async () => {
    const workDirA = scratchDir();
    const workDirB = scratchDir();

    const reportA = await runConvergenceBench({ workDir: workDirA });
    const reportB = await runConvergenceBench({ workDir: workDirB });

    const strip = (r: ConvergenceReport) => {
      const { durationMs: _durationMs, ...rest } = r;
      return rest;
    };
    expect(strip(reportA)).toEqual(strip(reportB));
  });

  it("measures real wall-clock duration — reruns take non-negative, non-fabricated time", async () => {
    const workDir = scratchDir();
    const report = await runConvergenceBench({ workDir });
    // A real performance.now() delta for genuine work (crypto signing +
    // repeated disk I/O + regex extraction across 9 sessions) is not
    // instantaneous, but the only hard invariant we assert is that it is a
    // real, non-negative, finite measurement — never a hardcoded constant.
    expect(Number.isFinite(report.durationMs)).toBe(true);
    expect(report.durationMs).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Perturbation test — the invariant is enforced, not assumed
// ===========================================================================

describe("runConvergenceBench — perturbation", () => {
  it("audit FAILS after an evidence weight is mutated upward on disk between sessions", async () => {
    const workDir = scratchDir();
    const firstReport = await runConvergenceBench({ workDir });
    expect(firstReport.audit.passed).toBe(true);

    const modelPath = path.join(workDir, USER_MODEL_FILENAME);
    const raw = JSON.parse(fs.readFileSync(modelPath, "utf8")) as {
      snapshot: { beliefs: Array<{ attribute: string; evidence: Array<{ weight: number }> }> };
    };
    const target = raw.snapshot.beliefs.find((b) => b.attribute === "identity.name");
    expect(target).toBeDefined();
    expect(target!.evidence.length).toBeGreaterThan(0);
    // Mutate ONE evidence weight upward — DialecticUserModel.fromJSON will
    // honestly re-derive `confidence` from this (now-tampered) weight on
    // load, which is exactly why this does NOT surface as
    // confidence-exceeds-evidence; it is the ledger cross-check (see
    // ./user-model-verifier.ts) that catches the on-disk tamper the model's
    // own self-healing recompute cannot.
    target!.evidence[0].weight = Math.min(1, target!.evidence[0].weight + 0.4);
    fs.writeFileSync(modelPath, JSON.stringify(raw), "utf8");

    const store = new UserModelStore({ path: modelPath });
    expect(store.loadIssues()).toEqual([]); // the file still parses/validates fine — the tamper is silent, not corrupt
    const audit = await auditUserModel(store.model, { ledger: store.ledger });

    expect(audit.passed).toBe(false);
    expect(audit.findings.some((f) => f.kind === "ledger-mismatch")).toBe(true);
  });
});
