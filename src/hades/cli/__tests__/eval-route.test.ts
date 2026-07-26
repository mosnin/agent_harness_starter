/**
 * `hades eval` router integration — the central wiring that makes this
 * cycle's continuous-eval stack (measure -> record -> compare -> gate ->
 * bisect) actually REACHABLE from the terminal.
 *
 * These drive the real `HadesCli` and the real `defaultEvalCliDeps` against
 * real temp directories: no mocked ledger, no mocked fs, no stubbed engine.
 * What they protect is exactly what "central integration" means here — the
 * subcommand is routed and listed, the deps factory is lazy (a `help` must
 * never take the ledger's cross-process lock), the ledger is opened ONCE per
 * process and shared across subcommands, the eval root is the shared
 * `<dataDir>/eval`, and the CI-contract exit codes survive the router.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HadesCli, HADES_SUBCOMMANDS } from "../cli";
import { defaultEvalCliDeps } from "../eval-deps";
import type { EvalCliDeps } from "../eval-command";
import { EvalHistoryLedger } from "../../eval/history";
import { runEvalMeasurement, defaultMeasureRunner, scriptedEvalRunner } from "../../eval/measure";
import { EVAL_TASKS } from "../../bench/eval-suite";
import { scriptedSolvers } from "../../trust/risk-eval";
import type { ScorecardRevision, EvalScorecard } from "../../eval/scorecard";
import type { TrustStack } from "../../trust/wiring";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-eval-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function revision(n: number): ScorecardRevision {
  return {
    sha: String(n).padStart(40, "a"),
    shortSha: String(n).padStart(12, "a"),
    branch: "main",
    dirty: false,
    committedAtMs: 1_700_000_000_000 + n,
    workTreeHash: `worktree-${n}`,
    source: "content",
  };
}

/** A REAL measurement over the REAL EVAL_TASKS driven by a real deterministic
 *  scripted solver. `admit` is a real always-abstain port so the risk lane is
 *  genuinely measured (finite fields) — the same discipline the engine's own
 *  tests use when a scorecard has to be persisted and re-read. */
async function measure(n: number, solverLabel: "faithful" | "fabricating"): Promise<EvalScorecard> {
  const solver = scriptedSolvers().find((s) => s.label === solverLabel);
  if (solver === undefined) throw new Error(`no scripted solver labelled ${solverLabel}`);
  return runEvalMeasurement({
    revision: revision(n),
    tasks: EVAL_TASKS,
    runner: scriptedEvalRunner(solver),
    runnerLabel: `scripted:${solver.id}`,
    mode: "scripted",
    admit: async (subject) => ({
      accepted: false,
      domain: subject.domain,
      taskId: subject.taskId,
      score: 0,
      threshold: Number.POSITIVE_INFINITY,
      pCorrect: 0,
      epsilon: 0.05,
      tier: "test",
      abstention: { code: "below-threshold", message: "always-abstain test admission port" },
    }),
  });
}

describe("hades eval — routing", () => {
  it("is a declared subcommand, listed in help, and reachable", async () => {
    expect(HADES_SUBCOMMANDS).toContain("eval");

    const cli = new HadesCli({ eval: () => defaultEvalCliDeps({ root: join(dir, "data") }) });
    const help = await cli.run(["help"]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("eval <sub>");

    const res = await cli.run(["eval", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Usage: hades eval <command>");
  });

  it("an unknown eval subcommand fails with usage, not a crash", async () => {
    const cli = new HadesCli({ eval: () => defaultEvalCliDeps({ root: join(dir, "data") }) });
    const res = await cli.run(["eval", "nope"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain('unknown subcommand "nope"');
  });

  it("builds the eval deps LAZILY — `hades help` never constructs them", async () => {
    let built = 0;
    const cli = new HadesCli({
      eval: () => {
        built += 1;
        return defaultEvalCliDeps({ root: join(dir, "data") });
      },
    });

    await cli.run(["help"]);
    await cli.run(["version"]);
    expect(built).toBe(0);

    await cli.run(["eval", "help"]);
    expect(built).toBe(1);
  });

  it("caches the deps across subcommands so one process shares ONE ledger", async () => {
    let built = 0;
    const cli = new HadesCli({
      eval: () => {
        built += 1;
        return defaultEvalCliDeps({ root: join(dir, "data") });
      },
    });

    await cli.run(["eval", "history"]);
    await cli.run(["eval", "history"]);
    await cli.run(["eval", "status"]);
    expect(built).toBe(1);
  });

  it("routes a real recorded history through the router and verifies its chain", async () => {
    const root = join(dir, "data", "eval");
    const ledger = new EvalHistoryLedger({ root });
    ledger.append(await measure(1, "faithful"), { note: "seed-1" });
    ledger.append(await measure(2, "faithful"), { note: "seed-2" });

    const cli = new HadesCli({ eval: () => defaultEvalCliDeps({ root: join(dir, "data") }) });

    const listed = await cli.run(["eval", "history"]);
    expect(listed.code).toBe(0);
    expect(listed.lines.join("\n")).toContain("HADES EVAL HISTORY");
    expect(listed.lines.join("\n")).toContain("count : 2");

    const verified = await cli.run(["eval", "history", "--verify"]);
    expect(verified.code).toBe(0);
    expect(verified.lines.join("\n")).toContain("chain verified : true");
  });

  it("propagates the CI-contract exit code 2 for a REAL gate BLOCK through the router", async () => {
    const root = join(dir, "data", "eval");
    const ledger = new EvalHistoryLedger({ root });
    // Four genuinely faithful revisions, then one genuinely degraded one —
    // the regression is produced by really swapping the solver, never by
    // editing a number.
    for (const n of [1, 2, 3, 4]) ledger.append(await measure(n, "faithful"));
    ledger.append(await measure(5, "fabricating"));

    const cli = new HadesCli({ eval: () => defaultEvalCliDeps({ root: join(dir, "data") }) });
    const gate = await cli.run(["eval", "gate"]);

    expect(gate.code).toBe(2);
    const text = gate.lines.join("\n");
    expect(text).toContain("BLOCK");
    // A real named rule, from the real engine — not a generic failure string.
    expect(text).toMatch(/verified-correct-drop|silent-wrong-increase/);
  });

  it("propagates the CI-contract exit code 3 for a broken chain through the router", async () => {
    const root = join(dir, "data", "eval");
    const ledger = new EvalHistoryLedger({ root });
    ledger.append(await measure(1, "faithful"));
    ledger.append(await measure(2, "faithful"));

    // Corrupt the middle of the on-disk chain, exactly as a tamper would.
    const logPath = join(root, "history.jsonl");
    const lines = readFileSync(logPath, "utf8").split("\n");
    lines[1] = lines[1].replace(/"note":[^,]*/, '"note":"tampered"');
    writeFileSync(logPath, lines.join("\n"), "utf8");

    const cli = new HadesCli({ eval: () => defaultEvalCliDeps({ root: join(dir, "data") }) });
    const res = await cli.run(["eval", "history", "--verify"]);
    expect(res.code).toBe(3);
    expect(res.lines.join("\n")).toContain("chain verified : false");
  });
});

describe("defaultEvalCliDeps — real product wiring", () => {
  it("resolves the eval root to <dataDir>/eval using the shared HADES_DATA_DIR convention", () => {
    const deps = defaultEvalCliDeps({ env: { HADES_DATA_DIR: join(dir, "custom") } as unknown as NodeJS.ProcessEnv });
    expect(deps.root).toBe(join(dir, "custom", "eval"));

    const fallback = defaultEvalCliDeps({ env: {} as unknown as NodeJS.ProcessEnv });
    expect(fallback.root).toBe(join(".hades", "eval"));
  });

  it("does not touch disk until a stateful capability is actually used", () => {
    const root = join(dir, "lazy");
    defaultEvalCliDeps({ root });
    expect(existsSync(join(root, "eval"))).toBe(false);
  });

  it("binds a real, cached EvalHistoryLedger", () => {
    const deps = defaultEvalCliDeps({ root: join(dir, "data") });
    const a = deps.ledger();
    const b = deps.ledger();
    expect(a).toBeInstanceOf(EvalHistoryLedger);
    expect(b).toBe(a);
  });
});

describe("defaultEvalCliDeps — the risk-lane admission port", () => {
  const measureOf = (deps: EvalCliDeps): NonNullable<EvalCliDeps["measure"]> =>
    deps.measure as NonNullable<EvalCliDeps["measure"]>;

  it("refuses to drive a trust gate that cannot admit anything, and says why", async () => {
    // A real stack shape whose fitted threshold is +Infinity — the honest
    // conformal answer for verifiers with no correct-vs-wrong separation.
    // Driving it would yield 0 accepted of N attempts, i.e. a silentWrongRate
    // of 0 and withinBound=true from a gate that admitted NOTHING.
    const deps = defaultEvalCliDeps({
      root: join(dir, "data"),
      trust: () =>
        ({
          calibratedDomains: ["procedure"],
          calibrationErrors: {},
          gate: { stats: () => ({ procedure: { threshold: Number.POSITIVE_INFINITY } }) },
        }) as unknown as TrustStack,
    });

    const card = await measureOf(deps)(revision(1));
    expect(card.risk.measured).toBe(false);
    expect(card.risk.unmeasuredReason).toContain("+Infinity");
    expect(card.risk.unmeasuredReason).toContain("degenerate 0-of-0");
    // The honest "nothing happened" encoding — never a fabricated 0 rate.
    expect(Number.isNaN(card.risk.silentWrongRate)).toBe(true);
  });

  it("reports an UNcalibrated domain as unmeasured with an actionable reason", async () => {
    const deps = defaultEvalCliDeps({
      root: join(dir, "data"),
      trust: () =>
        ({
          calibratedDomains: [],
          calibrationErrors: { procedure: "no stored calibration" },
          gate: { stats: () => ({}) },
        }) as unknown as TrustStack,
    });

    const card = await measureOf(deps)(revision(1));
    expect(card.risk.measured).toBe(false);
    expect(card.risk.unmeasuredReason).toContain("not calibrated");
    expect(card.risk.unmeasuredReason).toContain("hades trust calibrate");
  });

  it("genuinely MEASURES the risk lane when the gate has a finite threshold", async () => {
    let admitCalls = 0;
    const deps = defaultEvalCliDeps({
      root: join(dir, "data"),
      trust: () =>
        ({
          calibratedDomains: ["procedure"],
          calibrationErrors: {},
          gate: {
            stats: () => ({ procedure: { threshold: 0.5 } }),
            admit: async (subject: { domain: string; taskId: string }) => {
              admitCalls += 1;
              return {
                accepted: true,
                domain: subject.domain,
                taskId: subject.taskId,
                score: 0.9,
                threshold: 0.5,
                pCorrect: 0.99,
                epsilon: 0.05,
                tier: "test",
              };
            },
          },
        }) as unknown as TrustStack,
    });

    const card = await measureOf(deps)(revision(1));
    expect(card.risk.measured).toBe(true);
    expect(card.risk.unmeasuredReason).toBeNull();
    expect(admitCalls).toBeGreaterThan(0);
    expect(card.risk.attempts).toBe(admitCalls);
    expect(card.risk.accepted).toBeGreaterThan(0);
    expect(Number.isFinite(card.risk.silentWrongRate)).toBe(true);
  });

  it("honours an explicit `admit: null` as a deliberate unmeasured lane", async () => {
    const deps = defaultEvalCliDeps({ root: join(dir, "data"), admit: null });
    const card = await measureOf(deps)(revision(1));
    expect(card.risk.measured).toBe(false);
    expect(card.risk.unmeasuredReason).toContain("no admission port was wired");
  });

  it("threads --label through the injected measurement port", async () => {
    const deps = defaultEvalCliDeps({ root: join(dir, "data"), admit: null });
    const card = await measureOf(deps)(revision(1), { label: "my-label" });
    expect(card.label).toBe("my-label");
  });
});
