/**
 * Run-cost journal tests.
 *
 * The journal's job is to be a ledger nobody has to trust: aggregates are
 * always RECOMPUTED from the stored calls, a corrupt line is skipped AND
 * counted (so an under-report is visible, never silent), and a failed write
 * is reported rather than swallowed.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunCost,
  costJournalPath,
  readRunCosts,
  recomputeRunReport,
  totalRunCosts,
  type RunCostRecord,
} from "../journal";
import type { MeteredCall } from "../meter";

function call(over: Partial<MeteredCall> = {}): MeteredCall {
  return { model: "gpt-4o-mini", provider: "openai", tokensIn: 50, tokensOut: 10, latencyMs: 40, at: 1_000, ...over };
}

function record(over: Partial<RunCostRecord> = {}): RunCostRecord {
  return {
    v: 1,
    runId: "run-1",
    surface: "chat",
    startedAt: 1_000,
    wallClockMs: 55,
    model: "gpt-4o-mini",
    provider: "openai",
    calls: [call()],
    ...over,
  };
}

describe("journal round trip", () => {
  it("appends and reads back the individual calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-cost-"));
    try {
      const path = costJournalPath(dir);
      expect(appendRunCost(path, record())).toBeUndefined();
      expect(appendRunCost(path, record({ runId: "run-2", startedAt: 2_000 }))).toBeUndefined();

      const history = readRunCosts(path);
      expect(history.missing).toBe(false);
      expect(history.skippedLines).toBe(0);
      expect(history.records.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
      expect(history.records[0].calls[0].tokensIn).toBe(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory rather than failing the run", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-cost-"));
    try {
      const path = join(dir, "deep", "nested", "runs.jsonl");
      expect(appendRunCost(path, record())).toBeUndefined();
      expect(readFileSync(path, "utf8")).toContain("run-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing journal is an empty history, not an error", () => {
    const history = readRunCosts("/definitely/not/here/runs.jsonl");
    expect(history.missing).toBe(true);
    expect(history.records).toEqual([]);
  });

  it("reports a failed write instead of pretending the record landed", () => {
    const dir = mkdtempSync(join(tmpdir(), "hades-cost-"));
    try {
      // A FILE where the journal's parent directory should be: mkdir fails.
      const blocker = join(dir, "blocked");
      writeFileSync(blocker, "not a directory", "utf8");
      const problem = appendRunCost(join(blocker, "runs.jsonl"), record());
      expect(problem).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("corrupt input is counted, never silently dropped", () => {
  const read = (content: string) => (_: string) => content;

  it("skips and COUNTS an unparseable line", () => {
    const good = JSON.stringify(record());
    const history = readRunCosts("x", read(`${good}\n{not json\n\n${good}\n`));
    expect(history.records).toHaveLength(2);
    expect(history.skippedLines).toBe(1);
  });

  it("rejects a whole record whose calls are malformed (a partial read would UNDER-report)", () => {
    const bad = JSON.stringify({ ...record(), calls: [{ model: "m" }] });
    const history = readRunCosts("x", read(`${bad}\n`));
    expect(history.records).toHaveLength(0);
    expect(history.skippedLines).toBe(1);
  });

  it("rejects an unknown schema version rather than reinterpreting it", () => {
    const future = JSON.stringify({ ...record(), v: 2 });
    expect(readRunCosts("x", read(`${future}\n`)).skippedLines).toBe(1);
  });

  it("preserves a null token count through the round trip", () => {
    const line = JSON.stringify(record({ calls: [call({ tokensIn: null, tokensOut: null })] }));
    const history = readRunCosts("x", read(`${line}\n`));
    expect(history.records[0].calls[0].tokensIn).toBeNull();
    expect(recomputeRunReport(history.records[0]).usageMissingCalls).toBe(1);
  });
});

describe("stored totals are never trusted", () => {
  it("recomputes from the stored CALLS, ignoring a tampered `report` field", () => {
    const tampered = {
      ...record(),
      // A hand-edited total claiming the run was free.
      report: { calls: 1, usd: 0, tokensIn: 0, tokensOut: 0 },
    } as unknown as RunCostRecord;
    const report = recomputeRunReport(tampered);
    expect(report.tokensIn).toBe(50);
    expect(report.usd).toBeCloseTo(0.0000135, 12);
  });

  it("totals across runs by concatenating calls, not by adding stored sums", () => {
    const totals = totalRunCosts([
      record({ startedAt: 5_000 }),
      record({ runId: "run-2", startedAt: 1_000, calls: [call({ model: "mystery" })] }),
    ]);
    expect(totals.runs).toBe(2);
    expect(totals.report.tokensIn).toBe(100);
    expect(totals.report.unpricedModels).toEqual(["mystery"]);
    expect(totals.report.complete).toBe(false);
    expect(totals.firstAt).toBe(1_000);
    expect(totals.lastAt).toBe(5_000);
  });
});
