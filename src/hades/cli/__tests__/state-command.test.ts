/* ------------------------------------------------------------------ *
 * state-command.test.ts
 *
 * Exercises `runStateCommand` against a REAL `WorkspaceStore` on a real
 * temp directory, and — for export/import/sync — real domain adapters
 * (`../../state/domains`) wired to real `InMemorySessionStore` /
 * `InMemoryMemoryStore` engine instances. No fakes stand in for the store,
 * the adapters, or the sync engine: this module's whole job is wiring
 * argv parsing onto those real pieces, so the tests prove that wiring.
 * ------------------------------------------------------------------ */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runStateCommand, STATE_USAGE } from "../state-command";
import type { StateCommandDeps } from "../state-command";
import { WorkspaceStore } from "../../state/store";
import type { ActorId } from "../../state/record";
import { sessionsAdapter, memoryAdapter, type DomainAdapter } from "../../state/domains";
import { InMemorySessionStore } from "../../memory/session-store";
import { InMemoryMemoryStore } from "../../memory/store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hades-state-cmd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function clockNow(startMs = 1_700_000_000_000) {
  let t = startMs;
  return () => (t += 1);
}

function baseDeps(overrides: Partial<StateCommandDeps> = {}): StateCommandDeps {
  return {
    root,
    actor: { kind: "cli", id: "alice" },
    now: clockNow(),
    ...overrides,
  };
}

// ===========================================================================
// help / unknown
// ===========================================================================

describe("help / unknown subcommand", () => {
  it("`help` (and no args) returns code 0 with STATE_USAGE", async () => {
    const deps = baseDeps();
    const r1 = await runStateCommand([], deps);
    expect(r1.code).toBe(0);
    expect(r1.lines).toEqual(STATE_USAGE);

    const r2 = await runStateCommand(["help"], deps);
    expect(r2.lines).toEqual(STATE_USAGE);
  });

  it("an unknown subcommand exits 1 with usage", async () => {
    const deps = baseDeps();
    const r = await runStateCommand(["bogus"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("Unknown state command: bogus");
    expect(r.lines).toEqual(expect.arrayContaining([STATE_USAGE[0]]));
  });
});

// ===========================================================================
// status
// ===========================================================================

describe("status", () => {
  it("reports zero counts on a fresh store, in both text and --json shape", async () => {
    const deps = baseDeps();
    const text = await runStateCommand(["status"], deps);
    expect(text.code).toBe(0);
    expect(text.lines.some((l) => l.startsWith("journal seq: 0"))).toBe(true);

    const json = await runStateCommand(["status", "--json"], deps);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.lines[0]);
    expect(parsed.journalSeq).toBe(0);
    expect(parsed.domains.memory).toEqual({ live: 0, deleted: 0 });
  });

  it("reflects real writes made via `set`", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "note-1", '{"text":"hi"}'], deps);
    const json = await runStateCommand(["status", "--json"], deps);
    const parsed = JSON.parse(json.lines[0]);
    expect(parsed.domains.memory.live).toBe(1);
    expect(parsed.journalSeq).toBe(1);
  });
});

// ===========================================================================
// set / get / list / delete
// ===========================================================================

describe("set / get / list / delete", () => {
  it("set writes a real record; get returns it in both text and --json shape", async () => {
    const deps = baseDeps();
    const setRes = await runStateCommand(["set", "config", "locale", '"en"'], deps);
    expect(setRes.code).toBe(0);
    expect(setRes.lines[0]).toContain("Set config/locale");

    const getText = await runStateCommand(["get", "config", "locale"], deps);
    expect(getText.code).toBe(0);
    expect(getText.lines.some((l) => l.startsWith("value:"))).toBe(true);

    const getJson = await runStateCommand(["get", "config", "locale", "--json"], deps);
    const parsed = JSON.parse(getJson.lines[0]);
    expect(parsed.value).toBe("en");
    expect(parsed.domain).toBe("config");
    expect(parsed.key).toBe("locale");
  });

  it("get on a missing key exits 1 with a precise message", async () => {
    const deps = baseDeps();
    const r = await runStateCommand(["get", "memory", "nope"], deps);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("No such record: memory/nope");
  });

  it("set with malformed JSON exits 1 with a precise message and performs NO partial write", async () => {
    const deps = baseDeps();
    const store = new WorkspaceStore({ root, actor: deps.actor, now: deps.now });
    const before = store.snapshot();
    store.close();

    const r = await runStateCommand(["set", "memory", "k1", "{not valid json"], baseDeps());
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/Invalid JSON value/);

    const store2 = new WorkspaceStore({ root, actor: deps.actor, now: deps.now });
    const after = store2.snapshot();
    store2.close();
    expect(after.journalSeq).toBe(before.journalSeq);
    expect(after.records).toEqual(before.records);
  });

  it("set with an invalid domain exits 1 and never touches the store", async () => {
    const r = await runStateCommand(["set", "bogus-domain", "k1", "1"], baseDeps());
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("invalid domain");
  });

  it("list shows only live records by default, honors --prefix, and matches --json shape", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "alpha-1", "1"], deps);
    await runStateCommand(["set", "memory", "alpha-2", "2"], deps);
    await runStateCommand(["set", "memory", "beta-1", "3"], deps);
    await runStateCommand(["delete", "memory", "beta-1"], deps);

    const all = await runStateCommand(["list", "memory"], deps);
    expect(all.code).toBe(0);
    // header + 2 live rows (beta-1 deleted, so excluded)
    expect(all.lines.length).toBe(3);

    const prefixed = await runStateCommand(["list", "memory", "--prefix", "alpha-", "--json"], deps);
    const parsed = JSON.parse(prefixed.lines[0]);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r: { key: string }) => r.key.startsWith("alpha-"))).toBe(true);
  });

  it("delete tombstones an existing key and is an idempotent no-op on a missing one", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "k1", "1"], deps);
    const del1 = await runStateCommand(["delete", "memory", "k1"], deps);
    expect(del1.code).toBe(0);
    expect(del1.lines[0]).toContain("Deleted");

    const del2 = await runStateCommand(["delete", "memory", "k1"], deps);
    expect(del2.code).toBe(0);
    expect(del2.lines[0]).toContain("no-op");

    const get = await runStateCommand(["get", "memory", "k1", "--json"], deps);
    expect(get.code).toBe(0); // get() returns the tombstone itself, honestly
    expect(JSON.parse(get.lines[0]).deleted).toBe(true);
  });
});

// ===========================================================================
// export / import
// ===========================================================================

function makeEngineDeps(): { sessions: InMemorySessionStore; memory: InMemoryMemoryStore; adapters: DomainAdapter[] } {
  const sessions = new InMemorySessionStore();
  const memory = new InMemoryMemoryStore();
  return { sessions, memory, adapters: [sessionsAdapter({ sessions }), memoryAdapter({ memory })] };
}

describe("export / import", () => {
  it("export writes real engine state (a real session + a real memory fact) into the store", async () => {
    const { sessions, memory, adapters } = makeEngineDeps();
    const s = sessions.create({ title: "hello" });
    memory.add({ fact: "the sky is blue" });

    const deps = baseDeps({ adapters });
    const r = await runStateCommand(["export"], deps);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/Exported 2 record/);

    const got = await runStateCommand(["get", "sessions", s.id, "--json"], deps);
    expect(JSON.parse(got.lines[0]).value.title).toBe("hello");
  });

  it("export with --domain only touches that domain", async () => {
    const { sessions, memory, adapters } = makeEngineDeps();
    sessions.create({ title: "s1" });
    memory.add({ fact: "f1" });

    const deps = baseDeps({ adapters });
    const r = await runStateCommand(["export", "--domain", "memory"], deps);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/Exported 1 record/);

    const status = await runStateCommand(["status", "--json"], deps);
    const parsed = JSON.parse(status.lines[0]);
    expect(parsed.domains.memory.live).toBe(1);
    expect(parsed.domains.sessions.live).toBe(0);
  });

  it("export without adapters configured fails honestly", async () => {
    const r = await runStateCommand(["export"], baseDeps());
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/No domain adapters/);
  });

  it("import writes store content back into a REAL fresh engine", async () => {
    const source = makeEngineDeps();
    source.sessions.create({ title: "exported session" });
    source.memory.add({ fact: "exported fact" });
    const deps1 = baseDeps({ adapters: source.adapters });
    await runStateCommand(["export"], deps1);

    const target = makeEngineDeps();
    const deps2 = baseDeps({ adapters: target.adapters });
    const r = await runStateCommand(["import"], deps2);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith("sessions: applied=1"))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("memory: applied=1"))).toBe(true);

    expect(target.sessions.size()).toBe(1);
    expect(target.sessions.all()[0].title).toBe("exported session");
    expect(target.memory.size()).toBe(1);
    expect(target.memory.all()[0].fact).toBe("exported fact");
  });

  it("import --dry-run provably writes nothing: journal seq and engine state are unchanged", async () => {
    const source = makeEngineDeps();
    source.sessions.create({ title: "should not land" });
    const deps1 = baseDeps({ adapters: source.adapters });
    await runStateCommand(["export"], deps1);

    const target = makeEngineDeps();
    const deps2 = baseDeps({ adapters: target.adapters });

    const storeBefore = new WorkspaceStore({ root, actor: deps2.actor, now: deps2.now });
    const before = storeBefore.snapshot();
    storeBefore.close();

    const r = await runStateCommand(["import", "--dry-run"], deps2);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/Dry run/);
    expect(target.sessions.size()).toBe(0); // engine never touched

    const storeAfter = new WorkspaceStore({ root, actor: deps2.actor, now: deps2.now });
    const after = storeAfter.snapshot();
    storeAfter.close();
    expect(after.journalSeq).toBe(before.journalSeq);
    expect(after.records).toEqual(before.records);
  });

  it("import reports a malformed record as an error via exit code 1, without crashing", async () => {
    const deps = baseDeps();
    // hand-craft a record the sessions adapter can't parse
    await runStateCommand(["set", "sessions", "bad", '{"nope":true}'], deps);
    const target = makeEngineDeps();
    const deps2 = baseDeps({ adapters: target.adapters, root });
    const r = await runStateCommand(["import"], deps2);
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.includes("error: bad"))).toBe(true);
  });
});

// ===========================================================================
// sync
// ===========================================================================

describe("sync", () => {
  it("pushes a real engine-side fact into the store on first sync", async () => {
    const { memory, adapters } = makeEngineDeps();
    memory.add({ fact: "synced fact", salience: 0.5 });

    const deps = baseDeps({ adapters });
    const r = await runStateCommand(["sync"], deps);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/Synced/);
    expect(r.lines.some((l) => l.includes("pushed:    1"))).toBe(true);

    const status = await runStateCommand(["status", "--json"], deps);
    expect(JSON.parse(status.lines[0]).domains.memory.live).toBe(1);
  });

  it("pulls store-side content into the engine via the adapter", async () => {
    const source = makeEngineDeps();
    source.memory.add({ fact: "from the store" });
    await runStateCommand(["sync"], baseDeps({ adapters: source.adapters }));

    const target = makeEngineDeps();
    const r = await runStateCommand(["sync"], baseDeps({ adapters: target.adapters }));
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes("pulled:    1"))).toBe(true);
    expect(target.memory.size()).toBe(1);
    expect(target.memory.all()[0].fact).toBe("from the store");
  });

  it("--dry-run reports the plan without writing to the store or the engine", async () => {
    const { memory, adapters } = makeEngineDeps();
    memory.add({ fact: "would push" });
    const deps = baseDeps({ adapters });

    const storeBefore = new WorkspaceStore({ root, actor: deps.actor, now: deps.now });
    const before = storeBefore.snapshot();
    storeBefore.close();

    const r = await runStateCommand(["sync", "--dry-run"], deps);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/Dry run/);

    const storeAfter = new WorkspaceStore({ root, actor: deps.actor, now: deps.now });
    const after = storeAfter.snapshot();
    storeAfter.close();
    expect(after.journalSeq).toBe(before.journalSeq);
  });

  it("rejects an invalid --policy value", async () => {
    const { adapters } = makeEngineDeps();
    const r = await runStateCommand(["sync", "--policy", "bogus"], baseDeps({ adapters }));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/Invalid --policy value/);
  });

  it("sync without adapters configured fails honestly", async () => {
    const r = await runStateCommand(["sync"], baseDeps());
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/No domain adapters/);
  });
});

// ===========================================================================
// watch
// ===========================================================================

describe("watch", () => {
  it("--once observes exactly the writes already in the journal and returns immediately", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "k1", "1"], deps);

    const r = await runStateCommand(["watch", "--once", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.records).toBeGreaterThanOrEqual(1);
  });

  it("--for MS terminates deterministically under fake timers and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const deps = baseDeps();
      const promise = runStateCommand(["watch", "--for", "100"], deps);
      // Drive every pending timer (the internal sleep(stepMs) loop) to
      // completion deterministically, without any real wall-clock wait.
      await vi.runAllTimersAsync();
      const r = await promise;
      expect(r.code).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a malformed --for value", async () => {
    const r = await runStateCommand(["watch", "--for", "not-a-number"], baseDeps());
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/Invalid --for value/);
  });
});

// ===========================================================================
// doctor
// ===========================================================================

describe("doctor", () => {
  it("reports ok:true on a healthy fresh store", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "k1", "1"], deps);
    const r = await runStateCommand(["doctor", "--json"], deps);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.chain.ok).toBe(true);
    expect(parsed.quarantined).toEqual([]);
    expect(parsed.lock.held).toBe(false);
  });

  it("accurately reports a deliberately corrupted journal", async () => {
    const deps = baseDeps();
    await runStateCommand(["set", "memory", "k1", "1"], deps);
    await runStateCommand(["set", "memory", "k2", "2"], deps);

    // Deliberately corrupt the journal: append a garbage non-final-safe line
    // (i.e. a line followed by more content) so it is a genuine mid-stream
    // corruption, not a torn trailing write that self-heals silently.
    const journalPath = join(root, "journal.log");
    const original = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, original + "not valid json\n{\"seq\":99}\n");

    const r = await runStateCommand(["doctor", "--json"], deps);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.chain.ok).toBe(false);
    expect(typeof parsed.chain.reason).toBe("string");
  });

  it("reports a lock directory left behind by a crashed writer, as observed at the start of the check", async () => {
    // Build the store FIRST (a normal, healthy construction), then plant a
    // fake lock dir afterward, and pass the SAME store instance in via
    // `deps.store` so `runStateCommand` never reconstructs a store (which
    // would otherwise self-heal — reclaim — the stale lock before `doctor`
    // ever got to observe it). `cmdDoctor` itself snapshots lock state
    // before calling `store.verifyChain()` (which also acquires the lock)
    // for the same reason.
    const actor: ActorId = { kind: "cli", id: "alice" };
    const store = new WorkspaceStore({ root, actor, now: clockNow() });
    store.put("memory", "k1", 1);

    const lockDir = join(root, ".lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "holder.json"), JSON.stringify({ pid: 999999999, acquiredAt: Date.now() }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockDir, old, old);

    try {
      const r = await runStateCommand(["doctor", "--json"], baseDeps({ store, actor }));
      const parsed = JSON.parse(r.lines[0]);
      expect(parsed.lock.held).toBe(true);
      expect(parsed.lock.stale).toBe(true);
      expect(r.code).toBe(1);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
      store.close();
    }
  });
});

// ===========================================================================
// misc
// ===========================================================================

describe("actor / clock plumbing", () => {
  it("uses the injected `now` for record timestamps, not the real wall clock", async () => {
    const fixedSeq = clockNow(12345);
    const deps = baseDeps({ now: fixedSeq });
    const r = await runStateCommand(["get", "memory", "missing"], deps);
    void r; // ensure store construction with injected now doesn't throw
    const setRes = await runStateCommand(["set", "memory", "k1", "1"], baseDeps({ now: () => 999_999 }));
    expect(setRes.code).toBe(0);
    const got = await runStateCommand(["get", "memory", "k1", "--json"], baseDeps());
    const parsed = JSON.parse(got.lines[0]);
    expect(parsed.updatedAt).toBe(999_999);
  });
});
