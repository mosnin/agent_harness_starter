import { describe, it, expect } from "vitest";
import { parseVersion, compareVersions, satisfies, validateManifest } from "../modules/manifest";
import type { ModuleManifest } from "../modules/manifest";

describe("version parsing + compare", () => {
  it("parses and rejects", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("x")).toBeNull();
  });
  it("compares", () => {
    expect(compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 1 })).toBe(-1);
    expect(compareVersions({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBe(1);
    expect(compareVersions({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 })).toBe(0);
  });
});

describe("satisfies", () => {
  it("wildcards", () => {
    expect(satisfies("9.9.9", "*")).toBe(true);
    expect(satisfies("1.0.0", "")).toBe(true);
  });
  it("caret — compatible within major", () => {
    expect(satisfies("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfies("1.2.0", "^1.2.0")).toBe(true);
    expect(satisfies("1.1.0", "^1.2.0")).toBe(false); // below floor
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false); // major bump
  });
  it("tilde — same major+minor", () => {
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
  });
  it("comparators", () => {
    expect(satisfies("1.5.0", ">=1.0.0")).toBe(true);
    expect(satisfies("1.0.0", ">1.0.0")).toBe(false);
    expect(satisfies("0.9.0", "<1.0.0")).toBe(true);
  });
  it("exact", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
  });
});

describe("validateManifest", () => {
  const good: ModuleManifest = {
    name: "devops-pack",
    version: "1.0.0",
    kind: "pack",
    dependencies: { "core-skills": "^1.0.0", browser: "*" },
    capabilities: ["deploy"],
  };
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(good)).toEqual({ ok: true, errors: [] });
  });
  it("rejects bad name/version/kind and unparseable ranges", () => {
    const bad = {
      name: "Bad Name",
      version: "1.0",
      kind: "widget",
      dependencies: { x: "^not-a-version" },
    } as unknown as ModuleManifest;
    const res = validateManifest(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("invalid module name"))).toBe(true);
    expect(res.errors.some((e) => e.includes("invalid version"))).toBe(true);
    expect(res.errors.some((e) => e.includes("invalid kind"))).toBe(true);
    expect(res.errors.some((e) => e.includes("unparseable range"))).toBe(true);
  });
});
