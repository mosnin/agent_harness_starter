import { describe, expect, it } from "vitest";

import { runClusterCommand, type ClusterCommandDeps } from "../cluster-command";
import type { ChaosRunReport, ClusterFabric } from "../../../swarm-runtime/distributed/cluster-chaos";
import { runClusterBench, type ClusterBenchReport } from "../../../swarm-runtime/distributed/cluster-bench";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeChaosReport(overrides: Partial<ChaosRunReport> = {}): ChaosRunReport {
  return {
    mode: "measured",
    nodes: 2,
    tasksSubmitted: 3,
    tasksVerified: 3,
    tasksFailed: 0,
    duplicateVerifications: 0,
    reassignments: 0,
    faultsInjected: [],
    makespanMs: 123,
    verifiedPerSec: 5,
    certificatesValid: 3,
    certificatesInvalid: 0,
    conflicts: 0,
    ...overrides,
  };
}

/** A minimal stand-in fabric for tests that only exercise `run()`/`shutdown()` —
 * `coordinator`/`nodes`/`routers` are never touched on the `run`/`chaos` code
 * paths these deps are injected into. */
function makeFakeFabric(report: ChaosRunReport, opts?: { runError?: Error }): ClusterFabric {
  return {
    coordinator: {} as unknown as ClusterFabric["coordinator"],
    nodes: [] as unknown as ClusterFabric["nodes"],
    routers: [] as unknown as ClusterFabric["routers"],
    run: async () => {
      if (opts?.runError) throw opts.runError;
      return report;
    },
    shutdown: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// help / usage / unknown-command handling
// ---------------------------------------------------------------------------

describe("runClusterCommand — dispatch and usage", () => {
  it("prints usage with exit code 0 for no args and for help", async () => {
    const r1 = await runClusterCommand([]);
    expect(r1.code).toBe(0);
    expect(r1.lines.some((l) => l.includes("Usage: hades cluster"))).toBe(true);

    const r2 = await runClusterCommand(["help"]);
    expect(r2.code).toBe(0);
    expect(r2.lines).toEqual(r1.lines);

    const r3 = await runClusterCommand(["--help"]);
    expect(r3.code).toBe(0);
  });

  it("exits 2 with a usage line for an unknown subcommand", async () => {
    const r = await runClusterCommand(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/Unknown cluster command: frobnicate/);
    expect(r.lines.some((l) => l.includes("Usage: hades cluster"))).toBe(true);
  });

  it("exits 2 with a usage line for an unknown flag", async () => {
    const r = await runClusterCommand(["status", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/unknown flag: --bogus/);
    expect(r.lines.some((l) => l.includes("Usage: hades cluster"))).toBe(true);
  });

  it("exits 2 for a flag not allowed on that subcommand", async () => {
    // --density is only valid for `chaos`, not `status`.
    const r = await runClusterCommand(["status", "--density", "0.5"]);
    expect(r.code).toBe(2);
    expect(r.lines[0]).toMatch(/unknown flag: --density/);
  });

  it("exits 2 when a numeric flag value is missing or invalid", async () => {
    const r1 = await runClusterCommand(["run", "--nodes"]);
    expect(r1.code).toBe(2);
    expect(r1.lines[0]).toMatch(/--nodes must be a positive integer/);

    const r2 = await runClusterCommand(["run", "--nodes", "abc"]);
    expect(r2.code).toBe(2);
    expect(r2.lines[0]).toMatch(/--nodes must be a positive integer/);

    const r3 = await runClusterCommand(["run", "--nodes", "0"]);
    expect(r3.code).toBe(2);
    expect(r3.lines[0]).toMatch(/--nodes must be a positive integer/);
  });

  it("exits 2 when `run` is missing required --nodes/--tasks", async () => {
    const r1 = await runClusterCommand(["run"]);
    expect(r1.code).toBe(2);
    expect(r1.lines[0]).toMatch(/--nodes is required/);

    const r2 = await runClusterCommand(["run", "--nodes", "2"]);
    expect(r2.code).toBe(2);
    expect(r2.lines[0]).toMatch(/--tasks is required/);
  });
});

// ---------------------------------------------------------------------------
// status / nodes — real fabric, small sizes
// ---------------------------------------------------------------------------

describe("runClusterCommand — status / nodes (real fabric)", () => {
  it("status builds a real fabric, reports coordinator stats, and tears it down", async () => {
    const r = await runClusterCommand(["status", "--nodes", "2", "--workers", "1"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/cluster status \(measured/);
    expect(r.lines.some((l) => l.includes("nodes: 2 x 1"))).toBe(true);
  }, 10_000);

  it("status --json emits a parseable, honestly-measured report", async () => {
    const r = await runClusterCommand(["status", "--nodes", "2", "--workers", "1", "--json"]);
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.mode).toBe("measured");
    expect(parsed.nodes).toBe(2);
    expect(parsed.workersPerNode).toBe(1);
    expect(parsed.coordinator.total).toBe(0); // nothing submitted yet
    expect(Array.isArray(parsed.peersReady)).toBe(true);
    expect(parsed.peersReady).toHaveLength(2);
  }, 10_000);

  it("nodes lists each real node's live snapshot", async () => {
    const r = await runClusterCommand(["nodes", "--nodes", "2", "--workers", "1"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/cluster nodes \(measured, 2 nodes/);
    expect(r.lines.some((l) => l.includes("node-0"))).toBe(true);
    expect(r.lines.some((l) => l.includes("node-1"))).toBe(true);
  }, 10_000);

  it("nodes --json reports real per-node snapshots", async () => {
    const r = await runClusterCommand(["nodes", "--nodes", "2", "--workers", "1", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.nodes).toHaveLength(2);
    const ids = parsed.nodes.map((n: { nodeId: string }) => n.nodeId).sort();
    expect(ids).toEqual(["node-0", "node-1"]);
    for (const n of parsed.nodes) {
      expect(n.health).toBe("alive");
    }
  }, 10_000);

  it("uses the injected `now` for the reported timestamp", async () => {
    const fixed = 1_700_000_000_000;
    const r = await runClusterCommand(["status", "--nodes", "2", "--json"], { now: () => fixed });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.asOf).toBe(fixed);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// run — real fabric end to end
// ---------------------------------------------------------------------------

describe("runClusterCommand — run (real fabric, end to end)", () => {
  it("runs real tasks across a real small fabric and reports full verification", async () => {
    const r = await runClusterCommand(["run", "--nodes", "2", "--tasks", "3", "--workers", "1"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/cluster run \(mode=measured, nodes=2\)/);
    expect(r.lines.some((l) => l.includes("submitted=3 verified=3 failed=0"))).toBe(true);
  }, 15_000);

  it("run --json emits the underlying measured ChaosRunReport verbatim", async () => {
    const r = await runClusterCommand(["run", "--nodes", "2", "--tasks", "3", "--workers", "1", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]) as ChaosRunReport;
    expect(parsed.mode).toBe("measured");
    expect(parsed.tasksSubmitted).toBe(3);
    expect(parsed.tasksVerified).toBe(3);
    expect(parsed.tasksFailed).toBe(0);
  }, 15_000);

  it("reports the honest failure path (non-zero exit) when a run does not fully verify", async () => {
    const incomplete = fakeChaosReport({ tasksSubmitted: 5, tasksVerified: 2, tasksFailed: 1 });
    const deps: ClusterCommandDeps = { fabric: async () => makeFakeFabric(incomplete) };
    const r = await runClusterCommand(["run", "--nodes", "2", "--tasks", "5"], deps);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.includes("WARNING") && l.includes("verified 2/5"))).toBe(true);
  });

  it("reports a fabric build failure with a non-zero exit and the honest reason", async () => {
    const deps: ClusterCommandDeps = {
      fabric: async () => {
        throw new Error("boom: no capacity available");
      },
    };
    const r = await runClusterCommand(["run", "--nodes", "2", "--tasks", "3"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/cluster run: failed to build fabric: boom: no capacity available/);
  });

  it("tears the fabric down even when run() throws", async () => {
    let shutdownCalled = false;
    const deps: ClusterCommandDeps = {
      fabric: async () => ({
        coordinator: {} as unknown as ClusterFabric["coordinator"],
        nodes: [] as unknown as ClusterFabric["nodes"],
        routers: [] as unknown as ClusterFabric["routers"],
        run: async () => {
          throw new Error("run exploded");
        },
        shutdown: async () => {
          shutdownCalled = true;
        },
      }),
    };
    const r = await runClusterCommand(["run", "--nodes", "1", "--tasks", "1"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/cluster run: run exploded/);
    expect(shutdownCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chaos — real fabric end to end
// ---------------------------------------------------------------------------

describe("runClusterCommand — chaos (real fabric, end to end)", () => {
  it("runs a real seeded chaos schedule against a real small fabric and fully verifies", async () => {
    const r = await runClusterCommand(["chaos", "--seed", "3", "--nodes", "3", "--tasks", "4", "--density", "0.4"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/cluster chaos \(mode=measured, nodes=3\)/);
    expect(r.lines.some((l) => l.includes("submitted=4 verified=4 failed=0"))).toBe(true);
  }, 20_000);

  it("chaos --json emits the measured report including faultsInjected", async () => {
    const r = await runClusterCommand(["chaos", "--seed", "3", "--nodes", "3", "--tasks", "4", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]) as ChaosRunReport;
    expect(parsed.tasksVerified).toBe(4);
    expect(Array.isArray(parsed.faultsInjected)).toBe(true);
  }, 20_000);

  it("the same --seed reproduces the same fault count across two runs", async () => {
    const r1 = await runClusterCommand(["chaos", "--seed", "21", "--nodes", "2", "--tasks", "3", "--json"]);
    const r2 = await runClusterCommand(["chaos", "--seed", "21", "--nodes", "2", "--tasks", "3", "--json"]);
    const p1 = JSON.parse(r1.lines[0]) as ChaosRunReport;
    const p2 = JSON.parse(r2.lines[0]) as ChaosRunReport;
    expect(p1.faultsInjected.map((f) => f.kind)).toEqual(p2.faultsInjected.map((f) => f.kind));
  }, 20_000);

  it("reports the honest failure path when the chaos run does not fully verify", async () => {
    const incomplete = fakeChaosReport({ tasksSubmitted: 4, tasksVerified: 1, tasksFailed: 0 });
    const deps: ClusterCommandDeps = { chaos: async () => incomplete };
    const r = await runClusterCommand(["chaos", "--nodes", "2", "--tasks", "4"], deps);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.includes("WARNING"))).toBe(true);
  });

  it("reports a chaos run() rejection with a non-zero exit and the honest reason", async () => {
    const deps: ClusterCommandDeps = {
      chaos: async () => {
        throw new Error("chaos exploded");
      },
    };
    const r = await runClusterCommand(["chaos", "--nodes", "2", "--tasks", "4"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/cluster chaos: chaos exploded/);
  });
});

// ---------------------------------------------------------------------------
// bench — real fabric end to end
// ---------------------------------------------------------------------------

describe("runClusterCommand — bench (real fabric, end to end)", () => {
  it("runs the real measured bench (small sizes) and reports all three arms", async () => {
    const r = await runClusterCommand(["bench", "--tasks", "3", "--nodes", "2", "--seed", "5"]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/cluster bench \(measured/);
    expect(r.lines.some((l) => l.includes("single-node"))).toBe(true);
    expect(r.lines.some((l) => l.includes("multi-node-chaos"))).toBe(true);
  }, 25_000);

  it("bench --json emits a real ClusterBenchReport with three completed arms", async () => {
    const r = await runClusterCommand(["bench", "--tasks", "3", "--nodes", "2", "--seed", "5", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]) as ClusterBenchReport;
    expect(parsed.mode).toBe("measured");
    expect(parsed.arms).toHaveLength(3);
    expect(parsed.arms.every((a) => a.tasksVerified === parsed.tasks)).toBe(true);
  }, 25_000);

  it("delegates default tasks/nodes/seed to runClusterBench when flags are omitted", async () => {
    let seen: unknown;
    const deps: ClusterCommandDeps = {
      bench: async (opts) => {
        seen = opts;
        return runClusterBench({ tasks: 2, nodes: 2, workersPerNode: 1, seed: opts?.seed ?? 1, timeoutMs: 10_000 });
      },
    };
    const r = await runClusterCommand(["bench"], deps);
    expect(r.code).toBe(0);
    expect(seen).toEqual({ tasks: undefined, nodes: undefined, seed: undefined });
  }, 15_000);

  it("reports a bench failure with a non-zero exit and the honest reason", async () => {
    const deps: ClusterCommandDeps = {
      bench: async () => {
        throw new Error("bench arm never converged");
      },
    };
    const r = await runClusterCommand(["bench"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/cluster bench: bench arm never converged/);
  });
});

// ---------------------------------------------------------------------------
// Never asserts a number the run did not measure — spot-check consistency.
// ---------------------------------------------------------------------------

describe("runClusterCommand — output never claims an unmeasured number", () => {
  it("the human-readable `run` summary's counts match the underlying report exactly", async () => {
    const jsonResult = await runClusterCommand(["run", "--nodes", "2", "--tasks", "3", "--workers", "1", "--json"]);
    const humanResult = await runClusterCommand(["run", "--nodes", "2", "--tasks", "3", "--workers", "1"]);
    const report = JSON.parse(jsonResult.lines[0]) as ChaosRunReport;
    expect(
      humanResult.lines.some((l) =>
        l.includes(`submitted=${report.tasksSubmitted} verified=${report.tasksVerified} failed=${report.tasksFailed}`),
      ),
    ).toBe(true);
  }, 20_000);
});
