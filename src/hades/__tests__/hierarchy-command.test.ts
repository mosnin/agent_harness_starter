import { describe, it, expect } from "vitest";
import { runHierarchyCommand } from "../cli/hierarchy-command";

describe("runHierarchyCommand", () => {
  it("no-arg and help list the subcommands (code 0)", async () => {
    for (const args of [[] as string[], ["help"]]) {
      const res = await runHierarchyCommand(args);
      expect(res.code).toBe(0);
      const text = res.lines.join("\n");
      expect(text).toContain("head-to-head");
      expect(text).toContain("makespan");
      expect(text).toContain("chaos");
      expect(text).toContain("fuzz");
      expect(text).toContain("stats");
    }
  });

  it("unknown subcommand → code 1 with guidance", async () => {
    const res = await runHierarchyCommand(["bogus"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Unknown hierarchy command: bogus");
    expect(res.lines.join("\n")).toContain("run `hades hierarchy help`");
  });

  it("head-to-head prints a table header and a speedup summary", async () => {
    const res = await runHierarchyCommand(["head-to-head"], {
      headToHead: { workerCounts: [4], branching: 2, aggCostPerItem: 10 },
      makespan: { workerCounts: [4], branching: 2 },
    });
    expect(res.code).toBe(0);
    // Every line is a single line (no embedded newlines).
    expect(res.lines.every((l) => !l.includes("\n"))).toBe(true);
    const text = res.lines.join("\n");
    expect(text).toContain("| Workers |");
    expect(text).toContain("Routing speedup: up to");
    expect(text).toContain("Makespan (latency model): up to");
  });

  it("makespan prints its markdown table", async () => {
    const res = await runHierarchyCommand(["makespan"], {
      makespan: { workerCounts: [8], branching: 2 },
    });
    expect(res.code).toBe(0);
    expect(res.lines[0]).toContain("| Workers |");
    expect(res.lines.some((l) => l.includes("---"))).toBe(true);
  });

  it("chaos with tiny runsPerScenario → code 0, invariants held, silent-wrong 0", async () => {
    const res = await runHierarchyCommand(["chaos"], {
      chaos: { runsPerScenario: 2, leafValues: [1, 2, 3, 4] },
    });
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("silent-wrong:     0");
    expect(text).toContain("allInvariantsHeld: true");
  });

  it("fuzz 20 → code 0 and checked=20", async () => {
    const res = await runHierarchyCommand(["fuzz", "20"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("checked 20");
  });

  it("fuzz with invalid count → code 1", async () => {
    const res = await runHierarchyCommand(["fuzz", "abc"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("Invalid count");
  });

  it("stats 2 2 → workers=8 (2^3), depth 3", async () => {
    const res = await runHierarchyCommand(["stats", "2", "2"]);
    expect(res.code).toBe(0);
    const text = res.lines.join("\n");
    expect(text).toContain("workers:  8");
    expect(text).toContain("depth:    3");
  });
});
