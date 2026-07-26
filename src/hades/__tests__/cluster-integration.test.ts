/**
 * Central-integration audit for the multi-node (`cluster`) layer.
 *
 * The distributed modules under `src/swarm-runtime/distributed/**` shipped
 * across several cycles WITHOUT being reachable from any surface — they were
 * dead code that type-checked and tested green. This suite exists so that can
 * never silently happen again: it asserts the capability is actually reachable
 * from the CLI, from the library barrels, from the TUI barrel, and from
 * `package.json`'s scripts, and that a `hades cluster` invocation really
 * dispatches into the real command module.
 *
 * A barrel assertion is not ceremony here: TypeScript SILENTLY DROPS a name
 * from an `export *` when two re-export sources disagree on it, so a name
 * collision introduced upstream would remove the whole cluster surface from
 * `@agent-harness/core/swarm-runtime` while still compiling clean. Only a
 * runtime read catches that.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HadesCli, HADES_SUBCOMMANDS } from "../cli/cli";
import { runClusterCommand, CLUSTER_USAGE } from "../cli/index";
import * as swarmRuntime from "../../swarm-runtime/index";
import * as tui from "../../swarm-runtime/tui/index";
import * as distributed from "../../swarm-runtime/distributed/index";

describe("hades cluster is routed by the real CLI", () => {
  it("is a declared subcommand", () => {
    expect((HADES_SUBCOMMANDS as readonly string[]).includes("cluster")).toBe(true);
  });

  it("`hades cluster help` dispatches into the real command module (exit 0 + its usage)", async () => {
    const cli = new HadesCli();
    const res = await cli.run(["cluster", "help"]);
    expect(res.code).toBe(0);
    expect(res.lines[0]).toBe("Usage: hades cluster <command> [options]");
    expect(res.lines).toEqual([...CLUSTER_USAGE]);
  });

  it("`hades cluster` with no subcommand shows usage rather than erroring", async () => {
    const res = await new HadesCli().run(["cluster"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Usage: hades cluster");
  });

  it("an unknown cluster subcommand is a usage error (exit 2), not a silent success", async () => {
    const res = await new HadesCli().run(["cluster", "nope"]);
    expect(res.code).toBe(2);
    expect(res.lines[0]).toContain("Unknown cluster command: nope");
  });

  it("an unknown flag is a usage error (exit 2) and never reaches the fabric builder", async () => {
    const res = await runClusterCommand(["status", "--wat"]);
    expect(res.code).toBe(2);
    expect(res.lines[0]).toContain("unknown flag: --wat");
  });

  it("`hades cluster run` refuses without its required flags rather than guessing a size", async () => {
    const noNodes = await runClusterCommand(["run", "--tasks", "2"]);
    expect(noNodes.code).toBe(2);
    expect(noNodes.lines[0]).toContain("--nodes is required");

    const noTasks = await runClusterCommand(["run", "--nodes", "2"]);
    expect(noTasks.code).toBe(2);
    expect(noTasks.lines[0]).toContain("--tasks is required");
  });

  it("`cluster autoscale` REFUSES when no fleet is configured, instead of planning against an invented backend list", async () => {
    const res = await runClusterCommand(["autoscale", "--pending", "8"]);
    expect(res.code).toBe(1);
    expect(res.lines.join("\n")).toContain("remote-compute fleet is not configured");
    expect(res.lines.join("\n")).toContain("refuses to plan against a fiction");
  });

  it("`cluster autoscale` plans against the REAL registered backends and provisions nothing", async () => {
    const { BackendManager } = await import("../backends/manager");
    const { LocalProcessBackend } = await import("../backends/local");
    const manager = new BackendManager();
    manager.register(new LocalProcessBackend({ name: "local" }), {
      name: "local",
      kind: "local",
      capabilities: ["general"],
      cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
      supportsHibernate: true,
      locality: "local",
    });
    const before = manager.registry.list().length;

    const res = await runClusterCommand(
      ["autoscale", "--pending", "8", "--nodes", "2", "--workers", "2", "--min", "0", "--max", "4", "--json"],
      { backends: () => ({ registry: manager.registry, descriptors: manager.descriptors() }), now: () => 1_700_000_000_000 },
    );
    expect(res.code).toBe(0);

    const plan = JSON.parse(res.lines.join("\n")) as {
      mode: string;
      dryRun: boolean;
      backends: string[];
      decisions: Array<{ nodeId: string; from: number; to: number; reason: string; backendName?: string }>;
    };
    // It is a PLAN, and it says so — never labelled "measured".
    expect(plan.mode).toBe("plan");
    expect(plan.dryRun).toBe(true);
    expect(plan.backends).toEqual(["local"]);
    expect(plan.decisions.map((d) => d.nodeId)).toEqual(["node-0", "node-1"]);
    // Real demand really drives it: 8 queued items must produce scale-up.
    expect(plan.decisions.some((d) => d.to > d.from)).toBe(true);
    // And it names the backend it actually scored, not a hardcoded default.
    expect(plan.decisions.filter((d) => d.to > d.from).every((d) => d.backendName === "local")).toBe(true);

    // NOTHING was provisioned: the registry is untouched.
    expect(manager.registry.list().length).toBe(before);
  });

  it("`cluster autoscale` rejects a --max below --min rather than silently reordering them", async () => {
    const res = await runClusterCommand(["autoscale", "--min", "5", "--max", "2"], {
      backends: () => ({ registry: { list: () => [] } as never, descriptors: [] }),
    });
    expect(res.code).toBe(2);
    expect(res.lines[0]).toContain("--max (2) must be >= --min (5)");
  });

  it("is listed in `hades help`, and the listing says the numbers are measured", async () => {
    const res = await new HadesCli().run(["help"]);
    const text = res.lines.join("\n");
    expect(text).toContain("cluster <sub>");
    expect(text).toContain("status/nodes/run/bench/chaos");
    // The help must not promise anything the layer does not do.
    expect(text).toContain("actually execute");
  });
});

describe("the distributed layer is exported from the real barrels", () => {
  const required = [
    // membership + leases (the primitives)
    "ClusterMembership",
    "electLeader",
    "LeaseLedger",
    "VerifiedResultLedger",
    // the wire
    "FederationLink",
    "FederationRouter",
    "pairedWires",
    "localIdentity",
    "pinnedTrust",
    // the node + the leader's brain
    "ClusterNode",
    "LeasedTaskPlanner",
    "ClusterCoordinator",
    "costAwarePlacement",
    // scaling + the measured harness
    "ClusterAutoscaler",
    "buildClusterFabric",
    "chaosPlan",
    "runClusterChaos",
    "runClusterBench",
    "formatClusterBench",
  ] as const;

  it("the distributed barrel exposes the whole surface", () => {
    for (const name of required) {
      expect(distributed, `distributed/index.ts must export ${name}`).toHaveProperty(name);
      expect(typeof (distributed as Record<string, unknown>)[name]).not.toBe("undefined");
    }
  });

  it("the swarm-runtime barrel re-exports it — no name collision silently dropped it", () => {
    for (const name of required) {
      expect(swarmRuntime, `swarm-runtime/index.ts must re-export ${name}`).toHaveProperty(name);
    }
    // And the re-export is the SAME binding, not a shadowing duplicate.
    expect((swarmRuntime as Record<string, unknown>).ClusterCoordinator).toBe(distributed.ClusterCoordinator);
    expect((swarmRuntime as Record<string, unknown>).buildClusterFabric).toBe(distributed.buildClusterFabric);
  });

  it("the TUI barrel exposes the CLUSTER pane", () => {
    for (const name of ["initClusterPane", "clusterPaneKey", "renderClusterPane", "nodeNote", "leaderCell"]) {
      expect(tui, `tui/index.ts must export ${name}`).toHaveProperty(name);
    }
    expect(tui.CLUSTER_PANE_DEFAULT_WIDTH).toBe(72);
  });
});

describe("package.json exposes the cluster scripts", () => {
  it("has one script per reachable subcommand, all pointing at the real bin", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["cluster", "cluster:status", "cluster:nodes", "cluster:run", "cluster:bench", "cluster:chaos"]) {
      expect(pkg.scripts[name], `package.json must define the ${name} script`).toBeTruthy();
      expect(pkg.scripts[name]).toContain("src/hades/bin/hades.ts cluster");
    }
  });
});
