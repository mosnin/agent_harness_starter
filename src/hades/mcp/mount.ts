/**
 * **Mounting an external MCP server** — the protocol-side half of "inherit the
 * ecosystem instead of rebuilding it".
 *
 * WHY THIS EXISTS. `.plans/HADES_BEYOND_HERMES.md` (Phase 1) names the strategy:
 * "speak MCP so Hades inherits the entire Hermes/Anthropic tool ecosystem *for
 * free* rather than rebuilding 90 tools. This is how we neutralize Hermes'
 * breadth advantage with one protocol." `mcp/client.ts` could already speak the
 * protocol and `mcp/stdio-transport.ts` can now reach a real subprocess; this
 * module is the operation in between — given a server SPEC, connect, complete
 * the handshake, list what that server offers, and call one of its tools —
 * expressed so the tool catalog (`tools/mcp-catalog.ts`) can mount the results.
 *
 * THE HONESTY CONTRACT OF THIS FILE (it is the whole point):
 *  - Every entry point returns a discriminated result, never a fabricated
 *    stand-in. There is NO mock branch anywhere in this module. If a server
 *    cannot be reached, the failure text names the server, the endpoint, the
 *    underlying reason, and — when the server said something on stderr — quotes
 *    it. A caller can print that string and the operator knows what to fix.
 *  - A declared environment requirement that is not satisfied is reported as an
 *    unmet requirement BEFORE any process is spawned or request is sent, and
 *    only ever by VARIABLE NAME. Values are never read into messages, never
 *    persisted, and never logged.
 *  - A tool-level failure (`isError: true` in the MCP result) is NOT a
 *    connection failure: it comes back as a successful call carrying
 *    `isError`, exactly as MCP defines it, so the two are never conflated.
 *  - Sessions are strictly scoped: every successful open is matched by a
 *    `close()` in a `finally`, so a mount probe cannot leak a child process.
 *
 * Connection lifetime is deliberately per-operation: `listMcpServerTools` and
 * `callMcpServerTool` each open, use, and close their own session. A pooled
 * long-lived connection would be faster for a tight call loop, but it would put
 * a live subprocess behind a catalog entry that the CLI builds on every
 * invocation — including `hades tools list`, which must never spawn anything.
 * Correctness and "no surprise processes" win; a `hades exec` program pays one
 * spawn per MCP call, which is the same order of cost as the sandbox it already
 * runs in.
 */

import { McpClient, type McpCallResult, type McpContent, type McpToolDef } from "./client";
import {
  StdioMcpTransport,
  realStdioSpawn,
  type StdioSpawnLike,
} from "./stdio-transport";
import { HttpMcpTransport, type McpFetchLike } from "./http-transport";

/** Default per-request timeout for a mounted server, in milliseconds. */
export const DEFAULT_MCP_TIMEOUT_MS = 15_000;

/** A locally-spawned MCP server, addressed by program + argv. */
export interface McpStdioServerSpec {
  name: string;
  transport: "stdio";
  /** The program to execute. No shell: this is an executable, not a command line. */
  command: string;
  args: string[];
  cwd?: string;
  /** Environment variable NAMES this server needs. Values are never stored. */
  requiresEnv?: string[];
  timeoutMs?: number;
}

/** A hosted MCP server, addressed by URL. */
export interface McpHttpServerSpec {
  name: string;
  transport: "http";
  url: string;
  /**
   * Request headers whose values come from the environment at call time:
   * `{ Authorization: "MY_TOKEN_VAR" }` sends `Authorization: <value of
   * MY_TOKEN_VAR>`. Only the VARIABLE NAME is ever persisted or printed.
   */
  headerEnv?: Record<string, string>;
  /** Additional environment variable NAMES this server needs. */
  requiresEnv?: string[];
  timeoutMs?: number;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** Injectable seams so every path is testable without a process or a network. */
export interface McpMountDeps {
  /** Spawn used for stdio servers. Default: the real `child_process.spawn`. */
  spawnStdio?: StdioSpawnLike;
  /** Fetch used for http servers. Default: none — an http mount then fails honestly. */
  fetchFn?: McpFetchLike;
  /** Environment consulted for requirement checks and header values.
   *  Default: `process.env`. NEVER used as the child's environment. */
  env?: Record<string, string | undefined>;
  /** Explicit environment for a spawned child. Default: inherit this process's
   *  environment, which is what a locally-launched MCP server expects (it needs
   *  PATH/HOME to run at all). */
  childEnv?: Record<string, string | undefined>;
}

export interface McpFailure {
  ok: false;
  error: string;
}

export interface McpServerIdentity {
  name?: string;
  version?: string;
}

export interface McpListSuccess {
  ok: true;
  tools: McpToolDef[];
  server: McpServerIdentity;
}

export interface McpCallSuccess {
  ok: true;
  /** Concatenated text blocks — the usual thing a caller wants. */
  text: string;
  /** The full content array, unmodified. */
  content: McpContent[];
  /** The server's own tool-level error flag. A failed TOOL, not a failed call. */
  isError: boolean;
}

export type McpListResult = McpListSuccess | McpFailure;
export type McpCallOutcome = McpCallSuccess | McpFailure;

/** Human-readable endpoint, safe to print: no env values, ever. */
export function describeMcpEndpoint(spec: McpServerSpec): string {
  if (spec.transport === "stdio") {
    const argv = [spec.command, ...spec.args].join(" ");
    return `stdio: ${argv}${spec.cwd !== undefined ? ` (cwd ${spec.cwd})` : ""}`;
  }
  return `http: ${spec.url}`;
}

/**
 * Environment variable NAMES this spec declares but the environment does not
 * provide. An unmet requirement is surfaced (by name) rather than silently
 * producing a doomed request.
 */
export function unmetEnvRequirements(
  spec: McpServerSpec,
  env: Record<string, string | undefined>
): string[] {
  const names = new Set<string>(spec.requiresEnv ?? []);
  if (spec.transport === "http") {
    for (const varName of Object.values(spec.headerEnv ?? {})) names.add(varName);
  }
  return [...names].filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
}

/** All environment variable NAMES this spec depends on (met or not). */
export function declaredEnvKeys(spec: McpServerSpec): string[] {
  const names = new Set<string>(spec.requiresEnv ?? []);
  if (spec.transport === "http") {
    for (const varName of Object.values(spec.headerEnv ?? {})) names.add(varName);
  }
  return [...names].sort();
}

/**
 * A live, initialized connection to one MCP server. `guard` races an operation
 * against the transport dying, so a server that exits mid-request fails in
 * milliseconds with a real reason instead of waiting out the request timeout.
 */
export interface McpSession {
  client: McpClient;
  server: McpServerIdentity;
  guard<T>(op: Promise<T>): Promise<T>;
  /** Transport diagnostics (child stderr, non-protocol stdout), or "". */
  diagnostics(): string;
  close(): void;
}

export type McpOpenResult = ({ ok: true } & { session: McpSession }) | McpFailure;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Compose the one error string every failure path in this module produces. */
function failureText(spec: McpServerSpec, reason: string, diagnostics: string): string {
  const base = `MCP server "${spec.name}" (${describeMcpEndpoint(spec)}) ${reason}`;
  return diagnostics === "" ? base : `${base}${diagnostics}`;
}

/**
 * Connect to `spec` and complete the MCP `initialize` handshake.
 *
 * On success the caller OWNS the returned session and must `close()` it
 * (`listMcpServerTools`/`callMcpServerTool` below do exactly that in a
 * `finally`). On failure nothing is left running.
 */
export async function openMcpSession(spec: McpServerSpec, deps: McpMountDeps = {}): Promise<McpOpenResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

  const unmet = unmetEnvRequirements(spec, env);
  if (unmet.length > 0) {
    return {
      ok: false,
      error: failureText(
        spec,
        `has an unmet requirement: environment variable${unmet.length === 1 ? "" : "s"} ${unmet.join(
          ", "
        )} ${unmet.length === 1 ? "is" : "are"} not set`,
        ""
      ),
    };
  }

  if (spec.transport === "stdio") {
    return openStdioSession(spec, deps, timeoutMs);
  }
  return openHttpSession(spec, deps, env, timeoutMs);
}

async function openStdioSession(
  spec: McpStdioServerSpec,
  deps: McpMountDeps,
  timeoutMs: number
): Promise<McpOpenResult> {
  const spawnStdio = deps.spawnStdio ?? realStdioSpawn();

  let transport: StdioMcpTransport;
  try {
    const child = spawnStdio(spec.command, spec.args, {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(deps.childEnv !== undefined ? { env: deps.childEnv } : {}),
    });
    transport = new StdioMcpTransport(child);
  } catch (err) {
    // Most spawn failures arrive asynchronously on 'error'; a synchronous throw
    // (bad arguments, a spawn seam that refuses) is handled here all the same.
    return { ok: false, error: failureText(spec, `could not be started: ${messageOf(err)}`, "") };
  }

  const diagnostics = (): string => {
    const parts: string[] = [];
    const stderr = transport.stderrTail();
    if (stderr !== "") parts.push(`; server stderr: ${stderr}`);
    const noise = transport.noiseLines();
    if (noise.length > 0) parts.push(`; non-protocol stdout: ${noise.join(" | ")}`);
    return parts.join("");
  };

  // A promise that rejects the moment the child dies. Pre-handled so an
  // unraced fatal never surfaces as an unhandled rejection.
  let rejectFatal: ((err: Error) => void) | undefined;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  fatal.catch(() => undefined);
  transport.onFatal((reason) => rejectFatal?.(new Error(reason)));

  const client = new McpClient(transport, { timeoutMs });
  const session: McpSession = {
    client,
    server: {},
    guard: <T,>(op: Promise<T>): Promise<T> => Promise.race([op, fatal]),
    diagnostics,
    close: () => client.close(),
  };

  try {
    const info = await session.guard(client.initialize());
    session.server = {
      ...(info.serverName !== undefined ? { name: info.serverName } : {}),
      ...(info.serverVersion !== undefined ? { version: info.serverVersion } : {}),
    };
    return { ok: true, session };
  } catch (err) {
    session.close();
    return { ok: false, error: failureText(spec, `is unreachable: ${messageOf(err)}`, diagnostics()) };
  }
}

async function openHttpSession(
  spec: McpHttpServerSpec,
  deps: McpMountDeps,
  env: Record<string, string | undefined>,
  timeoutMs: number
): Promise<McpOpenResult> {
  if (!deps.fetchFn) {
    return {
      ok: false,
      error: failureText(
        spec,
        "cannot be reached: no HTTP transport is available in this build (no fetch implementation was supplied)",
        ""
      ),
    };
  }

  // Header values are resolved here, at call time, from the environment. The
  // NAMES came from the persisted spec; the VALUES never leave this scope.
  const headers: Record<string, string> = {};
  for (const [header, varName] of Object.entries(spec.headerEnv ?? {})) {
    const value = env[varName];
    if (value === undefined || value === "") {
      return {
        ok: false,
        error: failureText(
          spec,
          `has an unmet requirement: environment variable ${varName} (used for the ${header} header) is not set`,
          ""
        ),
      };
    }
    headers[header] = value;
  }

  const transport = new HttpMcpTransport({ url: spec.url, fetchFn: deps.fetchFn, headers });
  const client = new McpClient(transport, { timeoutMs });
  const session: McpSession = {
    client,
    server: {},
    guard: <T,>(op: Promise<T>): Promise<T> => op,
    diagnostics: () => "",
    close: () => client.close(),
  };

  try {
    const info = await client.initialize();
    session.server = {
      ...(info.serverName !== undefined ? { name: info.serverName } : {}),
      ...(info.serverVersion !== undefined ? { version: info.serverVersion } : {}),
    };
    return { ok: true, session };
  } catch (err) {
    session.close();
    return { ok: false, error: failureText(spec, `is unreachable: ${messageOf(err)}`, "") };
  }
}

/**
 * Connect, `tools/list`, disconnect. This is the probe `hades tools mcp add`
 * runs before persisting anything: a server that cannot be listed is never
 * recorded as if it were available.
 */
export async function listMcpServerTools(
  spec: McpServerSpec,
  deps: McpMountDeps = {}
): Promise<McpListResult> {
  const opened = await openMcpSession(spec, deps);
  if (!opened.ok) return opened;
  const { session } = opened;
  try {
    const tools = await session.guard(session.client.listTools());
    return { ok: true, tools, server: session.server };
  } catch (err) {
    return {
      ok: false,
      error: failureText(spec, `failed to list its tools: ${messageOf(err)}`, session.diagnostics()),
    };
  } finally {
    session.close();
  }
}

/** Flatten an MCP content array into the text a Hades tool result carries. */
export function contentToText(content: McpContent[]): string {
  return content
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      // A non-text block (image, resource, ...) is described, never invented:
      // the caller sees exactly what kind of block came back.
      return `[${typeof block.type === "string" ? block.type : "unknown"} content block]`;
    })
    .join("\n");
}

/**
 * Connect, `tools/call`, disconnect.
 *
 * `ok:false` means the CALL failed (unreachable server, protocol error).
 * `ok:true` with `isError:true` means the call succeeded and the TOOL failed —
 * the server's own verdict, passed through untouched.
 */
export async function callMcpServerTool(
  spec: McpServerSpec,
  toolName: string,
  args: Record<string, unknown>,
  deps: McpMountDeps = {}
): Promise<McpCallOutcome> {
  const opened = await openMcpSession(spec, deps);
  if (!opened.ok) return opened;
  const { session } = opened;
  try {
    const result: McpCallResult = await session.guard(session.client.callTool(toolName, args));
    return {
      ok: true,
      text: contentToText(result.content),
      content: result.content,
      isError: result.isError === true,
    };
  } catch (err) {
    return {
      ok: false,
      error: failureText(
        spec,
        `failed while calling tool "${toolName}": ${messageOf(err)}`,
        session.diagnostics()
      ),
    };
  } finally {
    session.close();
  }
}
