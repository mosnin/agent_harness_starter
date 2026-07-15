import { describe, it, expect } from "vitest";
import { SkillModuleLoader } from "../modules/loader";
import type { SkillModule, ModuleEvent } from "../modules/loader";

function skillMod(name: string, version: string, deps?: Record<string, string>): SkillModule {
  return {
    manifest: { name, version, kind: "skill", dependencies: deps },
    skill: { name: `${name}-skill`, description: name, capabilities: [name] },
  };
}

describe("SkillModuleLoader", () => {
  it("loads modules and projects them into a live registry", () => {
    const loader = new SkillModuleLoader();
    loader.load(skillMod("browser", "1.0.0"));
    loader.load(skillMod("search", "1.0.0"));
    expect(loader.size()).toBe(2);
    const reg = loader.skillRegistry();
    expect(reg.list().map((s) => s.name).sort()).toEqual(["browser-skill", "search-skill"]);
  });

  it("hot-unloads and reloads, emitting events", () => {
    const events: ModuleEvent[] = [];
    const loader = new SkillModuleLoader({ onEvent: (e) => events.push(e) });
    loader.load(skillMod("x", "1.0.0"));
    loader.reload(skillMod("x", "1.1.0")); // same name → reload
    expect(loader.loaded()[0].version).toBe("1.1.0");

    const res = loader.unload("x");
    expect(res.ok).toBe(true);
    expect(loader.isLoaded("x")).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["load", "reload", "unload"]);
  });

  it("refuses to unload a module others depend on, unless forced", () => {
    const loader = new SkillModuleLoader();
    loader.load(skillMod("core", "1.0.0"));
    loader.load(skillMod("app", "1.0.0", { core: "^1.0.0" }));

    const blocked = loader.unload("core");
    expect(blocked).toEqual({ ok: false, blockedBy: ["app"] });
    expect(loader.isLoaded("core")).toBe(true);

    const forced = loader.unload("core", { force: true });
    expect(forced.ok).toBe(true);
    expect(loader.isLoaded("core")).toBe(false);
  });

  it("loadAll installs in dependency-first order", () => {
    const events: ModuleEvent[] = [];
    const loader = new SkillModuleLoader({ onEvent: (e) => events.push(e) });
    loader.loadAll([
      skillMod("app", "1.0.0", { core: "^1.0.0" }),
      skillMod("core", "1.2.0"),
    ]);
    const order = events.filter((e) => e.type === "load").map((e) => e.name);
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("app"));
  });

  it("rejects an invalid manifest and an unresolvable set", () => {
    const loader = new SkillModuleLoader();
    expect(() => loader.load(skillMod("Bad Name", "1.0.0"))).toThrow(/Invalid module/);
    expect(() => loader.loadAll([skillMod("a", "1.0.0", { missing: "^1.0.0" })])).toThrow(/Cannot load modules/);
  });
});
