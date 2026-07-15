import { describe, it, expect } from "vitest";
import { renderTui, type TuiState } from "../tui/render";

const sample: TuiState = {
  mode: "docker",
  groundingRate: 0.92,
  metrics: {
    goals: { total: 3, completed: 2, failed: 0, aborted: 0, running: 1 },
    tasks: { total: 9, verified: 7, failed: 0, pending: 1, dispatched: 1 },
    workers: { total: 3, idle: 2, busy: 1, killed: 0, dead: 0 },
    verification: { total: 8, accepted: 7, rejected: 1, avgScore: 0.88, groundingRate: 0.92 },
    usage: { toolCalls: 24, costUsd: 0.0123 },
  },
  workers: [
    { workerId: "w-1", status: "idle", capabilities: ["research"] },
    { workerId: "w-2", status: "busy", capabilities: ["code"] },
  ],
  tasks: [
    { description: "Investigate the objective from the research angle", status: "verified" },
    { description: "Synthesize a grounded answer", status: "dispatched" },
  ],
  logs: [{ workerId: "w-2", line: "running task ab12" }],
};

describe("renderTui", () => {
  it("renders a boxed snapshot with all sections", () => {
    const out = renderTui(sample);
    expect(out).toContain("HERMES·SWARM");
    expect(out).toContain("mode=docker");
    expect(out).toContain("grounded=92%");
    expect(out).toContain("goals 2/3 done");
    expect(out).toContain("WORKERS (2)");
    expect(out).toContain("w-1");
    expect(out).toContain("TASKS (2)");
    expect(out).toContain("$0.0123");
    // every line is the same visible width (box aligns)
    const lines = out.split("\n");
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });

  it("handles an empty/partial state without throwing", () => {
    expect(() => renderTui({})).not.toThrow();
    const out = renderTui({ mode: "inline" });
    expect(out).toContain("mode=inline");
  });

  it("truncates long task descriptions to keep the box aligned", () => {
    const out = renderTui({
      tasks: [{ description: "x".repeat(500), status: "verified" }],
    }, 60);
    const lines = out.split("\n");
    expect(new Set(lines.map((l) => [...l].length)).size).toBe(1);
  });
});
