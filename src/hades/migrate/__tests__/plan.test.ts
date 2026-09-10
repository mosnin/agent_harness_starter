/**
 * Tests for `src/hades/migrate/plan.ts` -- the migration conflict engine.
 *
 * Exercises real behavior against real `MigrationBundle`s built with T1's
 * own helpers (`makeItem`, `makeMemoryItem` from `../ir` / `../hermes-source`)
 * and hand-built `TargetProbe`s -- no fs, no mocking. Covers every kind's
 * conflict semantics, every `BlockerCode`, the "no destructive action
 * survives a blocker" invariant, order-independence of `planHash`, and a
 * property-style loop asserting total, lossless accounting across all five
 * conflict policies.
 */
import { describe, expect, it } from "vitest";

import {
  buildMigrationPlan,
  type ConflictPolicy,
  type MigrateOptions,
  type PlannedAction,
  type TargetProbe,
} from "../plan";
import { itemHash, makeItem } from "../ir";
import type { ArtifactKind, MigrationBundle, MigrationItem } from "../ir";
import { makeMemoryItem } from "../hermes-source";
import type { SecretDescriptor } from "../secrets";
import type { JsonValue } from "../../state/record";
import { DEFAULT_CONFIG } from "../../config/config";
import { sha256Hex } from "../../styx/certificate";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function emptyStats() {
  return { filesScanned: 0, bytesRead: 0, truncated: false };
}

function bundle(overrides: Partial<MigrationBundle> = {}): MigrationBundle {
  return {
    vendor: "hermes",
    layout: "hermes-dotfile",
    root: "/home/u/.hermes",
    items: [],
    unimportable: [],
    readErrors: [],
    stats: emptyStats(),
    ...overrides,
  };
}

function target(overrides: Partial<TargetProbe> = {}): TargetProbe {
  return {
    dataDir: "/home/u/.hades",
    memoryFacts: [],
    sessions: [],
    skills: [],
    config: { ...DEFAULT_CONFIG },
    knownModelIds: ["claude-sonnet-5", "claude-haiku-5"],
    contextFiles: [],
    envVarNames: [],
    secretsFilePath: "/home/u/.hades/secrets.env",
    writable: { config: true, model: true, memory: true, session: true, skill: true, secret: true, "context-file": true, "tool-state": true, unknown: true },
    priorReceipts: [],
    ...overrides,
  };
}

function options(overrides: Partial<MigrateOptions> = {}): MigrateOptions {
  return { conflict: "skip", importSecrets: true, dryRun: true, now: 1_700_000_000_000, ...overrides };
}

function configItem(path: string, value: JsonValue, originPath = "/home/u/.hermes/config.json"): MigrationItem {
  return makeItem({ kind: "config", key: `config:${path}`, value, origin: { path: originPath }, confidence: 1 });
}

function modelItem(modelId: string, originPath = "/home/u/.hermes/model.json"): MigrationItem {
  return makeItem({ kind: "model", key: "model:selection", value: { modelId }, origin: { path: originPath }, confidence: 1 });
}

function sessionItem(id: string, startedAt: number, originPath?: string): MigrationItem {
  return makeItem({
    kind: "session",
    key: `session:${id}`,
    value: { id, messages: [{ role: "user", content: "hi", at: startedAt }], tags: [], startedAt, endedAt: startedAt },
    origin: { path: originPath ?? `/home/u/.hermes/sessions/${id}.jsonl` },
    confidence: 1,
  });
}

function skillItem(name: string, body: string, opts?: { mtimeMs?: number; originPath?: string }): MigrationItem {
  const bodySha256 = itemHash("skill", `bodyof:${name}`, body); // cheap stand-in hash, deterministic per body text
  const value: JsonValue = {
    name,
    description: `desc ${name}`,
    capabilities: [],
    tools: [],
    instructions: body,
    sourcePath: `skills/${name}/SKILL.md`,
    bodySha256,
    ...(opts?.mtimeMs !== undefined ? { mtimeMs: opts.mtimeMs } : {}),
  };
  return makeItem({ kind: "skill", key: `skill:${name}`, value, origin: { path: opts?.originPath ?? `/home/u/.hermes/skills/${name}/SKILL.md` }, confidence: 1 });
}

function contextFileItem(relPath: string, content: string, originPath?: string): MigrationItem {
  return makeItem({ kind: "context-file", key: `context:${relPath}`, value: { relPath, content }, origin: { path: originPath ?? `/home/u/.hermes/memory/${relPath}` }, confidence: 1 });
}

function secretItemInBundle(envVar: string, present = true, originPath = "/home/u/.hermes/.env"): MigrationItem {
  return makeItem({ kind: "secret", key: `secret:${envVar}`, value: { envVar, present }, origin: { path: originPath, locator: envVar }, confidence: 1 });
}

function secretDescriptor(envVar: string, overrides: Partial<SecretDescriptor> = {}): SecretDescriptor {
  return {
    envVar,
    provider: "openai",
    fingerprint: "abcdef123456",
    length: 40,
    origin: { path: "/home/u/.hermes/.env", locator: envVar },
    confidence: 1,
    looksValid: true,
    ...overrides,
  };
}

function toolStateItem(toolId: string, value: JsonValue, originPath = "/home/u/.hermes/tool-state/x.json"): MigrationItem {
  return makeItem({ kind: "tool-state", key: `tool-state:${toolId}`, value, origin: { path: originPath }, confidence: 1 });
}

function byKey(actions: PlannedAction[], itemKey: string): PlannedAction {
  const found = actions.find((a) => a.itemKey === itemKey);
  if (!found) throw new Error(`no action for itemKey ${itemKey}; actions were: ${actions.map((a) => a.itemKey).join(", ")}`);
  return found;
}

// ---------------------------------------------------------------------------
// Basic imports, one per kind
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- plain imports (no conflicts)", () => {
  it("imports a config field not present in target", () => {
    const b = bundle({ items: [configItem("gateway.trigger", "!hades")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    const a = byKey(plan.actions, "config:gateway.trigger");
    expect(a.action).toBe("import");
    expect(a.risk).toBe("low");
    expect(a.target.field).toBe("gateway.trigger");
    expect(plan.blockers).toEqual([]);
  });

  it("imports a known model id when none is currently selected", () => {
    const b = bundle({ items: [modelItem("claude-sonnet-5")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target({ modelSelection: undefined }), options: options() });
    const a = byKey(plan.actions, "model:selection");
    expect(a.action).toBe("import");
  });

  it("imports a memory fact with no near-duplicate", () => {
    const item = makeMemoryItem("the user prefers dark mode", { createdAt: 1000, originPath: "/home/u/.hermes/memory/MEMORY.md", confidence: 1 });
    const b = bundle({ items: [item] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    const a = byKey(plan.actions, item.key);
    expect(a.action).toBe("import");
    expect(a.risk).toBe("none");
  });

  it("imports a session with a fresh id", () => {
    const b = bundle({ items: [sessionItem("s1", 1000)] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    expect(byKey(plan.actions, "session:s1").action).toBe("import");
  });

  it("imports a skill with a fresh name", () => {
    const b = bundle({ items: [skillItem("greeter", "say hi")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    expect(byKey(plan.actions, "skill:greeter").action).toBe("import");
  });

  it("imports a context-file with a fresh relPath", () => {
    const b = bundle({ items: [contextFileItem("USER.md", "the user is Sam")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    expect(byKey(plan.actions, "context:USER.md").action).toBe("import");
  });

  it("imports a fresh secret env var and counts it in secretsToWrite", () => {
    const b = bundle({ items: [secretItemInBundle("OPENAI_API_KEY")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    const a = byKey(plan.actions, "secret:OPENAI_API_KEY");
    expect(a.action).toBe("import");
    expect(a.target.path).toBe("/home/u/.hades/secrets.env");
    expect(plan.summary.secretsToWrite).toBe(1);
  });

  it("imports tool-state and unknown items with no target counterpart", () => {
    const b = bundle({ items: [toolStateItem("browser", { cookies: [] })] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    expect(byKey(plan.actions, "tool-state:browser").action).toBe("import");
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- idempotency via priorReceipts", () => {
  it("skips an item whose itemHash matches a prior receipt, with reason 'already-imported'", () => {
    const item = configItem("locale", "fr");
    const b = bundle({ items: [item] });
    const t = target({ priorReceipts: [{ itemKey: item.key, itemHash: item.hash, action: "import", at: 1 }] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options() });
    const a = byKey(plan.actions, item.key);
    expect(a.action).toBe("skip");
    expect(a.reason).toBe("already-imported");
    expect(plan.summary.alreadyImported).toBe(1);
  });

  it("does NOT treat a changed value (different itemHash, same key) as already-imported", () => {
    const item = configItem("locale", "fr");
    const b = bundle({ items: [item] });
    const t = target({ priorReceipts: [{ itemKey: item.key, itemHash: "deadbeef", action: "import", at: 1 }] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options() });
    const a = byKey(plan.actions, item.key);
    expect(a.reason).not.toBe("already-imported");
  });
});

// ---------------------------------------------------------------------------
// Memory: normalized near-duplicate detection
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- memory near-duplicate merge", () => {
  it("merges a fact that only differs from an incumbent by case/punctuation, regardless of policy", () => {
    const item = makeMemoryItem("Loves pizza.", { createdAt: 2000, originPath: "/home/u/.hermes/memory/MEMORY.md", confidence: 1 });
    const b = bundle({ items: [item] });
    const t = target({ memoryFacts: [{ id: "m1", fact: "loves pizza", salience: 0.4, tags: ["food"], createdAt: 1000 }] });
    for (const policy of ["skip", "overwrite", "rename", "newest", "ask"] as ConflictPolicy[]) {
      const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: policy }) });
      const a = byKey(plan.actions, item.key);
      expect(a.action).toBe("merge");
      expect(a.reason).toMatch(/salience/);
      expect(a.reason).toMatch(/tags/);
      expect(a.risk).not.toBe("destructive");
    }
  });

  it("merges two near-duplicate facts observed within the same run (no target incumbent)", () => {
    const item1 = makeMemoryItem("The user's name is Sam", { createdAt: 1000, originPath: "/home/u/.hermes/memory/MEMORY.md", confidence: 1 });
    const item2 = makeMemoryItem("the user's name is sam.", { createdAt: 1500, originPath: "/home/u/.openclaw/memory/MEMORY.md", confidence: 1 });
    const b1 = bundle({ items: [item1], root: "/home/u/.hermes" });
    const b2 = bundle({ vendor: "openclaw", layout: "openclaw-dotfile", root: "/home/u/.openclaw", items: [item2] });
    const plan = buildMigrationPlan({ bundles: [b1, b2], secrets: [], target: target(), options: options() });
    const actions = [byKey(plan.actions, item1.key), byKey(plan.actions, item2.key)];
    const kinds = actions.map((a) => a.action).sort();
    expect(kinds).toEqual(["import", "merge"]);
  });

  it("does not merge genuinely different facts", () => {
    const item = makeMemoryItem("loves sushi", { createdAt: 1000, originPath: "/x", confidence: 1 });
    const t = target({ memoryFacts: [{ id: "m1", fact: "loves pizza", salience: 0.4, tags: [], createdAt: 1000 }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options() });
    expect(byKey(plan.actions, item.key).action).toBe("import");
  });
});

// ---------------------------------------------------------------------------
// Sessions: exact-id collision, per policy
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- session id collisions", () => {
  const t = target({ sessions: [{ id: "abc", startedAt: 1000 }] });

  it("policy=skip keeps the incumbent", () => {
    const b = bundle({ items: [sessionItem("abc", 500)] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "skip" }) });
    const a = byKey(plan.actions, "session:abc");
    expect(a.action).toBe("skip");
    expect(a.conflict?.policy).toBe("skip");
  });

  it("policy=overwrite replaces the incumbent and is destructive", () => {
    const b = bundle({ items: [sessionItem("abc", 500)] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    const a = byKey(plan.actions, "session:abc");
    expect(a.action).toBe("overwrite");
    expect(a.risk).toBe("destructive");
  });

  it("policy=rename suffixes rather than ever overwriting", () => {
    const b = bundle({ items: [sessionItem("abc", 500)] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "rename" }) });
    const a = byKey(plan.actions, "session:abc");
    expect(a.action).toBe("rename");
    expect(a.renamedTo).toMatch(/^abc__migrated_\d+$/);
    expect(a.risk).not.toBe("destructive");
  });

  it("policy=rename disambiguates a third occurrence of the same id", () => {
    const b = bundle({ items: [sessionItem("abc", 500, "/a"), sessionItem("abc", 600, "/b")] });
    // two different physical items sharing the raw key "session:abc" from the SAME bundle;
    // ir.ts's `key` grammar allows duplicate keys across the raw item list (validateBundle,
    // not exercised here, is what would normally reject it) -- plan.ts must still give each
    // physical item its own outcome.
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "rename" }) });
    expect(plan.actions).toHaveLength(2);
    const keys = new Set(plan.actions.map((a) => a.itemKey));
    expect(keys.size).toBe(2);
    const renamedTos = plan.actions.map((a) => a.renamedTo).filter((x): x is string => x !== undefined);
    expect(new Set(renamedTos).size).toBe(renamedTos.length); // all unique
  });

  it("policy=newest overwrites only when the source is strictly more recent", () => {
    const older = bundle({ items: [sessionItem("abc", 500)] });
    const newer = bundle({ items: [sessionItem("abc", 5000)] });
    const planOlder = buildMigrationPlan({ bundles: [older], secrets: [], target: t, options: options({ conflict: "newest" }) });
    const planNewer = buildMigrationPlan({ bundles: [newer], secrets: [], target: t, options: options({ conflict: "newest" }) });
    expect(byKey(planOlder.actions, "session:abc").action).toBe("skip");
    expect(byKey(planNewer.actions, "session:abc").action).toBe("overwrite");
    expect(byKey(planNewer.actions, "session:abc").risk).toBe("destructive");
  });

  it("policy=ask abstains and never silently picks a side", () => {
    const b = bundle({ items: [sessionItem("abc", 500)] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "ask" }) });
    const a = byKey(plan.actions, "session:abc");
    expect(a.action).toBe("abstain");
    expect(plan.blockers.some((bl) => bl.code === "policy-requires-confirmation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- skill collisions", () => {
  it("skips when content is byte-identical (sha256 match), regardless of policy", () => {
    const item = skillItem("greeter", "say hi");
    const bodySha = (item.value as { bodySha256: string }).bodySha256;
    const t = target({ skills: [{ name: "greeter", path: "/x/greeter", mtimeMs: 1, sha256: bodySha }] });
    for (const policy of ["skip", "overwrite", "rename", "newest", "ask"] as ConflictPolicy[]) {
      const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: policy }) });
      expect(byKey(plan.actions, "skill:greeter").action).toBe("skip");
    }
  });

  it("policy=rename produces a jail-safe unique name for a traversal-shaped incoming key", () => {
    // The key itself is grammar-safe (ir.ts enforces that upstream); this proves the RENAME
    // output stays inside the safe charset even so, and is unique against the incumbent.
    const item = skillItem("weird..name", "body A");
    const t = target({ skills: [{ name: "weird..name", path: "/x", mtimeMs: 1, sha256: "zzz" }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "rename" }) });
    const a = byKey(plan.actions, "skill:weird..name");
    expect(a.action).toBe("rename");
    expect(a.renamedTo).toBeDefined();
    expect(a.renamedTo).not.toMatch(/\.\./);
    expect(a.renamedTo).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it("policy=newest defaults to keeping the incumbent when the source carries no mtime", () => {
    const item = skillItem("greeter", "body B"); // no mtimeMs on this item
    const t = target({ skills: [{ name: "greeter", path: "/x", mtimeMs: 999, sha256: "aaa" }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "newest" }) });
    const a = byKey(plan.actions, "skill:greeter");
    expect(a.action).toBe("skip");
    expect(a.reason).toMatch(/no mtime/);
  });

  it("policy=newest overwrites when the source mtime is strictly newer", () => {
    const item = skillItem("greeter", "body C", { mtimeMs: 5000 });
    const t = target({ skills: [{ name: "greeter", path: "/x", mtimeMs: 100, sha256: "aaa" }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "newest" }) });
    const a = byKey(plan.actions, "skill:greeter");
    expect(a.action).toBe("overwrite");
    expect(a.risk).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- config field collisions", () => {
  it("skips when the value already matches (before === after)", () => {
    const item = configItem("locale", "en");
    const t = target({ config: { ...DEFAULT_CONFIG, locale: "en" } });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options() });
    expect(byKey(plan.actions, "config:locale").action).toBe("skip");
  });

  it("policy=rename stores the incoming value at a '.imported' side path instead of discarding it", () => {
    const item = configItem("locale", "fr");
    const t = target({ config: { ...DEFAULT_CONFIG, locale: "en" } });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "rename" }) });
    const a = byKey(plan.actions, "config:locale");
    expect(a.action).toBe("rename");
    expect(a.renamedTo).toBe("locale.imported");
    expect(a.target.field).toBe("locale.imported");
  });

  it("policy=newest cannot compare recency for config and conservatively skips", () => {
    const item = configItem("locale", "fr");
    const t = target({ config: { ...DEFAULT_CONFIG, locale: "en" } });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "newest" }) });
    expect(byKey(plan.actions, "config:locale").action).toBe("skip");
  });

  it("policy=overwrite is destructive and shows before/after in the reason", () => {
    const item = configItem("locale", "fr");
    const t = target({ config: { ...DEFAULT_CONFIG, locale: "en" } });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    const a = byKey(plan.actions, "config:locale");
    expect(a.action).toBe("overwrite");
    expect(a.risk).toBe("destructive");
    expect(a.reason).toContain("before=");
    expect(a.reason).toContain("after=");
  });
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- model selection", () => {
  it("an unknown model id becomes abstain plus a model-unknown blocker, never selected", () => {
    const item = modelItem("nonexistent-model-xyz");
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: target(), options: options() });
    const a = byKey(plan.actions, "model:selection");
    expect(a.action).toBe("abstain");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "model-unknown", message: expect.stringContaining("nonexistent-model-xyz") }),
    );
    expect(plan.actions.some((x) => x.action === "overwrite" || x.action === "import" || x.action === "merge")).toBe(false);
  });

  it("policy=overwrite replaces a different-but-known incumbent model", () => {
    const item = modelItem("claude-haiku-5");
    const t = target({ modelSelection: "claude-sonnet-5" });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    const a = byKey(plan.actions, "model:selection");
    expect(a.action).toBe("overwrite");
    expect(a.risk).toBe("destructive");
  });

  it("a malformed model item (no modelId) is reported as unimportable, not silently dropped", () => {
    const item = makeItem({ kind: "model", key: "model:selection", value: { notAModelId: true }, origin: { path: "/x" }, confidence: 1 });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: target(), options: options() });
    expect(plan.actions).toHaveLength(0);
    expect(plan.unimportable).toHaveLength(1);
    expect(plan.unimportable[0].kind).toBe("model");
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- secrets", () => {
  it("skips an existing env var under every policy except overwrite, and never carries material", () => {
    const t = target({ envVarNames: ["OPENAI_API_KEY"] });
    for (const policy of ["skip", "rename", "newest", "ask"] as ConflictPolicy[]) {
      const b = bundle({ items: [secretItemInBundle("OPENAI_API_KEY")] });
      const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: policy }) });
      const a = byKey(plan.actions, "secret:OPENAI_API_KEY");
      expect(a.action).toBe("skip");
    }
    const b2 = bundle({ items: [secretItemInBundle("OPENAI_API_KEY")] });
    const overwritePlan = buildMigrationPlan({ bundles: [b2], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    expect(byKey(overwritePlan.actions, "secret:OPENAI_API_KEY").action).toBe("overwrite");
  });

  it("importSecrets=false refuses fresh secrets and raises secrets-refused", () => {
    const b = bundle({ items: [secretItemInBundle("BRAND_NEW_KEY")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options({ importSecrets: false }) });
    const a = byKey(plan.actions, "secret:BRAND_NEW_KEY");
    expect(a.action).toBe("skip");
    expect(plan.blockers.some((bl) => bl.code === "secrets-refused")).toBe(true);
    expect(plan.summary.secretsToWrite).toBe(0);
  });

  it("a top-level SecretDescriptor for the same env var as a bundle item is a within-run duplicate", () => {
    const b = bundle({ items: [secretItemInBundle("DUPLICATE_KEY", true, "/home/u/.hermes/.env")] });
    const d = secretDescriptor("DUPLICATE_KEY", { origin: { path: "/home/u/.hermes/.env" } });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [d], target: target(), options: options() });
    const actionsForKey = plan.actions.filter((a) => a.itemKey.startsWith("secret:DUPLICATE_KEY"));
    expect(actionsForKey).toHaveLength(2);
    const kinds = actionsForKey.map((a) => a.action).sort();
    expect(kinds).toEqual(["import", "skip"]);
  });

  it("never renders/stores the descriptor's real material -- SecretDescriptor has no material field at all", () => {
    const d = secretDescriptor("SOME_KEY");
    // Structural guarantee: the type itself carries no material. Belt-and-braces, also check
    // the produced action's JSON-serializable surface never contains anything but metadata.
    const plan = buildMigrationPlan({ bundles: [], secrets: [d], target: target(), options: options() });
    const a = byKey(plan.actions, "secret:SOME_KEY");
    expect(JSON.stringify(a)).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });
});

// ---------------------------------------------------------------------------
// Context files
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- context-file collisions", () => {
  it("skips identical content by sha256", () => {
    const content = "the user is Sam";
    const item = contextFileItem("USER.md", content);
    const t = target({ contextFiles: [{ relPath: "USER.md", sha256: sha256Hex(content) }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options() });
    expect(byKey(plan.actions, "context:USER.md").action).toBe("skip");
  });

  it("policy=overwrite is destructive on differing content", () => {
    const item = contextFileItem("USER.md", "new content");
    const t = target({ contextFiles: [{ relPath: "USER.md", sha256: "not-matching" }] });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    const a = byKey(plan.actions, "context:USER.md");
    expect(a.action).toBe("overwrite");
    expect(a.risk).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// only / exclude
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- only/exclude filters", () => {
  it("excludes a kind via `exclude`, still producing exactly one action for it", () => {
    const b = bundle({ items: [configItem("gateway.trigger", "!hades"), modelItem("claude-sonnet-5")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options({ exclude: ["model"] }) });
    expect(byKey(plan.actions, "config:gateway.trigger").action).toBe("import");
    const modelAction = byKey(plan.actions, "model:selection");
    expect(modelAction.action).toBe("skip");
    expect(modelAction.reason).toMatch(/excluded/);
  });

  it("`only` restricts processing to the given kinds", () => {
    const b = bundle({ items: [configItem("gateway.trigger", "!hades"), modelItem("claude-sonnet-5")] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options({ only: ["config"] }) });
    expect(byKey(plan.actions, "config:gateway.trigger").action).toBe("import");
    expect(byKey(plan.actions, "model:selection").action).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// maxItems
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- item-limit-exceeded", () => {
  it("quarantines items beyond maxItems and raises the blocker", () => {
    const items = [configItem("locale", "fr"), configItem("plugins", ["a"]), modelItem("claude-sonnet-5")];
    const b = bundle({ items });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options({ maxItems: 1 }) });
    expect(plan.actions).toHaveLength(3);
    expect(plan.blockers.some((bl) => bl.code === "item-limit-exceeded")).toBe(true);
    const quarantined = plan.actions.filter((a) => a.action === "quarantine");
    expect(quarantined).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// target-not-writable
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- target-not-writable", () => {
  it("quarantines writes to a non-writable kind and raises the blocker", () => {
    const b = bundle({ items: [configItem("gateway.trigger", "!hades")] });
    const t = target({ writable: { config: false } });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options() });
    const a = byKey(plan.actions, "config:gateway.trigger");
    expect(a.action).toBe("quarantine");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "target-not-writable" }));
  });

  it("does not quarantine a skip/abstain action just because the kind is unwritable", () => {
    const item = configItem("locale", "en"); // equals incumbent -> natural "skip", not a write
    const t = target({ config: { ...DEFAULT_CONFIG, locale: "en" }, writable: { config: false } });
    const plan = buildMigrationPlan({ bundles: [bundle({ items: [item] })], secrets: [], target: t, options: options() });
    expect(byKey(plan.actions, "config:locale").action).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// source-is-target
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- source-is-target", () => {
  it("refuses outright when a bundle's root is the live Hades dataDir", () => {
    const b = bundle({ root: "/home/u/.hades", items: [configItem("locale", "fr", "/home/u/.hades/config.json")] });
    const t = target({ dataDir: "/home/u/.hades" });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options() });
    const a = byKey(plan.actions, "config:locale");
    expect(a.action).toBe("abstain");
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "source-is-target" }));
  });

  it("tolerates a trailing-slash mismatch between root and dataDir", () => {
    const b = bundle({ root: "/home/u/.hades/", items: [configItem("locale", "fr")] });
    const t = target({ dataDir: "/home/u/.hades" });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options() });
    expect(byKey(plan.actions, "config:locale").action).toBe("abstain");
  });
});

// ---------------------------------------------------------------------------
// no-sources / source-unreadable
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- no-sources / source-unreadable", () => {
  it("raises no-sources for a totally empty call", () => {
    const plan = buildMigrationPlan({ bundles: [], secrets: [], target: target(), options: options() });
    expect(plan.blockers).toEqual([{ code: "no-sources", message: expect.any(String) }]);
    expect(plan.actions).toEqual([]);
  });

  it("raises source-unreadable when a bundle reports read errors", () => {
    const b = bundle({ readErrors: [{ path: "/home/u/.hermes/sessions/broken.jsonl", reason: "permission denied" }] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: target(), options: options() });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "source-unreadable" }));
  });
});

// ---------------------------------------------------------------------------
// Global invariant: blockers forbid destructive actions
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- blockers forbid destructive actions plan-wide", () => {
  it("downgrades an unrelated destructive action to quarantine when any blocker exists", () => {
    const sessionOverwrite = sessionItem("abc", 500);
    const unknownModel = modelItem("nonexistent-model");
    const b = bundle({ items: [sessionOverwrite, unknownModel] });
    const t = target({ sessions: [{ id: "abc", startedAt: 1000 }] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "overwrite" }) });

    expect(plan.blockers.some((bl) => bl.code === "model-unknown")).toBe(true);
    const sessionAction = byKey(plan.actions, "session:abc");
    expect(sessionAction.action).toBe("quarantine");
    expect(sessionAction.risk).not.toBe("destructive");
    expect(plan.actions.every((a) => a.risk !== "destructive")).toBe(true);
    expect(plan.summary.destructive).toBe(0);
  });

  it("allows a destructive action through when the plan has zero blockers", () => {
    const b = bundle({ items: [sessionItem("abc", 500)] });
    const t = target({ sessions: [{ id: "abc", startedAt: 1000 }] });
    const plan = buildMigrationPlan({ bundles: [b], secrets: [], target: t, options: options({ conflict: "overwrite" }) });
    expect(plan.blockers).toEqual([]);
    expect(byKey(plan.actions, "session:abc").action).toBe("overwrite");
    expect(plan.summary.destructive).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Order independence
// ---------------------------------------------------------------------------

describe("buildMigrationPlan -- order independence", () => {
  it("shuffling the bundles array and each bundle's items yields the same planHash", () => {
    const items1 = [configItem("locale", "fr"), modelItem("claude-sonnet-5"), sessionItem("s1", 100), skillItem("a", "x")];
    const items2 = [contextFileItem("USER.md", "hi"), secretItemInBundle("K1"), toolStateItem("t1", { a: 1 })];
    const b1 = bundle({ items: items1, root: "/home/u/.hermes" });
    const b2 = bundle({ vendor: "openclaw", layout: "openclaw-dotfile", root: "/home/u/.openclaw", items: items2 });

    const planA = buildMigrationPlan({ bundles: [b1, b2], secrets: [], target: target(), options: options() });
    const planB = buildMigrationPlan({
      bundles: [
        { ...b2, items: [...items2].reverse() },
        { ...b1, items: [...items1].reverse() },
      ],
      secrets: [],
      target: target(),
      options: options(),
    });

    expect(planB.planHash).toBe(planA.planHash);
    expect(planB.actions.map((a) => a.itemKey).sort()).toEqual(planA.actions.map((a) => a.itemKey).sort());
  });
});

// ---------------------------------------------------------------------------
// Property-style invariant across all five policies, seeded pseudo-random bundles
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERATOR_KINDS: ArtifactKind[] = ["config", "model", "memory", "context-file", "session", "skill", "secret", "tool-state", "unknown"];

function generateBundle(rand: () => number, seed: number, targetProbe: TargetProbe): MigrationBundle {
  const n = 1 + Math.floor(rand() * 8);
  const items: MigrationItem[] = [];
  const unimportable: Array<{ path: string; kind: ArtifactKind; reason: string }> = [];
  for (let i = 0; i < n; i++) {
    const kind = GENERATOR_KINDS[Math.floor(rand() * GENERATOR_KINDS.length)];
    const idx = Math.floor(rand() * 4); // small alphabet so collisions actually happen
    switch (kind) {
      case "config":
        items.push(configItem(["locale", "plugins", "gateway.trigger"][idx % 3], `v${idx}-${seed}`));
        break;
      case "model":
        items.push(modelItem(idx % 2 === 0 ? "claude-sonnet-5" : `unknown-model-${idx}`));
        break;
      case "memory":
        items.push(makeMemoryItem(`fact number ${idx} variant ${seed}`, { createdAt: 1000 + idx, originPath: "/x", confidence: 1 }));
        break;
      case "context-file":
        items.push(contextFileItem(`file${idx}.md`, `content ${idx}-${seed}`));
        break;
      case "session":
        items.push(sessionItem(`sess${idx}`, 1000 + idx + seed));
        break;
      case "skill":
        items.push(skillItem(`skill${idx}`, `body ${idx}-${seed}`));
        break;
      case "secret":
        items.push(secretItemInBundle(`ENV_VAR_${idx}`));
        break;
      case "tool-state":
        items.push(toolStateItem(`tool${idx}`, { seed, idx }));
        break;
      case "unknown":
        if (rand() < 0.5) {
          unimportable.push({ path: `/x/unknown${idx}-${seed}`, kind: "unknown", reason: "simulated unreadable artifact" });
        } else {
          items.push(makeItem({ kind: "unknown", key: `unknown:blob${idx}-${seed}`, value: { idx }, origin: { path: "/x" }, confidence: 0.5 }));
        }
        break;
    }
  }
  return {
    vendor: rand() < 0.5 ? "hermes" : "openclaw",
    layout: "generated",
    root: `/home/u/.gen-${seed}`,
    items,
    unimportable,
    readErrors: [],
    stats: emptyStats(),
  };
}

describe("buildMigrationPlan -- total, lossless accounting (property-style)", () => {
  const policies: ConflictPolicy[] = ["skip", "overwrite", "rename", "newest", "ask"];

  for (const policy of policies) {
    it(`every item across generated bundles resolves to exactly one action or unimportable entry (policy=${policy})`, () => {
      for (let seed = 0; seed < 12; seed++) {
        const rand = mulberry32(seed * 977 + policies.indexOf(policy) * 31 + 1);
        const t = target();
        const bundleCount = 1 + Math.floor(rand() * 3);
        const bundles: MigrationBundle[] = [];
        for (let bi = 0; bi < bundleCount; bi++) bundles.push(generateBundle(rand, seed * 10 + bi, t));

        const plan = buildMigrationPlan({ bundles, secrets: [], target: t, options: options({ conflict: policy, now: 1 }) });

        const totalItems = bundles.reduce((s, b) => s + b.items.length + b.unimportable.length, 0);
        expect(plan.actions.length + plan.unimportable.length).toBe(totalItems);

        const keys = plan.actions.map((a) => a.itemKey);
        expect(new Set(keys).size).toBe(keys.length);

        // blockers gate correctly: no destructive action survives alongside a blocker.
        if (plan.blockers.length > 0) {
          expect(plan.actions.every((a) => a.risk !== "destructive")).toBe(true);
        }

        // summary counts are recomputable from actions.
        const recomputedByAction: Record<string, number> = {};
        for (const a of plan.actions) recomputedByAction[a.action] = (recomputedByAction[a.action] ?? 0) + 1;
        for (const [k, v] of Object.entries(plan.summary.byAction)) {
          expect(recomputedByAction[k] ?? 0).toBe(v);
        }

        // order independence for this exact generated input too.
        const shuffledBundles = [...bundles].reverse().map((b) => ({ ...b, items: [...b.items].reverse() }));
        const plan2 = buildMigrationPlan({ bundles: shuffledBundles, secrets: [], target: t, options: options({ conflict: policy, now: 1 }) });
        expect(plan2.planHash).toBe(plan.planHash);
      }
    });
  }
});
