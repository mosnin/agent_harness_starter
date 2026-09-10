import { describe, it, expect } from "vitest";
import { resolveModules } from "../modules/resolver";
import type { ModuleManifest } from "../modules/manifest";

function mod(name: string, version: string, deps?: Record<string, string>): ModuleManifest {
  return { name, version, kind: "skill", dependencies: deps };
}

describe("resolveModules", () => {
  it("orders dependencies before dependents", () => {
    const available = [
      mod("app", "1.0.0", { core: "^1.0.0", ui: "^2.0.0" }),
      mod("ui", "2.1.0", { core: "^1.0.0" }),
      mod("core", "1.4.0"),
    ];
    const res = resolveModules(available, ["app"]);
    expect(res.ok).toBe(true);
    const names = res.order.map((m) => m.name);
    expect(names.indexOf("core")).toBeLessThan(names.indexOf("ui"));
    expect(names.indexOf("ui")).toBeLessThan(names.indexOf("app"));
  });

  it("picks the highest version satisfying all constraints", () => {
    const available = [
      mod("root", "1.0.0", { lib: ">=1.2.0" }),
      mod("lib", "1.1.0"),
      mod("lib", "1.3.0"),
      mod("lib", "1.5.0"),
    ];
    const res = resolveModules(available, ["root"]);
    expect(res.ok).toBe(true);
    expect(res.order.find((m) => m.name === "lib")?.version).toBe("1.5.0");
  });

  it("reports a missing dependency", () => {
    const res = resolveModules([mod("a", "1.0.0", { ghost: "^1.0.0" })], ["a"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("missing module: ghost"))).toBe(true);
  });

  it("reports an unsatisfiable version conflict", () => {
    const available = [
      mod("a", "1.0.0", { shared: "^1.0.0" }),
      mod("b", "1.0.0", { shared: "^2.0.0" }),
      mod("shared", "1.5.0"),
      mod("shared", "2.1.0"),
      mod("root", "1.0.0", { a: "*", b: "*" }),
    ];
    const res = resolveModules(available, ["root"]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("version conflict for shared"))).toBe(true);
  });

  it("detects a dependency cycle", () => {
    const available = [mod("a", "1.0.0", { b: "*" }), mod("b", "1.0.0", { a: "*" })];
    const res = resolveModules(available, ["a"]);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("dependency cycle");
  });

  it("resolves multiple roots sharing a dep once", () => {
    const available = [
      mod("x", "1.0.0", { core: "^1.0.0" }),
      mod("y", "1.0.0", { core: "^1.0.0" }),
      mod("core", "1.2.0"),
    ];
    const res = resolveModules(available, ["x", "y"]);
    expect(res.ok).toBe(true);
    expect(res.order.filter((m) => m.name === "core")).toHaveLength(1);
  });
});
