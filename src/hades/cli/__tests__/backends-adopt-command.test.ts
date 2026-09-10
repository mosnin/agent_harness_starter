/* ------------------------------------------------------------------ *
 * backends-adopt-command.test.ts
 *
 * REAL-VS-MOCK POLICY: exercises `runReconcileAdoptCommand` against a REAL
 * `RemoteBackendRegistry` (`../../backends/backend`) wired to real
 * `FakeBackend` instances (`../../backends/fake-backend`) and a REAL
 * `HandleStore` (`../../backends/handle-store`) over an injected in-memory
 * fs, plus a REAL `LifecycleMachine` (`../../backends/lifecycle`) where
 * relevant. The port's `adopt` is the same thin documented test shim used by
 * `adoption.test.ts` (the real `RemoteBackendRegistry.adopt` lands at
 * central integration) — wrapped in a spy so tests can assert the dry-run
 * path genuinely never calls it.
 * ------------------------------------------------------------------ */
import { describe, expect, it, vi } from "vitest";

import { runReconcileAdoptCommand, type AdoptCommandDeps } from "../backends-adopt-command";
import { RemoteBackendRegistry, type RemoteHandle } from "../../backends/backend";
import type { RegistryAdoptionPort } from "../../backends/adoption";
import { FakeBackend } from "../../backends/fake-backend";
import { LifecycleMachine } from "../../backends/lifecycle";
import { HandleStore, type HandleStoreFs, HANDLE_STORE_VERSION } from "../../backends/handle-store";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeAdoptionPort(registry: RemoteBackendRegistry): RegistryAdoptionPort {
  const shadow = new Map<string, RemoteHandle>();
  return {
    adopt(h: RemoteHandle): void {
      if (shadow.has(h.workerId) || registry.handle(h.workerId)) {
        throw new Error(`duplicate workerId: ${h.workerId}`);
      }
      shadow.set(h.workerId, h);
    },
    handle(workerId: string): RemoteHandle | undefined {
      return registry.handle(workerId) ?? shadow.get(workerId);
    },
    get(name: string) {
      return registry.get(name);
    },
    list(): RemoteHandle[] {
      return [...registry.list(), ...shadow.values()];
    },
  };
}

function handle(overrides: Partial<RemoteHandle> = {}): RemoteHandle {
  return {
    workerId: "w1",
    backend: "alpha",
    nativeId: "n1",
    state: "running",
    startedAt: 1000,
    ...overrides,
  };
}

function makeMemoryFs(initial: Record<string, string> = {}): { fs: HandleStoreFs; files: Map<string, string> } {
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

async function primeRunning(backend: FakeBackend, seedWorkerId: string): Promise<string> {
  const h = await backend.provision({ workerId: seedWorkerId, capabilities: [], managerUrl: "x", authToken: "t" });
  return h.nativeId;
}

interface Fixture {
  registry: RemoteBackendRegistry;
  backend: FakeBackend;
  port: RegistryAdoptionPort;
  adoptSpy: ReturnType<typeof vi.spyOn>;
  fs: HandleStoreFs;
  store: HandleStore;
  machine: LifecycleMachine;
}

function makeFixture(): Fixture {
  const registry = new RemoteBackendRegistry();
  const backend = new FakeBackend({ name: "alpha" });
  registry.register(backend);
  const port = makeAdoptionPort(registry);
  const adoptSpy = vi.spyOn(port, "adopt");
  const { fs } = makeMemoryFs();
  const store = new HandleStore({ path: PATH, fs, now: () => 1 });
  const machine = new LifecycleMachine({ now: () => 1 });
  return { registry, backend, port, adoptSpy, fs, store, machine };
}

/** Splits a rendered table row on runs of 2+ spaces (house column separator),
 *  matching the convention `backends-command.test.ts` already uses. */
function cols(line: string): string[] {
  return line.trim().split(/\s{2,}/);
}

// ---------------------------------------------------------------------------
// argument parsing / guard rails
// ---------------------------------------------------------------------------

describe("runReconcileAdoptCommand — argument parsing", () => {
  it("--adopt and --dry-run together is a usage error", async () => {
    const { port } = makeFixture();
    const result = await runReconcileAdoptCommand(["--adopt", "--dry-run"], { registry: port });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/mutually exclusive/);
  });

  it("an unexpected extra argument is a usage error", async () => {
    const { port } = makeFixture();
    const result = await runReconcileAdoptCommand(["bogus"], { registry: port });
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/Unexpected argument: bogus/);
  });

  it("no store configured -> code 1, honest message, matching backends-command.ts's reconcile style", async () => {
    const { port } = makeFixture();
    const result = await runReconcileAdoptCommand([], { registry: port });
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["No fleet store configured for this build (nothing is persisted to adopt)."]);
  });

  it("store configured but nothing ever persisted -> code 0, honest 'nothing found' message", async () => {
    const { port, store } = makeFixture();
    const result = await runReconcileAdoptCommand([], { registry: port, store });
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["No persisted fleet found (nothing saved yet, or the file was quarantined)."]);
  });

  it("sanitizes control characters out of an unexpected argument before echoing it", async () => {
    const { port } = makeFixture();
    const result = await runReconcileAdoptCommand(["bad\x07arg"], { registry: port });
    expect(result.code).toBe(1);
    expect(result.lines[0]).not.toContain("\x07");
  });
});

// ---------------------------------------------------------------------------
// dry run (default, and explicit --dry-run) — proven side-effect-free
// ---------------------------------------------------------------------------

describe("runReconcileAdoptCommand — dry run", () => {
  it("default (no flags) is a dry run: reports what would adopt, never calls the real port's adopt", async () => {
    const { port, store, backend, adoptSpy } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand([], { registry: port, store });

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/Dry run/);
    expect(adoptSpy).not.toHaveBeenCalled();
    // The real registry was never mutated: no live handle for w1.
    expect(port.handle("w1")).toBeUndefined();
  });

  it("explicit --dry-run behaves identically to the default", async () => {
    const { port, store, backend, adoptSpy } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand(["--dry-run"], { registry: port, store });

    expect(result.code).toBe(0);
    expect(adoptSpy).not.toHaveBeenCalled();
    expect(port.handle("w1")).toBeUndefined();
  });

  it("dry run never re-tracks the lifecycle machine even when one is configured", async () => {
    const { port, store, backend, machine } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    await runReconcileAdoptCommand([], { registry: port, store, machine });
    expect(machine.state("w1")).toBeUndefined();
  });

  it("dry run report still reflects an already-live conflict correctly (reads delegate to the real registry)", async () => {
    const { registry, port, store, backend } = makeFixture();
    const otherNativeId = await primeRunning(backend, "other-seed");
    await registry.provision({ workerId: "w1", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");
    await store.save([handle({ workerId: "w1", nativeId: otherNativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand([], { registry: port, store });
    const text = result.lines.join("\n");
    expect(text).toMatch(/conflicts:\s+1/);
  });

  it("a repeated dry run is idempotent: two consecutive calls produce the same report", async () => {
    const { port, store, backend } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const first = await runReconcileAdoptCommand([], { registry: port, store });
    const second = await runReconcileAdoptCommand([], { registry: port, store });
    expect(second.lines).toEqual(first.lines);
  });
});

// ---------------------------------------------------------------------------
// --adopt (real execution)
// ---------------------------------------------------------------------------

describe("runReconcileAdoptCommand — --adopt executes for real", () => {
  it("re-attaches an adoptable handle into the live registry", async () => {
    const { port, store, backend, adoptSpy } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand(["--adopt"], { registry: port, store });

    expect(result.code).toBe(0);
    expect(adoptSpy).toHaveBeenCalledTimes(1);
    expect(port.handle("w1")).toMatchObject({ workerId: "w1", state: "running" });
  });

  it("re-tracks the lifecycle machine at the probed state when one is configured", async () => {
    const { port, store, backend, machine } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "hibernated" })], { w1: "hibernated" });

    await runReconcileAdoptCommand(["--adopt"], { registry: port, store, machine });
    // Probed truth ("running") wins over the stale persisted "hibernated".
    expect(machine.state("w1")).toBe("running");
  });

  it("downgrades a persisted transient lifecycle entry to 'failed' in the machine, mirroring FleetSupervisor", async () => {
    const { port, store, backend, machine } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "hibernating" });

    const result = await runReconcileAdoptCommand(["--adopt"], { registry: port, store, machine });
    expect(result.code).toBe(0);
    // Still adopted into the registry at the real probed state...
    expect(port.handle("w1")).toMatchObject({ state: "running" });
    // ...but the machine tracks the crash-recovered worker as failed.
    expect(machine.state("w1")).toBe("failed");
  });

  it("renders adopted/corrected/conflicts/dropped as tables", async () => {
    const { registry, port, store, backend } = makeFixture();
    const okNative = await primeRunning(backend, "seed-ok");
    const driftNative = await primeRunning(backend, "seed-drift");
    const liveNative = await primeRunning(backend, "seed-live");
    await registry.provision({ workerId: "w-live", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    await store.save(
      [
        handle({ workerId: "w-ok", nativeId: okNative, state: "running" }),
        handle({ workerId: "w-drift", nativeId: driftNative, state: "hibernated" }),
        handle({ workerId: "w-live", backend: "alpha", nativeId: liveNative, state: "running" }),
        handle({ workerId: "w-ghost", backend: "no-such-backend", nativeId: "x", state: "running" }),
      ],
      {},
    );

    const result = await runReconcileAdoptCommand(["--adopt"], { registry: port, store });
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("Adopted:");
    expect(text).toContain("Corrected (stored state disagreed with the live probe):");
    expect(text).toContain("Conflicts (already live in the registry — left untouched):");
    expect(text).toContain("Dropped:");

    const correctedHeaderIdx = result.lines.findIndex((l) => l.startsWith("Corrected"));
    const correctedRow = result.lines.slice(correctedHeaderIdx).find((l) => l.startsWith("w-drift"));
    expect(correctedRow).toBeDefined();
    expect(cols(correctedRow!)).toEqual(["w-drift", "hibernated", "running"]);

    const conflictRow = result.lines.find((l) => l.startsWith("w-live"));
    expect(conflictRow).toBeDefined();

    const droppedRow = result.lines.find((l) => l.startsWith("w-ghost"));
    expect(droppedRow).toBeDefined();
  });

  it("--json emits a machine-parseable report with the correct dryRun flag", async () => {
    const { port, store, backend } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand(["--adopt", "--json"], { registry: port, store });
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    const parsed = JSON.parse(result.lines[0]);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.adoption.adopted).toHaveLength(1);
    expect(parsed.adoption.adopted[0].workerId).toBe("w1");
  });

  it("--json in dry-run mode reports dryRun: true and an empty side-effect", async () => {
    const { port, store, backend, adoptSpy } = makeFixture();
    const nativeId = await primeRunning(backend, "seed");
    await store.save([handle({ workerId: "w1", nativeId, state: "running" })], { w1: "running" });

    const result = await runReconcileAdoptCommand(["--json"], { registry: port, store });
    const parsed = JSON.parse(result.lines[0]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.adoption.adopted).toHaveLength(1);
    expect(adoptSpy).not.toHaveBeenCalled();
  });

  it("a crash-realism batch (unknown backend + terminal probe + conflict + healthy) never throws, always code 0", async () => {
    const { registry, port, store, backend } = makeFixture();
    const okNative = await primeRunning(backend, "seed-ok");
    const stoppedNative = await primeRunning(backend, "seed-stop");
    await backend.terminate({ workerId: "seed-stop", backend: "alpha", nativeId: stoppedNative, state: "running", startedAt: 1 });
    const liveNative = await primeRunning(backend, "seed-live");
    await registry.provision({ workerId: "w-live", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");

    await store.save(
      [
        handle({ workerId: "w-ok", nativeId: okNative, state: "running" }),
        handle({ workerId: "w-terminal", nativeId: stoppedNative, state: "running" }),
        handle({ workerId: "w-live", backend: "alpha", nativeId: liveNative, state: "running" }),
        handle({ workerId: "w-ghost", backend: "gone", nativeId: "x", state: "running" }),
      ],
      {},
    );

    const result = await runReconcileAdoptCommand(["--adopt"], { registry: port, store });
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toMatch(/adopted:\s+1/);
    expect(text).toMatch(/conflicts:\s+1/);
    expect(text).toMatch(/dropped:\s+2/);
  });

  it("empty persisted fleet (zero handles) adopts to an empty, non-erroring report", async () => {
    const { port, store } = makeFixture();
    await store.save([], {});
    const result = await runReconcileAdoptCommand(["--adopt"], { registry: port, store });
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toMatch(/adopted:\s+0/);
    expect(text).toMatch(/corrected:\s+0/);
    expect(text).toMatch(/conflicts:\s+0/);
    expect(text).toMatch(/dropped:\s+0/);
  });
});
