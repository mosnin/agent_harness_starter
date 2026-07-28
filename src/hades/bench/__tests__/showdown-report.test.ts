import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderShowdownMarkdown, renderShowdownText, writeShowdownArtifacts } from "../showdown-report";
import { runShowdown, verifyAuditChain } from "../showdown";
import type { AuditRecord, ShowdownMode, ShowdownResult } from "../showdown";
import { sha256Hex } from "../../styx/certificate";
import type { VtphComparison, VtphReport } from "../vtph";

// ---------------------------------------------------------------------------
// Fixture builders — reproduce the production hash-chain algorithm (genesis
// literal + fixed-order JSON canonicalization) so we can hand-craft
// ShowdownResults the renderers will accept (a valid chain is required —
// both renderers refuse to render a broken one).
// ---------------------------------------------------------------------------

const GENESIS = sha256Hex("hades.bench.showdown.v1");

function buildChain(
  entries: Array<{ taskId: string; lane: "swarm" | "baseline"; verdict: string; elapsedMs: number; usd: number; mode: ShowdownMode }>
): AuditRecord[] {
  let prevHash = GENESIS;
  const out: AuditRecord[] = [];
  entries.forEach((e, seq) => {
    const base = {
      seq,
      taskId: e.taskId,
      lane: e.lane,
      verdict: e.verdict,
      elapsedMs: e.elapsedMs,
      usd: e.usd,
      mode: e.mode,
      prevHash,
    };
    const hash = sha256Hex(prevHash + "\n" + JSON.stringify(base));
    out.push({ ...base, hash });
    prevHash = hash;
  });
  return out;
}

function emptyReport(label: string): VtphReport {
  return {
    label,
    tasks: 0,
    verifiedCorrect: 0,
    silentWrong: 0,
    declined: 0,
    correctButUnclaimed: 0,
    wallClockMs: 0,
    totalTokens: 0,
    totalUsd: 0,
    vtph: 0,
    vtphPerDollar: 0,
    verifiedYield: 0,
    provenanceCompleteRate: 0,
  };
}

function makeResult(opts: {
  mode: ShowdownMode;
  audit: AuditRecord[];
  swarmReport: VtphReport;
  baselineReport: VtphReport;
  taskCount: number;
  seed?: number;
}): ShowdownResult {
  const comparison: VtphComparison = {
    reports: [opts.swarmReport, opts.baselineReport],
    markdownTable: "| unused |",
    vtphPerDollarSpeedup: 1,
  };
  return {
    mode: opts.mode,
    seed: opts.seed ?? 1,
    taskCount: opts.taskCount,
    swarmReport: opts.swarmReport,
    baselineReport: opts.baselineReport,
    comparison,
    audit: opts.audit,
  };
}

// ===========================================================================
// Tamper refusal
// ===========================================================================

describe("renderShowdownText / renderShowdownMarkdown — tamper refusal", () => {
  it("throws instead of rendering when the audit chain is broken", () => {
    const audit = buildChain([
      { taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 1, usd: 0.001, mode: "modeled" },
      { taskId: "t0", lane: "baseline", verdict: "verified", elapsedMs: 1, usd: 0.001, mode: "modeled" },
    ]);
    audit[1].verdict = "rejected"; // tamper after chaining, without recomputing the hash
    const result = makeResult({
      mode: "modeled",
      audit,
      swarmReport: emptyReport("swarm"),
      baselineReport: emptyReport("baseline"),
      taskCount: 1,
    });
    expect(() => renderShowdownText(result)).toThrow(/audit/i);
    expect(() => renderShowdownMarkdown(result)).toThrow(/audit/i);
  });

  it("renders fine when the chain is genuinely valid", () => {
    const audit = buildChain([
      { taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 1, usd: 0.001, mode: "modeled" },
      { taskId: "t0", lane: "baseline", verdict: "verified", elapsedMs: 1, usd: 0.001, mode: "modeled" },
    ]);
    const result = makeResult({
      mode: "modeled",
      audit,
      swarmReport: emptyReport("swarm"),
      baselineReport: emptyReport("baseline"),
      taskCount: 1,
    });
    expect(() => renderShowdownText(result)).not.toThrow();
    expect(() => renderShowdownMarkdown(result)).not.toThrow();
  });
});

// ===========================================================================
// Mode labeling
// ===========================================================================

describe("mode labeling", () => {
  it("suffixes every figure with (modeled) on a modeled run", () => {
    const audit = buildChain([
      { taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "modeled" },
      { taskId: "t0", lane: "baseline", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "modeled" },
    ]);
    const swarmReport: VtphReport = { ...emptyReport("swarm"), tasks: 1, verifiedCorrect: 1, vtph: 12, totalUsd: 0.01, vtphPerDollar: 1200 };
    const baselineReport: VtphReport = { ...emptyReport("baseline"), tasks: 1, verifiedCorrect: 1, vtph: 12, totalUsd: 0.01, vtphPerDollar: 1200 };
    const result = makeResult({ mode: "modeled", audit, swarmReport, baselineReport, taskCount: 1 });

    const md = renderShowdownMarkdown(result);
    expect(md).toContain("MODELED");
    // Every numeric-figure-bearing table row should carry the label.
    const rows = md.split("\n").filter((l) => l.startsWith("| swarm") || l.startsWith("| baseline"));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const modeledCount = (row.match(/\(modeled\)/g) ?? []).length;
      expect(modeledCount).toBeGreaterThanOrEqual(5); // tasks/verified/silent/declined/vtph/spend/vtph$
    }

    const text = renderShowdownText(result);
    const figureLines = text.filter((l) => /:\s+\S/.test(l) && !l.startsWith("SHOWDOWN") && !l.startsWith("seed"));
    expect(figureLines.some((l) => l.includes("(modeled)"))).toBe(true);
    // The trust-adjusted verified-yield line is present and carries the label.
    expect(text.some((l) => l.includes("verified-yield") && l.includes("(modeled)"))).toBe(true);
  });

  it("renders verifiedYield in both renderers — negative values included, labeled (modeled)", async () => {
    const audit = buildChain([
      { taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "modeled" },
      { taskId: "t0", lane: "baseline", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "modeled" },
    ]);
    const swarmReport: VtphReport = {
      ...emptyReport("swarm"),
      tasks: 1,
      verifiedCorrect: 1,
      vtph: 12,
      totalUsd: 0.01,
      vtphPerDollar: 1200,
      verifiedYield: 100, // (1 - 0) / 0.01
    };
    const baselineReport: VtphReport = {
      ...emptyReport("baseline"),
      tasks: 1,
      silentWrong: 1,
      vtph: 0,
      totalUsd: 0.01,
      vtphPerDollar: 0,
      verifiedYield: -1000, // (0 - 10) / 0.01 — a lie drags the lane negative
    };
    const result = makeResult({ mode: "modeled", audit, swarmReport, baselineReport, taskCount: 1 });

    const md = renderShowdownMarkdown(result);
    expect(md).toContain("Yield$");
    expect(md).toContain("100.00 (modeled)");
    expect(md).toContain("-1000.00 (modeled)");

    const text = renderShowdownText(result).join("\n");
    expect(text).toContain("verified-yield ($): 100.00 (modeled)");
    expect(text).toContain("verified-yield ($): -1000.00 (modeled)");
  });

  it("never adds a (modeled) suffix on a real run", () => {
    const audit = buildChain([
      { taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "real" },
      { taskId: "t0", lane: "baseline", verdict: "verified", elapsedMs: 5, usd: 0.01, mode: "real" },
    ]);
    const swarmReport: VtphReport = { ...emptyReport("swarm"), tasks: 1, verifiedCorrect: 1, vtph: 12, totalUsd: 0.01, vtphPerDollar: 1200 };
    const baselineReport: VtphReport = { ...emptyReport("baseline"), tasks: 1, verifiedCorrect: 1, vtph: 12, totalUsd: 0.01, vtphPerDollar: 1200 };
    const result = makeResult({ mode: "real", audit, swarmReport, baselineReport, taskCount: 1 });

    const md = renderShowdownMarkdown(result);
    expect(md).not.toContain("(modeled)");
    expect(md).toContain("REAL");

    const text = renderShowdownText(result);
    expect(text.join("\n")).not.toContain("(modeled)");
  });
});

// ===========================================================================
// Edge cases: empty suite, all-rejected suite, unicode task text
// ===========================================================================

describe("edge cases", () => {
  it("renders an empty (0-task) suite without throwing or producing garbage", () => {
    const result = makeResult({
      mode: "modeled",
      audit: [],
      swarmReport: emptyReport("swarm"),
      baselineReport: emptyReport("baseline"),
      taskCount: 0,
    });
    expect(verifyAuditChain(result.audit)).toEqual({ ok: true });
    const text = renderShowdownText(result);
    expect(text.length).toBeGreaterThan(0);
    const md = renderShowdownMarkdown(result);
    expect(md).toContain("audit records: `0`");
    expect(md).toContain("empty"); // audit-sample section says so
  });

  it("renders an all-rejected suite (real run through the swarm) with declined/silentWrong figures matching", async () => {
    const alwaysWrongExecutor = {
      execute: async () => ({
        output: "definitely-wrong",
        claims: [], // no claims => the real gate hard-rejects (evidence-traceable critical fail)
        toolTrace: [],
      }),
    };
    const alwaysDeclineBaseline = async () => ({
      output: "definitely-wrong",
      claimedVerified: false,
      tokensIn: 1,
      tokensOut: 1,
      usd: 0.0001,
      provenance: [],
    });
    let c = 0;
    const result = await runShowdown({
      mode: "modeled",
      seed: 21,
      taskCount: 4,
      now: () => (c += 1),
      swarm: { executor: alwaysWrongExecutor },
      baselineRunner: alwaysDeclineBaseline,
    });
    expect(result.swarmReport.verifiedCorrect).toBe(0);
    expect(result.swarmReport.declined).toBe(4);
    expect(result.swarmReport.silentWrong).toBe(0);
    expect(result.baselineReport.verifiedCorrect).toBe(0);
    expect(result.audit.every((r) => r.lane !== "swarm" || r.verdict === "rejected" || r.verdict === "failed")).toBe(
      true
    );

    const md = renderShowdownMarkdown(result);
    expect(md).toContain("| swarm | 4 (modeled) | 0 (modeled) | 0 (modeled) | 4 (modeled)");
    const text = renderShowdownText(result);
    expect(text.join("\n")).toContain("declined:           4 (modeled)");
  }, 30000);

  it("keeps the markdown table intact when a task id contains unicode, pipes, and newlines", () => {
    const trickyId = 'showdown-☃-日本語-"pipe|here"\nnewline-emoji-🔥';
    const audit = buildChain([
      { taskId: trickyId, lane: "swarm", verdict: "verified", elapsedMs: 3, usd: 0.002, mode: "modeled" },
      { taskId: trickyId, lane: "baseline", verdict: "declined", elapsedMs: 2, usd: 0.001, mode: "modeled" },
    ]);
    const swarmReport: VtphReport = { ...emptyReport("swarm"), tasks: 1, verifiedCorrect: 1, vtph: 5, totalUsd: 0.002, vtphPerDollar: 2500 };
    const baselineReport: VtphReport = { ...emptyReport("baseline"), tasks: 1, declined: 1, vtph: 0, totalUsd: 0.001, vtphPerDollar: 0 };
    const result = makeResult({ mode: "modeled", audit, swarmReport, baselineReport, taskCount: 1 });

    const md = renderShowdownMarkdown(result);
    const lines = md.split("\n");
    // No row derived from the tricky id may have a different pipe-COLUMN count
    // than the header — i.e. an embedded newline never split one logical row
    // into two lines, and an unescaped `|` never added a phantom column.
    // (A backslash-escaped `|` is legitimate table content, not a delimiter —
    // splitMarkdownRow mirrors what any real markdown table parser does.)
    const splitMarkdownRow = (row: string): string[] => row.split(/(?<!\\)\|/);
    const headerCols = splitMarkdownRow("| Seq | Lane | Verdict | Task |").length;
    const sampleRows = lines.filter((l) => l.startsWith("| 0 ") || l.startsWith("| 1 "));
    expect(sampleRows.length).toBe(2);
    for (const row of sampleRows) {
      expect(splitMarkdownRow(row).length).toBe(headerCols);
    }
    // The unicode content survives (escaped for `|`, newline collapsed to space).
    expect(md).toContain("☃");
    expect(md).toContain("日本語");
    expect(md).toContain("🔥");
    expect(md).not.toMatch(/pipe\|here/); // raw unescaped pipe must not appear
    expect(md).toContain("pipe\\|here"); // escaped form does
  });
});

// ===========================================================================
// writeShowdownArtifacts
// ===========================================================================

describe("writeShowdownArtifacts", () => {
  it("writes report.md, audit.jsonl, and result.json atomically, all mutually consistent", async () => {
    let c = 0;
    const result = await runShowdown({ mode: "modeled", seed: 5, taskCount: 6, now: () => (c += 1) });
    const dir = await mkdtemp(join(tmpdir(), "showdown-artifacts-"));

    const { files } = await writeShowdownArtifacts(result, dir);
    expect(files.length).toBe(3);

    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["audit.jsonl", "report.md", "result.json"]);
    // No leftover .tmp files — atomic rename completed cleanly.
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);

    const auditRaw = await readFile(join(dir, "audit.jsonl"), "utf8");
    const records = auditRaw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditRecord);
    expect(records.length).toBe(result.audit.length);
    expect(verifyAuditChain(records)).toEqual({ ok: true });

    const resultRaw = await readFile(join(dir, "result.json"), "utf8");
    const parsedResult = JSON.parse(resultRaw) as ShowdownResult;
    expect(parsedResult.taskCount).toBe(6);
    expect(parsedResult.audit.length).toBe(result.audit.length);

    const reportRaw = await readFile(join(dir, "report.md"), "utf8");
    expect(reportRaw).toContain("MODELED");
  }, 30000);

  it("refuses to write anything when the audit chain is broken", async () => {
    const audit = buildChain([{ taskId: "t0", lane: "swarm", verdict: "verified", elapsedMs: 1, usd: 0.001, mode: "modeled" }]);
    audit[0].usd = 999; // tamper without recomputing hash
    const result = makeResult({
      mode: "modeled",
      audit,
      swarmReport: emptyReport("swarm"),
      baselineReport: emptyReport("baseline"),
      taskCount: 1,
    });
    const dir = await mkdtemp(join(tmpdir(), "showdown-artifacts-refuse-"));
    await expect(writeShowdownArtifacts(result, dir)).rejects.toThrow(/audit/i);
    const entries = await readdir(dir);
    expect(entries.length).toBe(0);
  });
});
