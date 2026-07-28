import { describe, it, expect } from "vitest";
import { SshBackend, createSshCliTransport } from "../backends/ssh";
import type { SshTransport, ExecResult } from "../backends/ssh";
import type { RemoteSpec } from "../backends/backend";

/** The serverless-only lifecycle a persistent backend deliberately omits.
 *  Declared here so the "these are absent" assertions below are typed
 *  rather than cast through `any`. */
interface ServerlessCapabilities {
  hibernate: unknown;
  wake: unknown;
}


/** A fake remote host: a tiny process table + log store driven by parsed commands. */
function fakeHost(): SshTransport & { commands: string[]; kill(pid: string): void } {
  const commands: string[] = [];
  const alive = new Set<string>();
  const logs = new Map<string, string>();
  let nextPid = 1000;

  return {
    commands,
    kill(pid: string) {
      alive.delete(pid);
    },
    async exec(cmd: string): Promise<ExecResult> {
      commands.push(cmd);
      if (cmd.includes("echo hades-ok")) return { stdout: "hades-ok\n", stderr: "", code: 0 };
      if (cmd.includes("nohup")) {
        const pid = String(++nextPid);
        alive.add(pid);
        const logMatch = cmd.match(/> (\S+\.log)/);
        if (logMatch) logs.set(pid, `worker booting on log ${logMatch[1]}`);
        return { stdout: `${pid}\n`, stderr: "", code: 0 };
      }
      if (cmd.includes("kill -0")) {
        const pid = cmd.match(/kill -0 (\d+)/)?.[1] ?? "";
        return { stdout: alive.has(pid) ? "alive\n" : "dead\n", stderr: "", code: 0 };
      }
      if (cmd.startsWith("kill ")) {
        const pid = cmd.match(/kill (\d+)/)?.[1] ?? "";
        alive.delete(pid);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (cmd.includes("tail")) {
        // Return the most recent booted log (single-worker tests).
        const last = [...logs.values()].pop() ?? "";
        return { stdout: last, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

const spec: RemoteSpec = {
  workerId: "w1",
  capabilities: ["search"],
  managerUrl: "http://mgr.local",
  authToken: "secret",
  model: "claude-x",
};

describe("SshBackend", () => {
  it("reports availability via a probe", async () => {
    const host = fakeHost();
    const be = new SshBackend(host, { now: () => 1 });
    expect(await be.isAvailable()).toBe(true);
  });

  it("provisions a worker, capturing its PID and log path", async () => {
    const host = fakeHost();
    const be = new SshBackend(host, { now: () => 42, workDir: "/tmp/hw" });
    const h = await be.provision(spec);

    expect(h.backend).toBe("ssh");
    expect(h.nativeId).toMatch(/^\d+$/);
    expect(h.state).toBe("running");
    expect(h.startedAt).toBe(42);
    expect(h.meta?.logPath).toBe("/tmp/hw/worker-w1.log");
    // The launch command carries the worker env.
    const launch = host.commands.find((c) => c.includes("nohup"))!;
    expect(launch).toContain('SWARM_WORKER_ID="w1"');
    expect(launch).toContain('SWARM_CAPABILITIES="search"');
    expect(launch).toContain('SWARM_MODEL="claude-x"');
  });

  it("tracks liveness and terminates", async () => {
    const host = fakeHost();
    const be = new SshBackend(host);
    const h = await be.provision(spec);

    expect(await be.status(h)).toBe("running");
    await be.terminate(h);
    expect(await be.status(h)).toBe("stopped");
  });

  it("tails logs from the worker's log file", async () => {
    const host = fakeHost();
    const be = new SshBackend(host);
    const h = await be.provision(spec);
    expect(await be.logs(h)).toContain("worker booting");
  });

  it("throws when the remote launch does not yield a PID", async () => {
    const host: SshTransport = {
      async exec() {
        return { stdout: "boom", stderr: "no such file", code: 1 };
      },
    };
    const be = new SshBackend(host);
    await expect(be.provision(spec)).rejects.toThrow(/SSH provision failed/);
  });

  it("has no hibernate/wake (not serverless)", () => {
    const be = new SshBackend(fakeHost());
    expect((be as Partial<ServerlessCapabilities>).hibernate).toBeUndefined();
    expect((be as Partial<ServerlessCapabilities>).wake).toBeUndefined();
  });
});

describe("createSshCliTransport", () => {
  it("builds an ssh invocation with port + identity and BatchMode", async () => {
    const calls: Array<{ bin: string; argv: string[] }> = [];
    const t = createSshCliTransport("user@host", {
      port: 2222,
      identityFile: "/keys/id",
      runLocal: async (bin, argv) => {
        calls.push({ bin, argv });
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    await t.exec("echo hi");
    expect(calls[0].bin).toBe("ssh");
    expect(calls[0].argv).toEqual(["-p", "2222", "-i", "/keys/id", "-o", "BatchMode=yes", "user@host", "echo hi"]);
  });
});
