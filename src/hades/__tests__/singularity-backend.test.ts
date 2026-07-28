import { describe, it, expect } from "vitest";
import { SingularityBackend } from "../backends/singularity";
import type { CommandRunner } from "../backends/singularity";
import type { ExecResult } from "../backends/ssh";
import type { RemoteSpec } from "../backends/backend";

/** The serverless-only lifecycle a persistent backend deliberately omits.
 *  Declared here so the "these are absent" assertions below are typed
 *  rather than cast through `any`. */
interface ServerlessCapabilities {
  hibernate: unknown;
  wake: unknown;
}


/** Fake apptainer CLI: a tiny instance table driven by parsed argv. */
function fakeRunner(): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const instances = new Set<string>();
  return {
    calls,
    async run(bin: string, args: string[]): Promise<ExecResult> {
      calls.push([bin, ...args]);
      if (args[0] === "--version") return { stdout: "apptainer version 1.3.0", stderr: "", code: 0 };
      if (args[0] === "instance" && args[1] === "start") {
        const name = args[args.length - 1];
        instances.add(name);
        return { stdout: `Instance stats will be available with 'instance list'`, stderr: "", code: 0 };
      }
      if (args[0] === "instance" && args[1] === "list") {
        return { stdout: ["INSTANCE NAME", ...instances].join("\n"), stderr: "", code: 0 };
      }
      if (args[0] === "instance" && args[1] === "stop") {
        instances.delete(args[2]);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (bin === "sh") return { stdout: "worker log line", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

const spec: RemoteSpec = {
  workerId: "w1",
  capabilities: ["hpc"],
  managerUrl: "http://mgr.local",
  authToken: "secret",
  image: "/images/hades.sif",
  limits: { memory: "4g" },
};

describe("SingularityBackend", () => {
  it("reports availability from --version", async () => {
    expect(await new SingularityBackend(fakeRunner()).isAvailable()).toBe(true);
  });

  it("starts a named instance with the worker env and image", async () => {
    const runner = fakeRunner();
    const be = new SingularityBackend(runner, { now: () => 9 });
    const h = await be.provision(spec);

    expect(h.backend).toBe("singularity");
    expect(h.nativeId).toBe("hades-w1");
    expect(h.state).toBe("running");
    const start = runner.calls.find((c) => c[1] === "instance" && c[2] === "start")!;
    expect(start).toContain("--env");
    expect(start).toContain("SWARM_WORKER_ID=w1");
    expect(start).toContain("--memory");
    expect(start).toContain("4g");
    expect(start).toContain("/images/hades.sif");
    expect(start[start.length - 1]).toBe("hades-w1");
  });

  it("tracks liveness via instance list and terminates", async () => {
    const runner = fakeRunner();
    const be = new SingularityBackend(runner);
    const h = await be.provision(spec);
    expect(await be.status(h)).toBe("running");
    await be.terminate(h);
    expect(await be.status(h)).toBe("stopped");
  });

  it("tails the instance log", async () => {
    const be = new SingularityBackend(fakeRunner());
    const h = await be.provision(spec);
    expect(await be.logs(h)).toContain("worker log line");
  });

  it("throws without a .sif image", async () => {
    const be = new SingularityBackend(fakeRunner());
    const { image, ...noImage } = spec;
    void image;
    await expect(be.provision(noImage)).rejects.toThrow(/requires a .sif image/);
  });

  it("uses a default image and the singularity binary when configured", async () => {
    const runner = fakeRunner();
    const be = new SingularityBackend(runner, { bin: "singularity", image: "/def.sif" });
    const { image, ...noImage } = spec;
    void image;
    const h = await be.provision(noImage);
    expect((h.meta as { image: string }).image).toBe("/def.sif");
    expect(runner.calls[0][0]).toBe("singularity");
  });

  it("has no hibernate/wake (persistent HPC node)", () => {
    const be = new SingularityBackend(fakeRunner());
    expect((be as Partial<ServerlessCapabilities>).hibernate).toBeUndefined();
    expect((be as Partial<ServerlessCapabilities>).wake).toBeUndefined();
  });
});
