/**
 * Tests for `src/hades/migrate/hermes-source.ts` against REAL on-disk
 * fixture trees written by `fixtures.ts` (via `node:fs`, exercised through
 * the real `nodeFsProbe` and the real `openSqlite`) -- not a mock filesystem.
 * The one exception is a single "unreadable directory" case, where a thin
 * `FsProbe` wrapper simulates EACCES, since running as root in CI defeats
 * real `chmod`-based permission tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeFsProbe, type DiscoveredSource, type FsProbe } from "../discovery";
import { validateBundle, type ArtifactKind } from "../ir";
import { openSqlite } from "../sqlite-read";
import {
  HERMES_ARTIFACTS,
  classifySqliteTables,
  parseDotenv,
  parseTimestampFlexible,
  readHermesSource,
  readSessionJsonl,
  readSkillFile,
  ruleMatches,
  sanitizeEnvVarName,
  type SourceReadDeps,
} from "../hermes-source";
import { materializeHermesFixture, type FixtureManifest } from "../fixtures";

const FIXED_NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function makeSource(root: string, overrides: Partial<DiscoveredSource> = {}): DiscoveredSource {
  return {
    vendor: "hermes",
    root,
    layout: "hermes-dotfile",
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
  workDir = mkdtempSync(join(tmpdir(), "hermes-source-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// End-to-end against real fixtures
// ---------------------------------------------------------------------------

describe("readHermesSource against real fixtures", () => {
  it("default fixture: item/unimportable/secret counts match the fixture's own inline-computed expectations", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 7 });
    const source = makeSource(workDir);
    const { bundle, secrets } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.unimportable.length).toBe(manifest.expected.unimportable);
    expect(secrets.entries.length).toBe(manifest.expected.secrets);
    expect(bundle.vendor).toBe("hermes");
    expect(bundle.stats.filesScanned).toBeGreaterThan(0);
    expect(bundle.stats.truncated).toBe(false);

    const validation = validateBundle(bundle);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("withSecrets: config-embedded and .env secrets are vaulted and redacted out of the bundle entirely", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 3, withSecrets: true });
    const source = makeSource(workDir);
    const { bundle, secrets } = await readHermesSource(source, makeDeps());

    expect(secrets.vendor).toBe("hermes");
    expect(secrets.entries.length).toBe(manifest.expected.secrets);
    expect(secrets.entries.length).toBe(3); // backupApiKey (config) + 2 .env lines
    for (const entry of secrets.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
      expect(entry.envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }

    // No serialized bundle item anywhere contains a real secret value or anything key-material-shaped.
    const serializedBundle = JSON.stringify(bundle);
    for (const entry of secrets.entries) {
      expect(serializedBundle.includes(entry.value)).toBe(false);
    }
    expect(serializedBundle).not.toMatch(/sk-[A-Za-z0-9]{16,}/);

    const validation = validateBundle(bundle);
    expect(validation.ok).toBe(true);
  });

  it("withSqlite: real hermes.db contributes memory + session items via column-name heuristics (or is honestly absent)", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 11, withSqlite: true });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);

    if (manifest.sqlite.present) {
      const sqliteMemory = bundle.items.filter((i) => i.kind === "memory" && i.origin.path === "hermes.db");
      expect(sqliteMemory.length).toBe(2);
      for (const m of sqliteMemory) {
        expect((m.value as { fact: string }).fact.length).toBeGreaterThan(0);
        expect(m.confidence).toBeCloseTo(0.7);
        expect(m.notes?.some((n) => n.includes("SQLite table"))).toBe(true);
      }
      const sqliteSession = bundle.items.find((i) => i.kind === "session" && i.origin.path === "hermes.db");
      expect(sqliteSession).toBeDefined();
      const sessionValue = sqliteSession!.value as { id: string; messages: unknown[]; title?: string };
      expect(sessionValue.id).toBe("sqlite-session-0");
      expect(sessionValue.messages.length).toBe(2);
      expect(sessionValue.title).toBe("SQLite fixture session");
    } else {
      // Environment lacks node:sqlite -- honestly absent, never a fake file passed off as a database.
      expect(bundle.items.some((i) => i.origin.path === "hermes.db")).toBe(false);
    }

    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("truncated-json: config.json becomes unimportable, contributes zero config items", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 2, corrupt: ["truncated-json"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.items.filter((i) => i.kind === "config").length).toBe(0);
    const configUnimportable = bundle.unimportable.find((u) => u.path === "config.json");
    expect(configUnimportable).toBeDefined();
    expect(configUnimportable!.kind).toBe("config");
    expect(configUnimportable!.reason).toMatch(/not valid JSON/);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("bad-utf8: invalid byte sequences never throw and decode to U+FFFD in the captured context-file content", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 5, corrupt: ["bad-utf8"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const userMd = bundle.items.find((i) => i.kind === "context-file" && i.key === "context:memory/USER.md");
    expect(userMd).toBeDefined();
    const content = (userMd!.value as { content: string }).content;
    expect(content).toContain("�");
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("unterminated-frontmatter: a broken SKILL.md becomes unimportable, never throws", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 4, corrupt: ["unterminated-frontmatter"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const brokenSkill = bundle.unimportable.find((u) => u.path === "skills/broken/SKILL.md");
    expect(brokenSkill).toBeDefined();
    expect(brokenSkill!.kind).toBe("skill");
    expect(brokenSkill!.reason).toMatch(/frontmatter/i);
  });

  it("traversal-skill-name: a skill whose name contains '../' is sanitized, never a path-traversal key", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 6, corrupt: ["traversal-skill-name"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const evilSkill = bundle.items.find((i) => i.kind === "skill" && i.origin.path === "skills/evil/SKILL.md");
    expect(evilSkill).toBeDefined();
    expect(evilSkill!.key).not.toMatch(/\.\./);
    expect(evilSkill!.key).toMatch(/^skill:[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    expect(evilSkill!.confidence).toBeLessThan(1);
    expect(evilSkill!.notes?.some((n) => n.includes("sanitized"))).toBe(true);
    // The raw manifest name is still preserved verbatim as inert data (never interpreted as a path).
    expect((evilSkill!.value as { name: string }).name).toBe("../../etc/evil-fixture");
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("oversized-file: a multi-MB MEMORY.md is byte-capped, stats.truncated is set, and no Facts bullet is fabricated from a chopped file", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 8, corrupt: ["oversized-file"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    expect(bundle.stats.truncated).toBe(true);
    const memoryMdItems = bundle.items.filter((i) => i.kind === "memory" && i.origin.path === "memory/MEMORY.md");
    expect(memoryMdItems.length).toBe(0);
    const contextItem = bundle.items.find((i) => i.kind === "context-file" && i.key === "context:memory/MEMORY.md");
    expect(contextItem).toBeDefined();
    expect(contextItem!.notes?.some((n) => n.includes("truncated"))).toBe(true);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("symlink-escape: a symlink leaving the source root is never followed, and is recorded as a warning", async () => {
    materializeHermesFixture(workDir, { variant: "home", seed: 9, corrupt: ["symlink-escape"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    const escapeWarning = bundle.readErrors.find((e) => e.reason.includes("escapes the source root"));
    expect(escapeWarning).toBeDefined();
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("sqlite-garbage: a non-database hermes.db is classified as unimportable, never crashes the reader", async () => {
    const manifest = materializeHermesFixture(workDir, { variant: "home", seed: 10, corrupt: ["sqlite-garbage"] });
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());

    expect(manifest.sqlite.present).toBe(false);
    expect(countByKind(bundle.items)).toEqual(manifest.expected.items);
    const dbUnimportable = bundle.unimportable.find((u) => u.path === "hermes.db");
    expect(dbUnimportable).toBeDefined();
    expect(dbUnimportable!.kind).toBe("unknown");
  });

  it("windows-appdata variant writes CRLF line endings", () => {
    materializeHermesFixture(workDir, { variant: "windows-appdata", seed: 1 });
    const raw = readFileSync(join(workDir, "memory", "USER.md"), "utf8");
    expect(raw.includes("\r\n")).toBe(true);
    expect(raw.includes("\n")).toBe(true); // sanity: file is not empty/single-line
  });

  it("is deterministic given a seed: two independent materializations produce byte-identical file sets", () => {
    const dirA = mkdtempSync(join(tmpdir(), "hermes-det-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "hermes-det-b-"));
    try {
      const a = materializeHermesFixture(dirA, { variant: "home", seed: 42, withSecrets: true, memories: 2, sessions: 1, skills: 1 });
      const b = materializeHermesFixture(dirB, { variant: "home", seed: 42, withSecrets: true, memories: 2, sessions: 1, skills: 1 });
      const normalize = (m: FixtureManifest) => m.files.map((f) => `${f.relPath}:${f.sha256}:${f.bytes}`).sort();
      expect(normalize(a)).toEqual(normalize(b));
      expect(a.expected).toEqual(b.expected);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("reverse parity: every HERMES_ARTIFACTS rule matches a real fixture file, and every fixture file matches a rule", () => {
    const manifest = materializeHermesFixture(workDir, {
      variant: "home",
      withSecrets: true,
      withSqlite: true,
      corrupt: ["truncated-json", "bad-utf8", "unterminated-frontmatter", "traversal-skill-name", "symlink-escape"],
      seed: 99,
    });
    // "settings.json" (Hermes' alternate config filename) and "sessions.db" / "memory.db" (alternate
    // SQLite filenames) are mutually-exclusive-with-config.json/hermes.db in a real install, so the
    // fixture generator never writes all of them at once. Add them as synthetic path-only entries
    // purely to exercise these rules' glob matches; settings.json's actual parsing is covered by the
    // dedicated test below, and the SQLite table-classification logic is identical regardless of filename.
    const files = [
      ...manifest.files,
      { relPath: "settings.json", sha256: "", bytes: 0 },
      { relPath: "sessions.db", sha256: "", bytes: 0 },
      { relPath: "memory.db", sha256: "", bytes: 0 },
    ];
    for (const rule of HERMES_ARTIFACTS) {
      const matched = files.some((f) => ruleMatches(rule, f.relPath));
      expect(matched, `HERMES_ARTIFACTS rule "${rule.relPathGlob}" matched no fixture file`).toBe(true);
    }
    for (const f of manifest.files) {
      const matched = HERMES_ARTIFACTS.some((rule) => ruleMatches(rule, f.relPath));
      expect(matched, `fixture file "${f.relPath}" matched no HERMES_ARTIFACTS rule`).toBe(true);
    }
  });

  it("settings.json (Hermes' alternate config filename) is parsed identically to config.json", async () => {
    writeFileSync(
      join(workDir, "settings.json"),
      JSON.stringify({ model: "hermes-settings-variant", locale: "de", plugins: [], gateway: {} }),
    );
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps());
    const model = bundle.items.find((i) => i.key === "config:model");
    expect(model?.value).toBe("hermes-settings-variant");
    expect(validateBundle(bundle).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases not driven by fixtures.ts
// ---------------------------------------------------------------------------

describe("readHermesSource edge cases", () => {
  it("an empty tree produces an empty-but-valid bundle, no exceptions", async () => {
    const source = makeSource(workDir);
    const { bundle, secrets } = await readHermesSource(source, makeDeps());
    expect(bundle.items).toEqual([]);
    expect(bundle.unimportable).toEqual([]);
    expect(secrets.entries).toEqual([]);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("a tree with only a .env file produces only secret items", async () => {
    writeFileSync(join(workDir, ".env"), "OPENAI_API_KEY=sk-onlysecrettree1234567890abcdef\n");
    const source = makeSource(workDir);
    const { bundle, secrets } = await readHermesSource(source, makeDeps());
    expect(bundle.items.length).toBe(1);
    expect(bundle.items[0].kind).toBe("secret");
    expect(secrets.entries.length).toBe(1);
    expect(validateBundle(bundle).ok).toBe(true);
  });

  it("a directory the probe cannot read degrades to a readError, never throws", async () => {
    writeFileSync(join(workDir, "config.json"), JSON.stringify({ model: "x", locale: "en", plugins: [], gateway: {} }));
    const skillsDir = join(workDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "placeholder"), "x");

    const real = nodeFsProbe();
    const throwingProbe: FsProbe = {
      ...real,
      readDir(p: string) {
        if (p === skillsDir) throw new Error("EACCES: permission denied (simulated)");
        return real.readDir(p);
      },
    };
    const source = makeSource(workDir);
    const { bundle } = await readHermesSource(source, makeDeps({ probe: throwingProbe }));
    expect(bundle.readErrors.some((e) => e.reason.includes("unreadable directory"))).toBe(true);
    // config.json is still read fine despite skills/ being unreadable.
    expect(bundle.items.some((i) => i.kind === "config")).toBe(true);
  });

  it("item cap (maxItems) stops processing early and records a readError rather than exceeding it silently", async () => {
    materializeHermesFixture(workDir, { variant: "home", seed: 1, memories: 20, sessions: 1, skills: 1 });
    const source = makeSource(workDir);
    const uncapped = await readHermesSource(source, makeDeps());
    const totalUncapped = uncapped.bundle.items.length;
    expect(totalUncapped).toBeGreaterThan(3); // sanity: the fixture is big enough for the cap to matter

    const { bundle } = await readHermesSource(source, makeDeps({ maxItems: 3 }));
    // The cap is checked between files, not mid-file, so it is a "stop soon after crossing the
    // threshold" bound rather than an exact truncation -- but it must meaningfully cut work short.
    expect(bundle.items.length).toBeLessThan(totalUncapped);
    expect(bundle.readErrors.some((e) => e.reason.includes("item cap"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for individual parsers/helpers
// ---------------------------------------------------------------------------

describe("parseTimestampFlexible", () => {
  const now = () => FIXED_NOW;

  it("disambiguates unix seconds vs milliseconds by range", () => {
    expect(parseTimestampFlexible(1700000000, now).ms).toBe(1700000000 * 1000);
    expect(parseTimestampFlexible(1700000000000, now).ms).toBe(1700000000000);
  });

  it("parses ISO date strings", () => {
    const r = parseTimestampFlexible("2024-01-01T00:00:00.000Z", now);
    expect(r.ms).toBe(Date.UTC(2024, 0, 1));
    expect(r.note).toBeUndefined();
  });

  it("substitutes now() and notes an unparseable timestamp rather than inventing one", () => {
    const r = parseTimestampFlexible("not-a-date-at-all", now);
    expect(r.ms).toBe(FIXED_NOW);
    expect(r.note).toMatch(/could not be parsed/);
  });

  it("substitutes now() for a missing/undefined timestamp with a clear note", () => {
    const r = parseTimestampFlexible(undefined, now);
    expect(r.ms).toBe(FIXED_NOW);
    expect(r.note).toMatch(/missing/);
  });

  it("substitutes now() for an out-of-range numeric timestamp", () => {
    const r = parseTimestampFlexible(-5, now);
    expect(r.ms).toBe(FIXED_NOW);
    expect(r.note).toMatch(/out of plausible range/);
  });
});

describe("parseDotenv", () => {
  it("parses quoted, unquoted, exported, and commented lines", () => {
    const lines = parseDotenv(
      [
        "# a comment",
        "export FOO=bar",
        'BAZ="quoted value"',
        "QUX='single quoted'",
        "EMPTY=",
        "NOTANASSIGNMENT",
        "SPACED = has-eq-with-spaces-in-key-name-should-still-parse",
      ].join("\n"),
    );
    const map = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(map.FOO).toBe("bar");
    expect(map.BAZ).toBe("quoted value");
    expect(map.QUX).toBe("single quoted");
    expect(map.EMPTY).toBe("");
    expect(map.NOTANASSIGNMENT).toBeUndefined();
  });
});

describe("sanitizeEnvVarName", () => {
  it("upper-cases, strips invalid characters, and guarantees a leading letter", () => {
    expect(sanitizeEnvVarName("openai-api-key")).toBe("OPENAI_API_KEY");
    expect(sanitizeEnvVarName("123abc")).toBe("S_123ABC");
    expect(sanitizeEnvVarName("")).toBe("SECRET");
  });
});

describe("readSkillFile", () => {
  it("parses a well-formed SKILL.md and computes a stable bodySha256", () => {
    const skillMd = ["---", "name: test-skill", "description: A test skill.", "capabilities: [routing]", "tools: []", "---", "# body", "", "content"].join(
      "\n",
    );
    const used = new Set<string>();
    const result = readSkillFile(skillMd, "skills/test-skill/SKILL.md", "skills/test-skill/SKILL.md", used);
    expect(result.item).toBeDefined();
    expect(result.item!.key).toBe("skill:test-skill");
    const value = result.item!.value as { bodySha256: string; instructions: string };
    expect(value.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an invalid manifest via validateSkillManifest without throwing", () => {
    const skillMd = ["---", "description: missing a name field", "---", "body"].join("\n");
    const used = new Set<string>();
    const result = readSkillFile(skillMd, "skills/bad/SKILL.md", "skills/bad/SKILL.md", used);
    expect(result.item).toBeUndefined();
    expect(result.unimportable).toBeDefined();
  });
});

describe("readSessionJsonl", () => {
  it("recovers valid messages around a bad line in the middle, reporting only that line as unimportable", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "hello", at: "2024-01-01T00:00:00.000Z" }),
      "{not valid json",
      JSON.stringify({ role: "assistant", content: "hi", at: "2024-01-02T00:00:00.000Z" }),
    ];
    const result = readSessionJsonl(lines.join("\n"), "sessions/s1.jsonl", "sessions/s1.jsonl", () => FIXED_NOW);
    expect(result.item).toBeDefined();
    const value = result.item!.value as { messages: unknown[] };
    expect(value.messages.length).toBe(2);
    expect(result.unimportable.length).toBe(1);
    expect(result.unimportable[0].reason).toMatch(/invalid JSON on line 2/);
  });

  it("an empty session file yields no item and one unimportable entry", () => {
    const result = readSessionJsonl("", "sessions/empty.jsonl", "sessions/empty.jsonl", () => FIXED_NOW);
    expect(result.item).toBeUndefined();
    expect(result.unimportable.length).toBe(1);
  });
});

describe("classifySqliteTables (via a real, hand-written SQLite fixture)", () => {
  it("identifies session/message/memory tables purely from column names, never a hardcoded schema", async () => {
    materializeHermesFixture(workDir, { variant: "home", seed: 20, withSqlite: true });
    const opened = await openSqlite(join(workDir, "hermes.db"));
    if (!opened.ok) {
      // node:sqlite unavailable in this runtime -- nothing to assert, the reader already degrades honestly elsewhere.
      return;
    }
    const { sessionsTable, messagesTable, memoryTable } = classifySqliteTables(opened.reader, opened.reader.tables());
    expect(sessionsTable?.table).toBe("sessions");
    expect(messagesTable?.table).toBe("messages");
    expect(memoryTable?.table).toBe("facts");
    opened.reader.close();
  });

  it("an unrecognizable schema is reported unimportable with the actual table/column names, not a hardcoded guess", async () => {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const dbPath = join(workDir, "weird.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE widgets (widget_id INTEGER, color TEXT);");
    db.close();

    const opened = await openSqlite(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { sessionsTable, messagesTable, memoryTable } = classifySqliteTables(opened.reader, opened.reader.tables());
    expect(sessionsTable).toBeUndefined();
    expect(messagesTable).toBeUndefined();
    expect(memoryTable).toBeUndefined();
    opened.reader.close();
  });
});
