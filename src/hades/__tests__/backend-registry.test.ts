import { describe, it, expect } from "vitest";
import { RemoteBackendRegistry } from "../backends/backend";
import { FakeBackend } from "../backends/fake-backend";
import type { RemoteSpec } from "../backends/backend";

const spec: RemoteSpec = {
  workerId: "w1",
  capabilities: ["search", "code"],
  managerUrl: "http://mgr.local",
  authToken: "secret",
};

describe("RemoteBackendRegistry", () => {
  it("provisions on a named backend and tracks the handle", async () => {
    const reg = new RemoteBackendRegistry();
    const modal = new FakeBackend({ name: "modal" });
    reg.register(modal);

    const { backend, handle } = await reg.provision(spec, "modal");
    expect(backend).toBe("modal");
    expect(handle.state).toBe("running");
    expect(handle.endpoint).toContain("fake.local");
    expect(reg.handle("w1")?.nativeId).toBe(handle.nativeId);
    expect(reg.list()).toHaveLength(1);
    expect(modal.events).toContain("provision:w1");
  });

  it("falls back to the first available backend when none named", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "down", available: false }));
    reg.register(new FakeBackend({ name: "up", available: true }));

    const { backend } = await reg.provision(spec);
    expect(backend).toBe("up");
  });

  it("throws for an unknown backend and when a named backend is unavailable", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "off", available: false }));

    await expect(reg.provision(spec, "nope")).rejects.toThrow(/Unknown backend/);
    await expect(reg.provision(spec, "off")).rejects.toThrow(/not available/);
  });

  it("hibernates and wakes a serverless backend, updating the tracked handle", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "modal" }));
    await reg.provision(spec, "modal");

    const hib = await reg.hibernate("w1");
    expect(hib?.state).toBe("hibernated");
    expect(hib?.endpoint).toBeUndefined();
    expect(await reg.status("w1")).toBe("hibernated");

    const woke = await reg.wake("w1");
    expect(woke?.state).toBe("running");
    expect(woke?.endpoint).toContain("fake.local");
    expect(await reg.status("w1")).toBe("running");
  });

  it("rejects hibernate on a backend that does not support it", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new FakeBackend({ name: "ssh", supportsHibernate: false }));
    await reg.provision(spec, "ssh");
    await expect(reg.hibernate("w1")).rejects.toThrow(/does not support hibernate/);
  });

  it("terminates and stops tracking", async () => {
    const reg = new RemoteBackendRegistry();
    const b = new FakeBackend({ name: "modal" });
    reg.register(b);
    await reg.provision(spec, "modal");

    await reg.terminate("w1");
    expect(reg.handle("w1")).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
    expect(b.events).toContain("terminate:w1");
  });
});
