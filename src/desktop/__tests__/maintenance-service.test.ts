import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MaintenanceService } from "../core/maintenance-service";
const roots: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-maintenance-")); roots.push(root);
  const data = join(root, "data"), destination = join(root, "exports"); mkdirSync(data); mkdirSync(destination);
  const barrier = vi.fn();
  const service = new MaintenanceService(data, { runtimePaths: { node: process.execPath, missingHelper: join(root, "missing") }, withSnapshotBarrier: async run => { barrier(); return run(); } });
  return { root, data, destination, service, barrier };
}
function database(data: string, name: string, sql: string) { const db = new DatabaseSync(join(data, name)); dbs.push(db); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;" + sql); return db; }
function rewriteBundle(path: string, change: (bundle: any) => void, rehash = true) {
  const bundle = JSON.parse(readFileSync(path, "utf8")); change(bundle);
  if (rehash) bundle.manifestSha256 = hash(JSON.stringify({ format: bundle.format, createdAt: bundle.createdAt, exclusions: bundle.exclusions, files: bundle.files.map(({ content: _content, ...entry }: any) => entry) }));
  writeFileSync(path, JSON.stringify(bundle));
}
it("backs up committed WAL data and private history under a barrier while excluding credentials and project files", async () => {
  const { data, root, destination, service, barrier } = setup();
  writeFileSync(join(data, "desktop.json"), JSON.stringify({ projects: [join(root, "project")], profiles: [{ id: "default", apiKey: "PROVIDER_SECRET", mcp: [{ env: { TOKEN: "MCP_SECRET" }, args: ["--api-key", "MCP_ARG_SECRET", "--token=ASSIGN_SECRET"] }], baseUrl: "https://user:URL_SECRET@example.invalid" }], jobs: [], computerEnabled: true }));
  writeFileSync(join(data, "sessions.json"), JSON.stringify([{ id: "one", messages: [{ role: "user", content: "Private history" }] }]));
  mkdirSync(join(data, "codex")); writeFileSync(join(data, "codex", "auth.json"), "AUTH_SECRET");
  mkdirSync(join(data, "slack")); writeFileSync(join(data, "slack", "credentials.json"), "SLACK_SECRET");
  writeFileSync(join(data, "api-keys.json"), "KEYCHAIN_SECRET");
  mkdirSync(join(root, "project")); writeFileSync(join(root, "project", "external.txt"), "EXTERNAL_SECRET");
  database(data, "activity.sqlite", "CREATE TABLE activity(id INTEGER PRIMARY KEY,kind TEXT); INSERT INTO activity(kind) VALUES('committed-wal');");
  expect(statSync(join(data, "activity.sqlite-wal")).size).toBeGreaterThan(0);
  const created = await service.create({ destination }); expect(barrier).toHaveBeenCalledOnce();
  expect(statSync(created.path).mode & 0o777).toBe(0o600);
  const bundle = JSON.parse(readFileSync(created.path, "utf8"));
  expect(bundle.files.map((entry: any) => entry.path)).toEqual(["activity.sqlite", "desktop.json", "sessions.json"]);
  const decoded = bundle.files.filter((entry: any) => entry.path.endsWith(".json")).map((entry: any) => Buffer.from(entry.content, "base64").toString("utf8")).join("\n");
  expect(decoded).toContain("Private history"); expect(decoded).not.toMatch(/PROVIDER_SECRET|MCP_SECRET|MCP_ARG_SECRET|ASSIGN_SECRET|URL_SECRET|AUTH_SECRET|SLACK_SECRET|KEYCHAIN_SECRET|EXTERNAL_SECRET/);
  const verified = await service.verify({ path: created.path }); expect(verified.valid).toBe(true);
  const staged = await service.stage({ path: created.path, destination, expectedSha256: verified.sha256 });
  const db = new DatabaseSync(join(staged.path, "activity.sqlite")); try { expect(db.prepare("SELECT kind FROM activity").get()).toEqual({ kind: "committed-wal" }); } finally { db.close(); }
  expect(JSON.parse(readFileSync(join(data, "desktop.json"), "utf8")).computerEnabled).toBe(true);
  expect(JSON.parse(readFileSync(join(staged.path, "desktop.json"), "utf8"))).toMatchObject({ projects: [], computerEnabled: false });
  expect(service.list()[0]).toMatchObject({ path: created.path, exists: true });
});
it("stages disabled execution and invalidated webhook keys in a new isolated directory", async () => {
  const { data, destination, service } = setup();
  const settings = { projects: ["/project"], computerEnabled: true, jobs: [{ enabled: true }], plugins: [{ enabled: true }], profiles: [{ id: "p", mcp: [{ enabled: true }] }] };
  writeFileSync(join(data, "desktop.json"), JSON.stringify(settings)); writeFileSync(join(data, "schedule.json"), JSON.stringify({ version: 1, jobs: [{ enabled: true }] }));
  const work = database(data, "work.sqlite", "CREATE TABLE work_goals(id TEXT PRIMARY KEY,profile TEXT,payload TEXT,owner TEXT,lease INTEGER,started INTEGER);");
  work.prepare("INSERT INTO work_goals VALUES('g','p',?,'old-owner',9999,1)").run(JSON.stringify({ status: "running", tasks: [{ status: "running", reservedTokens: 1000 }] }));
  const hooks = database(data, "webhooks.sqlite", "CREATE TABLE webhook_subscriptions(id TEXT,profile TEXT,payload TEXT); CREATE TABLE webhook_receipts(id TEXT,payload TEXT); CREATE TABLE webhook_owner(id INTEGER,owner TEXT,lease INTEGER);");
  hooks.prepare("INSERT INTO webhook_subscriptions VALUES('s','p',?)").run(JSON.stringify({ enabled: true, tokenHash: "ORIGINAL_HASH" }));
  hooks.prepare("INSERT INTO webhook_receipts VALUES('r',?)").run(JSON.stringify({ status: "running" })); hooks.exec("INSERT INTO webhook_owner VALUES(1,'old',9999)");
  const pool = database(data, "credential-pools.sqlite", "CREATE TABLE credentials(id TEXT,profile TEXT,provider TEXT,body TEXT);"); pool.prepare("INSERT INTO credentials VALUES('key','p','openai',?)").run(JSON.stringify({ enabled: true, account: "keychain-account" }));
  const wake = database(data, "wakes.sqlite", "CREATE TABLE wakes(status TEXT,owner TEXT,lease_until INTEGER,error TEXT);"); wake.exec("INSERT INTO wakes VALUES('queued','old',9999,NULL)");
  const archive = await service.create({ destination }), verified = await service.verify({ path: archive.path });
  const staged = await service.stage({ path: archive.path, destination, expectedSha256: verified.sha256 });
  expect(staged.activated).toBe(false); expect(staged.path).not.toBe(data);
  const projection = JSON.parse(readFileSync(join(staged.path, "desktop.json"), "utf8"));
  expect(projection).toMatchObject({ projects: [], computerEnabled: false, jobs: [{ enabled: false }], plugins: [{ enabled: false }], profiles: [{ mcp: [{ enabled: false }] }] });
  for (const [name, check] of [
    ["work.sqlite", (db: DatabaseSync) => { const row: any = db.prepare("SELECT * FROM work_goals").get(); expect(row.owner).toBeNull(); expect(JSON.parse(row.payload)).toMatchObject({ status: "needs_review", tasks: [{ status: "interrupted", reservedTokens: 1000 }] }); }],
    ["webhooks.sqlite", (db: DatabaseSync) => { const sub = JSON.parse((db.prepare("SELECT payload FROM webhook_subscriptions").get() as any).payload); expect(sub.enabled).toBe(false); expect(sub.tokenHash).not.toBe("ORIGINAL_HASH"); expect(db.prepare("SELECT * FROM webhook_owner").all()).toEqual([]); expect(JSON.parse((db.prepare("SELECT payload FROM webhook_receipts").get() as any).payload).status).toBe("interrupted"); }],
    ["credential-pools.sqlite", (db: DatabaseSync) => expect(JSON.parse((db.prepare("SELECT body FROM credentials").get() as any).body).enabled).toBe(false)],
    ["wakes.sqlite", (db: DatabaseSync) => expect(db.prepare("SELECT * FROM wakes").get()).toMatchObject({ status: "interrupted", owner: null })],
  ] as Array<[string, (db: DatabaseSync) => void]>) { const db = new DatabaseSync(join(staged.path, name)); try { check(db); } finally { db.close(); } }
  const manifest = JSON.parse(readFileSync(staged.review, "utf8"));
  for (const entry of manifest.files) expect(hash(readFileSync(join(staged.path, entry.path)))).toBe(entry.sha256);
  expect(JSON.parse(readFileSync(join(data, "desktop.json"), "utf8"))).toEqual(settings);
});
it.each(["../escape", "/absolute", "profiles/../escape", "profiles\\escape", "auth.json", "codex/auth.json"])("rejects unsupported or traversing import path %s", async candidate => {
  const { data, destination, service } = setup(); writeFileSync(join(data, "sessions.json"), "[]");
  const archive = await service.create({ destination }); rewriteBundle(archive.path, bundle => { bundle.files[0].path = candidate; });
  await expect(service.verify({ path: archive.path })).rejects.toThrow("path");
  expect(readdirSync(destination).filter(name => name.startsWith("Hades-import"))).toEqual([]);
});
it("rejects duplicate paths, corrupted hashes, symlink sources and changed reviewed candidates", async () => {
  const { data, root, destination, service } = setup(); writeFileSync(join(data, "sessions.json"), "[]");
  const archive = await service.create({ destination }); const original = readFileSync(archive.path);
  rewriteBundle(archive.path, bundle => { bundle.files.push({ ...bundle.files[0] }); }); await expect(service.verify({ path: archive.path })).rejects.toThrow("duplicate");
  writeFileSync(archive.path, original); const verified = await service.verify({ path: archive.path });
  rewriteBundle(archive.path, bundle => { bundle.createdAt = "2026-09-08T00:00:00Z"; });
  await expect(service.stage({ path: archive.path, destination, expectedSha256: verified.sha256 })).rejects.toThrow("changed since review");
  writeFileSync(archive.path, original); rewriteBundle(archive.path, bundle => { bundle.files[0].content = Buffer.from("{}").toString("base64"); });
  await expect(service.verify({ path: archive.path })).rejects.toThrow("checksum");
  const link = join(root, "linked-backup"); symlinkSync(archive.path, link); await expect(service.verify({ path: link })).rejects.toThrow("regular");
  rmSync(join(data, "sessions.json")); symlinkSync(join(root, "private.json"), join(data, "sessions.json")); writeFileSync(join(root, "private.json"), "[]");
  await expect(service.create({ destination })).rejects.toThrow("Unsafe");
});
it("rejects database triggers and oversized files before publishing an import", async () => {
  const { data, destination, service } = setup();
  const db = database(data, "activity.sqlite", "CREATE TABLE activity(id INTEGER); CREATE TRIGGER unsafe AFTER INSERT ON activity BEGIN DELETE FROM activity; END;");
  await expect(service.create({ destination })).rejects.toThrow("schema"); db.exec("DROP TRIGGER unsafe");
  writeFileSync(join(data, "sessions.json"), Buffer.alloc(32 * 1024 * 1024 + 1));
  await expect(service.create({ destination })).rejects.toThrow("32 MB");
  expect(readdirSync(destination)).toEqual([]);
});
it("reports actual runtime/schema/disk facts and exports only support metadata", async () => {
  const { data, destination, service } = setup(); writeFileSync(join(data, "sessions.json"), JSON.stringify([{ content: "NEVER_IN_SUPPORT" }]));
  database(data, "activity.sqlite", "CREATE TABLE activity(id INTEGER);");
  const diagnostics = await service.diagnostics(); expect(diagnostics.node).toBe(process.version); expect(diagnostics.disk.totalBytes).toBeGreaterThan(0);
  expect(diagnostics.runtime).toEqual(expect.arrayContaining([expect.objectContaining({ name: "node", exists: true }), { name: "missingHelper", exists: false }]));
  expect(diagnostics.schemas[0]).toMatchObject({ name: "activity.sqlite", integrity: "ok" });
  const exported = await service.support({ destination }); const support = readFileSync(exported.path, "utf8"); expect(support).not.toContain("NEVER_IN_SUPPORT"); expect(support).not.toContain(data); expect(statSync(exported.path).mode & 0o777).toBe(0o600);
});
it("honors snapshot admission refusal without writing an archive", async () => {
  const { data, destination } = setup(); const service = new MaintenanceService(data, { withSnapshotBarrier: async () => { throw new Error("Active work must finish"); } });
  await expect(service.create({ destination })).rejects.toThrow("Active work"); expect(readdirSync(destination)).toEqual([]);
});
