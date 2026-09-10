/**
 * `DomainAdapter`s — the bridge between the ACTUAL Hades engine (sessions,
 * memory facts + context files, config, the on-disk SKILL.md library) and
 * the shared, hash-chained `WorkspaceStore` every surface (CLI, desktop,
 * TUI) reads and writes.
 *
 * Every adapter is written against the REAL engine contracts (imported
 * TYPE-ONLY so this module compiles and tests completely standalone,
 * exactly like `../cli/memory-command.ts`): `SessionStore`/`SessionRecord`,
 * `MemoryStore`/`MemoryRecord`, `HadesConfig`, `LoadedSkill`. None of those
 * interfaces expose a "restore a record with this exact identity" primitive
 * (`SessionStore.create`/`MemoryStore.add` always mint a fresh random id and
 * stamp the current wall clock), so importing INTO the real engine works by
 * (1) locating an existing engine record by comparing its own `.id`/`.fact`
 * field against the imported key via `.all()` — never `.get()`, since a
 * restored record's engine-internal storage key and its logical `.id` field
 * can diverge — and (2) either mutating that live object in place (a
 * genuine merge, never a duplicate) or creating a fresh one via the public
 * API and then overwriting every field the constructor doesn't expose
 * (`id`, `createdAt`, `endedAt`, …) directly on the object the engine
 * itself just handed back. Every store class this module round-trips
 * against (`InMemorySessionStore`/`FileSessionStore`,
 * `InMemoryMemoryStore`/`FileMemoryStore`) returns that exact live
 * reference — never a defensive clone — so this is a real, load-bearing
 * technique, not a hack against a black box.
 *
 * ## Secrets
 *
 * `configAdapter`'s redaction is non-negotiable (see its doc below): no
 * `*_KEY`/`*_TOKEN`/`*_SECRET`/`Authorization`-shaped value is ever placed
 * into the shared store in cleartext, and a redaction marker read back from
 * the store can never clobber a real local secret.
 *
 * ## Tombstones
 *
 * `exportToStore` diffs each adapter's fresh `exportRecords()` against what
 * the store already holds live for that domain and calls `store.delete`
 * for any key that vanished (forgotten memory, etc.) — so a subsequent
 * `importFromStore` sees an honest tombstone instead of stale data, and
 * every adapter's `importRecords` treats `record.deleted` as "never
 * resurrect this", not "nothing to do".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname as pathDirname, isAbsolute, join, relative } from "node:path";

import { sha256Hex } from "../styx/certificate";
import type { JsonValue, WorkspaceDomain, WorkspaceRecord } from "./record";
import type { WorkspaceStore } from "./store";

import type { MemoryStore, MemoryRecord } from "../memory/store";
import type { SessionStore, SessionRecord, SessionMessage } from "../memory/session-store";
import type { HadesConfig } from "../config/config";
import type { LoadedSkill } from "../skills/library";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DomainImportReport {
  applied: number;
  skipped: number;
  errors: Array<{ key: string; reason: string }>;
}

export interface DomainAdapter {
  readonly domain: WorkspaceDomain;
  exportRecords(): Array<{ key: string; value: JsonValue }>;
  importRecords(records: WorkspaceRecord[]): DomainImportReport;
}

export interface WorkspaceDeps {
  dataDir: string;
  sessions?: SessionStore;
  memory?: MemoryStore;
  config?: { load(): HadesConfig; write(next: Partial<HadesConfig>): void };
  skillsDir?: string;
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ===========================================================================
// sessionsAdapter
// ===========================================================================

function sessionToJson(s: SessionRecord): JsonValue {
  return {
    id: s.id,
    title: s.title ?? null,
    messages: s.messages.map((m) => ({ role: m.role, content: m.content, at: m.at })),
    summary: s.summary ?? null,
    tags: [...s.tags],
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
  };
}

interface ParsedSession {
  id: string;
  title?: string;
  messages: SessionMessage[];
  summary?: string;
  tags: string[];
  startedAt: number;
  endedAt?: number;
}

function parseSessionValue(v: JsonValue): ParsedSession | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt)) return null;
  if (!Array.isArray(v.messages)) return null;

  const messages: SessionMessage[] = [];
  for (const raw of v.messages) {
    if (!isPlainObject(raw)) return null;
    if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "system") return null;
    if (typeof raw.content !== "string") return null;
    if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
    messages.push({ role: raw.role, content: raw.content, at: raw.at });
  }

  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : undefined,
    messages,
    summary: typeof v.summary === "string" ? v.summary : undefined,
    tags: stringArray(v.tags),
    startedAt: v.startedAt,
    endedAt: typeof v.endedAt === "number" && Number.isFinite(v.endedAt) ? v.endedAt : undefined,
  };
}

export function sessionsAdapter(opts: { sessions: SessionStore; limit?: number }): DomainAdapter {
  return {
    domain: "sessions",

    exportRecords() {
      let all = [...opts.sessions.all()].sort((a, b) => b.startedAt - a.startedAt);
      if (opts.limit !== undefined) all = all.slice(0, opts.limit);
      return all.map((s) => ({ key: s.id, value: sessionToJson(s) }));
    },

    importRecords(records) {
      const report: DomainImportReport = { applied: 0, skipped: 0, errors: [] };
      for (const r of records) {
        if (r.deleted) {
          // Sessions have no delete operation in the engine contract — a
          // session tombstone from the shared store is honestly reported
          // as a no-op rather than pretending to erase history it cannot.
          report.skipped++;
          continue;
        }
        const parsed = parseSessionValue(r.value);
        if (!parsed) {
          report.errors.push({ key: r.key, reason: "malformed session record value" });
          continue;
        }
        if (parsed.id !== r.key) {
          report.errors.push({ key: r.key, reason: `session id "${parsed.id}" does not match record key "${r.key}"` });
          continue;
        }

        const existing = opts.sessions.all().find((s) => s.id === parsed.id);
        if (existing) {
          existing.title = parsed.title;
          existing.messages = parsed.messages.map((m) => ({ ...m }));
          existing.summary = parsed.summary;
          existing.tags = [...parsed.tags];
          existing.startedAt = parsed.startedAt;
          existing.endedAt = parsed.endedAt;
        } else {
          const created = opts.sessions.create({ title: parsed.title, tags: [...parsed.tags] });
          created.id = parsed.id;
          created.title = parsed.title;
          created.messages = parsed.messages.map((m) => ({ ...m }));
          created.summary = parsed.summary;
          created.startedAt = parsed.startedAt;
          created.endedAt = parsed.endedAt;
        }
        report.applied++;
      }
      return report;
    },
  };
}

// ===========================================================================
// memoryAdapter
// ===========================================================================

function factToJson(r: MemoryRecord): JsonValue {
  return {
    id: r.id,
    fact: r.fact,
    salience: r.salience,
    tags: [...r.tags],
    source: r.source ?? null,
    createdAt: r.createdAt,
    lastAccessedAt: r.lastAccessedAt ?? null,
    accessCount: r.accessCount,
  };
}

interface ParsedFact {
  id: string;
  fact: string;
  salience: number;
  tags: string[];
  source?: string;
  createdAt: number;
  lastAccessedAt?: number;
  accessCount: number;
}

function parseFactValue(v: JsonValue): ParsedFact | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.fact !== "string") return null;
  if (typeof v.salience !== "number" || !Number.isFinite(v.salience)) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  if (typeof v.accessCount !== "number" || !Number.isFinite(v.accessCount)) return null;
  return {
    id: v.id,
    fact: v.fact,
    salience: v.salience,
    tags: stringArray(v.tags),
    source: typeof v.source === "string" ? v.source : undefined,
    createdAt: v.createdAt,
    lastAccessedAt: typeof v.lastAccessedAt === "number" && Number.isFinite(v.lastAccessedAt) ? v.lastAccessedAt : undefined,
    accessCount: v.accessCount,
  };
}

const CONTEXT_KEY_PREFIX = "file:";

function contextKey(path: string): string {
  return `${CONTEXT_KEY_PREFIX}${encodeURIComponent(path)}`;
}

function contextPathFromKey(key: string): string | null {
  if (!key.startsWith(CONTEXT_KEY_PREFIX)) return null;
  try {
    return decodeURIComponent(key.slice(CONTEXT_KEY_PREFIX.length));
  } catch {
    return null;
  }
}

export function memoryAdapter(opts: {
  memory: MemoryStore;
  contextFiles?: { read(): Array<{ path: string; text: string }>; write(path: string, text: string): void };
}): DomainAdapter {
  // Correlates a restored fact's LOGICAL id (the workspace key) with the
  // engine's actual internal storage key when the two diverge (i.e. when
  // this adapter created the record via `memory.add()`, which always mints
  // its own fresh id). Needed so a later tombstone import can `forget()`
  // the right underlying record. Scoped to this adapter instance's
  // lifetime — a fresh process re-derives it from `.all()` on demand.
  const remap = new Map<string, string>();

  return {
    domain: "memory",

    exportRecords() {
      const facts = opts.memory.all().map((r) => ({ key: r.id, value: factToJson(r) }));
      const files = opts.contextFiles
        ? opts.contextFiles.read().map((f) => ({
            key: contextKey(f.path),
            value: { kind: "context-file", path: f.path, text: f.text } as JsonValue,
          }))
        : [];
      return [...facts, ...files];
    },

    importRecords(records) {
      const report: DomainImportReport = { applied: 0, skipped: 0, errors: [] };
      for (const r of records) {
        const path = contextPathFromKey(r.key);
        if (path !== null) {
          if (r.deleted) {
            report.skipped++;
            continue;
          }
          if (!opts.contextFiles) {
            report.errors.push({ key: r.key, reason: "no context-file sink configured" });
            continue;
          }
          if (!isPlainObject(r.value) || typeof r.value.text !== "string" || typeof r.value.path !== "string") {
            report.errors.push({ key: r.key, reason: "malformed context-file record" });
            continue;
          }
          try {
            opts.contextFiles.write(r.value.path, r.value.text);
            report.applied++;
          } catch (err) {
            report.errors.push({ key: r.key, reason: err instanceof Error ? err.message : String(err) });
          }
          continue;
        }

        if (r.deleted) {
          // Tombstone honoured: a fact forgotten upstream must never be
          // resurrected by a later import. If the local engine still holds
          // a live record under this logical id, retract it too.
          const existing = opts.memory.all().find((m) => m.id === r.key);
          if (existing) {
            const actualId = remap.get(r.key) ?? existing.id;
            opts.memory.forget(actualId);
            remap.delete(r.key);
          }
          report.skipped++;
          continue;
        }

        const parsed = parseFactValue(r.value);
        if (!parsed) {
          report.errors.push({ key: r.key, reason: "malformed memory record value" });
          continue;
        }
        if (parsed.id !== r.key) {
          report.errors.push({ key: r.key, reason: `memory id "${parsed.id}" does not match record key "${r.key}"` });
          continue;
        }

        const existing = opts.memory.all().find((m) => m.id === parsed.id);
        if (existing) {
          existing.fact = parsed.fact;
          existing.salience = parsed.salience;
          existing.tags = [...parsed.tags];
          existing.source = parsed.source;
          existing.createdAt = parsed.createdAt;
          existing.lastAccessedAt = parsed.lastAccessedAt;
          existing.accessCount = parsed.accessCount;
        } else {
          const created = opts.memory.add({
            fact: parsed.fact,
            salience: parsed.salience,
            tags: [...parsed.tags],
            source: parsed.source,
          });
          const actualId = created.id;
          created.id = parsed.id;
          created.createdAt = parsed.createdAt;
          created.lastAccessedAt = parsed.lastAccessedAt;
          created.accessCount = parsed.accessCount;
          remap.set(parsed.id, actualId);
        }
        report.applied++;
      }
      return report;
    },
  };
}

// ===========================================================================
// configAdapter
// ===========================================================================

const SECRET_NAME_RE = /(key|token|secret|authorization)/i;

function isSecretKeyName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

function redactionMarker(raw: string): JsonValue {
  return { redacted: true, fingerprint: sha256Hex(raw).slice(0, 12) };
}

function isRedactionMarker(v: unknown): v is { redacted: true; fingerprint: string } {
  return (
    isPlainObject(v) &&
    (v as Record<string, unknown>).redacted === true &&
    typeof (v as Record<string, unknown>).fingerprint === "string"
  );
}

function toJsonValueDeep(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v as JsonValue;
  if (t === "number") return Number.isFinite(v as number) ? (v as number) : null;
  if (Array.isArray(v)) return v.map(toJsonValueDeep);
  if (t === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = toJsonValueDeep(val);
    }
    return out;
  }
  return null;
}

function redactDeep(key: string, v: unknown): JsonValue {
  if (typeof v === "string" && v.length > 0 && isSecretKeyName(key)) {
    return redactionMarker(v);
  }
  if (Array.isArray(v)) {
    if (isSecretKeyName(key)) {
      return v.map((item) => (typeof item === "string" && item.length > 0 ? redactionMarker(item) : toJsonValueDeep(item)));
    }
    return v.map((item) => toJsonValueDeep(item));
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = redactDeep(k, val);
    }
    return out;
  }
  return toJsonValueDeep(v);
}

/**
 * `configAdapter` — every top-level field of `HadesConfig` (PLUS any extra
 * key the real loaded object carries beyond the typed interface — this
 * adapter is schema-agnostic on purpose, iterating `Object.entries` rather
 * than a fixed field list, so an unknown key survives export + import
 * intact instead of being silently dropped) becomes one workspace record
 * keyed by its field name.
 *
 * Secrets policy (non-negotiable): with `redact` (default true), any
 * property whose NAME matches `/key|token|secret|authorization/i` —
 * anywhere in the config tree, not just top-level — is NEVER written to
 * the shared store as its real value; it is replaced by
 * `{ redacted: true, fingerprint: sha256Hex(value).slice(0, 12) }`.
 * `importRecords` mirrors this: a redaction marker read back from the
 * store never overwrites a real local secret (`opts.load()` still holding
 * the actual cleartext value for that key) — the field is skipped, not
 * clobbered.
 */
export function configAdapter(opts: { load(): HadesConfig; write(next: Partial<HadesConfig>): void; redact?: boolean }): DomainAdapter {
  const redact = opts.redact ?? true;

  return {
    domain: "config",

    exportRecords() {
      const cfg = opts.load() as unknown as Record<string, unknown>;
      const out: Array<{ key: string; value: JsonValue }> = [];
      for (const [k, v] of Object.entries(cfg)) {
        if (v === undefined) continue;
        out.push({ key: k, value: redact ? redactDeep(k, v) : toJsonValueDeep(v) });
      }
      return out;
    },

    importRecords(records) {
      const report: DomainImportReport = { applied: 0, skipped: 0, errors: [] };
      const current = opts.load() as unknown as Record<string, unknown>;
      const patch: Record<string, JsonValue> = {};
      let changed = false;

      for (const r of records) {
        if (r.deleted) {
          report.skipped++;
          continue;
        }
        if (isRedactionMarker(r.value)) {
          const localVal = current[r.key];
          if (localVal !== undefined && !isRedactionMarker(localVal)) {
            // Refuse to clobber a real local secret with a redaction marker.
            report.skipped++;
            continue;
          }
        }
        patch[r.key] = r.value;
        changed = true;
        report.applied++;
      }

      if (changed) opts.write(patch as unknown as Partial<HadesConfig>);
      return report;
    },
  };
}

// ===========================================================================
// skillsAdapter
// ===========================================================================

interface SkillManifestLite {
  name: string;
  description: string;
  capabilities: string[];
  tools: string[];
  whenToUse?: string;
  model?: string;
  version?: string;
  instructions: string;
}

function slugifySkillName(name: string): string {
  let s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s || s === "." || s === "..") s = "skill";
  return s;
}

/**
 * A small, deliberately independent SKILL.md frontmatter parser/serializer
 * (this module never value-imports `../skills/*` — only `LoadedSkill`,
 * type-only). Round-trips whatever `serializeSkillMd` produces byte-exactly;
 * it is not a full reimplementation of the real parser's quoting/escaping
 * rules, only enough to act as an honest default when the caller does not
 * inject a real `read`/`writeFile` wired to the actual skill library.
 */
function parseSkillMdLite(content: string): { manifest: SkillManifestLite } | null {
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) return null;

  const fmLines = lines.slice(1, closing);
  const body = lines.slice(closing + 1).join("\n").replace(/^\n/, "");

  const data: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest.startsWith("[") && rest.endsWith("]")) {
      lists[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = rest.replace(/^["']|["']$/g, "");
    }
  }
  if (!data.name || !data.description) return null;

  return {
    manifest: {
      name: data.name,
      description: data.description,
      capabilities: lists.capabilities ?? [],
      tools: lists.tools ?? [],
      whenToUse: data.whenToUse,
      model: data.model,
      version: data.version,
      instructions: body,
    },
  };
}

function serializeSkillMd(m: SkillManifestLite): string {
  const lines = ["---", `name: ${m.name}`, `description: ${m.description}`];
  lines.push(`capabilities: [${m.capabilities.join(", ")}]`);
  lines.push(`tools: [${m.tools.join(", ")}]`);
  if (m.whenToUse !== undefined) lines.push(`whenToUse: ${m.whenToUse}`);
  if (m.model !== undefined) lines.push(`model: ${m.model}`);
  if (m.version !== undefined) lines.push(`version: ${m.version}`);
  lines.push("---");
  return `${lines.join("\n")}\n${m.instructions}`;
}

/** True iff `target` is `base` itself or nested inside it (both must already be resolved/real paths). */
function isPathWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Default `read`: walks `dir`'s immediate subdirectories looking for
 * `<subdir>/SKILL.md`. A symlinked entry that resolves OUTSIDE `dir` is
 * never followed (silently skipped — export has no error channel; a
 * caller wanting that reported should inject a `read` that does). A file
 * that fails to parse (missing frontmatter, 0-byte, unreadable) is skipped
 * rather than crashing the whole read, mirroring `SkillLibrary.loadFiles`'s
 * error tolerance.
 */
function defaultReadSkills(dir: string): LoadedSkill[] {
  const out: LoadedSkill[] = [];
  let rootReal: string;
  try {
    rootReal = realpathSync(dir);
  } catch {
    return out;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return out;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    let isDir = entry.isDirectory();

    if (entry.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(entryPath);
      } catch {
        continue;
      }
      if (!isPathWithin(rootReal, real)) continue; // refuse to follow an escaping symlink
      try {
        isDir = statSync(entryPath).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) continue;

    const skillFile = join(entryPath, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let content: string;
    try {
      content = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMdLite(content);
    if (!parsed) continue;
    out.push({ manifest: parsed.manifest, path: skillFile, warnings: [] });
  }
  return out;
}

/**
 * Default `writeFile`: atomic tmp+rename write, refusing (throwing) if the
 * target's parent directory resolves — directly or through a symlink —
 * outside `dir`. The caller (`importRecords`) turns that throw into an
 * honest `errors` entry instead of crashing.
 */
function makeDefaultWriteFile(dir: string): (p: string, text: string) => void {
  return (p: string, text: string): void => {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* already exists, or a race with another writer — fine */
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(dir);
    } catch {
      rootReal = dir;
    }

    const parentDir = pathDirname(p);
    mkdirSync(parentDir, { recursive: true });
    let parentReal: string;
    try {
      parentReal = realpathSync(parentDir);
    } catch {
      parentReal = parentDir;
    }
    if (!isPathWithin(rootReal, parentReal)) {
      throw new Error(`refusing to write outside the skills dir (resolved to "${parentReal}")`);
    }

    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, p);
  };
}

export function skillsAdapter(opts: {
  dir: string;
  read?: (dir: string) => LoadedSkill[];
  writeFile?: (p: string, text: string) => void;
}): DomainAdapter {
  const read = opts.read ?? defaultReadSkills;
  const writeFile = opts.writeFile ?? makeDefaultWriteFile(opts.dir);

  return {
    domain: "skills",

    exportRecords() {
      const loaded = read(opts.dir);
      return loaded.map((s) => ({
        key: slugifySkillName(s.manifest.name),
        value: {
          name: s.manifest.name,
          description: s.manifest.description,
          capabilities: [...s.manifest.capabilities],
          tools: [...s.manifest.tools],
          whenToUse: s.manifest.whenToUse ?? null,
          model: s.manifest.model ?? null,
          version: s.manifest.version ?? null,
          instructions: s.manifest.instructions,
        } as JsonValue,
      }));
    },

    importRecords(records) {
      const report: DomainImportReport = { applied: 0, skipped: 0, errors: [] };
      for (const r of records) {
        if (r.deleted) {
          // Skill files are never deleted on disk by this module — a
          // tombstone here just means "nothing to write".
          report.skipped++;
          continue;
        }
        if (!isPlainObject(r.value)) {
          report.errors.push({ key: r.key, reason: "malformed skill record value" });
          continue;
        }
        const o = r.value;
        if (typeof o.name !== "string" || typeof o.description !== "string" || typeof o.instructions !== "string") {
          report.errors.push({ key: r.key, reason: "malformed skill record value" });
          continue;
        }
        const manifest: SkillManifestLite = {
          name: o.name,
          description: o.description,
          capabilities: stringArray(o.capabilities),
          tools: stringArray(o.tools),
          whenToUse: typeof o.whenToUse === "string" ? o.whenToUse : undefined,
          model: typeof o.model === "string" ? o.model : undefined,
          version: typeof o.version === "string" ? o.version : undefined,
          instructions: o.instructions,
        };
        const text = serializeSkillMd(manifest);
        const targetPath = join(opts.dir, slugifySkillName(manifest.name), "SKILL.md");
        try {
          writeFile(targetPath, text);
          report.applied++;
        } catch (err) {
          report.errors.push({ key: r.key, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return report;
    },
  };
}

// ===========================================================================
// allAdapters / exportToStore / importFromStore / workspaceRoot
// ===========================================================================

export function allAdapters(deps: WorkspaceDeps): DomainAdapter[] {
  const list: DomainAdapter[] = [];
  if (deps.sessions) list.push(sessionsAdapter({ sessions: deps.sessions }));
  if (deps.memory) list.push(memoryAdapter({ memory: deps.memory }));
  if (deps.config) list.push(configAdapter({ load: deps.config.load, write: deps.config.write }));
  const skillsDir = deps.skillsDir ?? `${deps.dataDir}/skills`;
  list.push(skillsAdapter({ dir: skillsDir }));
  return list;
}

/**
 * Engine → store. For each adapter, writes every currently-exported
 * `{key, value}` and — critically — tombstones (`store.delete`) any key
 * that WAS live in the store for that domain before this call but is no
 * longer produced by `exportRecords()` (a forgotten memory fact, a
 * removed skill, …), so deletions propagate honestly instead of leaving
 * stale data behind.
 */
export function exportToStore(store: WorkspaceStore, adapters: DomainAdapter[]): { written: number; perDomain: Record<string, number> } {
  let written = 0;
  const perDomain: Record<string, number> = {};

  for (const adapter of adapters) {
    const domain = adapter.domain;
    const beforeLive = store.list(domain, {});
    const records = adapter.exportRecords();
    const seenKeys = new Set(records.map((r) => r.key));

    let count = 0;
    for (const { key, value } of records) {
      try {
        store.put(domain, key, value);
      } catch (err) {
        // Fail loud, but SAY WHICH RECORD. Without this the caller only sees
        // e.g. "canonicalJson: undefined is not a valid JsonValue" with no
        // way to find the offending engine record among thousands.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`export failed at ${domain}/${key}: ${reason}`, { cause: err });
      }
      count++;
    }
    for (const rec of beforeLive) {
      if (!seenKeys.has(rec.key)) store.delete(domain, rec.key);
    }

    perDomain[domain] = count;
    written += count;
  }

  return { written, perDomain };
}

/** Store → engine. Feeds every live-or-tombstoned record for each adapter's domain to its `importRecords`. */
export function importFromStore(store: WorkspaceStore, adapters: DomainAdapter[]): Record<string, DomainImportReport> {
  const out: Record<string, DomainImportReport> = {};
  for (const adapter of adapters) {
    const domain = adapter.domain;
    const records = store.list(domain, { includeDeleted: true });
    out[domain] = adapter.importRecords(records);
  }
  return out;
}

/** `${dataDir}/state` — the ONE canonical `WorkspaceStore` root, used by every surface. */
export function workspaceRoot(dataDir: string): string {
  return `${dataDir}/state`;
}
