import { describe, it, expect } from "vitest";
import { ModuleRegistry } from "../modules/registry";
import type { ModuleManifest } from "../modules/manifest";

function m(name: string, version: string, kind: ModuleManifest["kind"], deps?: Record<string, string>): ModuleManifest {
  return { name, version, kind, dependencies: deps };
}

describe("ModuleRegistry", () => {
  it("catalogs skills and plugins together and counts by kind", () => {
    const reg = new ModuleRegistry().addAll([
      m("browser", "1.0.0", "plugin"),
      m("search", "1.0.0", "skill"),
      m("devops", "1.0.0", "pack"),
    ]);
    expect(reg.counts()).toEqual({ skill: 1, plugin: 1, pack: 1 });
    expect(reg.has("browser")).toBe(true);
  });

  it("keeps multiple versions and reports the latest", () => {
    const reg = new ModuleRegistry().addAll([
      m("lib", "1.0.0", "skill"),
      m("lib", "1.3.0", "skill"),
      m("lib", "1.2.0", "skill"),
    ]);
    expect(reg.find("lib").map((e) => e.version)).toEqual(["1.3.0", "1.2.0", "1.0.0"]);
    expect(reg.latest("lib")?.version).toBe("1.3.0");
  });

  it("rejects duplicate name+version", () => {
    const reg = new ModuleRegistry().add(m("x", "1.0.0", "skill"));
    expect(() => reg.add(m("x", "1.0.0", "skill"))).toThrow(/duplicate module x@1.0.0/);
  });

  it("detects a kind conflict (same name, different kinds)", () => {
    const reg = new ModuleRegistry().addAll([
      m("thing", "1.0.0", "skill"),
      m("thing", "2.0.0", "plugin"),
    ]);
    expect(reg.conflicts()).toEqual(["thing"]);
  });

  it("resolves a cross-kind install set into load order", () => {
    const reg = new ModuleRegistry().addAll([
      m("app", "1.0.0", "plugin", { toolkit: "^1.0.0" }),
      m("toolkit", "1.2.0", "skill"),
    ]);
    const res = reg.resolve(["app"]);
    expect(res.ok).toBe(true);
    expect(res.order.map((e) => e.name)).toEqual(["toolkit", "app"]);
  });

  it("rejects an invalid manifest at add time", () => {
    expect(() => new ModuleRegistry().add(m("Bad Name", "1.0.0", "skill"))).toThrow(/invalid manifest/);
  });
});
