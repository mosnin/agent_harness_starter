/**
 * Central-integration tests for the desktop `state.*` lane.
 *
 * These are the "is it actually wired, or is it dead code?" tests:
 *
 *  1. The `state.*` messages really are part of the `Command`/`AppEvent`
 *     unions and survive a full encode -> decode round trip on the wire.
 *  2. `Sidecar` really routes them to a `StateHandler`, really fans the
 *     handler's push lane out as `state.changed`, and really reports an
 *     honest `state.error` when no handler is configured.
 *  3. `runSidecar` — the REAL process entry point — really opens the REAL
 *     shared workspace at `<dataDir>/state` and answers from it, so a record
 *     written by the REAL `hades state` CLI in the same root is visible to
 *     the desktop. No mocked fs, no mocked store, no scripted fake service.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isCommand,
  isAppEvent,
  type AppEvent,
  type Command,
} from "../ipc/contract";
import { Sidecar, type StateHandler } from "../core/sidecar";
import { runSidecar } from "../sidecar-entry";
import { runStateCommand, defaultStateDeps } from "../../hades/cli/state-command";
import type { StateEvent } from "../ipc/state-contract";

// ---------------------------------------------------------------------------
// 1. Wire format
// ---------------------------------------------------------------------------

describe("desktop IPC contract — state.* merged into the unions", () => {
  const commands: Command[] = [
    { kind: "state.status" },
    { kind: "state.list", domain: "memory" },
    { kind: "state.list", domain: "memory", prefix: "a/" },
    { kind: "state.get", domain: "config", key: "locale" },
    { kind: "state.set", domain: "config", key: "locale", value: { nested: [1, "two", null] } },
    { kind: "state.delete", domain: "memory", key: "k" },
    { kind: "state.sync" },
    { kind: "state.sync", dryRun: true, policy: "prefer-local" },
    { kind: "state.watch", enabled: true },
  ];

  const events: AppEvent[] = [
    {
      kind: "state.status",
      status: {
        root: "/tmp/x/state",
        actor: "desktop:a",
        journalSeq: 3,
        head: "abc",
        chainOk: true,
        perDomain: [{ domain: "memory", records: 2, lastUpdatedAt: 5 }],
        lastSyncAt: null,
        conflicts: 0,
      },
    },
    {
      kind: "state.records",
      domain: "memory",
      records: [
        { domain: "memory", key: "k", rev: 1, updatedAt: 2, actor: "cli:a", deleted: false, hash: "h", value: { a: 1 } },
      ],
    },
    { kind: "state.changed", seq: 4, actor: "cli:a", records: [] },
    { kind: "state.synced", pulled: 1, pushed: 0, conflicts: [], dryRun: false, at: 9 },
    { kind: "state.error", op: "state.list", message: "boom" },
  ];

  it("accepts every state command and round-trips it byte-for-byte", () => {
    for (const cmd of commands) {
      expect(isCommand(cmd)).toBe(true);
      expect(decodeCommand(encodeCommand(cmd))).toEqual(cmd);
    }
  });

  it("accepts every state event and round-trips it byte-for-byte", () => {
    for (const ev of events) {
      expect(isAppEvent(ev)).toBe(true);
      expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
    }
  });

  it("still rejects malformed state traffic rather than passing it through", () => {
    expect(() => decodeCommand(JSON.stringify({ kind: "state.list" }))).toThrow(/invalid fields/);
    expect(() => decodeCommand(JSON.stringify({ kind: "state.watch", enabled: "yes" }))).toThrow(/invalid fields/);
    expect(() => decodeEvent(JSON.stringify({ kind: "state.error", op: 1, message: "x" }))).toThrow(/invalid fields/);
    expect(() => decodeCommand(JSON.stringify({ kind: "state.nope" }))).toThrow(/unknown kind/);
  });
});

// ---------------------------------------------------------------------------
// 2. Sidecar routing + push lane
// ---------------------------------------------------------------------------

describe("Sidecar — state.* routing", () => {
  function collect(): { events: AppEvent[]; emit: (e: AppEvent) => void } {
    const events: AppEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  const noopFactory = () => ({
    dispatchGoal: () => ({ goalId: "g" }),
    snapshot: () => ({ workers: [], tasks: [] }),
  });

  it("routes every state command to the handler and emits its events", async () => {
    const seen: Command[] = [];
    const handler: StateHandler = {
      handle: async (cmd) => {
        seen.push(cmd);
        return [{ kind: "state.error", op: cmd.kind, message: "ack" }];
      },
    };
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit, state: handler });

    for (const cmd of [
      { kind: "state.status" },
      { kind: "state.list", domain: "memory" },
      { kind: "state.get", domain: "memory", key: "k" },
      { kind: "state.set", domain: "memory", key: "k", value: 1 },
      { kind: "state.delete", domain: "memory", key: "k" },
      { kind: "state.sync" },
      { kind: "state.watch", enabled: false },
    ] as Command[]) {
      await sidecar.handle(cmd);
    }

    expect(seen.map((c) => c.kind)).toEqual([
      "state.status",
      "state.list",
      "state.get",
      "state.set",
      "state.delete",
      "state.sync",
      "state.watch",
    ]);
    expect(events).toHaveLength(7);
    await sidecar.dispose();
  });

  it("reports an honest state.error when no handler is configured", async () => {
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit });
    await sidecar.handle({ kind: "state.status" });
    expect(events).toEqual([
      { kind: "state.error", op: "state.status", message: "the shared workspace store is not configured in this build" },
    ]);
    await sidecar.dispose();
  });

  it("fans the handler's push lane out as out-of-band events", async () => {
    let push: ((e: StateEvent) => void) | undefined;
    let unsubscribed = false;
    const handler: StateHandler = {
      handle: async () => [],
      subscribe: (emit) => {
        push = emit;
        return () => {
          unsubscribed = true;
        };
      },
    };
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit, state: handler });

    // No command was sent — this is a genuinely unsolicited delta.
    push?.({ kind: "state.changed", seq: 7, actor: "cli:other-terminal", records: [] });
    expect(events).toEqual([{ kind: "state.changed", seq: 7, actor: "cli:other-terminal", records: [] }]);

    await sidecar.dispose();
    expect(unsubscribed).toBe(true);
  });

  it("keeps the workspace answering after runtime.stop, and only tears it down on dispose", async () => {
    let closed = 0;
    const handler: StateHandler = {
      handle: async (cmd) => [{ kind: "state.error", op: cmd.kind, message: "still here" }],
      close: () => {
        closed += 1;
      },
    };
    const { events, emit } = collect();
    const sidecar = new Sidecar({ factory: noopFactory, emit, state: handler });

    await sidecar.handle({ kind: "runtime.start", mode: "inline", poolSize: 1 });
    await sidecar.handle({ kind: "runtime.stop" });
    expect(closed).toBe(0);

    events.length = 0;
    await sidecar.handle({ kind: "state.status" });
    expect(events).toEqual([{ kind: "state.error", op: "state.status", message: "still here" }]);

    await sidecar.dispose();
    expect(closed).toBe(1);
    // Idempotent.
    await sidecar.dispose();
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. runSidecar over the REAL shared workspace
// ---------------------------------------------------------------------------

describe("runSidecar — the real shared-workspace lane", () => {
  let dir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hades-desktop-state-"));
    previousDataDir = process.env.HADES_DATA_DIR;
    process.env.HADES_DATA_DIR = dir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.HADES_DATA_DIR;
    else process.env.HADES_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  async function drive(commands: Command[]): Promise<AppEvent[]> {
    const out: AppEvent[] = [];
    async function* input(): AsyncGenerator<string> {
      yield commands.map((c) => JSON.stringify(c)).join("\n") + "\n";
    }
    await runSidecar(input(), (line) => out.push(JSON.parse(line.trim()) as AppEvent), {
      // The swarm engine is irrelevant here and must not be spun up.
      factory: () => ({ dispatchGoal: () => ({ goalId: "g" }), snapshot: () => ({ workers: [], tasks: [] }) }),
    });
    return out;
  }

  it("reads a record the REAL hades state CLI wrote into the same root", async () => {
    const cliWrite = await runStateCommand(
      ["set", "memory", "cross-surface", '{"who":"cli"}'],
      defaultStateDeps(process.env),
    );
    expect(cliWrite.code).toBe(0);

    const events = await drive([
      { kind: "state.status" },
      { kind: "state.get", domain: "memory", key: "cross-surface" },
    ]);

    const status = events.find((e): e is Extract<AppEvent, { kind: "state.status" }> => e.kind === "state.status");
    expect(status).toBeDefined();
    expect(status!.status.root).toBe(join(dir, "state"));
    expect(status!.status.chainOk).toBe(true);
    // The desktop opens the workspace under its OWN durable identity.
    expect(status!.status.actor.startsWith("desktop:")).toBe(true);

    const records = events.find((e): e is Extract<AppEvent, { kind: "state.records" }> => e.kind === "state.records");
    expect(records).toBeDefined();
    expect(records!.records).toHaveLength(1);
    expect(records!.records[0].value).toEqual({ who: "cli" });
    // Attribution survives the hop: the desktop can see WHO wrote it.
    expect(records!.records[0].actor.startsWith("cli:")).toBe(true);
  });

  it("writes back into the same journal, where the CLI can read it", async () => {
    const events = await drive([{ kind: "state.set", domain: "config", key: "locale", value: "fr" }]);
    const written = events.find((e): e is Extract<AppEvent, { kind: "state.records" }> => e.kind === "state.records");
    expect(written).toBeDefined();
    expect(written!.records[0].actor.startsWith("desktop:")).toBe(true);

    const read = await runStateCommand(["get", "config", "locale", "--json"], defaultStateDeps(process.env));
    expect(read.code).toBe(0);
    const record = JSON.parse(read.lines.join("\n")) as { value: unknown; actor: string };
    expect(record.value).toBe("fr");
    expect(record.actor.startsWith("desktop:")).toBe(true);

    // And the chain the CLI's doctor walks is still intact after both writers.
    const doctor = await runStateCommand(["doctor", "--json"], defaultStateDeps(process.env));
    const health = JSON.parse(doctor.lines.join("\n")) as { chain: { ok: boolean } };
    expect(health.chain.ok).toBe(true);
  });

  it("opens the workspace lazily — a run with no state command touches nothing on disk", async () => {
    await drive([{ kind: "runtime.stop" }]);
    // `Sidecar` subscribes to the state push lane at construction; that must
    // NOT be enough to build the stack, open the store, or take its
    // cross-process lock. Nothing under <dataDir>/state should exist yet.
    expect(existsSync(join(dir, "state"))).toBe(false);

    await drive([{ kind: "state.status" }]);
    expect(existsSync(join(dir, "state", "journal.log"))).toBe(true);
  });

  it("answers an unknown domain with an honest state.error, never a fabricated empty batch", async () => {
    const events = await drive([{ kind: "state.list", domain: "memory" }]);
    // A valid but empty domain is an empty batch...
    const ok = events.find((e): e is Extract<AppEvent, { kind: "state.records" }> => e.kind === "state.records");
    expect(ok?.records).toEqual([]);

    // ...whereas an unknown one is an error. `state.list` with a bogus domain
    // is rejected by the wire guard before it can even reach the service, so
    // this drives the service through a domain that decodes but is unknown.
    const bad = await drive([{ kind: "state.get", domain: "nope", key: "x" }]);
    const err = bad.find((e): e is Extract<AppEvent, { kind: "state.error" }> => e.kind === "state.error");
    expect(err?.message).toContain('unknown workspace domain "nope"');
  });
});
