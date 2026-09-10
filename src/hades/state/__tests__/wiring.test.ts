/**
 * Central-wiring tests for the shared workspace stack.
 *
 * Everything here runs against REAL temp directories and the REAL
 * `WorkspaceStore`/`WorkspaceFeed`/`SyncEngine` — no mocked fs, no stubbed
 * store. These cover the guarantees the surfaces actually depend on:
 * a STABLE per-surface actor identity (or vector clocks grow without bound),
 * a config accessor that never bakes env values into the user's config file,
 * and a stack whose pieces all point at the one shared root.
 *
 * The `draft:` actor regression tests live here too: the placeholder kind
 * `InMemoryMirror`/`WorkspaceFeed` stamp on synthetic records must never be
 * persistable, and must never collide with a genuine `test:` writer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkspaceStack,
  fileConfigAccess,
  resolveWorkspaceActor,
  workspaceRoot,
} from "../wiring";
import { WorkspaceStore } from "../store";
import { InMemoryMirror, SyncEngine } from "../sync";
import { WorkspaceFeed } from "../feed";
import { actorKey, isDraftActorKey, DRAFT_ACTOR_KIND } from "../record";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hades-wiring-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkspaceActor", () => {
  it("mints one identity and reuses it across calls and processes", () => {
    const root = workspaceRoot(dir);
    mkdirSync(root, { recursive: true });
    const first = resolveWorkspaceActor({ root, kind: "cli", env: {} });
    const second = resolveWorkspaceActor({ root, kind: "cli", env: {} });

    expect(first.kind).toBe("cli");
    expect(first.id.length).toBeGreaterThan(0);
    // Same identity — this is the whole point: a per-invocation id would add
    // a new vector-clock key on every `hades state set`.
    expect(second).toEqual(first);
    expect(existsSync(join(root, "actors", "cli.json"))).toBe(true);
  });

  it("keeps distinct identities per surface in the same root", () => {
    const root = workspaceRoot(dir);
    mkdirSync(root, { recursive: true });
    const cli = resolveWorkspaceActor({ root, kind: "cli", env: {} });
    const desktop = resolveWorkspaceActor({ root, kind: "desktop", env: {} });
    expect(cli.id).not.toBe(desktop.id);
    expect(actorKey(cli)).not.toBe(actorKey(desktop));
  });

  it("honours an explicit HADES_STATE_ACTOR_ID pin without persisting it", () => {
    const root = workspaceRoot(dir);
    mkdirSync(root, { recursive: true });
    const pinned = resolveWorkspaceActor({ root, kind: "tui", env: { HADES_STATE_ACTOR_ID: "  ci-runner-7  " } });
    expect(pinned).toEqual({ kind: "tui", id: "ci-runner-7" });
    // A pin is a per-invocation override, not a durable identity choice.
    expect(existsSync(join(root, "actors", "tui.json"))).toBe(false);
  });

  it("re-mints (never throws) when the identity file is corrupt or mis-kinded", () => {
    const root = workspaceRoot(dir);
    mkdirSync(join(root, "actors"), { recursive: true });
    writeFileSync(join(root, "actors", "cli.json"), "{not json", "utf8");
    const a = resolveWorkspaceActor({ root, kind: "cli", env: {}, mintId: () => "fresh-1" });
    expect(a).toEqual({ kind: "cli", id: "fresh-1" });

    // A file recording a DIFFERENT kind must not be adopted for this kind.
    writeFileSync(join(root, "actors", "desktop.json"), JSON.stringify({ kind: "cli", id: "wrong" }), "utf8");
    const b = resolveWorkspaceActor({ root, kind: "desktop", env: {}, mintId: () => "fresh-2" });
    expect(b).toEqual({ kind: "desktop", id: "fresh-2" });
  });
});

describe("fileConfigAccess", () => {
  it("resolves defaults < file < env, but only ever persists the file layer", () => {
    const cfg = fileConfigAccess(dir, { HADES_LOCALE: "de" });
    // Nothing on disk yet: env still layers over the built-in defaults.
    expect(cfg.load().locale).toBe("de");

    cfg.write({ model: "some-model" });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    // The env-supplied locale must NOT have been baked into the file.
    expect(onDisk).toEqual({ model: "some-model" });
    expect(cfg.load().model).toBe("some-model");
    expect(cfg.load().locale).toBe("de");
  });

  it("shallow-merges successive writes instead of replacing the file", () => {
    const cfg = fileConfigAccess(dir, {});
    cfg.write({ model: "a" });
    cfg.write({ locale: "fr" });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ model: "a", locale: "fr" });
  });

  it("treats an unreadable config file as an empty file layer rather than throwing", () => {
    writeFileSync(join(dir, "config.json"), "]]]not json[[[", "utf8");
    const cfg = fileConfigAccess(dir, {});
    expect(() => cfg.load()).not.toThrow();
    expect(cfg.load().locale).toBe("en");
  });
});

describe("createWorkspaceStack", () => {
  it("assembles real pieces all pointing at the one shared root", () => {
    const stack = createWorkspaceStack({ dataDir: dir, kind: "desktop", env: {} });
    try {
      expect(stack.root).toBe(workspaceRoot(dir));
      expect(stack.store).toBeInstanceOf(WorkspaceStore);
      expect(stack.feed).toBeInstanceOf(WorkspaceFeed);
      expect(stack.sync).toBeInstanceOf(SyncEngine);
      expect(stack.mirror).toBeInstanceOf(InMemoryMirror);
      // The store's own public identity must agree with the stack's.
      expect(stack.store.rootPath).toBe(stack.root);
      expect(stack.store.actorKeyId).toBe(actorKey(stack.actor));
      // `config` and `skills` always have adapters; sessions/memory only when
      // real engine stores were supplied (they weren't here).
      expect(stack.adapters.map((a) => a.domain).sort()).toEqual(["config", "skills"]);
    } finally {
      stack.close();
    }
  });

  it("two stacks on the same dataDir are two writers on ONE journal", () => {
    const a = createWorkspaceStack({ dataDir: dir, kind: "cli", env: {} });
    const b = createWorkspaceStack({ dataDir: dir, kind: "desktop", env: {} });
    try {
      a.store.put("memory", "shared", { from: "cli" });
      // b never saw a's write in memory — it must read it off disk.
      const seen = b.store.get("memory", "shared");
      expect(seen?.value).toEqual({ from: "cli" });
      expect(seen?.actor).toBe(actorKey(a.actor));
      expect(a.actor.id).not.toBe(b.actor.id);
      expect(b.store.verifyChain().ok).toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });

  it("close() is idempotent and stops the feed", () => {
    const stack = createWorkspaceStack({ dataDir: dir, kind: "cli", env: {}, watch: false });
    stack.feed.start();
    stack.close();
    stack.close();
    // The store is closed: further mutation must be refused, not silently
    // accepted against a torn-down handle.
    expect(() => stack.store.put("memory", "after-close", 1)).toThrow();
  });
});

describe("draft actor kind (non-persistable placeholder)", () => {
  it("is recognised only when it is genuinely the actor's kind", () => {
    expect(isDraftActorKey("draft:mirror")).toBe(true);
    expect(isDraftActorKey("draft:resync")).toBe(true);
    // An id that merely starts with the word must not be misclassified.
    expect(isDraftActorKey("cli:draftsman")).toBe(false);
    expect(isDraftActorKey("test:mirror")).toBe(false);
    expect(isDraftActorKey("not-an-actor")).toBe(false);
  });

  it("cannot be used to construct a WorkspaceStore", () => {
    expect(
      () => new WorkspaceStore({ root: join(dir, "state"), actor: { kind: DRAFT_ACTOR_KIND, id: "mirror" } }),
    ).toThrow(/non-persistable placeholder/);
  });

  it("is rejected by applyRemote instead of poisoning the journal", () => {
    const stack = createWorkspaceStack({ dataDir: dir, kind: "cli", env: {} });
    try {
      const mirror = new InMemoryMirror();
      // A raw, UNMATERIALIZED draft — exactly what a caller would produce by
      // bypassing SyncEngine.materialize and pushing mirror.drain() directly.
      const draft = mirror.stage("memory", "leaked", { v: 1 });
      expect(draft.actor).toBe("draft:mirror");

      const result = stack.store.applyRemote([draft]);
      expect(result.applied).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toContain(DRAFT_ACTOR_KIND);
      // Nothing landed and the chain is untouched.
      expect(stack.store.get("memory", "leaked")).toBeUndefined();
      expect(stack.store.snapshot().journalSeq).toBe(0);
      expect(stack.store.verifyChain().ok).toBe(true);
    } finally {
      stack.close();
    }
  });

  it("a real SyncEngine push materializes the draft, so it is never rejected", () => {
    const stack = createWorkspaceStack({ dataDir: dir, kind: "cli", env: {} });
    try {
      stack.mirror.stage("memory", "via-sync", { v: 2 });
      const report = stack.sync.push();
      expect(report.pushed).toHaveLength(1);
      expect(isDraftActorKey(report.pushed[0].actor)).toBe(false);
      expect(report.pushed[0].actor).toBe(actorKey(stack.actor));
      expect(stack.store.get("memory", "via-sync")?.value).toEqual({ v: 2 });
    } finally {
      stack.close();
    }
  });
});

describe("WorkspaceStore public identity accessors", () => {
  it("report the real configured root and actor, and hand back a copy of the ActorId", () => {
    const root = join(dir, "state");
    const store = new WorkspaceStore({ root, actor: { kind: "tui", id: "abc" } });
    try {
      expect(store.rootPath).toBe(root);
      expect(store.actorKeyId).toBe("tui:abc");
      const id = store.actorId;
      expect(id).toEqual({ kind: "tui", id: "abc" });
      // Mutating the returned object must not rewrite the store's identity.
      id.id = "hijacked";
      expect(store.actorKeyId).toBe("tui:abc");
      expect(store.actorId.id).toBe("abc");
    } finally {
      store.close();
    }
  });
});
