import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync } from "node:fs";
import type {
  EcosystemId,
  PluginConnection,
  PluginRecord,
  PluginTokens,
  PluginWriteReceipt,
} from "./ecosystem-types";

/** Credentials are authenticated ciphertext. The master key lives in OS Keychain, never this database. */
export class EcosystemStore {
  private db: DatabaseSync;
  private key?: Buffer;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS plugin_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_clients(profile TEXT NOT NULL,plugin TEXT NOT NULL,client TEXT NOT NULL,PRIMARY KEY(profile,plugin));
      CREATE TABLE IF NOT EXISTS plugin_connections(profile TEXT NOT NULL, plugin TEXT NOT NULL, value TEXT NOT NULL, token TEXT, PRIMARY KEY(profile,plugin));
      CREATE TABLE IF NOT EXISTS plugin_records(profile TEXT NOT NULL, plugin TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile,plugin,collection,id));
      CREATE TABLE IF NOT EXISTS plugin_writes(profile TEXT NOT NULL, plugin TEXT NOT NULL, generation TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile,plugin,generation,key));`);
    this.db
      .prepare("INSERT OR IGNORE INTO plugin_metadata VALUES(?,?)")
      .run("installation", randomUUID());
  }
  get installationId() {
    return this.db
      .prepare("SELECT value FROM plugin_metadata WHERE key=?")
      .get("installation")!.value as string;
  }
  client(profile: string, plugin: EcosystemId): string | undefined {
    return this.db
      .prepare("SELECT client FROM plugin_clients WHERE profile=? AND plugin=?")
      .get(profile, plugin)?.client as string | undefined;
  }
  saveClient(profile: string, plugin: EcosystemId, client: string) {
    this.db
      .prepare(
        "INSERT INTO plugin_clients VALUES(?,?,?) ON CONFLICT(profile,plugin) DO UPDATE SET client=excluded.client",
      )
      .run(profile, plugin, client);
  }
  unlock(hex: string) {
    if (!/^[a-f0-9]{64}$/.test(hex))
      throw new Error("Invalid Plugins vault key");
    this.key?.fill(0);
    this.key = Buffer.from(hex, "hex");
  }
  get unlocked() {
    return !!this.key;
  }
  private seal(value: PluginTokens, connection: PluginConnection) {
    if (!this.key)
      throw new Error("Unlock Plugins in macOS Keychain to connect an account");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          connection.profile,
          connection.pluginId,
          connection.generation,
        ]),
      ),
    );
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    });
  }
  tokens(c: PluginConnection): PluginTokens {
    if (!this.key)
      throw new Error("Unlock Plugins in macOS Keychain to use this account");
    const row = this.db
      .prepare(
        "SELECT value,token FROM plugin_connections WHERE profile=? AND plugin=?",
      )
      .get(c.profile, c.pluginId) as
      | { value: string; token?: string }
      | undefined;
    if (!row?.token || JSON.parse(row.value).generation !== c.generation)
      throw new Error("Account connection changed");
    try {
      const v = JSON.parse(row.token);
      if (v.v !== 1) throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(v.iv, "base64"),
      );
      decipher.setAAD(
        Buffer.from(JSON.stringify([c.profile, c.pluginId, c.generation])),
      );
      decipher.setAuthTag(Buffer.from(v.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(v.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw new Error(
        "Plugins credentials could not be unlocked; reconnect the account",
      );
    }
  }
  get(profile: string, id: EcosystemId): PluginConnection | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM plugin_connections WHERE profile=? AND plugin=?",
      )
      .get(profile, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  all(): PluginConnection[] {
    return (
      this.db.prepare("SELECT value FROM plugin_connections").all() as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value));
  }
  save(c: PluginConnection, token?: PluginTokens) {
    const previous = this.get(c.profile, c.pluginId);
    if (previous && previous.generation !== c.generation)
      throw new Error("Account connection changed");
    const sealed = token ? this.seal(token, c) : undefined;
    this.db
      .prepare(
        "INSERT INTO plugin_connections(profile,plugin,value,token) VALUES(?,?,?,?) ON CONFLICT(profile,plugin) DO UPDATE SET value=excluded.value,token=COALESCE(excluded.token,plugin_connections.token)",
      )
      .run(c.profile, c.pluginId, JSON.stringify(c), sealed ?? null);
  }
  remove(profile: string, id: EcosystemId) {
    // Disconnect removes account data and credentials, never the uncertain-effect ledger.
    this.transaction(() => {
      for (const table of ["plugin_connections", "plugin_records"])
        this.db
          .prepare(`DELETE FROM ${table} WHERE profile=? AND plugin=?`)
          .run(profile, id);
    });
  }
  records(profile: string, id: EcosystemId): PluginRecord[] {
    return (
      this.db
        .prepare(
          "SELECT value FROM plugin_records WHERE profile=? AND plugin=? ORDER BY collection,id",
        )
        .all(profile, id) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  commit(
    c: PluginConnection,
    records: PluginRecord[],
    replace: boolean,
    deleted: Array<{ collection: string; id: string }> = [],
    token?: PluginTokens,
  ) {
    this.transaction(() => {
      if (this.get(c.profile, c.pluginId)?.generation !== c.generation)
        throw new Error("Account connection changed");
      if (replace)
        this.db
          .prepare("DELETE FROM plugin_records WHERE profile=? AND plugin=?")
          .run(c.profile, c.pluginId);
      const put = this.db.prepare(
        "INSERT INTO plugin_records VALUES(?,?,?,?,?) ON CONFLICT(profile,plugin,collection,id) DO UPDATE SET value=excluded.value",
      );
      for (const r of records)
        put.run(
          c.profile,
          c.pluginId,
          r.collection,
          r.id,
          JSON.stringify(r, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, value[key]]),
                )
              : value,
          ),
        );
      for (const r of deleted)
        this.db
          .prepare(
            "DELETE FROM plugin_records WHERE profile=? AND plugin=? AND collection=? AND id=?",
          )
          .run(c.profile, c.pluginId, r.collection, r.id);
      // Cursor advances and unchanged refreshes must not invalidate an agent's
      // page. Bind the view to its actual content and grant, not the sync clock.
      const hash = createHash("sha256").update(
        JSON.stringify([
          c.profile,
          c.pluginId,
          c.generation,
          c.account?.id,
          c.account?.tenantId,
          [...c.scopes].sort(),
        ]),
      );
      for (const row of this.db
        .prepare(
          "SELECT value FROM plugin_records WHERE profile=? AND plugin=? ORDER BY collection,id",
        )
        .all(c.profile, c.pluginId) as { value: string }[])
        hash.update("\n").update(row.value);
      this.save({ ...c, snapshotId: hash.digest("hex") }, token);
    });
  }
  receipt(c: PluginConnection, key: string): PluginWriteReceipt | undefined {
    const rows = this.db
      .prepare(
        "SELECT generation,value FROM plugin_writes WHERE profile=? AND plugin=? AND key=?",
      )
      .all(c.profile, c.pluginId, key) as {
      generation: string;
      value: string;
    }[];
    return rows
      .map((r) => ({
        generation: r.generation,
        receipt: JSON.parse(r.value) as PluginWriteReceipt,
      }))
      .find(
        ({ generation, receipt }) =>
          generation === c.generation ||
          (receipt.accountId === c.account?.id &&
            receipt.tenantId === c.account?.tenantId),
      )?.receipt;
  }
  saveReceipt(c: PluginConnection, receipt: PluginWriteReceipt) {
    const existing = this.db
      .prepare(
        "SELECT value FROM plugin_writes WHERE profile=? AND plugin=? AND generation=? AND key=?",
      )
      .get(c.profile, c.pluginId, c.generation, receipt.key) as
      | { value: string }
      | undefined;
    if (
      existing &&
      JSON.parse(existing.value).fingerprint !== receipt.fingerprint
    )
      throw new Error("Write receipt input changed");
    if (
      !existing &&
      this.get(c.profile, c.pluginId)?.generation !== c.generation
    )
      throw new Error("Account connection changed");
    if (
      !existing &&
      Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM plugin_writes").get()!.n,
      ) >= 5000
    )
      throw new Error(
        "Review the retained plugin write ledger before submitting more changes",
      );
    this.db
      .prepare(
        "INSERT INTO plugin_writes VALUES(?,?,?,?,?) ON CONFLICT(profile,plugin,generation,key) DO UPDATE SET value=excluded.value",
      )
      .run(
        c.profile,
        c.pluginId,
        c.generation,
        receipt.key,
        JSON.stringify(receipt),
      );
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.key?.fill(0);
    this.key = undefined;
    this.db.close();
  }
}
