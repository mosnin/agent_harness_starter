import { describe, it, expect } from "vitest";
import { PluginPackageLoader } from "../modules/plugin-package";
import type { PluginPackage } from "../modules/plugin-package";
import { PluginManager } from "../plugins/manager";
import type { HadesPlugin } from "../plugins/plugin";

function pkg(name: string, permissions?: string[], deps?: Record<string, string>): PluginPackage {
  const plugin: HadesPlugin = { name, register: () => {} };
  return {
    manifest: { name, version: "1.0.0", kind: "plugin", permissions, dependencies: deps },
    create: () => plugin,
  };
}

describe("PluginPackageLoader", () => {
  it("installs a permission-free package", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr);
    const res = await loader.install(pkg("kanban"));
    expect(res.ok).toBe(true);
    expect(mgr.isEnabled("kanban")).toBe(true);
    expect(loader.isInstalled("kanban")).toBe(true);
  });

  it("denies a package requesting an ungranted permission (deny-by-default)", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr);
    const res = await loader.install(pkg("net-plugin", ["net", "fs:write"]));
    expect(res.ok).toBe(false);
    expect(res.denied).toEqual(["net", "fs:write"]);
    expect(mgr.get("net-plugin")).toBeUndefined(); // never registered
  });

  it("installs when the requested permissions are allowed", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr, { allowedPermissions: ["net"] });
    const res = await loader.install(pkg("net-plugin", ["net"]));
    expect(res.ok).toBe(true);
    expect(mgr.isEnabled("net-plugin")).toBe(true);
  });

  it("supports a custom grant function", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr, {
      grant: (perm, manifest) => manifest.name === "trusted" || perm === "read",
    });
    expect((await loader.install(pkg("trusted", ["net", "spawn"]))).ok).toBe(true);
    expect((await loader.install(pkg("other", ["read"]))).ok).toBe(true);
    expect((await loader.install(pkg("other2", ["spawn"]))).ok).toBe(false);
  });

  it("rejects a non-plugin manifest", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr);
    const skillPkg = pkg("s");
    skillPkg.manifest.kind = "skill";
    const res = await loader.install(skillPkg);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not a plugin package");
  });

  it("installAll resolves dependency order", async () => {
    const mgr = new PluginManager();
    const loader = new PluginPackageLoader(mgr);
    const results = await loader.installAll([pkg("app", undefined, { core: "^1.0.0" }), pkg("core")]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(loader.list().map((m) => m.name)).toContain("app");
  });
});
