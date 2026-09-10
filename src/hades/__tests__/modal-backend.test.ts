import { describe, it, expect } from "vitest";
import { ModalBackend } from "../backends/modal";
import type { ModalClient, ModalCallStatus, ModalSpawnInput, ModalCall } from "../backends/modal";
import { RemoteBackendRegistry } from "../backends/backend";
import type { RemoteSpec } from "../backends/backend";

function fakeModal(configured = true): ModalClient & { spawns: ModalSpawnInput[]; cancelled: string[] } {
  const spawns: ModalSpawnInput[] = [];
  const cancelled: string[] = [];
  const status = new Map<string, ModalCallStatus>();
  let n = 0;
  return {
    spawns,
    cancelled,
    async isConfigured() {
      return configured;
    },
    async spawn(input): Promise<ModalCall> {
      spawns.push(input);
      const callId = `call-${++n}`;
      status.set(callId, "running");
      return { callId, url: `https://${callId}.modal.run` };
    },
    async poll(callId): Promise<ModalCallStatus> {
      return status.get(callId) ?? "failed";
    },
    async cancel(callId) {
      cancelled.push(callId);
      status.set(callId, "cancelled");
    },
    async logs(callId) {
      return `logs for ${callId}`;
    },
  };
}

const spec: RemoteSpec = {
  workerId: "w1",
  capabilities: ["research"],
  managerUrl: "http://mgr.local",
  authToken: "secret",
  model: "claude-x",
  limits: { cpus: 2, memory: "2g", timeoutMs: 60000 },
};

describe("ModalBackend", () => {
  it("provisions a call, exposing the endpoint and saving the spec", async () => {
    const client = fakeModal();
    const be = new ModalBackend(client, { app: "hades", function: "run", now: () => 7 });
    const h = await be.provision(spec);

    expect(h.backend).toBe("modal");
    expect(h.nativeId).toBe("call-1");
    expect(h.endpoint).toBe("https://call-1.modal.run");
    expect(h.state).toBe("running");
    expect(client.spawns[0].env.SWARM_WORKER_ID).toBe("w1");
    expect(client.spawns[0].env.SWARM_MODEL).toBe("claude-x");
    expect(client.spawns[0].cpus).toBe(2);
    expect((h.meta as { app: string }).app).toBe("hades");
  });

  it("maps poll status to remote state", async () => {
    const client = fakeModal();
    const be = new ModalBackend(client);
    const h = await be.provision(spec);
    expect(await be.status(h)).toBe("running");
  });

  it("scales to zero on hibernate and re-spawns on wake", async () => {
    const client = fakeModal();
    const be = new ModalBackend(client);
    const h = await be.provision(spec);

    const hib = await be.hibernate(h);
    expect(hib.state).toBe("hibernated");
    expect(hib.endpoint).toBeUndefined();
    expect(client.cancelled).toEqual(["call-1"]);
    expect(await be.status(hib)).toBe("hibernated"); // no poll while hibernated

    const woke = await be.wake(hib);
    expect(woke.state).toBe("running");
    expect(woke.nativeId).toBe("call-2"); // fresh call
    expect(woke.endpoint).toBe("https://call-2.modal.run");
    // Re-spawned with the same saved env.
    expect(client.spawns[1].env.SWARM_WORKER_ID).toBe("w1");
  });

  it("terminate cancels a live call but no-ops when hibernated", async () => {
    const client = fakeModal();
    const be = new ModalBackend(client);
    const h = await be.provision(spec);
    const hib = await be.hibernate(h);
    await be.terminate(hib);
    expect(client.cancelled).toEqual(["call-1"]); // only the hibernate cancel, not a second
  });

  it("reports availability from the client", async () => {
    expect(await new ModalBackend(fakeModal(false)).isAvailable()).toBe(false);
    expect(await new ModalBackend(fakeModal(true)).isAvailable()).toBe(true);
  });

  it("integrates with the registry's hibernate/wake tracking", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new ModalBackend(fakeModal(), { name: "modal" }));
    await reg.provision(spec, "modal");

    await reg.hibernate("w1");
    expect((await reg.status("w1"))).toBe("hibernated");
    const woke = await reg.wake("w1");
    expect(woke?.state).toBe("running");
    expect(reg.handle("w1")?.nativeId).toBe("call-2");
  });
});
