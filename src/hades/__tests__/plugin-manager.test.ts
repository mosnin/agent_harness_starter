import { describe, it, expect } from "vitest";
import { PluginManager } from "../plugins/manager";
import type { HadesPlugin } from "../plugins/plugin";
import { SkillRegistry } from "../../swarm-runtime/skills/skill";
import { ModelRegistry } from "../models/registry";

describe("PluginManager", () => {
  it("registers a plugin, wires hooks, and dispatches them", async () => {
    const seen: string[] = [];
    const plugin: HadesPlugin = {
      name: "counter",
      register(ctx) {
        ctx.on("goal:start", (p) => void seen.push(`start:${p.objective}`));
        ctx.on("goal:complete", (p) => void seen.push(`done:${p.status}`));
      },
    };
    const mgr = new PluginManager();
    await mgr.register(plugin);

    await mgr.emit("goal:start", { objective: "build" });
    await mgr.emit("goal:complete", { objective: "build", status: "completed" });

    expect(seen).toEqual(["start:build", "done:completed"]);
    expect(mgr.list()).toEqual([{ name: "counter", version: undefined, enabled: true, description: undefined }]);
  });

  it("lets a plugin extend host services (skills, models)", async () => {
    const skills = new SkillRegistry();
    const models = new ModelRegistry();
    const mgr = new PluginManager({ services: { skills, models } });

    const plugin: HadesPlugin = {
      name: "devops",
      register(ctx) {
        expect(ctx.addSkill({ name: "deploy", description: "ship it", capabilities: ["deploy"] })).toBe(true);
        expect(ctx.addModel({ id: "m1", provider: "p", displayName: "M1" })).toBe(true);
      },
    };
    await mgr.register(plugin);
    expect(skills.get("deploy")?.name).toBe("deploy");
    expect(models.get("m1")?.id).toBe("m1");
  });

  it("addSkill returns false when no SkillRegistry is wired", async () => {
    const mgr = new PluginManager();
    let result: boolean | undefined;
    await mgr.register({
      name: "p",
      register(ctx) {
        result = ctx.addSkill({ name: "x", description: "x", capabilities: [] });
      },
    });
    expect(result).toBe(false);
  });

  it("stops dispatching to a disabled plugin and resumes on enable", async () => {
    const seen: string[] = [];
    const mgr = new PluginManager();
    await mgr.register({
      name: "p",
      register(ctx) {
        ctx.on("message:inbound", (m) => void seen.push(m.text));
      },
    });

    await mgr.emit("message:inbound", { platform: "cli", user: "u", text: "a" });
    await mgr.disable("p");
    await mgr.emit("message:inbound", { platform: "cli", user: "u", text: "b" });
    await mgr.enable("p");
    await mgr.emit("message:inbound", { platform: "cli", user: "u", text: "c" });

    expect(seen).toEqual(["a", "c"]);
  });

  it("runs onEnable/onDisable lifecycle hooks", async () => {
    const events: string[] = [];
    const mgr = new PluginManager();
    await mgr.register({
      name: "p",
      register: () => void events.push("register"),
      onEnable: () => void events.push("enable"),
      onDisable: () => void events.push("disable"),
    });
    await mgr.disable("p");
    await mgr.enable("p");
    expect(events).toEqual(["register", "enable", "disable", "enable"]);
  });

  it("rejects duplicate names and missing dependencies", async () => {
    const mgr = new PluginManager();
    await mgr.register({ name: "a", register: () => {} });
    await expect(mgr.register({ name: "a", register: () => {} })).rejects.toThrow(/already registered/);
    await expect(
      mgr.register({ name: "b", dependencies: ["ghost"], register: () => {} })
    ).rejects.toThrow(/missing dependency/);
  });

  it("isolates a throwing hook listener so others still run", async () => {
    const logs: string[] = [];
    const seen: string[] = [];
    const mgr = new PluginManager({ logger: (l) => logs.push(l) });
    await mgr.register({
      name: "bad",
      register(ctx) {
        ctx.on("goal:start", () => {
          throw new Error("kaboom");
        });
      },
    });
    await mgr.register({
      name: "good",
      register(ctx) {
        ctx.on("goal:start", (p) => void seen.push(p.objective));
      },
    });
    await mgr.emit("goal:start", { objective: "x" });
    expect(seen).toEqual(["x"]); // good plugin still ran
    expect(logs.some((l) => l.includes("kaboom"))).toBe(true);
  });
});
