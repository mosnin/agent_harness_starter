import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Trust tier assigned to a `platform:user` handle.
 *
 * - `owner`   — the human(s) running this agent; full trust, can issue codes.
 * - `trusted` — paired/linked handle; the wrapped handler sees their messages.
 * - `blocked` — explicitly denied; {@link PairingGuard.wrap} drops them silently.
 *
 * Anything with no {@link TrustRecord} at all is "unknown" — neither trusted
 * nor blocked, gated behind pairing.
 */
export type TrustLevel = "owner" | "trusted" | "blocked";

/**
 * One handle's trust decision. `key` is `platform:user` — the exact same
 * `${ref.platform}:${ref.user}` shape ContinuityRouter / InMemoryIdentityStore
 * use as their internal `refKey` in continuity.ts (channel is intentionally
 * excluded: trust follows the handle, not the room it happened to speak in).
 */
export interface TrustRecord {
  key: string;
  level: TrustLevel;
  identityId?: string;
  addedAt: number;
  note?: string;
}

/**
 * Durable map of `platform:user` handles to trust decisions. In-memory base
 * with a file-backed subclass below, mirroring the exact persistence seam
 * `InMemoryIdentityStore` / `FileIdentityStore` use in continuity.ts so the
 * rest of Hades gets one consistent storage story.
 */
export class InMemoryTrustStore {
  protected records = new Map<string, TrustRecord>();

  /** Look up the trust decision for a handle key, if any. */
  get(key: string): TrustRecord | undefined {
    return this.records.get(key);
  }

  /** Write (or overwrite) a handle's trust decision. */
  set(record: TrustRecord): void {
    this.records.set(record.key, record);
    this.persist();
  }

  /** Erase a handle's trust decision entirely. Returns whether one existed. */
  remove(key: string): boolean {
    const existed = this.records.delete(key);
    if (existed) this.persist();
    return existed;
  }

  all(): TrustRecord[] {
    return [...this.records.values()];
  }

  size(): number {
    return this.records.size;
  }

  /** Time source for subclasses/callers that want a deterministic clock. */
  protected now(): number {
    return Date.now();
  }

  /** Persistence hook; no-op in memory, overridden by {@link FileTrustStore}. */
  protected persist(): void {}
}

/**
 * File-backed {@link InMemoryTrustStore}. Loads synchronously at construction
 * (an absent or corrupted file yields a fresh, empty store — never a throw)
 * and persists synchronously on every mutation using the same atomic
 * write-tmp-then-rename pattern as `FileIdentityStore` in continuity.ts, so a
 * reader never observes a half-written file.
 */
export class FileTrustStore extends InMemoryTrustStore {
  constructor(private readonly path: string) {
    super();
    try {
      const arr = JSON.parse(readFileSync(path, "utf8")) as TrustRecord[];
      for (const r of arr) this.records.set(r.key, r);
    } catch {
      /* absent or corrupted file → fresh store */
    }
  }

  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* directory already exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all()));
    renameSync(tmp, this.path);
  }
}
