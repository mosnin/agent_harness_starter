/* ------------------------------------------------------------------ *
 * ToolsetManager — enable/disable state over a ToolCatalog, durable
 * across process restarts, and the single place that assembles a
 * `ToolRegistry` out of whichever catalog entries are currently
 * enabled.
 *
 * The manager never decides `mode` (real vs mock) — that is baked into
 * each `CatalogEntry` by whoever built it. The manager only decides
 * *whether a tool is available at all* (enabled/disabled) and persists
 * that decision.
 * ------------------------------------------------------------------ */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ToolRegistry, builtinRegistry } from "../agent/tools";
import { BUILTIN_TOOL_SOURCE } from "./catalog";
import type { ToolCatalog, ToolCategory, ToolMode } from "./catalog";

/** Durable enable/disable state, keyed by tool id. */
export interface ToolStateStore {
  /** Return the persisted state, or `undefined` if none exists / it is
   *  unreadable (missing file, corrupt JSON, empty file, ...). Must
   *  never throw. */
  load(): Record<string, boolean> | undefined;
  /** Persist the full enable/disable state. May throw (the manager is
   *  responsible for surfacing that without corrupting its in-memory
   *  view — see `ToolsetManager.enable`/`disable`). */
  save(state: Record<string, boolean>): void;
}

/** Non-durable store: useful as a default / in tests. */
export class InMemoryToolStateStore implements ToolStateStore {
  private state: Record<string, boolean> | undefined;

  load(): Record<string, boolean> | undefined {
    return this.state === undefined ? undefined : { ...this.state };
  }

  save(state: Record<string, boolean>): void {
    this.state = { ...state };
  }
}

/**
 * Real, durable store backed by a JSON file on disk. Writes are
 * atomic (write to a sibling tmp file, then rename over the target) so
 * a crash mid-write can never leave a half-written state file behind.
 * The parent directory is created (`mkdir -p`) on demand. `load()`
 * never throws: a missing file, an empty file, or corrupt JSON all
 * simply yield `undefined` so callers fall back to defaults.
 */
export class JsonFileToolStateStore implements ToolStateStore {
  constructor(private readonly filePath: string) {}

  load(): Record<string, boolean> | undefined {
    let raw: string;
    try {
      if (!existsSync(this.filePath)) return undefined;
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return undefined;
    }
    if (raw.trim() === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  }

  save(state: Record<string, boolean>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

export interface ToolStatus {
  id: string;
  category: ToolCategory;
  mode: ToolMode;
  enabled: boolean;
  requiresNetwork: boolean;
  requiredEnvKeys: string[];
  verifierId: string;
  description: string;
  /** `"builtin"`, or `"mcp:<server>"` for a tool inherited over MCP. Always
   *  populated here (the catalog's optional field is defaulted), so every
   *  consumer of `status()` can show provenance without a fallback. */
  source: string;
}

export interface ToolsetManagerOptions {
  /** Enabled-by-default value for a catalog entry with no persisted
   *  state and no prior in-memory decision. Default `true`. */
  defaultEnabled?: boolean;
}

/**
 * Enable/disable state over a `ToolCatalog`, persisted through a
 * `ToolStateStore`. Persisted state may reference ids that have since
 * left the catalog (a tool was removed from a build); those stale
 * keys are preserved verbatim in memory and re-persisted as-is on the
 * next save, but never surfaced through `status()`/`buildRegistry()`
 * (which both iterate the *catalog*, not the stored keys) — so a
 * catalog shrink never silently drops a user's other preferences, and
 * a catalog regrowth (the id comes back) picks the old preference back
 * up automatically.
 */
export class ToolsetManager {
  private readonly store: ToolStateStore;
  private readonly defaultEnabled: boolean;
  /** In-memory mirror of persisted state; source of truth for
   *  `isEnabled`/`status` even if a `save()` call throws. */
  private state: Record<string, boolean>;
  /** Set when the most recent `save()` threw; surfaced via `lastSaveError`
   *  and folded into `status()` isn't required by the contract, but we
   *  keep it so callers can inspect it if they want to. */
  private lastSaveError: string | undefined;

  constructor(
    private readonly catalog: ToolCatalog,
    store?: ToolStateStore,
    opts?: ToolsetManagerOptions
  ) {
    this.store = store ?? new InMemoryToolStateStore();
    this.defaultEnabled = opts?.defaultEnabled ?? true;
    this.state = this.store.load() ?? {};
  }

  /** The error message from the most recent failed `save()`, if any. */
  getLastSaveError(): string | undefined {
    return this.lastSaveError;
  }

  private persist(): void {
    try {
      this.store.save(this.state);
      this.lastSaveError = undefined;
    } catch (err) {
      this.lastSaveError = err instanceof Error ? err.message : String(err);
    }
  }

  enable(id: string): boolean {
    if (!this.catalog.get(id)) return false;
    this.state = { ...this.state, [id]: true };
    this.persist();
    return true;
  }

  disable(id: string): boolean {
    if (!this.catalog.get(id)) return false;
    this.state = { ...this.state, [id]: false };
    this.persist();
    return true;
  }

  isEnabled(id: string): boolean {
    const entry = this.catalog.get(id);
    if (!entry) return false;
    const stored = this.state[id];
    return stored === undefined ? this.defaultEnabled : stored;
  }

  /**
   * The catalog this manager manages. Exposed (read-only by convention) so a
   * command that changes the catalog's CONTENTS rather than its enable/disable
   * state — `hades tools mcp add|remove`, which mounts and unmounts inherited
   * MCP tools — can act on the catalog the current process is already using,
   * instead of only on the persisted file the next process will read.
   */
  getCatalog(): ToolCatalog {
    return this.catalog;
  }

  status(): ToolStatus[] {
    return this.catalog.list().map((entry) => ({
      id: entry.id,
      category: entry.category,
      mode: entry.mode,
      enabled: this.isEnabled(entry.id),
      requiresNetwork: entry.requiresNetwork,
      requiredEnvKeys: [...entry.requiredEnvKeys],
      verifierId: entry.verifierId,
      description: entry.tool.description,
      source: entry.source ?? BUILTIN_TOOL_SOURCE,
    }));
  }

  /**
   * Build a `ToolRegistry` starting from `base` (defaults to a fresh
   * `builtinRegistry()`), registering every currently-enabled catalog
   * entry on top of it. Throws rather than silently overwriting if an
   * enabled entry's id collides with a name already present in `base`
   * (e.g. a catalog entry named `calc` colliding with the real builtin
   * `calc` tool) — shadowing a builtin is always a configuration bug,
   * never a feature.
   */
  buildRegistry(base?: ToolRegistry): ToolRegistry {
    const registry = base ?? builtinRegistry();
    const existing = new Set(registry.names());
    for (const entry of this.catalog.list()) {
      if (!this.isEnabled(entry.id)) continue;
      if (existing.has(entry.id)) {
        throw new Error(
          `ToolsetManager.buildRegistry: catalog entry ${JSON.stringify(
            entry.id
          )} would shadow an existing registry tool of the same name`
        );
      }
      registry.register(entry.tool);
      existing.add(entry.id);
    }
    return registry;
  }
}
