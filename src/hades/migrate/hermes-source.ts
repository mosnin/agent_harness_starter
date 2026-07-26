/**
 * Hermes source reader: turns a {@link DiscoveredSource} (found by
 * `./discovery.ts`) into a canonical {@link MigrationBundle} plus a
 * {@link SecretVault} of real secret material kept strictly out of the
 * bundle itself.
 *
 * Pure over {@link SourceReadDeps} -- no direct `node:fs`, no direct clock
 * read, no direct `node:sqlite` import used at call time (only its *type*,
 * via `typeof openSqlite`, is referenced so the injected `deps.openSqlite`
 * has the right shape). Every filesystem access goes through `deps.probe`;
 * every "now" goes through `deps.now()`. This is what makes the whole module
 * testable against an in-memory `FsProbe` with a frozen clock and safe to
 * fuzz with adversarial vendor content without ever touching a real disk.
 *
 * {@link HERMES_ARTIFACTS} is the declarative relative-path-glob -> kind ->
 * parser-id -> provenance table this reader walks against. It is
 * deliberately a *finer* table than `discovery.ts`'s `SOURCE_LAYOUTS`
 * (which only buckets whole directories into coarse kinds for the
 * discovery-time inventory) -- this module needs to dispatch each concrete
 * file shape (`config.json` vs `.env` vs `skills/<name>/SKILL.md` vs a SQLite
 * file) to its own real parser, so it walks `source.root` itself rather than
 * relying on `source.inventory`.
 */

import type { DiscoveredSource, FsProbe } from "./discovery";
import { makeItem } from "./ir";
import type { ArtifactKind, MigrateVendor, MigrationBundle, MigrationItem } from "./ir";
import type { JsonValue } from "../state/record";
import { openSqlite } from "./sqlite-read";
import type { SqliteColumn, SqliteReader } from "./sqlite-read";
import { parseMarkdownSections } from "../memory/context-files";
import { parseSkillFile, validateSkillManifest } from "../skills/skill-file";
import type { SkillManifest } from "../skills/skill-file";
import { sha256Hex } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Locked contract: SourceReadDeps
// ---------------------------------------------------------------------------

export interface SourceReadDeps {
  probe: FsProbe;
  openSqlite: typeof openSqlite;
  now: () => number;
  maxFileBytes?: number;
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// Secret vault (locked shape, defined here; `openclaw-source.ts` defines the
// structurally-identical counterpart independently -- both files must stay
// standalone, and TypeScript's structural typing makes the two interchangeable)
// ---------------------------------------------------------------------------

/** Metadata about a secret WITHOUT the secret material itself -- what a `"secret"` MigrationItem's value carries. */
export interface SecretDescriptor {
  /** Screaming-snake-case environment-variable-style name, e.g. `OPENAI_API_KEY`. */
  envVar: string;
  present: boolean;
  /** A safe-to-display redacted preview, e.g. `"sk-a...b12c"`. Never enough to reconstruct the secret. */
  redactedPreview?: string;
}

/** A vault entry: the descriptor PLUS the real material. Only ever lives in a {@link SecretVault}, never a bundle. */
export interface SecretVaultEntry extends SecretDescriptor {
  value: string;
  origin: { path: string; locator?: string };
}

export interface SecretVault {
  vendor: MigrateVendor;
  entries: SecretVaultEntry[];
}

// ---------------------------------------------------------------------------
// Declarative artifact table
// ---------------------------------------------------------------------------

export interface ArtifactRule {
  /** Forward-slash relative-path glob (relative to `source.root`), `*` matches within one path segment. */
  relPathGlob: string;
  /** The kind this rule primarily inventories as (a SQLite rule may emit several kinds; this documents the dominant one). */
  kind: ArtifactKind;
  /** Stable identifier for the parsing routine that handles a match -- keeps the table inspectable as data. */
  parser: string;
  /** Why this path is believed to hold Hermes data in this shape. */
  provenance: string;
}

export const HERMES_ARTIFACTS: readonly ArtifactRule[] = Object.freeze([
  {
    relPathGlob: "config.json",
    kind: "config",
    parser: "hermes.config.json",
    provenance: "config.json is Hermes' primary configuration file, written by every supported version.",
  },
  {
    relPathGlob: "settings.json",
    kind: "config",
    parser: "hermes.config.json",
    provenance: "settings.json is an alternate name some Hermes builds use for the primary configuration file.",
  },
  {
    relPathGlob: ".env",
    kind: "secret",
    parser: "dotenv",
    provenance: "Hermes reads provider API keys and other secrets from a dotenv file in its home directory.",
  },
  {
    relPathGlob: "model.json",
    kind: "model",
    parser: "hermes.model.json",
    provenance: "model.json records the active Hermes model selection.",
  },
  {
    relPathGlob: "memory/MEMORY.md",
    kind: "memory",
    parser: "hermes.memory.md",
    provenance: "memory/MEMORY.md holds Hermes' durable long-term facts, one `## Facts` bullet per remembered item.",
  },
  {
    relPathGlob: "memory/USER.md",
    kind: "context-file",
    parser: "hermes.user.md",
    provenance: "memory/USER.md holds who-the-user-is context Hermes injects into every conversation.",
  },
  {
    relPathGlob: "memory.json",
    kind: "memory",
    parser: "hermes.memory.json",
    provenance: "memory.json is a flat JSON-array memory store some Hermes builds use instead of memory/MEMORY.md.",
  },
  {
    relPathGlob: "memory.jsonl",
    kind: "memory",
    parser: "hermes.memory.jsonl",
    provenance: "memory.jsonl is a one-record-per-line memory store some Hermes builds append to directly.",
  },
  {
    relPathGlob: "skills/*/SKILL.md",
    kind: "skill",
    parser: "skill-md",
    provenance: "skills/<name>/SKILL.md is Hermes' (and Hades') portable per-directory skill format.",
  },
  {
    relPathGlob: "skills/*.md",
    kind: "skill",
    parser: "skill-md",
    provenance: "skills/<name>.md is Hermes' flat (non-directory) skill format for simple skills.",
  },
  {
    relPathGlob: "sessions/*.jsonl",
    kind: "session",
    parser: "hermes.session.jsonl",
    provenance: "sessions/<id>.jsonl holds one saved Hermes session transcript, one message per line.",
  },
  {
    relPathGlob: "hermes.db",
    kind: "unknown",
    parser: "sqlite",
    provenance: "hermes.db is a SQLite store some Hermes builds use for sessions and/or memory instead of flat files.",
  },
  {
    relPathGlob: "sessions.db",
    kind: "session",
    parser: "sqlite",
    provenance: "sessions.db is a SQLite store dedicated to session transcripts in some Hermes builds.",
  },
  {
    relPathGlob: "memory.db",
    kind: "memory",
    parser: "sqlite",
    provenance: "memory.db is a SQLite store dedicated to long-term memory in some Hermes builds.",
  },
]);

// ---------------------------------------------------------------------------
// Small pure utilities shared across parsers in this file
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_ITEMS = 5000;
export const MAX_WALK_ENTRIES = 5000;
export const MAX_WALK_DEPTH = 8;

function joinRel(root: string, child: string): string {
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  return `${trimmedRoot}/${child}`;
}

function safeExists(probe: FsProbe, p: string): boolean {
  try {
    return probe.exists(p);
  } catch {
    return false;
  }
}
function safeIsDir(probe: FsProbe, p: string): boolean {
  try {
    return probe.isDir(p);
  } catch {
    return false;
  }
}
function safeStat(probe: FsProbe, p: string): ReturnType<FsProbe["stat"]> {
  try {
    return probe.stat(p);
  } catch {
    return undefined;
  }
}
function safeReadDir(probe: FsProbe, p: string): { ok: true; entries: string[] } | { ok: false } {
  try {
    return { ok: true, entries: probe.readDir(p) };
  } catch {
    return { ok: false };
  }
}
function safeRealpath(probe: FsProbe, p: string): string | undefined {
  try {
    return probe.realpath(p);
  } catch {
    return undefined;
  }
}
export function safeReadFile(probe: FsProbe, p: string, maxBytes: number): string | undefined {
  try {
    return probe.readFile(p, maxBytes);
  } catch {
    return undefined;
  }
}

interface WalkedFile {
  relPath: string;
  abs: string;
  bytes: number;
}

/**
 * Bounded, loop- and escape-safe recursive walk of `root` via `probe`,
 * independent of (but structurally similar to) `discovery.ts`'s internal
 * walker -- this module owns its own file discovery because it needs every
 * concrete file (not just directories bucketed by coarse kind).
 */
export function walkSourceTree(
  probe: FsProbe,
  root: string,
  opts?: { maxDepth?: number; maxEntries?: number },
): { files: WalkedFile[]; warnings: string[] } {
  const maxDepth = opts?.maxDepth ?? MAX_WALK_DEPTH;
  const budget = { remaining: opts?.maxEntries ?? MAX_WALK_ENTRIES };
  const warnings: string[] = [];
  const files: WalkedFile[] = [];

  const rootReal = safeRealpath(probe, root) ?? root;
  const visited = new Set<string>([rootReal]);

  const top = safeReadDir(probe, root);
  if (!top.ok) {
    warnings.push(`source root could not be read (permission denied or transient I/O error): "${root}"`);
    return { files, warnings };
  }

  type StackEntry = { abs: string; rel: string; depth: number };
  const stack: StackEntry[] = top.entries.map((child) => ({ abs: joinRel(root, child), rel: child, depth: 1 }));

  while (stack.length > 0) {
    if (budget.remaining <= 0) {
      warnings.push(`scan truncated at ${opts?.maxEntries ?? MAX_WALK_ENTRIES} total entries`);
      break;
    }
    const cur = stack.pop()!;
    const st = safeStat(probe, cur.abs);
    if (!st) continue;

    let effectiveAbs = cur.abs;
    if (st.isSymlink) {
      const real = safeRealpath(probe, cur.abs);
      if (!real) {
        warnings.push(`broken symlink, skipping: "${cur.rel}"`);
        continue;
      }
      if (visited.has(real)) {
        warnings.push(`symlink loop detected, not following: "${cur.rel}"`);
        continue;
      }
      if (!real.startsWith(rootReal)) {
        warnings.push(`symlink escapes the source root, not followed: "${cur.rel}" -> "${real}"`);
        continue;
      }
      visited.add(real);
      effectiveAbs = real;
    }

    const isDir = safeIsDir(probe, effectiveAbs);
    if (isDir) {
      if (cur.depth >= maxDepth) {
        warnings.push(`max walk depth ${maxDepth} reached, not descending into: "${cur.rel}"`);
        continue;
      }
      const dir = safeReadDir(probe, effectiveAbs);
      if (!dir.ok) {
        warnings.push(`unreadable directory, skipping: "${cur.rel}"`);
        continue;
      }
      for (const child of dir.entries) {
        if (budget.remaining <= 0) break;
        stack.push({ abs: joinRel(effectiveAbs, child), rel: `${cur.rel}/${child}`, depth: cur.depth + 1 });
      }
    } else {
      budget.remaining -= 1;
      files.push({ relPath: cur.rel, abs: effectiveAbs, bytes: st.size });
    }
  }

  return { files, warnings };
}

/** Converts an `ArtifactRule.relPathGlob` (`*` = within one path segment) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("/")
    .map((seg) =>
      seg
        .split("*")
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
}

const RULE_REGEXPS = new WeakMap<ArtifactRule, RegExp>();
export function ruleMatches(rule: ArtifactRule, relPath: string): boolean {
  let re = RULE_REGEXPS.get(rule);
  if (!re) {
    re = globToRegExp(rule.relPathGlob);
    RULE_REGEXPS.set(rule, re);
  }
  return re.test(relPath);
}

export type UnimportableEntry = { path: string; kind: ArtifactKind; reason: string };
export type ReadErrorEntry = { path: string; reason: string };

interface TsResult {
  ms: number;
  note?: string;
}

/**
 * Disambiguates a raw timestamp value (unix seconds, unix milliseconds, or
 * an ISO/parseable date string) by range check. An unparseable/implausible
 * value falls back to `now()`, with a `note` explicitly marking the
 * substitution rather than silently inventing a timestamp.
 */
export function parseTimestampFlexible(raw: unknown, now: () => number): TsResult {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 0 && raw < 10_000_000_000) return { ms: Math.round(raw * 1000) };
    if (raw >= 10_000_000_000 && raw < 100_000_000_000_000) return { ms: Math.round(raw) };
    return { ms: now(), note: `timestamp value ${raw} is out of plausible range; substituted current time (now())` };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ms: now(), note: "timestamp was an empty string; substituted current time (now())" };
    }
    if (/^-?\d+$/.test(trimmed)) {
      return parseTimestampFlexible(Number(trimmed), now);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return { ms: parsed };
    return { ms: now(), note: `timestamp "${raw}" could not be parsed; substituted current time (now())` };
  }
  return { ms: now(), note: `timestamp was missing or not a string/number (${JSON.stringify(raw)}); substituted current time (now())` };
}

export function redactPreview(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length || 1);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function sanitizeEnvVarName(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (s.length === 0) s = "SECRET";
  if (!/^[A-Z]/.test(s)) s = `S_${s}`;
  return s;
}

const KEY_MATERIAL_RE =
  /(-----BEGIN[ A-Z]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/;

export function looksLikeKeyMaterial(s: string): boolean {
  return KEY_MATERIAL_RE.test(s);
}

export const SECRET_KEY_NAME_RE = /(api[_-]?key|apikey|token|secret|password|passwd|credential)/i;

function sha256HexOf(text: string): string {
  return sha256Hex(text);
}

export function makeMemoryItem(
  fact: string,
  opts: {
    salience?: number;
    tags?: string[];
    source?: string;
    createdAt: number;
    originPath: string;
    locator?: string;
    confidence: number;
    notes?: string[];
  },
): MigrationItem {
  const key = `memory:${sha256HexOf(fact).slice(0, 16)}`;
  const value: JsonValue = {
    fact,
    salience: clamp01(opts.salience ?? 0.5),
    tags: opts.tags ?? [],
    ...(opts.source !== undefined && opts.source.length > 0 ? { source: opts.source } : {}),
    createdAt: opts.createdAt,
  };
  return makeItem({
    kind: "memory",
    key,
    value,
    origin: { path: opts.originPath, locator: opts.locator },
    confidence: opts.confidence,
    notes: opts.notes && opts.notes.length > 0 ? opts.notes : undefined,
  });
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export function sanitizeSessionId(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "_");
  return trimmed.length > 0 ? trimmed : "unknown";
}

export function splitTagsField(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
  } catch {
    /* not JSON, fall through to CSV */
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// config.json / settings.json
// ---------------------------------------------------------------------------

type AllowedConfigPath = "model" | "locale" | "plugins" | "gateway.trigger" | "gateway.allowedUsers";

/** Top-level Hermes config field name -> Hades dotted path, declared as data. Identity entries score confidence 1. */
const CONFIG_FIELD_ALIASES: Readonly<
  Record<string, { path: AllowedConfigPath; confidence: number; note?: string }>
> = Object.freeze({
  model: { path: "model", confidence: 1 },
  defaultModel: { path: "model", confidence: 0.6, note: 'heuristically mapped from Hermes field "defaultModel"' },
  locale: { path: "locale", confidence: 1 },
  language: { path: "locale", confidence: 0.6, note: 'heuristically mapped from Hermes field "language"' },
  plugins: { path: "plugins", confidence: 1 },
  extensions: { path: "plugins", confidence: 0.6, note: 'heuristically mapped from Hermes field "extensions"' },
  triggerWord: { path: "gateway.trigger", confidence: 0.6, note: 'heuristically mapped from Hermes field "triggerWord"' },
  authorizedUsers: {
    path: "gateway.allowedUsers",
    confidence: 0.6,
    note: 'heuristically mapped from Hermes field "authorizedUsers"',
  },
});

interface ConfigExtraction {
  items: MigrationItem[];
  vaultEntries: SecretVaultEntry[];
  modelCandidate?: { value: string; originPath: string };
}

function extractConfigAndSecrets(parsed: Record<string, unknown>, originPath: string): ConfigExtraction {
  const items: MigrationItem[] = [];
  const vaultEntries: SecretVaultEntry[] = [];
  const secretishTopKeys = new Set<string>();

  // Pass 1: identify + vault secret-looking fields (by name OR by value shape), top-level and one level into "gateway".
  const scanObject = (obj: Record<string, unknown>, keyPrefix: string, markSecretish: (k: string) => void) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "string" || value.length === 0) continue;
      if (SECRET_KEY_NAME_RE.test(key) || looksLikeKeyMaterial(value)) {
        markSecretish(key);
        const envVar = sanitizeEnvVarName(`${keyPrefix}${key}`);
        vaultEntries.push({
          envVar,
          present: true,
          redactedPreview: redactPreview(value),
          value,
          origin: { path: originPath, locator: `${keyPrefix}${key}` },
        });
      }
    }
  };
  scanObject(parsed, "", (k) => secretishTopKeys.add(k));
  const gatewayObj =
    parsed.gateway && typeof parsed.gateway === "object" && !Array.isArray(parsed.gateway)
      ? (parsed.gateway as Record<string, unknown>)
      : undefined;
  const gatewaySecretish = new Set<string>();
  if (gatewayObj) scanObject(gatewayObj, "gateway.", (k) => gatewaySecretish.add(k));

  const pushConfig = (path: AllowedConfigPath, value: JsonValue, confidence: number, note?: string) => {
    items.push(
      makeItem({
        kind: "config",
        key: `config:${path}`,
        value,
        origin: { path: originPath, locator: path },
        confidence,
        notes: note ? [note] : undefined,
      }),
    );
  };

  let modelCandidate: { value: string; originPath: string } | undefined;

  for (const [key, alias] of Object.entries(CONFIG_FIELD_ALIASES)) {
    if (secretishTopKeys.has(key)) continue;
    if (!(key in parsed)) continue;
    const raw = parsed[key];
    if (alias.path === "plugins") {
      if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
        pushConfig(alias.path, raw as JsonValue, alias.confidence, alias.note);
      }
      continue;
    }
    if (alias.path === "gateway.allowedUsers") {
      if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
        pushConfig(alias.path, raw as JsonValue, alias.confidence, alias.note);
      }
      continue;
    }
    if (typeof raw === "string" && raw.length > 0) {
      pushConfig(alias.path, raw, alias.confidence, alias.note);
      if (alias.path === "model") modelCandidate = { value: raw, originPath };
    }
  }

  if (gatewayObj) {
    if (!gatewaySecretish.has("trigger") && typeof gatewayObj.trigger === "string" && gatewayObj.trigger.length > 0) {
      pushConfig("gateway.trigger", gatewayObj.trigger, 1);
    }
    if (
      !gatewaySecretish.has("allowedUsers") &&
      Array.isArray(gatewayObj.allowedUsers) &&
      gatewayObj.allowedUsers.every((u) => typeof u === "string")
    ) {
      pushConfig("gateway.allowedUsers", gatewayObj.allowedUsers as JsonValue, 1);
    }
  }

  return { items, vaultEntries, modelCandidate };
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

interface DotenvLine {
  key: string;
  value: string;
}

export function parseDotenv(content: string): DotenvLine[] {
  const out: DotenvLine[] = [];
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    out.push({ key, value });
  }
  return out;
}

export function readDotenvFile(text: string, originPath: string): { items: MigrationItem[]; vaultEntries: SecretVaultEntry[] } {
  const items: MigrationItem[] = [];
  const vaultEntries: SecretVaultEntry[] = [];
  for (const { key, value } of parseDotenv(text)) {
    const envVar = sanitizeEnvVarName(key);
    const descriptor: JsonValue = {
      envVar,
      present: value.length > 0,
      ...(value.length > 0 ? { redactedPreview: redactPreview(value) } : {}),
    };
    items.push(
      makeItem({
        kind: "secret",
        key: `secret:${envVar}`,
        value: descriptor,
        origin: { path: originPath, locator: key },
        confidence: 1,
      }),
    );
    if (value.length > 0) {
      vaultEntries.push({
        envVar,
        present: true,
        redactedPreview: redactPreview(value),
        value,
        origin: { path: originPath, locator: key },
      });
    }
  }
  return { items, vaultEntries };
}

// ---------------------------------------------------------------------------
// model.json
// ---------------------------------------------------------------------------

export function findStringField(o: Record<string, unknown>, keys: string[]): { key: string; value: string } | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return { key: k, value: v };
  }
  return undefined;
}

function readModelJson(text: string, originPath: string): { item?: MigrationItem; unimportable?: UnimportableEntry } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { unimportable: { path: originPath, kind: "model", reason: `model.json is not valid JSON: ${(e as Error).message}` } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { unimportable: { path: originPath, kind: "model", reason: "model.json is not a JSON object" } };
  }
  const o = parsed as Record<string, unknown>;
  const modelField = findStringField(o, ["modelId", "id", "model", "name"]);
  if (!modelField) {
    return {
      unimportable: {
        path: originPath,
        kind: "model",
        reason: 'model.json has no recognizable model-id field ("modelId"/"id"/"model"/"name")',
      },
    };
  }
  const providerField = findStringField(o, ["provider", "vendor"]);
  const evidence: string[] = [`modelId read from "${modelField.key}" in ${originPath}`];
  if (providerField) evidence.push(`provider read from "${providerField.key}" in ${originPath}`);
  const value: JsonValue = {
    modelId: modelField.value,
    ...(providerField ? { provider: providerField.value } : {}),
    evidence,
  };
  const confidence = modelField.key === "modelId" ? 1 : 0.8;
  return {
    item: makeItem({
      kind: "model",
      key: "model:selection",
      value,
      origin: { path: originPath },
      confidence,
    }),
  };
}

// ---------------------------------------------------------------------------
// memory/MEMORY.md + memory/USER.md (and, reused by openclaw, memory/*.md)
// ---------------------------------------------------------------------------

const FACTS_BULLET_RE = /^-\s*(?:\[([^\]]+)\]\s*)?(.+?)(?:\s*\(source:\s*(.+)\))?$/;

export function readMarkdownContextFile(
  raw: string,
  relPath: string,
  originPath: string,
  now: () => number,
): { items: MigrationItem[]; unimportable: UnimportableEntry[] } {
  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];

  // Verbatim capture -- always emitted, confidence 1, content round-trips untouched (it is pure data, never
  // interpreted as a path/command/prompt directive downstream).
  items.push(
    makeItem({
      kind: "context-file",
      key: `context:${relPath}`,
      value: { relPath, content: raw },
      origin: { path: originPath },
      confidence: 1,
    }),
  );

  const sections = parseMarkdownSections(raw);
  const factsSection = sections.find((s) => s.level === 2 && s.heading === "Facts");
  if (!factsSection) return { items, unimportable };

  const lines = factsSection.body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = FACTS_BULLET_RE.exec(trimmed);
    if (!m) {
      unimportable.push({
        path: originPath,
        kind: "memory",
        reason: `MEMORY.md Facts bullet did not match the expected "- [timestamp] fact (source: ...)" shape: ${JSON.stringify(trimmed)}`,
      });
      continue;
    }
    const [, tsRaw, factRaw, source] = m;
    const notes: string[] = [];
    let createdAt: number;
    let confidence = 1;
    if (tsRaw) {
      const ts = parseTimestampFlexible(tsRaw, now);
      createdAt = ts.ms;
      if (ts.note) {
        confidence = 0.5;
        notes.push(ts.note);
      }
    } else {
      createdAt = now();
      confidence = 0.5;
      notes.push("MEMORY.md bullet had no [timestamp] prefix; substituted current time (now())");
    }
    const fact = factRaw.trim();
    if (fact.length === 0) {
      unimportable.push({
        path: originPath,
        kind: "memory",
        reason: `MEMORY.md Facts bullet had no fact text: ${JSON.stringify(trimmed)}`,
      });
      continue;
    }
    items.push(
      makeMemoryItem(fact, {
        source,
        createdAt,
        originPath,
        locator: "Facts",
        confidence,
        notes,
      }),
    );
  }

  return { items, unimportable };
}

// ---------------------------------------------------------------------------
// memory.json / memory.jsonl
// ---------------------------------------------------------------------------

export function memoryRecordFromUnknown(
  entry: unknown,
  locator: string,
  now: () => number,
): { ok: true; item: MigrationItem } | { ok: false; reason: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "entry is not a JSON object" };
  }
  const o = entry as Record<string, unknown>;
  const factRaw = o.fact ?? o.content ?? o.text;
  if (typeof factRaw !== "string" || factRaw.trim().length === 0) {
    return { ok: false, reason: 'entry has no usable "fact"/"content"/"text" string field' };
  }
  const fact = factRaw.trim();
  const notes: string[] = [];
  let confidence = 1;

  let salience: number | undefined;
  if (typeof o.salience === "number") salience = o.salience;
  else if (typeof o.salience !== "undefined") {
    confidence = Math.min(confidence, 0.6);
    notes.push(`"salience" was not a number (${JSON.stringify(o.salience)}); defaulted to 0.5`);
  }

  let tags: string[] = [];
  if (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")) tags = o.tags as string[];
  else if (typeof o.tags !== "undefined") {
    confidence = Math.min(confidence, 0.6);
    notes.push('"tags" was not a string array; defaulted to []');
  }

  const source = typeof o.source === "string" ? o.source : undefined;

  const tsRaw = o.createdAt ?? o.created_at ?? o.timestamp ?? o.at;
  const ts = parseTimestampFlexible(tsRaw, now);
  if (ts.note) {
    confidence = Math.min(confidence, 0.5);
    notes.push(ts.note);
  }

  const item = makeMemoryItem(fact, {
    salience,
    tags,
    source,
    createdAt: ts.ms,
    originPath: locator,
    confidence,
    notes,
  });
  return { ok: true, item };
}

export function readMemoryJsonArray(
  text: string,
  originPath: string,
  now: () => number,
): { items: MigrationItem[]; unimportable: UnimportableEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { items: [], unimportable: [{ path: originPath, kind: "memory", reason: `not valid JSON: ${(e as Error).message}` }] };
  }
  const arr: unknown[] | undefined = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).memories)
      ? ((parsed as Record<string, unknown>).memories as unknown[])
      : undefined;
  if (!arr) {
    return {
      items: [],
      unimportable: [{ path: originPath, kind: "memory", reason: 'JSON is not an array (and has no top-level "memories" array)' }],
    };
  }
  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];
  arr.forEach((entry, idx) => {
    const locator = `${originPath}#[${idx}]`;
    const r = memoryRecordFromUnknown(entry, locator, now);
    if (!r.ok) {
      unimportable.push({ path: locator, kind: "memory", reason: r.reason });
      return;
    }
    items.push(r.item);
  });
  return { items, unimportable };
}

export function readMemoryJsonl(
  text: string,
  originPath: string,
  now: () => number,
): { items: MigrationItem[]; unimportable: UnimportableEntry[] } {
  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    const locator = `${originPath}:L${idx + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      unimportable.push({ path: locator, kind: "memory", reason: `invalid JSON on line ${idx + 1}: ${(e as Error).message}` });
      return;
    }
    const r = memoryRecordFromUnknown(parsed, locator, now);
    if (!r.ok) {
      unimportable.push({ path: locator, kind: "memory", reason: r.reason });
      return;
    }
    items.push(r.item);
  });
  return { items, unimportable };
}

// ---------------------------------------------------------------------------
// skills/*/SKILL.md, skills/*.md
// ---------------------------------------------------------------------------

export function sanitizeSkillKeyName(rawName: string): { keyName: string; sanitized: boolean } {
  let hadTraversal = /\.\./.test(rawName) || rawName.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawName) || rawName.includes("\0");
  let s = rawName.replace(/\0/g, "").replace(/[\\/]/g, "_").replace(/\.\./g, "_");
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  const keyName = cleaned.length > 0 ? cleaned : "skill";
  if (keyName !== rawName) hadTraversal = true;
  return { keyName, sanitized: hadTraversal };
}

export function readSkillFile(
  raw: string,
  relPath: string,
  originPath: string,
  usedNames: Set<string>,
): { item?: MigrationItem; unimportable?: UnimportableEntry } {
  let parseResult: { manifest: SkillManifest; warnings: string[] };
  try {
    parseResult = parseSkillFile(raw);
  } catch (e) {
    return { unimportable: { path: originPath, kind: "skill", reason: `SKILL.md parse failed: ${(e as Error).message}` } };
  }
  const validation = validateSkillManifest(parseResult.manifest);
  if (!validation.valid) {
    return {
      unimportable: {
        path: originPath,
        kind: "skill",
        reason: `SKILL.md failed validation: ${validation.errors.join("; ")}`,
      },
    };
  }
  const manifest = parseResult.manifest;
  const notes: string[] = [...parseResult.warnings];
  const { keyName, sanitized } = sanitizeSkillKeyName(manifest.name);
  if (sanitized) {
    notes.push(
      `skill name ${JSON.stringify(manifest.name)} was sanitized to ${JSON.stringify(keyName)} for the item key to avoid a path-traversal or invalid-character key`,
    );
  }
  if (usedNames.has(keyName)) {
    return {
      unimportable: {
        path: originPath,
        kind: "skill",
        reason: `duplicate skill name "${keyName}" (from manifest name ${JSON.stringify(manifest.name)}); a skill with this key was already imported from another path`,
      },
    };
  }
  usedNames.add(keyName);

  const bodySha256 = sha256HexOf(manifest.instructions);
  const value: JsonValue = {
    name: manifest.name,
    description: manifest.description,
    capabilities: manifest.capabilities,
    tools: manifest.tools,
    ...(manifest.whenToUse !== undefined ? { whenToUse: manifest.whenToUse } : {}),
    ...(manifest.model !== undefined ? { model: manifest.model } : {}),
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    instructions: manifest.instructions,
    sourcePath: relPath,
    bodySha256,
  };
  return {
    item: makeItem({
      kind: "skill",
      key: `skill:${keyName}`,
      value,
      origin: { path: originPath },
      confidence: sanitized || notes.length > 0 ? 0.8 : 1,
      notes: notes.length > 0 ? notes : undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// sessions/*.jsonl
// ---------------------------------------------------------------------------

export interface ParsedSessionMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: number;
}

export function readSessionJsonl(
  text: string,
  relFile: string,
  originPath: string,
  now: () => number,
): { item?: MigrationItem; unimportable: UnimportableEntry[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const messages: ParsedSessionMessage[] = [];
  const unimportable: UnimportableEntry[] = [];
  const notes: string[] = [];
  let meta: { id?: string; title?: string; summary?: string; tags?: string[] } = {};
  let nonEmptyLines = 0;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    nonEmptyLines++;
    const locator = `${originPath}:L${idx + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      unimportable.push({ path: locator, kind: "session", reason: `invalid JSON on line ${idx + 1}: ${(e as Error).message}` });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      unimportable.push({ path: locator, kind: "session", reason: `line ${idx + 1} is not a JSON object` });
      return;
    }
    const o = parsed as Record<string, unknown>;
    if (o.type === "session-meta") {
      if (typeof o.id === "string") meta.id = o.id;
      if (typeof o.title === "string") meta.title = o.title;
      if (typeof o.summary === "string") meta.summary = o.summary;
      if (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string")) meta.tags = o.tags as string[];
      return;
    }
    const role = o.role;
    const content = o.content;
    if ((role === "user" || role === "assistant" || role === "system") && typeof content === "string") {
      const ts = parseTimestampFlexible(o.at ?? o.timestamp ?? o.ts, now);
      if (ts.note) notes.push(`line ${idx + 1}: ${ts.note}`);
      messages.push({ role, content, at: ts.ms });
      return;
    }
    unimportable.push({
      path: locator,
      kind: "session",
      reason: `line ${idx + 1} is not a recognizable session message (expected {role, content, at?}): ${trimmed.slice(0, 160)}`,
    });
  });

  if (nonEmptyLines === 0) {
    return { unimportable: [{ path: originPath, kind: "session", reason: "session file is empty" }] };
  }
  if (messages.length === 0) {
    unimportable.push({ path: originPath, kind: "session", reason: "no valid messages could be parsed from this session file" });
    return { unimportable };
  }

  const id = meta.id ?? relFile.replace(/\.jsonl?$/i, "").split("/").pop() ?? "unknown";
  const startedAt = Math.min(...messages.map((m) => m.at));
  const endedAt = Math.max(...messages.map((m) => m.at));
  const value: JsonValue = {
    id,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    messages: messages as unknown as JsonValue,
    ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
    tags: meta.tags ?? [],
    startedAt,
    endedAt,
  };
  const item = makeItem({
    kind: "session",
    key: `session:${sanitizeSessionId(id)}`,
    value,
    origin: { path: originPath },
    confidence: unimportable.length === 0 ? 1 : 0.7,
    notes: notes.length > 0 ? notes : undefined,
  });
  return { item, unimportable };
}

// ---------------------------------------------------------------------------
// SQLite (hermes.db / sessions.db / memory.db)
// ---------------------------------------------------------------------------

interface MessagesTableMatch {
  table: string;
  cols: { sessionId: string; role: string; content: string; at?: string };
}
interface SessionsTableMatch {
  table: string;
  cols: { id: string; title?: string; summary?: string; tags?: string; startedAt?: string; endedAt?: string };
}
interface MemoryTableMatch {
  table: string;
  cols: { fact: string; salience?: string; tags?: string; source?: string; createdAt?: string };
}

function findCol(names: string[], cols: SqliteColumn[], candidates: string[]): string | undefined {
  for (const cand of candidates) {
    const idx = names.indexOf(cand);
    if (idx !== -1) return cols[idx].name;
  }
  return undefined;
}

/** Discovers session/message/memory tables from `sqlite_master`-derived schema, purely by column-name heuristics. Never a hardcoded schema. */
export function classifySqliteTables(
  reader: SqliteReader,
  tables: string[],
): { sessionsTable?: SessionsTableMatch; messagesTable?: MessagesTableMatch; memoryTable?: MemoryTableMatch } {
  let sessionsTable: SessionsTableMatch | undefined;
  let messagesTable: MessagesTableMatch | undefined;
  let memoryTable: MemoryTableMatch | undefined;

  for (const t of tables) {
    if (t.startsWith("sqlite_")) continue;
    let cols: SqliteColumn[];
    try {
      cols = reader.columns(t);
    } catch {
      continue;
    }
    const names = cols.map((c) => c.name.toLowerCase());

    const contentCol = findCol(names, cols, ["content", "text", "message", "body"]);
    const roleCol = findCol(names, cols, ["role", "sender", "speaker"]);
    const sessionIdCol = findCol(names, cols, ["session_id", "sessionid", "conversation_id", "chat_id"]);
    if (!messagesTable && contentCol && roleCol && sessionIdCol) {
      messagesTable = {
        table: t,
        cols: { sessionId: sessionIdCol, role: roleCol, content: contentCol, at: findCol(names, cols, ["at", "timestamp", "created_at", "ts", "time"]) },
      };
      continue;
    }

    const factCol = findCol(names, cols, ["fact", "content", "text", "memory", "note"]);
    const salienceCol = findCol(names, cols, ["salience", "importance", "weight", "score"]);
    if (!memoryTable && factCol && (names.includes("fact") || salienceCol)) {
      memoryTable = {
        table: t,
        cols: {
          fact: factCol,
          salience: salienceCol,
          tags: findCol(names, cols, ["tags", "tag"]),
          source: findCol(names, cols, ["source", "origin"]),
          createdAt: findCol(names, cols, ["created_at", "createdat", "ts", "timestamp", "at"]),
        },
      };
      continue;
    }

    const idCol = findCol(names, cols, ["id", "session_id", "uuid"]);
    const startedCol = findCol(names, cols, ["started_at", "startedat", "created_at", "createdat"]);
    if (!sessionsTable && idCol && startedCol && (names.includes("title") || names.includes("summary") || t.toLowerCase().includes("session"))) {
      sessionsTable = {
        table: t,
        cols: {
          id: idCol,
          title: findCol(names, cols, ["title", "name"]),
          summary: findCol(names, cols, ["summary"]),
          tags: findCol(names, cols, ["tags"]),
          startedAt: startedCol,
          endedAt: findCol(names, cols, ["ended_at", "endedat", "finished_at"]),
        },
      };
    }
  }

  return { sessionsTable, messagesTable, memoryTable };
}

export async function readSqliteDb(
  deps: SourceReadDeps,
  absPath: string,
  relPath: string,
  now: () => number,
  maxItems: number,
): Promise<{ items: MigrationItem[]; unimportable: UnimportableEntry[] }> {
  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];

  const opened = await deps.openSqlite(absPath, { maxBytes: 256 * 1024 * 1024 });
  if (!opened.ok) {
    unimportable.push({ path: relPath, kind: "unknown", reason: `could not open SQLite database: [${opened.failure.code}] ${opened.failure.message}` });
    return { items, unimportable };
  }
  const reader = opened.reader;
  try {
    const tables = reader.tables();
    const { sessionsTable, messagesTable, memoryTable } = classifySqliteTables(reader, tables);

    if (!sessionsTable && !messagesTable && !memoryTable) {
      const schemaDump = tables
        .filter((t) => !t.startsWith("sqlite_"))
        .map((t) => {
          try {
            return `${t}(${reader.columns(t).map((c) => c.name).join(",")})`;
          } catch {
            return `${t}(?)`;
          }
        })
        .join("; ");
      unimportable.push({
        path: relPath,
        kind: "unknown",
        reason: `unrecognized SQLite schema: no session/message/memory table could be identified from tables seen: [${schemaDump || "none"}]`,
      });
      return { items, unimportable };
    }

    if (memoryTable) {
      const { table, cols } = memoryTable;
      let n = 0;
      try {
        for (const row of reader.scan(table, { maxRows: maxItems })) {
          n++;
          const factRaw = row[cols.fact];
          if (typeof factRaw !== "string" || factRaw.trim().length === 0) {
            unimportable.push({ path: `${relPath}#${table}[${n}]`, kind: "memory", reason: "row has no usable fact text" });
            continue;
          }
          const salienceCell = cols.salience ? row[cols.salience] : undefined;
          const salience = typeof salienceCell === "number" ? salienceCell : undefined;
          const tagsCell = cols.tags ? row[cols.tags] : undefined;
          const tags = typeof tagsCell === "string" ? splitTagsField(tagsCell) : [];
          const sourceCell = cols.source ? row[cols.source] : undefined;
          const source = typeof sourceCell === "string" ? sourceCell : undefined;
          const ts = parseTimestampFlexible(cols.createdAt ? row[cols.createdAt] : undefined, now);
          const notes: string[] = [`read from SQLite table "${table}" via column-name heuristics`];
          if (ts.note) notes.push(ts.note);
          items.push(
            makeMemoryItem(factRaw.trim(), {
              salience,
              tags,
              source,
              createdAt: ts.ms,
              originPath: relPath,
              locator: table,
              confidence: 0.7,
              notes,
            }),
          );
        }
      } catch (e) {
        unimportable.push({ path: `${relPath}#${table}`, kind: "memory", reason: `error scanning table "${table}": ${(e as Error).message}` });
      }
    }

    if (messagesTable) {
      const { table: msgTable, cols: msgCols } = messagesTable;
      const bySession = new Map<string, ParsedSessionMessage[]>();
      try {
        for (const row of reader.scan(msgTable, { maxRows: maxItems })) {
          const sid = String(row[msgCols.sessionId] ?? "default");
          const roleRaw = row[msgCols.role];
          const role: ParsedSessionMessage["role"] = roleRaw === "user" || roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";
          const content = typeof row[msgCols.content] === "string" ? (row[msgCols.content] as string) : "";
          const ts = parseTimestampFlexible(msgCols.at ? row[msgCols.at] : undefined, now);
          const arr = bySession.get(sid) ?? [];
          arr.push({ role, content, at: ts.ms });
          bySession.set(sid, arr);
        }
      } catch (e) {
        unimportable.push({ path: `${relPath}#${msgTable}`, kind: "session", reason: `error scanning table "${msgTable}": ${(e as Error).message}` });
      }

      const sessionMeta = new Map<string, { title?: string; summary?: string; tags?: string[]; startedAt?: number; endedAt?: number }>();
      if (sessionsTable) {
        const { table: sTable, cols: sCols } = sessionsTable;
        try {
          for (const row of reader.scan(sTable, { maxRows: maxItems })) {
            const idCell = row[sCols.id];
            const id = idCell === null || idCell === undefined ? "" : String(idCell);
            if (!id) continue;
            const m: { title?: string; summary?: string; tags?: string[]; startedAt?: number; endedAt?: number } = {};
            if (sCols.title && typeof row[sCols.title] === "string") m.title = row[sCols.title] as string;
            if (sCols.summary && typeof row[sCols.summary] === "string") m.summary = row[sCols.summary] as string;
            if (sCols.tags && typeof row[sCols.tags] === "string") m.tags = splitTagsField(row[sCols.tags] as string);
            if (sCols.startedAt) m.startedAt = parseTimestampFlexible(row[sCols.startedAt], now).ms;
            if (sCols.endedAt && row[sCols.endedAt] !== null && row[sCols.endedAt] !== undefined) {
              m.endedAt = parseTimestampFlexible(row[sCols.endedAt], now).ms;
            }
            sessionMeta.set(id, m);
          }
        } catch (e) {
          unimportable.push({ path: `${relPath}#${sTable}`, kind: "session", reason: `error scanning table "${sTable}": ${(e as Error).message}` });
        }
      }

      for (const [sid, msgs] of bySession) {
        if (msgs.length === 0) continue;
        const meta = sessionMeta.get(sid) ?? {};
        const startedAt = meta.startedAt ?? Math.min(...msgs.map((m) => m.at));
        const endedAt = meta.endedAt ?? Math.max(...msgs.map((m) => m.at));
        const value: JsonValue = {
          id: sid,
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          messages: msgs as unknown as JsonValue,
          ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
          tags: meta.tags ?? [],
          startedAt,
          endedAt,
        };
        items.push(
          makeItem({
            kind: "session",
            key: `session:${sanitizeSessionId(sid)}`,
            value,
            origin: { path: relPath, locator: msgTable },
            confidence: 0.7,
            notes: [
              `read from SQLite table "${msgTable}"${sessionsTable ? ` joined with "${sessionsTable.table}"` : ""} via column-name heuristics`,
            ],
          }),
        );
      }
    }
  } catch (e) {
    unimportable.push({ path: relPath, kind: "unknown", reason: `error reading SQLite database: ${(e as Error).message}` });
  } finally {
    try {
      reader.close();
    } catch {
      /* already closed */
    }
  }

  return { items, unimportable };
}

// ---------------------------------------------------------------------------
// readHermesSource
// ---------------------------------------------------------------------------

export async function readHermesSource(
  source: DiscoveredSource,
  deps: SourceReadDeps,
): Promise<{ bundle: MigrationBundle; secrets: SecretVault }> {
  const now = deps.now;
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS;

  const items: MigrationItem[] = [];
  const unimportable: UnimportableEntry[] = [];
  const readErrors: ReadErrorEntry[] = [];
  const vaultEntries: SecretVaultEntry[] = [];
  let filesScanned = 0;
  let bytesRead = 0;
  let truncatedAny = false;

  const { files, warnings: walkWarnings } = walkSourceTree(deps.probe, source.root);
  for (const w of walkWarnings) readErrors.push({ path: source.root, reason: w });

  const usedSkillNames = new Set<string>();
  let modelJsonSeen = false;
  let modelCandidateFromConfig: { value: string; originPath: string } | undefined;
  let itemCapHit = false;

  ruleLoop: for (const rule of HERMES_ARTIFACTS) {
    const matches = files.filter((f) => ruleMatches(rule, f.relPath)).sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const f of matches) {
      if (items.length >= maxItems) {
        itemCapHit = true;
        break ruleLoop;
      }
      filesScanned++;
      const wasTruncated = f.bytes > maxFileBytes;
      if (wasTruncated) truncatedAny = true;

      if (rule.parser === "sqlite") {
        const before = items.length;
        const result = await readSqliteDb(deps, f.abs, f.relPath, now, maxItems - items.length);
        items.push(...result.items);
        unimportable.push(...result.unimportable);
        bytesRead += Math.min(f.bytes, 256 * 1024 * 1024);
        if (wasTruncated && items.length === before) {
          // sqlite reads its own bytes independent of maxFileBytes; nothing further to note.
        }
        continue;
      }

      const text = safeReadFile(deps.probe, f.abs, maxFileBytes);
      if (text === undefined) {
        readErrors.push({ path: f.relPath, reason: "could not be read (permission denied, unreadable encoding, or not a regular file)" });
        continue;
      }
      bytesRead += Math.min(f.bytes, maxFileBytes);
      const truncationNote = wasTruncated
        ? [`file is ${f.bytes} bytes, exceeding the ${maxFileBytes}-byte cap; content was truncated before parsing`]
        : [];

      switch (rule.parser) {
        case "hermes.config.json": {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            unimportable.push({
              path: f.relPath,
              kind: "config",
              reason: `not valid JSON${wasTruncated ? " (file was truncated at the read cap)" : ""}: ${(e as Error).message}`,
            });
            break;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            unimportable.push({ path: f.relPath, kind: "config", reason: "top-level JSON value is not an object" });
            break;
          }
          const extraction = extractConfigAndSecrets(parsed as Record<string, unknown>, f.relPath);
          items.push(...extraction.items);
          vaultEntries.push(...extraction.vaultEntries);
          if (extraction.modelCandidate) modelCandidateFromConfig = extraction.modelCandidate;
          break;
        }
        case "dotenv": {
          const result = readDotenvFile(text, f.relPath);
          items.push(...result.items);
          vaultEntries.push(...result.vaultEntries);
          break;
        }
        case "hermes.model.json": {
          const result = readModelJson(text, f.relPath);
          if (result.item) {
            items.push(result.item);
            modelJsonSeen = true;
          }
          if (result.unimportable) unimportable.push(result.unimportable);
          break;
        }
        case "hermes.memory.md":
        case "hermes.user.md": {
          const result = readMarkdownContextFile(text, f.relPath, f.relPath, now);
          if (wasTruncated) {
            for (const it of result.items) (it.notes ??= []).push(...truncationNote);
          }
          items.push(...result.items);
          unimportable.push(...result.unimportable);
          break;
        }
        case "hermes.memory.json": {
          const result = readMemoryJsonArray(text, f.relPath, now);
          items.push(...result.items);
          unimportable.push(...result.unimportable);
          break;
        }
        case "hermes.memory.jsonl": {
          const result = readMemoryJsonl(text, f.relPath, now);
          items.push(...result.items);
          unimportable.push(...result.unimportable);
          break;
        }
        case "skill-md": {
          const result = readSkillFile(text, f.relPath, f.relPath, usedSkillNames);
          if (result.item) items.push(result.item);
          if (result.unimportable) unimportable.push(result.unimportable);
          break;
        }
        case "hermes.session.jsonl": {
          const result = readSessionJsonl(text, f.relPath, f.relPath, now);
          if (result.item) items.push(result.item);
          unimportable.push(...result.unimportable);
          break;
        }
        default:
          unimportable.push({ path: f.relPath, kind: rule.kind, reason: `no parser implemented for parser id "${rule.parser}"` });
      }
    }
  }

  if (itemCapHit) {
    readErrors.push({ path: source.root, reason: `item cap of ${maxItems} reached; remaining matched artifacts were not processed` });
  }

  if (!modelJsonSeen && modelCandidateFromConfig) {
    items.push(
      makeItem({
        kind: "model",
        key: "model:selection",
        value: {
          modelId: modelCandidateFromConfig.value,
          evidence: [`modelId read from config.json's "model" field (no model.json present) at ${modelCandidateFromConfig.originPath}`],
        },
        origin: { path: modelCandidateFromConfig.originPath },
        confidence: 0.8,
        notes: ["derived from config.json; no dedicated model.json was found"],
      }),
    );
  }

  const bundle: MigrationBundle = {
    vendor: "hermes",
    layout: source.layout,
    root: source.root,
    version: source.version,
    items,
    unimportable,
    readErrors,
    stats: { filesScanned, bytesRead, truncated: truncatedAny },
  };
  const secrets: SecretVault = { vendor: "hermes", entries: vaultEntries };
  return { bundle, secrets };
}
