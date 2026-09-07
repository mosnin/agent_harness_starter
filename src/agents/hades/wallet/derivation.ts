import { createHash } from "node:crypto";
import type { AccountOwner } from "../protocol";

/**
 * Every agent gets its own keys, derived from the workspace's single recovery
 * phrase at its own HD index. That means one phrase backs up every agent, an
 * agent's funds are separable from the user's, and a compromised agent cannot
 * reach another's balance.
 *
 * Indices come from an explicit registry rather than a hash of the agent id:
 * a hash would eventually collide, and two agents sharing an address would be
 * a silent, unrecoverable accounting bug.
 */

/** The human's own accounts always sit at index 0. */
export const USER_ACCOUNT_INDEX = 0;

export function evmPath(index: number): string {
  return `m/44'/60'/0'/0/${index}`;
}

export function solanaPath(index: number): string {
  return `m/44'/501'/${index}'/0'`;
}

export function ownerId(owner: AccountOwner): string {
  return owner.kind === "user" ? `user:${owner.userId}` : `agent:${owner.agentId}`;
}

export interface IndexAssignmentStore {
  read(): Promise<Record<string, number>>;
  write(assignments: Record<string, number>): Promise<void>;
}

export class InMemoryIndexStore implements IndexAssignmentStore {
  #assignments: Record<string, number> = {};

  async read(): Promise<Record<string, number>> {
    return { ...this.#assignments };
  }

  async write(assignments: Record<string, number>): Promise<void> {
    this.#assignments = { ...assignments };
  }
}

/**
 * Hands out a stable HD index per owner. Assignments are persisted, so an
 * agent keeps its address across restarts — an agent whose address moved would
 * lose every incoming payment made to the old one.
 */
export class DerivationIndexRegistry {
  readonly #store: IndexAssignmentStore;
  #assignments: Record<string, number> = {};
  #loaded = false;

  constructor(store: IndexAssignmentStore) {
    this.#store = store;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#assignments = await this.#store.read();
    this.#loaded = true;
  }

  async indexFor(owner: AccountOwner): Promise<number> {
    await this.load();
    if (owner.kind === "user") return USER_ACCOUNT_INDEX;
    const key = ownerId(owner);
    const existing = this.#assignments[key];
    if (existing !== undefined) return existing;

    // Index 0 is reserved for the user, so agents start at 1.
    const used = new Set(Object.values(this.#assignments));
    let next = 1;
    while (used.has(next)) next += 1;
    this.#assignments[key] = next;
    await this.#store.write(this.#assignments);
    return next;
  }

  async assignments(): Promise<Record<string, number>> {
    await this.load();
    return { ...this.#assignments };
  }
}

/**
 * A short, stable fingerprint of an agent id. Used only for labelling, never
 * for key derivation — see the note above about collisions.
 */
export function agentFingerprint(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 8);
}
