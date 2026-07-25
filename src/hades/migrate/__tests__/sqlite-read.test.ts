import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { isSqliteFile, openSqlite, type SqliteCell } from "../sqlite-read";

// ---------------------------------------------------------------------------
// node:sqlite availability probe. Per the comprehensiveness bar: if it is
// unavailable, we skip the fixture-creation half honestly (printed reason,
// never a silent pass) rather than fabricating fixtures another way.
//
// This MUST be resolved synchronously at module-eval time (not inside
// beforeAll): `it.skipIf(...)` conditions are evaluated during test
// collection, before any `beforeAll` hook has run, so an async probe would
// always see `undefined` and silently skip everything.
// ---------------------------------------------------------------------------

interface NodeStmt {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): NodeStmt;
  close(): void;
}
type NodeDatabaseSyncCtor = new (path: string, opts?: Record<string, unknown>) => NodeDb;

let NodeDatabaseSync: NodeDatabaseSyncCtor | undefined;
try {
  const req = createRequire(import.meta.url);
  const mod = req("node:sqlite") as { DatabaseSync: NodeDatabaseSyncCtor };
  NodeDatabaseSync = mod.DatabaseSync;
} catch {
  NodeDatabaseSync = undefined;
  // eslint-disable-next-line no-console
  console.warn(
    "[sqlite-read.test] node:sqlite is unavailable in this Node.js runtime — skipping fixture-creation " +
      "and cross-validation tests that require it (printed here, not a silent pass). Header/adversarial " +
      "tests that don't need a real SQLite writer still run.",
  );
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-read-test-"));
});

afterEach(() => {
  // Individual tests create their own files inside `dir`; leave cleanup to
  // the OS tmp reaper, but make sure we don't accumulate huge fixtures
  // across the whole suite by removing the biggest ones eagerly is not
  // necessary here since each file is a few MB at most.
});

function dbPath(name: string): string {
  return join(dir, name);
}

/** Builds a real SQLite file via node:sqlite. Skips (throws a skip signal) if unavailable. */
function buildDb(name: string, setup: (db: NodeDb) => void): string {
  if (!NodeDatabaseSync) {
    throw new Error("node:sqlite unavailable");
  }
  const p = dbPath(name);
  try {
    rmSync(p);
  } catch {
    /* file didn't exist */
  }
  const db = new NodeDatabaseSync(p);
  db.exec("BEGIN");
  setup(db);
  db.exec("COMMIT");
  db.close();
  return p;
}

function readAllViaNode(path: string, table: string): Record<string, unknown>[] {
  if (!NodeDatabaseSync) throw new Error("node:sqlite unavailable");
  const db = new NodeDatabaseSync(path, { readOnly: true, readBigInts: true });
  const rows = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).all();
  db.close();
  return rows as Record<string, unknown>[];
}

/** Normalizes a node:sqlite (readBigInts:true) row the same way our own reader does, for comparison. */
function normalizeNodeRowForCompare(row: Record<string, unknown>): Record<string, SqliteCell> {
  const out: Record<string, SqliteCell> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "bigint") {
      out[k] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    } else if (v instanceof Uint8Array) out[k] = new Uint8Array(v);
    else out[k] = v as SqliteCell;
  }
  return out;
}

function cellsEqual(a: SqliteCell, b: SqliteCell): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

// ---------------------------------------------------------------------------
// isSqliteFile / header sniffing
// ---------------------------------------------------------------------------

describe("isSqliteFile", () => {
  it("matches the exact 16-byte magic header", () => {
    const magic = Buffer.from("SQLite format 3\u0000", "latin1");
    expect(isSqliteFile(magic)).toBe(true);
    expect(isSqliteFile(Buffer.concat([magic, Buffer.alloc(84)]))).toBe(true);
  });

  it("rejects short buffers and non-matching content", () => {
    expect(isSqliteFile(Buffer.alloc(0))).toBe(false);
    expect(isSqliteFile(Buffer.from("SQLite forma"))).toBe(false);
    expect(isSqliteFile(Buffer.from("not a database at all, 16+ bytes"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-validation: pure reader vs. node:sqlite, row for row.
// ---------------------------------------------------------------------------

describe("cross-validation: pure reader vs node:sqlite", () => {
  it.skipIf(!NodeDatabaseSync)(
    "matches on NULLs, every integer width, negatives, doubles incl. denormals, strings, blobs with 0x00, emoji",
    async () => {
      const p = buildDb("wide-types.db", (db) => {
        db.exec(
          "CREATE TABLE t(a INTEGER PRIMARY KEY, i1 INTEGER, i2 INTEGER, i3 INTEGER, i4 INTEGER, i6 INTEGER, i8 INTEGER, d REAL, s TEXT, emoji TEXT, blob BLOB, n INTEGER)",
        );
        const stmt = db.prepare(
          "INSERT INTO t(i1,i2,i3,i4,i6,i8,d,s,emoji,blob,n) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        );
        stmt.run(1, 2, 3, 4, 5, 6, 3.14159, "hello", "😀🚀🔥 UTF-8 4-byte test", Buffer.from([0, 1, 2, 255]), null);
        stmt.run(-1, -300, -70000, -2000000000, -140000000000, -9223372036854775808n, -3.14159, "", "", Buffer.alloc(0), 0);
        // NOTE: deliberately no embedded NUL byte inside a TEXT value here —
        // node:sqlite's experimental JS<->C string bridge truncates TEXT at
        // an embedded NUL on read (confirmed independently: `length(s)` via
        // raw SQL also reports the truncated length even though the full
        // bytes are genuinely on disk), so it cannot serve as a correct
        // reference for that case. Embedded-NUL coverage is exercised via
        // BLOB columns instead, where node:sqlite has no such limitation.
        stmt.run(127, 32767, 8388607, 2147483647, 140737488355327n, 9223372036854775807n, 5e-324, "no-embedded-nul-here", "", Buffer.from([0, 0, 0]), -1);
        stmt.run(null, null, null, null, null, null, null, null, null, null, null);
        stmt.run(0, 0, 0, 0, 0, 0, Number.MAX_VALUE, "x".repeat(1000), "", Buffer.from("plain"), 42);
      });

      const expected = readAllViaNode(p, "t").map(normalizeNodeRowForCompare);

      for (const prefer of ["node", "pure"] as const) {
        const res = await openSqlite(p, { prefer });
        expect(res.ok).toBe(true);
        if (!res.ok) continue;
        const reader = res.reader;
        expect(reader.engine).toBe(prefer === "node" ? "node:sqlite" : "pure");
        const actual = [...reader.scan("t")];
        expect(actual.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          for (const key of Object.keys(expected[i])) {
            expect(cellsEqual(actual[i][key], expected[i][key]), `row ${i} column ${key} (engine=${prefer})`).toBe(
              true,
            );
          }
        }
        reader.close();
      }
    },
  );

  it.skipIf(!NodeDatabaseSync)("matches on a >1-page overflow TEXT cell (200KB)", async () => {
    const bigText = "OVERFLOW-" + "A".repeat(200_000) + "-END";
    const p = buildDb("overflow.db", (db) => {
      db.exec("CREATE TABLE ov(id INTEGER PRIMARY KEY, big TEXT, tag TEXT)");
      db.prepare("INSERT INTO ov(big, tag) VALUES (?, ?)").run(bigText, "small-sibling-column");
    });
    const expected = readAllViaNode(p, "ov").map(normalizeNodeRowForCompare);

    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const rows = [...res.reader.scan("ov")];
      expect(rows.length).toBe(1);
      expect(rows[0].big).toBe(bigText);
      expect((rows[0].big as string).length).toBe(bigText.length);
      expect(rows[0].tag).toBe(expected[0].tag);
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("matches on a table with ≥5k rows, forcing interior b-tree pages", async () => {
    const N = 6000;
    const p = buildDb("big-table.db", (db) => {
      db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, v TEXT)");
      const ins = db.prepare("INSERT INTO big(v) VALUES (?)");
      for (let i = 0; i < N; i++) ins.run(`row-${i}-${"x".repeat(20)}`);
    });

    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = [...res.reader.scan("big")];
    expect(rows.length).toBe(N);
    expect(rows[0]).toEqual({ id: 1, v: "row-0-xxxxxxxxxxxxxxxxxxxx" });
    expect(rows[N - 1]).toEqual({ id: N, v: `row-${N - 1}-xxxxxxxxxxxxxxxxxxxx` });
    // rowids/ids must be strictly ascending — proves interior-page ordering is respected
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i].id as number) > (rows[i - 1].id as number)).toBe(true);
    }
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)("matches on a column added via ALTER TABLE (short old records default to NULL)", async () => {
    const p = buildDb("alter.db", (db) => {
      db.exec("CREATE TABLE alt(id INTEGER PRIMARY KEY, a TEXT)");
      db.prepare("INSERT INTO alt(a) VALUES ('old-row')").run();
      db.exec("ALTER TABLE alt ADD COLUMN b TEXT");
      db.prepare("INSERT INTO alt(a,b) VALUES ('new-row','new-col-val')").run();
    });
    const expected = readAllViaNode(p, "alt").map(normalizeNodeRowForCompare);
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const rows = [...res.reader.scan("alt")];
      expect(rows).toEqual(expected);
      expect(rows[0].b).toBeNull();
      expect(rows[1].b).toBe("new-col-val");
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("matches on a quoted/odd table and column name", async () => {
    const p = buildDb("quoted.db", (db) => {
      db.exec('CREATE TABLE "My Weird Table!" ("col one" INTEGER, "select" TEXT)');
      db.prepare('INSERT INTO "My Weird Table!" VALUES (1, \'reserved-word-column\')').run();
    });
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.reader.tables()).toContain("My Weird Table!");
      const cols = res.reader.columns("My Weird Table!").map((c) => c.name);
      expect(cols).toEqual(["col one", "select"]);
      const rows = [...res.reader.scan("My Weird Table!")];
      expect(rows).toEqual([{ "col one": 1, select: "reserved-word-column" }]);
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)(
    "honestly refuses a WITHOUT ROWID table in the pure engine (does not mis-read it)",
    async () => {
      const p = buildDb("without-rowid.db", (db) => {
        db.exec("CREATE TABLE wr(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID");
        db.prepare("INSERT INTO wr VALUES ('key1','val1')").run();
      });
      const pure = await openSqlite(p, { prefer: "pure" });
      expect(pure.ok).toBe(true);
      if (!pure.ok) return;
      expect(pure.reader.tables()).toContain("wr");
      expect(() => [...pure.reader.scan("wr")]).toThrow(/WITHOUT ROWID/);
      expect(pure.reader.warnings().some((w) => /WITHOUT ROWID/.test(w))).toBe(true);
      pure.reader.close();

      // node:sqlite (a real SQL engine) has no such limitation — sanity check
      // that this is a "pure reader chooses to refuse", not "the file is bad".
      const node = await openSqlite(p, { prefer: "node" });
      expect(node.ok).toBe(true);
      if (!node.ok) return;
      expect([...node.reader.scan("wr")]).toEqual([{ k: "key1", v: "val1" }]);
      node.reader.close();
    },
  );

  it.skipIf(!NodeDatabaseSync)("createSql() returns the verbatim CREATE TABLE text for both engines", async () => {
    const sql = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)";
    const p = buildDb("createsql.db", (db) => db.exec(sql));
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.reader.createSql("t")).toBe(sql);
      expect(res.reader.createSql("does-not-exist")).toBeUndefined();
      res.reader.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Memory bounds: limit / maxRows / maxCellBytes, and true laziness.
// ---------------------------------------------------------------------------

describe("memory bounds and laziness", () => {
  it.skipIf(!NodeDatabaseSync)("maxCellBytes truncates large cell values without truncating sibling columns", async () => {
    const p = buildDb("cap.db", (db) => {
      db.exec("CREATE TABLE ov(id INTEGER PRIMARY KEY, big TEXT, tag TEXT)");
      db.prepare("INSERT INTO ov(big, tag) VALUES (?, ?)").run("Z".repeat(200_000), "unaffected");
    });
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const [row] = [...res.reader.scan("ov", { maxCellBytes: 100 })];
      expect((row.big as string).length).toBe(100);
      expect(row.tag).toBe("unaffected");
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("limit and maxRows both cap the number of rows returned (min wins)", async () => {
    const p = buildDb("limits.db", (db) => {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
      const ins = db.prepare("INSERT INTO t DEFAULT VALUES");
      for (let i = 0; i < 50; i++) ins.run();
    });
    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.reader.scan("t", { limit: 10 })].length).toBe(10);
    expect([...res.reader.scan("t", { maxRows: 7 })].length).toBe(7);
    expect([...res.reader.scan("t", { limit: 10, maxRows: 3 })].length).toBe(3);
    expect([...res.reader.scan("t", { limit: 0 })].length).toBe(0);
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)(
    "scan() is a lazy iterator: a limited scan never touches a corrupted page beyond the requested rows",
    async () => {
      const N = 6000;
      const p = buildDb("lazy.db", (db) => {
        db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, v TEXT)");
        const ins = db.prepare("INSERT INTO big(v) VALUES (?)");
        for (let i = 0; i < N; i++) ins.run(`row-${i}-${"x".repeat(20)}`);
      });

      const buf = readFileSync(p);
      const rawPageSize = buf.readUInt16BE(16);
      const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
      const totalPages = Math.floor(buf.length / pageSize);
      // Zero the physically-last page. For a monotonically-increasing-rowid
      // bulk insert, this reliably lands on a leaf holding the highest keys,
      // which left-to-right b-tree order visits last.
      const mutable = Buffer.from(buf);
      mutable.fill(0, (totalPages - 1) * pageSize, totalPages * pageSize);
      writeFileSync(p, mutable);

      const res = await openSqlite(p, { prefer: "pure" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const small = [...res.reader.scan("big", { limit: 5 })];
      expect(small.length).toBe(5);
      expect(small[0]).toEqual({ id: 1, v: "row-0-xxxxxxxxxxxxxxxxxxxx" });

      expect(() => [...res.reader.scan("big")]).toThrow(/corrupt/);
      res.reader.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Adversarial inputs: must fail closed with the right code, no crash/hang.
// ---------------------------------------------------------------------------

describe("adversarial inputs fail closed", () => {
  it("a 0-byte file is 'not-sqlite'", async () => {
    const p = dbPath("zero.db");
    writeFileSync(p, Buffer.alloc(0));
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("not-sqlite");
  });

  it("a plain text file is 'not-sqlite'", async () => {
    const p = dbPath("text.db");
    writeFileSync(p, "this is definitely not a database, just plain english text.\n".repeat(10));
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("not-sqlite");
  });

  it("page-aligned high-entropy binary with no magic is classified 'encrypted' (SQLCipher-shaped)", async () => {
    const p = dbPath("encrypted.db");
    const buf = Buffer.alloc(8192);
    // Deterministic pseudo-random fill (no real crypto needed — just needs
    // to look like non-text, non-magic binary data).
    let seed = 12345;
    for (let i = 0; i < buf.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = seed & 0xff;
    }
    writeFileSync(p, buf);
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("encrypted");
  });

  it.skipIf(!NodeDatabaseSync)("a truncated file (header promises more pages than exist) is 'corrupt'", async () => {
    const src = buildDb("trunc-src.db", (db) => {
      db.exec("CREATE TABLE t(a,b)");
      db.prepare("INSERT INTO t VALUES (1,2)").run();
    });
    const full = readFileSync(src);
    const truncated = full.subarray(0, full.length - 2000);
    const p = dbPath("truncated.db");
    writeFileSync(p, truncated);
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("corrupt");
  });

  it.skipIf(!NodeDatabaseSync)("a header claiming an invalid/huge page size is 'corrupt'", async () => {
    const src = buildDb("badpage-src.db", (db) => db.exec("CREATE TABLE t(a)"));
    const bad = Buffer.from(readFileSync(src));
    bad.writeUInt16BE(0xfffe, 16); // not 1, not a valid power-of-two page size
    const p = dbPath("badpage.db");
    writeFileSync(p, bad);
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("corrupt");
  });

  it.skipIf(!NodeDatabaseSync)("an unsupported file-format version is 'unsupported-version'", async () => {
    const src = buildDb("badver-src.db", (db) => db.exec("CREATE TABLE t(a)"));
    const bad = Buffer.from(readFileSync(src));
    bad.writeUInt8(3, 19); // read-version 3: neither legacy(1) nor WAL(2)
    const p = dbPath("badver.db");
    writeFileSync(p, bad);
    const res = await openSqlite(p);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("unsupported-version");
  });

  it.skipIf(!NodeDatabaseSync)("maxBytes enforces a hard file-size ceiling ('too-large')", async () => {
    const p = buildDb("toolarge.db", (db) => db.exec("CREATE TABLE t(a)"));
    const res = await openSqlite(p, { maxBytes: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("too-large");
  });

  it("a missing file is an 'io-error'", async () => {
    const res = await openSqlite(dbPath("does-not-exist.db"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("io-error");
  });

  it.skipIf(!NodeDatabaseSync)("a locked database is 'locked' under prefer:'node'", async () => {
    if (!NodeDatabaseSync) return;
    const p = dbPath("locked.db");
    try {
      rmSync(p);
    } catch {
      /* ignore */
    }
    const db1 = new NodeDatabaseSync(p);
    db1.exec("CREATE TABLE t(a)");
    db1.exec("BEGIN EXCLUSIVE");
    db1.exec("INSERT INTO t VALUES (1)");
    try {
      const res = await openSqlite(p, { prefer: "node" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure.code).toBe("locked");
    } finally {
      db1.exec("COMMIT");
      db1.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("prefer:'auto' falls back to the pure engine when a db is locked", async () => {
    if (!NodeDatabaseSync) return;
    const p = dbPath("locked-auto.db");
    try {
      rmSync(p);
    } catch {
      /* ignore */
    }
    const db1 = new NodeDatabaseSync(p);
    db1.exec("CREATE TABLE t(a)");
    db1.prepare("INSERT INTO t VALUES (1)").run();
    db1.exec("BEGIN EXCLUSIVE");
    db1.exec("INSERT INTO t VALUES (2)");
    try {
      const res = await openSqlite(p, { prefer: "auto" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.reader.engine).toBe("pure");
        res.reader.close();
      }
    } finally {
      db1.exec("COMMIT");
      db1.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("detects and warns about a present -wal / -journal sidecar", async () => {
    const src = buildDb("wal-src.db", (db) => db.exec("CREATE TABLE t(a)"));
    writeFileSync(`${src}-wal`, "not a real wal file, just presence-testing");
    writeFileSync(`${src}-journal`, "not a real journal file, just presence-testing");
    const res = await openSqlite(src, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const warnings = res.reader.warnings();
    expect(warnings.some((w) => w.includes("-wal"))).toBe(true);
    expect(warnings.some((w) => w.includes("-journal"))).toBe(true);
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)("a zeroed page fails closed (no crash) when scanned, not silently mis-read", async () => {
    const p = buildDb("zeropage.db", (db) => {
      db.exec("CREATE TABLE t(a,b)");
      db.prepare("INSERT INTO t VALUES (1,2)").run();
    });
    const buf = Buffer.from(readFileSync(p));
    const rawPageSize = buf.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    buf.fill(0, pageSize, pageSize * 2); // page 2 is table t's data page
    writeFileSync(p, buf);
    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(() => [...res.reader.scan("t")]).toThrow();
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)("a page-pointer cycle in the b-tree fails closed (no hang)", async () => {
    const N = 6000;
    const p = buildDb("cycle.db", (db) => {
      db.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, v TEXT)");
      const ins = db.prepare("INSERT INTO big(v) VALUES (?)");
      for (let i = 0; i < N; i++) ins.run(`row-${i}-${"x".repeat(20)}`);
    });
    const buf = Buffer.from(readFileSync(p));
    const rawPageSize = buf.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const totalPages = Math.floor(buf.length / pageSize);
    let interiorPage = -1;
    for (let pg = 1; pg <= totalPages; pg++) {
      const off = (pg - 1) * pageSize + (pg === 1 ? 100 : 0);
      if (buf[off] === 0x05) {
        interiorPage = pg;
        break;
      }
    }
    expect(interiorPage).toBeGreaterThan(0);
    const hdrOff = interiorPage === 1 ? 100 : 0;
    const pageStart = (interiorPage - 1) * pageSize;
    const cellPtrStart = pageStart + hdrOff + 12;
    const firstCellOff = pageStart + buf.readUInt16BE(cellPtrStart);
    buf.writeUInt32BE(interiorPage, firstCellOff); // make the child pointer point at itself
    writeFileSync(p, buf);

    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(() => [...res.reader.scan("big")]).toThrow(/cycl|corrupt/i);
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)("a self-referential overflow chain fails closed (no hang)", async () => {
    const p = buildDb("ovcycle.db", (db) => {
      db.exec("CREATE TABLE ov(id INTEGER PRIMARY KEY, big TEXT)");
      db.prepare("INSERT INTO ov(big) VALUES (?)").run("B".repeat(200_000));
    });
    const buf = Buffer.from(readFileSync(p));
    const rawPageSize = buf.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const usableSize = pageSize; // fresh node:sqlite db: reserved space is 0

    // Locate the leaf cell for table `ov` (rootpage 2 in a fresh single-table db).
    const rootpage = 2;
    const pageStart = (rootpage - 1) * pageSize;
    const ncells = buf.readUInt16BE(pageStart + 3);
    expect(ncells).toBe(1);
    let off = pageStart + buf.readUInt16BE(pageStart + 8);

    function readVarint(b: Buffer, o: number): [bigint, number] {
      let result = 0n;
      for (let i = 0; i < 8; i++) {
        const byte = b[o + i];
        result = (result << 7n) | BigInt(byte & 0x7f);
        if ((byte & 0x80) === 0) return [result, i + 1];
      }
      result = (result << 8n) | BigInt(b[o + 8]);
      return [result, 9];
    }
    const [payloadLen, l1] = readVarint(buf, off);
    off += l1;
    const [, l2] = readVarint(buf, off);
    off += l2;

    const X = usableSize - 35;
    const M = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const P = Number(payloadLen);
    const localLen = P <= X ? P : (() => {
      const K = M + ((P - M) % (usableSize - 4));
      return K <= X ? K : M;
    })();
    const overflowPtrOff = off + localLen;
    const firstOverflowPage = buf.readUInt32BE(overflowPtrOff);
    expect(firstOverflowPage).toBeGreaterThan(0);

    const ovPageStart = (firstOverflowPage - 1) * pageSize;
    buf.writeUInt32BE(firstOverflowPage, ovPageStart); // overflow page points at itself
    writeFileSync(p, buf);

    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(() => [...res.reader.scan("ov")]).toThrow(/cycl|revisit|corrupt/i);
    res.reader.close();
  });

  it.skipIf(!NodeDatabaseSync)(
    "a sqlite_master row that lies about a table's rootpage fails closed, not mis-read",
    async () => {
      const p = buildDb("lie.db", (db) => {
        db.exec("CREATE TABLE t(a INTEGER, b TEXT)");
        db.prepare("INSERT INTO t VALUES (1,'x')").run();
      });
      const buf = Buffer.from(readFileSync(p));
      const idx = buf.indexOf(Buffer.from("CREATE TABLE"));
      expect(idx).toBeGreaterThan(0);
      // The byte immediately preceding the sql text is the (single-byte,
      // small-int-serial-type) rootpage value for this fixture (rootpage=2).
      expect(buf[idx - 1]).toBe(2);
      buf[idx - 1] = 250; // an out-of-range page number for this tiny file
      writeFileSync(p, buf);

      const res = await openSqlite(p, { prefer: "pure" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // tables()/columns() only read sqlite_master text and don't crash...
      expect(res.reader.tables()).toContain("t");
      // ...but scanning the lying table must fail closed, not return garbage.
      expect(() => [...res.reader.scan("t")]).toThrow();
      res.reader.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Engine dispatch / prefer semantics
// ---------------------------------------------------------------------------

describe("engine dispatch", () => {
  it.skipIf(!NodeDatabaseSync)("prefer:'pure' always uses the pure engine even when node:sqlite is available", async () => {
    const p = buildDb("prefer-pure.db", (db) => db.exec("CREATE TABLE t(a)"));
    const res = await openSqlite(p, { prefer: "pure" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reader.engine).toBe("pure");
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("prefer:'auto' (default) uses node:sqlite when available", async () => {
    const p = buildDb("prefer-auto.db", (db) => db.exec("CREATE TABLE t(a)"));
    const res = await openSqlite(p);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reader.engine).toBe("node:sqlite");
      res.reader.close();
    }
  });

  it.skipIf(!NodeDatabaseSync)("close() releases the underlying handle for both engines", async () => {
    const p = buildDb("close.db", (db) => db.exec("CREATE TABLE t(a)"));
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      res.reader.close();
      // Calling close() twice must not throw.
      expect(() => res.reader.close()).not.toThrow();
      // Using the reader after close() must fail loudly, not silently
      // return stale/garbage data.
      expect(() => res.reader.tables()).toThrow();
    }
  });

  it("scan() on an unknown table throws rather than returning an empty/garbage result silently", async () => {
    const p = dbPath("noop-unknown.db");
    // Build a minimal valid-looking sqlite file via the pure engine's own
    // ability to open something node:sqlite made, OR skip entirely if we
    // truly have nothing — but since this file must exist and be openable,
    // reuse an existing fixture directory db if present.
    if (!existsSync(p)) {
      if (!NodeDatabaseSync) return;
      const db = new NodeDatabaseSync(p);
      db.exec("CREATE TABLE t(a)");
      db.close();
    }
    for (const prefer of ["node", "pure"] as const) {
      const res = await openSqlite(p, { prefer });
      if (!res.ok) continue;
      expect(() => [...res.reader.scan("does-not-exist")]).toThrow();
      res.reader.close();
    }
  });
});
