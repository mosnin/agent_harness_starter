/**
 * Cost-meter tests.
 *
 * These pin the two understatements the meter exists to prevent:
 *
 *   1. a call whose response carried no `usage` block being counted as
 *      0 tokens (and therefore $0), and
 *   2. a call on a model with no published price being counted as $0.
 *
 * Both would make a run look cheaper than it was, and every per-dollar metric
 * in `../../bench/vtph.ts` divides by spend — so understating cost is the
 * single most flattering error this codebase can make.
 */
import { describe, expect, it } from "vitest";
import {
  CostMeter,
  describeModelSpend,
  describeModelTokens,
  describeSpend,
  describeTokens,
  emptyCostReport,
  formatCostLine,
  formatCostReport,
  formatUsd,
  summarizeCalls,
  type MeteredCall,
} from "../meter";

function call(over: Partial<MeteredCall> = {}): MeteredCall {
  return {
    model: "gpt-4o-mini",
    provider: "openai",
    tokensIn: 50,
    tokensOut: 10,
    latencyMs: 40,
    at: 1_000,
    ...over,
  };
}

describe("CostMeter — measured totals", () => {
  it("sums provider-reported tokens and prices them", () => {
    const meter = new CostMeter();
    meter.record(call()).record(call({ tokensIn: 100, tokensOut: 20, latencyMs: 60 }));
    const report = meter.report();

    expect(report.calls).toBe(2);
    expect(report.meteredCalls).toBe(2);
    expect(report.tokensIn).toBe(150);
    expect(report.tokensOut).toBe(30);
    expect(report.usd).toBeCloseTo(0.0000405, 12); // 150/1e6*.15 + 30/1e6*.60
    expect(report.complete).toBe(true);
    expect(report.modelLatencyMs).toBe(100);
    expect(report.slowestCallMs).toBe(60);
  });

  it("an empty run is complete but explicitly empty", () => {
    const report = new CostMeter().report();
    expect(report).toEqual(emptyCostReport());
    expect(formatCostLine(report)).toContain("0 model calls");
  });
});

describe("a response with no usage block", () => {
  it("counts the CALL but not zero tokens, and stops claiming completeness", () => {
    const report = summarizeCalls([call({ tokensIn: null, tokensOut: null })]);
    expect(report.calls).toBe(1);
    expect(report.meteredCalls).toBe(0);
    expect(report.usageMissingCalls).toBe(1);
    expect(report.tokensIn).toBe(0);
    expect(report.complete).toBe(false);
  });

  it("renders UNKNOWN rather than $0.00 — the renderer must not re-tell the lie", () => {
    const report = summarizeCalls([call({ tokensIn: null, tokensOut: null })]);
    expect(describeTokens(report)).toContain("UNKNOWN");
    expect(describeSpend(report)).toContain("UNKNOWN");
    expect(describeSpend(report)).not.toContain("$0");
    expect(formatCostLine(report)).not.toContain("$0.00");
    expect(formatCostReport(report).join("\n")).toContain("not counted as zero");
  });

  it("carries the caveat onto the one-line form too", () => {
    const report = summarizeCalls([call(), call({ tokensIn: null, tokensOut: null })]);
    expect(formatCostLine(report)).toContain("1 call(s) reported no usage and are excluded");
    expect(formatCostLine(report)).toContain("lower bound");
  });

  it("treats a HALF-reported usage block as absent", () => {
    // prompt_tokens present, completion_tokens missing: adding a real input
    // count to an assumed-zero output count is the same understatement.
    const report = summarizeCalls([call({ tokensOut: null })]);
    expect(report.meteredCalls).toBe(0);
    expect(report.tokensIn).toBe(0);
    expect(report.usageMissingCalls).toBe(1);
  });
});

describe("a model with no published price", () => {
  it("is named, counted, and excluded from the dollar total", () => {
    const report = summarizeCalls([call(), call({ model: "llama-3.3-70b-local" })]);
    expect(report.unpricedCalls).toBe(1);
    expect(report.unpricedModels).toEqual(["llama-3.3-70b-local"]);
    // Tokens ARE measured for it (usage was reported) — only the price is unknown.
    expect(report.tokensIn).toBe(100);
    // The priced call's spend is present; the unpriced one contributes nothing
    // and the report refuses to call the number complete.
    expect(report.usd).toBeCloseTo(0.0000135, 12);
    expect(report.complete).toBe(false);
    expect(describeSpend(report)).toContain("UNKNOWN for 1 call(s)");
    expect(describeSpend(report)).toContain("llama-3.3-70b-local");
  });

  it("keeps its per-model spend null even when other calls on it are priced", () => {
    const report = summarizeCalls([call({ model: "mystery" }), call({ model: "mystery" })]);
    const bucket = report.byModel.find((m) => m.model === "mystery");
    expect(bucket?.usd).toBeNull();
    expect(describeModelSpend(bucket!)).toContain("UNKNOWN");
  });

  it("reports UNKNOWN (not $0.00) when NOTHING was priceable", () => {
    const report = summarizeCalls([call({ model: "mystery" })]);
    expect(report.usd).toBe(0);
    expect(describeSpend(report)).toContain("UNKNOWN");
    expect(describeSpend(report)).not.toMatch(/\$0/);
  });
});

describe("provider served a different model than requested", () => {
  it("prices against the REQUESTED id and surfaces the mismatch", () => {
    const report = summarizeCalls([call({ servedModel: "stub-model" })]);
    expect(report.usd).toBeCloseTo(0.0000135, 12);
    expect(report.modelMismatches).toEqual(["gpt-4o-mini -> stub-model"]);
    expect(formatCostReport(report).join("\n")).toContain("priced against the REQUESTED id");
  });

  it("says nothing when the ids agree", () => {
    const report = summarizeCalls([call({ servedModel: "gpt-4o-mini" })]);
    expect(report.modelMismatches).toEqual([]);
  });
});

describe("rendering", () => {
  it("never rounds a real sub-cent charge away to $0.00", () => {
    expect(formatUsd(0.0000135)).toBe("$0.0000135");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.23456)).toBe("$1.2346");
  });

  it("reports wall clock separately from summed model latency", () => {
    // Two 40ms calls that overlapped inside a 50ms run: quoting only the sum
    // (80ms) would misrepresent a parallel run's real duration.
    const report = summarizeCalls([call(), call()]);
    const lines = formatCostReport(report, { wallClockMs: 50 }).join("\n");
    expect(lines).toContain("wall clock         50 ms (measured, end to end)");
    expect(lines).toContain("80 ms summed");
  });

  it("labels every figure measured, and labels incompleteness too", () => {
    const complete = formatCostReport(summarizeCalls([call()])).join("\n");
    expect(complete).toContain("(measured)");
    expect(complete).not.toContain("lower bound");

    const partial = formatCostReport(summarizeCalls([call(), call({ tokensIn: null, tokensOut: null })])).join("\n");
    expect(partial).toContain("lower bound");
  });

  it("never emits the (modeled) label — there is no modeled lane here", () => {
    const lines = formatCostReport(summarizeCalls([call()]), { wallClockMs: 10 }).join("\n");
    expect(lines).not.toContain("(modeled)");
  });

  it("per-model tokens read UNKNOWN when no call on that model reported usage", () => {
    const report = summarizeCalls([call({ tokensIn: null, tokensOut: null })]);
    expect(describeModelTokens(report.byModel[0])).toBe("UNKNOWN in/out");
  });
});

describe("recomputation", () => {
  it("summarizeCalls is the same function the meter uses", () => {
    const calls = [call(), call({ model: "gpt-4o", tokensIn: 7, tokensOut: 3 })];
    const meter = new CostMeter();
    for (const c of calls) meter.record(c);
    expect(meter.report()).toEqual(summarizeCalls(calls));
  });

  it("hands back defensive copies so a report cannot be edited after the fact", () => {
    const meter = new CostMeter().record(call());
    meter.calls()[0].tokensIn = 999_999;
    expect(meter.report().tokensIn).toBe(50);
  });
});
