import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { LocalProcessBackend } from "../local";
import type { LocalChild, SpawnFn } from "../local";
import { RemoteBackendRegistry } from "../backend";
import type { RemoteSpec } from "../backend";
import { ScaleToZeroManager } from "../scale-to-zero";

/**
 * FAKE-TRANSPORT test double: a `LocalChild` that never touches a real OS
 * process. `kill()` just records the signal instead of sending one — the one
 * exception is `pid`, which callers set to a real, currently-alive pid
 * (`process.pid`, the test runner itself) or a pid picked to be dead, because
 * `LocalProcessBackend.status()` probes liveness with the *real* `process.kill`.
 */
class FakeChild implements LocalChild {
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  private readonly emitter = new EventEmitter();

  constructor(
    public pid: number,
    private readonly killReturn: boolean = true
  ) {
    this.stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
    this.stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return this.killReturn;
  }

  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void {
    this.emitter.on(event, cb);
  }

  emitExit(code: number | null, signal: string | null): void {
    this.emitter.emit("exit", code, signal);
  }

  writeStdout(text: string): void {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"));
  }

  writeStderr(text: string): void {
    (this.stderr as unknown as EventEmitter).emit("data", Buffer.from(text, "utf8"));
  }
}

/** A pid essentially guaranteed not to be a live process on this machine. */
const DEAD_PID = 4194303;

function fakeSpawnFactory(): { spawn: SpawnFn; children: FakeChild[]; calls: Array<{ command: string; args: string[]; env: Record<string, string> }> } {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  let nextPid = 20000;
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    const child = new FakeChild(++nextPid);
    children.push(child);
    return child;
  };
  return { spawn, children, calls };
}

function baseSpec(overrides: Partial<RemoteSpec> = {}): RemoteSpec {
  return {
    workerId: "w1",
    capabilities: ["search", "code"],
    managerUrl: "http://mgr.local",
    authToken: "secret-token",
    ...overrides,
  };
}

describe("LocalProcessBackend — provision", () => {
  it("is always available (no external dependency)", async () => {
    const be = new LocalProcessBackend();
    expect(await be.isAvailable()).toBe(true);
  });

  it("defaults to the name 'local'", () => {
    const be = new LocalProcessBackend();
    expect(be.name).toBe("local");
  });

  it("honors a custom name", () => {
    const be = new LocalProcessBackend({ name: "local-2" });
    expect(be.name).toBe("local-2");
  });

  it("spawns the default entrypoint when spec.image is absent", async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn, now: () => 100 });
    await be.provision(baseSpec());
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(["-e", "setInterval(()=>{},1<<30)"]);
  });

  it("interprets spec.image as a whitespace-split command line", async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    await be.provision(baseSpec({ image: "/usr/bin/env  node worker.js  --flag" }));
    expect(calls[0].command).toBe("/usr/bin/env");
    expect(calls[0].args).toEqual(["node", "worker.js", "--flag"]);
  });

  it("maps SWARM_* env exactly like the other backends, including SWARM_MODEL when present", async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    await be.provision(baseSpec({ model: "claude-x" }));
    expect(calls[0].env).toMatchObject({
      SWARM_WORKER_ID: "w1",
      SWARM_MANAGER_URL: "http://mgr.local",
      SWARM_AUTH_TOKEN: "secret-token",
      SWARM_CAPABILITIES: "search,code",
      SWARM_MODEL: "claude-x",
    });
  });

  it("omits SWARM_MODEL when spec.model is absent", async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    await be.provision(baseSpec());
    expect(calls[0].env.SWARM_MODEL).toBeUndefined();
  });

  it("documented precedence: spec.env overrides derived SWARM_* keys on collision", async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    await be.provision(baseSpec({ env: { SWARM_CAPABILITIES: "overridden", EXTRA: "1" } }));
    expect(calls[0].env.SWARM_CAPABILITIES).toBe("overridden");
    expect(calls[0].env.EXTRA).toBe("1");
    // Untouched derived keys survive alongside the override.
    expect(calls[0].env.SWARM_WORKER_ID).toBe("w1");
  });

  it("returns a running handle with nativeId = String(pid) and the injected startedAt", async () => {
    const { spawn } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn, now: () => 4242 });
    const h = await be.provision(baseSpec());
    expect(h.backend).toBe("local");
    expect(h.state).toBe("running");
    expect(h.startedAt).toBe(4242);
    expect(h.nativeId).toMatch(/^\d+$/);
  });
});

describe("LocalProcessBackend — hibernate / wake (SIGSTOP / SIGCONT)", () => {
  it("hibernate sends SIGSTOP and reports state hibernated", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    const hibernated = await be.hibernate(h);
    expect(children[0].killedSignals).toEqual(["SIGSTOP"]);
    expect(hibernated.state).toBe("hibernated");
  });

  it("wake sends SIGCONT and reports state running", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    await be.hibernate(h);
    const woken = await be.wake(h);
    expect(children[0].killedSignals).toEqual(["SIGSTOP", "SIGCONT"]);
    expect(woken.state).toBe("running");
  });

  it("double-hibernate is idempotent: second call sends no additional SIGSTOP", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    await be.hibernate(h);
    const second = await be.hibernate(h);
    expect(children[0].killedSignals).toEqual(["SIGSTOP"]);
    expect(second.state).toBe("hibernated");
  });

  it("double-wake is idempotent: waking an already-running worker sends no SIGCONT", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    const woken = await be.wake(h); // never hibernated
    expect(children[0].killedSignals).toEqual([]);
    expect(woken.state).toBe("running");
  });

  it("hibernate does not throw even if the underlying kill() returns false", async () => {
    const spawn: SpawnFn = (_c, _a, _o) => new FakeChild(30001, false);
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    await expect(be.hibernate(h)).resolves.toMatchObject({ state: "hibernated" });
  });

  it("exit-during-hibernated: process dying while stopped keeps status() 'hibernated' until wake() resolves reality", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    await be.hibernate(h);
    children[0].emitExit(0, "SIGSTOP");
    // A hibernated worker reads as hibernated even after the underlying
    // process died, until something (wake) reconciles it against reality.
    expect(await be.status(h)).toBe("hibernated");
    const woken = await be.wake(h);
    expect(woken.state).toBe("stopped"); // exitCode 0 → clean stop
    expect(await be.status(h)).toBe("stopped");
  });

  it("exit-during-hibernated with non-zero exit code resolves to 'failed' on wake", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    await be.hibernate(h);
    children[0].emitExit(1, null);
    const woken = await be.wake(h);
    expect(woken.state).toBe("failed");
  });

  it("throws hibernating/waking an unknown worker", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn });
    const ghost = { workerId: "ghost", backend: "local", nativeId: "1", state: "running" as const, startedAt: 0 };
    await expect(be.hibernate(ghost)).rejects.toThrow(/unknown worker/);
    await expect(be.wake(ghost)).rejects.toThrow(/unknown worker/);
  });
});

describe("LocalProcessBackend — status", () => {
  it("reports 'running' via the real kill(pid, 0) liveness probe", async () => {
    const spawn: SpawnFn = () => new FakeChild(process.pid); // guaranteed-alive real pid
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    expect(await be.status(h)).toBe("running");
  });

  it("reports 'stopped' when the liveness probe finds the pid gone (never exited via event)", async () => {
    const spawn: SpawnFn = () => new FakeChild(DEAD_PID);
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    expect(await be.status(h)).toBe("stopped");
  });

  it("reports 'stopped' after a clean (code 0) exit event, without probing the pid", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    children[0].emitExit(0, null);
    expect(await be.status(h)).toBe("stopped");
  });

  it("reports 'failed' after a non-zero exit event", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    children[0].emitExit(7, null);
    expect(await be.status(h)).toBe("failed");
  });

  it("reports 'stopped' when killed by a signal (exit code null, signal set)", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    children[0].emitExit(null, "SIGTERM");
    expect(await be.status(h)).toBe("stopped");
  });

  // Untracked handles (e.g. reconciled from a persisted fleet after a
  // restart) are probed via their REAL pid, never blanket-claimed "stopped":
  // a live orphan must not be lied about (integration-audit fix, cycle 1).
  it("probes the real pid for a never-tracked handle: dead/bogus pid -> 'stopped'", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn });
    // A pid that cannot exist (beyond pid_max) and a non-numeric nativeId.
    const dead = { workerId: "ghost", backend: "local", nativeId: "999999999", state: "running" as const, startedAt: 0 };
    expect(await be.status(dead)).toBe("stopped");
    const bogus = { workerId: "ghost2", backend: "local", nativeId: "not-a-pid", state: "running" as const, startedAt: 0 };
    expect(await be.status(bogus)).toBe("stopped");
  });

  it("probes the real pid for a never-tracked handle: genuinely-alive pid -> 'running'", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn });
    // This test process itself is indisputably alive.
    const alive = { workerId: "ghost3", backend: "local", nativeId: String(process.pid), state: "running" as const, startedAt: 0 };
    expect(await be.status(alive)).toBe("running");
  });

  it("terminate on a never-tracked handle with a dead pid is a safe no-op (no signals thrown)", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn, graceMs: 1 });
    const dead = { workerId: "ghost4", backend: "local", nativeId: "999999999", state: "running" as const, startedAt: 0 };
    await expect(be.terminate(dead)).resolves.toBeUndefined();
  });
});

describe("LocalProcessBackend — logs ring buffer", () => {
  it("captures stdout and stderr", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn });
    const h = await be.provision(baseSpec());
    children[0].writeStdout("hello out\n");
    children[0].writeStderr("uh oh\n");
    const text = await be.logs(h);
    expect(text).toContain("hello out");
    expect(text).toContain("uh oh");
  });

  it("honors the exact byte cap and truncates from the front, with an honest truncation marker", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn, logBufferBytes: 10 });
    const h = await be.provision(baseSpec());
    children[0].writeStdout("0123456789"); // exactly 10 bytes — no overflow yet
    let text = await be.logs(h);
    expect(text).toBe("0123456789");
    expect(text).not.toContain("truncated");

    children[0].writeStdout("ABCDE"); // now 15 bytes total, cap 10 → keep last 10
    text = await be.logs(h);
    expect(text).toContain("truncated");
    expect(text).toContain("56789ABCDE"); // exactly the last 10 raw bytes
    expect(text).not.toContain("0123456789A"); // the dropped prefix
  });

  it("defaults the log buffer to 64KiB when unset", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const be = new LocalProcessBackend({ spawn }); // default logBufferBytes
    const h = await be.provision(baseSpec());
    children[0].writeStdout("x".repeat(64 * 1024)); // exactly the default cap
    const text = await be.logs(h);
    expect(text.length).toBe(64 * 1024);
    expect(text).not.toContain("truncated");
    children[0].writeStdout("y"); // one byte over → now must truncate
    const text2 = await be.logs(h);
    expect(text2).toContain("truncated");
  });

  it("throws logs() for an unknown worker", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn });
    const ghost = { workerId: "ghost", backend: "local", nativeId: "1", state: "running" as const, startedAt: 0 };
    await expect(be.logs(ghost)).rejects.toThrow(/unknown worker/);
  });
});

describe("LocalProcessBackend — terminate", () => {
  it("sends SIGTERM then, if still alive after graceMs, SIGKILL — timed via injected sleep", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
      // process never exits during the grace window in this test.
    });
    const be = new LocalProcessBackend({ spawn, graceMs: 5000, sleep });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    expect(children[0].killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sleepCalls).toEqual([5000]);
  });

  it("skips SIGKILL if the process exits during the grace window", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const sleep = vi.fn(async (_ms: number) => {
      children[0].emitExit(0, "SIGTERM"); // exits mid-grace
    });
    const be = new LocalProcessBackend({ spawn, graceMs: 5000, sleep });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    expect(children[0].killedSignals).toEqual(["SIGTERM"]);
  });

  it("is a no-op for an already-dead pid (exit event already fired)", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const sleep = vi.fn(async () => {});
    const be = new LocalProcessBackend({ spawn, sleep });
    const h = await be.provision(baseSpec());
    children[0].emitExit(0, null);
    await be.terminate(h);
    expect(children[0].killedSignals).toEqual([]); // never signaled a dead process
    expect(sleep).not.toHaveBeenCalled();
  });

  it("is a safe no-op for an unknown worker", async () => {
    const be = new LocalProcessBackend({ spawn: fakeSpawnFactory().spawn });
    const ghost = { workerId: "ghost", backend: "local", nativeId: "1", state: "running" as const, startedAt: 0 };
    await expect(be.terminate(ghost)).resolves.toBeUndefined();
  });

  it("does not escalate to SIGKILL when the initial kill() call itself returns false", async () => {
    const spawn: SpawnFn = () => new FakeChild(30002, false);
    const sleep = vi.fn(async () => {});
    const be = new LocalProcessBackend({ spawn, sleep });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("resumes a hibernated (SIGSTOP'd) process with SIGCONT before terminating it", async () => {
    const { spawn, children } = fakeSpawnFactory();
    const sleep = vi.fn(async () => {});
    const be = new LocalProcessBackend({ spawn, sleep });
    const h = await be.provision(baseSpec());
    const hibernated = await be.hibernate(h);
    await be.terminate(hibernated);
    expect(children[0].killedSignals).toEqual(["SIGSTOP", "SIGCONT", "SIGTERM", "SIGKILL"]);
  });

  it("stops tracking the worker after terminate (subsequent status() reads 'stopped')", async () => {
    const { spawn } = fakeSpawnFactory();
    const sleep = vi.fn(async () => {});
    const be = new LocalProcessBackend({ spawn, sleep });
    const h = await be.provision(baseSpec());
    await be.terminate(h);
    expect(await be.status(h)).toBe("stopped");
  });
});

describe("LocalProcessBackend — real default spawn (integration, no injected fake)", () => {
  it("provisions and terminates a genuine child process via the real default SpawnFn", async () => {
    const be = new LocalProcessBackend({
      graceMs: 200,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const h = await be.provision(
      baseSpec({ image: `${process.execPath} -e setInterval(()=>{},1000)`, workerId: "real1" })
    );
    expect(h.nativeId).toMatch(/^\d+$/);
    expect(Number(h.nativeId)).toBeGreaterThan(0);
    // Give the OS a moment to schedule the process, then confirm it's alive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await be.status(h)).toBe("running");
    await be.terminate(h);
    expect(await be.status(h)).toBe("stopped");
  }, 10_000);
});

describe("LocalProcessBackend — RemoteBackendRegistry / ScaleToZeroManager interop", () => {
  it("registers with the real registry, provisions, and the scale-to-zero sweep hibernates it via the real SIGSTOP path on an injected clock", async () => {
    let t = 0;
    const { spawn, children } = fakeSpawnFactory();
    const registry = new RemoteBackendRegistry();
    const be = new LocalProcessBackend({ spawn, now: () => t });
    registry.register(be);

    const { handle } = await registry.provision(baseSpec({ workerId: "sweep-me" }), "local");
    expect(handle.backend).toBe("local");

    const mgr = new ScaleToZeroManager(registry, { idleMs: 1000, now: () => t });
    mgr.markActive("sweep-me");

    t = 2000; // idle 2000ms > 1000ms threshold
    const hibernated = await mgr.sweep();

    expect(hibernated).toEqual(["sweep-me"]);
    expect(children[0].killedSignals).toEqual(["SIGSTOP"]);
    expect(await registry.status("sweep-me")).toBe("hibernated");

    t = 2500;
    const woken = await mgr.acquire("sweep-me");
    expect(woken?.state).toBe("running");
    expect(children[0].killedSignals).toEqual(["SIGSTOP", "SIGCONT"]);
  });
});
