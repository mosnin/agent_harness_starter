/**
 * Tests for `src/hades/migrate/openclaw-source.ts` against REAL on-disk
 * fixture trees (current openclaw.json layout, and the legacy clawdbot /
 * moltbot roots) written by `fixtures.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeFsProbe, type DiscoveredSource } from "../discovery";
import { validateBundle, type ArtifactKind } from "../ir";
import { openSqlite } from "../sqlite-read";
import type { SourceReadDeps } from "../hermes-source";
import {
  OPENCLAW_ARTIFACTS,
  OPENCLAW_LEGACY_KEY_RENAME_MAP,
  parseJsonc,
  readOpenClawSource,
  stripJsonComments,
  stripTrailingCommas,
} from "../openclaw-source";
import { ruleMatches } from "../hermes-source";
import {
  materializeLegacyClawdbotFixture,
  materializeLegacyMoltbotFixture,
  materializeOpenClawFixture,
  type FixtureManifest,
} from "../fixtures";

const FIXED_NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function makeSource(root: string, overrides: Partial<DiscoveredSource> = {}): DiscoveredSource {
  return {
    vendor: "openclaw",
    root,
    layout: "openclaw-dotfile",
    confidence: 1,
    evidence: [],
    inventory: [],
    warnings: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SourceReadDeps> = {}): SourceReadDeps {
  return { probe: nodeFsProbe(), openSqlite, now: () => FIXED_NOW, ...overrides };
}

function zeroKinds(): Record<ArtifactKind, number> {
  return { config: 0, model: 0, memory: 0, "context-file": 0, session: 0, skill: 0, secret: 0, "tool-state": 0, unknown: 0 };
}

function countByKind(items: { kind: ArtifactKind }[]): Record<ArtifactKind, number> {
  const out = zeroKinds();
  for (const it of items) out[it.kind] += 1;
  return out;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openclaw-source-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Current openclaw.json layout
// ---------------------------------------------------------------------------

describe("readOpenClawSource against the current openclaw.json layout", () => {
  it("default fixture: item/unimportable/secret counts match the fixture's own inline-computed expectations", async () => {
    const manifest = materializeOpenClawFixture(workDir, { variant: "home", seed: 7 });
    const source = makeSource(workDir);
    const { bundle, secrets } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.unimportable.length).toBe(manifest.expected.unimportable);
    expect(secrets.entries.length).toBe(manifest.expected.secrets);
    expect(bundle.vendor).toBe("openclaw");

    const validation = validateBundle(bundle);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("parses tolerant JSONC (// comments, block comments, trailing commas) correctly", async () => {
    materializeOpenClawFixture(workDir, { variant: "home", seed: 3 });
    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());

    const locale = bundle.items.find((i) => i.key === "config:locale");
    expect(locale?.value).toBe("en-GB");
    const trigger = bundle.items.find((i) => i.key === "config:gateway.trigger");
    expect(trigger?.value).toBe("!openclaw");
    const allowedUsers = bundle.items.find((i) => i.key === "config:gateway.allowedUsers");
    expect(allowedUsers?.value).toEqual(["carol", "dave"]);
  });

  it("the active agent's model becomes model:selection; the inactive agent only contributes tool-state", async () => {
    materializeOpenClawFixture(workDir, { variant: "home", seed: 4 });
    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());

    const model = bundle.items.find((i) => i.kind === "model");
    expect(model).toBeDefined();
    expect((model!.value as { modelId: string }).modelId).toBe("openclaw-large-v1");

    const toolStates = bundle.items.filter((i) => i.kind === "tool-state");
    expect(toolStates.length).toBe(2);
    const agentA = toolStates.find((t) => t.key === "tool-state:agent:agent-a");
    const agentB = toolStates.find((t) => t.key === "tool-state:agent:agent-b");
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
  });

  it("withSecrets: config-embedded and .env secrets are vaulted and redacted out of the bundle", async () => {
    const manifest = materializeOpenClawFixture(workDir, { variant: "home", seed: 8, withSecrets: true });
    const source = makeSource(workDir);
    const { bundle, secrets } = await readOpenClawSource(source, makeDeps());

    expect(secrets.entries.length).toBe(manifest.expected.secrets);
    const serialized = JSON.stringify(bundle);
    for (const entry of secrets.entries) {
      expect(serialized.includes(entry.value)).toBe(false);
    }
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("truncated-json: openclaw.json becomes unimportable, contributes zero config items", async () => {
    const manifest = materializeOpenClawFixture(workDir, { variant: "home", seed: 9, corrupt: ["truncated-json"] });
    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.items.filter((i) => i.kind === "config").length).toBe(0);
    const unimportable = bundle.unimportable.find((u) => u.path === "openclaw.json");
    expect(unimportable?.kind).toBe("config");
  });

  it("oversized-file: memory/notes.md is byte-capped and stats.truncated is set", async () => {
    const manifest = materializeOpenClawFixture(workDir, { variant: "home", seed: 10, corrupt: ["oversized-file"] });
    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.stats.truncated).toBe(true);
  });

  it("traversal-skill-name and unterminated-frontmatter degrade honestly", async () => {
    const manifest = materializeOpenClawFixture(workDir, {
      variant: "home",
      seed: 11,
      corrupt: ["traversal-skill-name", "unterminated-frontmatter"],
    });
    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const evilSkill = bundle.items.find((i) => i.origin.path === "skills/oc-evil/SKILL.md");
    expect(evilSkill?.key).not.toMatch(/\.\./);
    const broken = bundle.unimportable.find((u) => u.path === "skills/oc-broken/SKILL.md");
    expect(broken?.kind).toBe("skill");
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("reverse parity: current-layout HERMES-equivalent rules match real fixture files", () => {
    const manifest = materializeOpenClawFixture(workDir, {
      variant: "home",
      withSecrets: true,
      corrupt: ["truncated-json", "unterminated-frontmatter", "traversal-skill-name", "symlink-escape"],
      seed: 55,
    });
    const currentLayoutRules = OPENCLAW_ARTIFACTS.filter(
      (r) => !r.relPathGlob.startsWith("clawdbot") && !r.relPathGlob.startsWith("moltbot") && !r.relPathGlob.startsWith("history/") && !r.relPathGlob.startsWith("logs/") && !r.relPathGlob.startsWith("plugins/") && !r.relPathGlob.startsWith("addons/") && r.relPathGlob !== "memory.json" && r.relPathGlob !== "state.json",
    );
    for (const rule of currentLayoutRules) {
      const matched = manifest.files.some((f) => ruleMatches(rule, f.relPath));
      expect(matched, `OPENCLAW_ARTIFACTS rule "${rule.relPathGlob}" matched no fixture file`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy clawdbot / moltbot layouts
// ---------------------------------------------------------------------------

describe("readOpenClawSource against the legacy ~/.clawdbot layout", () => {
  it("legacy field names are mapped via OPENCLAW_LEGACY_KEY_RENAME_MAP with lower confidence and a note", async () => {
    const manifest = materializeLegacyClawdbotFixture(workDir, { variant: "home", seed: 12 });
    const source = makeSource(workDir, { layout: "openclaw-legacy-clawdbot" });
    const { bundle } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const model = bundle.items.find((i) => i.key === "config:model");
    expect(model?.value).toBe("clawdbot-legacy-v1");
    expect(model?.confidence).toBeLessThan(1);
    expect(model?.notes?.[0]).toMatch(/OPENCLAW_LEGACY_KEY_RENAME_MAP/);

    const locale = bundle.items.find((i) => i.key === "config:locale");
    expect(locale?.value).toBe("en");
    const trigger = bundle.items.find((i) => i.key === "config:gateway.trigger");
    expect(trigger?.value).toBe("!clawdbot");
    const allowedUsers = bundle.items.find((i) => i.key === "config:gateway.allowedUsers");
    expect(allowedUsers?.value).toEqual(["erin"]);
    const plugins = bundle.items.find((i) => i.key === "config:plugins");
    expect(plugins?.value).toEqual(["shell"]);

    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("history/*.jsonl and history/*.json (legacy session dirs) both import", async () => {
    materializeLegacyClawdbotFixture(workDir, { variant: "home", seed: 13 });
    const source = makeSource(workDir, { layout: "openclaw-legacy-clawdbot" });
    const { bundle } = await readOpenClawSource(source, makeDeps());

    const sessions = bundle.items.filter((i) => i.kind === "session");
    expect(sessions.length).toBe(2);
    expect(sessions.some((s) => s.origin.path === "history/h0.jsonl")).toBe(true);
    expect(sessions.some((s) => s.origin.path === "history/h1.json")).toBe(true);
  });

  it("plugins/*/SKILL.md (legacy skill-equivalent dir) imports through the same SKILL.md parser", async () => {
    materializeLegacyClawdbotFixture(workDir, { variant: "home", seed: 14 });
    const source = makeSource(workDir, { layout: "openclaw-legacy-clawdbot" });
    const { bundle } = await readOpenClawSource(source, makeDeps());

    const skill = bundle.items.find((i) => i.kind === "skill" && i.origin.path === "plugins/legacy-plugin-skill/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill!.key).toBe("skill:legacy-plugin-skill");
  });

  it("truncated-json on memory.json: zero memory items, one unimportable(memory)", async () => {
    const manifest = materializeLegacyClawdbotFixture(workDir, { variant: "home", seed: 15, corrupt: ["truncated-json"] });
    const source = makeSource(workDir, { layout: "openclaw-legacy-clawdbot" });
    const { bundle } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.items.filter((i) => i.kind === "memory").length).toBe(0);
    expect(bundle.unimportable.some((u) => u.path === "memory.json" && u.kind === "memory")).toBe(true);
  });
});

describe("readOpenClawSource against the legacy ~/.moltbot layout", () => {
  it("moltbot field names map correctly and state.json becomes a redacted tool-state item", async () => {
    const manifest = materializeLegacyMoltbotFixture(workDir, { variant: "home", seed: 16, withSecrets: true });
    const source = makeSource(workDir, { layout: "openclaw-legacy-moltbot" });
    const { bundle, secrets } = await readOpenClawSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const model = bundle.items.find((i) => i.key === "config:model");
    expect(model?.value).toBe("moltbot-legacy-v1");

    const state = bundle.items.find((i) => i.key === "tool-state:legacy-state");
    expect(state).toBeDefined();
    const stateValue = state!.value as Record<string, unknown>;
    expect(stateValue.cachedApiKey).toBeUndefined(); // redacted out, moved to the vault
    expect(stateValue.toolCallCount).toBe(42);

    expect(secrets.entries.some((e) => e.origin.locator === "cachedApiKey")).toBe(true);
    expect(secrets.entries.some((e) => e.origin.locator === "secretToken")).toBe(true);

    const serialized = JSON.stringify(bundle);
    for (const entry of secrets.entries) expect(serialized.includes(entry.value)).toBe(false);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("logs/*.jsonl and logs/*.json (legacy session dirs) both import; addons/*/SKILL.md imports", async () => {
    materializeLegacyMoltbotFixture(workDir, { variant: "home", seed: 17 });
    const source = makeSource(workDir, { layout: "openclaw-legacy-moltbot" });
    const { bundle } = await readOpenClawSource(source, makeDeps());

    const sessions = bundle.items.filter((i) => i.kind === "session");
    expect(sessions.length).toBe(2);
    expect(sessions.some((s) => s.origin.path === "logs/l0.jsonl")).toBe(true);
    expect(sessions.some((s) => s.origin.path === "logs/l1.json")).toBe(true);

    const skill = bundle.items.find((i) => i.kind === "skill" && i.origin.path === "addons/legacy-addon-skill/SKILL.md");
    expect(skill).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Full-table reverse parity across all three fixtures combined
// ---------------------------------------------------------------------------

describe("OPENCLAW_ARTIFACTS reverse parity across all fixture generators", () => {
  it("every declared rule is exercised by at least one of the three (+bonus moltbot) fixtures", () => {
    const currentDir = mkdtempSync(join(tmpdir(), "oc-parity-current-"));
    const clawdbotDir = mkdtempSync(join(tmpdir(), "oc-parity-clawdbot-"));
    const moltbotDir = mkdtempSync(join(tmpdir(), "oc-parity-moltbot-"));
    try {
      const manifests: FixtureManifest[] = [
        materializeOpenClawFixture(currentDir, { variant: "home", withSecrets: true, seed: 1 }),
        materializeLegacyClawdbotFixture(clawdbotDir, { variant: "home", withSecrets: true, seed: 2 }),
        materializeLegacyMoltbotFixture(moltbotDir, { variant: "home", withSecrets: true, seed: 3 }),
      ];
      const allFiles = manifests.flatMap((m) => m.files);
      for (const rule of OPENCLAW_ARTIFACTS) {
        const matched = allFiles.some((f) => ruleMatches(rule, f.relPath));
        expect(matched, `OPENCLAW_ARTIFACTS rule "${rule.relPathGlob}" matched no fixture file across all generators`).toBe(true);
      }
    } finally {
      rmSync(currentDir, { recursive: true, force: true });
      rmSync(clawdbotDir, { recursive: true, force: true });
      rmSync(moltbotDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: tolerant JSONC + the legacy rename map + edge cases
// ---------------------------------------------------------------------------

describe("stripJsonComments / stripTrailingCommas / parseJsonc", () => {
  it("strips // and block comments without touching string content", () => {
    const input = '{\n  // comment\n  "a": "value // not a comment", /* another */\n  "b": 1\n}';
    const stripped = stripJsonComments(input);
    expect(stripped).toContain('"value // not a comment"');
    expect(stripped).not.toContain("// comment");
    expect(stripped).not.toContain("/* another */");
  });

  it("strips trailing commas before ] and } but not commas inside strings", () => {
    const input = '{"a": [1, 2, 3,], "b": "x,}", "c": 2,}';
    const stripped = stripTrailingCommas(input);
    expect(() => JSON.parse(stripped)).not.toThrow();
    const parsed = JSON.parse(stripped) as { a: number[]; b: string; c: number };
    expect(parsed.a).toEqual([1, 2, 3]);
    expect(parsed.b).toBe("x,}");
    expect(parsed.c).toBe(2);
  });

  it("parseJsonc handles comments plus trailing commas together", () => {
    const input = '{\n  // leading comment\n  "model": "x", // trailing\n  "list": [1, 2,],\n}';
    expect(parseJsonc(input)).toEqual({ model: "x", list: [1, 2] });
  });

  it("throws the underlying JSON.parse error for genuinely malformed input", () => {
    expect(() => parseJsonc("{ this is not json")).toThrow();
  });
});

describe("OPENCLAW_LEGACY_KEY_RENAME_MAP", () => {
  it("is declared as data covering both clawdbot- and moltbot-era field names", () => {
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.defaultModel).toBe("model");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.botModel).toBe("model");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.language).toBe("locale");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.lang).toBe("locale");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.triggerWord).toBe("gateway.trigger");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.wakeWord).toBe("gateway.trigger");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.authorizedUsers).toBe("gateway.allowedUsers");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.allowedUsers).toBe("gateway.allowedUsers");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.extensions).toBe("plugins");
    expect(OPENCLAW_LEGACY_KEY_RENAME_MAP.addons).toBe("plugins");
  });
});

describe("readOpenClawSource edge cases", () => {
  it("an empty tree produces an empty-but-valid bundle, no exceptions", async () => {
    const source = makeSource(workDir);
    const { bundle, secrets } = await readOpenClawSource(source, makeDeps());
    expect(bundle.items).toEqual([]);
    expect(bundle.unimportable).toEqual([]);
    expect(secrets.entries).toEqual([]);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("a tree with only a .env file produces only secret items", async () => {
    writeFileSync(join(workDir, ".env"), "OPENAI_API_KEY=sk-onlysecrettree0987654321fedcba\n");
    const source = makeSource(workDir);
    const { bundle, secrets } = await readOpenClawSource(source, makeDeps());
    expect(bundle.items.length).toBe(1);
    expect(bundle.items[0].kind).toBe("secret");
    expect(secrets.entries.length).toBe(1);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("a malformed sessions/*.json (not an array or {messages}) is unimportable, never throws", async () => {
    writeFileSync(join(workDir, "openclaw.json"), JSON.stringify({ locale: "en" }));
    const sessionsDir = join(workDir, "sessions");
    writeFileSync(join(workDir, "sessions.marker"), ""); // ensure workDir has content; sessions dir created below
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "weird.json"), JSON.stringify({ notMessages: true }));

    const source = makeSource(workDir);
    const { bundle } = await readOpenClawSource(source, makeDeps());
    expect(bundle.items.some((i) => i.kind === "session")).toBe(false);
    expect(bundle.unimportable.some((u) => u.path === "sessions/weird.json" && u.reason.includes("messages"))).toBe(true);
  });

  it("item cap (maxItems) stops processing early and records a readError", async () => {
    materializeOpenClawFixture(workDir, { variant: "home", seed: 1, memories: 20, sessions: 2, skills: 3 });
    const source = makeSource(workDir);
    const uncapped = await readOpenClawSource(source, makeDeps());
    const totalUncapped = uncapped.bundle.items.length;
    expect(totalUncapped).toBeGreaterThan(3);

    const { bundle } = await readOpenClawSource(source, makeDeps({ maxItems: 3 }));
    expect(bundle.items.length).toBeLessThan(totalUncapped);
    expect(bundle.readErrors.some((e) => e.reason.includes("item cap"))).toBe(true);
  });
});
