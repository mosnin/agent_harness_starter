import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HANDLE_STORE_VERSION,
  HandleStore,
  type HandleStoreFs,
  type PersistedFleet,
} from "../handle-store";
import type { RemoteHandle } from "../backend";
import { RemoteBackendRegistry } from "../backend";
import { FakeBackend } from "../fake-backend";
import type { LifecycleState } from "../lifecycle";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handle-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function handle(overrides: Partial<RemoteHandle> = {}): RemoteHandle {
  return {
    workerId: "w1",
    backend: "fake",
    nativeId: "fake-1",
    endpoint: "https://fake-1.fake.local",
    state: "running",
    startedAt: 1000,
    ...overrides,
  };
}

// ===========================================================================
// save() / load() round trip on the real filesystem
// ===========================================================================

describe("HandleStore — save/load round trip (real fs)", () => {
  it("returns undefined when the file does not exist", async () => {
    const store = new HandleStore({ path: join(dir, "fleet.json") });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("auto-creates the parent directory on save", async () => {
    const path = join(dir, "nested", "deeper", "fleet.json");
    const store = new HandleStore({ path });
    await store.save([handle()], { w1: "running" });
    const loaded = await store.load();
    expect(loaded?.handles).toHaveLength(1);
  });

  it("round-trips handles and lifecycle exactly", async () => {
    const path = join(dir, "fleet.json");
    let t = 5000;
    const store = new HandleStore({ path, now: () => t });
    const handles = [handle({ workerId: "w1" }), handle({ workerId: "w2", nativeId: "fake-2", state: "hibernated" })];
    const lifecycle: Record<string, LifecycleState> = { w1: "running", w2: "hibernated" };
    await store.save(handles, lifecycle);

    const loaded = await store.load();
    expect(loaded).toBeDefined();
    expect(loaded!.version).toBe(HANDLE_STORE_VERSION);
    expect(loaded!.savedAt).toBe(5000);
    expect(loaded!.handles).toEqual(handles);
    expect(loaded!.lifecycle).toEqual(lifecycle);
  });

  it("save -> load -> save produces byte-identical canonical output", async () => {
    const path = join(dir, "fleet.json");
    const store = new HandleStore({ path, now: () => 9999 });
    const handles = [handle({ meta: { region: "us", z: 1, a: 2 } })];
    const lifecycle: Record<string, LifecycleState> = { w1: "running" };

    await store.save(handles, lifecycle);
    const bytes1 = await fsp.readFile(path, "utf8");

    const loaded = await store.load();
    await store.save(loaded!.handles, loaded!.lifecycle);
    const bytes2 = await fsp.readFile(path, "utf8");

    expect(bytes2).toBe(bytes1);
  });

  it("canonical JSON has stable (sorted) key order regardless of input property order", async () => {
    const path = join(dir, "fleet.json");
    const store = new HandleStore({ path, now: () => 1 });
    const h: RemoteHandle = {
      state: "running",
      workerId: "w1",
      startedAt: 1,
      nativeId: "n1",
      backend: "fake",
    };
    await store.save([h], {});
    const raw = await fsp.readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    // top-level keys sorted
    expect(Object.keys(parsed)).toEqual(["handles", "lifecycle", "savedAt", "version"]);
    // nested handle keys sorted
    expect(Object.keys(parsed.handles[0])).toEqual(["backend", "nativeId", "startedAt", "state", "workerId"]);
  });
});

// ===========================================================================
// Crash consistency via injected fs
// ===========================================================================

describe("HandleStore — crash consistency (injected fs)", () => {
  it("if rename throws AFTER the tmp write, the original file remains intact and readable", async () => {
    const path = join(dir, "fleet.json");
    const realFs: HandleStoreFs = {
      readFile: (p, enc) => fsp.readFile(p, enc),
      writeFile: (p, data, enc) => fsp.writeFile(p, data, enc),
      rename: (a, b) => fsp.rename(a, b),
      mkdir: async (p, opts) => {
        await fsp.mkdir(p, opts);
      },
      unlink: (p) => fsp.unlink(p),
    };

    // First, save a good baseline directly so `path` has real content.
    const goodStore = new HandleStore({ path, fs: realFs, now: () => 1 });
    await goodStore.save([handle({ workerId: "original" })], { original: "running" });
    const before = await fsp.readFile(path, "utf8");

    // Now wrap fs so rename always throws (tmp write still succeeds for real).
    const flakyFs: HandleStoreFs = {
      ...realFs,
      rename: async () => {
        throw new Error("simulated crash between tmp write and rename");
      },
    };
    const flakyStore = new HandleStore({ path, fs: flakyFs, now: () => 2 });

    await expect(
      flakyStore.save([handle({ workerId: "new-should-not-land" })], { "new-should-not-land": "running" }),
    ).rejects.toThrow(/simulated crash/);

    const after = await fsp.readFile(path, "utf8");
    expect(after).toBe(before);

    // The store built on the untouched file still loads the ORIGINAL fleet.
    const loaded = await goodStore.load();
    expect(loaded?.handles.map((h) => h.workerId)).toEqual(["original"]);

    // The tmp file written by the flaky attempt does exist (writeFile really
    // ran); only the rename step failed.
    const tmpContents = await fsp.readFile(`${path}.tmp`, "utf8");
    expect(JSON.parse(tmpContents).handles[0].workerId).toBe("new-should-not-land");
  });

  it("fully in-memory fake fs also proves atomic ordering (write then rename, nothing else)", async () => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const fakeFs: HandleStoreFs = {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) {
          const err = new Error(`ENOENT: no such file, open '${p}'`) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return v;
      },
      writeFile: async (p, data) => {
        calls.push(`write:${p}`);
        files.set(p, data);
      },
      rename: async (a, b) => {
        calls.push(`rename:${a}->${b}`);
        const v = files.get(a);
        if (v === undefined) throw new Error(`rename source missing: ${a}`);
        files.set(b, v);
        files.delete(a);
      },
      mkdir: async () => {
        calls.push("mkdir");
      },
      unlink: async (p) => {
        files.delete(p);
      },
    };
    const path = join(dir, "fleet.json");
    const store = new HandleStore({ path, fs: fakeFs, now: () => 7 });
    await store.save([handle()], { w1: "running" });
    expect(calls).toEqual(["mkdir", `write:${path}.tmp`, `rename:${path}.tmp->${path}`]);
  });
});

// ===========================================================================
// Defensive load() validation
// ===========================================================================

function fsWithContent(map: Record<string, string>): { fs: HandleStoreFs; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(map));
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

describe("HandleStore.load — defensive validation, never trusts disk bytes", () => {
  it("corrupt (unparseable) JSON is quarantined; load returns undefined; warning surfaced", async () => {
    const path = "/virtual/fleet.json";
    const { fs, files } = fsWithContent({ [path]: "{not json at all" });
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, now: () => 123, onWarn });

    await expect(store.load()).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/quarantined/);
    expect(files.has(path)).toBe(false);
    expect(files.has(`${path}.corrupt-123`)).toBe(true);
    expect(files.get(`${path}.corrupt-123`)).toBe("{not json at all");
  });

  it("truncated JSON is quarantined the same way", async () => {
    const path = "/virtual/fleet.json";
    const truncated = JSON.stringify({ version: 1, savedAt: 1, handles: [handle()], lifecycle: {} }).slice(0, 30);
    const { fs, files } = fsWithContent({ [path]: truncated });
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, now: () => 1, onWarn });

    await expect(store.load()).resolves.toBeUndefined();
    expect(files.has(`${path}.corrupt-1`)).toBe(true);
    expect(onWarn).toHaveBeenCalled();
  });

  it("valid JSON of the wrong shape (missing handles array) is quarantined", async () => {
    const path = "/virtual/fleet.json";
    const { fs, files } = fsWithContent({ [path]: JSON.stringify({ version: 1, savedAt: 1, lifecycle: {} }) });
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, now: () => 55, onWarn });

    await expect(store.load()).resolves.toBeUndefined();
    expect(files.has(`${path}.corrupt-55`)).toBe(true);
    expect(onWarn.mock.calls[0][0]).toMatch(/quarantined/);
  });

  it("wrong version is quarantined", async () => {
    const path = "/virtual/fleet.json";
    const { fs, files } = fsWithContent({
      [path]: JSON.stringify({ version: 99, savedAt: 1, handles: [], lifecycle: {} }),
    });
    const store = new HandleStore({ path, fs, now: () => 9 });

    await expect(store.load()).resolves.toBeUndefined();
    expect(files.has(`${path}.corrupt-9`)).toBe(true);
  });

  it("a non-object entry inside handles[] is dropped per-handle, not a whole-file crash", async () => {
    const path = "/virtual/fleet.json";
    const goodHandle = handle({ workerId: "good" });
    const { fs, files } = fsWithContent({
      [path]: JSON.stringify({
        version: 1,
        savedAt: 1,
        handles: [goodHandle, "not-an-object", 42, null, { workerId: "missing-fields" }],
        lifecycle: { good: "running" },
      }),
    });
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, now: () => 1, onWarn });

    const loaded = await store.load();
    expect(loaded).toBeDefined();
    expect(loaded!.handles).toEqual([goodHandle]);
    // File itself is NOT quarantined — the envelope was valid.
    expect(files.has(path)).toBe(true);
    expect(files.has(`${path}.corrupt-1`)).toBe(false);
    // But warnings were emitted for the dropped entries.
    expect(onWarn.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("lifecycle map entries with bad keys/values are dropped, valid ones survive", async () => {
    const path = "/virtual/fleet.json";
    const { fs } = fsWithContent({
      [path]: JSON.stringify({
        version: 1,
        savedAt: 1,
        handles: [],
        lifecycle: { w1: "running", w2: "not-a-real-state", "": "hibernated", w3: 42 },
      }),
    });
    const store = new HandleStore({ path, fs, now: () => 1 });
    const loaded = await store.load();
    expect(loaded!.lifecycle).toEqual({ w1: "running" });
  });

  it("read failure for a reason other than ENOENT returns undefined with a warning, no quarantine attempt", async () => {
    const path = "/virtual/fleet.json";
    const fs: HandleStoreFs = {
      readFile: async () => {
        throw new Error("EACCES: permission denied");
      },
      writeFile: async () => {},
      rename: async () => {},
      mkdir: async () => {},
      unlink: async () => {},
    };
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, onWarn });
    await expect(store.load()).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/EACCES/);
  });

  it("if the quarantine rename itself fails, load still returns undefined without throwing", async () => {
    const path = "/virtual/fleet.json";
    const fs: HandleStoreFs = {
      readFile: async () => "not json",
      writeFile: async () => {},
      rename: async () => {
        throw new Error("rename blocked");
      },
      mkdir: async () => {},
      unlink: async () => {},
    };
    const onWarn = vi.fn();
    const store = new HandleStore({ path, fs, onWarn });
    await expect(store.load()).resolves.toBeUndefined();
    expect(onWarn.mock.calls[0][0]).toMatch(/could not be quarantined/);
  });
});

// ===========================================================================
// reconcile() against the REAL RemoteBackendRegistry with FakeBackend
// ===========================================================================

describe("HandleStore.reconcile — real RemoteBackendRegistry + FakeBackend", () => {
  it("covers restored, corrected, and dropped (unknown backend, throwing probe, malformed entry) all in one fleet", async () => {
    const registry = new RemoteBackendRegistry();

    // Backend "alpha": reports the SAME state as stored -> pure restore.
    const alpha = new FakeBackend({ name: "alpha" });
    // Backend "beta": reports a DIFFERENT state than stored -> corrected.
    const beta = new FakeBackend({ name: "beta" });
    // Backend "gamma": status() throws -> dropped.
    const gamma = new FakeBackend({ name: "gamma" });
    vi.spyOn(gamma, "status").mockRejectedValue(new Error("gamma unreachable"));

    registry.register(alpha);
    registry.register(beta);
    registry.register(gamma);

    // Prime backends' internal state maps via a real provision, so status()
    // returns exactly what we expect for alpha/beta's nativeIds.
    const alphaHandle = await registry.provision({ workerId: "w-alpha", capabilities: [], managerUrl: "x", authToken: "t" }, "alpha");
    const betaHandle = await registry.provision({ workerId: "w-beta", capabilities: [], managerUrl: "x", authToken: "t" }, "beta");

    const store = new HandleStore({ path: join(dir, "unused.json") });

    const fleet: PersistedFleet = {
      version: HANDLE_STORE_VERSION,
      savedAt: 1,
      handles: [
        // matches live truth (alpha reports "running", stored says "running")
        { ...alphaHandle.handle, state: "running" },
        // stale: stored says "hibernated" but beta backend actually reports "running"
        { ...betaHandle.handle, state: "hibernated" },
        // unknown backend name
        handle({ workerId: "w-ghost", backend: "no-such-backend", nativeId: "ghost-1" }),
        // backend whose status() throws
        handle({ workerId: "w-gamma", backend: "gamma", nativeId: "gamma-1" }),
        // structurally malformed entry (not an object)
        "totally-not-a-handle" as unknown as RemoteHandle,
      ],
      lifecycle: {},
    };

    const report = await store.reconcile(fleet, registry);

    expect(report.restored.map((h) => h.workerId).sort()).toEqual(["w-alpha", "w-beta"]);
    const restoredAlpha = report.restored.find((h) => h.workerId === "w-alpha")!;
    expect(restoredAlpha.state).toBe("running");
    const restoredBeta = report.restored.find((h) => h.workerId === "w-beta")!;
    expect(restoredBeta.state).toBe("running"); // probed truth wins over stored "hibernated"

    expect(report.corrected).toEqual([{ workerId: "w-beta", stored: "hibernated", probed: "running" }]);

    const droppedIds = report.dropped.map((d) => d.workerId).sort();
    expect(droppedIds).toEqual(["<unknown>", "w-gamma", "w-ghost"]);
    const ghostDrop = report.dropped.find((d) => d.workerId === "w-ghost")!;
    expect(ghostDrop.reason).toMatch(/unknown backend/);
    const gammaDrop = report.dropped.find((d) => d.workerId === "w-gamma")!;
    expect(gammaDrop.reason).toMatch(/gamma unreachable/);
    const malformedDrop = report.dropped.find((d) => d.workerId === "<unknown>")!;
    expect(malformedDrop.reason).toMatch(/malformed handle entry/);
  });

  it("empty fleet reconciles to an empty report", async () => {
    const registry = new RemoteBackendRegistry();
    const store = new HandleStore({ path: join(dir, "unused.json") });
    const report = await store.reconcile({ version: HANDLE_STORE_VERSION, savedAt: 1, handles: [], lifecycle: {} }, registry);
    expect(report).toEqual({ restored: [], corrected: [], dropped: [] });
  });
});
