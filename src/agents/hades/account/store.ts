import { randomUUID, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Accounts for the Hades Browser: sign-up, sign-in, and the sync records a
 * browser pushes. The storage interface is deliberately small so it can sit on
 * Prisma, Supabase or Convex — the harness already ships adapters for all
 * three — with the in-memory implementation used for tests and local runs.
 */

export interface AccountRecord {
  id: string;
  email: string;
  displayName?: string;
  /** scrypt digest, encoded by `hashPassword`. */
  passwordHash: string;
  createdAt: number;
  walletInitialised: boolean;
}

export interface SyncRecordRow {
  userId: string;
  type: string;
  id: string;
  revision: number;
  updatedAt: number;
  deviceId: string;
  data?: unknown;
  deleted?: boolean;
  /** Server-assigned, monotonic per user. Clients page on it. */
  cursor: number;
}

export interface AccountStore {
  findByEmail(email: string): Promise<AccountRecord | null>;
  findById(id: string): Promise<AccountRecord | null>;
  create(account: AccountRecord): Promise<void>;
  /** Records strictly newer than `since`, oldest first. */
  recordsSince(userId: string, since: number): Promise<SyncRecordRow[]>;
  /** Upsert, returning the rows actually written and the new high cursor. */
  putRecords(userId: string, rows: Omit<SyncRecordRow, "cursor">[]): Promise<number>;
  /** Current high-water cursor for a user. */
  cursor(userId: string): Promise<number>;
}

export class InMemoryAccountStore implements AccountStore {
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #records = new Map<string, SyncRecordRow[]>();
  readonly #cursors = new Map<string, number>();

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const needle = normaliseEmail(email);
    for (const account of this.#accounts.values()) {
      if (account.email === needle) return account;
    }
    return null;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.#accounts.get(id) ?? null;
  }

  async create(account: AccountRecord): Promise<void> {
    this.#accounts.set(account.id, account);
  }

  async recordsSince(userId: string, since: number): Promise<SyncRecordRow[]> {
    return (this.#records.get(userId) ?? [])
      .filter((row) => row.cursor > since)
      .sort((a, b) => a.cursor - b.cursor);
  }

  async putRecords(userId: string, rows: Omit<SyncRecordRow, "cursor">[]): Promise<number> {
    const existing = this.#records.get(userId) ?? [];
    let cursor = this.#cursors.get(userId) ?? 0;

    for (const row of rows) {
      const index = existing.findIndex(
        (candidate) => candidate.type === row.type && candidate.id === row.id,
      );
      const current = index === -1 ? undefined : existing[index]!;
      // Last-write-wins, resolved the same way both clients resolve it, so a
      // stale push cannot walk back a newer edit.
      if (current && !supersedes(row, current)) continue;
      cursor += 1;
      const next: SyncRecordRow = { ...row, userId, cursor };
      if (index === -1) existing.push(next);
      else existing[index] = next;
    }

    this.#records.set(userId, existing);
    this.#cursors.set(userId, cursor);
    return cursor;
  }

  async cursor(userId: string): Promise<number> {
    return this.#cursors.get(userId) ?? 0;
  }
}

/** Higher revision wins; then newer timestamp; then the larger device id. */
export function supersedes(
  incoming: { revision: number; updatedAt: number; deviceId: string },
  current: { revision: number; updatedAt: number; deviceId: string },
): boolean {
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;
  return incoming.deviceId > current.deviceId;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const SCRYPT_KEYLEN = 64;

/** `scrypt$<salt-hex>$<hash-hex>`. Node's scrypt, no dependency needed. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = encoded.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  // Node's Buffer.from silently drops invalid hex, so "zz" decodes to an empty
  // buffer. Without this check a corrupt or truncated digest would derive a
  // zero-length key, compare two empty buffers, and accept ANY password.
  if (!isHex(saltHex) || !isHex(hashHex)) return false;

  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

export function newAccountId(): string {
  return `usr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
