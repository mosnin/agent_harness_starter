import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  STATE_COMMAND_KINDS,
  STATE_EVENT_KINDS,
  isStateCommand,
  isStateEvent,
  isWorkspaceRecordView,
  isWorkspaceStatusView,
  type StateCommand,
  type StateEvent,
} from "../ipc/state-contract";
import { StateService } from "../core/state-service";
import { initialStateSlice, reduceState, stateSelectors, type StateSlice } from "../core/state-slice";

import { WorkspaceStore, WorkspaceCorruptError } from "../../hades/state/store";
import { InMemoryMirror, SyncEngine } from "../../hades/state/sync";
import { WorkspaceFeed } from "../../hades/state/feed";
import type { ActorId } from "../../hades/state/record";

// ===========================================================================
// Fixtures — REAL WorkspaceStore on a real temp dir. No mocked store
// anywhere in this file, exactly as the checkpoint requires; SyncEngine and
// WorkspaceFeed used below are the real Team 2 classes too.
// ===========================================================================

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-desktop-state-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkStore(actor: ActorId = { kind: "desktop", id: "svc" }, overrides: { fsync?: boolean; root?: string } = {}): WorkspaceStore {
  return new WorkspaceStore({ root: overrides.root ?? root, actor, fsync: overrides.fsync });
}

// ===========================================================================
// Contract guards — hostile input tables
// ===========================================================================

describe("state-contract: STATE_COMMAND_KINDS / STATE_EVENT_KINDS", () => {
  it("lists every StateCommand kind exactly once", () => {
    expect(new Set(STATE_COMMAND_KINDS).size).toBe(STATE_COMMAND_KINDS.length);
    expect(STATE_COMMAND_KINDS).toEqual([
      "state.status",
      "state.list",
      "state.get",
      "state.set",
      "state.delete",
      "state.sync",
      "state.watch",
    ]);
  });

  it("lists every StateEvent kind exactly once", () => {
    expect(new Set(STATE_EVENT_KINDS).size).toBe(STATE_EVENT_KINDS.length);
    expect(STATE_EVENT_KINDS).toEqual(["state.status", "state.records", "state.changed", "state.synced", "state.error"]);
  });
});

describe("isStateCommand: accepts every well-formed command", () => {
  const valid: StateCommand[] = [
    { kind: "state.status" },
    { kind: "state.list", domain: "memory" },
    { kind: "state.list", domain: "memory", prefix: "file:" },
    { kind: "state.get", domain: "sessions", key: "s1" },
    { kind: "state.set", domain: "config", key: "c1", value: { a: 1 } },
    { kind: "state.set", domain: "config", key: "c1", value: null },
    { kind: "state.delete", domain: "skills", key: "sk1" },
    { kind: "state.sync" },
    { kind: "state.sync", dryRun: true, policy: "prefer-local" },
    { kind: "state.watch", enabled: true },
  ];
  it.each(valid.map((v) => [JSON.stringify(v), v] as const))("accepts %s", (_label, v) => {
    expect(isStateCommand(v)).toBe(true);
  });
});

describe("isStateCommand: rejects hostile/malformed input", () => {
  const protoPollution: Record<string, unknown> = JSON.parse('{"kind":"state.status","__proto__":{"polluted":true}}');
  const table: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an array", ["state.status"]],
    ["a bare string", "state.status"],
    ["a number", 42],
    ["an object with no kind", { domain: "memory" }],
    ["an unknown kind", { kind: "state.nonexistent" }],
    ["state.list missing domain", { kind: "state.list" }],
    ["state.list with a numeric domain", { kind: "state.list", domain: 5 }],
    ["state.list with a non-string prefix", { kind: "state.list", domain: "memory", prefix: 7 }],
    ["state.get missing key", { kind: "state.get", domain: "memory" }],
    ["state.get with NaN key", { kind: "state.get", domain: "memory", key: NaN }],
    ["state.set missing value key entirely", { kind: "state.set", domain: "memory", key: "k" }],
    ["state.delete with a boolean domain", { kind: "state.delete", domain: true, key: "k" }],
    ["state.sync with a non-boolean dryRun", { kind: "state.sync", dryRun: "yes" }],
    ["state.sync with a numeric policy", { kind: "state.sync", policy: 1 }],
    ["state.watch missing enabled", { kind: "state.watch" }],
    ["state.watch with a string enabled", { kind: "state.watch", enabled: "true" }],
    ["a JSON.parse'd __proto__-polluting shape missing required fields", { kind: "state.set", __proto__: { polluted: true } }],
    ["the parsed prototype-pollution literal itself", protoPollution],
    ["a constructor-keyed hostile shape", { kind: "state.status", constructor: { evil: true } }],
  ];
  it.each(table)("rejects %s", (_label, v) => {
    expect(isStateCommand(v)).toBe(false);
  });

  it("never actually pollutes Object.prototype while rejecting hostile shapes", () => {
    isStateCommand(protoPollution);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("isStateEvent: accepts every well-formed event", () => {
  const status = { root: "/r", actor: "cli:x", journalSeq: 3, head: "abc", chainOk: true, perDomain: [{ domain: "memory", records: 1, lastUpdatedAt: 5 }], lastSyncAt: null, conflicts: 0 };
  const record = { domain: "memory", key: "k", rev: 1, updatedAt: 1, actor: "cli:x", deleted: false, hash: "h", value: { a: 1 } };
  const valid: StateEvent[] = [
    { kind: "state.status", status },
    { kind: "state.records", domain: "memory", records: [] },
    { kind: "state.records", domain: "memory", records: [record] },
    { kind: "state.changed", seq: 1, actor: "cli:x", records: [record] },
    { kind: "state.synced", pulled: 0, pushed: 0, conflicts: [], dryRun: false, at: 1 },
    {
      kind: "state.synced",
      pulled: 1,
      pushed: 2,
      conflicts: [{ domain: "memory", key: "k", localActor: "cli:a", remoteActor: "cli:b", resolution: "local", reason: "r" }],
      dryRun: true,
      at: 1,
    },
    { kind: "state.error", op: "state.set", message: "boom" },
  ];
  it.each(valid.map((v) => [JSON.stringify(v).slice(0, 60), v] as const))("accepts %s", (_label, v) => {
    expect(isStateEvent(v)).toBe(true);
  });
});

describe("isStateEvent: rejects hostile/malformed input", () => {
  const table: Array<[string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["a bare number", 1],
    ["missing kind", {}],
    ["an unknown kind", { kind: "state.bogus" }],
    ["state.status with a malformed status (missing perDomain)", { kind: "state.status", status: { root: "", actor: "", journalSeq: 0, head: "", chainOk: true, lastSyncAt: null, conflicts: 0 } }],
    ["state.status with status.conflicts as a negative number", { kind: "state.status", status: { root: "", actor: "", journalSeq: 0, head: "", chainOk: true, perDomain: [], lastSyncAt: null, conflicts: -1 } }],
    ["state.records with a non-array records", { kind: "state.records", domain: "memory", records: "nope" }],
    ["state.records with one malformed record (missing hash)", { kind: "state.records", domain: "memory", records: [{ domain: "memory", key: "k", rev: 1, updatedAt: 1, actor: "a", deleted: false, value: 1 }] }],
    ["state.changed with a non-integer seq", { kind: "state.changed", seq: 1.5, actor: "a", records: [] }],
    ["state.changed with a negative seq", { kind: "state.changed", seq: -1, actor: "a", records: [] }],
    ["state.synced with an invalid resolution value", { kind: "state.synced", pulled: 0, pushed: 0, conflicts: [{ domain: "d", key: "k", localActor: "a", remoteActor: "b", resolution: "bogus", reason: "r" }], dryRun: false, at: 1 }],
    ["state.synced with dryRun as a string", { kind: "state.synced", pulled: 0, pushed: 0, conflicts: [], dryRun: "false", at: 1 }],
    ["state.error missing message", { kind: "state.error", op: "x" }],
    ["a __proto__-polluting state.records shape missing domain", { kind: "state.records", __proto__: { polluted: true }, records: [] }],
  ];
  it.each(table)("rejects %s", (_label, v) => {
    expect(isStateEvent(v)).toBe(false);
  });
});

describe("isWorkspaceRecordView / isWorkspaceStatusView: hostile input", () => {
  const goodRecord = { domain: "memory", key: "k", rev: 1, updatedAt: 1, actor: "cli:x", deleted: false, hash: "h", value: 1 };
  const recordTable: Array<[string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["missing rev", { domain: "memory", key: "k", updatedAt: 1, actor: "cli:x", deleted: false, hash: "h", value: 1 }],
    ["rev as NaN", { ...goodRecord, rev: NaN }],
    ["deleted as a string", { ...goodRecord, deleted: "true" }],
    ["missing value entirely (not even undefined-assigned)", (() => { const c = { ...goodRecord } as Record<string, unknown>; delete c.value; return c; })()],
    ["hash as a number", { ...goodRecord, hash: 5 }],
    // A literal `{ ...obj, __proto__: x }` REASSIGNS the prototype rather
    // than creating an own property (that's ordinary JS semantics, not an
    // attack) — the genuine hostile shape is an OWN property literally
    // named "__proto__", exactly what `JSON.parse` produces for that key.
    ["a JSON.parse'd own-property named __proto__", JSON.parse(`{"domain":"memory","key":"k","rev":1,"updatedAt":1,"actor":"cli:x","deleted":false,"hash":"h","value":1,"__proto__":{"polluted":true}}`)],
    ["a constructor-keyed variant", { ...goodRecord, constructor: { polluted: true } }],
    ["domain as a number", { ...goodRecord, domain: 1 }],
  ];
  it.each(recordTable)("isWorkspaceRecordView rejects %s", (_label, v) => {
    expect(isWorkspaceRecordView(v)).toBe(false);
  });
  it("isWorkspaceRecordView accepts a well-formed record view, including a null value", () => {
    expect(isWorkspaceRecordView(goodRecord)).toBe(true);
    expect(isWorkspaceRecordView({ ...goodRecord, value: null })).toBe(true);
  });

  const goodStatus = { root: "/r", actor: "cli:x", journalSeq: 0, head: "", chainOk: true, perDomain: [], lastSyncAt: null, conflicts: 0 };
  const statusTable: Array<[string, unknown]> = [
    ["null", null],
    ["journalSeq as a negative number", { ...goodStatus, journalSeq: -1 }],
    ["journalSeq as a non-integer", { ...goodStatus, journalSeq: 1.2 }],
    ["chainOk as a string", { ...goodStatus, chainOk: "true" }],
    ["perDomain as a non-array", { ...goodStatus, perDomain: {} }],
    ["perDomain with a malformed entry", { ...goodStatus, perDomain: [{ domain: "memory", records: -1, lastUpdatedAt: 0 }] }],
    ["lastSyncAt as a string", { ...goodStatus, lastSyncAt: "never" }],
    ["conflicts as a negative number", { ...goodStatus, conflicts: -1 }],
    ["missing root", (() => { const c = { ...goodStatus } as Record<string, unknown>; delete c.root; return c; })()],
    ["a JSON.parse'd own-property named __proto__", JSON.parse(`{"root":"/r","actor":"cli:x","journalSeq":0,"head":"","chainOk":true,"perDomain":[],"lastSyncAt":null,"conflicts":0,"__proto__":{"polluted":true}}`)],
  ];
  it.each(statusTable)("isWorkspaceStatusView rejects %s", (_label, v) => {
    expect(isWorkspaceStatusView(v)).toBe(false);
  });
  it("isWorkspaceStatusView accepts a well-formed status view, including lastSyncAt as a real number", () => {
    expect(isWorkspaceStatusView(goodStatus)).toBe(true);
    expect(isWorkspaceStatusView({ ...goodStatus, lastSyncAt: 123 })).toBe(true);
  });
});

// ===========================================================================
// StateService — status / list / get / set / delete against a REAL store
// ===========================================================================

describe("StateService: state.status", () => {
  it("reports journalSeq/head/chainOk/perDomain honestly against a real store", async () => {
    const store = mkStore();
    store.put("memory", "fact1", { text: "hello" });
    store.put("sessions", "s1", { id: "s1" });
    const svc = new StateService({ store });

    const events = await svc.handle({ kind: "state.status" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("state.status");
    const status = (events[0] as Extract<StateEvent, { kind: "state.status" }>).status;
    expect(status.journalSeq).toBe(2);
    expect(status.chainOk).toBe(true);
    expect(status.head).not.toBe("");
    expect(status.lastSyncAt).toBeNull();
    expect(status.conflicts).toBe(0);
    const memoryEntry = status.perDomain.find((d) => d.domain === "memory")!;
    expect(memoryEntry.records).toBe(1);
    expect(memoryEntry.lastUpdatedAt).toBeGreaterThan(0);
    const configEntry = status.perDomain.find((d) => d.domain === "config")!;
    expect(configEntry.records).toBe(0);
    expect(configEntry.lastUpdatedAt).toBe(0);
    expect(isWorkspaceStatusView(status)).toBe(true);
    svc.close();
  });

  it("reports the store's REAL actor identity, not a placeholder", async () => {
    const store = mkStore({ kind: "desktop", id: "identity-check" });
    const svc = new StateService({ store });
    const events = await svc.handle({ kind: "state.status" });
    const status = (events[0] as Extract<StateEvent, { kind: "state.status" }>).status;
    expect(status.actor).toBe("desktop:identity-check");
    expect(status.root).toBe(root);
    svc.close();
  });

  it("a corrupt journal degrades to an honest state.error, never a throw or a fabricated status", async () => {
    const store = mkStore();
    store.put("memory", "a", 1);
    store.put("memory", "b", 2);
    store.close();

    const journalPath = join(root, "journal.log");
    const lines = readFileSync(journalPath, "utf8").trimEnd().split("\n");
    lines[0] = "{this is not valid json at all";
    writeFileSync(journalPath, lines.join("\n") + "\n", "utf8");

    const reopened = mkStore({ kind: "test", id: "verifier" });
    const svc = new StateService({ store: reopened });
    const events = await svc.handle({ kind: "state.status" });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("state.error");
    const err = events[0] as Extract<StateEvent, { kind: "state.error" }>;
    expect(err.op).toBe("state.status");
    expect(err.message.toLowerCase()).toContain("journal");
    svc.close();
    reopened.close();
  });
});

describe("StateService: state.list pagination", () => {
  it("paginates a many-record domain into ordered pages with no loss or duplication", async () => {
    const store = mkStore({ kind: "desktop", id: "pager" }, { fsync: false });
    const N = 10_000;
    const CHUNK = 500;
    for (let i = 0; i < N / CHUNK; i++) {
      store.putMany(
        Array.from({ length: CHUNK }, (_, j) => ({ domain: "memory" as const, key: `k${String(i * CHUNK + j).padStart(6, "0")}`, value: i * CHUNK + j })),
      );
    }
    const svc = new StateService({ store, maxRecordsPerEvent: 1000 });

    const events = await svc.handle({ kind: "state.list", domain: "memory" });
    expect(events.every((e) => e.kind === "state.records")).toBe(true);
    const pages = events as Array<Extract<StateEvent, { kind: "state.records" }>>;
    expect(pages).toHaveLength(10);
    for (const p of pages.slice(0, -1)) expect(p.records).toHaveLength(1000);

    const seenKeys = new Set<string>();
    for (const p of pages) {
      for (const r of p.records) {
        expect(seenKeys.has(r.key)).toBe(false); // no duplication across pages
        seenKeys.add(r.key);
      }
    }
    expect(seenKeys.size).toBe(N); // no loss
    svc.close();
  }, 30_000);

  it("an empty domain returns a single empty state.records event, not zero events", async () => {
    const svc = new StateService({ store: mkStore() });
    const events = await svc.handle({ kind: "state.list", domain: "config" });
    expect(events).toEqual([{ kind: "state.records", domain: "config", records: [] }]);
  });

  it("prefix filtering is honoured and an unknown domain is an honest state.error", async () => {
    const store = mkStore();
    store.put("memory", "file:a.txt", "A");
    store.put("memory", "note-1", "N");
    const svc = new StateService({ store });

    const filtered = await svc.handle({ kind: "state.list", domain: "memory", prefix: "file:" });
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as Extract<StateEvent, { kind: "state.records" }>).records.map((r) => r.key)).toEqual(["file:a.txt"]);

    const bad = await svc.handle({ kind: "state.list", domain: "not-a-real-domain" });
    expect(bad).toEqual([{ kind: "state.error", op: "state.list", message: expect.stringContaining("unknown workspace domain") }]);
  });
});

describe("StateService: state.get", () => {
  it("returns the exact real record content on a hit, and an empty array on a miss", async () => {
    const store = mkStore();
    store.put("sessions", "s1", { id: "s1", messages: [{ role: "user", content: "hi there", at: 1 }] });
    const svc = new StateService({ store });

    const hit = await svc.handle({ kind: "state.get", domain: "sessions", key: "s1" });
    expect(hit).toHaveLength(1);
    const view = (hit[0] as Extract<StateEvent, { kind: "state.records" }>).records[0];
    expect(view.value).toEqual({ id: "s1", messages: [{ role: "user", content: "hi there", at: 1 }] });
    expect(view.deleted).toBe(false);
    expect(isWorkspaceRecordView(view)).toBe(true);

    const miss = await svc.handle({ kind: "state.get", domain: "sessions", key: "nope" });
    expect(miss).toEqual([{ kind: "state.records", domain: "sessions", records: [] }]);
  });
});

describe("StateService: state.set", () => {
  it("writes through to the real store and echoes the written record", async () => {
    const store = mkStore();
    const svc = new StateService({ store });
    const events = await svc.handle({ kind: "state.set", domain: "memory", key: "fact1", value: { fact: "the sky is blue" } });
    expect(events).toHaveLength(1);
    const view = (events[0] as Extract<StateEvent, { kind: "state.records" }>).records[0];
    expect(view.value).toEqual({ fact: "the sky is blue" });
    expect(store.get("memory", "fact1")!.value).toEqual({ fact: "the sky is blue" });
  });

  it("rejects an unknown domain without ever touching the store", async () => {
    const store = mkStore();
    const svc = new StateService({ store });
    const events = await svc.handle({ kind: "state.set", domain: "bogus", key: "k", value: 1 });
    expect(events[0]).toMatchObject({ kind: "state.error", op: "state.set" });
    expect(store.list("memory", {})).toHaveLength(0);
  });

  it("rejects a cyclic value with a precise error, never crashing or corrupting the store", async () => {
    const store = mkStore();
    const svc = new StateService({ store });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const events = await svc.handle({ kind: "state.set", domain: "memory", key: "cyc", value: cyclic });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("state.error");
    expect((events[0] as Extract<StateEvent, { kind: "state.error" }>).message).toContain("not a valid JSON value");
    expect(store.get("memory", "cyc")).toBeUndefined();
  });

  it("rejects NaN/Infinity/undefined-bearing values", async () => {
    const store = mkStore();
    const svc = new StateService({ store });
    for (const bad of [{ n: NaN }, { n: Infinity }, { n: -Infinity }, [undefined], { fn: () => 1 }]) {
      const events = await svc.handle({ kind: "state.set", domain: "memory", key: "k", value: bad });
      expect(events[0].kind).toBe("state.error");
    }
    expect(store.get("memory", "k")).toBeUndefined();
  });

  it("rejects a value exceeding the configured size cap, without writing it", async () => {
    const store = mkStore();
    const svc = new StateService({ store, maxValueBytes: 64 });
    const events = await svc.handle({ kind: "state.set", domain: "memory", key: "big", value: { text: "x".repeat(200) } });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("state.error");
    expect((events[0] as Extract<StateEvent, { kind: "state.error" }>).message).toContain("size cap");
    expect(store.get("memory", "big")).toBeUndefined();
  });

  it("a value at or under the cap is accepted", async () => {
    const store = mkStore();
    const svc = new StateService({ store, maxValueBytes: 200 });
    const events = await svc.handle({ kind: "state.set", domain: "memory", key: "ok", value: { text: "short" } });
    expect(events[0].kind).toBe("state.records");
  });
});

describe("StateService: state.delete", () => {
  it("tombstones a live record and reports the real tombstone view", async () => {
    const store = mkStore();
    store.put("skills", "sk1", { name: "sk1" });
    const svc = new StateService({ store });
    const events = await svc.handle({ kind: "state.delete", domain: "skills", key: "sk1" });
    const view = (events[0] as Extract<StateEvent, { kind: "state.records" }>).records[0];
    expect(view.deleted).toBe(true);
    expect(view.value).toBeNull();
    expect(view.hash).toBe("");
    expect(store.get("skills", "sk1")!.deleted).toBe(true);
  });

  it("deleting a nonexistent key is an honest no-op (empty records array, no error)", async () => {
    const store = mkStore();
    const svc = new StateService({ store });
    const events = await svc.handle({ kind: "state.delete", domain: "skills", key: "never-existed" });
    expect(events).toEqual([{ kind: "state.records", domain: "skills", records: [] }]);
  });
});

// ===========================================================================
// StateService — state.sync against a REAL SyncEngine over a REAL store
// ===========================================================================

describe("StateService: state.sync", () => {
  it("without a configured sync engine, reports an honest state.error", async () => {
    const svc = new StateService({ store: mkStore() });
    const events = await svc.handle({ kind: "state.sync" });
    expect(events).toEqual([{ kind: "state.error", op: "state.sync", message: expect.stringContaining("not configured") }]);
  });

  it("rejects an unrecognized policy string before ever touching the engine", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const mirror = new InMemoryMirror();
    const sync = new SyncEngine({ store, mirror, actor: { kind: "desktop", id: "d1" } });
    const svc = new StateService({ store, sync });
    const events = await svc.handle({ kind: "state.sync", policy: "not-a-real-policy" });
    expect(events[0]).toMatchObject({ kind: "state.error", op: "state.sync" });
  });

  it("pulls a real foreign write into the mirror and reports it honestly", async () => {
    const storeLocal = mkStore({ kind: "desktop", id: "d1" });
    // A second, independent WorkspaceStore instance over the SAME root,
    // authored by a different real actor — simulating what another process
    // (e.g. the `hades state` CLI) would have written.
    const storeForeign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    storeForeign.put("memory", "foreign-fact", { text: "written elsewhere" });

    const mirror = new InMemoryMirror();
    const sync = new SyncEngine({ store: storeLocal, mirror, actor: { kind: "desktop", id: "d1" } });
    const svc = new StateService({ store: storeLocal, sync });

    const events = await svc.handle({ kind: "state.sync" });
    expect(events).toHaveLength(1);
    const synced = events[0] as Extract<StateEvent, { kind: "state.synced" }>;
    expect(synced.pulled).toBe(1);
    expect(synced.pushed).toBe(0);
    expect(synced.conflicts).toEqual([]);
    expect(synced.dryRun).toBe(false);
    expect(mirror.snapshot().find((r) => r.key === "foreign-fact")?.value).toEqual({ text: "written elsewhere" });

    const status = (await svc.handle({ kind: "state.status" }))[0] as Extract<StateEvent, { kind: "state.status" }>;
    expect((status.status.lastSyncAt as number)).toBe(synced.at);
    storeForeign.close();
  });

  it("dryRun never writes: a second identical dry-run reports the same plan", async () => {
    const storeLocal = mkStore({ kind: "desktop", id: "d1" });
    const storeForeign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    storeForeign.put("memory", "k", "v");
    const mirror = new InMemoryMirror();
    const sync = new SyncEngine({ store: storeLocal, mirror, actor: { kind: "desktop", id: "d1" } });
    const svc = new StateService({ store: storeLocal, sync });

    const first = (await svc.handle({ kind: "state.sync", dryRun: true }))[0] as Extract<StateEvent, { kind: "state.synced" }>;
    const second = (await svc.handle({ kind: "state.sync", dryRun: true }))[0] as Extract<StateEvent, { kind: "state.synced" }>;
    expect(first.pulled).toBe(1);
    expect(second.pulled).toBe(1); // plan() writes nothing, so re-planning sees the same thing
    expect(mirror.snapshot()).toHaveLength(0); // truly never applied
    storeForeign.close();
  });

  it("a genuine concurrent conflict is resolved and reported with real actor identities", async () => {
    const storeLocal = mkStore({ kind: "desktop", id: "d1" });
    const storeForeign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    storeForeign.put("config", "shared", "from-foreign");

    const mirror = new InMemoryMirror();
    // Pull first so the mirror's copy shares causal history with the store's
    // record, then stage a LOCAL edit on top of it without pulling again —
    // that is a genuine local-newer edit, not a conflict, so instead we
    // race: stage a local edit BEFORE ever pulling, so neither side's clock
    // dominates the other once the foreign write above already landed.
    mirror.stage("config", "shared", "from-local");

    const sync = new SyncEngine({ store: storeLocal, mirror, actor: { kind: "desktop", id: "d1" }, policy: "prefer-remote" });
    const svc = new StateService({ store: storeLocal, sync });
    const events = await svc.handle({ kind: "state.sync", policy: "prefer-remote" });
    const synced = events[0] as Extract<StateEvent, { kind: "state.synced" }>;
    expect(synced.conflicts.length).toBeGreaterThan(0);
    const conflict = synced.conflicts[0];
    expect(conflict.domain).toBe("config");
    expect(conflict.key).toBe("shared");
    expect(conflict.remoteActor).toBe("cli:other");
    expect(["local", "remote"]).toContain(conflict.resolution);
    storeForeign.close();
  });
});

// ===========================================================================
// StateService — subscribe() / state.watch against a REAL WorkspaceFeed
// ===========================================================================

describe("StateService: state.watch + subscribe over a REAL WorkspaceFeed", () => {
  it("without a configured feed, state.watch reports an honest state.error", async () => {
    const svc = new StateService({ store: mkStore() });
    const events = await svc.handle({ kind: "state.watch", enabled: true });
    expect(events).toEqual([{ kind: "state.error", op: "state.watch", message: expect.stringContaining("not configured") }]);
  });

  it("delivers foreign writes as ordered state.changed events with real content", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:test", watch: false });
    const svc = new StateService({ store, feed });

    const received: StateEvent[] = [];
    const unsub = svc.subscribe((e) => received.push(e));

    const foreign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    foreign.put("memory", "k1", "v1");
    foreign.put("memory", "k2", "v2");

    feed.poll(); // deterministic: this test drives delivery itself rather than racing a timer

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.kind === "state.changed")).toBe(true);
    const changes = received as Array<Extract<StateEvent, { kind: "state.changed" }>>;
    expect(changes[0].seq).toBeLessThan(changes[1].seq);
    expect(changes[0].actor).toBe("cli:other");
    expect(changes[0].records[0].key).toBe("k1");
    expect(changes[0].records[0].value).toBe("v1");
    expect(changes[1].records[0].key).toBe("k2");
    expect(changes[1].records[0].value).toBe("v2");

    unsub();
    foreign.put("memory", "k3", "v3");
    feed.poll();
    expect(received).toHaveLength(2); // unsubscribed listener receives nothing further

    foreign.close();
    svc.close();
  });

  it("a throwing listener never stops delivery to other listeners", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:throw-test", watch: false });
    const svc = new StateService({ store, feed });

    const good: StateEvent[] = [];
    svc.subscribe(() => {
      throw new Error("listener A always throws");
    });
    svc.subscribe((e) => good.push(e));

    const foreign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    foreign.put("memory", "k", "v");

    expect(() => feed.poll()).not.toThrow();
    expect(good).toHaveLength(1);

    foreign.close();
    svc.close();
  });

  it("re-entrant subscribe/unsubscribe during dispatch never corrupts delivery", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:reentrant-test", watch: false });
    const svc = new StateService({ store, feed });

    const order: string[] = [];
    let unsubB: (() => void) | undefined;
    svc.subscribe(() => {
      order.push("A");
      unsubB?.(); // unsubscribes B from inside A's own callback, mid-dispatch
    });
    unsubB = svc.subscribe(() => order.push("B"));
    svc.subscribe(() => order.push("C"));

    const foreign = new WorkspaceStore({ root, actor: { kind: "cli", id: "other" } });
    foreign.put("memory", "k", "v");
    feed.poll();

    // B was still subscribed at the moment this dispatch's snapshot was
    // taken, so it legitimately may or may not fire for THIS delivery, but
    // A and C must always both fire and nothing may throw.
    expect(order).toContain("A");
    expect(order).toContain("C");

    order.length = 0;
    foreign.put("memory", "k2", "v2");
    feed.poll();
    expect(order).toContain("A");
    expect(order).not.toContain("B"); // truly unsubscribed by the previous dispatch
    expect(order).toContain("C");

    foreign.close();
    svc.close();
  });

  it("state.watch{enabled:true} starts the real feed and close() tears it down completely (asserted on the feed's own internals)", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:lifecycle-test", watch: false, pollMs: 5 });
    const svc = new StateService({ store, feed });

    const feedInternals = feed as unknown as { started: boolean; intervalHandle: unknown };
    expect(feedInternals.started).toBe(false);

    const started = await svc.handle({ kind: "state.watch", enabled: true });
    expect(started).toEqual([]);
    expect(feedInternals.started).toBe(true);
    expect(feedInternals.intervalHandle).toBeDefined();

    svc.close();
    expect(feedInternals.started).toBe(false);
    expect(feedInternals.intervalHandle).toBeUndefined();
  });

  it("state.watch{enabled:false} stops the feed without closing the service", async () => {
    const store = mkStore({ kind: "desktop", id: "d1" });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:stop-test", watch: false, pollMs: 5 });
    const svc = new StateService({ store, feed });
    await svc.handle({ kind: "state.watch", enabled: true });
    const stopped = await svc.handle({ kind: "state.watch", enabled: false });
    expect(stopped).toEqual([]);
    expect((feed as unknown as { started: boolean }).started).toBe(false);
    svc.close();
  });
});

// ===========================================================================
// state-slice — pure reducer
// ===========================================================================

describe("state-slice: initialStateSlice / reduceState purity", () => {
  const record = { domain: "memory", key: "k1", rev: 1, updatedAt: 10, actor: "cli:a", deleted: false, hash: "h1", value: { fact: "hi" } };
  const status = { root: "/r", actor: "desktop:d1", journalSeq: 1, head: "h", chainOk: true, perDomain: [], lastSyncAt: null, conflicts: 0 };

  it("initialStateSlice() starts empty", () => {
    const s = initialStateSlice();
    expect(s).toEqual({ status: null, byDomain: {}, conflicts: [], lastChangeSeq: 0, lastError: null, changeLog: [] });
  });

  it("state.status replaces status without mutating the input slice", () => {
    const before = Object.freeze(initialStateSlice());
    const after = reduceState(before, { kind: "state.status", status });
    expect(after.status).toEqual(status);
    expect(before.status).toBeNull();
  });

  it("state.records upserts by key without dropping other domains or other keys", () => {
    let s = initialStateSlice();
    s = reduceState(s, { kind: "state.records", domain: "memory", records: [record] });
    s = reduceState(s, { kind: "state.records", domain: "sessions", records: [{ ...record, domain: "sessions", key: "s1" }] });
    expect(stateSelectors.domainRecords(s, "memory")).toEqual([record]);
    expect(stateSelectors.domainRecords(s, "sessions")).toHaveLength(1);

    const updated = { ...record, rev: 2, value: { fact: "updated" } };
    s = reduceState(s, { kind: "state.records", domain: "memory", records: [updated] });
    expect(stateSelectors.domainRecords(s, "memory")).toEqual([updated]); // same key -> replaced, not duplicated
    expect(stateSelectors.domainRecords(s, "sessions")).toHaveLength(1); // untouched
  });

  it("multiple ordered state.records pages for one state.list merge with no loss or duplication", () => {
    let s = initialStateSlice();
    const page1 = [record, { ...record, key: "k2" }];
    const page2 = [{ ...record, key: "k3" }, { ...record, key: "k4" }];
    s = reduceState(s, { kind: "state.records", domain: "memory", records: page1 });
    s = reduceState(s, { kind: "state.records", domain: "memory", records: page2 });
    expect(stateSelectors.domainRecords(s, "memory").map((r) => r.key).sort()).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("state.changed advances lastChangeSeq monotonically and tolerates duplicates/out-of-order delivery", () => {
    let s = initialStateSlice();
    s = reduceState(s, { kind: "state.changed", seq: 5, actor: "cli:a", records: [record] });
    expect(s.lastChangeSeq).toBe(5);
    // duplicate delivery of the same seq
    s = reduceState(s, { kind: "state.changed", seq: 5, actor: "cli:a", records: [record] });
    expect(s.lastChangeSeq).toBe(5);
    expect(stateSelectors.domainRecords(s, "memory")).toHaveLength(1); // idempotent, not duplicated
    // an OLDER seq arriving late never moves lastChangeSeq backwards
    s = reduceState(s, { kind: "state.changed", seq: 2, actor: "cli:a", records: [{ ...record, key: "stale" }] });
    expect(s.lastChangeSeq).toBe(5);
    expect(stateSelectors.domainRecords(s, "memory")).toHaveLength(2); // still applied as data, just doesn't rewind the cursor
  });

  it("changeLog is capped at 200 entries, dropping the oldest first", () => {
    let s = initialStateSlice();
    for (let i = 1; i <= 250; i++) {
      s = reduceState(s, { kind: "state.changed", seq: i, actor: "cli:a", records: [{ ...record, key: `k${i}` }] });
    }
    expect(s.changeLog).toHaveLength(200);
    expect(s.changeLog[0].seq).toBe(51); // oldest 50 dropped
    expect(s.changeLog[199].seq).toBe(250);
  });

  it("state.synced replaces the conflicts list", () => {
    let s = initialStateSlice();
    const conflict = { domain: "config", key: "shared", localActor: "desktop:d1", remoteActor: "cli:other", resolution: "remote" as const, reason: "r" };
    s = reduceState(s, { kind: "state.synced", pulled: 1, pushed: 0, conflicts: [conflict], dryRun: false, at: 1 });
    expect(stateSelectors.hasConflicts(s)).toBe(true);
    s = reduceState(s, { kind: "state.synced", pulled: 0, pushed: 0, conflicts: [], dryRun: false, at: 2 });
    expect(stateSelectors.hasConflicts(s)).toBe(false);
  });

  it("state.error records the last error without touching other fields", () => {
    let s = initialStateSlice();
    s = reduceState(s, { kind: "state.records", domain: "memory", records: [record] });
    s = reduceState(s, { kind: "state.error", op: "state.set", message: "boom" });
    expect(s.lastError).toEqual({ op: "state.set", message: "boom" });
    expect(stateSelectors.domainRecords(s, "memory")).toEqual([record]); // untouched
  });

  it("an unrecognized event kind returns the identical slice reference, never a copy", () => {
    const s = initialStateSlice();
    const hostile = { kind: "state.totally-unknown" } as unknown as StateEvent;
    const next = reduceState(s, hostile);
    expect(next).toBe(s); // reference equality, not just deep equality
  });

  it("is provably pure: same (slice, event) in -> deep-equal result, and the input slice is never mutated (frozen input)", () => {
    const frozenSlice: StateSlice = Object.freeze({
      status: null,
      byDomain: Object.freeze({ memory: Object.freeze([record]) }) as unknown as Record<string, typeof record[]>,
      conflicts: Object.freeze([]) as unknown as StateSlice["conflicts"],
      lastChangeSeq: 3,
      lastError: null,
      changeLog: Object.freeze([]) as unknown as StateSlice["changeLog"],
    });
    const ev: StateEvent = { kind: "state.changed", seq: 4, actor: "cli:b", records: [{ ...record, key: "k9" }] };
    // The clock is an ARGUMENT, not an ambient read — that is what makes this
    // a purity test rather than a race. (Before `now` was injectable this
    // assertion passed only when both calls landed in the same millisecond,
    // and genuinely failed when they straddled a tick.)
    const clock = () => 1_700_000_000_000;
    const r1 = reduceState(frozenSlice, ev, clock);
    const r2 = reduceState(frozenSlice, ev, clock);
    expect(r1).toEqual(r2);
    expect(r1.changeLog[0].at).toBe(1_700_000_000_000);
    expect(frozenSlice.lastChangeSeq).toBe(3); // still untouched
    expect(stateSelectors.domainRecords(frozenSlice, "memory")).toEqual([record]);
  });

  it("reads no ambient clock: the changeLog timestamp comes only from the injected `now`", () => {
    let ticks = 0;
    const clock = () => {
      ticks += 1;
      return 42;
    };
    const s = reduceState(
      initialStateSlice(),
      { kind: "state.changed", seq: 1, actor: "cli:b", records: [record] },
      clock,
    );
    expect(s.changeLog).toEqual([{ seq: 1, actor: "cli:b", keys: [`${record.domain}/${record.key}`], at: 42 }]);
    expect(ticks).toBe(1);

    // Events that carry no timestamp must not call the clock at all.
    ticks = 0;
    reduceState(initialStateSlice(), { kind: "state.error", op: "x", message: "y" }, clock);
    reduceState(initialStateSlice(), { kind: "state.records", domain: "memory", records: [record] }, clock);
    expect(ticks).toBe(0);
  });

  it("selectors: recordCount excludes tombstones, foreignWrites counts non-self actors", () => {
    let s = initialStateSlice();
    s = reduceState(s, { kind: "state.records", domain: "memory", records: [record, { ...record, key: "k2", deleted: true, value: null, hash: "" }] });
    expect(stateSelectors.recordCount(s)).toBe(1);
    s = reduceState(s, { kind: "state.changed", seq: 1, actor: "cli:other", records: [record] });
    s = reduceState(s, { kind: "state.changed", seq: 2, actor: "desktop:self", records: [record] });
    expect(stateSelectors.foreignWrites(s, "desktop:self")).toBe(1);
  });
});
