import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Goal, GoalUsage, WorkerTask } from "../types";

/** A serializable snapshot of a manager's goal/task state. */
export interface SwarmSnapshot {
  version: 1;
  savedAt: number;
  goals: Goal[];
  tasks: WorkerTask[];
  usage: Record<string, GoalUsage>;
}

/**
 * Durable store for swarm state. Lets a goal's plan, task statuses, verification
 * outcomes, and accounting survive a manager crash or container restart — so an
 * operator can inspect what happened (or a fresh manager can hydrate the record)
 * rather than losing everything when the process dies.
 */
export interface StateStore {
  save(snapshot: SwarmSnapshot): Promise<void>;
  load(): Promise<SwarmSnapshot | null>;
}

/** In-memory store — for tests and single-process runs that don't need disk. */
export class MemoryStateStore implements StateStore {
  private snap: SwarmSnapshot | null = null;
  async save(snapshot: SwarmSnapshot): Promise<void> {
    // Deep-clone so later mutations of live objects don't leak into the snapshot.
    this.snap = JSON.parse(JSON.stringify(snapshot));
  }
  async load(): Promise<SwarmSnapshot | null> {
    return this.snap ? JSON.parse(JSON.stringify(this.snap)) : null;
  }
}

/**
 * JSON file store with atomic writes (write to a temp file, then rename) so a
 * crash mid-write can never corrupt the persisted state. No dependencies.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async save(snapshot: SwarmSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => undefined);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), "utf8");
    await rename(tmp, this.path);
  }

  async load(): Promise<SwarmSnapshot | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as SwarmSnapshot;
    } catch {
      return null;
    }
  }
}
