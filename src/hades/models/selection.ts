import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The persisted current-model choice. */
export interface SelectionState {
  modelId?: string;
  updatedAt?: number;
}

/**
 * Durable "which model am I using" store. In-memory base + atomic-write file
 * subclass, matching the persistence seam the rest of Hades uses. Kept separate
 * from the registry so the selection survives restarts while the catalog is
 * rebuilt from config each boot.
 */
export class InMemoryModelSelection {
  protected state: SelectionState = {};

  constructor(protected readonly now: () => number = () => Date.now()) {}

  get(): string | undefined {
    return this.state.modelId;
  }

  set(modelId: string): void {
    this.state = { modelId, updatedAt: this.now() };
    this.persist();
  }

  clear(): void {
    this.state = {};
    this.persist();
  }

  protected persist(): void {}
}

export class FileModelSelection extends InMemoryModelSelection {
  constructor(
    private readonly path: string,
    now: () => number = () => Date.now()
  ) {
    super(now);
    try {
      this.state = JSON.parse(readFileSync(path, "utf8")) as SelectionState;
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }
}
