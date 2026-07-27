/**
 * Real, on-disk fixture trees for `hermes-source.ts` / `openclaw-source.ts`.
 *
 * This is the ONE file on this team that writes real files (`node:fs`
 * directly) -- both adapters stay pure over `SourceReadDeps`. Every
 * materializer here is deterministic given `seed`: same inputs, byte-for-byte
 * identical output, so `FixtureManifest.files[].sha256` is a real, reusable
 * fingerprint rather than a snapshot that drifts run to run.
 *
 * Content is built, wherever possible, through the SAME real serializers the
 * adapters parse against (`serializeSkillFile` for every SKILL.md) so a
 * fixture can never silently drift out of sync with what a real vendor
 * install would actually contain. Everything else (config.json, .env,
 * memory/session JSON(L), the SQLite store) is built by hand to the exact
 * shapes `hermes-source.ts` / `openclaw-source.ts` are documented to parse.
 *
 * `FixtureManifest.expected` is computed INLINE as each artifact is written
 * (an `expected.items.<kind> += 1` right where that item is decided to be
 * well-formed, an `expected.unimportable += 1` right where a line/file is
 * decided to be deliberately broken) rather than derived after the fact --
 * this is what keeps the manifest honest: the counters are the same code
 * path that produced the bytes, not a hand-reconstructed guess.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ArtifactKind } from "./ir";
import { DEFAULT_MAX_FILE_BYTES } from "./hermes-source";
import { serializeSkillFile } from "../skills/skill-file";
import type { SkillManifest } from "../skills/skill-file";

// ---------------------------------------------------------------------------
// Locked contract: FixtureOptions / FixtureManifest
// ---------------------------------------------------------------------------

export type CorruptOption =
  | "truncated-json"
  | "bad-utf8"
  | "unterminated-frontmatter"
  | "traversal-skill-name"
  | "oversized-file"
  | "symlink-escape"
  | "sqlite-garbage";

export interface FixtureOptions {
  variant: "home" | "xdg" | "macos" | "windows-appdata";
  withSqlite?: boolean;
  withSecrets?: boolean;
  sessions?: number;
  memories?: number;
  skills?: number;
  corrupt?: CorruptOption[];
  seed?: number;
}

export interface FixtureFileEntry {
  relPath: string;
  sha256: string;
  bytes: number;
}

export type FixtureVendorLabel = "hermes" | "openclaw" | "openclaw-legacy-clawdbot" | "openclaw-legacy-moltbot";

export interface FixtureManifest {
  root: string;
  vendor: FixtureVendorLabel;
  variant: FixtureOptions["variant"];
  seed: number;
  /** Every file written, in the order it was written. */
  files: FixtureFileEntry[];
  sqlite: { present: true; relPath: string; sha256: string; bytes: number } | { present: false; reason: string };
  expected: {
    items: Record<ArtifactKind, number>;
    unimportable: number;
    secrets: number;
  };
  /** Human-readable design notes about deliberate corruption/edge-cases baked into this fixture. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** mulberry32 -- a tiny, fully deterministic PRNG. Same seed -> same sequence, forever, on any platform. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256HexOfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const BASE_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
function isoAt(offsetDays: number): string {
  return new Date(BASE_EPOCH_MS + offsetDays * 86_400_000).toISOString();
}

function zeroExpectedItems(): Record<ArtifactKind, number> {
  return { config: 0, model: 0, memory: 0, "context-file": 0, session: 0, skill: 0, secret: 0, "tool-state": 0, unknown: 0 };
}

/** A deterministic fake API key shaped like a real one (for exercising secret-detection), never a real credential. */
function fakeApiKey(rng: () => number, prefix: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(rng() * chars.length)];
  return `${prefix}${out}`;
}

/** Writer state threaded through one materialize call -- tracks files, byte content, and line-ending policy. */
class FixtureWriter {
  readonly files: FixtureFileEntry[] = [];
  readonly eol: "\n" | "\r\n";

  constructor(
    readonly root: string,
    variant: FixtureOptions["variant"],
  ) {
    this.eol = variant === "windows-appdata" ? "\r\n" : "\n";
    mkdirSync(root, { recursive: true });
  }

  private normalizeEol(text: string): string {
    const lf = text.replace(/\r\n/g, "\n");
    return this.eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
  }

  /** Writes a UTF-8 text file, applying this fixture's line-ending policy. Returns the written byte length. */
  writeText(relPath: string, text: string): number {
    const normalized = this.normalizeEol(text);
    return this.writeBuffer(relPath, Buffer.from(normalized, "utf8"));
  }

  /** Writes raw bytes verbatim -- used for deliberately-invalid-UTF-8 and SQLite-garbage fixtures. */
  writeBuffer(relPath: string, buf: Buffer): number {
    const abs = join(this.root, ...relPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    this.files.push({ relPath, sha256: sha256HexOfBuffer(buf), bytes: buf.length });
    return buf.length;
  }

  symlink(relPath: string, target: string, notes: string[]): void {
    const abs = join(this.root, ...relPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    try {
      symlinkSync(target, abs, "dir");
    } catch (e) {
      notes.push(`symlink-escape: could not create a real symlink on this platform/filesystem (${(e as Error).message}); skipped`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared building blocks (skills, memory Facts, sessions, sqlite)
// ---------------------------------------------------------------------------

function skillMd(manifest: SkillManifest): string {
  return serializeSkillFile(manifest);
}

/** A `## Facts` section with `count` well-formed bullets, deterministic content. Optionally preceded by prose. */
function memoryMdWithFacts(opts: { preamble?: string; count: number; sourceLabel: string }): string {
  const lines: string[] = [];
  if (opts.preamble) lines.push(opts.preamble, "");
  lines.push("## Facts", "");
  for (let i = 0; i < opts.count; i++) {
    lines.push(`- [${isoAt(i)}] fixture fact number ${i} (source: ${opts.sourceLabel})`);
  }
  return lines.join("\n") + "\n";
}

/** `count` well-formed MemoryRecord-shaped objects for a memory.json array. */
function memoryJsonArray(count: number, sourceLabel: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      fact: `flat memory fact number ${i}`,
      salience: 0.5 + (i % 5) / 10,
      tags: ["fixture", `n${i}`],
      source: sourceLabel,
      createdAt: isoAt(i),
    });
  }
  return out;
}

/** `count` well-formed lines plus exactly one deliberately-broken JSON line inserted mid-file. */
function memoryJsonlWithOneBadLine(count: number, sourceLabel: string): { content: string; validCount: number } {
  const lines: string[] = [];
  const badAt = Math.max(1, Math.floor(count / 2));
  for (let i = 0; i < count; i++) {
    if (i === badAt) lines.push('{"fact": "unterminated fixture fact, deliberately broken JSON'); // no closing quote/brace
    lines.push(
      JSON.stringify({ fact: `jsonl memory fact number ${i}`, salience: 0.4, tags: ["fixture"], source: sourceLabel, createdAt: isoAt(i) }),
    );
  }
  return { content: lines.join("\n") + "\n", validCount: count };
}

interface SessionSpec {
  relPath: string;
  format: "jsonl" | "json";
  messageCount: number;
  withBadLine: boolean;
}

function sessionJsonlContent(spec: SessionSpec, id: string): string {
  const lines: string[] = [JSON.stringify({ type: "session-meta", id, title: `Fixture session ${id}`, tags: ["fixture"] })];
  const badAt = spec.withBadLine ? Math.max(1, Math.floor(spec.messageCount / 2)) : -1;
  for (let i = 0; i < spec.messageCount; i++) {
    if (i === badAt) lines.push("{not valid json at all");
    const role = i % 2 === 0 ? "user" : "assistant";
    lines.push(JSON.stringify({ role, content: `fixture message ${i} in session ${id}`, at: isoAt(i) }));
  }
  return lines.join("\n") + "\n";
}

function sessionJsonWholeContent(spec: SessionSpec, id: string): string {
  const messages = [];
  for (let i = 0; i < spec.messageCount; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `fixture message ${i} in session ${id}`, at: isoAt(i) });
  }
  return JSON.stringify({ id, title: `Fixture session ${id}`, tags: ["fixture"], messages }, null, 2);
}

// ---------------------------------------------------------------------------
// SQLite (real, written with node:sqlite when present)
// ---------------------------------------------------------------------------

interface SqliteBuildResult {
  wrote: boolean;
  reason?: string;
  bytes?: number;
  sha256?: string;
  memoryRows: number;
  sessionCount: number;
}

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void };
};

function writeRealSqliteDb(absPath: string, seed: number): SqliteBuildResult {
  let nodeSqlite: NodeSqliteModule;
  try {
    // Synchronous `require` (via createRequire) rather than dynamic `import()` --
    // this whole module's contract is synchronous (`materialize*Fixture` returns
    // `FixtureManifest`, not a Promise), so SQLite fixture generation must be too.
    //
    // Dual-format guard (duplicated in gov/airgap.ts on purpose -- no shared
    // spot exists that both files reach without inventing a new dependency):
    // in the CJS bundle (scripts/build-hades.mjs, format "cjs") esbuild leaves
    // `import.meta` as an empty object, so `import.meta.url` is `undefined` and
    // `createRequire(undefined)` throws -- there `__filename` is the real module
    // path. Under genuine ESM `__filename` is undeclared, but `typeof` on an
    // undeclared identifier never throws, so this falls through to
    // `import.meta.url`, the token that format actually provides.
    const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    nodeSqlite = req("node:sqlite") as NodeSqliteModule;
  } catch (e) {
    return { wrote: false, reason: `node:sqlite is unavailable in this runtime: ${(e as Error).message}`, memoryRows: 0, sessionCount: 0 };
  }

  try {
    if (existsSync(absPath)) {
      // Start clean -- a stale fixture file from a previous run must not corrupt this one.
      try {
        chmodSync(absPath, 0o600);
      } catch {
        /* best effort */
      }
    }
    const db = new nodeSqlite.DatabaseSync(absPath);
    try {
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, summary TEXT, tags TEXT, started_at TEXT, ended_at TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, at TEXT);
        CREATE TABLE facts (id INTEGER PRIMARY KEY, fact TEXT, salience REAL, tags TEXT, source TEXT, created_at TEXT);
      `);
      const insSession = db.prepare("INSERT INTO sessions (id, title, summary, tags, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)");
      insSession.run("sqlite-session-0", "SQLite fixture session", "a fixture-generated summary", JSON.stringify(["fixture", "sqlite"]), isoAt(0), isoAt(1));

      const insMessage = db.prepare("INSERT INTO messages (session_id, role, content, at) VALUES (?, ?, ?, ?)");
      insMessage.run("sqlite-session-0", "user", "hello from the sqlite fixture", isoAt(0));
      insMessage.run("sqlite-session-0", "assistant", "hi -- this row came from a real sqlite file", isoAt(1));

      const insFact = db.prepare("INSERT INTO facts (fact, salience, tags, source, created_at) VALUES (?, ?, ?, ?, ?)");
      const rng = mulberry32(seed);
      insFact.run("sqlite fixture fact zero", 0.6 + rng() * 0.1, JSON.stringify(["fixture"]), "sqlite", isoAt(0));
      insFact.run("sqlite fixture fact one", 0.5, JSON.stringify(["fixture", "second"]), "sqlite", isoAt(1));
    } finally {
      db.close();
    }
  } catch (e) {
    return { wrote: false, reason: `writing the real SQLite fixture failed: ${(e as Error).message}`, memoryRows: 0, sessionCount: 0 };
  }

  const buf = readFileSync(absPath);
  const st = statSync(absPath);
  return { wrote: true, bytes: st.size, sha256: sha256HexOfBuffer(buf), memoryRows: 2, sessionCount: 1 };
}

// ---------------------------------------------------------------------------
// materializeHermesFixture
// ---------------------------------------------------------------------------

export function materializeHermesFixture(dir: string, opts: FixtureOptions = { variant: "home" }): FixtureManifest {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const memories = opts.memories ?? 3;
  const sessions = opts.sessions ?? 2;
  const skills = opts.skills ?? 2;
  const corrupt = new Set(opts.corrupt ?? []);
  const notes: string[] = [];
  const w = new FixtureWriter(dir, opts.variant);
  const expected = zeroExpectedItems();
  let expectedUnimportable = 0;
  let expectedSecrets = 0;

  // --- config.json --------------------------------------------------------
  const configObj: Record<string, unknown> = {
    model: "hermes-large-v3",
    locale: "en-US",
    plugins: ["shell", "browser"],
    gateway: { trigger: "!hermes", allowedUsers: ["alice", "bob"] },
  };
  if (opts.withSecrets) {
    configObj.backupApiKey = fakeApiKey(rng, "sk-ant-");
  }
  const configJson = JSON.stringify(configObj, null, 2);
  if (corrupt.has("truncated-json")) {
    const buf = Buffer.from(configJson, "utf8").subarray(0, 15);
    w.writeBuffer("config.json", buf);
    expectedUnimportable += 1; // config.json fails to parse -> whole file unimportable, 0 config items
    notes.push("truncated-json: config.json was cut to 15 bytes, producing invalid JSON -> 1 unimportable(config), 0 config items");
  } else {
    w.writeText("config.json", configJson);
    expected.config += 5; // model, locale, plugins, gateway.trigger, gateway.allowedUsers
    if (opts.withSecrets) {
      // config-embedded secrets are moved to the vault and redacted IN PLACE -- no separate
      // "secret" kind item is created for them (only .env, whose entire purpose is secrets,
      // gets a descriptor item per line; see readDotenvFile vs extractConfigAndSecrets).
      expectedSecrets += 1;
    }
  }

  // --- .env ----------------------------------------------------------------
  if (opts.withSecrets) {
    const openaiKey = fakeApiKey(rng, "sk-");
    const anthropicKey = fakeApiKey(rng, "sk-ant-");
    w.writeText(".env", `# fixture secrets -- fake, never real credentials\nOPENAI_API_KEY=${openaiKey}\nANTHROPIC_API_KEY=${anthropicKey}\n`);
    expected.secret += 2;
    expectedSecrets += 2;
  }

  // --- model.json ------------------------------------------------------------
  w.writeText("model.json", JSON.stringify({ modelId: "hermes-large-v3", provider: "hermes-labs" }, null, 2));
  expected.model += 1;

  // --- memory/MEMORY.md + memory/USER.md -----------------------------------
  if (corrupt.has("oversized-file")) {
    const lines: string[] = [];
    let i = 0;
    let totalLen = 0;
    // Grow well past DEFAULT_MAX_FILE_BYTES with variable-length lines so the cap can never land exactly on a boundary.
    while (totalLen < DEFAULT_MAX_FILE_BYTES + 4096) {
      const line = `padding line ${i} ${"x".repeat(40 + (i % 17))}`;
      lines.push(line);
      totalLen += Buffer.byteLength(line, "utf8") + 1;
      i++;
    }
    const preamble = lines.join("\n");
    const full = memoryMdWithFacts({ preamble, count: memories, sourceLabel: "fixture-memory-md" });
    const fullBuf = Buffer.from(w.eol === "\r\n" ? full.replace(/\n/g, "\r\n") : full, "utf8");
    w.writeBuffer("memory/MEMORY.md", fullBuf);
    // The read cap lands inside the padding (well before "## Facts"), so no Facts bullets survive -- only the
    // (truncated) context-file item for MEMORY.md itself.
    expected["context-file"] += 1;
    notes.push(
      `oversized-file: memory/MEMORY.md is ${fullBuf.length} bytes with ${DEFAULT_MAX_FILE_BYTES}+ bytes of padding before "## Facts", ` +
        "so a reader using the default maxFileBytes truncates before any Facts bullet survives (0 memory items from this file, 1 truncated context-file item)",
    );
  } else {
    w.writeText("memory/MEMORY.md", memoryMdWithFacts({ preamble: "Durable notes about this fixture user.", count: memories, sourceLabel: "fixture-memory-md" }));
    expected.memory += memories;
    expected["context-file"] += 1;
  }
  if (corrupt.has("bad-utf8")) {
    const validPrefix = Buffer.from("# User\n\nThis user likes invalid bytes: ", "utf8");
    const invalid = Buffer.from([0xff, 0xfe, 0xc3, 0x28]); // not valid UTF-8
    const validSuffix = Buffer.from("\n\nAnd continues normally after them.\n", "utf8");
    w.writeBuffer("memory/USER.md", Buffer.concat([validPrefix, invalid, validSuffix]));
    notes.push("bad-utf8: memory/USER.md contains real invalid UTF-8 byte sequences; a UTF-8 decode never throws (U+FFFD substitution), so this still yields 1 context-file item");
  } else {
    w.writeText("memory/USER.md", "# User\n\nPrefers concise answers. Timezone: UTC.\n");
  }
  expected["context-file"] += 1;

  // --- memory.json / memory.jsonl ------------------------------------------
  w.writeText("memory.json", JSON.stringify(memoryJsonArray(memories, "fixture-memory-json"), null, 2));
  expected.memory += memories;

  const { content: jsonlContent } = memoryJsonlWithOneBadLine(memories, "fixture-memory-jsonl");
  w.writeText("memory.jsonl", jsonlContent);
  expected.memory += memories;
  expectedUnimportable += 1;

  // --- skills ---------------------------------------------------------------
  for (let i = 0; i < skills; i++) {
    const manifest: SkillManifest = {
      name: `skill-${i}`,
      description: `Fixture skill number ${i}.`,
      capabilities: ["fixture"],
      tools: [],
      whenToUse: "When exercising the migration adapter's SKILL.md parsing.",
      version: "1.0.0",
      instructions: `# skill-${i}\n\nDo fixture things for skill ${i}.\n`,
    };
    if (i % 2 === 0) {
      w.writeText(`skills/skill-${i}/SKILL.md`, skillMd(manifest));
    } else {
      w.writeText(`skills/skill-${i}.md`, skillMd(manifest));
    }
    expected.skill += 1;
  }
  // Duplicate skill name across two distinct nested directories -- first import wins, second is unimportable.
  const dupManifest = (dir_: string): SkillManifest => ({
    name: "shared-skill-name",
    description: `Duplicate-name fixture skill in ${dir_}.`,
    capabilities: [],
    tools: [],
    instructions: "# shared-skill-name\n\nDuplicate-name fixture body.\n",
  });
  w.writeText("skills/dup-a/SKILL.md", skillMd(dupManifest("dup-a")));
  w.writeText("skills/dup-b/SKILL.md", skillMd(dupManifest("dup-b")));
  expected.skill += 1; // dup-a wins
  expectedUnimportable += 1; // dup-b: duplicate

  if (corrupt.has("unterminated-frontmatter")) {
    w.writeText("skills/broken/SKILL.md", "---\nname: broken\ndescription: missing the closing frontmatter delimiter\n");
    expectedUnimportable += 1;
  }
  if (corrupt.has("traversal-skill-name")) {
    const traversal: SkillManifest = {
      name: "../../etc/evil-fixture",
      description: "A skill whose declared name looks like a path traversal attempt.",
      capabilities: [],
      tools: [],
      instructions: "# evil\n\nThis body is inert data; only the manifest name is adversarial.\n",
    };
    w.writeText("skills/evil/SKILL.md", skillMd(traversal));
    expected.skill += 1; // sanitized key, not a traversal -- still imported, with a warning note
    notes.push('traversal-skill-name: skills/evil/SKILL.md declares name "../../etc/evil-fixture"; the item key must be sanitized, never a traversal');
  }

  // --- sessions --------------------------------------------------------------
  for (let i = 0; i < sessions; i++) {
    const id = `session-${i}`;
    const withBadLine = i === 0;
    const spec: SessionSpec = { relPath: `sessions/${id}.jsonl`, format: "jsonl", messageCount: 3, withBadLine };
    w.writeText(spec.relPath, sessionJsonlContent(spec, id));
    expected.session += 1;
    if (withBadLine) expectedUnimportable += 1;
  }

  // --- symlink-escape ----------------------------------------------------
  if (corrupt.has("symlink-escape")) {
    w.symlink("skills/escaped-link", tmpdir(), notes);
    notes.push("symlink-escape: skills/escaped-link points outside the fixture root; the reader must record a warning and never follow it");
  }

  // --- SQLite ---------------------------------------------------------------
  return finalizeWithSqlite(w, "hermes", opts, seed, expected, expectedUnimportable, expectedSecrets, notes, corrupt);
}

function finalizeWithSqlite(
  w: FixtureWriter,
  vendor: FixtureVendorLabel,
  opts: FixtureOptions,
  seed: number,
  expected: Record<ArtifactKind, number>,
  expectedUnimportableIn: number,
  expectedSecretsIn: number,
  notes: string[],
  corrupt: Set<CorruptOption>,
): FixtureManifest {
  let expectedUnimportable = expectedUnimportableIn;
  const expectedSecrets = expectedSecretsIn;
  const dbRelPath = vendor === "hermes" ? "hermes.db" : undefined;
  let sqlite: FixtureManifest["sqlite"] = {
    present: false,
    reason: dbRelPath ? "withSqlite was not requested" : `${vendor} fixtures do not include a SQLite artifact rule`,
  };

  if (dbRelPath && corrupt.has("sqlite-garbage")) {
    const rng = mulberry32(seed ^ 0x5bd1e995);
    const garbage = Buffer.alloc(256);
    for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(rng() * 256);
    w.writeBuffer(dbRelPath, garbage);
    sqlite = { present: false, reason: "sqlite-garbage: 256 random bytes written in place of a real database" };
    expectedUnimportable += 1; // openSqlite fails to open it -> 1 unimportable(unknown)
    notes.push(`sqlite-garbage: ${dbRelPath} contains 256 random bytes with no SQLite header -- openSqlite must classify it as not-sqlite/corrupt, not crash`);
  } else if (dbRelPath && opts.withSqlite) {
    const abs = join(w.root, dbRelPath);
    const result = writeRealSqliteDb(abs, seed);
    if (result.wrote && result.bytes !== undefined && result.sha256 !== undefined) {
      w.files.push({ relPath: dbRelPath, sha256: result.sha256, bytes: result.bytes });
      sqlite = { present: true, relPath: dbRelPath, sha256: result.sha256, bytes: result.bytes };
      expected.memory += result.memoryRows;
      expected.session += result.sessionCount;
    } else {
      sqlite = { present: false, reason: result.reason ?? "unknown failure writing the SQLite fixture" };
      notes.push(`withSqlite was requested but no real database was written: ${sqlite.reason}`);
    }
  }

  const manifest: FixtureManifest = {
    root: w.root,
    vendor,
    variant: opts.variant,
    seed,
    files: w.files,
    sqlite,
    expected: { items: expected, unimportable: expectedUnimportable, secrets: expectedSecrets },
    notes,
  };
  return manifest;
}

// ---------------------------------------------------------------------------
// materializeOpenClawFixture
// ---------------------------------------------------------------------------

export function materializeOpenClawFixture(dir: string, opts: FixtureOptions = { variant: "home" }): FixtureManifest {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const memories = opts.memories ?? 3;
  const sessions = opts.sessions ?? 2;
  const skills = opts.skills ?? 2;
  const corrupt = new Set(opts.corrupt ?? []);
  const notes: string[] = [];
  const w = new FixtureWriter(dir, opts.variant);
  const expected = zeroExpectedItems();
  let expectedUnimportable = 0;
  let expectedSecrets = 0;

  // --- openclaw.json (tolerant JSONC: comments + trailing comma) ------------
  const secretLine = opts.withSecrets ? `  "backupApiKey": "${fakeApiKey(rng, "sk-ant-")}",\n` : "";
  const jsonc = [
    "{",
    "  // fixture openclaw.json -- exercises tolerant JSONC parsing",
    '  "locale": "en-GB",',
    '  "plugins": ["shell", "web"], // trailing comment',
    "  /* block comment spanning",
    "     more than one line */",
    '  "gateway": {',
    '    "trigger": "!openclaw",',
    '    "allowedUsers": ["carol", "dave"],',
    "  },",
    secretLine.replace(/\n$/, ""),
    "}",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
  if (corrupt.has("truncated-json")) {
    const buf = Buffer.from(jsonc, "utf8").subarray(0, 15);
    w.writeBuffer("openclaw.json", buf);
    expectedUnimportable += 1;
    notes.push("truncated-json: openclaw.json was cut to 15 bytes, producing invalid JSONC -> 1 unimportable(config), 0 config items");
  } else {
    w.writeText("openclaw.json", jsonc);
    expected.config += 4; // locale, plugins, gateway.trigger, gateway.allowedUsers ("model" is deliberately omitted)
    if (opts.withSecrets) {
      // config-embedded secrets are vaulted + redacted in place, no separate "secret" item (see hermes-source.ts).
      expectedSecrets += 1;
    }
  }

  // --- .env ------------------------------------------------------------------
  if (opts.withSecrets) {
    const openaiKey = fakeApiKey(rng, "sk-");
    w.writeText(".env", `# fixture secrets -- fake, never real credentials\nOPENAI_API_KEY=${openaiKey}\n`);
    expected.secret += 1;
    expectedSecrets += 1;
  }

  // --- agents/*.json ----------------------------------------------------------
  w.writeText(
    "agents/agent-a.json",
    JSON.stringify({ name: "agent-a", active: true, model: "openclaw-large-v1", provider: "openclaw-labs" }, null, 2),
  );
  expected["tool-state"] += 1;
  expected.model += 1;
  w.writeText("agents/agent-b.json", JSON.stringify({ name: "agent-b", model: "openclaw-mini" }, null, 2));
  expected["tool-state"] += 1;

  // --- skills ------------------------------------------------------------------
  for (let i = 0; i < skills; i++) {
    const manifest: SkillManifest = {
      name: `oc-skill-${i}`,
      description: `OpenClaw fixture skill number ${i}.`,
      capabilities: ["fixture"],
      tools: [],
      version: "1.0.0",
      instructions: `# oc-skill-${i}\n\nDo fixture things for skill ${i}.\n`,
    };
    w.writeText(`skills/oc-skill-${i}/SKILL.md`, skillMd(manifest));
    expected.skill += 1;
  }
  const dup = (label: string): SkillManifest => ({
    name: "shared-oc-skill-name",
    description: `Duplicate-name fixture skill in ${label}.`,
    capabilities: [],
    tools: [],
    instructions: "# shared-oc-skill-name\n\nDuplicate-name fixture body.\n",
  });
  w.writeText("skills/oc-dup-a/SKILL.md", skillMd(dup("oc-dup-a")));
  w.writeText("skills/oc-dup-b/SKILL.md", skillMd(dup("oc-dup-b")));
  expected.skill += 1;
  expectedUnimportable += 1;

  if (corrupt.has("unterminated-frontmatter")) {
    w.writeText("skills/oc-broken/SKILL.md", "---\nname: oc-broken\ndescription: missing the closing frontmatter delimiter\n");
    expectedUnimportable += 1;
  }
  if (corrupt.has("traversal-skill-name")) {
    const traversal: SkillManifest = {
      name: "../../oc-evil-fixture",
      description: "A skill whose declared name looks like a path traversal attempt.",
      capabilities: [],
      tools: [],
      instructions: "# evil\n\nInert data; only the manifest name is adversarial.\n",
    };
    w.writeText("skills/oc-evil/SKILL.md", skillMd(traversal));
    expected.skill += 1;
    notes.push('traversal-skill-name: skills/oc-evil/SKILL.md declares name "../../oc-evil-fixture"; sanitized key, not a traversal');
  }

  // --- memory/*.md -------------------------------------------------------------
  if (corrupt.has("oversized-file")) {
    const lines: string[] = [];
    let i = 0;
    let totalLen = 0;
    while (totalLen < DEFAULT_MAX_FILE_BYTES + 4096) {
      const line = `padding line ${i} ${"y".repeat(37 + (i % 13))}`;
      lines.push(line);
      totalLen += Buffer.byteLength(line, "utf8") + 1;
      i++;
    }
    const full = memoryMdWithFacts({ preamble: lines.join("\n"), count: memories, sourceLabel: "fixture-memory-md" });
    const fullBuf = Buffer.from(w.eol === "\r\n" ? full.replace(/\n/g, "\r\n") : full, "utf8");
    w.writeBuffer("memory/notes.md", fullBuf);
    expected["context-file"] += 1;
    notes.push(`oversized-file: memory/notes.md is ${fullBuf.length} bytes; the default maxFileBytes cap truncates before "## Facts", so 0 memory items and 1 truncated context-file item`);
  } else {
    w.writeText("memory/notes.md", memoryMdWithFacts({ preamble: "Durable OpenClaw fixture notes.", count: memories, sourceLabel: "fixture-memory-md" }));
    expected.memory += memories;
    expected["context-file"] += 1;
  }
  w.writeText("memory/context.md", "# Context\n\nGeneral background the agent should know.\n");
  expected["context-file"] += 1;

  if (corrupt.has("bad-utf8")) {
    const validPrefix = Buffer.from("# Notes\n\nContains invalid bytes: ", "utf8");
    const invalid = Buffer.from([0xff, 0xfe, 0xc3, 0x28]);
    const validSuffix = Buffer.from("\n\nand continues normally.\n", "utf8");
    w.writeBuffer("memory/binary-ish.md", Buffer.concat([validPrefix, invalid, validSuffix]));
    expected["context-file"] += 1;
    notes.push("bad-utf8: memory/binary-ish.md contains real invalid UTF-8 byte sequences; decode never throws, still yields 1 context-file item");
  }

  // --- sessions ------------------------------------------------------------------
  for (let i = 0; i < sessions; i++) {
    const id = `oc-session-${i}`;
    if (i === 0) {
      const spec: SessionSpec = { relPath: `sessions/${id}.jsonl`, format: "jsonl", messageCount: 3, withBadLine: true };
      w.writeText(spec.relPath, sessionJsonlContent(spec, id));
      expected.session += 1;
      expectedUnimportable += 1;
    } else {
      const spec: SessionSpec = { relPath: `sessions/${id}.json`, format: "json", messageCount: 2, withBadLine: false };
      w.writeText(spec.relPath, sessionJsonWholeContent(spec, id));
      expected.session += 1;
    }
  }

  if (corrupt.has("symlink-escape")) {
    w.symlink("skills/escaped-link", tmpdir(), notes);
    notes.push("symlink-escape: skills/escaped-link points outside the fixture root; the reader must record a warning and never follow it");
  }

  return finalizeWithSqlite(w, "openclaw", opts, seed, expected, expectedUnimportable, expectedSecrets, notes, corrupt);
}

// ---------------------------------------------------------------------------
// materializeLegacyClawdbotFixture
// ---------------------------------------------------------------------------

export function materializeLegacyClawdbotFixture(dir: string, opts: FixtureOptions = { variant: "home" }): FixtureManifest {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const memories = opts.memories ?? 3;
  const corrupt = new Set(opts.corrupt ?? []);
  const notes: string[] = [];
  const w = new FixtureWriter(dir, opts.variant);
  const expected = zeroExpectedItems();
  let expectedUnimportable = 0;
  let expectedSecrets = 0;

  // --- clawdbot.json (legacy field names) -------------------------------------
  const clawdbotObj: Record<string, unknown> = {
    defaultModel: "clawdbot-legacy-v1",
    language: "en",
    triggerWord: "!clawdbot",
    authorizedUsers: ["erin"],
    extensions: ["shell"],
  };
  if (opts.withSecrets) clawdbotObj.apiToken = fakeApiKey(rng, "sk-");
  w.writeText("clawdbot.json", JSON.stringify(clawdbotObj, null, 2));
  // Every legacy field maps via OPENCLAW_LEGACY_KEY_RENAME_MAP: model, locale, gateway.trigger, gateway.allowedUsers, plugins.
  expected.config += 5;
  // No dedicated model.json / agents/ dir in a legacy layout -- clawdbot.json's mapped "model"
  // config field is the only model evidence, so it also becomes the model:selection item.
  expected.model += 1;
  if (opts.withSecrets) {
    // config-embedded secrets are vaulted + redacted in place, no separate "secret" item.
    expectedSecrets += 1;
  }

  // --- memory.json (flat legacy store) -----------------------------------------
  w.writeText("memory.json", JSON.stringify(memoryJsonArray(memories, "fixture-clawdbot-memory"), null, 2));
  expected.memory += memories;

  // --- history/*.jsonl + history/*.json (legacy session dir) -------------------
  const jsonlSpec: SessionSpec = { relPath: "history/h0.jsonl", format: "jsonl", messageCount: 3, withBadLine: true };
  w.writeText(jsonlSpec.relPath, sessionJsonlContent(jsonlSpec, "h0"));
  expected.session += 1;
  expectedUnimportable += 1;

  const jsonSpec: SessionSpec = { relPath: "history/h1.json", format: "json", messageCount: 2, withBadLine: false };
  w.writeText(jsonSpec.relPath, sessionJsonWholeContent(jsonSpec, "h1"));
  expected.session += 1;

  // --- plugins/*/SKILL.md (legacy skill-equivalents) ----------------------------
  const manifest: SkillManifest = {
    name: "legacy-plugin-skill",
    description: "A legacy clawdbot plugin, read through the same SKILL.md parser.",
    capabilities: [],
    tools: [],
    instructions: "# legacy-plugin-skill\n\nFixture body.\n",
  };
  w.writeText("plugins/legacy-plugin-skill/SKILL.md", skillMd(manifest));
  expected.skill += 1;

  if (corrupt.has("unterminated-frontmatter")) {
    w.writeText("plugins/broken/SKILL.md", "---\nname: broken\ndescription: missing the closing delimiter\n");
    expectedUnimportable += 1;
  }
  if (corrupt.has("truncated-json")) {
    // Apply to memory.json instead of clawdbot.json here, for coverage variety across fixtures.
    const buf = Buffer.from(JSON.stringify(memoryJsonArray(memories, "x")), "utf8").subarray(0, 10);
    w.writeBuffer("memory.json", buf);
    expected.memory -= memories; // overwritten: no longer well-formed
    expectedUnimportable += 1;
    notes.push("truncated-json: memory.json was overwritten with a 10-byte truncated fragment -> 1 unimportable(memory), 0 memory items from this file");
  }

  return finalizeWithSqlite(w, "openclaw-legacy-clawdbot", opts, seed, expected, expectedUnimportable, expectedSecrets, notes, corrupt);
}

// ---------------------------------------------------------------------------
// materializeLegacyMoltbotFixture (additive, beyond the three locked exports --
// exists purely so every OPENCLAW_ARTIFACTS rule has SOME real fixture behind
// it, per the reverse-parity requirement: moltbot.json / state.json / logs/
// / addons/ are otherwise never exercised by any of the three required
// materializers above).
// ---------------------------------------------------------------------------

export function materializeLegacyMoltbotFixture(dir: string, opts: FixtureOptions = { variant: "home" }): FixtureManifest {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const corrupt = new Set(opts.corrupt ?? []);
  const notes: string[] = [];
  const w = new FixtureWriter(dir, opts.variant);
  const expected = zeroExpectedItems();
  let expectedUnimportable = 0;
  let expectedSecrets = 0;

  const moltbotObj: Record<string, unknown> = {
    botModel: "moltbot-legacy-v1",
    lang: "en",
    wakeWord: "!moltbot",
    allowedUsers: ["frank"],
    addons: ["shell"],
  };
  if (opts.withSecrets) moltbotObj.secretToken = fakeApiKey(rng, "sk-");
  w.writeText("moltbot.json", JSON.stringify(moltbotObj, null, 2));
  expected.config += 5;
  // No dedicated model.json / agents/ dir in a legacy layout -- moltbot.json's mapped "model"
  // config field is the only model evidence, so it also becomes the model:selection item.
  expected.model += 1;
  if (opts.withSecrets) {
    // config-embedded secrets are vaulted + redacted in place, no separate "secret" item.
    expectedSecrets += 1;
  }

  const stateObj: Record<string, unknown> = { lastRunAt: isoAt(0), toolCallCount: 42, flags: { verbose: false } };
  if (opts.withSecrets) stateObj.cachedApiKey = fakeApiKey(rng, "sk-ant-");
  w.writeText("state.json", JSON.stringify(stateObj, null, 2));
  expected["tool-state"] += 1;
  if (opts.withSecrets) {
    // state.json's secret scan feeds the vault directly; there is no separate "secret" item kind for tool-state sources.
    expectedSecrets += 1;
  }

  const jsonlSpec: SessionSpec = { relPath: "logs/l0.jsonl", format: "jsonl", messageCount: 2, withBadLine: false };
  w.writeText(jsonlSpec.relPath, sessionJsonlContent(jsonlSpec, "l0"));
  expected.session += 1;

  const jsonSpec: SessionSpec = { relPath: "logs/l1.json", format: "json", messageCount: 2, withBadLine: false };
  w.writeText(jsonSpec.relPath, sessionJsonWholeContent(jsonSpec, "l1"));
  expected.session += 1;

  const manifest: SkillManifest = {
    name: "legacy-addon-skill",
    description: "A legacy moltbot addon, read through the same SKILL.md parser.",
    capabilities: [],
    tools: [],
    instructions: "# legacy-addon-skill\n\nFixture body.\n",
  };
  w.writeText("addons/legacy-addon-skill/SKILL.md", skillMd(manifest));
  expected.skill += 1;

  return finalizeWithSqlite(w, "openclaw-legacy-moltbot", opts, seed, expected, expectedUnimportable, expectedSecrets, notes, corrupt);
}
