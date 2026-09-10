/**
 * `hades bench recall` — the CLI surface over ../memory/recall-bench.
 *
 * These tests run the REAL benchmark (real InvertedIndex build, real
 * scoreSession baseline scan) on a small seeded corpus — nothing mocked —
 * and check the command renders the measured numbers honestly.
 */
import { describe, expect, it } from "vitest";
import { runBenchCommand } from "../cli/bench-command";
import { runRecallBench } from "../memory/recall-bench";

describe("hades bench recall", () => {
  it("runs the real benchmark and prints both engines' measured metrics", async () => {
    const res = await runBenchCommand(["recall", "--sessions", "24", "--seed", "7"], { env: null });
    expect(res.code).toBe(0);
    const out = res.lines.join("\n");
    expect(out).toContain("24 sessions");
    expect(out).toContain("FTS (BM25F)");
    expect(out).toContain("legacy scan");
    expect(out).toContain("seed 7");

    // The printed FTS metrics are the real ones runRecallBench computes for
    // the identical deterministic corpus — not constants baked into the CLI.
    const report = runRecallBench({ sessions: 24, seed: 7 });
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    expect(out).toContain(pct(report.fts.recallAt1));
    expect(out).toContain(pct(report.baseline.recallAt1));
    expect(out).toContain(report.fts.mrr.toFixed(4));
    expect(out).toContain(report.baseline.mrr.toFixed(4));
  });

  it("defaults to the 60-session corpus", async () => {
    const res = await runBenchCommand(["recall"], { env: null });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("60 sessions");
  });

  it("rejects malformed --sessions/--seed values honestly", async () => {
    for (const argv of [
      ["recall", "--sessions", "zero"],
      ["recall", "--sessions", "-3"],
      ["recall", "--sessions"],
      ["recall", "--seed", "1.5"],
    ]) {
      const res = await runBenchCommand(argv, { env: null });
      expect(res.code).toBe(1);
      expect(res.lines[0]).toContain("Invalid");
    }
  });

  it("is listed in bench usage", async () => {
    const res = await runBenchCommand(["help"], { env: null });
    expect(res.lines.join("\n")).toContain("recall [--sessions N] [--seed N]");
  });
});
