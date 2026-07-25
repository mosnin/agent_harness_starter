/**
 * A genuine, dependency-free SQLite file reader.
 *
 * Two engines are provided behind one contract:
 *
 *  - "node": a thin, READ-ONLY wrapper around Node's built-in `node:sqlite`
 *    module (available from Node 22+, still experimental). Opened with
 *    `readOnly: true` so it can never create, upgrade, or checkpoint a file.
 *  - "pure": a hand-rolled parser of the on-disk SQLite file format — the
 *    100-byte header, table b-tree pages (interior + leaf), the record
 *    (payload) format for every serial type, and overflow-page chains. It
 *    never links against a SQLite library.
 *
 * `openSqlite()` sniffs and validates the file header itself (magic bytes,
 * page size, format version, text encoding, declared page count vs. actual
 * file size) before either engine ever touches the file, so failure
 * classification is identical and deterministic regardless of which engine
 * ultimately serves the read. Everything here is READ-ONLY: neither engine
 * ever creates a file, writes a byte, or touches a `-wal`/`-journal`
 * sidecar — their mere presence is only ever detected and surfaced through
 * `warnings()`.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type SqliteCell = string | number | bigint | Uint8Array | null;

export interface SqliteColumn {
  name: string;
  declType?: string;
}

export interface SqliteReader {
  readonly engine: "node:sqlite" | "pure";
  readonly path: string;
  tables(): string[];
  columns(table: string): SqliteColumn[];
  createSql(table: string): string | undefined;
  scan(
    table: string,
    opts?: { limit?: number; maxRows?: number; maxCellBytes?: number },
  ): IterableIterator<Record<string, SqliteCell>>;
  warnings(): string[];
  close(): void;
}

export type SqliteOpenFailure = {
  code:
    | "not-sqlite"
    | "encrypted"
    | "unsupported-version"
    | "corrupt"
    | "too-large"
    | "io-error"
    | "locked";
  message: string;
};

// ---------------------------------------------------------------------------
// Header format constants (see https://www.sqlite.org/fileformat2.html)
// ---------------------------------------------------------------------------

const HEADER_SIZE = 100;
const MAGIC = Buffer.from("SQLite format 3\u0000", "latin1"); // exactly 16 bytes
const VALID_PAGE_SIZES = new Set([512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]);

/** Page type byte values used by the b-tree page header. */
const PAGE_INTERIOR_INDEX = 0x02;
const PAGE_INTERIOR_TABLE = 0x05;
const PAGE_LEAF_INDEX = 0x0a;
const PAGE_LEAF_TABLE = 0x0d;

export function isSqliteFile(head: Uint8Array): boolean {
  if (head.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    if (head[i] !== MAGIC[i]) return false;
  }
  return true;
}

interface DbHeader {
  pageSize: number;
  reservedSpace: number;
  usableSize: number;
  writeVersion: number;
  readVersion: number;
  textEncoding: 1 | 2 | 3;
  headerPageCount: number;
}

/**
 * Best-effort classification of a file whose first 16 bytes are not the
 * SQLite magic. `buf` is the (possibly header-only) sample read from disk;
 * `size` is the file's *actual* total size, used for the page-alignment
 * heuristic — it must not be confused with `buf.length`.
 */
function classifyBadMagic(buf: Buffer, size: number): SqliteOpenFailure {
  if (size === 0) {
    return { code: "not-sqlite", message: "file is empty (0 bytes)" };
  }
  if (size < 100) {
    return {
      code: "not-sqlite",
      message: `file is only ${size} bytes; a SQLite database needs a 100-byte header`,
    };
  }
  const sample = buf.subarray(0, Math.min(size, 256));
  let printable = 0;
  for (const b of sample) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  const printableRatio = printable / sample.length;
  const pageAligned = [...VALID_PAGE_SIZES].some((ps) => size % ps === 0);
  // SQLCipher-style encryption produces page-aligned, high-entropy binary
  // data with no recognizable magic header. Plain garbage/text does not
  // usually happen to be exactly page-aligned. This is a heuristic, not a
  // proof, and is documented as such.
  if (pageAligned && size >= 512 && printableRatio < 0.85) {
    return {
      code: "encrypted",
      message:
        "file has no SQLite header but is page-aligned, high-entropy binary data " +
        "(consistent with SQLCipher or another full-database-encryption scheme)",
    };
  }
  return { code: "not-sqlite", message: "missing 'SQLite format 3' magic header" };
}

function parseHeader(
  buf: Buffer,
  fileSize: number,
): { ok: true; header: DbHeader } | { ok: false; failure: SqliteOpenFailure } {
  if (buf.length < HEADER_SIZE || !isSqliteFile(buf)) {
    return { ok: false, failure: classifyBadMagic(buf, fileSize) };
  }
  const rawPageSize = buf.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (!VALID_PAGE_SIZES.has(pageSize)) {
    return {
      ok: false,
      failure: { code: "corrupt", message: `header declares an invalid page size (raw field = ${rawPageSize})` },
    };
  }
  const writeVersion = buf.readUInt8(18);
  const readVersion = buf.readUInt8(19);
  if (readVersion < 1 || readVersion > 2) {
    return {
      ok: false,
      failure: {
        code: "unsupported-version",
        message: `unsupported file-format read-version ${readVersion} (only 1=legacy and 2=WAL are supported)`,
      },
    };
  }
  const reservedSpace = buf.readUInt8(20);
  const usableSize = pageSize - reservedSpace;
  if (usableSize < 480) {
    return {
      ok: false,
      failure: { code: "corrupt", message: `reserved-space byte (${reservedSpace}) leaves an unusably small page` },
    };
  }
  const maxEmbedFrac = buf.readUInt8(21);
  const minEmbedFrac = buf.readUInt8(22);
  const leafFrac = buf.readUInt8(23);
  if (maxEmbedFrac !== 64 || minEmbedFrac !== 32 || leafFrac !== 32) {
    return {
      ok: false,
      failure: {
        code: "corrupt",
        message: "header payload-fraction constants do not match the SQLite spec (expected 64/32/32)",
      },
    };
  }
  const headerPageCount = buf.readUInt32BE(28);
  const textEncodingRaw = buf.readUInt32BE(56);
  if (textEncodingRaw !== 1 && textEncodingRaw !== 2 && textEncodingRaw !== 3) {
    return { ok: false, failure: { code: "corrupt", message: `invalid text encoding field (${textEncodingRaw})` } };
  }
  return {
    ok: true,
    header: {
      pageSize,
      reservedSpace,
      usableSize,
      writeVersion,
      readVersion,
      textEncoding: textEncodingRaw as 1 | 2 | 3,
      headerPageCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Varints (used both for the top-level cell layout and record headers)
// ---------------------------------------------------------------------------

/** Reads one SQLite varint (max 9 bytes) from `buf` at `offset`. Returns [value, bytesConsumed]. */
function readVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    const b = buf[offset + i];
    if (b === undefined) throw new Error("corrupt: truncated varint");
    result = (result << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return [result, i + 1];
  }
  const b8 = buf[offset + 8];
  if (b8 === undefined) throw new Error("corrupt: truncated varint");
  result = (result << 8n) | BigInt(b8);
  return [result, 9];
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** Downcasts a bigint to a `number` when it fits safely, else keeps it a `bigint`. */
function normalizeInt(v: bigint): number | bigint {
  if (v >= MIN_SAFE_BIGINT && v <= MAX_SAFE_BIGINT) return Number(v);
  return v;
}

// ---------------------------------------------------------------------------
// CREATE TABLE column-list parsing (schema comes from sqlite_master.sql —
// there is no other source of truth in the file format).
// ---------------------------------------------------------------------------

interface ParsedTableSchema {
  columns: SqliteColumn[];
  rowidAliasColumn?: string;
  withoutRowid: boolean;
}

const CONSTRAINT_KEYWORDS = new Set(["primary", "unique", "check", "foreign", "constraint"]);
const TYPE_STOP_KEYWORDS = new Set([
  "primary",
  "not",
  "null",
  "unique",
  "check",
  "default",
  "collate",
  "references",
  "generated",
  "as",
  "constraint",
]);

/** Splits `sql` on top-level commas / finds the matching close-paren, respecting quotes and nested parens. */
function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = openIdx; i < sql.length; i++) {
    const c = sql[i];
    if (inQuote) {
      if (c === inQuote) {
        if (inQuote === '"' && sql[i + 1] === '"') {
          i++; // escaped doubled quote
          continue;
        }
        inQuote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inQuote = c;
      continue;
    }
    if (c === "[") {
      const close = sql.indexOf("]", i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote) {
        if (inQuote === '"' && s[i + 1] === '"') {
          i++;
          continue;
        }
        inQuote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inQuote = c;
      continue;
    }
    if (c === "[") {
      const close = s.indexOf("]", i + 1);
      if (close !== -1) i = close;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Reads one identifier (possibly quoted) from the start of `s`. Returns [name, restOfString]. */
function readIdentifier(s: string): [string, string] | undefined {
  const t = s;
  if (t.length === 0) return undefined;
  const q = t[0];
  if (q === '"' || q === "`" || q === "'") {
    let i = 1;
    let out = "";
    while (i < t.length) {
      if (t[i] === q) {
        if (t[i + 1] === q) {
          out += q;
          i += 2;
          continue;
        }
        i++;
        break;
      }
      out += t[i];
      i++;
    }
    return [out, t.slice(i)];
  }
  if (q === "[") {
    const close = t.indexOf("]");
    if (close === -1) return undefined;
    return [t.slice(1, close), t.slice(close + 1)];
  }
  const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(t);
  if (!m) return undefined;
  return [m[0], t.slice(m[0].length)];
}

function parseColumnSegment(seg: string): SqliteColumn & { hasInlinePrimaryKey: boolean; primaryKeyDesc: boolean } {
  const id = readIdentifier(seg.trim());
  if (!id) return { name: seg.trim(), hasInlinePrimaryKey: false, primaryKeyDesc: false };
  const [name, rest] = id;
  // Walk the remainder token-by-token to find the declared type (everything
  // up to the first constraint keyword), and detect an inline PRIMARY KEY.
  let i = 0;
  const typeTokens: string[] = [];
  let hasPk = false;
  let pkDesc = false;
  let parenDepth = 0;
  const tokenRe = /[A-Za-z_][A-Za-z0-9_$]*|\(|\)|,/g;
  tokenRe.lastIndex = 0;
  let stopAtTypeEnd = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(rest))) {
    const tok = m[0];
    if (tok === "(") {
      parenDepth++;
      if (!stopAtTypeEnd) typeTokens.push(tok);
      continue;
    }
    if (tok === ")") {
      parenDepth--;
      if (!stopAtTypeEnd) typeTokens.push(tok);
      continue;
    }
    if (parenDepth > 0) {
      if (!stopAtTypeEnd) typeTokens.push(tok);
      continue;
    }
    const lower = tok.toLowerCase();
    if (lower === "primary") {
      hasPk = true;
      stopAtTypeEnd = true;
      // look ahead for KEY then optional ASC/DESC
      const after = rest.slice(m.index + tok.length);
      const kd = /^\s*key\s*(asc|desc)?/i.exec(after);
      if (kd && kd[1] && kd[1].toLowerCase() === "desc") pkDesc = true;
      continue;
    }
    if (TYPE_STOP_KEYWORDS.has(lower)) {
      stopAtTypeEnd = true;
      continue;
    }
    if (!stopAtTypeEnd) typeTokens.push(tok);
  }
  const declType = typeTokens.join(" ").replace(/\s+([()])/g, "$1").replace(/([()])\s+/g, "$1").trim();
  return {
    name,
    declType: declType.length > 0 ? declType : undefined,
    hasInlinePrimaryKey: hasPk,
    primaryKeyDesc: pkDesc,
  };
}

/**
 * Best-effort parse of a `CREATE TABLE` statement's column list, declared
 * types, WITHOUT ROWID marker, and the (single-column, non-DESC, exactly
 * "INTEGER"-typed) primary key that SQLite treats as a rowid alias.
 *
 * Returns `undefined` if `sql` doesn't look like a parseable CREATE TABLE
 * (e.g. a virtual table, or a garbled/adversarial sqlite_master row) —
 * callers must degrade gracefully rather than throw.
 */
function parseCreateTableColumns(sql: string): ParsedTableSchema | undefined {
  const openIdx = sql.indexOf("(");
  if (openIdx === -1) return undefined;
  const closeIdx = findMatchingParen(sql, openIdx);
  if (closeIdx === -1) return undefined;
  const inner = sql.slice(openIdx + 1, closeIdx);
  const trailer = sql.slice(closeIdx + 1);
  const withoutRowid = /\bwithout\s+rowid\b/i.test(trailer);

  const segments = splitTopLevel(inner);
  const columns: SqliteColumn[] = [];
  let rowidAliasColumn: string | undefined;
  let tablePkColumn: string | undefined;
  let tablePkIsInteger = false;

  for (const seg of segments) {
    const trimmed = seg.trim();
    const firstCharIsQuote = /^["'`[]/.test(trimmed);
    const barewordMatch = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(trimmed);
    const isConstraint =
      !firstCharIsQuote && !!barewordMatch && CONSTRAINT_KEYWORDS.has(barewordMatch[0].toLowerCase());
    if (isConstraint) {
      const kw = barewordMatch![0].toLowerCase();
      if (kw === "primary") {
        const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(trimmed);
        if (pk) {
          const cols = splitTopLevel(pk[1]);
          if (cols.length === 1) {
            const desc = /\bdesc\b/i.test(cols[0]);
            const colId = readIdentifier(cols[0].trim());
            if (colId && !desc) tablePkColumn = colId[0];
          }
        }
      }
      continue;
    }
    const col = parseColumnSegment(trimmed);
    columns.push({ name: col.name, declType: col.declType });
    if (col.hasInlinePrimaryKey && !col.primaryKeyDesc && (col.declType ?? "").toLowerCase() === "integer") {
      rowidAliasColumn = col.name;
    }
    if (col.name === tablePkColumn) tablePkIsInteger = (col.declType ?? "").toLowerCase() === "integer";
  }

  if (!rowidAliasColumn && tablePkColumn && tablePkIsInteger) {
    rowidAliasColumn = tablePkColumn;
  }
  if (withoutRowid) rowidAliasColumn = undefined;

  return { columns, rowidAliasColumn, withoutRowid };
}

// ---------------------------------------------------------------------------
// Identifier quoting (used only by the node:sqlite engine, which has to
// build SQL text since PRAGMA/table names cannot be bound as parameters).
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// sqlite_master row shape
// ---------------------------------------------------------------------------

interface MasterRow {
  type: string;
  name: string;
  tblName: string;
  rootpage: number;
  sql: string | null;
}

// ---------------------------------------------------------------------------
// Pure (hand-rolled) engine
// ---------------------------------------------------------------------------

class PayloadCursor {
  private localBuf: Buffer;
  private localPos = 0;
  private remainingTotal: number;
  private currentOverflowPage: number;
  private overflowBuf: Buffer | null = null;
  private overflowPos = 0;
  private visitedOverflow = new Set<number>();
  private readonly maxChainSteps: number;

  constructor(
    private readonly reader: PureSqliteReader,
    localBuf: Buffer,
    totalLen: number,
    firstOverflowPage: number,
  ) {
    this.localBuf = localBuf;
    this.remainingTotal = totalLen;
    this.currentOverflowPage = firstOverflowPage;
    this.maxChainSteps = reader.totalPages + 4;
  }

  /** Materializes up to `n` bytes (fewer if the payload is exhausted), advancing the cursor. */
  read(n: number): Buffer {
    const want = Math.min(n, this.remainingTotal);
    const out = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      if (this.localPos < this.localBuf.length) {
        const take = Math.min(want - filled, this.localBuf.length - this.localPos);
        this.localBuf.copy(out, filled, this.localPos, this.localPos + take);
        this.localPos += take;
        filled += take;
        this.remainingTotal -= take;
        continue;
      }
      this.ensureOverflowLoaded();
      const take = Math.min(want - filled, this.overflowBuf!.length - this.overflowPos);
      this.overflowBuf!.copy(out, filled, this.overflowPos, this.overflowPos + take);
      this.overflowPos += take;
      filled += take;
      this.remainingTotal -= take;
    }
    return out;
  }

  /** Advances the cursor by `n` bytes without materializing them (still bounded I/O, not bounded memory-only). */
  skip(n: number): void {
    let toSkip = Math.min(n, this.remainingTotal);
    while (toSkip > 0) {
      if (this.localPos < this.localBuf.length) {
        const take = Math.min(toSkip, this.localBuf.length - this.localPos);
        this.localPos += take;
        toSkip -= take;
        this.remainingTotal -= take;
        continue;
      }
      this.ensureOverflowLoaded();
      const take = Math.min(toSkip, this.overflowBuf!.length - this.overflowPos);
      this.overflowPos += take;
      toSkip -= take;
      this.remainingTotal -= take;
    }
  }

  private ensureOverflowLoaded(): void {
    if (this.overflowBuf && this.overflowPos < this.overflowBuf.length) return;
    if (this.currentOverflowPage === 0) {
      throw new Error("corrupt: payload overflow chain ended before all declared bytes were read");
    }
    if (this.visitedOverflow.has(this.currentOverflowPage)) {
      throw new Error(`corrupt: overflow page ${this.currentOverflowPage} revisited (cyclic/self-referential chain)`);
    }
    this.visitedOverflow.add(this.currentOverflowPage);
    if (this.visitedOverflow.size > this.maxChainSteps) {
      throw new Error("corrupt: overflow chain longer than the entire database (runaway/cyclic chain)");
    }
    const pageBuf = this.reader.readPage(this.currentOverflowPage);
    const next = pageBuf.readUInt32BE(0);
    this.overflowBuf = pageBuf.subarray(4);
    this.overflowPos = 0;
    this.currentOverflowPage = next;
  }

  /** Reads one SQLite varint directly off the cursor (may straddle local/overflow boundary). Returns [value, bytesConsumed]. */
  readVarint(): [bigint, number] {
    let result = 0n;
    for (let i = 0; i < 8; i++) {
      const b = this.read(1);
      if (b.length === 0) throw new Error("corrupt: truncated varint in record header");
      result = (result << 7n) | BigInt(b[0] & 0x7f);
      if ((b[0] & 0x80) === 0) return [result, i + 1];
    }
    const b8 = this.read(1);
    if (b8.length === 0) throw new Error("corrupt: truncated varint in record header");
    result = (result << 8n) | BigInt(b8[0]);
    return [result, 9];
  }
}

interface LeafCellRef {
  rowid: bigint;
  payloadLen: number;
  localBuf: Buffer;
  overflowPage: number;
}

interface TableMeta {
  rootpage: number;
  sql: string | null;
  columns: SqliteColumn[];
  rowidAliasColumn?: string;
  withoutRowid: boolean;
}

export class PureSqliteReader implements SqliteReader {
  readonly engine = "pure" as const;
  private fd: number | null;
  private readonly header: DbHeader;
  private readonly fileSize: number;
  readonly totalPages: number;
  private masterRows: MasterRow[] | undefined;
  private readonly tableMetaCache = new Map<string, TableMeta | null>();
  private readonly _warnings: string[];
  private closed = false;

  constructor(fd: number, path: string, header: DbHeader, fileSize: number, totalPages: number, warnings: string[]) {
    this.fd = fd;
    this.header = header;
    this.fileSize = fileSize;
    this.totalPages = totalPages;
    this._warnings = warnings;
    this.path = path;
  }

  readonly path: string;

  get usableSize(): number {
    return this.header.usableSize;
  }

  /** Reads one full page (1-indexed) from disk. Never caches the whole file. */
  readPage(pageNum: number): Buffer {
    if (this.fd === null) throw new Error("reader is closed");
    if (pageNum < 1 || pageNum > this.totalPages) {
      throw new Error(`corrupt: page ${pageNum} is out of range (database has ${this.totalPages} pages)`);
    }
    const buf = Buffer.allocUnsafe(this.header.pageSize);
    const offset = (pageNum - 1) * this.header.pageSize;
    let readTotal = 0;
    while (readTotal < buf.length) {
      const n = readSync(this.fd, buf, readTotal, buf.length - readTotal, offset + readTotal);
      if (n === 0) {
        // Short read past EOF: zero-fill the remainder rather than loop forever.
        buf.fill(0, readTotal);
        break;
      }
      readTotal += n;
    }
    return buf;
  }

  private ensureMasterLoaded(): MasterRow[] {
    if (this.masterRows) return this.masterRows;
    const rows: MasterRow[] = [];
    const masterColumns: SqliteColumn[] = [
      { name: "type" },
      { name: "name" },
      { name: "tbl_name" },
      { name: "rootpage" },
      { name: "sql" },
    ];
    for (const cell of this.walkTableBTree(1, "sqlite_master")) {
      const rec = this.decodeRecordRaw(cell, masterColumns.length);
      const [type, name, tblName, rootpage, sql] = rec;
      rows.push({
        type: type == null ? "" : String(type),
        name: name == null ? "" : String(name),
        tblName: tblName == null ? "" : String(tblName),
        rootpage: typeof rootpage === "bigint" ? Number(rootpage) : (rootpage as number) || 0,
        sql: sql == null ? null : String(sql),
      });
    }
    this.masterRows = rows;
    return rows;
  }

  private getTableMeta(table: string): TableMeta | null {
    if (this.tableMetaCache.has(table)) return this.tableMetaCache.get(table)!;
    const rows = this.ensureMasterLoaded();
    const row = rows.find((r) => r.type === "table" && r.name === table);
    if (!row) {
      this.tableMetaCache.set(table, null);
      return null;
    }
    let parsed: ParsedTableSchema | undefined;
    if (row.sql) {
      try {
        parsed = parseCreateTableColumns(row.sql);
      } catch {
        parsed = undefined;
      }
    }
    if (!parsed) {
      this._warnings.push(`could not parse schema for table '${table}'; columns will be positional (col0, col1, ...)`);
    }
    const meta: TableMeta = {
      rootpage: row.rootpage,
      sql: row.sql,
      columns: parsed?.columns ?? [],
      rowidAliasColumn: parsed?.rowidAliasColumn,
      withoutRowid: parsed?.withoutRowid ?? false,
    };
    this.tableMetaCache.set(table, meta);
    return meta;
  }

  tables(): string[] {
    return this.ensureMasterLoaded()
      .filter((r) => r.type === "table")
      .map((r) => r.name)
      .sort();
  }

  columns(table: string): SqliteColumn[] {
    const meta = this.getTableMeta(table);
    if (!meta) throw new Error(`no such table: '${table}'`);
    return meta.columns.map((c) => ({ ...c }));
  }

  createSql(table: string): string | undefined {
    const meta = this.getTableMeta(table);
    return meta?.sql ?? undefined;
  }

  /** Lazily walks a table b-tree rooted at `rootPage`, yielding raw leaf cells in key order. */
  private *walkTableBTree(rootPage: number, label: string): Generator<LeafCellRef> {
    const visited = new Set<number>();
    const reader = this;
    function* walk(pageNum: number): Generator<LeafCellRef> {
      if (visited.has(pageNum)) {
        throw new Error(`corrupt: page ${pageNum} visited twice while scanning '${label}' (cyclic b-tree)`);
      }
      visited.add(pageNum);
      if (visited.size > reader.totalPages + 4) {
        throw new Error(`corrupt: b-tree traversal for '${label}' visited more pages than the database has`);
      }
      const buf = reader.readPage(pageNum);
      const hdrOff = pageNum === 1 ? HEADER_SIZE : 0;
      const type = buf[hdrOff];
      if (type === PAGE_INTERIOR_TABLE) {
        const ncells = buf.readUInt16BE(hdrOff + 3);
        const rightPtr = buf.readUInt32BE(hdrOff + 8);
        const cellPtrStart = hdrOff + 12;
        for (let i = 0; i < ncells; i++) {
          const cellOff = buf.readUInt16BE(cellPtrStart + i * 2);
          if (cellOff < cellPtrStart || cellOff >= buf.length) {
            throw new Error(`corrupt: cell pointer out of range on interior page ${pageNum} of '${label}'`);
          }
          const childPage = buf.readUInt32BE(cellOff);
          yield* walk(childPage);
        }
        if (rightPtr !== 0) yield* walk(rightPtr);
      } else if (type === PAGE_LEAF_TABLE) {
        const ncells = buf.readUInt16BE(hdrOff + 3);
        const cellPtrStart = hdrOff + 8;
        for (let i = 0; i < ncells; i++) {
          const cellOff = buf.readUInt16BE(cellPtrStart + i * 2);
          if (cellOff < cellPtrStart || cellOff >= buf.length) {
            throw new Error(`corrupt: cell pointer out of range on leaf page ${pageNum} of '${label}'`);
          }
          yield reader.readLeafCell(buf, cellOff, pageNum);
        }
      } else if (type === PAGE_INTERIOR_INDEX || type === PAGE_LEAF_INDEX) {
        throw new Error(
          `'${label}' rootpage ${rootPage} is an index b-tree (WITHOUT ROWID table?), not a table b-tree`,
        );
      } else {
        throw new Error(
          `corrupt: page ${pageNum} has invalid b-tree page type 0x${type.toString(16)} while scanning '${label}'`,
        );
      }
    }
    yield* walk(rootPage);
  }

  private readLeafCell(buf: Buffer, cellOff: number, pageNum: number): LeafCellRef {
    let off = cellOff;
    const [payloadLenBig, len1] = readVarint(buf, off);
    off += len1;
    const [rowidBig, len2] = readVarint(buf, off);
    off += len2;
    if (payloadLenBig < 0n || payloadLenBig > BigInt(this.fileSize)) {
      throw new Error(`corrupt: cell at page ${pageNum} declares an impossible payload length`);
    }
    const payloadLen = Number(payloadLenBig);
    const cellPayloadStart = off;
    const X = this.usableSize - 35;
    let localLen: number;
    if (payloadLen <= X) {
      localLen = payloadLen;
    } else {
      const M = Math.floor(((this.usableSize - 12) * 32) / 255) - 23;
      const K = M + ((payloadLen - M) % (this.usableSize - 4));
      localLen = K <= X ? K : M;
    }
    if (cellPayloadStart + localLen > buf.length) {
      throw new Error(`corrupt: cell at page ${pageNum} offset ${cellOff} overruns the page`);
    }
    const localBuf = buf.subarray(cellPayloadStart, cellPayloadStart + localLen);
    let overflowPage = 0;
    if (localLen < payloadLen) {
      if (cellPayloadStart + localLen + 4 > buf.length) {
        throw new Error(`corrupt: cell at page ${pageNum} is missing its overflow-page pointer`);
      }
      overflowPage = buf.readUInt32BE(cellPayloadStart + localLen);
    }
    return { rowid: rowidBig, payloadLen, localBuf, overflowPage };
  }

  /** Decodes a record into an array of exactly `expectedColumnCount` values, no name mapping, no cap. */
  private decodeRecordRaw(cell: LeafCellRef, expectedColumnCount: number): SqliteCell[] {
    const cursor = new PayloadCursor(this, cell.localBuf, cell.payloadLen, cell.overflowPage);
    const [headerLenBig] = cursor.readVarint();
    const headerLen = Number(headerLenBig);
    let consumed = varintLength(headerLenBig);
    const serialTypes: bigint[] = [];
    while (consumed < headerLen) {
      const [st, n] = cursor.readVarint();
      serialTypes.push(st);
      consumed += n;
    }
    const out: SqliteCell[] = [];
    for (let i = 0; i < expectedColumnCount; i++) {
      const st = i < serialTypes.length ? serialTypes[i] : 0n;
      out.push(this.readValueForSerialType(st, cursor, undefined));
    }
    return out;
  }

  private readValueForSerialType(st: bigint, cursor: PayloadCursor, maxCellBytes: number | undefined): SqliteCell {
    if (st === 0n) return null;
    if (st === 1n) return normalizeInt(BigInt.asIntN(8, BigInt(cursor.read(1)[0])));
    if (st === 2n) return normalizeInt(BigInt.asIntN(16, readUIntBE(cursor.read(2))));
    if (st === 3n) return normalizeInt(BigInt.asIntN(24, readUIntBE(cursor.read(3))));
    if (st === 4n) return normalizeInt(BigInt.asIntN(32, readUIntBE(cursor.read(4))));
    if (st === 5n) return normalizeInt(BigInt.asIntN(48, readUIntBE(cursor.read(6))));
    if (st === 6n) return normalizeInt(cursor.read(8).readBigInt64BE(0));
    if (st === 7n) return cursor.read(8).readDoubleBE(0);
    if (st === 8n) return 0;
    if (st === 9n) return 1;
    if (st === 10n || st === 11n) {
      throw new Error("corrupt: record uses reserved serial type 10/11 with unknown length");
    }
    const isBlob = st % 2n === 0n;
    const length = Number(isBlob ? (st - 12n) / 2n : (st - 13n) / 2n);
    if (length < 0) throw new Error("corrupt: negative value length decoded from serial type");
    const cap = maxCellBytes !== undefined ? Math.min(length, maxCellBytes) : length;
    const data = cursor.read(cap);
    if (cap < length) cursor.skip(length - cap);
    if (isBlob) return new Uint8Array(data);
    return this.decodeText(data);
  }

  private decodeText(data: Buffer): string {
    switch (this.header.textEncoding) {
      case 1:
        return data.toString("utf8");
      case 2:
        return data.toString("utf16le");
      case 3: {
        const swapped = Buffer.from(data);
        for (let i = 0; i + 1 < swapped.length; i += 2) {
          const tmp = swapped[i];
          swapped[i] = swapped[i + 1];
          swapped[i + 1] = tmp;
        }
        return swapped.toString("utf16le");
      }
    }
  }

  *scan(
    table: string,
    opts?: { limit?: number; maxRows?: number; maxCellBytes?: number },
  ): IterableIterator<Record<string, SqliteCell>> {
    const meta = this.getTableMeta(table);
    if (!meta) throw new Error(`no such table: '${table}'`);
    if (meta.withoutRowid) {
      this._warnings.push(`table '${table}' is a WITHOUT ROWID table; the pure reader does not support it`);
      throw new Error(`WITHOUT ROWID tables are not supported: '${table}'`);
    }
    const limit = Math.min(opts?.limit ?? Number.POSITIVE_INFINITY, opts?.maxRows ?? Number.POSITIVE_INFINITY);
    if (limit <= 0) return;
    const columns = meta.columns;
    const useFallbackNames = columns.length === 0;
    let yielded = 0;
    for (const cell of this.walkTableBTree(meta.rootpage, table)) {
      if (yielded >= limit) break;
      const cursor = new PayloadCursor(this, cell.localBuf, cell.payloadLen, cell.overflowPage);
      const [headerLenBig] = cursor.readVarint();
      const headerLen = Number(headerLenBig);
      let consumed = varintLength(headerLenBig);
      const serialTypes: bigint[] = [];
      while (consumed < headerLen) {
        const [st, n] = cursor.readVarint();
        serialTypes.push(st);
        consumed += n;
      }
      const row: Record<string, SqliteCell> = {};
      const columnCount = useFallbackNames ? serialTypes.length : columns.length;
      for (let i = 0; i < columnCount; i++) {
        const name = useFallbackNames ? `col${i}` : columns[i].name;
        const st = i < serialTypes.length ? serialTypes[i] : 0n;
        if (!useFallbackNames && meta.rowidAliasColumn === columns[i].name && st === 0n) {
          row[name] = normalizeInt(cell.rowid);
        } else {
          row[name] = this.readValueForSerialType(st, cursor, opts?.maxCellBytes);
        }
      }
      yielded++;
      yield row;
    }
  }

  warnings(): string[] {
    return [...this._warnings];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

function varintLength(v: bigint): number {
  // Re-derive how many bytes a varint occupies from its decoded value, for
  // the (extremely common) small values this is exact; SQLite always writes
  // varints in minimal form so this matches what was actually on disk.
  if (v < 0n) return 9;
  let n = 1;
  let x = v;
  while (x >= 128n && n < 9) {
    x >>= 7n;
    n++;
  }
  return n;
}

function readUIntBE(buf: Buffer): bigint {
  let v = 0n;
  for (const b of buf) v = (v << 8n) | BigInt(b);
  return v;
}

// ---------------------------------------------------------------------------
// node:sqlite engine (thin, READ-ONLY wrapper)
// ---------------------------------------------------------------------------

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    opts?: { readOnly?: boolean; readBigInts?: boolean; open?: boolean; enableForeignKeyConstraints?: boolean },
  ) => NodeDatabaseSync;
}

interface NodeStatementSync {
  all(...params: unknown[]): Record<string, unknown>[];
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}

interface NodeDatabaseSync {
  prepare(sql: string): NodeStatementSync;
  close(): void;
}

class NodeSqliteReader implements SqliteReader {
  readonly engine = "node:sqlite" as const;
  private db: NodeDatabaseSync | null;
  private readonly _warnings: string[];

  constructor(
    db: NodeDatabaseSync,
    readonly path: string,
    warnings: string[],
  ) {
    this.db = db;
    this._warnings = warnings;
  }

  private db_(): NodeDatabaseSync {
    if (!this.db) throw new Error("reader is closed");
    return this.db;
  }

  tables(): string[] {
    const stmt = this.db_().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    return stmt.all().map((r) => String((r as { name: unknown }).name));
  }

  columns(table: string): SqliteColumn[] {
    const stmt = this.db_().prepare(`PRAGMA table_info(${quoteIdent(table)})`);
    const rows = stmt.all() as Array<{ name: string; type: string }>;
    if (rows.length === 0 && !this.tableExists(table)) {
      throw new Error(`no such table: '${table}'`);
    }
    return rows.map((r) => ({ name: r.name, declType: r.type && r.type.length > 0 ? r.type : undefined }));
  }

  private tableExists(table: string): boolean {
    const stmt = this.db_().prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?");
    return stmt.all(table).length > 0;
  }

  createSql(table: string): string | undefined {
    const stmt = this.db_().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?");
    const rows = stmt.all(table) as Array<{ sql: string | null }>;
    if (rows.length === 0) return undefined;
    return rows[0].sql ?? undefined;
  }

  *scan(
    table: string,
    opts?: { limit?: number; maxRows?: number; maxCellBytes?: number },
  ): IterableIterator<Record<string, SqliteCell>> {
    if (!this.tableExists(table)) throw new Error(`no such table: '${table}'`);
    const limit = Math.min(opts?.limit ?? Number.POSITIVE_INFINITY, opts?.maxRows ?? Number.POSITIVE_INFINITY);
    if (limit <= 0) return;
    const stmt = this.db_().prepare(`SELECT * FROM ${quoteIdent(table)}`);
    let yielded = 0;
    for (const raw of stmt.iterate()) {
      if (yielded >= limit) break;
      const row: Record<string, SqliteCell> = {};
      for (const [k, v] of Object.entries(raw)) {
        row[k] = normalizeNodeValue(v, opts?.maxCellBytes);
      }
      yielded++;
      yield row;
    }
  }

  warnings(): string[] {
    return [...this._warnings];
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function normalizeNodeValue(v: unknown, maxCellBytes: number | undefined): SqliteCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return normalizeInt(v);
  if (typeof v === "number" || typeof v === "string") {
    if (typeof v === "string" && maxCellBytes !== undefined) {
      const buf = Buffer.from(v, "utf8");
      if (buf.length > maxCellBytes) return buf.subarray(0, maxCellBytes).toString("utf8");
    }
    return v;
  }
  if (v instanceof Uint8Array) {
    const capped = maxCellBytes !== undefined && v.length > maxCellBytes ? v.subarray(0, maxCellBytes) : v;
    return new Uint8Array(capped);
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// openSqlite: header sniff + engine dispatch
// ---------------------------------------------------------------------------

function readHeaderBytes(fd: number, size: number): Buffer {
  const n = Math.min(size, HEADER_SIZE);
  const buf = Buffer.alloc(n);
  let readTotal = 0;
  while (readTotal < n) {
    const r = readSync(fd, buf, readTotal, n - readTotal, readTotal);
    if (r === 0) break;
    readTotal += r;
  }
  return buf;
}

function collectSidecarWarnings(path: string): string[] {
  const warnings: string[] = [];
  if (existsSync(`${path}-wal`)) {
    warnings.push(
      `a '-wal' sidecar file is present (${path}-wal); this reader reads only the main database file and ` +
        "will not see any writes that are still in the WAL",
    );
  }
  if (existsSync(`${path}-journal`)) {
    warnings.push(
      `a '-journal' rollback-journal sidecar file is present (${path}-journal); this may indicate an ` +
        "interrupted transaction, and the main database file could reflect a partially-applied write",
    );
  }
  return warnings;
}

export async function openSqlite(
  path: string,
  opts?: { prefer?: "auto" | "node" | "pure"; maxBytes?: number },
): Promise<{ ok: true; reader: SqliteReader } | { ok: false; failure: SqliteOpenFailure }> {
  const prefer = opts?.prefer ?? "auto";

  let stat;
  try {
    stat = statSync(path);
  } catch (e) {
    return { ok: false, failure: { code: "io-error", message: `cannot stat '${path}': ${(e as Error).message}` } };
  }
  if (!stat.isFile()) {
    return { ok: false, failure: { code: "io-error", message: `'${path}' is not a regular file` } };
  }
  const size = stat.size;
  if (opts?.maxBytes !== undefined && size > opts.maxBytes) {
    return {
      ok: false,
      failure: { code: "too-large", message: `file is ${size} bytes, exceeding the ${opts.maxBytes}-byte limit` },
    };
  }

  let sniffFd: number;
  try {
    sniffFd = openSync(path, "r");
  } catch (e) {
    return { ok: false, failure: { code: "io-error", message: `cannot open '${path}': ${(e as Error).message}` } };
  }
  let headerBuf: Buffer;
  try {
    headerBuf = readHeaderBytes(sniffFd, size);
  } finally {
    closeSync(sniffFd);
  }

  const parsed = parseHeader(headerBuf, size);
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  const header = parsed.header;

  const pagesFromSize = Math.floor(size / header.pageSize);
  if (size < header.pageSize) {
    return {
      ok: false,
      failure: { code: "corrupt", message: `file (${size} bytes) is smaller than one page (${header.pageSize} bytes)` },
    };
  }
  const declaredPages = header.headerPageCount === 0 ? pagesFromSize : header.headerPageCount;
  if (declaredPages > 0 && declaredPages * header.pageSize > size) {
    return {
      ok: false,
      failure: {
        code: "corrupt",
        message: `header declares ${declaredPages} pages (${declaredPages * header.pageSize} bytes) but the file is only ${size} bytes (truncated?)`,
      },
    };
  }
  const totalPages = Math.max(1, Math.min(declaredPages || pagesFromSize, pagesFromSize));

  const sidecarWarnings = collectSidecarWarnings(path);

  const openPure = (): { ok: true; reader: SqliteReader } | { ok: false; failure: SqliteOpenFailure } => {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (e) {
      return { ok: false, failure: { code: "io-error", message: `cannot open '${path}': ${(e as Error).message}` } };
    }
    const reader = new PureSqliteReader(fd, path, header, size, totalPages, [...sidecarWarnings]);
    return { ok: true, reader };
  };

  if (prefer === "pure") {
    return openPure();
  }

  let nodeModule: NodeSqliteModule | undefined;
  try {
    // Guarded dynamic import: absent on Node < 22 / built without the
    // experimental module, in which case we fall back to the pure engine.
    nodeModule = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  } catch {
    nodeModule = undefined;
  }

  if (!nodeModule) {
    if (prefer === "node") {
      return { ok: false, failure: { code: "io-error", message: "node:sqlite is unavailable in this Node.js runtime" } };
    }
    return openPure();
  }

  try {
    const db = new nodeModule.DatabaseSync(path, { readOnly: true, readBigInts: true });
    // The constructor can succeed even when another connection holds a lock;
    // the failure only surfaces on the first actual read. Probe eagerly so
    // openSqlite() reports "locked" rather than handing back a reader that
    // will explode on first use.
    try {
      db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").all();
    } catch (probeErr) {
      db.close();
      throw probeErr;
    }
    const reader = new NodeSqliteReader(db, path, [...sidecarWarnings]);
    return { ok: true, reader };
  } catch (e) {
    const err = e as Error & { errcode?: number };
    if (prefer === "node") {
      return { ok: false, failure: classifyNodeOpenError(err) };
    }
    return openPure();
  }
}

function classifyNodeOpenError(err: Error & { errcode?: number }): SqliteOpenFailure {
  const msg = err.message || String(err);
  if (err.errcode === 5 || err.errcode === 6 || /locked|busy/i.test(msg)) {
    return { code: "locked", message: msg };
  }
  if (/not a database|file is not a database/i.test(msg)) {
    return { code: "corrupt", message: msg };
  }
  return { code: "io-error", message: msg };
}
