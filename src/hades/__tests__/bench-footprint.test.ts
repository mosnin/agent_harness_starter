import { describe, it, expect } from "vitest";
import { Lazy, LazyModuleRegistry, footprintReport } from "../bench/footprint";

describe("Lazy", () => {
  it("builds at most once, on first access", () => {
    let builds = 0;
    const lazy = new Lazy(() => {
      builds++;
      return { n: 42 };
    });
    expect(lazy.loaded).toBe(false);
    expect(lazy.get().n).toBe(42);
    expect(lazy.get().n).toBe(42);
    expect(builds).toBe(1);
    expect(lazy.loaded).toBe(true);
  });
});

describe("LazyModuleRegistry", () => {
  it("registers factories without instantiating them", () => {
    let built = 0;
    const reg = new LazyModuleRegistry<{ id: string }>();
    for (let i = 0; i < 100; i++) {
      reg.register(`m${i}`, () => {
        built++;
        return { id: `m${i}` };
      });
    }
    // Registering 100 modules built nothing.
    expect(reg.size()).toBe(100);
    expect(reg.instantiatedCount()).toBe(0);
    expect(built).toBe(0);

    // Using two builds only those two.
    expect(reg.get("m5")?.id).toBe("m5");
    reg.get("m5"); // cached — no rebuild
    expect(reg.get("m42")?.id).toBe("m42");
    expect(built).toBe(2);
    expect(reg.instantiatedCount()).toBe(2);
  });

  it("evicts an instantiated module while keeping its factory", () => {
    const reg = new LazyModuleRegistry<number>().register("x", () => 1);
    reg.get("x");
    expect(reg.isInstantiated("x")).toBe(true);
    expect(reg.evict("x")).toBe(true);
    expect(reg.isInstantiated("x")).toBe(false);
    expect(reg.has("x")).toBe(true); // still registered
  });

  it("footprintReport quantifies the lightweight win", () => {
    const reg = new LazyModuleRegistry<number>();
    for (let i = 0; i < 10; i++) reg.register(`m${i}`, () => i);
    reg.get("m0");
    reg.get("m1");
    const report = footprintReport(reg);
    expect(report).toMatchObject({ registered: 10, instantiated: 2, ratio: 0.2 });
    expect(report.lazyNames).toHaveLength(8);
  });
});
