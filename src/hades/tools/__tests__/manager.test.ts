/**
 * Real behavioral tests for ToolsetManager and its two ToolStateStore
 * implementations. JsonFileToolStateStore tests use a real temp
 * directory (node:fs mkdtempSync under the OS tmpdir) and real file
 * I/O — no mocked fs. Nothing here touches the network or the clock.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCatalog, type CatalogEntry } from "../catalog";
import {
  ToolsetManager,
  InMemoryToolStateStore,
  JsonFileToolStateStore,
  type ToolStateStore,
} from "../manager";
import { ToolRegistry, builtinRegistry } from "../../agent/tools";
import type { Tool, ToolResult } from "../../agent/tools";

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    run: (input: string): ToolResult => ({ ok: true, output: input }),
  };
}

function entry(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    tool: overrides.tool ?? makeTool(id),
    category: overrides.category ?? "data",
    mode: overrides.mode ?? "real",
    requiresNetwork: overrides.requiresNetwork ?? false,
    requiredEnvKeys: overrides.requiredEnvKeys ?? [],
    verifierId: overrides.verifierId ?? "default-verifier",
  };
}

function catalogWith(...entries: CatalogEntry[]): ToolCatalog {
  const catalog = new ToolCatalog();
  for (const e of entries) catalog.add(e);
  return catalog;
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hades-toolstate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

describe("InMemoryToolStateStore", () => {
  it("returns undefined before any save", () => {
    const store = new InMemoryToolStateStore();
    expect(store.load()).toBeUndefined();
  });

  it("round-trips saved state", () => {
    const store = new InMemoryToolStateStore();
    store.save({ a: true, b: false });
    expect(store.load()).toEqual({ a: true, b: false });
  });

  it("load() returns a copy, not the live reference", () => {
    const store = new InMemoryToolStateStore();
    store.save({ a: true });
    const loaded = store.load()!;
    loaded.a = false;
    expect(store.load()).toEqual({ a: true });
  });
});

describe("JsonFileToolStateStore", () => {
  it("load() returns undefined when the file does not exist", () => {
    const dir = makeTempDir();
    const store = new JsonFileToolStateStore(join(dir, "state.json"));
    expect(store.load()).toBeUndefined();
  });

  it("save() then load() round-trips through a real file, creating parent dirs", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "nested", "deeper", "state.json");
    const store = new JsonFileToolStateStore(filePath);
    store.save({ calc: true, weather: false });
    expect(existsSync(filePath)).toBe(true);
    expect(store.load()).toEqual({ calc: true, weather: false });

    // A fresh store instance pointed at the same path sees the same state.
    const store2 = new JsonFileToolStateStore(filePath);
    expect(store2.load()).toEqual({ calc: true, weather: false });
  });

  it("save() writes atomically: no leftover tmp file after a successful save", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "state.json");
    const store = new JsonFileToolStateStore(filePath);
    store.save({ a: true });
    const leftovers = readdirSync(dir).filter((f: string) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("load() returns undefined for an empty file", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "state.json");
    writeFileSync(filePath, "", "utf8");
    const store = new JsonFileToolStateStore(filePath);
    expect(store.load()).toBeUndefined();
  });

  it("load() returns undefined for corrupt JSON", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "state.json");
    writeFileSync(filePath, "{not valid json", "utf8");
    const store = new JsonFileToolStateStore(filePath);
    expect(store.load()).toBeUndefined();
  });

  it("load() returns undefined for a JSON array instead of an object", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "state.json");
    writeFileSync(filePath, "[1,2,3]", "utf8");
    const store = new JsonFileToolStateStore(filePath);
    expect(store.load()).toBeUndefined();
  });

  it("load() drops non-boolean values but keeps boolean ones", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "state.json");
    writeFileSync(filePath, JSON.stringify({ a: true, b: "yes", c: 1, d: false }), "utf8");
    const store = new JsonFileToolStateStore(filePath);
    expect(store.load()).toEqual({ a: true, d: false });
  });

  it("save() throws when the parent path is unwritable (regular file, not a dir)", () => {
    const dir = makeTempDir();
    const blockerPath = join(dir, "blocker");
    writeFileSync(blockerPath, "im a file not a directory", "utf8");
    // treat the file as though it were a directory -> mkdir -p must fail
    const filePath = join(blockerPath, "state.json");
    const store = new JsonFileToolStateStore(filePath);
    expect(() => store.save({ a: true })).toThrow();
  });
});

describe("ToolsetManager — enable/disable/isEnabled", () => {
  it("defaults every catalog entry to enabled when defaultEnabled is unset", () => {
    const catalog = catalogWith(entry("a"), entry("b"));
    const manager = new ToolsetManager(catalog);
    expect(manager.isEnabled("a")).toBe(true);
    expect(manager.isEnabled("b")).toBe(true);
  });

  it("honors defaultEnabled: false for entries with no persisted state", () => {
    const catalog = catalogWith(entry("a"));
    const manager = new ToolsetManager(catalog, undefined, { defaultEnabled: false });
    expect(manager.isEnabled("a")).toBe(false);
  });

  it("isEnabled() returns false for an id not in the catalog", () => {
    const catalog = catalogWith(entry("a"));
    const manager = new ToolsetManager(catalog);
    expect(manager.isEnabled("ghost")).toBe(false);
  });

  it("disable() then isEnabled() reflects the change immediately", () => {
    const catalog = catalogWith(entry("a"));
    const manager = new ToolsetManager(catalog);
    expect(manager.disable("a")).toBe(true);
    expect(manager.isEnabled("a")).toBe(false);
    expect(manager.enable("a")).toBe(true);
    expect(manager.isEnabled("a")).toBe(true);
  });

  it("enable()/disable() on an unknown id returns false and does not corrupt state", () => {
    const catalog = catalogWith(entry("a"));
    const store = new InMemoryToolStateStore();
    const manager = new ToolsetManager(catalog, store);
    expect(manager.enable("ghost")).toBe(false);
    expect(manager.disable("ghost")).toBe(false);
    expect(manager.isEnabled("a")).toBe(true);
    // no persisted write should have happened for the unknown id
    expect(store.load()).toBeUndefined();
  });

  it("persists every enable/disable through the store immediately", () => {
    const catalog = catalogWith(entry("a"), entry("b"));
    const store = new InMemoryToolStateStore();
    const manager = new ToolsetManager(catalog, store);
    manager.disable("a");
    expect(store.load()).toEqual({ a: false });
    manager.enable("b");
    expect(store.load()).toEqual({ a: false, b: true });
  });
});

describe("ToolsetManager — persisted state round-trip (real fs)", () => {
  it("round-trips enable/disable decisions across a fresh manager pointed at the same file", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "toolstate.json");
    const catalog = catalogWith(entry("a"), entry("b"), entry("c"));

    const manager1 = new ToolsetManager(catalog, new JsonFileToolStateStore(filePath));
    manager1.disable("a");
    manager1.disable("b");
    manager1.enable("c");

    const catalog2 = catalogWith(entry("a"), entry("b"), entry("c"));
    const manager2 = new ToolsetManager(catalog2, new JsonFileToolStateStore(filePath));
    expect(manager2.isEnabled("a")).toBe(false);
    expect(manager2.isEnabled("b")).toBe(false);
    expect(manager2.isEnabled("c")).toBe(true);
  });

  it("stale keys from a shrunk catalog are preserved in the persisted file and reappear if the catalog regrows", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "toolstate.json");

    const fullCatalog = catalogWith(entry("a"), entry("b"), entry("stale"));
    const manager1 = new ToolsetManager(fullCatalog, new JsonFileToolStateStore(filePath));
    manager1.disable("stale");
    manager1.disable("a");

    // Catalog shrinks: "stale" is gone from this build.
    const shrunkCatalog = catalogWith(entry("a"), entry("b"));
    const manager2 = new ToolsetManager(shrunkCatalog, new JsonFileToolStateStore(filePath));
    expect(manager2.status().map((s) => s.id)).toEqual(["a", "b"]);
    expect(manager2.isEnabled("stale")).toBe(false); // not in catalog -> always false
    // touch the store so it re-persists (still carrying the stale key forward)
    manager2.enable("b");
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.stale).toBe(false); // preserved, not pruned

    // Catalog regrows: "stale" comes back and picks up its old preference.
    const regrownCatalog = catalogWith(entry("a"), entry("b"), entry("stale"));
    const manager3 = new ToolsetManager(regrownCatalog, new JsonFileToolStateStore(filePath));
    expect(manager3.isEnabled("stale")).toBe(false);
  });
});

describe("ToolsetManager — save() failure resilience", () => {
  class ThrowingStore implements ToolStateStore {
    load(): Record<string, boolean> | undefined {
      return undefined;
    }
    save(): void {
      throw new Error("disk full");
    }
  }

  it("enable() does not throw when the store's save() throws, and memory state stays consistent", () => {
    const catalog = catalogWith(entry("a"));
    const manager = new ToolsetManager(catalog, new ThrowingStore());
    expect(() => manager.enable("a")).not.toThrow();
    expect(manager.isEnabled("a")).toBe(true);
    expect(manager.getLastSaveError()).toMatch(/disk full/);
  });

  it("disable() does not throw when the store's save() throws, and memory state stays consistent", () => {
    const catalog = catalogWith(entry("a"));
    const manager = new ToolsetManager(catalog, new ThrowingStore());
    expect(() => manager.disable("a")).not.toThrow();
    expect(manager.isEnabled("a")).toBe(false);
    expect(manager.getLastSaveError()).toMatch(/disk full/);
  });
});

describe("ToolsetManager.status()", () => {
  it("reports full metadata per catalog entry, catalog-sorted", () => {
    const catalog = catalogWith(
      entry("zeta", { category: "web", mode: "mock", requiresNetwork: true, requiredEnvKeys: ["ZETA_KEY"], verifierId: "v-zeta" }),
      entry("alpha", { category: "system", mode: "real", verifierId: "v-alpha" })
    );
    const manager = new ToolsetManager(catalog);
    manager.disable("zeta");
    const status = manager.status();
    expect(status.map((s) => s.id)).toEqual(["alpha", "zeta"]);
    const zeta = status.find((s) => s.id === "zeta")!;
    expect(zeta).toMatchObject({
      category: "web",
      mode: "mock",
      enabled: false,
      requiresNetwork: true,
      requiredEnvKeys: ["ZETA_KEY"],
      verifierId: "v-zeta",
    });
    expect(zeta.description).toContain("zeta");
  });

  it("mode reported is exactly the mode the entry was constructed with — manager never changes it", () => {
    const catalog = catalogWith(entry("m", { mode: "mock" }));
    const manager = new ToolsetManager(catalog);
    manager.enable("m");
    manager.disable("m");
    expect(manager.status()[0].mode).toBe("mock");
  });
});

describe("ToolsetManager.buildRegistry", () => {
  it("starts from builtinRegistry() by default and adds enabled catalog entries", () => {
    const catalog = catalogWith(entry("weather"));
    const manager = new ToolsetManager(catalog);
    const registry = manager.buildRegistry();
    expect(registry.get("weather")).toBeDefined();
    expect(registry.get("calc")).toBeDefined(); // builtin still present
  });

  it("registers only enabled entries, skipping disabled ones", () => {
    const catalog = catalogWith(entry("weather"), entry("stocks"));
    const manager = new ToolsetManager(catalog);
    manager.disable("stocks");
    const registry = manager.buildRegistry();
    expect(registry.get("weather")).toBeDefined();
    expect(registry.get("stocks")).toBeUndefined();
  });

  it("accepts a custom base registry instead of builtinRegistry()", () => {
    const base = new ToolRegistry();
    base.register(makeTool("custom_base_tool"));
    const catalog = catalogWith(entry("weather"));
    const manager = new ToolsetManager(catalog);
    const registry = manager.buildRegistry(base);
    expect(registry.get("custom_base_tool")).toBeDefined();
    expect(registry.get("weather")).toBeDefined();
    expect(registry.get("calc")).toBeUndefined(); // base wasn't builtinRegistry()
  });

  it("throws rather than silently shadowing a builtin tool of the same name", () => {
    const catalog = catalogWith(entry("calc")); // collides with the real builtin `calc`
    const manager = new ToolsetManager(catalog);
    expect(() => manager.buildRegistry()).toThrow(/shadow/i);
  });

  it("throws on collision against a custom base registry too", () => {
    const base = new ToolRegistry();
    base.register(makeTool("dup"));
    const catalog = catalogWith(entry("dup"));
    const manager = new ToolsetManager(catalog);
    expect(() => manager.buildRegistry(base)).toThrow(/shadow/i);
  });

  it("mutates and returns the same base registry instance it was given", () => {
    const base = new ToolRegistry();
    const catalog = catalogWith(entry("weather"));
    const manager = new ToolsetManager(catalog);
    const result = manager.buildRegistry(base);
    expect(result).toBe(base);
  });

  it("does not throw when a disabled entry would have collided (never gets registered)", () => {
    const catalog = catalogWith(entry("calc"));
    const manager = new ToolsetManager(catalog);
    manager.disable("calc");
    expect(() => manager.buildRegistry()).not.toThrow();
  });
});
