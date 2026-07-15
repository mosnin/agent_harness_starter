import { describe, it, expect } from "vitest";
import { RemoteBackendRegistry } from "../backends/backend";
import { FakeBackend } from "../backends/fake-backend";
import { ScaleToZeroManager } from "../backends/scale-to-zero";
import type { ScaleEvent } from "../backends/scale-to-zero";
import type { RemoteSpec } from "../backends/backend";

function spec(workerId: string): RemoteSpec {
  return { workerId, capabilities: ["x"], managerUrl: "http://m", authToken: "t" };
}

describe("ScaleToZeroManager", () => {
  it("hibernates only workers idle past the threshold", async () => {
    let t = 0;
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "modal", now: () => t }));
    await reg.provision(spec("w1"), "modal");
    await reg.provision(spec("w2"), "modal");

    const mgr = new ScaleToZeroManager(reg, { idleMs: 1000, now: () => t });
    mgr.markActive("w1"); // t=0
    mgr.markActive("w2"); // t=0

    t = 500;
    mgr.markActive("w2"); // keep w2 warm

    t = 1200; // w1 idle 1200ms (>1000), w2 idle 700ms (<1000)
    const hibernated = await mgr.sweep();

    expect(hibernated).toEqual(["w1"]);
    expect(await reg.status("w1")).toBe("hibernated");
    expect(await reg.status("w2")).toBe("running");
  });

  it("wakes a hibernated worker on acquire and marks it active", async () => {
    let t = 0;
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "modal", now: () => t }));
    await reg.provision(spec("w1"), "modal");
    const mgr = new ScaleToZeroManager(reg, { idleMs: 100, now: () => t });
    mgr.markActive("w1");

    t = 1000;
    await mgr.sweep();
    expect(await reg.status("w1")).toBe("hibernated");

    t = 1500;
    const handle = await mgr.acquire("w1");
    expect(handle?.state).toBe("running");
    expect(handle?.endpoint).toContain("fake.local");
    expect(mgr.idleFor("w1")).toBe(0); // marked active at acquire time
  });

  it("skips backends that cannot hibernate (mixed fleet)", async () => {
    let t = 0;
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "ssh", supportsHibernate: false, now: () => t }));
    await reg.provision(spec("w1"), "ssh");

    const events: ScaleEvent[] = [];
    const mgr = new ScaleToZeroManager(reg, { idleMs: 100, now: () => t, onEvent: (e) => events.push(e) });
    mgr.markActive("w1");

    t = 5000;
    const hibernated = await mgr.sweep();
    expect(hibernated).toEqual([]);
    expect(await reg.status("w1")).toBe("running"); // untouched
    expect(events.some((e) => e.type === "skipped" && e.workerId === "w1")).toBe(true);
  });

  it("emits lifecycle events", async () => {
    let t = 0;
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "modal", now: () => t }));
    await reg.provision(spec("w1"), "modal");

    const events: ScaleEvent[] = [];
    const mgr = new ScaleToZeroManager(reg, { idleMs: 100, now: () => t, onEvent: (e) => events.push(e) });
    mgr.markActive("w1");
    t = 1000;
    await mgr.sweep();
    t = 1100;
    await mgr.acquire("w1");

    const types = events.map((e) => e.type);
    expect(types).toContain("active");
    expect(types).toContain("hibernated");
    expect(types).toContain("woken");
  });

  it("returns undefined acquiring an unknown worker", async () => {
    const reg = new RemoteBackendRegistry();
    const mgr = new ScaleToZeroManager(reg);
    expect(await mgr.acquire("ghost")).toBeUndefined();
  });
});
