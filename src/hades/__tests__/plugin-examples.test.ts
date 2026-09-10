import { describe, it, expect } from "vitest";
import { PluginManager } from "../plugins/manager";
import { LocalPluginRegistry, defaultPluginRegistry } from "../plugins/registry";
import { AchievementsPlugin } from "../plugins/examples/achievements";
import { KanbanPlugin } from "../plugins/examples/kanban";
import { BrowserPlugin } from "../plugins/examples/browser";
import { SkillRegistry } from "../../swarm-runtime/skills/skill";

describe("AchievementsPlugin", () => {
  it("unlocks milestones as goals complete", async () => {
    const plugin = new AchievementsPlugin(() => 1);
    const mgr = new PluginManager();
    await mgr.register(plugin);

    await mgr.emit("goal:complete", { objective: "g1", status: "completed" });
    expect(plugin.goalsCompleted).toBe(1);
    expect(plugin.unlocked.map((u) => u.id)).toEqual(["first-goal"]);

    // Aborted goals don't count.
    await mgr.emit("goal:complete", { objective: "g2", status: "aborted" });
    expect(plugin.goalsCompleted).toBe(1);

    for (let i = 0; i < 4; i++) await mgr.emit("goal:complete", { objective: `x${i}`, status: "completed" });
    expect(plugin.unlocked.map((u) => u.id)).toContain("five-goals");
  });
});

describe("KanbanPlugin", () => {
  it("moves a goal card from in-progress to done", async () => {
    const plugin = new KanbanPlugin();
    const mgr = new PluginManager();
    await mgr.register(plugin);

    await mgr.emit("goal:start", { objective: "ship", goalId: "g1" });
    expect(plugin.column("in_progress").map((c) => c.title)).toEqual(["ship"]);

    await mgr.emit("goal:complete", { objective: "ship", goalId: "g1", status: "completed" });
    expect(plugin.column("in_progress")).toHaveLength(0);
    expect(plugin.column("done").map((c) => c.title)).toEqual(["ship"]);
  });

  it("sends a failed goal back to todo", async () => {
    const plugin = new KanbanPlugin();
    const mgr = new PluginManager();
    await mgr.register(plugin);
    await mgr.emit("goal:start", { objective: "risky", goalId: "g2" });
    await mgr.emit("goal:complete", { objective: "risky", goalId: "g2", status: "aborted" });
    expect(plugin.column("todo").map((c) => c.id)).toEqual(["g2"]);
  });
});

describe("BrowserPlugin", () => {
  it("registers a browse skill and tracks browse tool calls", async () => {
    const skills = new SkillRegistry();
    const plugin = new BrowserPlugin();
    const mgr = new PluginManager({ services: { skills } });
    await mgr.register(plugin);

    expect(skills.get("browser")?.capabilities).toEqual(["browse"]);

    await mgr.emit("tool:after", { tool: "browse", output: { url: "https://example.com" }, ok: true });
    await mgr.emit("tool:after", { tool: "search", output: {}, ok: true }); // ignored
    await mgr.emit("tool:after", { tool: "browse", output: { url: "https://fail" }, ok: false }); // ignored (not ok)
    expect(plugin.visited).toEqual(["https://example.com"]);
  });
});

describe("LocalPluginRegistry", () => {
  it("lists catalog metadata without factories", () => {
    const reg = defaultPluginRegistry();
    const names = reg.available().map((m) => m.name).sort();
    expect(names).toEqual(["achievements", "browser", "kanban"]);
    expect(reg.available()[0]).not.toHaveProperty("create");
  });

  it("loads a catalog plugin into a manager", async () => {
    const reg = defaultPluginRegistry();
    const mgr = new PluginManager();
    const plugin = await reg.load("kanban", mgr);
    expect(plugin).toBeInstanceOf(KanbanPlugin);
    expect(mgr.isEnabled("kanban")).toBe(true);
  });

  it("throws loading an unknown plugin, and gives fresh instances", async () => {
    const reg = new LocalPluginRegistry().add({ name: "k", create: () => new KanbanPlugin() });
    const mgr = new PluginManager();
    await expect(reg.load("ghost", mgr)).rejects.toThrow(/Unknown plugin/);
    expect(reg.create("k")).not.toBe(reg.create("k")); // distinct instances
  });
});
