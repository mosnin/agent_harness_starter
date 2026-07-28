/* ------------------------------------------------------------------ *
 * MCP mounts in the tool catalog — inherited tools, standing next to
 * the built-in ones.
 *
 * WHY THIS EXISTS. Hades ships nine catalog tools. The comparable
 * product ships forty-plus tools and a hundred-plus skills. The plan
 * (`.plans/HADES_BEYOND_HERMES.md`, Phase 1) is explicit that the answer
 * is NOT to write eighty more tool files: "speak MCP so Hades inherits
 * the entire Hermes/Anthropic tool ecosystem *for free* rather than
 * rebuilding 90 tools. This is how we neutralize Hermes' breadth
 * advantage with one protocol." `mcp/mount.ts` can talk to a server;
 * this module is where a talked-to server becomes REAL CATALOG ENTRIES,
 * reached through exactly the same `Tool.run(input)` contract a caller
 * uses for `shell` or `http_request`. No caller needs to know the tool
 * came from somewhere else.
 *
 * HOW FAR THAT ACTUALLY REACHES TODAY — measured, not aspirational.
 * `ToolsetManager.buildRegistry()` is the only thing that puts catalog
 * entries into a registry, and it has exactly ONE production caller:
 * `../cli/cli.ts`'s `exec`. So `hades exec` reaches inherited tools and
 * nothing else does yet. `../agent/runner.ts` defaults to
 * `builtinRegistry()`; `../cli/chat-command.ts` and
 * `../cli/tui-command.ts` never touch the toolset; `mcpSwarmTools()` in
 * `./mcp-swarm-tools.ts` is a proven, tested bridge with zero production
 * callers, because the swarm's `ToolBox` is populated from skills and
 * inventing a seam there was out of scope. This is the same reach the
 * BUILTIN catalog tools have — they are exec-only too — so nothing is
 * regressed. It is written down because an earlier version of this
 * header named the ReAct loop, the swarm and the TUI, and a header is
 * the artifact the next reader trusts.
 *
 * FOUR DESIGN RULES, ALL LOAD-BEARING:
 *
 *  1. NAMESPACED IDS. Every mounted tool is `mcp.<server>.<tool>`, so a
 *     foreign server can never shadow a builtin (`shell`, `file_ops`, …)
 *     or another server's tool of the same name. `ToolCatalog.add`
 *     enforces the id charset; anything a server offers that cannot be
 *     represented is SKIPPED and reported, never silently renamed into
 *     something the operator did not ask for.
 *
 *  2. NO MOCK MODE — EVER. Every other network-touching tool in this
 *     catalog degrades to a clearly-labelled `[mock]` when its key or
 *     transport is missing. A mounted MCP tool has no honest mock: we do
 *     not know what someone else's tool does, so a stand-in would be
 *     fabrication. Mounted entries are therefore always `mode: "real"`,
 *     and a server that cannot be reached produces `ok:false` with an
 *     error naming the server, the endpoint, and the reason. Silence and
 *     invention are both excluded by construction.
 *
 *  3. THE ENTRY IS INERT UNTIL CALLED. Building catalog entries spawns
 *     nothing and opens no socket — `hades tools list` must stay a
 *     read-only, instant, side-effect-free command even with a dozen
 *     servers mounted. The connection happens inside `run`, per call,
 *     and is closed in a `finally` (see `mcp/mount.ts` for why per-call
 *     beats a pool here).
 *
 *  4. PROVENANCE IS AUTOMATIC. Because a mounted tool is an ordinary
 *     `Tool` in the ordinary `ToolRegistry`, every call through
 *     `hades exec` lands in the same hash-chained STYX provenance ledger
 *     as a builtin call, with the same input/output hashes. Inheriting
 *     breadth does not mean inheriting unverifiability.
 *
 * VERIFIERS, HONESTLY. Built-in entries name a calibrated STYX verifier.
 * A third-party tool has none — we have no calibration data for someone
 * else's output format, and inventing a number would be exactly the
 * fabrication this codebase forbids. Mounted entries therefore carry the
 * self-announcing sentinel {@link MCP_UNVERIFIED_VERIFIER_ID}, which is
 * deliberately NOT registered in `toolVerifiers()`: `hades tools info`
 * shows it verbatim, so the absence of verification is visible rather
 * than implied.
 * ------------------------------------------------------------------ */

import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "../agent/tools";
import { isValidToolId, type CatalogEntry } from "./catalog";
import {
  callMcpServerTool,
  declaredEnvKeys,
  describeMcpEndpoint,
  type McpMountDeps,
  type McpServerSpec,
} from "../mcp/mount";

/** Prefix of every mounted tool id: `mcp.<server>.<tool>`. */
export const MCP_TOOL_ID_PREFIX = "mcp";

/** `CatalogEntry.source` value for a tool inherited from server `<name>`. */
export function mcpSource(server: string): string {
  return `mcp:${server}`;
}

/**
 * The verifier id mounted tools carry. NOT registered in `toolVerifiers()`, on
 * purpose: there is no calibrated STYX verifier for a third party's output
 * format, and this sentinel says so out loud instead of borrowing a number
 * that was measured on something else.
 */
export const MCP_UNVERIFIED_VERIFIER_ID = "unverified.mcp-inherited";

/** Legal mount names: conservative, and free of the `.` the id namespace uses. */
const VALID_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidMcpServerName(name: string): boolean {
  return typeof name === "string" && VALID_SERVER_NAME.test(name);
}

/** One tool as the server advertised it at mount time. */
export interface McpMountedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * A persisted mount: the spec needed to reconnect, when it was mounted, who
 * answered, and the tool listing captured at that moment.
 *
 * The listing is a CACHE, and every surface that prints it says so. It exists
 * because the catalog is rebuilt on every CLI invocation and re-probing every
 * server on every `hades tools list` would spawn processes behind a read-only
 * command. A cached listing can go stale; that is why `hades tools mcp list
 * --probe` exists (it re-connects for real) and why a call always dispatches to
 * the live server rather than trusting the cache for anything but names.
 */
export interface McpMountRecord {
  spec: McpServerSpec;
  mountedAt: number;
  server?: { name?: string; version?: string };
  tools: McpMountedTool[];
}

/** Durable set of mounts. Mirrors `ToolStateStore`'s never-throw contract. */
export interface McpMountStore {
  /** All mounts, or `[]` when absent/unreadable. Must never throw. */
  load(): McpMountRecord[];
  /** Persist the full mount set. May throw (the caller surfaces it). */
  save(records: McpMountRecord[]): void;
}

/** Non-durable store: the default for tests and ephemeral runs. */
export class InMemoryMcpMountStore implements McpMountStore {
  private records: McpMountRecord[] = [];

  constructor(initial: McpMountRecord[] = []) {
    this.records = initial.map(cloneRecord);
  }

  load(): McpMountRecord[] {
    return this.records.map(cloneRecord);
  }

  save(records: McpMountRecord[]): void {
    this.records = records.map(cloneRecord);
  }
}

/** On-disk file shape (`<dataDir>/mcp-servers.json`). */
interface McpMountFile {
  version: 1;
  servers: McpMountRecord[];
}

/**
 * Durable store backed by a JSON file, written atomically (temp file +
 * rename) exactly like `JsonFileToolStateStore`, so a crash mid-write cannot
 * leave a half-written mount set. `load()` never throws: missing, empty,
 * corrupt, or partially-invalid content degrades to the valid records only —
 * a garbage entry is dropped rather than crashing every `hades` invocation.
 */
export class JsonFileMcpMountStore implements McpMountStore {
  constructor(private readonly filePath: string) {}

  load(): McpMountRecord[] {
    let raw: string;
    try {
      if (!existsSync(this.filePath)) return [];
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    if (raw.trim() === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const servers = (parsed as Partial<McpMountFile>).servers;
    if (!Array.isArray(servers)) return [];
    const out: McpMountRecord[] = [];
    const seen = new Set<string>();
    for (const candidate of servers) {
      const record = validateMountRecord(candidate);
      if (!record) continue;
      if (seen.has(record.spec.name)) continue;
      seen.add(record.spec.name);
      out.push(record);
    }
    return out;
  }

  save(records: McpMountRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const file: McpMountFile = { version: 1, servers: records.map(cloneRecord) };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

function cloneRecord(record: McpMountRecord): McpMountRecord {
  return JSON.parse(JSON.stringify(record)) as McpMountRecord;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Shape-check one persisted record. Returns `undefined` for anything that is
 * not a mount this build can actually reconnect to — a truncated file or a
 * record written by a future version is dropped, not guessed at.
 */
export function validateMountRecord(value: unknown): McpMountRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Partial<McpMountRecord> & Record<string, unknown>;
  const spec = raw.spec as Partial<McpServerSpec> & Record<string, unknown>;
  if (spec === null || typeof spec !== "object") return undefined;
  if (typeof spec.name !== "string" || !isValidMcpServerName(spec.name)) return undefined;

  let validSpec: McpServerSpec;
  if (spec.transport === "stdio") {
    if (typeof spec.command !== "string" || spec.command === "") return undefined;
    const args = spec.args === undefined ? [] : spec.args;
    if (!isStringArray(args)) return undefined;
    validSpec = {
      name: spec.name,
      transport: "stdio",
      command: spec.command,
      args,
      ...(typeof spec.cwd === "string" ? { cwd: spec.cwd } : {}),
      ...(isStringArray(spec.requiresEnv) ? { requiresEnv: spec.requiresEnv } : {}),
      ...(typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs)
        ? { timeoutMs: spec.timeoutMs }
        : {}),
    };
  } else if (spec.transport === "http") {
    if (typeof spec.url !== "string" || spec.url === "") return undefined;
    const headerEnv: Record<string, string> = {};
    if (spec.headerEnv !== null && typeof spec.headerEnv === "object" && !Array.isArray(spec.headerEnv)) {
      for (const [header, varName] of Object.entries(spec.headerEnv as Record<string, unknown>)) {
        if (typeof varName === "string" && varName !== "") headerEnv[header] = varName;
      }
    }
    validSpec = {
      name: spec.name,
      transport: "http",
      url: spec.url,
      ...(Object.keys(headerEnv).length > 0 ? { headerEnv } : {}),
      ...(isStringArray(spec.requiresEnv) ? { requiresEnv: spec.requiresEnv } : {}),
      ...(typeof spec.timeoutMs === "number" && Number.isFinite(spec.timeoutMs)
        ? { timeoutMs: spec.timeoutMs }
        : {}),
    };
  } else {
    return undefined;
  }

  const tools: McpMountedTool[] = [];
  if (Array.isArray(raw.tools)) {
    for (const candidate of raw.tools) {
      if (candidate === null || typeof candidate !== "object") continue;
      const tool = candidate as Partial<McpMountedTool>;
      if (typeof tool.name !== "string" || tool.name === "") continue;
      tools.push({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      });
    }
  }

  const server = raw.server;
  return {
    spec: validSpec,
    mountedAt: typeof raw.mountedAt === "number" && Number.isFinite(raw.mountedAt) ? raw.mountedAt : 0,
    ...(server !== null && typeof server === "object"
      ? {
          server: {
            ...(typeof (server as { name?: unknown }).name === "string"
              ? { name: (server as { name: string }).name }
              : {}),
            ...(typeof (server as { version?: unknown }).version === "string"
              ? { version: (server as { version: string }).version }
              : {}),
          },
        }
      : {}),
    tools,
  };
}

/**
 * The catalog id for one mounted tool, or `undefined` when the server's name
 * for it cannot be represented as a catalog id at all.
 *
 * Sanitization is deliberately minimal and lossless-looking-but-declared:
 * characters outside the catalog's charset become `_`. Any collision that
 * creates is caught by the caller ({@link planMcpEntries}), which SKIPS the
 * colliding tool and reports it, rather than quietly binding an id to the
 * wrong remote tool.
 */
export function mcpToolId(server: string, toolName: string): string | undefined {
  if (!isValidMcpServerName(server)) return undefined;
  if (typeof toolName !== "string" || toolName === "") return undefined;
  const sanitized = toolName.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === "" || /^[._-]*$/.test(sanitized)) return undefined;
  const id = `${MCP_TOOL_ID_PREFIX}.${server}.${sanitized}`;
  return isValidToolId(id) ? id : undefined;
}

/** A tool the mount could not represent locally, with the reason. */
export interface SkippedMcpTool {
  name: string;
  reason: string;
}

export interface McpEntryPlan {
  entries: CatalogEntry[];
  skipped: SkippedMcpTool[];
}

/** Render a JSON-Schema-ish `inputSchema` as a one-line argument hint. */
export function describeInputSchema(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return "a JSON object";
  const props = (schema as { properties?: unknown }).properties;
  if (props === null || typeof props !== "object") return "a JSON object";
  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter((r) => typeof r === "string") as string[])
      : []
  );
  const parts = Object.entries(props as Record<string, unknown>).map(([key, value]) => {
    const type =
      value !== null && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : "any";
    return `${key}${required.has(key) ? "" : "?"}: ${type}`;
  });
  return parts.length === 0 ? "a JSON object" : `{ ${parts.join(", ")} }`;
}

/**
 * The single required string property of a schema, if it has exactly one
 * property and that property is a required string. Used for the ONE input
 * convenience below — and reported in the output, never applied invisibly.
 */
function soleRequiredStringProp(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const props = (schema as { properties?: unknown }).properties;
  if (props === null || typeof props !== "object") return undefined;
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const [key, value] = entries[0];
  const type =
    value !== null && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  if (type !== "string") return undefined;
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required) || !required.includes(key)) return undefined;
  return key;
}

type ArgParse =
  | { ok: true; args: Record<string, unknown>; shape: string }
  | { ok: false; error: string };

/**
 * Turn a Hades tool's raw string input into MCP `arguments`.
 *
 *  - `""`             -> `{}`                      (shape `empty`)
 *  - a JSON object    -> itself                    (shape `json`)
 *  - any other text   -> `{ <sole required string prop>: text }`, but ONLY when
 *                        the server's schema has exactly one such property
 *                        (shape `wrapped:<prop>`). The shape is echoed in the
 *                        result so this convenience is never invisible.
 *  - anything else    -> an error naming the expected shape.
 */
export function parseMcpToolInput(input: string, schema: unknown): ArgParse {
  const text = (input ?? "").trim();
  if (text === "") return { ok: true, args: {}, shape: "empty" };

  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        error: `input is not valid JSON (${
          err instanceof Error ? err.message : String(err)
        }); expected ${describeInputSchema(schema)}`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `input JSON must be an object; expected ${describeInputSchema(schema)}` };
    }
    return { ok: true, args: parsed as Record<string, unknown>, shape: "json" };
  }

  const sole = soleRequiredStringProp(schema);
  if (sole !== undefined) {
    return { ok: true, args: { [sole]: input }, shape: `wrapped:${sole}` };
  }

  return {
    ok: false,
    error: `input must be a JSON object matching ${describeInputSchema(
      schema
    )} (this tool takes more than one argument, so bare text cannot be mapped to it)`,
  };
}

/**
 * Build the catalog entries for one mount, plus the honest list of anything
 * that could not be represented locally.
 *
 * Nothing here connects: the returned entries hold only the spec and the
 * injected seams, and dial out on `run`.
 */
export function planMcpEntries(record: McpMountRecord, deps: McpMountDeps = {}): McpEntryPlan {
  const entries: CatalogEntry[] = [];
  const skipped: SkippedMcpTool[] = [];
  const claimed = new Set<string>();
  const server = record.spec.name;
  const envKeys = declaredEnvKeys(record.spec);

  for (const mounted of record.tools) {
    const id = mcpToolId(server, mounted.name);
    if (id === undefined) {
      skipped.push({
        name: mounted.name,
        reason: "the server's name for it cannot be represented as a catalog id",
      });
      continue;
    }
    if (claimed.has(id)) {
      skipped.push({
        name: mounted.name,
        reason: `it maps to the already-claimed id ${id} (two of this server's tool names differ only by characters the catalog id charset does not allow)`,
      });
      continue;
    }
    claimed.add(id);

    entries.push({
      id,
      tool: mcpTool(id, record.spec, mounted, deps),
      // The catalog's category enum has no "inherited" member and inventing
      // one for someone else's tool would be a guess; `source` carries the
      // truth (and is what `hades tools list` shows).
      category: "data",
      // Always real: there is no honest mock for a third party's tool. An
      // unreachable server yields ok:false with a reason — never a stand-in.
      mode: "real",
      requiresNetwork: record.spec.transport === "http",
      requiredEnvKeys: envKeys,
      verifierId: MCP_UNVERIFIED_VERIFIER_ID,
      source: mcpSource(server),
    });
  }

  return { entries, skipped };
}

/** Catalog entries for every mount in `records` (skips are dropped silently
 *  here; use {@link planMcpEntries} when you need to report them). */
export function mcpCatalogEntries(records: McpMountRecord[], deps: McpMountDeps = {}): CatalogEntry[] {
  return records.flatMap((record) => planMcpEntries(record, deps).entries);
}

/**
 * The `Tool` behind one mounted MCP tool. Its result contract (a JSON string,
 * like every other catalog tool):
 *
 *   { mode:"real", source, server, tool, argShape, ok:true,  text, content }
 *   { mode:"real", source, server, tool, argShape, ok:false, error }
 *
 * `ok:false` covers BOTH an unreachable server and a tool that reported
 * `isError` — but the two are distinguishable: a tool-level failure carries
 * `isError:true` alongside the server's own text, while a transport failure
 * carries `error`. `mode` is always `"real"`, because it always is: this tool
 * has no mock branch to fall into.
 */
function mcpTool(
  id: string,
  spec: McpServerSpec,
  mounted: McpMountedTool,
  deps: McpMountDeps
): Tool {
  const description =
    `[${mcpSource(spec.name)}] ${mounted.description ?? "(no description provided by the server)"} ` +
    `Input: ${describeInputSchema(mounted.inputSchema)} as JSON.`;

  return {
    name: id,
    description,
    run: async (input: string): Promise<ToolResult> => {
      const base = {
        mode: "real" as const,
        source: mcpSource(spec.name),
        server: spec.name,
        endpoint: describeMcpEndpoint(spec),
        tool: mounted.name,
      };

      const parsed = parseMcpToolInput(input, mounted.inputSchema);
      if (!parsed.ok) {
        return {
          ok: false,
          output: JSON.stringify({ ...base, argShape: "invalid", ok: false, error: parsed.error }),
        };
      }

      const outcome = await callMcpServerTool(spec, mounted.name, parsed.args, deps);
      if (!outcome.ok) {
        return {
          ok: false,
          output: JSON.stringify({ ...base, argShape: parsed.shape, ok: false, error: outcome.error }),
        };
      }

      return {
        ok: !outcome.isError,
        output: JSON.stringify({
          ...base,
          argShape: parsed.shape,
          ok: !outcome.isError,
          isError: outcome.isError,
          text: outcome.text,
          content: outcome.content,
        }),
      };
    },
  };
}
