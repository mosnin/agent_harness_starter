/**
 * Central assembly of the shipped tool catalog — the one place the product
 * (CLI `hades tools`, `hades exec`, the REPL, the desktop sidecar) gets its
 * `ToolCatalog`/`ToolsetManager` from.
 *
 * The individual tool factories were deliberately built decoupled (each file
 * carries structural duplicates of the catalog shapes and never imports
 * another team's file); this module is the integration layer that was
 * explicitly left to central wiring: it imports every factory, hands their
 * entries to the canonical `ToolCatalog`, and exposes a `ToolsetManager`
 * with a durable state file.
 *
 * REAL vs MOCK is decided by each factory itself, honestly, at construction:
 *  - `web_search` is real iff BRAVE_SEARCH_API_KEY is set AND a fetch
 *    transport exists; `fetch_extract`/`http_request` are real iff a fetch
 *    transport exists; `image_gen`/`tts`/`vision_describe` are real iff
 *    their provider key is set AND a fetch transport exists. Otherwise each
 *    runs its deterministic, clearly "[mock]"-labelled fallback.
 *  - `file_ops` and `shell` are always real (root-jailed / allowlist-gated).
 * This module never overrides a factory's mode decision; it only supplies
 * (or, with `offline: true`, withholds) the real `fetch` transport.
 *
 * BEYOND THE NINE: MOUNTED MCP TOOLS. The catalog is also where tools this
 * build did NOT write appear. When mounts exist (`hades tools mcp add`,
 * persisted at `<dataDir>/mcp-servers.json`), their tools are added here as
 * ordinary entries under namespaced ids (`mcp.<server>.<tool>`) — the strategy
 * from `.plans/HADES_BEYOND_HERMES.md` Phase 1: inherit the ecosystem over one
 * protocol instead of rebuilding ninety tools. Two properties are deliberate:
 * building the catalog still spawns NOTHING (the entries dial out only when
 * called, so `hades tools list` stays instant and side-effect-free), and a
 * mounted tool has no mock mode at all — an unreachable server produces an
 * honest error, never a stand-in (see `./mcp-catalog.ts` for why).
 */

import { ToolCatalog, type CatalogEntry, type FetchLike } from "./catalog";
import {
  ToolsetManager,
  InMemoryToolStateStore,
  JsonFileToolStateStore,
  type ToolStateStore,
  type ToolsetManagerOptions,
} from "./manager";
import { createBrowserTool, type BrowseRunner } from "../browser/tool";
import { createWebSearchTool } from "./web-search";
import { createFetchExtractTool } from "./fetch-extract";
import { createFileOpsTool } from "./file-ops";
import { createShellTool, type ShellPolicy } from "./shell";
import { createHttpTool } from "./http";
import { createImageGenTool } from "./image-gen";
import { createTtsTool } from "./tts";
import { createVisionDescribeTool } from "./vision";
import {
  JsonFileMcpMountStore,
  mcpCatalogEntries,
  type McpMountRecord,
  type McpMountStore,
} from "./mcp-catalog";
import type { McpMountDeps } from "../mcp/mount";

/** The nine shipped catalog tool ids, in catalog (name-sorted) order. */
export const DEFAULT_CATALOG_TOOL_IDS = [
  "browser",
  "fetch_extract",
  "file_ops",
  "http_request",
  "image_gen",
  "shell",
  "tts",
  "vision_describe",
  "web_search",
] as const;

/**
 * Conservative default `shell` allowlist: read-only inspection commands plus
 * `git`. Deliberately excludes interpreters (`node`, `python3`, `sh`) — the
 * sandboxed `execute_code` tool is the supported way to run code — and
 * anything that mutates the filesystem (`rm`, `mv`, `chmod`, ...), which
 * belongs to the root-jailed `file_ops` tool. Operators widen this
 * explicitly via `DefaultCatalogOptions.shellPolicy`.
 */
export const DEFAULT_SHELL_ALLOWED_COMMANDS: readonly string[] = [
  "echo",
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "date",
  "uname",
  "whoami",
  "git",
];

/**
 * Adapt the platform's global `fetch` into the catalog's narrow `FetchLike`
 * shape. Returns `undefined` when no global fetch exists (ancient Node), in
 * which case every network tool honestly falls back to its mock mode.
 */
export function realFetchLike(): FetchLike | undefined {
  const f = (globalThis as { fetch?: typeof globalThis.fetch }).fetch;
  if (typeof f !== "function") return undefined;
  return async (url, init) => {
    const res = await f(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, text: () => res.text() };
  };
}

export interface DefaultCatalogOptions {
  /** Env the factories read provider keys from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Fetch transport for network tools. Default: `realFetchLike()`.
   *  Ignored when `offline` is true. */
  fetchFn?: FetchLike;
  /** Force every network tool into its deterministic mock mode by
   *  withholding the fetch transport. Default false. */
  offline?: boolean;
  /** Jail root for `file_ops`. Default: `process.cwd()`. */
  fileRoot?: string;
  /** `shell` gate policy. Default: `DEFAULT_SHELL_ALLOWED_COMMANDS`. */
  shellPolicy?: ShellPolicy;
  /** Optional strict host allowlist for `http_request` (applied after the
   *  built-in SSRF deny matrix, never instead of it). */
  httpAllowHosts?: string[];
  /** Override the browse runner backing the `browser` tool (tests inject a
   *  stub). Default: the real driver+extract+trace composition from
   *  `../browser/runner`, loaded lazily on first browse so constructing a
   *  catalog never pays for (or requires) `playwright-core`. When `offline`
   *  is true the runner is withheld entirely — `browser` honestly mocks. */
  browseRunner?: BrowseRunner;
  /** Playwright browsers cache dir for the `browser` tool's Chromium probe
   *  (default: PLAYWRIGHT_BROWSERS_PATH from `env`, else /opt/pw-browsers). */
  browsersPath?: string;
  /** Override the `browser` tool's Chromium-installed probe (tests). */
  probeChromium?: (browsersPath: string) => boolean;
  /** Mounted MCP servers to inherit tools from. Wins over `mcpMountStore`
   *  and `mcpStatePath` (tests pass records directly). */
  mcpServers?: McpMountRecord[];
  /** Store the mounts are read from. Wins over `mcpStatePath`. */
  mcpMountStore?: McpMountStore;
  /** Durable mount file (e.g. `<dataDir>/mcp-servers.json`). Omitted =>
   *  no mounts are read and the catalog is the shipped nine. */
  mcpStatePath?: string;
  /** Seams for MCP mount operations (spawn/fetch/env). Defaults to the real
   *  `child_process.spawn` plus this catalog's own fetch transport — which
   *  `offline: true` withholds, so an HTTP-mounted server then fails
   *  honestly instead of pretending. A stdio-mounted server is a local
   *  subprocess and keeps working offline, which is the truth. */
  mcpMount?: McpMountDeps;
}

/**
 * The default `browser` runner: the real driver+extract+trace composition,
 * imported lazily at first call. Laziness matters twice over: catalog
 * construction stays instant (no `playwright-core` module load on every
 * `hades` CLI startup), and an environment without `playwright-core`
 * installed still builds a working catalog — the browse itself then fails
 * honestly (`ok:false`, mapped to `browse-failed` by the tool) instead of
 * crashing the whole product at import time.
 */
function lazyBrowseRunner(): BrowseRunner {
  return async (req) => {
    const { createBrowseRunner } = await import("../browser/runner");
    return createBrowseRunner()(req);
  };
}

/**
 * Resolve the mounted-MCP-server records this catalog should inherit tools
 * from, in precedence order: explicit records, then an explicit store, then a
 * state file, then nothing. Reading is failure-tolerant by the store's own
 * contract — an unreadable or corrupt mount file yields no mounts rather than
 * breaking every `hades` invocation.
 */
function resolveMcpRecords(opts: DefaultCatalogOptions): McpMountRecord[] {
  if (opts.mcpServers !== undefined) return opts.mcpServers;
  if (opts.mcpMountStore !== undefined) return opts.mcpMountStore.load();
  if (opts.mcpStatePath !== undefined) return new JsonFileMcpMountStore(opts.mcpStatePath).load();
  return [];
}

/**
 * Build the canonical `ToolCatalog` containing all nine shipped tools
 * (the Phase 2 eight plus the Phase 3 `browser` tool, whose real mode
 * additionally requires an installed Chromium found by its own fs probe),
 * plus one entry per tool inherited from every mounted MCP server.
 * Every entry passes `ToolCatalog.add`'s id/name/duplicate validation on the
 * way in, so a factory drifting from its declared id fails loudly here.
 */
export function defaultToolCatalog(opts: DefaultCatalogOptions = {}): ToolCatalog {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const fetchFn = opts.offline ? undefined : opts.fetchFn ?? realFetchLike();
  const fileRoot = opts.fileRoot ?? process.cwd();
  const shellPolicy: ShellPolicy =
    opts.shellPolicy ?? { allowedCommands: [...DEFAULT_SHELL_ALLOWED_COMMANDS] };

  const entries: CatalogEntry[] = [
    createBrowserTool({
      env,
      ...(opts.browsersPath !== undefined ? { browsersPath: opts.browsersPath } : {}),
      ...(opts.probeChromium !== undefined ? { probeChromium: opts.probeChromium } : {}),
      // Offline withholds the runner entirely, forcing honest mock mode —
      // the same switch that withholds the fetch transport from the
      // network tools. The tool itself still requires a real on-disk
      // Chromium (its own fs probe) before it will claim "real".
      ...(opts.offline ? {} : { runner: opts.browseRunner ?? lazyBrowseRunner() }),
    }),
    createWebSearchTool({ env, fetchFn }),
    createFetchExtractTool({ env, fetchFn }),
    createFileOpsTool({ env, root: fileRoot }),
    createShellTool({ env, policy: shellPolicy }),
    createHttpTool({ env, fetchFn, allowHosts: opts.httpAllowHosts }),
    createImageGenTool({ env, fetchFn }),
    createTtsTool({ env, fetchFn }),
    createVisionDescribeTool({ env, fetchFn }),
  ];

  const catalog = new ToolCatalog();
  for (const entry of entries) catalog.add(entry);

  // Inherited MCP tools, added after the builtins. Their ids are namespaced
  // (`mcp.<server>.<tool>`), so a collision with a builtin is structurally
  // impossible; a collision BETWEEN two mounts of the same name would throw
  // here, which is correct — two servers claiming one name is a real conflict,
  // not something to resolve by silently picking one.
  const mcpRecords = resolveMcpRecords(opts);
  if (mcpRecords.length > 0) {
    const mountDeps: McpMountDeps = {
      env,
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      ...(opts.mcpMount ?? {}),
    };
    for (const entry of mcpCatalogEntries(mcpRecords, mountDeps)) catalog.add(entry);
  }

  return catalog;
}

export interface DefaultToolsetOptions extends DefaultCatalogOptions {
  /** Durable enable/disable state file (e.g. `<dataDir>/tools.json`).
   *  Omitted => non-durable in-memory state (tests, ephemeral runs). */
  statePath?: string;
  /** Full custom store; wins over `statePath`. */
  store?: ToolStateStore;
  /** Forwarded to `ToolsetManager` (e.g. `defaultEnabled`). */
  manager?: ToolsetManagerOptions;
}

/**
 * The product's `ToolsetManager`: the default catalog over a durable JSON
 * state store. This is what `buildHadesCli` wires into `hades tools` and
 * `hades exec`.
 */
export function defaultToolsetManager(opts: DefaultToolsetOptions = {}): ToolsetManager {
  const store =
    opts.store ??
    (opts.statePath !== undefined
      ? new JsonFileToolStateStore(opts.statePath)
      : new InMemoryToolStateStore());
  return new ToolsetManager(defaultToolCatalog(opts), store, opts.manager);
}
