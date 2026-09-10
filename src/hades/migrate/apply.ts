/**
 * Transactional applier: turns a real, already-computed {@link MigrationPlan}
 * (from `./plan.ts`) into real writes against the REAL Hades engine —
 * memory (through the STYX write-guard when present), sessions, config,
 * model selection, the on-disk SKILL.md library, context files, and a 0600
 * secrets file — atomically, resumably, and reversibly.
 *
 * ## Where the actual VALUES come from
 *
 * `PlannedAction` (the locked shape `plan.ts` produces) deliberately carries
 * no content — only identifiers (`itemKey`, `itemHash`), a target descriptor,
 * and human-readable reasoning. This is intentional: `plan.ts` is a PURE
 * function of a `TargetProbe` and the already-read `MigrationBundle`s, and
 * never re-serializes the (potentially large) item payloads into the plan.
 * `applyMigrationPlan` therefore resolves the real {@link MigrationItem} (with
 * its `.value`) for a content-bearing action via `deps.fsOps.resolveItem`,
 * an injectable hook — the caller (the real CLI wiring in
 * `../cli/migrate-command.ts`) has already read every source bundle once (to
 * build the plan in the first place) and hands back a simple `itemHash ->
 * MigrationItem` lookup. The resolved item's `.hash` is re-verified against
 * `action.itemHash` before it is trusted — a source file that changed between
 * `plan` and `apply` fails that action honestly (integrity error) rather than
 * writing stale or mismatched content. `model` (value already inline as
 * `target.id`) and `secret` (material lives only in `deps.secrets`, the
 * leak-proof vault, never in a bundle) never need this hook at all.
 *
 * ## Transactionality
 *
 * Before ANY write touches a given file for the first time in this apply run,
 * its current bytes (or "did not exist") are captured. Every write goes
 * through `fsOps.writeFileAtomic` (temp file + rename). A hash-chained JSONL
 * receipt line is appended after every attempted write (success or — via the
 * thrown-error path — never reached for a failed one; the failure itself is
 * reported without a receipt line, since nothing durable happened). On the
 * FIRST failure, every backed-up file (including the receipts file itself) is
 * restored to its pre-transaction bytes and `rolledBack: true` is reported;
 * no further actions in the plan are attempted. Re-running an interrupted (or
 * previously-successful) apply against the SAME receipt file skips any action
 * whose `(itemKey, itemHash)` already has an `ok:true` receipt — this is what
 * makes resume idempotent without a second write.
 *
 * ## A dry-run plan is never applied
 *
 * `plan.dryRun === true` means "this plan was computed as a PREVIEW"; every
 * renderer stamps it with a `[dry run] no changes will be applied` banner.
 * `applyMigrationPlan` therefore refuses such a plan outright (nothing is
 * written, nothing is locked, no receipt line is appended) rather than
 * silently contradicting the banner the user was just shown. A caller that
 * genuinely wants to write re-plans with `options.dryRun: false` — which is
 * exactly what `hades migrate apply --yes` does.
 *
 * A cross-process lock file (`<dataDir>/.migrate.lock`) is taken for the
 * duration of the transaction (stale-pid reclaim, bounded real-wall-clock
 * wait via `Atomics.wait` — the same technique `../state/store.ts` documents
 * for its own lock) so two concurrent `hades migrate apply` invocations
 * against the same data directory never interleave their writes.
 */

import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import * as nodeFs from "node:fs";

import { sha256Hex } from "../styx/certificate";
import { canonicalJson } from "./ir";
import type { MigrationItem } from "./ir";
import type { JsonValue } from "../state/record";
import type { MigrationPlan, PlannedAction, PlannedActionKind, TargetProbe } from "./plan";
import type { ApplyOutcome } from "./report";
import type { MemoryRecord, MemoryStore } from "../memory/store";
import type { SessionStore } from "../memory/session-store";
import type { HadesConfig } from "../config/config";
import { SecretVault, parseEnvFile } from "./secrets";
import { parseSkillFile, serializeSkillFile } from "../skills/skill-file";
import type { SkillManifest } from "../skills/skill-file";

// ---------------------------------------------------------------------------
// Locked contract: ApplyDeps / ApplyResult / MigrationReceipt
// ---------------------------------------------------------------------------

export interface ApplyDeps {
  dataDir: string;
  memory: MemoryStore;
  guard?: {
    addChecked(input: Parameters<MemoryStore["add"]>[0]): {
      record?: MemoryRecord;
      verdict: { passed: boolean; reason?: string };
      flagged?: { id: string };
    };
  };
  sessions: SessionStore;
  config: { load(): HadesConfig; write(next: Partial<HadesConfig>): void };
  modelSelection: { get(): string | undefined; set(id: string): void };
  skillsDir: string;
  contextFilesDir: string;
  secretsPath: string;
  secrets: SecretVault;
  now: () => number;
  fsOps?: ApplyFsOps;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  receiptPath: string;
  receiptHead: string;
  applied: number;
  failed: number;
  rolledBack: boolean;
  quarantined: number;
  secretsWritten: number;
  durationMs: number;
}

export interface MigrationReceipt {
  seq: number;
  at: number;
  itemKey: string;
  itemHash: string;
  action: PlannedActionKind;
  ok: boolean;
  target?: string;
  prevHash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// ApplyFsOps — the fs seam. Not part of any other module's locked contract;
// defined here so tests can inject fault behavior (a write that throws
// EACCES/ENOSPC, a lock that never acquires, ...) and so the real CLI wiring
// can inject `resolveItem`, the item-value lookup described above.
// ---------------------------------------------------------------------------

export interface ApplyLockHandle {
  release(): void;
}

export interface ApplyFsOps {
  readFileBuffer(path: string): Buffer | undefined;
  writeFileAtomic(path: string, data: Buffer, mode?: number): void;
  mkdirp(path: string): void;
  statMode(path: string): number | undefined;
  chmod(path: string, mode: number): void;
  removeFile(path: string): void;
  realpath(path: string): string;
  /** Acquire the cross-process apply lock, blocking (real wall-clock wait)
   *  up to `opts.timeoutMs`. Returns `undefined` if the lock could not be
   *  acquired in time (held by a live process) or at all (e.g. EACCES). */
  acquireLock(lockPath: string, opts: { timeoutMs: number }): ApplyLockHandle | undefined;
  /** Resolve the real `MigrationItem` (with its `.value`) an action refers
   *  to. Absent (or returning `undefined`) makes every content-bearing
   *  action fail honestly rather than fabricate content — `model` and
   *  `secret` actions never call this at all. */
  resolveItem?(action: PlannedAction): MigrationItem | undefined;
}

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real, `node:fs`-backed {@link ApplyFsOps}. Every write is tmp-file +
 *  `renameSync`; the lock uses an exclusive `wx` create with stale-pid
 *  reclaim and a bounded real-wall-clock poll (`Atomics.wait`), the same
 *  technique `../state/store.ts` documents for its own cross-process lock.
 *  `resolveItem` is absent by default — a caller that wants content-bearing
 *  actions to actually work must inject one (see the module doc). */
export function defaultApplyFsOps(): ApplyFsOps {
  return {
    readFileBuffer(path) {
      try {
        return nodeFs.readFileSync(path);
      } catch {
        return undefined;
      }
    },
    writeFileAtomic(path, data, mode) {
      nodeFs.mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      nodeFs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
      nodeFs.renameSync(tmp, path);
      if (mode !== undefined) {
        try {
          nodeFs.chmodSync(path, mode);
        } catch {
          /* best effort — some filesystems (e.g. Windows) don't support POSIX modes */
        }
      }
    },
    mkdirp(path) {
      nodeFs.mkdirSync(path, { recursive: true });
    },
    statMode(path) {
      try {
        return nodeFs.statSync(path).mode & 0o777;
      } catch {
        return undefined;
      }
    },
    chmod(path, mode) {
      nodeFs.chmodSync(path, mode);
    },
    removeFile(path) {
      try {
        nodeFs.unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
    realpath(path) {
      try {
        return nodeFs.realpathSync(path);
      } catch {
        return resolvePath(path);
      }
    },
    acquireLock(lockPath, opts) {
      const deadline = Date.now() + opts.timeoutMs;
      for (;;) {
        try {
          nodeFs.mkdirSync(dirname(lockPath), { recursive: true });
        } catch {
          /* best effort */
        }
        try {
          const fd = nodeFs.openSync(lockPath, "wx");
          try {
            nodeFs.writeSync(fd, String(process.pid));
          } finally {
            nodeFs.closeSync(fd);
          }
          return {
            release() {
              try {
                nodeFs.unlinkSync(lockPath);
              } catch {
                /* already gone */
              }
            },
          };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") return undefined; // e.g. EACCES / read-only dir — locking is impossible here
          try {
            const pidRaw = nodeFs.readFileSync(lockPath, "utf8").trim();
            const pid = Number(pidRaw);
            if (Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
              try {
                nodeFs.unlinkSync(lockPath); // stale — reclaim
              } catch {
                /* raced with someone else reclaiming it; loop and retry */
              }
              continue;
            }
          } catch {
            /* unreadable lock file — fall through to waiting */
          }
          if (Date.now() >= deadline) return undefined;
          sleepSyncMs(Math.min(25, Math.max(1, deadline - Date.now())));
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWriteAction(a: PlannedActionKind): boolean {
  return a === "import" || a === "merge" || a === "overwrite" || a === "rename";
}

const RECEIPTS_FILENAME = "migrate-receipts.jsonl";
const LOCK_FILENAME = ".migrate.lock";
const GENESIS_RECEIPT_HASH = sha256Hex("hades.migrate.receipts.v1");
const DEFAULT_LOCK_TIMEOUT_MS = 1500;

export function receiptsPath(dataDir: string): string {
  return join(dataDir, RECEIPTS_FILENAME);
}

function receiptEntryHash(body: Omit<MigrationReceipt, "hash">): string {
  const canon: JsonValue = {
    seq: body.seq,
    at: body.at,
    itemKey: body.itemKey,
    itemHash: body.itemHash,
    action: body.action,
    ok: body.ok,
    target: body.target ?? null,
    prevHash: body.prevHash,
  };
  return sha256Hex(body.prevHash + canonicalJson(canon));
}

function isReceiptShape(v: unknown): v is MigrationReceipt {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.seq === "number" &&
    typeof r.at === "number" &&
    typeof r.itemKey === "string" &&
    typeof r.itemHash === "string" &&
    typeof r.action === "string" &&
    typeof r.ok === "boolean" &&
    (r.target === undefined || typeof r.target === "string") &&
    typeof r.prevHash === "string" &&
    typeof r.hash === "string"
  );
}

/**
 * Reads and verifies the hash chain of a migration receipt file. Never
 * throws: an absent file reads as an empty, valid chain; a malformed line or
 * a broken chain link is reported via `chainOk: false` / `brokenAt` (the
 * `seq` of the first bad entry) rather than raising. Every syntactically
 * parseable entry is still included in `entries` for forensics, even past
 * the break point.
 */
export function readReceipts(path: string): { entries: MigrationReceipt[]; chainOk: boolean; brokenAt?: number } {
  let raw: string;
  try {
    raw = nodeFs.readFileSync(path, "utf8");
  } catch {
    return { entries: [], chainOk: true };
  }

  const entries: MigrationReceipt[] = [];
  let prevHash = GENESIS_RECEIPT_HASH;
  let chainOk = true;
  let brokenAt: number | undefined;
  let lineNo = 0;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    lineNo++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (chainOk) {
        chainOk = false;
        brokenAt = lineNo;
      }
      continue;
    }
    if (!isReceiptShape(parsed)) {
      if (chainOk) {
        chainOk = false;
        brokenAt = lineNo;
      }
      continue;
    }
    entries.push(parsed);
    if (chainOk) {
      const expected = receiptEntryHash({
        seq: parsed.seq,
        at: parsed.at,
        itemKey: parsed.itemKey,
        itemHash: parsed.itemHash,
        action: parsed.action,
        ok: parsed.ok,
        target: parsed.target,
        prevHash: parsed.prevHash,
      });
      if (parsed.prevHash !== prevHash || parsed.hash !== expected) {
        chainOk = false;
        brokenAt = parsed.seq;
      } else {
        prevHash = parsed.hash;
      }
    }
  }

  return { entries, chainOk, brokenAt };
}

function appendReceipt(fsOps: ApplyFsOps, path: string, body: Omit<MigrationReceipt, "hash">): MigrationReceipt {
  const hash = receiptEntryHash(body);
  const rec: MigrationReceipt = { ...body, hash };
  const existing = fsOps.readFileBuffer(path);
  const existingText = existing ? existing.toString("utf8") : "";
  const sep = existingText.length > 0 && !existingText.endsWith("\n") ? "\n" : "";
  const newText = `${existingText}${sep}${JSON.stringify(rec)}\n`;
  fsOps.mkdirp(dirname(path));
  fsOps.writeFileAtomic(path, Buffer.from(newText, "utf8"));
  return rec;
}

// ---------------------------------------------------------------------------
// Path jailing (skills dir / context files dir)
// ---------------------------------------------------------------------------

/**
 * Resolves `rawName` against `baseDir`, refusing (throwing) anything that
 * would land outside `baseDir` once traversal/absolute segments are
 * collapsed — a NUL byte, an absolute path, or a `..` escape are all
 * rejected regardless of any upstream sanitization, and the check is done
 * against the REALPATH of `baseDir` (so a symlinked data directory can't be
 * used to disguise an escape either).
 */
function jailedChildPath(fsOps: ApplyFsOps, baseDir: string, rawName: string): string {
  if (rawName.length === 0) throw new Error("refusing to write: empty target name");
  if (rawName.includes("\0")) throw new Error(`refusing to write: target name contains a NUL byte (${JSON.stringify(rawName)})`);
  fsOps.mkdirp(baseDir);
  const baseReal = fsOps.realpath(baseDir);
  const candidate = resolvePath(baseReal, rawName);
  const rel = relative(baseReal, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write outside "${baseDir}": target name ${JSON.stringify(rawName)} would resolve to "${candidate}"`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// dotenv writing (secrets.env)
// ---------------------------------------------------------------------------

function dotenvQuote(v: string): string {
  let s = v.replace(/\\/g, "\\\\");
  s = s.replace(/"/g, '\\"');
  s = s.replace(/\n/g, "\\n");
  s = s.replace(/\r/g, "\\r");
  s = s.replace(/\t/g, "\\t");
  s = s.replace(/\$/g, "\\$");
  s = s.replace(/`/g, "\\`");
  return `"${s}"`;
}

/** Escapes every RegExp metacharacter so foreign text can only ever be matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeSecretEnvVar(fsOps: ApplyFsOps, secretsPath: string, envVar: string, material: string, allowOverwrite: boolean): void {
  // Env-var names reaching here come from vendor config/dotenv files on
  // disk (via `sanitizeEnvVarName`/`parseEnvFile`), i.e. foreign data. Even
  // though both producers currently emit `[A-Z0-9_]+`, the name is escaped
  // before it is interpolated into a RegExp so a hostile name can never
  // become a pattern (or throw a SyntaxError mid-transaction).
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
    throw new Error(`refusing to write secret: ${JSON.stringify(envVar)} is not a valid POSIX environment-variable name`);
  }
  const existingBuf = fsOps.readFileBuffer(secretsPath);
  const existingText = existingBuf ? existingBuf.toString("utf8") : "";
  const lines = existingText.length > 0 ? existingText.split(/\r?\n/).filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === "")) : [];
  const re = new RegExp(`^(export\\s+)?${escapeRegExp(envVar)}=`);
  const newLine = `${envVar}=${dotenvQuote(material)}`;
  let replaced = false;
  const outLines = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return allowOverwrite ? newLine : line;
    }
    return line;
  });
  if (!replaced) outLines.push(newLine);
  const finalText = `${outLines.join("\n")}\n`;
  fsOps.mkdirp(dirname(secretsPath));
  fsOps.writeFileAtomic(secretsPath, Buffer.from(finalText, "utf8"), 0o600);
}

// ---------------------------------------------------------------------------
// Conventional per-domain file paths (matching ../cli/build.ts's wiring)
// ---------------------------------------------------------------------------

function memoryFilePath(deps: ApplyDeps): string {
  const cfg = deps.config.load();
  return cfg.memoryPath && cfg.memoryPath.length > 0 ? cfg.memoryPath : join(deps.dataDir, "memory.json");
}
function memoryFlagsFilePath(deps: ApplyDeps): string {
  return join(deps.dataDir, "memory-flags.json");
}
function sessionsFilePath(deps: ApplyDeps): string {
  return join(deps.dataDir, "sessions.json");
}
function modelFilePath(deps: ApplyDeps): string {
  return join(deps.dataDir, "model.json");
}
function configFilePath(deps: ApplyDeps): string {
  return join(deps.dataDir, "config.json");
}

// ---------------------------------------------------------------------------
// Config: dotted-path nested patch builder
// ---------------------------------------------------------------------------

function setNested(current: unknown, path: string[], value: JsonValue): JsonValue {
  if (path.length === 0) return value;
  const base: Record<string, JsonValue> =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, JsonValue>) } : {};
  const [head, ...rest] = path;
  base[head] = setNested(base[head], rest, value);
  return base;
}

function buildConfigPatch(current: HadesConfig, dottedField: string, value: JsonValue): Partial<HadesConfig> {
  const segments = dottedField.split(".").filter((s) => s.length > 0);
  const top = segments[0];
  const currentTop = (current as unknown as Record<string, unknown>)[top];
  const patched = setNested(currentTop, segments.slice(1), value);
  return { [top]: patched } as unknown as Partial<HadesConfig>;
}

// ---------------------------------------------------------------------------
// performWrite — per-kind dispatch. Throws on hard failure (caught by the
// caller, which triggers rollback); returns a description of what happened
// on success (including the "guard quarantined this" outcome, which is a
// SUCCESSFUL, correct result, not a failure).
// ---------------------------------------------------------------------------

interface WriteOutcome {
  target?: string;
  detail: string;
  secretWritten?: boolean;
  quarantinedByGuard?: boolean;
}

function resolveItemOrThrow(fsOps: ApplyFsOps, action: PlannedAction): MigrationItem {
  const item = fsOps.resolveItem?.(action);
  if (!item) {
    throw new Error(
      `no source item resolver is configured (or it returned nothing) for "${action.itemKey}"; cannot recover the original content to write`,
    );
  }
  if (item.hash !== action.itemHash) {
    throw new Error(
      `integrity check failed for "${action.itemKey}": the resolved source item's hash no longer matches the plan (the source may have changed since the plan was computed)`,
    );
  }
  return item;
}

function performMemory(
  action: PlannedAction,
  deps: ApplyDeps,
  fsOps: ApplyFsOps,
  ensureBackup: (p: string) => void,
  memoryTargetRealId: Map<string, string>,
): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const v = item.value as { fact?: unknown; salience?: unknown; tags?: unknown; source?: unknown };
  if (typeof v.fact !== "string") throw new Error(`memory item "${action.itemKey}" has no usable fact text`);
  const salience = typeof v.salience === "number" ? v.salience : 0.5;
  const tags = Array.isArray(v.tags) ? (v.tags.filter((t) => typeof t === "string") as string[]) : [];
  const source = typeof v.source === "string" ? v.source : undefined;

  ensureBackup(memoryFilePath(deps));
  if (deps.guard) ensureBackup(memoryFlagsFilePath(deps));

  const writeOne = (input: { fact: string; salience: number; tags: string[]; source?: string }): { ok: boolean; realId?: string; note: string } => {
    if (deps.guard) {
      const res = deps.guard.addChecked(input);
      if (!res.verdict.passed) {
        const reasonText = res.verdict.reason ?? "a contradiction with an existing high-salience memory was detected";
        return { ok: false, note: `quarantined by the write-guard (not written): ${reasonText}${res.flagged ? ` [flag ${res.flagged.id}]` : ""}` };
      }
      return { ok: true, realId: res.record?.id, note: "" };
    }
    const rec = deps.memory.add(input);
    return { ok: true, realId: rec.id, note: "" };
  };

  if (action.action === "merge") {
    const key = action.target.id;
    let existing: MemoryRecord | undefined;
    if (key !== undefined) {
      const trackedId = memoryTargetRealId.get(key);
      if (trackedId !== undefined) existing = deps.memory.all().find((m) => m.id === trackedId);
      if (!existing) existing = deps.memory.all().find((m) => m.id === key);
    }
    if (existing) {
      const mergedSalience = Math.max(existing.salience, salience);
      const mergedTags = Array.from(new Set([...existing.tags, ...tags]));
      const mergedSource = existing.source ?? source;
      deps.memory.forget(existing.id);
      const result = writeOne({ fact: existing.fact, salience: mergedSalience, tags: mergedTags, source: mergedSource });
      if (!result.ok) return { target: "memory", detail: result.note, quarantinedByGuard: true };
      if (key !== undefined && result.realId) memoryTargetRealId.set(key, result.realId);
      return { target: `memory#${result.realId}`, detail: `merged into existing memory fact "${existing.id}" (salience=max, tags=union)` };
    }
    // Defensive fallback: the plan claimed a merge target that isn't (or is
    // no longer) present — import the candidate fresh rather than lose it.
  }

  const result = writeOne({ fact: v.fact, salience, tags, source });
  if (!result.ok) return { target: "memory", detail: result.note, quarantinedByGuard: true };
  if (action.target.id !== undefined && result.realId) memoryTargetRealId.set(action.target.id, result.realId);
  return { target: `memory#${result.realId}`, detail: `imported new memory fact "${result.realId}"` };
}

function performSession(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const v = item.value as {
    id?: unknown;
    title?: unknown;
    messages?: unknown;
    summary?: unknown;
    tags?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
  };
  if (typeof v.id !== "string" || !Array.isArray(v.messages)) {
    throw new Error(`session item "${action.itemKey}" is missing an id or a messages array`);
  }
  const messages = v.messages
    .filter((m): m is { role: unknown; content: unknown; at: unknown } => !!m && typeof m === "object")
    .map((m) => ({
      role: (m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : "user") as "user" | "assistant" | "system",
      content: typeof m.content === "string" ? m.content : "",
      at: typeof m.at === "number" ? m.at : deps.now(),
    }));
  const title = typeof v.title === "string" ? v.title : undefined;
  const summary = typeof v.summary === "string" ? v.summary : undefined;
  const tags = Array.isArray(v.tags) ? (v.tags.filter((t) => typeof t === "string") as string[]) : [];
  const startedAt = typeof v.startedAt === "number" ? v.startedAt : messages[0]?.at ?? deps.now();
  const endedAt = typeof v.endedAt === "number" ? v.endedAt : undefined;

  ensureBackup(sessionsFilePath(deps));

  const targetId = action.renamedTo ?? action.target.id ?? v.id;

  if (action.action === "overwrite") {
    const existing = deps.sessions.all().find((s) => s.id === targetId);
    if (!existing) throw new Error(`overwrite target session "${targetId}" was not found in the live session store`);
    existing.title = title;
    existing.summary = summary;
    existing.tags = [...tags];
    existing.startedAt = startedAt;
    existing.endedAt = endedAt;
    if (messages.length > 0) {
      existing.messages = messages.slice(0, -1).map((m) => ({ ...m }));
      const last = messages[messages.length - 1];
      deps.sessions.append(existing.id, { role: last.role, content: last.content, at: last.at });
    } else {
      existing.messages = [];
    }
    return { target: `sessions#${existing.id}`, detail: `overwrote existing session "${existing.id}" (${messages.length} message(s))` };
  }

  // import / rename: create fresh, then restore identity onto the live
  // record BEFORE appending — append() looks the session up by its
  // engine-internal storage key (the id `create()` minted), which never
  // changes even after we overwrite the object's own `.id` field, so we
  // capture that key first and always append against it.
  const live = deps.sessions.create({ title, tags: [...tags] });
  const engineKey = live.id;
  live.id = targetId;
  live.startedAt = startedAt;
  live.endedAt = endedAt;
  live.summary = summary;
  for (const m of messages) {
    deps.sessions.append(engineKey, { role: m.role, content: m.content, at: m.at });
  }
  return { target: `sessions#${targetId}`, detail: `imported session "${targetId}" (${messages.length} message(s))` };
}

function performSkill(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const v = item.value as {
    name?: unknown;
    description?: unknown;
    capabilities?: unknown;
    tools?: unknown;
    whenToUse?: unknown;
    model?: unknown;
    version?: unknown;
    instructions?: unknown;
  };
  if (typeof v.name !== "string" || typeof v.description !== "string" || typeof v.instructions !== "string") {
    throw new Error(`skill item "${action.itemKey}" is missing name/description/instructions`);
  }
  const targetName = action.renamedTo ?? action.target.id;
  if (!targetName) throw new Error(`skill action "${action.itemKey}" has no target name`);

  const skillDir = jailedChildPath(fsOps, deps.skillsDir, targetName);
  const filePath = join(skillDir, "SKILL.md");
  ensureBackup(filePath);

  const manifest: SkillManifest = {
    name: v.name,
    description: v.description,
    capabilities: Array.isArray(v.capabilities) ? (v.capabilities.filter((x) => typeof x === "string") as string[]) : [],
    tools: Array.isArray(v.tools) ? (v.tools.filter((x) => typeof x === "string") as string[]) : [],
    instructions: v.instructions,
    ...(typeof v.whenToUse === "string" ? { whenToUse: v.whenToUse } : {}),
    ...(typeof v.model === "string" ? { model: v.model } : {}),
    ...(typeof v.version === "string" ? { version: v.version } : {}),
  };
  const text = serializeSkillFile(manifest);
  fsOps.mkdirp(skillDir);
  fsOps.writeFileAtomic(filePath, Buffer.from(text, "utf8"));

  const roundTripRaw = fsOps.readFileBuffer(filePath);
  if (!roundTripRaw) throw new Error(`skill file "${filePath}" could not be re-read immediately after writing`);
  let roundTrip: ReturnType<typeof parseSkillFile>;
  try {
    roundTrip = parseSkillFile(roundTripRaw.toString("utf8"));
  } catch (err) {
    throw new Error(`written SKILL.md at "${filePath}" failed to round-trip parse: ${errMsg(err)}`);
  }
  if (roundTrip.manifest.name !== manifest.name || roundTrip.manifest.instructions !== manifest.instructions) {
    throw new Error(`written SKILL.md at "${filePath}" did not round-trip to the same manifest`);
  }

  return { target: filePath, detail: `wrote skill "${manifest.name}" to ${filePath}` };
}

function performContextFile(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const v = item.value as { relPath?: unknown; content?: unknown };
  if (typeof v.content !== "string") throw new Error(`context-file item "${action.itemKey}" has no content`);
  const rawRel = action.renamedTo ?? action.target.path ?? (typeof v.relPath === "string" ? v.relPath : undefined);
  if (!rawRel) throw new Error(`context-file action "${action.itemKey}" has no target path`);

  const filePath = jailedChildPath(fsOps, deps.contextFilesDir, rawRel);
  ensureBackup(filePath);
  fsOps.mkdirp(dirname(filePath));
  fsOps.writeFileAtomic(filePath, Buffer.from(v.content, "utf8"));
  return { target: filePath, detail: `wrote context file to ${filePath}` };
}

function performGeneric(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const safeKey = action.itemKey.replace(/[^A-Za-z0-9_.-]/g, "_");
  const rawRel = `${item.kind}/${safeKey}.json`;
  const filePath = jailedChildPath(fsOps, deps.contextFilesDir, rawRel);
  ensureBackup(filePath);
  fsOps.mkdirp(dirname(filePath));
  fsOps.writeFileAtomic(filePath, Buffer.from(`${JSON.stringify(item.value, null, 2)}\n`, "utf8"));
  return { target: filePath, detail: `wrote ${item.kind} record to ${filePath}` };
}

function performModel(action: PlannedAction, deps: ApplyDeps): WriteOutcome {
  const modelId = action.target.id;
  if (!modelId) throw new Error(`model action "${action.itemKey}" has no target model id`);
  if (action.action === "rename") {
    return {
      target: "model.candidates",
      detail: `recorded "${modelId}" as an alternate model candidate; the engine has no separate candidates slot, so the active selection was left unchanged`,
    };
  }
  deps.modelSelection.set(modelId);
  return { target: "model.json#modelId", detail: `set active model selection to "${modelId}"` };
}

function performSecret(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const envVar = action.target.field;
  if (!envVar) throw new Error(`secret action "${action.itemKey}" has no target env var name`);
  const material = deps.secrets.take(envVar);
  if (material === undefined) {
    throw new Error(`no secret material is available in the vault for env var "${envVar}"`);
  }
  ensureBackup(deps.secretsPath);
  writeSecretEnvVar(fsOps, deps.secretsPath, envVar, material, action.action === "overwrite");
  const isWin = process.platform === "win32";
  const modeNote = isWin
    ? " (note: POSIX file mode 0600 does not apply on Windows; the file was written with the platform's default ACLs)"
    : "";
  return { target: `${deps.secretsPath}#${envVar}`, detail: `wrote env var "${envVar}" to ${deps.secretsPath}${modeNote}`, secretWritten: true };
}

function performConfig(action: PlannedAction, deps: ApplyDeps, fsOps: ApplyFsOps, ensureBackup: (p: string) => void): WriteOutcome {
  const item = resolveItemOrThrow(fsOps, action);
  const field = action.target.field;
  if (!field) throw new Error(`config action "${action.itemKey}" has no target field`);
  ensureBackup(configFilePath(deps));
  const current = deps.config.load();
  const patch = buildConfigPatch(current, field, item.value);
  deps.config.write(patch);
  return { target: `config.json#${field}`, detail: `set config field "${field}"` };
}

function performWrite(
  action: PlannedAction,
  deps: ApplyDeps,
  fsOps: ApplyFsOps,
  ensureBackup: (p: string) => void,
  memoryTargetRealId: Map<string, string>,
): WriteOutcome {
  switch (action.kind) {
    case "memory":
      return performMemory(action, deps, fsOps, ensureBackup, memoryTargetRealId);
    case "session":
      return performSession(action, deps, fsOps, ensureBackup);
    case "skill":
      return performSkill(action, deps, fsOps, ensureBackup);
    case "context-file":
      return performContextFile(action, deps, fsOps, ensureBackup);
    case "model":
      return performModel(action, deps);
    case "secret":
      return performSecret(action, deps, fsOps, ensureBackup);
    case "config":
      return performConfig(action, deps, fsOps, ensureBackup);
    case "tool-state":
    case "unknown":
      return performGeneric(action, deps, fsOps, ensureBackup);
    default: {
      const _exhaustive: never = action.kind;
      throw new Error(`unhandled artifact kind: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// applyMigrationPlan
// ---------------------------------------------------------------------------

/**
 * Outcomes for a run that never started (dry-run plan, lock held, unusable
 * data directory). NOTHING was attempted, so nothing is reported `ok` — a
 * "skip"/"abstain" action that was never even looked at must not be counted
 * as a success by `renderApplyReport`, which is exactly the kind of silent
 * "it worked" this codebase refuses to fabricate.
 */
function backoutOutcomes(actions: PlannedAction[], detail: string): ApplyOutcome[] {
  return actions.map((a) => ({ itemKey: a.itemKey, action: a.action, ok: false, detail }));
}

/** `{ applied, failed }` for a run that never started: zero applied, every planned action failed. */
function notStartedCounts(outcomes: ApplyOutcome[]): { applied: number; failed: number } {
  return { applied: 0, failed: outcomes.filter((o) => !o.ok).length };
}

export async function applyMigrationPlan(plan: MigrationPlan, deps: ApplyDeps): Promise<ApplyResult> {
  const start = deps.now();
  const fsOps = deps.fsOps ?? defaultApplyFsOps();
  const receiptPath = receiptsPath(deps.dataDir);

  const headOf = (): string => readReceipts(receiptPath).entries.at(-1)?.hash ?? GENESIS_RECEIPT_HASH;

  // Preflight 0: a plan computed as a preview is never applied. Every
  // renderer stamps `dryRun` plans with "[dry run] no changes will be
  // applied"; honoring that banner is this function's job, not the caller's.
  if (plan.dryRun) {
    const detail =
      "refusing to apply a dry-run plan (plan.dryRun is true — it was computed as a preview); re-plan with options.dryRun:false to write";
    const outcomes = backoutOutcomes(plan.actions, detail);
    const counts = notStartedCounts(outcomes);
    return {
      outcomes,
      receiptPath,
      receiptHead: headOf(),
      applied: counts.applied,
      failed: counts.failed,
      rolledBack: false,
      quarantined: 0,
      secretsWritten: 0,
      durationMs: deps.now() - start,
    };
  }

  // Preflight: the data directory itself must be preparable.
  try {
    fsOps.mkdirp(deps.dataDir);
  } catch (err) {
    const detail = `cannot prepare the data directory "${deps.dataDir}": ${errMsg(err)}`;
    const outcomes = backoutOutcomes(plan.actions, detail);
    const counts = notStartedCounts(outcomes);
    return {
      outcomes,
      receiptPath,
      receiptHead: headOf(),
      applied: counts.applied,
      failed: counts.failed,
      rolledBack: false,
      quarantined: 0,
      secretsWritten: 0,
      durationMs: deps.now() - start,
    };
  }

  const lockPath = join(deps.dataDir, LOCK_FILENAME);
  const lock = fsOps.acquireLock(lockPath, { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS });
  if (!lock) {
    const detail = "another `hades migrate apply` is already running against this data directory (lock held); refusing to run concurrently";
    const outcomes = backoutOutcomes(plan.actions, detail);
    const counts = notStartedCounts(outcomes);
    return {
      outcomes,
      receiptPath,
      receiptHead: headOf(),
      applied: counts.applied,
      failed: counts.failed,
      rolledBack: false,
      quarantined: 0,
      secretsWritten: 0,
      durationMs: deps.now() - start,
    };
  }

  const outcomes: ApplyOutcome[] = [];
  let applied = 0;
  let failed = 0;
  let quarantined = 0;
  let secretsWritten = 0;
  let rolledBack = false;

  try {
    const backups = new Map<string, { existed: boolean; content?: Buffer }>();
    const ensureBackup = (p: string): void => {
      if (backups.has(p)) return;
      const content = fsOps.readFileBuffer(p);
      backups.set(p, { existed: content !== undefined, content });
    };
    // The receipts file is itself mutated by this transaction — back it up
    // unconditionally so a rollback restores it too (a rolled-back run must
    // never leave receipt lines for actions it just undid).
    ensureBackup(receiptPath);
    ensureBackup(modelFilePath(deps));

    const priorReceipts = readReceipts(receiptPath);
    let seq = priorReceipts.entries.length;
    let prevHash = priorReceipts.entries.at(-1)?.hash ?? GENESIS_RECEIPT_HASH;
    const alreadyApplied = new Set(priorReceipts.entries.filter((r) => r.ok).map((r) => `${r.itemKey}\u0000${r.itemHash}`));

    const memoryTargetRealId = new Map<string, string>();
    let failure: { action: PlannedAction; error: unknown } | undefined;
    let stoppedAtIndex = -1;

    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      if (!isWriteAction(action.action)) {
        outcomes.push({ itemKey: action.itemKey, action: action.action, ok: true, detail: `plan decided "${action.action}"; no write required (${action.reason})` });
        applied++;
        continue;
      }
      if (alreadyApplied.has(`${action.itemKey}\u0000${action.itemHash}`)) {
        outcomes.push({ itemKey: action.itemKey, action: action.action, ok: true, detail: "already applied in a previous run (resumed from the receipt chain; not repeated)" });
        applied++;
        continue;
      }
      try {
        const result = performWrite(action, deps, fsOps, ensureBackup, memoryTargetRealId);
        const effectiveAction: PlannedActionKind = result.quarantinedByGuard ? "quarantine" : action.action;
        seq += 1;
        const rec = appendReceipt(fsOps, receiptPath, {
          seq,
          at: deps.now(),
          itemKey: action.itemKey,
          itemHash: action.itemHash,
          action: effectiveAction,
          ok: true,
          target: result.target,
          prevHash,
        });
        prevHash = rec.hash;
        outcomes.push({ itemKey: action.itemKey, action: effectiveAction, ok: true, detail: result.detail, target: result.target });
        applied++;
        if (result.quarantinedByGuard) quarantined++;
        if (result.secretWritten) secretsWritten++;
      } catch (err) {
        failure = { action, error: err };
        stoppedAtIndex = i;
        break;
      }
    }

    if (failure) {
      for (const [p, b] of backups) {
        try {
          if (b.existed && b.content !== undefined) fsOps.writeFileAtomic(p, b.content);
          else fsOps.removeFile(p);
        } catch {
          /* best-effort restore — we still report rolledBack:true, the
             attempt itself is the contract; a doubly-failing filesystem
             is already being reported as a blocker elsewhere */
        }
      }
      rolledBack = true;
      // HONESTY: every action reported `ok` before the failure has just been
      // UNDONE by the rollback above. Leaving those outcomes as successes
      // would make `renderApplyReport` (and the CLI/desktop summaries built
      // on it) claim writes that no longer exist on disk. Rewrite them in
      // place, and reset the counters — after a rollback, zero actions were
      // applied, by definition.
      for (let k = 0; k < outcomes.length; k++) {
        const prior = outcomes[k];
        outcomes[k] = {
          ...prior,
          ok: false,
          detail: `${prior.detail} — UNDONE: a later action in this run failed and the whole transaction was rolled back`,
        };
      }
      failed = outcomes.length;
      applied = 0;
      quarantined = 0;
      secretsWritten = 0;
      outcomes.push({
        itemKey: failure.action.itemKey,
        action: failure.action.action,
        ok: false,
        detail: `apply failed: ${errMsg(failure.error)}; every change made during this run was rolled back`,
      });
      failed++;
      for (const a of plan.actions.slice(stoppedAtIndex + 1)) {
        outcomes.push({ itemKey: a.itemKey, action: a.action, ok: false, detail: "not attempted: apply was aborted earlier in this run and rolled back" });
        failed++;
      }
    }
  } finally {
    lock.release();
  }

  return {
    outcomes,
    receiptPath,
    receiptHead: headOf(),
    applied,
    failed,
    rolledBack,
    quarantined,
    secretsWritten,
    durationMs: deps.now() - start,
  };
}

// ---------------------------------------------------------------------------
// probeTarget — the real-machine probe feeding plan.ts's pure conflict engine
// ---------------------------------------------------------------------------

/**
 * Is `dir` writable — WITHOUT creating it?
 *
 * `probeTarget` also runs for a PREVIEW (`hades migrate plan`, the desktop's
 * Preview button), so it must not leave directories behind on a machine
 * whose owner only asked to look. An absent directory is therefore probed at
 * its nearest existing ancestor: if that ancestor accepts a create+delete,
 * the directory itself can be created when an apply actually runs. The probe
 * file is written and immediately removed; nothing else touches the disk.
 */
function canWriteDir(dir: string): boolean {
  let probeDir = resolvePath(dir);
  for (let hops = 0; hops < 64 && !nodeFs.existsSync(probeDir); hops++) {
    const parent = dirname(probeDir);
    if (parent === probeDir) return false; // walked past the filesystem root
    probeDir = parent;
  }
  if (!nodeFs.existsSync(probeDir)) return false;
  try {
    const marker = join(probeDir, `.hades-migrate-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    nodeFs.writeFileSync(marker, "");
    nodeFs.unlinkSync(marker);
    return true;
  } catch {
    return false;
  }
}

function listSkillsForProbe(skillsDir: string): TargetProbe["skills"] {
  const out: TargetProbe["skills"] = [];
  let entries: nodeFs.Dirent[];
  try {
    entries = nodeFs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = nodeFs.readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = nodeFs.statSync(skillPath).mtimeMs;
    } catch {
      /* leave 0 */
    }
    try {
      const { manifest } = parseSkillFile(text);
      out.push({ name: entry.name, path: skillPath, version: manifest.version, mtimeMs, sha256: sha256Hex(text) });
    } catch {
      continue; // unparsable on-disk skill — not a candidate incumbent
    }
  }
  return out;
}

function listContextFilesForProbe(contextFilesDir: string): TargetProbe["contextFiles"] {
  const out: TargetProbe["contextFiles"] = [];
  const walk = (dir: string, relPrefix: string): void => {
    let entries: nodeFs.Dirent[];
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const buf = nodeFs.readFileSync(abs);
        out.push({ relPath: rel, sha256: sha256Hex(buf.toString("utf8")) });
      } catch {
        /* unreadable — not a usable incumbent */
      }
    }
  };
  walk(contextFilesDir, "");
  return out;
}

function listEnvVarNamesForProbe(secretsPath: string): string[] {
  let text: string;
  try {
    text = nodeFs.readFileSync(secretsPath, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of parseEnvFile(text)) names.add(entry.key);
  return [...names].sort();
}

/**
 * Builds a real snapshot of the live Hades install as a {@link TargetProbe} —
 * the ONLY bridge between the real, stateful engine and `plan.ts`'s pure
 * conflict engine. Every filesystem probe degrades honestly (never throws):
 * an absent skills/context-files directory reads as empty, an unreadable
 * secrets file reads as no known env vars, and per-kind writability is a
 * REAL create+delete probe against the actual target directory, never a
 * fabricated `true`.
 */
export function probeTarget(deps: ApplyDeps & { knownModelIds: string[] }): TargetProbe {
  const memoryFacts = deps.memory.all().map((r) => ({ id: r.id, fact: r.fact, salience: r.salience, tags: [...r.tags], createdAt: r.createdAt }));
  const sessions = deps.sessions.all().map((s) => ({ id: s.id, startedAt: s.startedAt }));
  const skills = listSkillsForProbe(deps.skillsDir);
  const config = deps.config.load();
  const modelSelection = deps.modelSelection.get();
  const contextFiles = listContextFilesForProbe(deps.contextFilesDir);
  const envVarNames = listEnvVarNamesForProbe(deps.secretsPath);

  const dataDirWritable = canWriteDir(deps.dataDir);
  const writable: Record<string, boolean> = {
    dataDir: dataDirWritable,
    config: dataDirWritable && canWriteDir(dirname(configFilePath(deps))),
    model: dataDirWritable && canWriteDir(dirname(modelFilePath(deps))),
    memory: dataDirWritable && canWriteDir(dirname(memoryFilePath(deps))),
    session: dataDirWritable && canWriteDir(dirname(sessionsFilePath(deps))),
    skill: dataDirWritable && canWriteDir(deps.skillsDir),
    secret: dataDirWritable && canWriteDir(dirname(deps.secretsPath)),
    "context-file": dataDirWritable && canWriteDir(deps.contextFilesDir),
    "tool-state": dataDirWritable && canWriteDir(deps.contextFilesDir),
    unknown: dataDirWritable && canWriteDir(deps.contextFilesDir),
  };

  const receipts = readReceipts(receiptsPath(deps.dataDir));
  const priorReceipts = receipts.entries
    .filter((r) => r.ok)
    .map((r) => ({ itemKey: r.itemKey, itemHash: r.itemHash, action: r.action, at: r.at }));

  return {
    dataDir: deps.dataDir,
    memoryFacts,
    sessions,
    skills,
    config,
    modelSelection,
    knownModelIds: [...deps.knownModelIds],
    contextFiles,
    envVarNames,
    secretsFilePath: deps.secretsPath,
    writable,
    priorReceipts,
  };
}
