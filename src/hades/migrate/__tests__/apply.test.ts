/**
 * Tests for `src/hades/migrate/apply.ts` -- the transactional applier.
 *
 * No mocks: every test drives real temp directories, the real
 * `FileMemoryStore`/`FileSessionStore`/`FileModelSelection`/`fileConfigAccess`
 * -shaped stores, the real `GuardedMemoryStore` write-guard, and (for the
 * end-to-end tests) the real T3 fixtures read through the real
 * `readHermesSource`/`readOpenClawSource`/`discoverSources` pipeline and
 * planned by the real `buildMigrationPlan`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyMigrationPlan,
  defaultApplyFsOps,
  probeTarget,
  readReceipts,
  receiptsPath,
  type ApplyDeps,
  type ApplyFsOps,
} from "../apply";
import { buildMigrationPlan, type MigrationPlan, type PlannedAction } from "../plan";
import { makeItem, type MigrationBundle, type MigrationItem } from "../ir";
import { discoverSources, nodeFsProbe } from "../discovery";
import { readHermesSource, makeMemoryItem } from "../hermes-source";
import { readOpenClawSource } from "../openclaw-source";
import { openSqlite } from "../sqlite-read";
import { SecretVault } from "../secrets";
import { materializeHermesFixture, materializeOpenClawFixture } from "../fixtures";

import { FileMemoryStore, InMemoryMemoryStore } from "../../memory/store";
import { GuardedMemoryStore } from "../../memory/guard";
import { FileSessionStore } from "../../memory/session-store";
import { fileConfigAccess } from "../../state/wiring";
import { FileModelSelection } from "../../models/selection";
import { parseSkillFile } from "../../skills/skill-file";

const KNOWN_MODEL_IDS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "hermes-large-v3", "openclaw-large-v1"];

// ---------------------------------------------------------------------------
// Real-store wiring helper (mirrors ../cli/migrate-command.ts's realApplyDeps)
// ---------------------------------------------------------------------------

function makeRealDeps(dataDir: string, now: () => number = () => Date.now()): ApplyDeps & { knownModelIds: string[] } {
  mkdirSync(dataDir, { recursive: true });
  const baseMemory = new FileMemoryStore(join(dataDir, "memory.json"));
  const memory = new GuardedMemoryStore(baseMemory, { now });
  const sessions = new FileSessionStore(join(dataDir, "sessions.json"));
  const config = fileConfigAccess(dataDir, {});
  const modelSelection = new FileModelSelection(join(dataDir, "model.json"), now);
  const skillsDir = join(dataDir, "skills");
  const contextFilesDir = join(dataDir, "context-files");
  const secretsPath = join(dataDir, "secrets.env");
  return {
    dataDir,
    memory,
    guard: memory,
    sessions,
    config,
    modelSelection,
    skillsDir,
    contextFilesDir,
    secretsPath,
    secrets: new SecretVault(),
    now,
    knownModelIds: KNOWN_MODEL_IDS,
  };
}

function sha256OfFile(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function itemResolver(bundles: MigrationBundle[]) {
  const byHash = new Map<string, MigrationItem>();
  for (const b of bundles) for (const item of b.items) byHash.set(item.hash, item);
  return (action: { itemHash: string }) => byHash.get(action.itemHash);
}

function emptyStats() {
  return { filesScanned: 0, bytesRead: 0, truncated: false };
}

// ---------------------------------------------------------------------------
// Small manual-plan helpers for unit-scoped tests (one kind at a time)
// ---------------------------------------------------------------------------

function planFromBundle(bundle: MigrationBundle, target: ReturnType<typeof probeTarget>, overrides: Partial<Parameters<typeof buildMigrationPlan>[0]["options"]> = {}): MigrationPlan {
  return buildMigrationPlan({
    bundles: [bundle],
    secrets: [],
    target,
    options: { conflict: "skip", importSecrets: true, dryRun: false, now: 1_700_000_000_000, ...overrides },
  });
}

let tmpDirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// readReceipts
// ---------------------------------------------------------------------------

describe("readReceipts", () => {
  it("reports an empty, valid chain for a missing file", () => {
    const dataDir = freshDir("hades-recv-missing-");
    const { entries, chainOk } = readReceipts(receiptsPath(dataDir));
    expect(entries).toEqual([]);
    expect(chainOk).toBe(true);
  });

  it("detects a tampered receipt line as a broken chain", async () => {
    const dataDir = freshDir("hades-recv-tamper-");
    const deps = makeRealDeps(dataDir);
    const bundle: MigrationBundle = {
      vendor: "hermes",
      layout: "hermes-dotfile",
      root: "/x/.hermes",
      items: [makeMemoryItem("the sky is blue", { createdAt: 1, originPath: "memory.json", confidence: 1 })],
      unimportable: [],
      readErrors: [],
      stats: emptyStats(),
    };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);

    const path = result.receiptPath;
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const tampered = JSON.parse(lines[0]);
    tampered.itemHash = "0".repeat(64); // mutate content without recomputing hash
    lines[0] = JSON.stringify(tampered);
    writeFileSync(path, `${lines.join("\n")}\n`);

    const reread = readReceipts(path);
    expect(reread.chainOk).toBe(false);
    expect(reread.brokenAt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-kind writes
// ---------------------------------------------------------------------------

describe("applyMigrationPlan -- memory", () => {
  it("imports a clean fact through the write-guard and it is readable back from the real store", async () => {
    const dataDir = freshDir("hades-apply-mem-");
    const deps = makeRealDeps(dataDir);
    const bundle: MigrationBundle = {
      vendor: "hermes",
      layout: "hermes-dotfile",
      root: "/x/.hermes",
      items: [makeMemoryItem("the user prefers dark mode", { salience: 0.8, tags: ["ui"], createdAt: 5, originPath: "memory.json", confidence: 1 })],
      unimportable: [],
      readErrors: [],
      stats: emptyStats(),
    };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("import");

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });

    expect(result.failed).toBe(0);
    expect(result.applied).toBe(1);
    expect(result.rolledBack).toBe(false);
    expect(result.quarantined).toBe(0);
    expect(deps.memory.all().some((m) => m.fact === "the user prefers dark mode")).toBe(true);

    // Reading back through a FRESH store instance over the same file proves
    // it is durable, not just in-memory.
    const reopened = new FileMemoryStore(join(dataDir, "memory.json"));
    expect(reopened.all().some((m) => m.fact === "the user prefers dark mode")).toBe(true);

    const receipts = readReceipts(result.receiptPath);
    expect(receipts.chainOk).toBe(true);
    expect(receipts.entries).toHaveLength(1);
    expect(receipts.entries[0].ok).toBe(true);
    expect(receipts.entries[0].action).toBe("import");
  });

  it("quarantines a fact that contradicts an existing high-salience memory, and reports it -- never force-writing", async () => {
    const dataDir = freshDir("hades-apply-quarantine-");
    const deps = makeRealDeps(dataDir);
    // Seed a high-salience incumbent fact directly through the guard.
    deps.memory.add({ fact: "the request timeout is 30 seconds", salience: 0.9 });

    const bundle: MigrationBundle = {
      vendor: "hermes",
      layout: "hermes-dotfile",
      root: "/x/.hermes",
      items: [makeMemoryItem("the request timeout is 90 seconds", { salience: 0.9, createdAt: 5, originPath: "memory.json", confidence: 1 })],
      unimportable: [],
      readErrors: [],
      stats: emptyStats(),
    };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });

    expect(result.failed).toBe(0); // quarantine is a SUCCESSFUL, correct outcome, not a failure
    expect(result.quarantined).toBe(1);
    expect(result.rolledBack).toBe(false);
    expect(deps.memory.all().some((m) => m.fact.includes("90 seconds"))).toBe(false); // never force-written
    expect(result.outcomes[0].detail.toLowerCase()).toContain("quarantine");

    const receipts = readReceipts(result.receiptPath);
    expect(receipts.entries[0].action).toBe("quarantine");
    expect(receipts.entries[0].ok).toBe(true);
  });

  it("merges a near-duplicate memory fact (salience=max, tags=union) instead of duplicating it", async () => {
    const dataDir = freshDir("hades-apply-merge-");
    const deps = makeRealDeps(dataDir);
    const existing = deps.memory.add({ fact: "loves pizza", salience: 0.4, tags: ["food"] });

    const bundle: MigrationBundle = {
      vendor: "hermes",
      layout: "hermes-dotfile",
      root: "/x/.hermes",
      items: [makeMemoryItem("Loves pizza.", { salience: 0.9, tags: ["preference"], createdAt: 5, originPath: "memory.json", confidence: 1 })],
      unimportable: [],
      readErrors: [],
      stats: emptyStats(),
    };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("merge");
    expect(plan.actions[0].target.id).toBe(existing.id);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);

    const all = deps.memory.all().filter((m) => m.fact.toLowerCase().includes("pizza"));
    expect(all).toHaveLength(1); // no duplicate
    expect(all[0].salience).toBe(0.9); // max
    expect(new Set(all[0].tags)).toEqual(new Set(["food", "preference"])); // union
  });
});

describe("applyMigrationPlan -- sessions", () => {
  it("imports a session with its original id and timestamps restored on the live record and on disk", async () => {
    const dataDir = freshDir("hades-apply-session-");
    const deps = makeRealDeps(dataDir);
    const sessionValue = {
      id: "imported-session-42",
      title: "Old chat",
      messages: [
        { role: "user", content: "hi", at: 1000 },
        { role: "assistant", content: "hello", at: 1001 },
      ],
      tags: ["fixture"],
      startedAt: 1000,
      endedAt: 1001,
    };
    const item = makeItem({ kind: "session", key: `session:${sessionValue.id}`, value: sessionValue, origin: { path: "sessions/x.jsonl" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("import");

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);

    const live = deps.sessions.all().find((s) => s.id === "imported-session-42");
    expect(live).toBeDefined();
    expect(live!.startedAt).toBe(1000);
    expect(live!.endedAt).toBe(1001);
    expect(live!.messages).toHaveLength(2);
    expect(live!.messages[0].content).toBe("hi");

    // Read back through a fresh store over the actual sessions.json file.
    const reopened = new FileSessionStore(join(dataDir, "sessions.json"));
    const onDisk = reopened.all().find((s) => s.id === "imported-session-42");
    expect(onDisk).toBeDefined();
    expect(onDisk!.startedAt).toBe(1000);
    expect(onDisk!.endedAt).toBe(1001);
    expect(onDisk!.messages.map((m) => m.content)).toEqual(["hi", "hello"]);
  });
});

describe("applyMigrationPlan -- skills", () => {
  it("writes a skill under skillsDir and it round-trips through the real SKILL.md parser", async () => {
    const dataDir = freshDir("hades-apply-skill-");
    const deps = makeRealDeps(dataDir);
    const skillValue = {
      name: "my-skill",
      description: "does a thing",
      capabilities: ["fixture"],
      tools: [],
      instructions: "# my-skill\n\nDo the thing.\n",
      sourcePath: "skills/my-skill/SKILL.md",
      bodySha256: "irrelevant-for-this-test",
    };
    const item = makeItem({ kind: "skill", key: "skill:my-skill", value: skillValue, origin: { path: "skills/my-skill/SKILL.md" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);

    const written = readFileSync(join(dataDir, "skills", "my-skill", "SKILL.md"), "utf8");
    const parsed = parseSkillFile(written);
    expect(parsed.manifest.name).toBe("my-skill");
    expect(parsed.manifest.description).toBe("does a thing");
    expect(parsed.manifest.instructions).toBe("# my-skill\n\nDo the thing.\n");
  });

  it("jails a skill name containing '../', an absolute path, or a NUL -- it cannot escape skillsDir", async () => {
    const dataDir = freshDir("hades-apply-skill-jail-");
    const sibling = freshDir("hades-apply-skill-jail-sibling-");
    const deps = makeRealDeps(dataDir);

    const maliciousNames = ["../../../etc/evil-fixture", join(sibling, "evil"), "evil\0name"];
    for (const name of maliciousNames) {
      const item = makeItem({
        kind: "skill",
        key: "skill:whatever",
        value: { name, description: "d", capabilities: [], tools: [], instructions: "body" },
        origin: { path: "skills/whatever/SKILL.md" },
        confidence: 1,
      });
      const action: PlannedAction = {
        itemKey: "skill:whatever",
        kind: "skill",
        action: "import",
        reason: "test",
        vendor: "hermes",
        sourcePath: "skills/whatever/SKILL.md",
        target: { id: name },
        risk: "none",
        itemHash: item.hash,
      };
      const plan: MigrationPlan = {
        createdAt: 0,
        sources: [],
        actions: [action],
        unimportable: [],
        blockers: [],
        warnings: [],
        summary: { byKind: {}, byAction: { import: 1, merge: 0, rename: 0, overwrite: 0, skip: 0, quarantine: 0, abstain: 0 }, destructive: 0, secretsToWrite: 0, alreadyImported: 0 },
        dryRun: false,
        planHash: "test",
      };
      const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: () => item };
      const result = await applyMigrationPlan(plan, { ...deps, fsOps });
      expect(result.failed).toBe(1);
      expect(result.rolledBack).toBe(true);
    }

    // The sibling temp dir (used by the absolute-path attempt) must remain empty.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(sibling)).toEqual([]);
  });
});

describe("applyMigrationPlan -- config", () => {
  it("sets a nested config field without clobbering sibling fields", async () => {
    const dataDir = freshDir("hades-apply-config-");
    const deps = makeRealDeps(dataDir);
    deps.config.write({ gateway: { allowedUsers: ["alice"] } });

    const item = makeItem({ kind: "config", key: "config:gateway.trigger", value: "!hades", origin: { path: "config.json" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);

    const loaded = deps.config.load();
    expect(loaded.gateway.trigger).toBe("!hades");
    expect(loaded.gateway.allowedUsers).toEqual(["alice"]); // untouched sibling field
  });
});

describe("applyMigrationPlan -- model", () => {
  it("sets the active model selection from target.id", async () => {
    const dataDir = freshDir("hades-apply-model-");
    const deps = makeRealDeps(dataDir);
    const item = makeItem({ kind: "model", key: "model:selection", value: { modelId: "claude-sonnet-5" }, origin: { path: "model.json" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("import");

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);
    expect(deps.modelSelection.get()).toBe("claude-sonnet-5");
  });

  it("refuses to select a model id outside knownModelIds (abstain) rather than writing it", async () => {
    const dataDir = freshDir("hades-apply-model-unknown-");
    const deps = makeRealDeps(dataDir);
    const item = makeItem({ kind: "model", key: "model:selection", value: { modelId: "totally-unknown-model" }, origin: { path: "model.json" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("abstain");
    expect(plan.blockers.some((b) => b.code === "model-unknown")).toBe(true);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);
    expect(deps.modelSelection.get()).toBeUndefined();
  });
});

describe("applyMigrationPlan -- secrets", () => {
  it("writes a secret env var to secretsPath at mode 0600 and never leaks material elsewhere", async () => {
    const dataDir = freshDir("hades-apply-secret-");
    const deps = makeRealDeps(dataDir);
    const distinctiveMaterial = "sk-ant-VERY-DISTINCTIVE-SECRET-VALUE-abc123XYZ";
    deps.secrets.add({ envVar: "OPENAI_API_KEY", provider: "openai", origin: { path: ".env" }, confidence: 1, looksValid: true }, distinctiveMaterial);

    const item = makeItem({ kind: "secret", key: "secret:OPENAI_API_KEY", value: { envVar: "OPENAI_API_KEY", present: true }, origin: { path: ".env" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions[0].action).toBe("import");

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);
    expect(result.secretsWritten).toBe(1);

    const secretsText = readFileSync(deps.secretsPath, "utf8");
    expect(secretsText).toContain(distinctiveMaterial);

    if (process.platform !== "win32") {
      const mode = statSync(deps.secretsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Secret hygiene: no receipt line, no outcome detail/target, and no
    // other written file may contain the raw material.
    const receiptsText = readFileSync(result.receiptPath, "utf8");
    expect(receiptsText).not.toContain(distinctiveMaterial);
    for (const o of result.outcomes) {
      expect(o.detail).not.toContain(distinctiveMaterial);
      expect(o.target ?? "").not.toContain(distinctiveMaterial);
    }
    expect(JSON.stringify(result)).not.toContain(distinctiveMaterial);
  });
});

describe("applyMigrationPlan -- context files", () => {
  it("writes a context file under contextFilesDir", async () => {
    const dataDir = freshDir("hades-apply-ctx-");
    const deps = makeRealDeps(dataDir);
    const item = makeItem({
      kind: "context-file",
      key: "context:notes/USER.md",
      value: { relPath: "notes/USER.md", content: "# User\n\nLikes tea.\n" },
      origin: { path: "memory/USER.md" },
      confidence: 1,
    });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(0);
    const written = readFileSync(join(dataDir, "context-files", "notes", "USER.md"), "utf8");
    expect(written).toBe("# User\n\nLikes tea.\n");
  });
});

// ---------------------------------------------------------------------------
// Failure / rollback / resume / concurrency
// ---------------------------------------------------------------------------

describe("applyMigrationPlan -- rollback on failure", () => {
  it("rolls every file back to byte-identical pre-state when a later action in the same run fails", async () => {
    const dataDir = freshDir("hades-apply-rollback-");
    const deps = makeRealDeps(dataDir);

    const skillItem = makeItem({
      kind: "skill",
      key: "skill:ok-skill",
      value: { name: "ok-skill", description: "d", capabilities: [], tools: [], instructions: "body" },
      origin: { path: "skills/ok-skill/SKILL.md" },
      confidence: 1,
    });
    const memItem = makeMemoryItem("this write will fail", { createdAt: 1, originPath: "memory.json", confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [skillItem, memItem], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);
    expect(plan.actions.map((a) => a.kind).sort()).toEqual(["memory", "skill"].sort()); // order per KIND_ORDER: skill before memory

    const memoryPathBefore = join(dataDir, "memory.json");
    const shaBeforeMemory = sha256OfFile(memoryPathBefore); // undefined: file does not exist yet

    // A memory store whose .add() throws -- a real, deterministic failure
    // injected at the engine boundary (not a fs fault).
    class ThrowingMemoryStore extends InMemoryMemoryStore {
      override add(): never {
        throw new Error("simulated write failure");
      }
    }
    const throwingDeps: ApplyDeps = { ...deps, memory: new ThrowingMemoryStore(), guard: undefined };

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const result = await applyMigrationPlan(plan, { ...throwingDeps, fsOps });

    expect(result.rolledBack).toBe(true);
    expect(result.failed).toBeGreaterThan(0);

    // The skill file that succeeded FIRST must have been rolled back too.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dataDir, "skills", "ok-skill", "SKILL.md"))).toBe(false);

    // memory.json must be back to its pre-transaction state (it did not exist before).
    expect(sha256OfFile(memoryPathBefore)).toBe(shaBeforeMemory);

    // The receipt chain must be clean (rolled back, not left half-written).
    const receipts = readReceipts(result.receiptPath);
    expect(receipts.entries).toHaveLength(0);
    expect(receipts.chainOk).toBe(true);
  });

  it("reports an honest blocker (not a crash) when the data directory cannot be prepared", async () => {
    const dataDir = freshDir("hades-apply-noprep-");
    const deps = makeRealDeps(dataDir);
    const item = makeItem({ kind: "model", key: "model:selection", value: { modelId: "claude-sonnet-5" }, origin: { path: "model.json" }, confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = {
      ...defaultApplyFsOps(),
      mkdirp() {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      resolveItem: itemResolver([bundle]),
    };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBeGreaterThan(0);
    expect(result.outcomes.some((o) => o.detail.includes("cannot prepare"))).toBe(true);
    expect(result.rolledBack).toBe(false); // nothing was ever started
  });
});

describe("applyMigrationPlan -- resume / idempotency", () => {
  it("skips actions already recorded in the receipt chain and does not duplicate the write", async () => {
    const dataDir = freshDir("hades-apply-resume-");
    const deps1 = makeRealDeps(dataDir);
    const item = makeMemoryItem("resume test fact", { createdAt: 1, originPath: "memory.json", confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target1 = probeTarget(deps1);
    const plan = planFromBundle(bundle, target1);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver([bundle]) };
    const first = await applyMigrationPlan(plan, { ...deps1, fsOps });
    expect(first.failed).toBe(0);
    expect(first.applied).toBe(1);

    // Re-run the SAME plan object (same itemHash) against a freshly-opened
    // set of stores over the SAME dataDir -- apply.ts's own receipt-based
    // resume logic must short-circuit this, independent of plan.ts.
    const deps2 = makeRealDeps(dataDir);
    const second = await applyMigrationPlan(plan, { ...deps2, fsOps });
    expect(second.failed).toBe(0);
    expect(second.receiptHead).toBe(first.receiptHead); // no new receipt entries
    expect(second.outcomes[0].detail).toContain("already applied");

    const facts = deps2.memory.all().filter((m) => m.fact === "resume test fact");
    expect(facts).toHaveLength(1); // not duplicated
  });
});

describe("applyMigrationPlan -- concurrency", () => {
  it("refuses to run when the lock is already held, without corrupting existing state", async () => {
    const dataDir = freshDir("hades-apply-lock-");
    const deps = makeRealDeps(dataDir);
    deps.memory.add({ fact: "pre-existing fact", salience: 0.5 });
    const memoryPath = join(dataDir, "memory.json");
    const shaBefore = sha256OfFile(memoryPath);

    const item = makeMemoryItem("blocked by lock", { createdAt: 1, originPath: "memory.json", confidence: 1 });
    const bundle: MigrationBundle = { vendor: "hermes", layout: "hermes-dotfile", root: "/x/.hermes", items: [item], unimportable: [], readErrors: [], stats: emptyStats() };
    const target = probeTarget(deps);
    const plan = planFromBundle(bundle, target);

    const fsOps: ApplyFsOps = {
      ...defaultApplyFsOps(),
      acquireLock: () => undefined, // simulates another process already holding it
      resolveItem: itemResolver([bundle]),
    };
    const result = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(result.failed).toBe(1);
    expect(result.outcomes[0].detail.toLowerCase()).toContain("already running");
    expect(sha256OfFile(memoryPath)).toBe(shaBefore); // untouched
    expect(deps.memory.all().some((m) => m.fact === "blocked by lock")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real Hermes + real OpenClaw fixtures (one with a real sqlite db)
// ---------------------------------------------------------------------------

describe("applyMigrationPlan -- end to end against real T3 fixtures", () => {
  it("migrates Hermes + OpenClaw fixtures into a fresh dataDir and reads everything back through the real engine, then re-applying makes zero new writes", async () => {
    const root = freshDir("hades-apply-e2e-");
    const hermesRoot = join(root, "hermes-src");
    const openclawRoot = join(root, "openclaw-src");
    const dataDir = join(root, "dataDir");

    materializeHermesFixture(hermesRoot, { variant: "home", withSqlite: true, withSecrets: true, memories: 3, sessions: 2, skills: 2, seed: 3 });
    materializeOpenClawFixture(openclawRoot, { variant: "home", withSecrets: true, memories: 3, sessions: 2, skills: 2, seed: 5 });

    const probe = nodeFsProbe();
    const { sources: allSources } = discoverSources(probe, {
      platform: process.platform,
      home: "/nonexistent-home-for-this-test",
      env: process.env,
      explicitRoots: [
        { root: hermesRoot, vendor: "hermes" },
        { root: openclawRoot, vendor: "openclaw" },
      ],
    });
    expect(allSources.length).toBeGreaterThan(0);
    // `explicitRoots` against one literal path matches every layout alias
    // sharing that vendor's required markers (env-home/xdg/dotfile all point
    // at the identical directory here) -- collapse to one representative
    // DiscoveredSource per vendor so each fixture file is read exactly once.
    const sources = [allSources.find((s) => s.vendor === "hermes")!, allSources.find((s) => s.vendor === "openclaw")!];
    expect(sources.every(Boolean)).toBe(true);

    const now = () => 1_700_000_000_000;
    const bundles: MigrationBundle[] = [];
    const vault = new SecretVault();
    for (const source of sources) {
      const reader = source.vendor === "hermes" ? readHermesSource : readOpenClawSource;
      const { bundle, secrets } = await reader(source, { probe, openSqlite, now });
      bundles.push(bundle);
      for (const e of secrets.entries) vault.add({ envVar: e.envVar, provider: "test", origin: e.origin, confidence: 1, looksValid: true }, e.value);
    }
    expect(bundles.every((b) => b.readErrors.length === 0)).toBe(true);

    const deps = makeRealDeps(dataDir, now);
    deps.secrets = vault;
    const target = probeTarget(deps);
    const plan = buildMigrationPlan({ bundles, secrets: vault.list(), target, options: { conflict: "skip", importSecrets: true, dryRun: false, now: now() } });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.length).toBeGreaterThan(0);

    const fsOps: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver(bundles) };
    const first = await applyMigrationPlan(plan, { ...deps, fsOps });
    expect(first.failed).toBe(0);
    expect(first.rolledBack).toBe(false);
    expect(first.applied).toBeGreaterThan(0);

    const chain = readReceipts(first.receiptPath);
    expect(chain.chainOk).toBe(true);
    expect(chain.entries.length).toBeGreaterThan(0);

    // -- Read back through the REAL engine -----------------------------
    const memoryOnDisk = new FileMemoryStore(join(dataDir, "memory.json"));
    expect(memoryOnDisk.size()).toBeGreaterThan(0);

    const sessionsOnDisk = new FileSessionStore(join(dataDir, "sessions.json"));
    expect(sessionsOnDisk.size()).toBeGreaterThan(0);
    for (const s of sessionsOnDisk.all()) {
      expect(s.messages.length).toBeGreaterThan(0);
      expect(typeof s.startedAt).toBe("number");
    }
    // At least one hermes session id (session-0/session-1) and one openclaw
    // session id (oc-session-0/oc-session-1) landed with recognizable ids.
    expect(sessionsOnDisk.all().some((s) => s.id.startsWith("session-"))).toBe(true);
    expect(sessionsOnDisk.all().some((s) => s.id.startsWith("oc-session-"))).toBe(true);

    const { readdirSync, existsSync } = await import("node:fs");
    const skillDirs = readdirSync(join(dataDir, "skills"));
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const dir of skillDirs) {
      const skillFile = join(dataDir, "skills", dir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const parsed = parseSkillFile(readFileSync(skillFile, "utf8"));
      expect(parsed.manifest.name.length).toBeGreaterThan(0);
    }

    const configOnDisk = fileConfigAccess(dataDir, {}).load();
    expect(configOnDisk.locale.length).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, "config.json"))).toBe(true);
    expect(existsSync(join(dataDir, "model.json"))).toBe(true);

    expect(existsSync(deps.secretsPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(deps.secretsPath).mode & 0o777).toBe(0o600);
    }

    // -- Idempotency: re-scan + re-plan + re-apply -> zero new writes ----
    const bundles2: MigrationBundle[] = [];
    const vault2 = new SecretVault();
    for (const source of sources) {
      const reader = source.vendor === "hermes" ? readHermesSource : readOpenClawSource;
      const { bundle, secrets } = await reader(source, { probe, openSqlite, now });
      bundles2.push(bundle);
      for (const e of secrets.entries) vault2.add({ envVar: e.envVar, provider: "test", origin: e.origin, confidence: 1, looksValid: true }, e.value);
    }
    const deps2 = makeRealDeps(dataDir, now);
    deps2.secrets = vault2;
    const target2 = probeTarget(deps2);
    const plan2 = buildMigrationPlan({ bundles: bundles2, secrets: vault2.list(), target: target2, options: { conflict: "skip", importSecrets: true, dryRun: false, now: now() } });
    const fsOps2: ApplyFsOps = { ...defaultApplyFsOps(), resolveItem: itemResolver(bundles2) };
    const second = await applyMigrationPlan(plan2, { ...deps2, fsOps: fsOps2 });
    expect(second.failed).toBe(0);
    expect(second.receiptHead).toBe(first.receiptHead);

    const memoryOnDisk2 = new FileMemoryStore(join(dataDir, "memory.json"));
    expect(memoryOnDisk2.size()).toBe(memoryOnDisk.size());
    const sessionsOnDisk2 = new FileSessionStore(join(dataDir, "sessions.json"));
    expect(sessionsOnDisk2.size()).toBe(sessionsOnDisk.size());
  }, 30_000);
});
