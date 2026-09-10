import { describe, expect, it } from "vitest";
import {
  StyxOrchestrator,
  type StyxTask,
  type Speculator,
  type Worker,
  type VerifierPanel,
  type StyxConfig,
} from "../styx/orchestrator";
import type { VerifierVote, TaskSignals } from "../styx/tiers";
import type { CalibrationPoint } from "../styx/gate";
import type { Perturbation } from "../styx/perturb";
import {
  CertificateAuthority,
  verifyCertificate,
  certifiesOutput,
} from "../styx/certificate";

/**
 * All components are SIMULATED and deterministic (no LLM, no keys, no clock, no
 * randomness). Worker outputs and panel votes are fixed lookup tables, so the
 * ensemble reliabilities, the bandit race, and the gate decision are all pure
 * functions of the config — every test is byte-reproducible.
 */

// A fixed 32-byte (64 hex char) ed25519 seed — deterministic signing key.
const SEED = "0f".repeat(32);
const CA = new CertificateAuthority(SEED);
const ISSUED_AT = 1_700_000_000_000;

/** Speculator that returns a fixed strategy list. */
class FixedSpeculator implements Speculator {
  constructor(private readonly strategies: string[]) {}
  propose(_task: StyxTask): string[] {
    return [...this.strategies];
  }
}

/**
 * Worker keyed by the strategy's BASE label (suffixes like "+refine"/"+alt"
 * from bandit expansion inherit the base output, mirroring the controller test
 * convention).
 */
class TableWorker implements Worker {
  constructor(
    private readonly outputs: Record<string, string>,
    private readonly cost = 1,
  ) {}
  run(_task: StyxTask, strategy: string): { output: string; cost: number } {
    const base = strategy.split("+")[0];
    const output = this.outputs[base] ?? `unknown:${base}`;
    return { output, cost: this.cost };
  }
}

/** Weak-verifier panel: a pass/fail pattern per output string. */
class PatternPanel implements VerifierPanel {
  constructor(
    private readonly ids: string[],
    private readonly patterns: Record<string, boolean[]>,
    private readonly fallback: boolean[],
  ) {}
  vote(_task: StyxTask, output: string): VerifierVote[] {
    const pat = this.patterns[output] ?? this.fallback;
    return this.ids.map((id, i) => ({ verifierId: id, passed: pat[i] ?? false }));
  }
}

function calib(n: number, score: number, correct: boolean): CalibrationPoint[] {
  return Array.from({ length: n }, () => ({ score, correct }));
}

// Calibration that fits a low-ish threshold (τ = 0.9 at ε = 0.1):
// 15 correct @0.9 → (0+1)/(15+1)=0.0625 ≤ 0.1; adding the 5 wrong @0.3 breaks it.
const EASY_CALIB: CalibrationPoint[] = [
  ...calib(15, 0.9, true),
  ...calib(5, 0.3, false),
];

const T0_SIGNALS: TaskSignals = { executable: true };
const T4_SIGNALS: TaskSignals = {}; // no signals → weakest tier

function baseConfig(over: Partial<StyxConfig> = {}): StyxConfig {
  return {
    epsilon: 0.1,
    budget: 50,
    ca: CA,
    calibration: EASY_CALIB,
    issuedAt: ISSUED_AT,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("StyxOrchestrator — end-to-end pipeline", () => {
  it("EASY task: emits a certified answer with high confidence, within budget", async () => {
    // best strategy "good" → output "G" the panel unanimously passes → fitness 1.
    const spec = new FixedSpeculator(["good", "bad1", "bad2"]);
    const worker = new TableWorker({ good: "G", bad1: "B1", bad2: "B2" });
    const panel = new PatternPanel(
      ["A", "B", "C"],
      { G: [true, true, true], B1: [false, false, false], B2: [false, false, false] },
      [false, false, false],
    );
    const orch = new StyxOrchestrator(spec, worker, panel, baseConfig());

    const out = await orch.run({ id: "t-easy", input: "q", signals: T0_SIGNALS });

    expect(out.emitted).toBe(true);
    expect(out.reason).toBe("emitted");
    expect(out.output).toBe("G");
    expect(out.tier).toBe("T0-execution");
    expect(out.confidenceFloor).toBeCloseTo(0.9, 10);
    expect(out.threshold).toBeCloseTo(0.9, 10);
    expect(out.pCorrect).toBeGreaterThan(0.8);
    expect(out.spent).toBeGreaterThan(0);
    expect(out.spent).toBeLessThanOrEqual(50);
    expect(out.certificate).toBeDefined();
    expect(await verifyCertificate(out.certificate!)).toBe(true);
    // certificate payload binds the pipeline evidence
    expect(out.certificate!.payload.taskId).toBe("t-easy");
    expect(out.certificate!.payload.verifierTier).toBe("T0-execution");
    expect(out.certificate!.payload.verifierVersions).toEqual(["A", "B", "C"]);
    expect(out.certificate!.payload.epsilon).toBe(0.1);
  });

  it("HARD task: panel rejects the best answer → abstains below the gate, no cert", async () => {
    const spec = new FixedSpeculator(["h0", "h1"]);
    const worker = new TableWorker({ h0: "H0", h1: "H1" });
    const panel = new PatternPanel(
      ["A", "B", "C"],
      { H0: [false, false, false], H1: [false, false, false] },
      [false, false, false],
    );
    const orch = new StyxOrchestrator(spec, worker, panel, baseConfig());

    const out = await orch.run({ id: "t-hard", input: "q", signals: T0_SIGNALS });

    expect(out.emitted).toBe(false);
    expect(out.reason).toBe("below-gate");
    expect(out.output).toBeUndefined();
    expect(out.certificate).toBeUndefined();
    expect(out.spent).toBeLessThanOrEqual(50);
  });

  it("T4 tier: a mediocre winner that clears the gate is still blocked by the tier floor", async () => {
    // 4 strategies engineered so the winner scores 0.75 (A,B reliable @0.75, C @0.5),
    // which clears the gate (τ=0.7) but sits below the T4 floor (0.998).
    const spec = new FixedSpeculator(["s0", "s1", "s2", "s3"]);
    const worker = new TableWorker({ s0: "O0", s1: "O1", s2: "O2", s3: "O3" });
    const panel = new PatternPanel(
      ["A", "B", "C"],
      {
        O0: [true, true, false], // winner: cons=pass, C dissents
        O1: [false, true, false], // cons=fail
        O2: [false, false, true], // cons=fail
        O3: [true, false, false], // cons=fail
      },
      [false, false, false],
    );
    const orch = new StyxOrchestrator(
      spec,
      worker,
      panel,
      baseConfig({ calibration: calib(20, 0.7, true) }),
    );

    const out = await orch.run({ id: "t-t4", input: "q", signals: T4_SIGNALS });

    expect(out.tier).toBe("T4-consistency");
    expect(out.confidenceFloor).toBeCloseTo(0.998, 10);
    expect(out.threshold).toBeCloseTo(0.7, 10);
    expect(out.emitted).toBe(false);
    expect(out.reason).toBe("below-tier-floor");
    expect(out.output).toBeUndefined();
    expect(out.certificate).toBeUndefined();
  });

  it("Perturbation gate: a winner that breaks under a semantics-preserving rewrite is rejected", async () => {
    // Gamed worker: returns the correct answer ONLY for the exact original input,
    // garbage otherwise — passes the panel on the canonical run but fails robustness.
    const ORIGINAL = "solve this";
    class GamedWorker implements Worker {
      run(task: StyxTask): { output: string; cost: number } {
        return { output: task.input === ORIGINAL ? "THE-ANSWER" : "GARBAGE", cost: 1 };
      }
    }
    const spec = new FixedSpeculator(["p0", "p1"]);
    const panel = new PatternPanel(
      ["A", "B", "C"],
      { "THE-ANSWER": [true, true, true] },
      [false, false, false], // GARBAGE → all fail
    );
    const appendPerturbation: Perturbation<StyxTask> = {
      name: "append-token",
      forward: (t) => ({ ...t, input: `${t.input} EXTRA` }),
      inverseAnswer: (a) => a,
    };
    const orch = new StyxOrchestrator(
      spec,
      new GamedWorker(),
      panel,
      baseConfig({ perturbations: [appendPerturbation] }),
    );

    const out = await orch.run({ id: "t-pert", input: ORIGINAL, signals: T0_SIGNALS });

    expect(out.emitted).toBe(false);
    expect(out.reason).toBe("failed-robustness");
    expect(out.output).toBeUndefined();
    expect(out.certificate).toBeUndefined();
  });

  it("certificate binds exactly the emitted output (true for it, false for anything else)", async () => {
    const spec = new FixedSpeculator(["good", "bad1"]);
    const worker = new TableWorker({ good: "G", bad1: "B1" });
    const panel = new PatternPanel(
      ["A", "B", "C"],
      { G: [true, true, true], B1: [false, false, false] },
      [false, false, false],
    );
    const orch = new StyxOrchestrator(spec, worker, panel, baseConfig());

    const out = await orch.run({ id: "t-bind", input: "q", signals: T0_SIGNALS });

    expect(out.emitted).toBe(true);
    expect(out.certificate).toBeDefined();
    expect(await certifiesOutput(out.certificate!, out.output!)).toBe(true);
    expect(await certifiesOutput(out.certificate!, "some other answer")).toBe(false);
  });

  it("is deterministic: two runs of the same task produce byte-identical outcomes", async () => {
    const mk = () =>
      new StyxOrchestrator(
        new FixedSpeculator(["good", "bad1", "bad2"]),
        new TableWorker({ good: "G", bad1: "B1", bad2: "B2" }),
        new PatternPanel(
          ["A", "B", "C"],
          { G: [true, true, true], B1: [false, false, false], B2: [false, false, false] },
          [false, false, false],
        ),
        baseConfig(),
      );
    const task: StyxTask = { id: "t-det", input: "q", signals: T0_SIGNALS };

    const a = await mk().run(task);
    const b = await mk().run(task);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never throws: a throwing worker degrades to an abstention with reason 'error:...'", async () => {
    class ThrowingWorker implements Worker {
      run(): { output: string; cost: number } {
        throw new Error("boom");
      }
    }
    const orch = new StyxOrchestrator(
      new FixedSpeculator(["x"]),
      new ThrowingWorker(),
      new PatternPanel(["A"], {}, [true]),
      baseConfig(),
    );

    const out = await orch.run({ id: "t-throw", input: "q", signals: T0_SIGNALS });
    expect(out.emitted).toBe(false);
    expect(out.reason.startsWith("error:")).toBe(true);
    expect(out.reason).toContain("boom");
    expect(out.output).toBeUndefined();
    expect(out.certificate).toBeUndefined();
    // tier routing still reported on the error path
    expect(out.tier).toBe("T0-execution");
  });

  it("spent never exceeds the budget even with a tiny budget", async () => {
    const spec = new FixedSpeculator(["good", "bad1", "bad2"]);
    const worker = new TableWorker({ good: "G", bad1: "B1", bad2: "B2" }, 1);
    const panel = new PatternPanel(
      ["A", "B", "C"],
      { G: [true, true, true], B1: [false, false, false], B2: [false, false, false] },
      [false, false, false],
    );
    const orch = new StyxOrchestrator(spec, worker, panel, baseConfig({ budget: 2 }));

    const out = await orch.run({ id: "t-budget", input: "q", signals: T0_SIGNALS });
    expect(out.spent).toBeLessThanOrEqual(2);
  });

  it("S1 guarantee preserved end-to-end: the EMITTED set contains zero wrong answers (≤ ε)", async () => {
    // 5 genuinely-correct tasks (panel passes) and 5 wrong ones (panel fails).
    // Ground truth: correct iff input starts with "good". The composition must
    // never emit a wrong answer → observed wrong-rate 0 ≤ ε.
    class EchoWorker implements Worker {
      run(task: StyxTask): { output: string; cost: number } {
        return { output: task.input, cost: 1 };
      }
    }
    class TruthPanel implements VerifierPanel {
      vote(_task: StyxTask, output: string): VerifierVote[] {
        const pass = output.startsWith("good");
        return ["A", "B", "C"].map((id) => ({ verifierId: id, passed: pass }));
      }
    }
    const orch = new StyxOrchestrator(
      new FixedSpeculator(["direct"]),
      new EchoWorker(),
      new TruthPanel(),
      baseConfig(),
    );

    const tasks: StyxTask[] = [];
    for (let i = 0; i < 5; i++) tasks.push({ id: `good-${i}`, input: `good-${i}`, signals: T0_SIGNALS });
    for (let i = 0; i < 5; i++) tasks.push({ id: `bad-${i}`, input: `bad-${i}`, signals: T0_SIGNALS });

    let emitted = 0;
    let emittedWrong = 0;
    for (const t of tasks) {
      const out = await orch.run(t);
      if (out.emitted) {
        emitted += 1;
        if (!t.input.startsWith("good")) emittedWrong += 1;
      }
    }

    expect(emitted).toBe(5); // exactly the 5 correct tasks cleared the pipeline
    expect(emittedWrong).toBe(0); // wrong-rate 0 ≤ ε = 0.1
  });
});
