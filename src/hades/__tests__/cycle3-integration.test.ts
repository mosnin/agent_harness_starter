/**
 * Central-integration tests for cycle 3: the pieces the build teams shipped
 * standalone, now wired into the real product surfaces.
 *
 *  - `RemoteBackendRegistry.adopt()` — the real registry method added to
 *    satisfy `adoption.ts`'s locked `RegistryAdoptionPort` contract (the
 *    adoption team's own tests ran against a documented shim; these run
 *    against the REAL method).
 *  - `FleetSupervisor.restore()` — now resurrects (re-attaches to the live
 *    registry via `restoreWithAdoption`), not just reports: after a restart,
 *    `status`/`hibernate`/`terminate` work again for a worker provisioned by
 *    the previous process.
 *  - `hades backends reconcile [--adopt|--dry-run|--json]` — routed through
 *    the real `runBackendsCommand` dispatch.
 *  - `hades showdown` and `hades skills hub` — routed through the real
 *    `HadesCli`, including a genuine (small) modeled showdown run whose
 *    artifacts re-verify through `showdown verify`.
 *
 * Real components everywhere: real registry, real FakeBackend probes, real
 * HandleStore over an injected in-memory fs, real CLI dispatch. No module
 * under test is mocked.
 */
import { describe, expect, it } from "vitest";

import { RemoteBackendRegistry, type RemoteHandle } from "../backends/backend";
import { BackendManager } from "../backends/manager";
import { FakeBackend } from "../backends/fake-backend";
import { FleetSupervisor } from "../backends/fleet-supervisor";
import { HandleStore, type HandleStoreFs } from "../backends/handle-store";
import type { BackendDescriptor } from "../backends/descriptor";
import type { RemoteSpec } from "../backends/backend";
import { runBackendsCommand } from "../cli/backends-command";
import { HadesCli } from "../cli/cli";
import { runShowdownCommand, type ShowdownCommandFsDeps } from "../cli/showdown-command";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => (t += ms),
  };
}

function descriptor(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    name: "fake",
    kind: "fake",
    capabilities: ["shell"],
    cost: { perRunningHourUsd: 0, perHibernatedHourUsd: 0, perProvisionUsd: 0, source: "configured" },
    supportsHibernate: true,
    locality: "remote",
    ...overrides,
  };
}

function spec(workerId: string, overrides: Partial<RemoteSpec> = {}): RemoteSpec {
  return {
    workerId,
    capabilities: ["shell"],
    managerUrl: "https://manager.local",
    authToken: "tok",
    ...overrides,
  };
}

function buildManager(now: () => number, backend: FakeBackend): BackendManager {
  const mgr = new BackendManager({ now });
  mgr.register(backend, descriptor({ name: backend.name }));
  return mgr;
}

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const fs: HandleStoreFs = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (a, b) => {
      const v = files.get(a);
      if (v === undefined) throw new Error("rename source missing");
      files.set(b, v);
      files.delete(a);
    },
    mkdir: async () => {},
    unlink: async (p) => {
      files.delete(p);
    },
  };
  return { fs, files };
}

const PATH = "/virtual/fleet.json";

function handle(overrides: Partial<RemoteHandle> = {}): RemoteHandle {
  return {
    workerId: "w1",
    backend: "fake",
    nativeId: "n-1",
    state: "running",
    startedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RemoteBackendRegistry.adopt — the REAL registry method
// ---------------------------------------------------------------------------

describe("RemoteBackendRegistry.adopt (real registry, real adoption seam)", () => {
  it("inserts the handle exactly as if provision() had produced it: handle() and list() see it", () => {
    const registry = new RemoteBackendRegistry();
    const h = handle();
    registry.adopt(h);
    expect(registry.handle("w1")).toBe(h);
    expect(registry.list()).toContain(h);
  });

  it("throws on a duplicate workerId instead of silently overwriting", () => {
    const registry = new RemoteBackendRegistry();
    registry.adopt(handle());
    expect(() => registry.adopt(handle({ nativeId: "other" }))).toThrow(/already live/);
    // Original entry untouched.
    expect(registry.handle("w1")?.nativeId).toBe("n-1");
  });

  it("an adopted handle is fully drivable: status() probes the real backend through it", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const provisioned = await fb.provision(spec("w1"));

    const registry = new RemoteBackendRegistry();
    registry.register(fb);
    registry.adopt(provisioned);

    await expect(registry.status("w1")).resolves.toBe("running");
  });
});

// ---------------------------------------------------------------------------
// FleetSupervisor.restore — resurrection, not just reporting
// ---------------------------------------------------------------------------

describe("FleetSupervisor.restore adopts restored workers into the live registry", () => {
  it("after a simulated restart, the restored worker is LIVE again (status/hibernate/terminate work)", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const supervisorA = new FleetSupervisor({
      manager: managerA,
      store: new HandleStore({ path: PATH, fs, now: clock.now }),
      now: clock.now,
    });
    await supervisorA.provision(spec("w1"));

    // "Restart": fresh manager/registry/machine, same backend, same file.
    const managerB = buildManager(clock.now, fb);
    const supervisorB = new FleetSupervisor({
      manager: managerB,
      store: new HandleStore({ path: PATH, fs, now: clock.now }),
      now: clock.now,
    });

    const report = await supervisorB.restore();
    expect(report?.adoption.adopted.map((h) => h.workerId)).toEqual(["w1"]);
    expect(report?.adoption.conflicts).toEqual([]);
    expect(report?.adoption.dropped).toEqual([]);

    // The gap this cycle closes: before adoption, these all failed with
    // "Unknown worker" after a restart.
    expect(managerB.registry.handle("w1")).toBeDefined();
    await expect(managerB.status("w1")).resolves.toBe("running");
    await expect(supervisorB.hibernate("w1")).resolves.toMatchObject({ state: "hibernated" });
    await expect(supervisorB.wake("w1")).resolves.toMatchObject({ state: "running" });
    await supervisorB.terminate("w1");
    expect(managerB.registry.handle("w1")).toBeUndefined();
  });

  it("a terminal-probed worker is still reported restored but never re-attached", async () => {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "alpha", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const supervisorA = new FleetSupervisor({
      manager: managerA,
      store: new HandleStore({ path: PATH, fs, now: clock.now }),
      now: clock.now,
    });
    const { handle: h } = await supervisorA.provision(spec("w1"));
    // Stop it on the backend directly so the persisted file still says running.
    await fb.terminate(h);

    const managerB = buildManager(clock.now, fb);
    const supervisorB = new FleetSupervisor({
      manager: managerB,
      store: new HandleStore({ path: PATH, fs, now: clock.now }),
      now: clock.now,
    });

    const report = await supervisorB.restore();
    expect(report?.restored.map((x) => x.workerId)).toEqual(["w1"]);
    expect(report?.adoption.adopted).toEqual([]);
    expect(report?.adoption.dropped).toHaveLength(1);
    expect(report?.adoption.dropped[0].reason).toContain("terminal");
    expect(managerB.registry.handle("w1")).toBeUndefined();
    // The lifecycle machine still tracks the observed terminal state.
    expect(supervisorB.lifecycle("w1")).toBe("stopped");
  });
});

// ---------------------------------------------------------------------------
// hades backends reconcile [--adopt|--dry-run|--json] through the real dispatch
// ---------------------------------------------------------------------------

describe("runBackendsCommand reconcile routing (central integration)", () => {
  async function persistedFixture() {
    const clock = makeClock();
    const fb = new FakeBackend({ name: "fake", now: clock.now });
    const { fs } = makeMemoryFs();

    const managerA = buildManager(clock.now, fb);
    const supervisorA = new FleetSupervisor({
      manager: managerA,
      store: new HandleStore({ path: PATH, fs, now: clock.now }),
      now: clock.now,
    });
    await supervisorA.provision(spec("w1"));

    const managerB = buildManager(clock.now, fb);
    const store = new HandleStore({ path: PATH, fs, now: clock.now });
    return { clock, managerB, store };
  }

  it("bare `reconcile` keeps the original read-only report and never mutates the registry", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["reconcile"], { manager: managerB, store });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("restored:  1");
    expect(managerB.registry.handle("w1")).toBeUndefined();
  });

  it("`reconcile --dry-run` reports what WOULD be adopted without mutating the registry", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["reconcile", "--dry-run"], { manager: managerB, store });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Dry run — 1 handle(s) would be adopted");
    expect(managerB.registry.handle("w1")).toBeUndefined();
  });

  it("`reconcile --adopt` re-attaches the worker so `status` works again", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["reconcile", "--adopt"], { manager: managerB, store });
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Adopted 1 handle(s).");
    expect(managerB.registry.handle("w1")).toBeDefined();

    const status = await runBackendsCommand(["status", "w1"], { manager: managerB, store });
    expect(status.code).toBe(0);
    expect(status.lines[0]).toContain("w1: running");
  });

  it("`reconcile --adopt --json` emits machine-readable adoption output", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["reconcile", "--adopt", "--json"], { manager: managerB, store });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.lines.join("\n")) as {
      dryRun: boolean;
      adoption: { adopted: Array<{ workerId: string }> };
    };
    expect(parsed.dryRun).toBe(false);
    expect(parsed.adoption.adopted.map((h) => h.workerId)).toEqual(["w1"]);
  });

  it("`reconcile --adopt --dry-run` is rejected as mutually exclusive", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["reconcile", "--adopt", "--dry-run"], { manager: managerB, store });
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain("mutually exclusive");
  });

  it("backends help documents the --adopt flag", async () => {
    const { managerB, store } = await persistedFixture();
    const res = await runBackendsCommand(["help"], { manager: managerB, store });
    expect(res.lines.join("\n")).toContain("--adopt");
  });
});

// ---------------------------------------------------------------------------
// hades showdown + hades skills hub through the real HadesCli router
// ---------------------------------------------------------------------------

describe("HadesCli routes the cycle-3 commands", () => {
  it("`hades help` lists showdown and skills hub", async () => {
    const cli = new HadesCli();
    const res = await cli.run(["help"]);
    const text = res.lines.join("\n");
    expect(text).toContain("showdown");
    expect(text).toContain("skills hub");
  });

  it("`hades showdown` prints the showdown usage", async () => {
    const cli = new HadesCli();
    const res = await cli.run(["showdown"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Usage: hades showdown <command>");
  });

  it("`hades skills hub` prints the hub usage without touching any library dir", async () => {
    const cli = new HadesCli({ skillsDir: "/nonexistent/should-never-be-read" });
    const res = await cli.run(["skills", "hub"]);
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("Usage: hades skills hub <command>");
  });

  it("`hades skills hub export` against an absent library dir reports honestly", async () => {
    const cli = new HadesCli({ skillsDir: "/nonexistent/should-never-be-read" });
    const res = await cli.run(["skills", "hub", "export", "no-such-skill", "/tmp/out"]);
    expect(res.code).toBe(1);
    expect(res.lines[0]).toContain('No skill named "no-such-skill"');
  });
});

// ---------------------------------------------------------------------------
// A genuine (small) modeled showdown run, end to end through the command,
// whose artifacts re-verify — and whose tampering is caught.
// ---------------------------------------------------------------------------

function makeShowdownMemoryFs() {
  const files = new Map<string, string>();
  const fs: ShowdownCommandFsDeps = {
    mkdir: async () => undefined,
    writeFile: async (p: string, data: string) => {
      files.set(String(p), String(data));
    },
    rename: async (a: string, b: string) => {
      const v = files.get(String(a));
      if (v === undefined) throw new Error("rename source missing");
      files.set(String(b), v);
      files.delete(String(a));
    },
    readFile: async (p: string) => {
      const v = files.get(String(p));
      if (v === undefined) throw new Error(`ENOENT: ${String(p)}`);
      return v;
    },
  } as unknown as ShowdownCommandFsDeps;
  return { fs, files };
}

describe("hades showdown run/verify (real modeled run through the real swarm engine)", () => {
  it("runs a small suite, writes artifacts, and verify re-verifies the chain from disk", async () => {
    const { fs, files } = makeShowdownMemoryFs();

    const run = await runShowdownCommand(["run", "--tasks", "8", "--seed", "7", "--out", "/virtual/showdown"], { fs });
    expect(run.code).toBe(0);
    const text = run.lines.join("\n");
    // Every modeled figure must carry the label; no unlabeled numbers.
    expect(text).toContain("(modeled)");
    expect([...files.keys()].sort()).toEqual([
      "/virtual/showdown/audit.jsonl",
      "/virtual/showdown/report.md",
      "/virtual/showdown/result.json",
    ]);

    const verify = await runShowdownCommand(["verify", "/virtual/showdown"], { fs });
    expect(verify.code).toBe(0);
    expect(verify.lines[0]).toContain("Audit chain OK");

    // Tamper with one recorded verdict: verification must fail.
    const audit = files.get("/virtual/showdown/audit.jsonl")!;
    const lines = audit.split("\n").filter((l) => l.trim().length > 0);
    const rec = JSON.parse(lines[3]) as { verdict: string };
    rec.verdict = rec.verdict === "verified" ? "rejected" : "verified";
    lines[3] = JSON.stringify(rec);
    files.set("/virtual/showdown/audit.jsonl", lines.join("\n") + "\n");

    const tampered = await runShowdownCommand(["verify", "/virtual/showdown"], { fs });
    expect(tampered.code).toBe(1);
    expect(tampered.lines.join("\n")).toContain("FAILED");
  }, 30_000);
});
