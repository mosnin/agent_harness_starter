import { describe, it, expect } from "vitest";
import { DaytonaBackend } from "../backends/daytona";
import type { DaytonaClient, DaytonaState, DaytonaWorkspace, DaytonaCreateInput } from "../backends/daytona";
import { RemoteBackendRegistry } from "../backends/backend";
import type { RemoteSpec } from "../backends/backend";

function fakeDaytona(configured = true): DaytonaClient & {
  creates: DaytonaCreateInput[];
  deleted: string[];
} {
  const creates: DaytonaCreateInput[] = [];
  const deleted: string[] = [];
  const state = new Map<string, DaytonaState>();
  let n = 0;
  return {
    creates,
    deleted,
    async isConfigured() {
      return configured;
    },
    async createWorkspace(input): Promise<DaytonaWorkspace> {
      creates.push(input);
      const workspaceId = `ws-${++n}`;
      state.set(workspaceId, "started");
      return { workspaceId, url: `https://${workspaceId}.daytona.dev` };
    },
    async startWorkspace(id): Promise<DaytonaWorkspace> {
      state.set(id, "started");
      return { workspaceId: id, url: `https://${id}.daytona.dev` };
    },
    async stopWorkspace(id) {
      state.set(id, "stopped");
    },
    async deleteWorkspace(id) {
      deleted.push(id);
      state.set(id, "deleted");
    },
    async getState(id): Promise<DaytonaState> {
      return state.get(id) ?? "error";
    },
    async logs(id) {
      return `logs ${id}`;
    },
  };
}

const spec: RemoteSpec = {
  workerId: "w1",
  capabilities: ["code"],
  managerUrl: "http://mgr.local",
  authToken: "secret",
};

describe("DaytonaBackend", () => {
  it("provisions a workspace with the worker env", async () => {
    const client = fakeDaytona();
    const be = new DaytonaBackend(client, { image: "hades:latest", now: () => 3 });
    const h = await be.provision(spec);

    expect(h.backend).toBe("daytona");
    expect(h.nativeId).toBe("ws-1");
    expect(h.endpoint).toBe("https://ws-1.daytona.dev");
    expect(h.state).toBe("running");
    expect(client.creates[0].image).toBe("hades:latest");
    expect(client.creates[0].env.SWARM_WORKER_ID).toBe("w1");
  });

  it("preserves the workspace id across hibernate/wake (persistence)", async () => {
    const client = fakeDaytona();
    const be = new DaytonaBackend(client);
    const h = await be.provision(spec);

    const hib = await be.hibernate(h);
    expect(hib.state).toBe("hibernated");
    expect(hib.endpoint).toBeUndefined();
    expect(await be.status(hib)).toBe("hibernated"); // stopped maps to hibernated

    const woke = await be.wake(hib);
    expect(woke.state).toBe("running");
    expect(woke.nativeId).toBe("ws-1"); // SAME workspace — disk preserved
    expect(woke.endpoint).toBe("https://ws-1.daytona.dev");
    // No new workspace was created on wake.
    expect(client.creates).toHaveLength(1);
  });

  it("terminate destroys the workspace volume", async () => {
    const client = fakeDaytona();
    const be = new DaytonaBackend(client);
    const h = await be.provision(spec);
    await be.terminate(h);
    expect(client.deleted).toEqual(["ws-1"]);
    expect(await be.status(h)).toBe("stopped"); // deleted maps to stopped
  });

  it("maps availability from the client", async () => {
    expect(await new DaytonaBackend(fakeDaytona(false)).isAvailable()).toBe(false);
    expect(await new DaytonaBackend(fakeDaytona(true)).isAvailable()).toBe(true);
  });

  it("works through the registry", async () => {
    const reg = new RemoteBackendRegistry();
    reg.register(new DaytonaBackend(fakeDaytona(), { name: "daytona" }));
    await reg.provision(spec, "daytona");
    await reg.hibernate("w1");
    expect(await reg.status("w1")).toBe("hibernated");
    const woke = await reg.wake("w1");
    expect(woke?.nativeId).toBe("ws-1");
  });
});
