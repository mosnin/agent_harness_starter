/**
 * `hades cost` surface tests.
 *
 * The surface is where an honest accounting can still be undone by a
 * flattering render, so these assert on the exact WORDS: an unpriced model
 * must produce the string "UNKNOWN" and must not produce a "$0" that a reader
 * would take for a measured zero.
 */
import { describe, expect, it } from "vitest";
import { runCostCommand, type CostCommandDeps } from "../cost-command";
import { HadesCli, HADES_SUBCOMMANDS } from "../cli";
import type { RunCostRecord } from "../../cost/journal";
import type { MeteredCall } from "../../cost/meter";
import { PRICES_FILE_VAR } from "../../cost/prices";

function call(over: Partial<MeteredCall> = {}): MeteredCall {
  return { model: "gpt-4o-mini", provider: "openai", tokensIn: 50, tokensOut: 10, latencyMs: 40, at: 1_000, ...over };
}

function record(over: Partial<RunCostRecord> = {}): RunCostRecord {
  return {
    v: 1,
    runId: "run-1",
    surface: "chat",
    startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    wallClockMs: 55,
    model: "gpt-4o-mini",
    provider: "openai",
    calls: [call()],
    ...over,
  };
}

/** Deps over an in-memory journal — no filesystem, no clock. */
function deps(lines: string[], env: Record<string, string | undefined> = {}): CostCommandDeps {
  return {
    env,
    journalPath: "/journal.jsonl",
    readFile: (p) => {
      if (p === "/journal.jsonl") return lines.join("\n");
      throw new Error(`ENOENT: ${p}`);
    },
  };
}

const J = (...records: RunCostRecord[]) => records.map((r) => JSON.stringify(r));

describe("hades cost — routing", () => {
  it("is a registered subcommand", () => {
    expect(HADES_SUBCOMMANDS).toContain("cost");
  });

  it("routes through the CLI and reports an empty journal honestly", async () => {
    const cli = new HadesCli({ costJournal: "/does/not/exist/runs.jsonl" });
    const res = await cli.run(["cost"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("No runs recorded yet");
  });

  it("rejects an unknown subcommand", () => {
    const res = runCostCommand(["nope"], deps(J(record())));
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Unknown cost command");
  });

  it("rejects a bad --limit rather than guessing one", () => {
    const res = runCostCommand(["runs", "--limit", "zero"], deps(J(record())));
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("Invalid --limit");
  });
});

describe("hades cost last / session — measured figures", () => {
  it("reports the measured tokens and dollars of the most recent run", () => {
    const res = runCostCommand(["last"], deps(J(record())));
    const out = res.lines.join("\n");
    expect(res.code).toBe(0);
    expect(out).toContain("50 / 10 (measured)");
    expect(out).toContain("$0.0000135");
    expect(out).toContain("wall clock         55 ms (measured, end to end)");
  });

  it("picks the latest by START time, not by file order", () => {
    const older = record({ runId: "older", startedAt: 9_000 });
    const newer = record({ runId: "newer", startedAt: 10_000 });
    // Appended out of order, as a long run finishing late really would be.
    const res = runCostCommand(["last"], deps(J(newer, older)));
    expect(res.lines[0]).toContain("newer");
  });

  it("sums across runs and keeps unknowns unknown", () => {
    const res = runCostCommand(
      ["session"],
      deps(J(record(), record({ runId: "r2", calls: [call({ model: "llama-3.3-70b-local" })] }))),
    );
    const out = res.lines.join("\n");
    expect(out).toContain("2 recorded run(s)");
    expect(out).toContain("UNKNOWN for 1 call(s) on unpriced model(s): llama-3.3-70b-local");
    expect(out).toContain("llama-3.3-70b-local  1 call(s)  50 in / 10 out  UNKNOWN (unpriced model)");
  });

  it("never prints a $0 for a run whose provider reported no usage", () => {
    const res = runCostCommand(["last"], deps(J(record({ calls: [call({ tokensIn: null, tokensOut: null })] }))));
    const out = res.lines.join("\n");
    expect(out).toContain("UNKNOWN");
    expect(out).toContain("not counted as zero");
    expect(out).not.toMatch(/spend\s+\$0/);
  });

  it("emits no (modeled) label — this surface has no modeled lane", () => {
    expect(runCostCommand(["session"], deps(J(record()))).lines.join("\n")).not.toContain("(modeled)");
  });
});

describe("hades cost — the ledger is recomputed, not believed", () => {
  it("ignores a tampered `report` field in the journal", () => {
    const tampered = JSON.stringify({ ...record(), report: { calls: 99, usd: 12.5, tokensIn: 0, tokensOut: 0 } });
    const out = runCostCommand(["last"], deps([tampered])).lines.join("\n");
    expect(out).toContain("$0.0000135");
    expect(out).not.toContain("12.5");
    expect(out).not.toContain("99");
  });

  it("counts unreadable lines and says the totals are a lower bound", () => {
    const out = runCostCommand(["session"], deps([...J(record()), "{corrupt"])).lines.join("\n");
    expect(out).toContain("1 unreadable record(s)");
    expect(out).toContain("lower bound");
  });
});

describe("hades cost prices", () => {
  it("prints each price with its source and the date the line was last edited here", () => {
    const out = runCostCommand(["prices", "gpt-4o-mini"], deps([])).lines.join("\n");
    expect(out).toContain("in $0.15 / out $0.6 per Mtok");
    expect(out).toContain("openai.com/api/pricing");
    expect(out).toContain("NOT a re-check of the vendor's page");
  });

  it("says UNKNOWN, not $0, for a model it does not price", () => {
    const out = runCostCommand(["prices", "mystery-model"], deps([])).lines.join("\n");
    expect(out).toContain("is NOT in the price table — its cost is UNKNOWN, not $0");
    expect(out).toContain(PRICES_FILE_VAR);
  });

  it("names a broken price override instead of silently using the builtin table", () => {
    const res = runCostCommand(["prices", "gpt-4o-mini"], {
      env: { [PRICES_FILE_VAR]: "/rates.json" },
      journalPath: "/journal.jsonl",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(res.lines.join("\n")).toContain("using the builtin table");
  });

  it("uses a valid override and says where the numbers came from", () => {
    const res = runCostCommand(["last"], {
      env: { [PRICES_FILE_VAR]: "/rates.json" },
      journalPath: "/journal.jsonl",
      readFile: (p) => {
        if (p === "/journal.jsonl") return J(record())[0];
        return JSON.stringify([
          { model: "gpt-4o-mini", inputUsdPerMTok: 100, outputUsdPerMTok: 200, source: "our rate card" },
        ]);
      },
    });
    const out = res.lines.join("\n");
    // 50/1e6*100 + 10/1e6*200 = 0.007
    expect(out).toContain("$0.007");
    expect(out).toContain("operator override");
  });
});
