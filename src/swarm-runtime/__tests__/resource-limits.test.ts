import { describe, it, expect } from "vitest";
import { buildDockerRunArgs } from "../providers/docker";
import { LocalProcessProvider } from "../providers/local-process";
import type { SpawnSpec } from "../types";

function spec(limits?: SpawnSpec["limits"]): SpawnSpec {
  return {
    workerId: "w1",
    capabilities: ["research"],
    managerUrl: "http://mgr:8787",
    authToken: "tok",
    limits,
  };
}

describe("buildDockerRunArgs — hardening + resource limits", () => {
  it("always applies no-new-privileges and a pids-limit", () => {
    const args = buildDockerRunArgs(spec(), { image: "img", name: "c", label: "hermes-swarm" });
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--pids-limit");
    expect(args[args.length - 1]).toBe("img"); // image is last
  });

  it("translates every resource/isolation limit into the right flag", () => {
    const args = buildDockerRunArgs(
      spec({ cpus: 1.5, memory: "512m", noNetwork: true, readOnlyRootFs: true, dropAllCapabilities: true }),
      { image: "img", name: "c", label: "hermes-swarm", network: "hermes-net" }
    ).join(" ");
    expect(args).toContain("--cpus 1.5");
    expect(args).toContain("--memory 512m");
    expect(args).toContain("--network none"); // noNetwork wins over the bridge network
    expect(args).toContain("--read-only --tmpfs /tmp");
    expect(args).toContain("--cap-drop ALL");
  });

  it("uses the configured network when not isolated", () => {
    const args = buildDockerRunArgs(spec({ cpus: 1 }), {
      image: "img", name: "c", label: "hermes-swarm", network: "hermes-net",
    }).join(" ");
    expect(args).toContain("--network hermes-net");
    expect(args).not.toContain("--network none");
  });

  it("injects the SWARM_* environment", () => {
    const args = buildDockerRunArgs(spec(), { image: "img", name: "c", label: "hermes-swarm" }).join(" ");
    expect(args).toContain("SWARM_WORKER_ID=w1");
    expect(args).toContain("SWARM_MANAGER_URL=http://mgr:8787");
    expect(args).toContain("SWARM_AUTH_TOKEN=tok");
  });
});

describe("LocalProcessProvider — timeout enforcement", () => {
  it("kills a worker that exceeds its lifetime ceiling", async () => {
    const provider = new LocalProcessProvider({
      command: process.execPath,
      commandArgs: ["-e"],
      workerEntry: "setInterval(()=>{}, 1000)", // runs forever unless killed
    });
    const handle = await provider.spawn({ ...spec({ timeoutMs: 300 }), workerId: "w-timeout" });
    expect(await provider.isAlive(handle)).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(await provider.isAlive(handle)).toBe(false); // SIGKILL fired at the ceiling
  });
});
