import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTrustStore, FileTrustStore } from "../gateway/trust-store";
import type { TrustRecord } from "../gateway/trust-store";

function record(overrides: Partial<TrustRecord> = {}): TrustRecord {
  return { key: "telegram:111", level: "trusted", addedAt: 1000, ...overrides };
}

describe("InMemoryTrustStore", () => {
  it("stores, retrieves, and counts records", () => {
    const store = new InMemoryTrustStore();
    expect(store.size()).toBe(0);
    expect(store.get("telegram:111")).toBeUndefined();

    store.set(record());
    expect(store.size()).toBe(1);
    expect(store.get("telegram:111")).toEqual(record());
    expect(store.all()).toEqual([record()]);
  });

  it("overwrites a record with the same key rather than duplicating it", () => {
    const store = new InMemoryTrustStore();
    store.set(record({ level: "trusted" }));
    store.set(record({ level: "owner", note: "promoted" }));
    expect(store.size()).toBe(1);
    expect(store.get("telegram:111")?.level).toBe("owner");
    expect(store.get("telegram:111")?.note).toBe("promoted");
  });

  it("removes a record and reports whether one existed", () => {
    const store = new InMemoryTrustStore();
    expect(store.remove("telegram:111")).toBe(false);
    store.set(record());
    expect(store.remove("telegram:111")).toBe(true);
    expect(store.remove("telegram:111")).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("all() reflects every distinct key, independent of insertion order", () => {
    const store = new InMemoryTrustStore();
    store.set(record({ key: "slack:U9", level: "blocked" }));
    store.set(record({ key: "telegram:111", level: "owner" }));
    const keys = store.all().map((r) => r.key).sort();
    expect(keys).toEqual(["slack:U9", "telegram:111"]);
  });
});

describe("FileTrustStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function freshDir(): string {
    dir = mkdtempSync(join(tmpdir(), "trust-store-test-"));
    return dir;
  }

  it("persists across a second instance opened on the same path", () => {
    const d = freshDir();
    const path = join(d, "trust.json");
    const a = new FileTrustStore(path);
    a.set(record({ key: "telegram:111", level: "owner" }));
    a.set(record({ key: "slack:U9", level: "trusted", identityId: "id-1" }));

    const b = new FileTrustStore(path);
    expect(b.size()).toBe(2);
    expect(b.get("telegram:111")?.level).toBe("owner");
    expect(b.get("slack:U9")?.identityId).toBe("id-1");
  });

  it("writes atomically via a .tmp file that gets renamed into place", () => {
    const d = freshDir();
    const path = join(d, "trust.json");
    const store = new FileTrustStore(path);
    store.set(record());

    // The tmp file must not linger after a successful write.
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual([record()]);
  });

  it("absent file on disk yields a fresh, empty store rather than throwing", () => {
    const d = freshDir();
    const path = join(d, "does-not-exist", "trust.json");
    expect(() => new FileTrustStore(path)).not.toThrow();
    const store = new FileTrustStore(path);
    expect(store.size()).toBe(0);
  });

  it("corrupted JSON on disk yields a fresh, empty store rather than crashing", () => {
    const d = freshDir();
    const path = join(d, "trust.json");
    writeFileSync(path, "{ this is not valid json ][");
    expect(() => new FileTrustStore(path)).not.toThrow();
    const store = new FileTrustStore(path);
    expect(store.size()).toBe(0);

    // And it should still be writable/usable afterward.
    store.set(record());
    expect(store.size()).toBe(1);
  });

  it("survives 50 concurrent set() calls with a parseable file at the end", async () => {
    const d = freshDir();
    const path = join(d, "trust.json");
    const store = new FileTrustStore(path);

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => store.set(record({ key: `platform${i}:user${i}` })))
      )
    );

    expect(store.size()).toBe(50);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk).toHaveLength(50);

    // A brand-new instance must be able to load exactly what was written.
    const reopened = new FileTrustStore(path);
    expect(reopened.size()).toBe(50);
  });
});
