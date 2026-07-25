import { describe, it, expect } from "vitest";
import { HadesCli } from "../cli/cli";
import { ModelRegistry } from "../models/registry";
import { InMemoryModelSelection } from "../models/selection";
import { ModelCommand } from "../models/command";
import { defaultPluginRegistry } from "../plugins/registry";
import { builtinSkillPackCatalog } from "../skill-packs/builtin";
import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";
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

  it("searches and adds memory through the full memory command", async () => {
    const { cli, memory } = fullCli();
    const add = await cli.run(["memory", "add", "release is on Friday"]);
    expect(add.lines[0]).toContain("Remembered");
    expect(memory.search("release").length).toBe(1);
    const search = await cli.run(["memory", "search", "release"]);
    expect(search.code).toBe(0);
    expect(search.lines.join("\n")).toContain("release is on Friday");
  });

  it("memory search reaches recorded sessions through the FTS index", async () => {
    const sessions = new InMemorySessionStore();
    const s = sessions.create({ title: "Zephyr rollout" });
    sessions.append(s.id, { role: "user", content: "how is the zephyr migration going?" });
    const cli = new HadesCli({ memory: new InMemoryMemoryStore(), sessions });

    const search = await cli.run(["memory", "search", "zephyr", "migration"]);
    expect(search.code).toBe(0);
    const out = search.lines.join("\n");
    expect(out).toContain(s.id);
    expect(out).toContain("Zephyr rollout");

    const timeline = await cli.run(["memory", "timeline"]);
    expect(timeline.lines.join("\n")).toContain("Zephyr rollout");

    const show = await cli.run(["memory", "show", s.id]);
    expect(show.lines.join("\n")).toContain("how is the zephyr migration going?");
  });

  it("memory session subcommands degrade honestly with no session store wired", async () => {
    const cli = new HadesCli({ memory: new InMemoryMemoryStore() });
    const timeline = await cli.run(["memory", "timeline"]);
    expect(timeline.code).toBe(0);
    expect(timeline.lines[0]).toBe("No sessions recorded.");
    const summarize = await cli.run(["memory", "summarize", "nope"]);
    expect(summarize.code).toBe(1);
    expect(summarize.lines[0]).toContain("not configured");
  });

  it("reports learn stats from the trajectory store", async () => {
    const { cli, trajectories } = fullCli();
    const goal: GoalTrajectory = { goalId: "g", objective: "x", tasks: [], success: true, startedAt: 1 };
    trajectories.add(goal);
    const res = await cli.run(["learn", "stats"]);
    expect(res.lines[0]).toBe("Recorded trajectories: 1");
  });

  it("routes `skill` authoring vs evolution subcommands to the right surface", async () => {
    const { cli } = fullCli();

    // Authoring path (skills-command): help lists both surfaces.
    const help = await cli.run(["skill", "help"]);
    expect(help.code).toBe(0);
    const helpText = help.lines.join("\n");
    expect(helpText).toContain("new <name>");
    expect(helpText).toContain("synth <trajectory.json>");
    expect(helpText).toContain("trust [--policy-file <p>]");

    // Evolution path (skill-evolve-command): `synth` with no file is that
    // module's usage error, not skills-command's "Unknown skill command".
    const synth = await cli.run(["skill", "synth"]);
    expect(synth.code).toBe(1);
    expect(synth.lines[0]).toBe("Usage: hades skill synth <trajectory.json>");

    const refine = await cli.run(["skill", "refine"]);
    expect(refine.code).toBe(1);
    expect(refine.lines[0]).toBe("Usage: hades skill refine <skill> <use.json>");

    // Top-level help advertises the evolution surface.
    const topHelp = await cli.run(["help"]);
    expect(topHelp.lines.join("\n")).toContain("synth (SKILL.md from a GATE-VERIFIED");
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
