import { backup, DatabaseSync } from "node:sqlite";
import { WorkAuditJournal } from "./work-audit";
import { arch, platform, release } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const FORMAT = "hades-private-backup-v1";
const MAX_BUNDLE = 100 * 1024 * 1024, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 70 * 1024 * 1024, MAX_FILES = 512;
const databases: Record<string, string[]> = {
  "credential-pools.sqlite": ["credentials"],
  "activity.sqlite": ["activity"], "execution-journal.sqlite": ["events", "streams"],
  "wakes.sqlite": ["wakes"], "work.sqlite": ["work_goals", "work_source_operations", "work_audit_scopes", "work_audit_events"], "native-schedules.sqlite": ["executions"],
  "webhooks.sqlite": ["webhook_subscriptions", "webhook_receipts", "webhook_owner"],
};
// Compare trigger bodies with the runtime schema; names alone cannot authorize imported SQL.
let workTriggers: Map<string,string> | undefined;
function expectedWorkTriggers() {
  if (!workTriggers) {
    const schema = new DatabaseSync(":memory:");
    try { new WorkAuditJournal(schema); workTriggers = new Map((schema.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as Array<{name:string;sql:string}>).map(row=>[row.name,row.sql])); }
    finally { schema.close(); }
  }
  return workTriggers;
}
const texts = ["desktop.json", "sessions.json", "memory.json", "schedule.json", "schedule-receipts.json", "desktop-artifacts.json", "MEMORY.md", "USER.md", "SOUL.md"];
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel)); };
const allowed = (path: string) => texts.includes(path) || Object.hasOwn(databases, path) || /^(?:profiles\/[\w-]+\/)?(?:sessions\.json|memory\.json|desktop-artifacts\.json|MEMORY\.md|USER\.md|SOUL\.md)$/.test(path) || /^(?:profiles\/[\w-]+\/)?skills\/[\w-]+\/SKILL\.md$/.test(path);
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
interface Entry { path: string; bytes: number; sha256: string; content: string }
interface Bundle { format: typeof FORMAT; createdAt: string; files: Entry[]; manifestSha256: string; exclusions: string[] }
interface Inventory { id: string; path: string; createdAt: string; bytes: number; sha256: string; files: number }
export interface MaintenanceDependencies {
  runtimePaths?: Record<string, string>;
  /** Root must reject active work and pause admission/mutations for this entire operation. */
  withSnapshotBarrier: <T>(operation: () => Promise<T>) => Promise<T>;
}
const exclusions = ["Provider auth homes and credentials", "Keychain and API keys", "Plugin account credentials, cached account data and write receipts (reconnect accounts after import)", "Company OS framework versions and profile switches (configure again after import)", "Slack and team connection credentials", "Shell hook configuration and channel access approvals (configure and approve again after import)", "External project files and checkpoints", "Model weights, caches, raw model context archives and terminal scrollback"];
function manifest(bundle: Pick<Bundle, "format" | "createdAt" | "files" | "exclusions">) { return JSON.stringify({ format: bundle.format, createdAt: bundle.createdAt, exclusions: bundle.exclusions, files: bundle.files.map(({ content: _content, ...entry }) => entry) }); }
function writePrivate(path: string, data: string | Buffer) {
  writeFileSync(path, data, { flag: "wx", mode: 0o600, flush: true });
  const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function redactSettings(value: any, depth = 0): any {
  if (depth > 40) throw new Error("Settings nesting exceeds backup limit");
  if (Array.isArray(value)) return value.map((item, index) =>
    index > 0 && typeof value[index - 1] === "string" && /^--?(?:api[_-]?key|token|password|secret|authorization)$/i.test(value[index - 1])
      ? "[credential excluded]" : redactSettings(item, depth + 1));
  if (plain(value)) {
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || /^(?:env|headers|authorization|api[_-]?(?:key|secret)|access[_-]?token|refresh[_-]?token|token|secret|password|credentials)$/i.test(key)) continue;
      result[key] = redactSettings(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return value.replace(/\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, "[credential excluded]").replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [credential excluded]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s&]+/gi, "$1[credential excluded]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1");
  return value;
}

/** Private, allowlisted backups. User-authored conversations and memories stay
 * private content, not a redacted support dump. Imports always stage a NEW data
 * directory with execution disabled; this class never loads or overwrites it. */
export class MaintenanceService {
  private stateDir: string;
  constructor(private dataDir: string, private deps: MaintenanceDependencies) {
    this.dataDir = realpathSync(dataDir);
    this.stateDir = join(this.dataDir, "maintenance");
    if (existsSync(this.stateDir) && lstatSync(this.stateDir).isSymbolicLink()) throw new Error("Maintenance storage cannot be a symlink");
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }
  private destination(path: string) {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new Error("Choose an absolute destination folder");
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) throw new Error("Choose a destination folder");
    if (inside(this.dataDir, resolved)) throw new Error("Choose a destination outside the live Hades data directory");
    return resolved;
  }
  private candidates() {
    const entries: string[] = [];
    const add = (path: string) => {
      if (!allowed(path)) return;
      const absolute = join(this.dataDir, path);
      if (!existsSync(absolute)) return;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || !inside(this.dataDir, realpathSync(absolute))) throw new Error(`Unsafe backup source: ${path}`);
      if (stat.size > MAX_FILE) throw new Error(`Backup file exceeds 32 MB: ${path}`);
      entries.push(path);
    };
    const skills = (prefix: string) => {
      const directory = join(this.dataDir, prefix, "skills");
      if (!existsSync(directory)) return;
      if (lstatSync(directory).isSymbolicLink()) throw new Error("Skills backup directory cannot be a symlink");
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (/^[\w-]+$/.test(entry.name)) {
        if (entry.isSymbolicLink()) throw new Error("Skill backup entries cannot be symlinks");
        if (entry.isDirectory()) add([prefix, "skills", entry.name, "SKILL.md"].filter(Boolean).join("/"));
      }
    };
    [...texts, ...Object.keys(databases)].forEach(add); skills("");
    const profiles = join(this.dataDir, "profiles");
    if (existsSync(profiles)) {
      if (lstatSync(profiles).isSymbolicLink()) throw new Error("Profile backup directory cannot be a symlink");
      for (const profile of readdirSync(profiles, { withFileTypes: true })) if (/^[\w-]+$/.test(profile.name)) {
        if (profile.isSymbolicLink()) throw new Error("Profile backup entries cannot be symlinks");
        if (profile.isDirectory()) { for (const name of texts) add(`profiles/${profile.name}/${name}`); skills(`profiles/${profile.name}`); }
      }
    }
    if (entries.length > MAX_FILES) throw new Error("Backup has more than 512 files");
    return entries.sort();
  }
  private inspectDatabase(path: string, kind: string) {
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF");
      const rows = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string; sql: string }>;
      if (rows.some(row => (row.type === "trigger" ? kind !== "work.sqlite" || expectedWorkTriggers().get(row.name) !== row.sql : !["table", "index"].includes(row.type)) || (row.type === "table" && !databases[kind].includes(row.name)))) throw new Error(`Unexpected database schema: ${kind}`);
      const check = db.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error(`Database integrity check failed: ${kind}`);
      return { tables: rows.filter(row => row.type === "table").map(row => row.name), integrity: "ok" };
    } finally { db.close(); }
  }
  async diagnostics() {
    const disk = await statfs(this.dataDir);
    const runtime = Object.entries(this.deps.runtimePaths ?? { node: process.execPath }).map(([name, path]) => {
      try { const stat = statSync(path); return { name, exists: stat.isFile(), bytes: stat.size }; } catch { return { name, exists: false }; }
    });
    const schemas = Object.keys(databases).filter(path => existsSync(join(this.dataDir, path))).map(path => {
      try { return { name: path, ...this.inspectDatabase(join(this.dataDir, path), path) }; }
      catch { return { name: path, integrity: "error", error: "Database could not pass its supported-schema and integrity check" }; }
    });
    return { at: new Date().toISOString(), os: platform(), release: release(), arch: arch(), node: process.version,
      disk: { freeBytes: Number(disk.bavail) * Number(disk.bsize), totalBytes: Number(disk.blocks) * Number(disk.bsize) }, runtime, schemas,
      scope: "Local runtime and database checks. This is not a security audit or provider connectivity test." };
  }
  list(): Array<Inventory & { exists: boolean }> {
    const path = join(this.stateDir, "inventory.json");
    if (!existsSync(path)) return [];
    const rows = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid backup inventory");
    return rows.slice(-100).reverse().map(row => ({ ...row, exists: existsSync(row.path) }));
  }
  async create({ destination }: { destination: string }) {
    const output = this.destination(destination);
    return this.deps.withSnapshotBarrier(async () => {
      const scratch = mkdtempSync(join(this.stateDir, "snapshot-")); chmodSync(scratch, 0o700);
      try {
        const files: Entry[] = []; let total = 0;
        for (const path of this.candidates()) {
          let bytes: Buffer;
          if (Object.hasOwn(databases, path)) {
            const source = new DatabaseSync(join(this.dataDir, path), { readOnly: true, allowExtension: false });
            const copy = join(scratch, path);
            try {
              // The main file can be tiny while committed pages still live in
              // WAL. Bound the logical database before copying those pages.
              const pages = Number(Object.values(source.prepare("PRAGMA page_count").get()!)[0]);
              const pageSize = Number(Object.values(source.prepare("PRAGMA page_size").get()!)[0]);
              if (pages * pageSize > MAX_FILE) throw new Error(`Backup file exceeds 32 MB: ${path}`);
              await backup(source, copy);
            } finally { source.close(); }
            chmodSync(copy, 0o600); this.inspectDatabase(copy, path); bytes = readFileSync(copy);
          } else {
            bytes = readFileSync(join(this.dataDir, path));
            if (path === "desktop.json") bytes = Buffer.from(JSON.stringify(redactSettings(JSON.parse(bytes.toString("utf8"))), null, 2));
          }
          total += bytes.length;
          if (bytes.length > MAX_FILE || total > MAX_TOTAL) throw new Error("Backup contents exceed the 70 MB limit");
          files.push({ path, bytes: bytes.length, sha256: hash(bytes), content: bytes.toString("base64") });
        }
        const bundle: Bundle = { format: FORMAT, createdAt: new Date().toISOString(), exclusions, files, manifestSha256: "" };
        bundle.manifestSha256 = hash(manifest(bundle));
        const content = JSON.stringify(bundle);
        if (Buffer.byteLength(content) > MAX_BUNDLE) throw new Error("Backup bundle exceeds 100 MB");
        const id = randomUUID(), path = join(output, `Hades-backup-${bundle.createdAt.slice(0, 10)}-${id}.hades-backup.json`);
        writePrivate(path, content);
        const item: Inventory = { id, path, createdAt: bundle.createdAt, bytes: Buffer.byteLength(content), sha256: hash(content), files: files.length };
        const inventory = this.list().map(({ exists: _exists, ...row }) => row).reverse(); inventory.push(item);
        const next = join(this.stateDir, `inventory-${randomUUID()}.pending`); writePrivate(next, JSON.stringify(inventory.slice(-100))); renameSync(next, join(this.stateDir, "inventory.json"));
        return { ...item, manifestSha256: bundle.manifestSha256, exclusions, privateHistory: true };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    });
  }
  private load(path: string): { bundle: Bundle; buffers: Buffer[]; sha256: string } {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new Error("Choose an absolute backup file path");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BUNDLE) throw new Error("Choose a regular backup file of at most 100 MB");
    const raw = readFileSync(path), bundle: unknown = JSON.parse(raw.toString("utf8"));
    if (!plain(bundle) || bundle.format !== FORMAT || typeof bundle.createdAt !== "string" || !Number.isFinite(Date.parse(bundle.createdAt)) || !Array.isArray(bundle.files) || bundle.files.length > MAX_FILES || !Array.isArray(bundle.exclusions) || bundle.exclusions.some((item: unknown) => typeof item !== "string")) throw new Error("Invalid or unsupported backup format");
    const seen = new Set<string>(); let total = 0;
    const buffers = bundle.files.map((entry: unknown) => {
      if (!plain(entry) || Object.keys(entry).sort().join(",") !== "bytes,content,path,sha256" || typeof entry.path !== "string" || !allowed(entry.path) || isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").some((part: string) => !part || part === "." || part === "..") || seen.has(entry.path.toLowerCase())) throw new Error("Unsafe, duplicate or unsupported backup path");
      seen.add(entry.path.toLowerCase());
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.content !== "string" || entry.content.length > Math.ceil(MAX_FILE / 3) * 4) throw new Error("Invalid backup file encoding or size");
      const bytes = Buffer.from(entry.content, "base64"); total += bytes.length;
      if (total > MAX_TOTAL || bytes.length !== entry.bytes || bytes.toString("base64") !== entry.content || hash(bytes) !== entry.sha256) throw new Error("Backup size or checksum mismatch");
      return bytes;
    });
    if (hash(manifest(bundle as Bundle)) !== bundle.manifestSha256) throw new Error("Backup manifest checksum mismatch");
    return { bundle: bundle as Bundle, buffers, sha256: hash(raw) };
  }
  private async verifyLoaded(loaded: ReturnType<MaintenanceService["load"]>) {
    const scratch = mkdtempSync(join(this.stateDir, "verify-")); chmodSync(scratch, 0o700);
    try {
      for (let i = 0; i < loaded.bundle.files.length; i++) {
        const { path } = loaded.bundle.files[i], bytes = loaded.buffers[i];
        if (Object.hasOwn(databases, path)) { const candidate = join(scratch, path); writePrivate(candidate, bytes); this.inspectDatabase(candidate, path); }
        else if (path.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  async verify({ path }: { path: string }) {
    const loaded = this.load(path); await this.verifyLoaded(loaded);
    return { valid: true, path, createdAt: loaded.bundle.createdAt, files: loaded.bundle.files.map(({ content: _content, ...entry }) => entry), sha256: loaded.sha256,
      manifestSha256: loaded.bundle.manifestSha256, totalBytes: loaded.buffers.reduce((n, bytes) => n + bytes.length, 0), privateHistory: true,
      scope: "Checksums and supported schemas verified. A checksum proves integrity, not the identity or trustworthiness of the backup author." };
  }
  private disableExecutors(path: string, kind: string) {
    const db = new DatabaseSync(path, { allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
      if (kind === "wakes.sqlite" && tables.has("wakes")) db.exec("UPDATE wakes SET status='interrupted',owner=NULL,lease_until=NULL,error='Imported for review; not replayed' WHERE status IN ('queued','running')");
      if (kind === "work.sqlite" && tables.has("work_goals")) {
        if (!(db.prepare("PRAGMA table_info(work_goals)").all() as Array<{name:string}>).some(column=>column.name==="revision")) db.exec("ALTER TABLE work_goals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
        const audit = tables.has("work_audit_events") ? new WorkAuditJournal(db) : undefined;
        for (const row of db.prepare("SELECT id,payload,revision FROM work_goals").all() as Array<{ id: string; payload: string; revision: number }>) {
          const before = JSON.parse(row.payload), goal = JSON.parse(row.payload);
          if (goal.status !== "completed") { goal.status = "needs_review"; goal.error = "Imported for review; inspect files and explicitly resume"; }
          for (const task of goal.tasks ?? []) if (["queued", "running"].includes(task.status)) task.status = "interrupted";
          if (audit) {
            const scope = {goalId:goal.id,profile:goal.profile,root:goal.root};
            if (!audit.head(scope).sequence) audit.append({scope,transitionId:`baseline:${row.revision}`,actor:{kind:"system",id:"maintenance"},kind:"work.baseline",at:Date.now(),revision:row.revision,after:before});
            audit.append({scope,transitionId:`revision:${row.revision+1}`,actor:{kind:"system",id:"maintenance"},kind:"work.imported",at:Date.now(),revision:row.revision+1,before,after:goal});
          }
          db.prepare("UPDATE work_goals SET payload=?,revision=revision+1,owner=NULL,lease=NULL,started=NULL WHERE id=?").run(JSON.stringify(goal), row.id);
        }
      }
      if (kind === "work.sqlite" && tables.has("work_source_operations")) db.exec("UPDATE work_source_operations SET cancelled=1");
      if (kind === "webhooks.sqlite") {
        if (tables.has("webhook_owner")) db.exec("DELETE FROM webhook_owner");
        if (tables.has("webhook_subscriptions")) for (const row of db.prepare("SELECT id,payload FROM webhook_subscriptions").all() as Array<{ id: string; payload: string }>) {
          const item = JSON.parse(row.payload); item.enabled = false; item.tokenHash = hash(randomBytes(32));
          db.prepare("UPDATE webhook_subscriptions SET payload=? WHERE id=?").run(JSON.stringify(item), row.id);
        }
        if (tables.has("webhook_receipts")) for (const row of db.prepare("SELECT id,payload FROM webhook_receipts").all() as Array<{ id: string; payload: string }>) {
          const item = JSON.parse(row.payload); if (["received", "running"].includes(item.status)) { item.status = "interrupted"; item.error = "Imported for review; not replayed"; db.prepare("UPDATE webhook_receipts SET payload=? WHERE id=?").run(JSON.stringify(item), row.id); }
        }
      }
      if (kind === "credential-pools.sqlite" && tables.has("credentials")) for (const row of db.prepare("SELECT id,body FROM credentials").all() as Array<{ id: string; body: string }>) {
        const item = JSON.parse(row.body); item.enabled = false; item.cooldownUntil = undefined; item.rejected = false; item.error = undefined;
        db.prepare("UPDATE credentials SET body=? WHERE id=?").run(JSON.stringify(item), row.id);
      }
      if (kind === "native-schedules.sqlite" && tables.has("executions")) db.prepare("UPDATE executions SET state='done',result=? WHERE state='running'").run(JSON.stringify({ ok: false, output: "", detail: "Imported interrupted attempt; no actions replayed" }));
      db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } finally { db.close(); }
  }
  async stage({ path, destination, expectedSha256 }: { path: string; destination: string; expectedSha256: string }) {
    const output = this.destination(destination), loaded = this.load(path);
    if (loaded.sha256 !== expectedSha256) throw new Error("Backup changed since review. Verify it again before importing");
    await this.verifyLoaded(loaded);
    const scratch = mkdtempSync(join(output, ".hades-import-pending-")); chmodSync(scratch, 0o700);
    const final = join(output, `Hades-import-${randomUUID()}`);
    try {
      for (let i = 0; i < loaded.bundle.files.length; i++) {
        const item = loaded.bundle.files[i]; let bytes = loaded.buffers[i];
        if (item.path === "desktop.json") {
          const settings = redactSettings(JSON.parse(bytes.toString("utf8")));
          settings.computerEnabled = false; settings.projects = [];
          for (const job of settings.jobs ?? []) job.enabled = false;
          for (const plugin of settings.plugins ?? []) plugin.enabled = false;
          for (const profile of settings.profiles ?? []) for (const server of profile.mcp ?? []) server.enabled = false;
          bytes = Buffer.from(JSON.stringify(settings, null, 2));
        } else if (item.path === "schedule.json") {
          const settings = JSON.parse(bytes.toString("utf8")); for (const job of settings.jobs ?? []) job.enabled = false; bytes = Buffer.from(JSON.stringify(settings));
        }
        const target = join(scratch, item.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writePrivate(target, bytes);
        if (Object.hasOwn(databases, item.path)) this.disableExecutors(target, item.path);
      }
      const files = loaded.bundle.files.map(item => { const bytes = readFileSync(join(scratch, item.path)); return { path: item.path, bytes: bytes.length, sha256: hash(bytes) }; });
      writePrivate(join(scratch, "IMPORT-REVIEW.json"), JSON.stringify({ format: "hades-staged-import-v1", at: new Date().toISOString(), sourceSha256: loaded.sha256, files,
        safeguards: ["Isolated staging only; not loaded into Hades", "Projects cleared; routines, credential pools, extensions, MCP and computer control disabled", "Webhook credentials invalidated and subscriptions disabled", "Pending execution interrupted; no actions replayed"] }, null, 2));
      renameSync(scratch, final);
      const fd = openSync(output, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      return { path: final, files: files.length, sourceSha256: loaded.sha256, staged: true, activated: false, review: join(final, "IMPORT-REVIEW.json") };
    } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
  }
  async support({ destination }: { destination: string }) {
    const output = this.destination(destination);
    const report = { format: "hades-support-metadata-v1", diagnostics: await this.diagnostics(), backups: this.list().map(({ path: _path, id: _id, ...row }) => row),
      excluded: ["Messages, prompts and tool arguments", "Credentials and account identity", "Project and data directory paths", "Memory and generated file contents"] };
    const path = join(output, `Hades-support-${randomUUID()}.json`); writePrivate(path, JSON.stringify(report, null, 2)); return { path, bytes: statSync(path).size };
  }
}
