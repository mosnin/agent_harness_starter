/**
 * Phase checkpoint: the desktop `StateService` and the `hades state` CLI
 * (`src/hades/cli/state-command.ts`, Team 3) genuinely share ONE
 * `WorkspaceStore` — a write from either surface is visible to the other,
 * with real content, not just matching counts.
 *
 * Two directions, both against a REAL `WorkspaceStore` on a REAL temp dir
 * (never mocked):
 *
 *  (a) CLI -> desktop, crossing a GENUINE process boundary: a real, separate
 *      `node` process is spawned (via `tsx`, mirroring
 *      `src/hades/state/__tests__/store.test.ts`'s own cross-process
 *      pattern) that imports the REAL `runStateCommand` and runs
 *      `hades state set` against the shared root. Back in THIS process, a
 *      `StateService` wired to a REAL `WorkspaceStore` + `WorkspaceFeed`
 *      over the same root reports the exact record via `state.status` /
 *      `state.list`, and pushes it out as a `state.changed` through
 *      `subscribe`.
 *
 *  (b) desktop -> CLI -> engine: `StateService.handle({kind:"state.set"})`
 *      writes a session and a memory fact. The REAL `runStateCommand`
 *      (`get`/`list`, in-process — the cross-process leg is already covered
 *      by (a)) sees them, and the REAL `importFromStore` lands them into a
 *      REAL `InMemorySessionStore`/`InMemoryMemoryStore` with the exact
 *      message text / fact string intact.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runStateCommand, type StateCommandDeps } from "../../hades/cli/state-command";
import { WorkspaceStore } from "../../hades/state/store";
import { WorkspaceFeed } from "../../hades/state/feed";
import { workspaceRoot, sessionsAdapter, memoryAdapter, importFromStore } from "../../hades/state/domains";
import { InMemorySessionStore } from "../../hades/memory/session-store";
import { InMemoryMemoryStore } from "../../hades/memory/store";
import type { ActorId } from "../../hades/state/record";

import { StateService } from "../core/state-service";
import type { StateEvent } from "../ipc/state-contract";

const STATE_COMMAND_TS_PATH = fileURLToPath(new URL("../../hades/cli/state-command.ts", import.meta.url));
const TSX_CLI = require.resolve("tsx/cli");

let dataDir: string;
let scratchDir: string;
const spawned: Array<ReturnType<typeof spawn>> = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hades-desktop-roundtrip-"));
  scratchDir = mkdtempSync(join(tmpdir(), "hades-desktop-roundtrip-scripts-"));
});

afterEach(() => {
  // Clean up even on failure: kill any still-alive spawned child, then
  // remove both temp dirs.
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Spawns a REAL, separate `node` process (via `tsx`) that imports the REAL `runStateCommand` and runs `hades state <argv>` against `root`. Resolves with its `CliResult`-shaped `{ code, lines }`, read back over a fixed-name output file (stdout is noisy under tsx's loader banner, so this is more robust than parsing stdio). */
function runStateCommandInChildProcess(root: string, actor: ActorId, argv: string[]): Promise<{ code: number; lines: string[] }> {
  const scriptPath = join(scratchDir, `roundtrip-cli-${Math.random().toString(36).slice(2)}.mts`);
  const outPath = join(scratchDir, `roundtrip-out-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    scriptPath,
    `
    import { writeFileSync } from "node:fs";
    import { runStateCommand } from ${JSON.stringify(STATE_COMMAND_TS_PATH)};
    const [, , root, actorKind, actorId, outPath, ...argv] = process.argv;
    const result = await runStateCommand(argv, { root, actor: { kind: actorKind, id: actorId } });
    writeFileSync(outPath, JSON.stringify(result), "utf8");
    `,
    "utf8",
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, scriptPath, root, actor.kind, actor.id, outPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        // A non-zero exit from `hades state set` itself is a legitimate
        // CliResult (code:1) already captured in outPath by the script
        // above — this branch is only for the CHILD PROCESS ITSELF
        // crashing (an uncaught exception before it got to write outPath).
        try {
          const raw = readFileSync(outPath, "utf8");
          resolve(JSON.parse(raw));
          return;
        } catch {
          reject(new Error(`child process exited ${code}: ${stderr}`));
          return;
        }
      }
      try {
        const raw = readFileSync(outPath, "utf8");
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`child process produced no output (stderr: ${stderr}): ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

// ===========================================================================
// (a) CLI (genuine child process) -> StateService, both directly and via
//     subscribe()'s live feed push
// ===========================================================================

describe("round-trip (a): a real child-process `hades state set` is observed by StateService", () => {
  it("StateService.handle(state.status/state.list) sees the exact record a separate process wrote", async () => {
    const root = workspaceRoot(dataDir);
    const cliActor: ActorId = { kind: "cli", id: "alice" };

    const result = await runStateCommandInChildProcess(root, cliActor, [
      "set",
      "memory",
      "fact-from-cli",
      JSON.stringify({ fact: "the desktop and the CLI share one store" }),
    ]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain("Set memory/fact-from-cli");

    const store = new WorkspaceStore({ root, actor: { kind: "desktop", id: "sidecar" } });
    const svc = new StateService({ store });

    const statusEvents = await svc.handle({ kind: "state.status" });
    const status = (statusEvents[0] as Extract<StateEvent, { kind: "state.status" }>).status;
    expect(status.perDomain.find((d) => d.domain === "memory")?.records).toBe(1);

    const listEvents = await svc.handle({ kind: "state.list", domain: "memory" });
    const records = (listEvents[0] as Extract<StateEvent, { kind: "state.records" }>).records;
    expect(records).toHaveLength(1);
    expect(records[0].key).toBe("fact-from-cli");
    expect(records[0].actor).toBe("cli:alice");
    // Real content, not just a count.
    expect(records[0].value).toEqual({ fact: "the desktop and the CLI share one store" });

    svc.close();
  }, 30_000);

  it("subscribe() pushes the child process's write as a state.changed event with the real content, in seq order", async () => {
    const root = workspaceRoot(dataDir);
    const cliActor: ActorId = { kind: "cli", id: "bob" };

    const store = new WorkspaceStore({ root, actor: { kind: "desktop", id: "sidecar" } });
    const feed = new WorkspaceFeed({ store, root, consumer: "desktop:roundtrip-a", watch: false });
    const svc = new StateService({ store, feed });

    const received: StateEvent[] = [];
    svc.subscribe((e) => received.push(e));

    const r1 = await runStateCommandInChildProcess(root, cliActor, ["set", "sessions", "s-from-cli", JSON.stringify({ id: "s-from-cli", messages: [{ role: "user", content: "hello from a real child process", at: 1 }], tags: [], startedAt: 1 })]);
    expect(r1.code).toBe(0);
    const r2 = await runStateCommandInChildProcess(root, cliActor, ["set", "memory", "m-from-cli", JSON.stringify({ id: "m-from-cli", fact: "second write", salience: 0.5, tags: [], createdAt: 1, accessCount: 0 })]);
    expect(r2.code).toBe(0);

    feed.poll(); // deterministic delivery — no timer race

    expect(received.length).toBeGreaterThanOrEqual(2);
    const changed = received.filter((e): e is Extract<StateEvent, { kind: "state.changed" }> => e.kind === "state.changed");
    expect(changed.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < changed.length; i++) expect(changed[i].seq).toBeGreaterThan(changed[i - 1].seq);
    expect(changed.every((c) => c.actor === "cli:bob")).toBe(true);

    const sessionChange = changed.find((c) => c.records.some((r) => r.key === "s-from-cli"));
    expect(sessionChange).toBeDefined();
    const sessionRecord = sessionChange!.records.find((r) => r.key === "s-from-cli")!;
    expect((sessionRecord.value as { messages: Array<{ content: string }> }).messages[0].content).toBe("hello from a real child process");

    svc.close();
  }, 30_000);
});

// ===========================================================================
// (b) StateService -> CLI (in-process) + real engine round-trip via
//     importFromStore into REAL InMemorySessionStore / InMemoryMemoryStore
// ===========================================================================

describe("round-trip (b): StateService.state.set is observed by the real CLI and lands back in the real engine", () => {
  it("hades state get/list (real runStateCommand) sees a StateService.state.set write with exact content", async () => {
    const root = workspaceRoot(dataDir);
    const desktopActor: ActorId = { kind: "desktop", id: "sidecar-1" };
    const store = new WorkspaceStore({ root, actor: desktopActor });
    const svc = new StateService({ store });

    const sessionValue = {
      id: "session-desktop-1",
      title: "desktop-authored session",
      messages: [{ role: "user", content: "a message typed in the desktop app", at: 1000 }],
      summary: null,
      tags: ["desktop"],
      startedAt: 1000,
      endedAt: null,
    };
    const setEvents = await svc.handle({ kind: "state.set", domain: "sessions", key: "session-desktop-1", value: sessionValue });
    expect(setEvents[0].kind).toBe("state.records");

    const cliDeps: StateCommandDeps = { root, actor: { kind: "cli", id: "verifier" } };
    const getResult = await runStateCommand(["get", "sessions", "session-desktop-1", "--json"], cliDeps);
    expect(getResult.code).toBe(0);
    const parsed = JSON.parse(getResult.lines[0]) as { domain: string; key: string; actor: string; value: typeof sessionValue };
    expect(parsed.domain).toBe("sessions");
    expect(parsed.actor).toBe("desktop:sidecar-1");
    expect(parsed.value.messages[0].content).toBe("a message typed in the desktop app");

    const listResult = await runStateCommand(["list", "sessions", "--json"], cliDeps);
    expect(listResult.code).toBe(0);
    const listed = JSON.parse(listResult.lines[0]) as Array<{ key: string }>;
    expect(listed.map((r) => r.key)).toContain("session-desktop-1");

    svc.close();
  });

  it("importFromStore lands a StateService.state.set session AND memory fact back into real InMemorySessionStore/InMemoryMemoryStore with exact content", async () => {
    const root = workspaceRoot(dataDir);
    const store = new WorkspaceStore({ root, actor: { kind: "desktop", id: "sidecar-2" } });
    const svc = new StateService({ store });

    const sessionValue = {
      id: "session-import-1",
      messages: [{ role: "assistant", content: "imported back into the real engine", at: 2000 }],
      tags: [],
      startedAt: 2000,
    };
    await svc.handle({ kind: "state.set", domain: "sessions", key: "session-import-1", value: sessionValue });

    const factValue = {
      id: "fact-import-1",
      fact: "hades remembers this exact sentence",
      salience: 0.8,
      tags: ["desktop-origin"],
      createdAt: 2000,
      accessCount: 0,
    };
    await svc.handle({ kind: "state.set", domain: "memory", key: "fact-import-1", value: factValue });

    // A fresh store handle over the SAME root, exactly as a real importer
    // process would open it — never reuses StateService's own instance.
    const importStore = new WorkspaceStore({ root, actor: { kind: "test", id: "importer" } });
    const sessions = new InMemorySessionStore();
    const memory = new InMemoryMemoryStore();
    const reports = importFromStore(importStore, [sessionsAdapter({ sessions }), memoryAdapter({ memory })]);

    expect(reports.sessions.applied).toBe(1);
    expect(reports.sessions.errors).toEqual([]);
    expect(reports.memory.applied).toBe(1);
    expect(reports.memory.errors).toEqual([]);

    const importedSession = sessions.all().find((s) => s.id === "session-import-1");
    expect(importedSession).toBeDefined();
    expect(importedSession!.messages[0].content).toBe("imported back into the real engine");

    const importedFact = memory.all().find((m) => m.id === "fact-import-1");
    expect(importedFact).toBeDefined();
    expect(importedFact!.fact).toBe("hades remembers this exact sentence");
    expect(importedFact!.tags).toEqual(["desktop-origin"]);

    svc.close();
  });

  it("a StateService.state.delete tombstone is honoured by importFromStore (no resurrection)", async () => {
    const root = workspaceRoot(dataDir);
    const store = new WorkspaceStore({ root, actor: { kind: "desktop", id: "sidecar-3" } });
    const svc = new StateService({ store });

    const factValue = { id: "fact-forget-me", fact: "temporary", salience: 0.3, tags: [], createdAt: 1, accessCount: 0 };
    await svc.handle({ kind: "state.set", domain: "memory", key: "fact-forget-me", value: factValue });

    // A single long-lived engine store + adapter across both imports — the
    // realistic shape of a real desktop process that syncs repeatedly in
    // one running session (`memoryAdapter`'s own doc: its logical-id ->
    // engine-internal-id `remap` is "scoped to this adapter instance's
    // lifetime"). Only the WorkspaceStore handle is reopened per import,
    // exactly like the (b) session/fact test above.
    const memory = new InMemoryMemoryStore();
    const adapter = memoryAdapter({ memory });

    const importStore1 = new WorkspaceStore({ root, actor: { kind: "test", id: "importer-1" } });
    importFromStore(importStore1, [adapter]);
    expect(memory.all().some((m) => m.id === "fact-forget-me")).toBe(true);

    await svc.handle({ kind: "state.delete", domain: "memory", key: "fact-forget-me" });

    const importStore2 = new WorkspaceStore({ root, actor: { kind: "test", id: "importer-2" } });
    importFromStore(importStore2, [adapter]);
    expect(memory.all().some((m) => m.id === "fact-forget-me")).toBe(false);

    svc.close();
  });
});
