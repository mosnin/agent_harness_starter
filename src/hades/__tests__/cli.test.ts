import { describe, it, expect } from "vitest";
import { HadesCli } from "../cli/cli";
import { ModelRegistry } from "../models/registry";
import { InMemoryModelSelection } from "../models/selection";
import { ModelCommand } from "../models/command";
import { defaultPluginRegistry } from "../plugins/registry";
import { builtinSkillPackCatalog } from "../skill-packs/builtin";
import { InMemoryMemoryStore } from "../memory/store";
import { InMemoryTrajectoryStore } from "../research/recorder";
import type { GoalTrajectory } from "../research/recorder";

function fullCli() {
  const registry = new ModelRegistry()
    .register({ id: "opus", provider: "anthropic", displayName: "Opus" }, { default: true })
    .register({ id: "haiku", provider: "anthropic", displayName: "Haiku" });
  const selection = new InMemoryModelSelection();
  const memory = new InMemoryMemoryStore();
  const trajectories = new InMemoryTrajectoryStore();
  return {
    memory,
    selection,
    trajectories,
    cli: new HadesCli({
      version: "9.9.9",
      models: new ModelCommand(registry, selection),
      plugins: defaultPluginRegistry(),
      skillPacks: builtinSkillPackCatalog(),
      memory,
      trajectories,
      onChat: () => ({ code: 0, lines: ["chat started"] }),
    }),
  };
}

describe("HadesCli", () => {
  it("prints version and help", async () => {
    const { cli } = fullCli();
    expect((await cli.run(["version"])).lines[0]).toBe("hades 9.9.9");
    const help = await cli.run([]);
    expect(help.code).toBe(0);
    expect(help.lines.join("\n")).toContain("hades <command>");
  });

  it("routes model subcommands", async () => {
    const { cli, selection } = fullCli();
    const res = await cli.run(["model", "use", "haiku"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Switched to haiku");
    expect(selection.get()).toBe("haiku");
  });

  it("lists plugins and skill packs", async () => {
    const { cli } = fullCli();
    const plugins = await cli.run(["plugins"]);
    expect(plugins.lines.join("\n")).toContain("kanban");
    const packs = await cli.run(["skills", "packs"]);
    expect(packs.lines.join("\n")).toContain("devops");
  });

  it("searches and adds memory", async () => {
    const { cli, memory } = fullCli();
    const add = await cli.run(["memory", "add", "release is on Friday"]);
    expect(add.lines[0]).toContain("Remembered");
    expect(memory.search("release").length).toBe(1);
    const search = await cli.run(["memory", "search", "release"]);
    expect(search.lines.join("\n")).toContain("• release is on Friday");
  });

  it("reports learn stats from the trajectory store", async () => {
    const { cli, trajectories } = fullCli();
    const goal: GoalTrajectory = { goalId: "g", objective: "x", tasks: [], success: true, startedAt: 1 };
    trajectories.add(goal);
    const res = await cli.run(["learn", "stats"]);
    expect(res.lines[0]).toBe("Recorded trajectories: 1");
  });

  it("delegates chat to the injected launcher", async () => {
    const { cli } = fullCli();
    expect((await cli.run(["chat"])).lines).toEqual(["chat started"]);
  });

  it("reports unknown commands and unavailable features", async () => {
    const bare = new HadesCli();
    const unknown = await bare.run(["frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.lines[0]).toContain("Unknown command");

    const noModels = await bare.run(["model", "list"]);
    expect(noModels.code).toBe(1);
    expect(noModels.lines[0]).toContain("not configured");

    const noGateway = await bare.run(["gateway"]);
    expect(noGateway.code).toBe(1);
  });
});
