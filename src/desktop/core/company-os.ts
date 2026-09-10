import {
  fetchCompanyOsUpdate,
  type CompanyOsFetch,
} from "./company-os-updates";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
export interface CompanyOsRelease {
  sha256: string;
  version: string;
  revision: string;
}
interface Bundle {
  schema: 1;
  package: string;
  version: string;
  revision: string;
  repository: string;
  license: string;
  distributionSha256: string;
  files: Array<{ path: string; sha256: string; bytes: number; text: string }>;
}
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const validHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const profile = (v: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(v))
    throw Error("Invalid profile");
  return v;
};
/** Verifies content, not publisher authenticity. The expected digest MUST come
 * from a host-approved pinned release, never from the downloaded bundle itself. */
export function verifyCompanyOsBundle(
  path: string,
  expected: CompanyOsRelease,
): Bundle {
  if (
    !validHash(expected.sha256) ||
    !/^[a-f0-9]{40}$/.test(expected.revision) ||
    !/^\d+\.\d+\.\d+$/.test(expected.version)
  )
    throw Error("Invalid trusted release identity");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
    throw Error("Invalid framework bundle file");
  const raw = readFileSync(path);
  if (hash(raw) !== expected.sha256)
    throw Error("Framework integrity mismatch");
  const b = JSON.parse(raw.toString("utf8")) as Bundle;
  if (
    b.schema !== 1 ||
    b.package !== "@mosnin/companyos" ||
    b.repository !== "https://github.com/mosnin/companyos" ||
    b.version !== expected.version ||
    b.revision !== expected.revision ||
    !validHash(b.distributionSha256) ||
    !Array.isArray(b.files) ||
    b.files.length < 1 ||
    b.files.length > 2000
  )
    throw Error("Unsupported framework release");
  const seen = new Set<string>();
  let total = 0;
  for (const f of b.files) {
    if (
      typeof f.path !== "string" ||
      !/^(company-os|autonomy-suite)\/[A-Za-z0-9_./-]+$/.test(f.path) ||
      f.path.split("/").some((p) => !p || p === "." || p === "..") ||
      seen.has(f.path) ||
      typeof f.text !== "string" ||
      !validHash(f.sha256) ||
      Buffer.byteLength(f.text) !== f.bytes ||
      f.bytes > 4 * 1024 * 1024 ||
      hash(f.text) !== f.sha256
    )
      throw Error("Invalid framework inventory");
    seen.add(f.path);
    total += f.bytes;
  }
  if (total > 16 * 1024 * 1024 || !seen.has("company-os/company-os/SKILL.md"))
    throw Error("Incomplete or oversized framework bundle");
  return b;
}
export class CompanyOsService {
  private db: DatabaseSync;
  private closed = false;
  private update?: AbortController;
  private validations = new Map<
    string,
    {
      stamp: string;
      integrity: "verified" | "integrity-error";
      message?: string;
    }
  >();
  constructor(
    private directory: string,
    private bundledPath: string,
    private bundledRelease: CompanyOsRelease,
    private fetcher: CompanyOsFetch = (url, options) => fetch(url, options),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "company-os.sqlite"));
    this.db.exec(
      "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS updates(profile TEXT PRIMARY KEY,auto INTEGER NOT NULL DEFAULT 0,status TEXT); CREATE TABLE IF NOT EXISTS settings(profile TEXT PRIMARY KEY,enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS releases(digest TEXT PRIMARY KEY,version TEXT NOT NULL,revision TEXT NOT NULL); CREATE TABLE IF NOT EXISTS active(id INTEGER PRIMARY KEY CHECK(id=1),digest TEXT NOT NULL,previous TEXT);",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO releases VALUES(?,?,?)")
      .run(
        bundledRelease.sha256,
        bundledRelease.version,
        bundledRelease.revision,
      );
    this.db
      .prepare("INSERT OR IGNORE INTO active(id,digest) VALUES(1,?)")
      .run(bundledRelease.sha256);
  }
  private check() {
    if (this.closed) throw Error("Company OS service closed");
  }
  private release(digest: string): CompanyOsRelease {
    const row = this.db
      .prepare("SELECT version,revision FROM releases WHERE digest=?")
      .get(digest) as { version: string; revision: string } | undefined;
    if (!row) throw Error("Unknown retained framework release");
    return { sha256: digest, ...row };
  }
  private path(digest: string) {
    if (!validHash(digest)) throw Error("Invalid retained framework digest");
    return digest === this.bundledRelease.sha256
      ? this.bundledPath
      : join(this.directory, digest + ".json");
  }
  private current() {
    this.check();
    const row = this.db
      .prepare("SELECT digest,previous FROM active WHERE id=1")
      .get() as { digest: string; previous: string | null };
    return { ...row, release: this.release(row.digest) };
  }
  private inspect(release: CompanyOsRelease) {
    try {
      const path = this.path(release.sha256),
        stat = lstatSync(path, { bigint: true });
      const stamp = [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
        stat.mode,
        release.version,
        release.revision,
      ].join(":");
      const prior = this.validations.get(release.sha256);
      if (prior?.stamp === stamp) return prior;
      let result: {
        stamp: string;
        integrity: "verified" | "integrity-error";
        message?: string;
      };
      try {
        verifyCompanyOsBundle(path, release);
        // Do not cache a successful verification across a concurrent replacement.
        const after = lstatSync(path, { bigint: true });
        if (
          [
            after.dev,
            after.ino,
            after.size,
            after.mtimeNs,
            after.ctimeNs,
            after.mode,
            release.version,
            release.revision,
          ].join(":") !== stamp
        )
          throw Error("Framework changed while verifying");
        result = { stamp, integrity: "verified" };
      } catch {
        result = {
          stamp,
          integrity: "integrity-error",
          message:
            "Framework integrity could not be verified. Restore a verified version or reinstall the framework before enabling it.",
        };
      }
      this.validations.set(release.sha256, result);
      return result;
    } catch (error) {
      this.validations.delete(release.sha256);
      const missing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR");
      return {
        integrity: missing
          ? ("unavailable" as const)
          : ("integrity-error" as const),
        message: missing
          ? "Framework files are unavailable. Restore a verified version or reinstall the framework."
          : "Framework integrity could not be verified. Restore a verified version before enabling it.",
      };
    }
  }
  private rollbackRelease(current: {
    digest: string;
    previous: string | null;
  }): CompanyOsRelease | undefined {
    const retained = this.db
      .prepare("SELECT digest FROM releases ORDER BY rowid DESC LIMIT 10")
      .all() as Array<{ digest: string }>;
    for (const digest of new Set([
      current.previous,
      this.bundledRelease.sha256,
      ...retained.map((row) => row.digest),
    ])) {
      if (!digest || digest === current.digest) continue;
      try {
        const candidate = this.release(digest);
        if (this.inspect(candidate).integrity === "verified") return candidate;
      } catch {
        /* Unknown/corrupt optional releases cannot block status. */
      }
    }
  }
  status(owner: string) {
    this.check();
    profile(owner);
    const configuredEnabled = !!this.db
      .prepare("SELECT enabled FROM settings WHERE profile=?")
      .get(owner)?.enabled;
    const updateRow = this.db
      .prepare("SELECT auto,status FROM updates WHERE profile=?")
      .get(owner);
    let latest: {
      state: string;
      version?: string;
      checkedAt?: number;
      message?: string;
    } = { state: "not_checked" };
    try {
      const saved = JSON.parse((updateRow?.status as string) || "null");
      if (saved !== null) {
        if (
          !saved ||
          typeof saved !== "object" ||
          ![
            "not_checked",
            "current",
            "incompatible",
            "available",
            "updated",
            "cancelled",
            "error",
          ].includes(saved.state)
        )
          throw Error("Invalid update status");
        latest = {
          state: saved.state,
          ...(typeof saved.version === "string" &&
          /^\d+\.\d+\.\d+$/.test(saved.version)
            ? { version: saved.version }
            : {}),
          ...(typeof saved.checkedAt === "number" &&
          Number.isFinite(saved.checkedAt)
            ? { checkedAt: saved.checkedAt }
            : {}),
          ...(typeof saved.message === "string"
            ? { message: saved.message.slice(0, 500) }
            : {}),
        };
      }
    } catch {
      latest = {
        state: "error",
        message: "Saved update status is unreadable; check for updates again.",
      };
    }
    let release = this.bundledRelease,
      integrity: "verified" | "unavailable" | "integrity-error" =
        "integrity-error",
      message: string | undefined =
        "Active framework metadata is unavailable. Restore the framework installation.",
      rollbackAvailable = false;
    try {
      const c = this.current();
      release = c.release;
      const checked = this.inspect(release);
      integrity = checked.integrity;
      message = checked.message;
      rollbackAvailable = !!this.rollbackRelease(c);
    } catch {
      /* Optional framework failure must not stop the workbench. */
    }
    const available = integrity === "verified";
    return {
      enabled: configuredEnabled && available,
      configuredEnabled,
      available,
      ...release,
      package: "@mosnin/companyos",
      integrity,
      ...(message ? { message } : {}),
      latest,
      autoUpdate: !!updateRow?.auto,
      rollbackAvailable,
      runtime: available ? "instructions-only" : "unavailable",
      schedulingEnabled: false,
    };
  }
  setEnabled(owner: string, enabled: boolean) {
    this.check();
    profile(owner);
    if (typeof enabled !== "boolean") throw Error("Invalid enabled state");
    if (enabled) {
      const c = this.current();
      verifyCompanyOsBundle(this.path(c.digest), c.release);
    }
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET enabled=excluded.enabled",
      )
      .run(owner, Number(enabled));
    return this.status(owner);
  }
  context(owner: string, options: { skill?: string; maxBytes?: number } = {}) {
    const status = this.status(owner);
    if (!status.available)
      throw Error(status.message ?? "Framework is unavailable");
    if (!status.enabled) throw Error("Company OS is disabled for this profile");
    const path = options.skill ?? "company-os/company-os/SKILL.md";
    if (!path.endsWith("/SKILL.md"))
      throw Error("Only framework skill instructions may enter context");
    const limit = options.maxBytes ?? 24000;
    if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 64000)
      throw Error("Context budget must be 1024–64000 bytes");
    const b = verifyCompanyOsBundle(this.path(status.sha256), status),
      file = b.files.find((f) => f.path === path);
    if (!file) throw Error("Framework skill not found");
    if (file.bytes > limit)
      throw Error(
        "Framework skill exceeds context budget; select a smaller skill",
      );
    return {
      version: b.version,
      revision: b.revision,
      sha256: status.sha256,
      skill: path,
      content: file.text,
      bytes: file.bytes,
      authority:
        "Guidance only. Existing Hades permissions, approvals, cancellation and project isolation remain authoritative. No framework scripts or scheduling are executed.",
    };
  }
  catalog(owner: string) {
    const s = this.status(owner);
    if (!s.available) throw Error(s.message ?? "Framework is unavailable");
    const b = verifyCompanyOsBundle(this.path(s.sha256), s);
    return b.files
      .filter((f) => f.path.endsWith("/SKILL.md"))
      .map((f) => ({ path: f.path, bytes: f.bytes }));
  }
  /** Host-only approved data update. expectedActive fences stale update UI. */
  activateVerified(
    path: string,
    release: CompanyOsRelease,
    expectedActive: string,
  ) {
    this.check();
    if (this.current().digest !== expectedActive)
      throw Error("Active framework changed; refresh before updating");
    if (
      (this.db.prepare("SELECT count(*) AS n FROM releases").get()!
        .n as number) >= 10 &&
      !this.db
        .prepare("SELECT 1 FROM releases WHERE digest=?")
        .get(release.sha256)
    )
      throw Error(
        "Retained release limit reached; review stored versions before updating",
      );
    verifyCompanyOsBundle(path, release);
    const bytes = readFileSync(path);
    if (hash(bytes) !== release.sha256)
      throw Error("Bundle changed during update");
    const target = join(this.directory, release.sha256 + ".json");
    if (release.sha256 !== this.bundledRelease.sha256 && !existsSync(target)) {
      const temp = join(this.directory, randomUUID() + ".tmp");
      try {
        writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temp, target);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    }
    verifyCompanyOsBundle(this.path(release.sha256), release);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.current();
      if (current.digest !== expectedActive)
        throw Error("Active framework changed; refresh before updating");
      this.db
        .prepare("INSERT OR IGNORE INTO releases VALUES(?,?,?)")
        .run(release.sha256, release.version, release.revision);
      if (current.digest !== release.sha256)
        this.db
          .prepare("UPDATE active SET digest=?,previous=? WHERE id=1")
          .run(release.sha256, current.digest);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return release;
  }
  rollback(expectedActive: string) {
    this.check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const c = this.current();
      if (c.digest !== expectedActive) throw Error("Active framework changed");
      const release = this.rollbackRelease(c);
      if (!release)
        throw Error("No verified framework release is available to restore");
      verifyCompanyOsBundle(this.path(release.sha256), release);
      this.db
        .prepare("UPDATE active SET digest=?,previous=? WHERE id=1")
        .run(release.sha256, c.digest);
      this.db.exec("COMMIT");
      return release;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  setAutoUpdate(owner: string, enabled: boolean) {
    this.check();
    profile(owner);
    if (typeof enabled !== "boolean")
      throw Error("Invalid auto-update setting");
    if (enabled) {
      const c = this.current();
      verifyCompanyOsBundle(this.path(c.digest), c.release);
    }
    this.db
      .prepare(
        "INSERT INTO updates(profile,auto) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET auto=excluded.auto",
      )
      .run(owner, Number(enabled));
    return this.status(owner);
  }
  async checkUpdates(
    owner: string,
    options: { apply?: boolean; signal?: AbortSignal } = {},
  ) {
    this.check();
    profile(owner);
    if (this.update) throw Error("Framework update check already in progress");
    const before = this.status(owner),
      controller = new AbortController();
    this.update = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, 20000);
    let temp: string | undefined;
    try {
      controller.signal.throwIfAborted();
      const result = await fetchCompanyOsUpdate(
        before.version,
        this.fetcher,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      this.check();
      let state: string = result.state;
      if (
        result.state === "available" &&
        (options.apply === true || this.status(owner).autoUpdate)
      ) {
        temp = join(this.directory, randomUUID() + ".update");
        writeFileSync(temp, result.bundle, { flag: "wx", mode: 0o600 });
        controller.signal.throwIfAborted();
        this.activateVerified(temp, result.release, before.sha256);
        state = "updated";
      }
      const status = { state, version: result.version, checkedAt: Date.now() };
      this.db
        .prepare(
          "INSERT INTO updates(profile,status) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET status=excluded.status",
        )
        .run(owner, JSON.stringify(status));
      return status;
    } catch (error) {
      if (!this.closed) {
        const status = {
          state: controller.signal.aborted ? "cancelled" : "error",
          checkedAt: Date.now(),
          message:
            "Could not verify a compatible Company OS release. The active framework was retained.",
        };
        this.db
          .prepare(
            "INSERT INTO updates(profile,status) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET status=excluded.status",
          )
          .run(owner, JSON.stringify(status));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (temp && existsSync(temp)) unlinkSync(temp);
      if (this.update === controller) this.update = undefined;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.update?.abort();
      this.db.close();
    }
  }
}
