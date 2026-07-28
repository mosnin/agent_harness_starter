/* ------------------------------------------------------------------ *
 * Tool catalog — the canonical shapes describing every tool a team's
 * factory can register: what it is, which category it lives in,
 * whether it currently runs for real or as a labelled mock, whether it
 * needs network access, which env keys unlock its real mode, and which
 * verifier (STYX-side) is responsible for checking its output.
 *
 * This module owns the *shapes*, not the tools themselves — teams build
 * `CatalogEntry` values elsewhere and hand them to a `ToolCatalog`
 * (assembled by `ToolsetManager`, see manager.ts). Nothing here touches
 * the network, the clock, or randomness: nothing here has a reason to.
 * ------------------------------------------------------------------ */

import type { Tool } from "../agent/tools";

/** Whether a catalog entry's `Tool.run` really does the thing, or returns a
 *  clearly labelled, deterministic stand-in (e.g. missing env key/network). */
export type ToolMode = "real" | "mock";

/** Coarse grouping used for CLI listing/filtering. */
export type ToolCategory = "web" | "system" | "media" | "data";

/**
 * A minimal fetch abstraction so real-mode tools that need HTTP stay
 * injectable/testable rather than reaching for the global `fetch`
 * directly. Deliberately narrow — just enough surface for GET/POST-style
 * calls with headers and a text body.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: Record<string, string>; text(): Promise<string> }>;

/** Everything a tool factory may need injected instead of reaching for a
 *  global — keeps tools deterministic and unit-testable. */
export interface ToolFactoryOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => number;
}

/** One row of the catalog: a real `Tool` plus the metadata the manager
 *  and CLI need to enable/disable/describe it without inspecting its
 *  implementation. */
export interface CatalogEntry {
  tool: Tool;
  id: string;
  category: ToolCategory;
  mode: ToolMode;
  requiresNetwork: boolean;
  requiredEnvKeys: string[];
  verifierId: string;
  /**
   * Where this tool came from. Omitted means `"builtin"` — a tool this build
   * ships and whose behaviour it owns. Tools inherited over MCP set
   * `"mcp:<server>"` (see `./mcp-catalog.ts`).
   *
   * This exists so a user can always tell OUR tools from someone else's:
   * `hades tools list` prints it as its own column, because "which of these
   * did you write?" is a question about trust, not cosmetics. It is optional
   * so the eight decoupled factory files (which each carry a structural
   * duplicate of this shape) need no change to keep satisfying it.
   */
  source?: string;
}

/** `CatalogEntry.source` for a tool this build ships itself. */
export const BUILTIN_TOOL_SOURCE = "builtin";

const MAX_ID_LENGTH = 128;
/** Conservative, portable tool-id charset: no path separators, no
 *  whitespace, no control/unicode surprises — safe as a registry key, a
 *  JSON-state-file key, and a CLI argument. */
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a catalog id up front so hostile ids (path separators, unicode,
 *  absurd lengths, empty strings) are rejected at the door rather than
 *  silently corrupting state files or registries downstream. */
export function isValidToolId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
  return VALID_ID.test(id);
}

/**
 * An in-memory, name-indexed catalog of `CatalogEntry` values. Pure data
 * structure — no persistence, no enable/disable state (that's
 * `ToolsetManager`'s job).
 */
export class ToolCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  /**
   * Register a catalog entry. Throws on:
   *  - an id that fails `isValidToolId` (path separators, unicode,
   *    empty, too long, leading punctuation, whitespace, ...)
   *  - `entry.id !== entry.tool.name` (the id is the contract; catalog
   *    and registry must agree on what a tool is called)
   *  - a duplicate id already present in this catalog
   */
  add(entry: CatalogEntry): void {
    if (!isValidToolId(entry.id)) {
      throw new Error(`ToolCatalog.add: invalid tool id ${JSON.stringify(entry.id)}`);
    }
    if (entry.id !== entry.tool.name) {
      throw new Error(
        `ToolCatalog.add: id ${JSON.stringify(entry.id)} does not match tool.name ${JSON.stringify(
          entry.tool.name
        )}`
      );
    }
    if (this.entries.has(entry.id)) {
      throw new Error(`ToolCatalog.add: duplicate tool id ${JSON.stringify(entry.id)}`);
    }
    this.entries.set(entry.id, entry);
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Drop an entry, returning whether it was there. Needed by `hades tools mcp
   * remove`, which must be able to unmount a server's tools from the CATALOG
   * THIS PROCESS ALREADY BUILT (a long-lived REPL/TUI session), not merely
   * from the persisted mount file — otherwise an unmounted tool would keep
   * answering until restart, which is precisely the kind of quiet divergence
   * between stated and actual state this codebase refuses to ship.
   */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /** All entries, sorted by tool name (matches `ToolRegistry.list()`'s
   *  sort so CLI output and registry contents read consistently). */
  list(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  byCategory(category: ToolCategory): CatalogEntry[] {
    return this.list().filter((e) => e.category === category);
  }
}
