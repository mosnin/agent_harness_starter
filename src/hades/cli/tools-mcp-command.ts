/**
 * `hades tools mcp <sub>` — mount external MCP servers into the local tool
 * catalog.
 *
 *   hades tools mcp add <name> --command <program> [args...]   Mount a stdio server
 *   hades tools mcp add <name> --url <endpoint>                Mount an HTTP server
 *   hades tools mcp list [--json] [--probe]                    Show mounts
 *   hades tools mcp remove <name>                              Unmount a server
 *
 * WHY THIS COMMAND EXISTS. It is the operator-facing end of the strategy in
 * `.plans/HADES_BEYOND_HERMES.md` (Phase 1): rather than writing eighty more
 * tool files to match a competitor's catalog, speak MCP once and let an
 * operator attach the ecosystem's servers. After `add`, the server's tools are
 * ordinary catalog entries — `hades tools list` shows them, `hades tools
 * enable/disable` toggles them, `hades exec` calls them, and every call lands
 * in the same hash-chained STYX provenance ledger as a builtin call.
 *
 * THREE THINGS THIS COMMAND WILL NOT DO:
 *
 *  1. It will not record a server it could not reach. `add` PROBES first
 *     (connect, handshake, `tools/list`); a failure prints the reason —
 *     including the server's own stderr — and persists nothing, exiting 1.
 *     A half-mounted server that fails later at call time would be exactly the
 *     silent degradation this codebase refuses to ship.
 *  2. It will not store or print a secret. `--requires-env` and `--header-env`
 *     take environment variable NAMES; values are read at call time and never
 *     written to `<dataDir>/mcp-servers.json`, never echoed, never logged.
 *  3. It will not pretend a cached listing is live. `list` prints the tool
 *     listing captured at mount time and says so; `list --probe` reconnects
 *     for real and exits non-zero if any mounted server is unreachable.
 *
 * Terminal-free (`{ code, lines }`) like every other command in this
 * directory, so it unit-tests without a shell. Unlike its siblings it is
 * async, because mounting genuinely talks to another process.
 */

import type { CliResult } from "./cli";
import type { ToolCatalog } from "../tools/catalog";
import {
  JsonFileMcpMountStore,
  InMemoryMcpMountStore,
  planMcpEntries,
  isValidMcpServerName,
  type McpMountRecord,
  type McpMountStore,
} from "../tools/mcp-catalog";
import {
  describeMcpEndpoint,
  listMcpServerTools,
  unmetEnvRequirements,
  type McpMountDeps,
  type McpServerSpec,
} from "../mcp/mount";

export interface ToolsMcpCommandDeps {
  /** Where mounts live. `<dataDir>/mcp-servers.json` in the shipped CLI. */
  store: McpMountStore;
  /** Seams forwarded to every mount operation (spawn, fetch, env). */
  mount?: McpMountDeps;
  /**
   * The catalog this process already built, when there is one. Passing it lets
   * a mount take effect IMMEDIATELY (in a REPL/TUI session, or for a later
   * subcommand in the same run) instead of only after a restart.
   */
  catalog?: ToolCatalog;
  now?: () => number;
}

const USAGE = [
  "Usage: hades tools mcp <command>",
  "",
  "Commands:",
  "  add <name> --command <program> [args...]   Mount a stdio MCP server",
  "  add <name> --url <endpoint>                Mount an HTTP MCP server",
  "  list [--json] [--probe]                    List mounted servers",
  "  remove <name>                              Unmount a server",
  "  help                                       Show this help",
  "",
  "add options:",
  "  --command <program>     Executable to spawn (no shell: pass arguments separately)",
  "  --arg <value>           One argument for the program (repeatable)",
  "  --url <endpoint>        HTTP MCP endpoint (mutually exclusive with --command)",
  "  --cwd <dir>             Working directory for the spawned program",
  "  --requires-env A,B      Environment variable NAMES the server needs (never values)",
  "  --header-env H=VAR      Send header H with the value of environment variable VAR",
  "  --timeout-ms <n>        Per-request timeout (default 15000)",
  "  --                      Everything after this is passed to the program verbatim",
  "",
  "Mounted tools are registered as mcp.<server>.<tool> so they can never shadow a",
  "builtin. `add` connects before it records anything: an unreachable server is an",
  "error, never a silent mock.",
];

interface AddOptions {
  name: string;
  command?: string;
  url?: string;
  args: string[];
  cwd?: string;
  requiresEnv: string[];
  headerEnv: Record<string, string>;
  timeoutMs?: number;
  json: boolean;
}

/** Parse `add` arguments. Returns error lines rather than throwing. */
export function parseMcpAddArgs(args: string[]): AddOptions | { errorLines: string[] } {
  const [name, ...rest] = args;
  if (name === undefined || name.startsWith("-")) {
    return { errorLines: ["Usage: hades tools mcp add <name> --command <program> [args...]"] };
  }

  const opts: AddOptions = { name, args: [], requiresEnv: [], headerEnv: {}, json: false };
  let verbatim = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];

    if (verbatim) {
      opts.args.push(token);
      continue;
    }
    if (token === "--") {
      verbatim = true;
      continue;
    }

    switch (token) {
      case "--command": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--command needs a program name"] };
        opts.command = value;
        continue;
      }
      case "--url": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--url needs an endpoint"] };
        opts.url = value;
        continue;
      }
      case "--arg": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--arg needs a value"] };
        opts.args.push(value);
        continue;
      }
      case "--cwd": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--cwd needs a directory"] };
        opts.cwd = value;
        continue;
      }
      case "--requires-env": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--requires-env needs a comma-separated list"] };
        for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!opts.requiresEnv.includes(part)) opts.requiresEnv.push(part);
        }
        continue;
      }
      case "--header-env": {
        const value = rest[++i];
        if (value === undefined) return { errorLines: ["--header-env needs <Header>=<ENV_VAR>"] };
        const eq = value.indexOf("=");
        if (eq <= 0 || eq === value.length - 1) {
          return { errorLines: [`--header-env expects <Header>=<ENV_VAR>, got ${JSON.stringify(value)}`] };
        }
        opts.headerEnv[value.slice(0, eq)] = value.slice(eq + 1);
        continue;
      }
      case "--timeout-ms": {
        const value = Number(rest[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          return { errorLines: ["--timeout-ms needs a positive number of milliseconds"] };
        }
        opts.timeoutMs = value;
        continue;
      }
      case "--json": {
        opts.json = true;
        continue;
      }
      default: {
        if (token.startsWith("--")) return { errorLines: [`Unknown option: ${token}`] };
        // A bare token is an argument for the spawned program.
        opts.args.push(token);
      }
    }
  }

  return opts;
}

/** Turn parsed options into a spec, or explain why they are not one. */
function specFromAddOptions(opts: AddOptions): McpServerSpec | { errorLines: string[] } {
  if (!isValidMcpServerName(opts.name)) {
    return {
      errorLines: [
        `Invalid server name ${JSON.stringify(opts.name)}.`,
        "Use letters, digits, '_' or '-' (starting with a letter or digit), at most 64 characters.",
      ],
    };
  }
  if (opts.command !== undefined && opts.url !== undefined) {
    return { errorLines: ["Pass either --command (stdio) or --url (http), not both."] };
  }
  if (opts.command === undefined && opts.url === undefined) {
    return { errorLines: ["Pass --command <program> for a stdio server, or --url <endpoint> for HTTP."] };
  }

  if (opts.command !== undefined) {
    if (Object.keys(opts.headerEnv).length > 0) {
      return { errorLines: ["--header-env only applies to an --url (http) server."] };
    }
    if (/\s/.test(opts.command)) {
      // No shell is involved anywhere in the spawn path (see
      // mcp/stdio-transport.ts), so a command line cannot be split for you
      // without inventing a tokenizer whose quoting rules would differ from
      // your shell's. Say so instead of silently mis-parsing it.
      const [program, ...rest] = opts.command.trim().split(/\s+/);
      return {
        errorLines: [
          "--command takes a single executable, not a shell command line (there is no shell).",
          `Did you mean: --command ${program} ${rest.map((a) => JSON.stringify(a)).join(" ")}`,
        ],
      };
    }
    return {
      name: opts.name,
      transport: "stdio",
      command: opts.command,
      args: opts.args,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.requiresEnv.length > 0 ? { requiresEnv: opts.requiresEnv } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
  }

  if (opts.args.length > 0) {
    return { errorLines: ["Program arguments only apply to a --command (stdio) server."] };
  }
  if (opts.cwd !== undefined) {
    return { errorLines: ["--cwd only applies to a --command (stdio) server."] };
  }
  const url = opts.url as string;
  if (!/^https?:\/\//i.test(url)) {
    return { errorLines: [`--url must be an http(s) endpoint, got ${JSON.stringify(url)}`] };
  }
  return {
    name: opts.name,
    transport: "http",
    url,
    ...(Object.keys(opts.headerEnv).length > 0 ? { headerEnv: opts.headerEnv } : {}),
    ...(opts.requiresEnv.length > 0 ? { requiresEnv: opts.requiresEnv } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const render = (cols: string[]): string => cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  return [render(headers), ...rows.map(render)];
}

function isoOrUnknown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "(unknown)";
  return new Date(ms).toISOString();
}

async function cmdAdd(args: string[], deps: ToolsMcpCommandDeps): Promise<CliResult> {
  const parsed = parseMcpAddArgs(args);
  if ("errorLines" in parsed) return { code: 1, lines: parsed.errorLines };

  const spec = specFromAddOptions(parsed);
  if ("errorLines" in spec) return { code: 1, lines: spec.errorLines };

  const existing = deps.store.load();
  if (existing.some((r) => r.spec.name === spec.name)) {
    return {
      code: 1,
      lines: [
        `An MCP server named ${JSON.stringify(spec.name)} is already mounted.`,
        `Remove it first: hades tools mcp remove ${spec.name}`,
      ],
    };
  }

  // Probe BEFORE persisting: a server we cannot reach is never recorded.
  const listed = await listMcpServerTools(spec, deps.mount);
  if (!listed.ok) {
    return {
      code: 1,
      lines: [listed.error, "", "Nothing was mounted."],
    };
  }

  const now = deps.now ?? Date.now;
  const record: McpMountRecord = {
    spec,
    mountedAt: now(),
    ...(listed.server.name !== undefined || listed.server.version !== undefined
      ? { server: listed.server }
      : {}),
    tools: listed.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    })),
  };

  const plan = planMcpEntries(record, deps.mount);

  try {
    deps.store.save([...existing, record]);
  } catch (err) {
    return {
      code: 1,
      lines: [
        `Could not persist the mount: ${err instanceof Error ? err.message : String(err)}`,
        "Nothing was mounted.",
      ],
    };
  }

  // Make it usable in THIS process too, not just the next one.
  const catalog = deps.catalog;
  const liveErrors: string[] = [];
  if (catalog) {
    for (const entry of plan.entries) {
      try {
        catalog.add(entry);
      } catch (err) {
        liveErrors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (parsed.json) {
    return {
      code: 0,
      lines: [
        JSON.stringify(
          {
            mounted: spec.name,
            endpoint: describeMcpEndpoint(spec),
            server: record.server ?? {},
            tools: plan.entries.map((e) => e.id),
            skipped: plan.skipped,
          },
          null,
          2
        ),
      ],
    };
  }

  const serverLabel =
    record.server?.name === undefined
      ? "(the server did not name itself)"
      : `${record.server.name}${record.server.version ? ` ${record.server.version}` : ""}`;

  const lines = [
    `Mounted MCP server "${spec.name}" (${describeMcpEndpoint(spec)}).`,
    `  server:   ${serverLabel}`,
    `  inherited: ${plan.entries.length} tool${plan.entries.length === 1 ? "" : "s"}`,
  ];
  for (const entry of plan.entries) {
    lines.push(`    ${entry.id}`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`  skipped:  ${plan.skipped.length}`);
    for (const skip of plan.skipped) {
      lines.push(`    ${skip.name}: ${skip.reason}`);
    }
  }
  if (liveErrors.length > 0) {
    lines.push("  NOT added to this process's live catalog (still persisted for the next run):");
    for (const err of liveErrors) lines.push(`    ${err}`);
  }
  lines.push(
    "",
    "These are ordinary catalog tools now: `hades tools list` shows them with their",
    "source, `hades tools disable <id>` turns one off, and `hades exec` can call them."
  );
  return { code: 0, lines };
}

async function cmdList(args: string[], deps: ToolsMcpCommandDeps): Promise<CliResult> {
  const json = args.includes("--json");
  const probe = args.includes("--probe");
  const records = deps.store.load();
  const env = deps.mount?.env ?? (process.env as Record<string, string | undefined>);

  interface ProbeResult {
    ok: boolean;
    tools?: number;
    names?: string[];
    error?: string;
  }
  const probes = new Map<string, ProbeResult>();
  if (probe) {
    for (const record of records) {
      const listed = await listMcpServerTools(record.spec, deps.mount);
      probes.set(
        record.spec.name,
        listed.ok
          ? { ok: true, tools: listed.tools.length, names: listed.tools.map((t) => t.name) }
          : { ok: false, error: listed.error }
      );
    }
  }

  // How many of each server's ADVERTISED tools this build could actually
  // inherit. `record.tools` is what the server said it had at mount time;
  // `planMcpEntries` is what became callable, and it drops any tool whose name
  // the catalog id charset cannot represent (or that collides with another
  // after sanitizing). `mcp add` reports those skips once and throws them away,
  // so rendering the advertised number here told an operator who came back the
  // next day that 4 tools were usable when 2 were. Recomputed rather than
  // persisted: the plan is a pure function of the record and cannot go stale.
  const plans = new Map(records.map((r) => [r.spec.name, planMcpEntries(r, deps.mount)]));
  /** Live tool names the CACHE does not know about, and vice versa. */
  const drift = (name: string): { added: string[]; removed: string[] } | undefined => {
    const result = probes.get(name);
    const record = records.find((r) => r.spec.name === name);
    if (!result?.ok || !result.names || !record) return undefined;
    const live = new Set(result.names);
    const cached = new Set(record.tools.map((t) => t.name));
    const added = [...live].filter((n) => !cached.has(n)).sort();
    const removed = [...cached].filter((n) => !live.has(n)).sort();
    return added.length > 0 || removed.length > 0 ? { added, removed } : undefined;
  };

  if (json) {
    return {
      code: 0,
      lines: [
        JSON.stringify(
          records.map((r) => ({
            name: r.spec.name,
            transport: r.spec.transport,
            endpoint: describeMcpEndpoint(r.spec),
            mountedAt: r.mountedAt,
            server: r.server ?? {},
            cachedTools: r.tools.map((t) => t.name),
            advertisedToolCount: r.tools.length,
            inheritedToolCount: plans.get(r.spec.name)?.entries.length ?? 0,
            skippedTools: plans.get(r.spec.name)?.skipped ?? [],
            unmetEnv: unmetEnvRequirements(r.spec, env),
            ...(probe ? { probe: probes.get(r.spec.name) ?? { ok: false, error: "not probed" } } : {}),
            ...(probe ? { drift: drift(r.spec.name) ?? null } : {}),
          })),
          null,
          2
        ),
      ],
    };
  }

  if (records.length === 0) {
    return {
      code: 0,
      lines: [
        "No MCP servers are mounted.",
        "Mount one: hades tools mcp add <name> --command <program> [args...]",
      ],
    };
  }

  const rows = records.map((r) => {
    const plan = plans.get(r.spec.name);
    const inherited = plan?.entries.length ?? 0;
    const skipped = plan?.skipped.length ?? 0;
    return [
      r.spec.name,
      r.spec.transport,
      describeMcpEndpoint(r.spec).replace(/^(stdio|http): /, ""),
      // `inherited/advertised` whenever they differ. A bare advertised count
      // beside `hades tools list` showing fewer entries is two answers to one
      // question.
      skipped === 0 ? String(inherited) : `${inherited}/${r.tools.length}`,
      String(skipped),
      isoOrUnknown(r.mountedAt),
    ];
  });
  const lines = table(["NAME", "TRANSPORT", "ENDPOINT", "TOOLS", "SKIPPED", "MOUNTED"], rows);

  const skippedLines: string[] = [];
  for (const record of records) {
    const plan = plans.get(record.spec.name);
    for (const skip of plan?.skipped ?? []) {
      skippedLines.push(`  ${record.spec.name}/${skip.name}: ${skip.reason}`);
    }
  }
  if (skippedLines.length > 0) {
    lines.push(
      "",
      "Advertised but NOT inherited — these are not callable and never were:",
      ...skippedLines
    );
  }

  const unmetLines: string[] = [];
  for (const record of records) {
    const unmet = unmetEnvRequirements(record.spec, env);
    if (unmet.length > 0) {
      unmetLines.push(`  ${record.spec.name}: unmet requirement — ${unmet.join(", ")} not set`);
    }
  }
  if (unmetLines.length > 0) {
    lines.push("", "Unmet environment requirements (variable names, never values):", ...unmetLines);
  }

  // The cache caveat belongs on BOTH paths. It used to sit inside the
  // `if (!probe)` early return — i.e. it was dropped in exactly the mode where
  // a contradiction between the cached number and the live one can appear on
  // screen. Two disagreeing numbers with the label explaining one of them
  // removed is worse than either number alone.
  lines.push(
    "",
    "TOOLS is the listing captured when each server was mounted, not a live count."
  );
  if (!probe) {
    lines.push("Re-check for real with: hades tools mcp list --probe");
    return { code: 0, lines };
  }

  lines.push("", "Live probe:");
  let failures = 0;
  let drifted = 0;
  for (const record of records) {
    const result = probes.get(record.spec.name);
    if (result?.ok) {
      lines.push(`  ${record.spec.name}: reachable, ${result.tools} tool${result.tools === 1 ? "" : "s"}`);
      // Observing the drift and then reporting success is the failure this
      // check exists to prevent: `--probe` is documented as the command that
      // actually reconnects, so it must not print a stale 2 beside a live 1 and
      // exit 0 while `hades tools list` still offers both.
      const d = drift(record.spec.name);
      if (d) {
        drifted += 1;
        lines.push(
          `    DRIFT — the live server no longer matches the listing captured at mount:`,
          ...(d.removed.length > 0
            ? [
                `      gone upstream (still offered locally, calls will fail): ${d.removed.join(", ")}`,
              ]
            : []),
          ...(d.added.length > 0
            ? [`      new upstream (NOT inherited until re-mounted): ${d.added.join(", ")}`]
            : []),
          `      re-mount to reconcile: hades tools mcp add ${record.spec.name} ...`
        );
      }
    } else {
      failures += 1;
      lines.push(`  ${record.spec.name}: UNREACHABLE — ${result?.error ?? "unknown error"}`);
    }
  }
  if (drifted > 0) {
    lines.push(
      "",
      `${drifted} mount(s) have drifted from what this install offers. Exiting non-zero: a probe that`,
      "saw the disagreement and reported success would be the stale number wearing a live badge."
    );
  }
  // A probe that found a dead server — or a mount that no longer matches the
  // tools this install is handing out — exits non-zero: the whole point of
  // asking is to find out, and a zero exit would report "fine" either way.
  return { code: failures > 0 || drifted > 0 ? 1 : 0, lines };
}

function cmdRemove(args: string[], deps: ToolsMcpCommandDeps): CliResult {
  const name = args[0];
  if (name === undefined) return { code: 1, lines: ["Usage: hades tools mcp remove <name>"] };

  const records = deps.store.load();
  const target = records.find((r) => r.spec.name === name);
  if (!target) {
    return {
      code: 1,
      lines: [`No MCP server named ${JSON.stringify(name)} is mounted.`, "Run `hades tools mcp list`."],
    };
  }

  try {
    deps.store.save(records.filter((r) => r.spec.name !== name));
  } catch (err) {
    return {
      code: 1,
      lines: [`Could not persist the change: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Drop the tools from the live catalog too, so an unmounted tool stops
  // answering immediately rather than at the next restart.
  let removed = 0;
  const plan = planMcpEntries(target, deps.mount);
  if (deps.catalog) {
    for (const entry of plan.entries) {
      if (deps.catalog.remove(entry.id)) removed += 1;
    }
  }

  return {
    code: 0,
    lines: [
      `Unmounted MCP server "${name}" (${plan.entries.length} tool${
        plan.entries.length === 1 ? "" : "s"
      } removed from the catalog${deps.catalog ? `, ${removed} from this process's live catalog` : ""}).`,
    ],
  };
}

export async function runToolsMcpCommand(
  args: string[],
  deps: ToolsMcpCommandDeps
): Promise<CliResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }
  if (sub === "add") return cmdAdd(rest, deps);
  if (sub === "list" || sub === "ls") return cmdList(rest, deps);
  if (sub === "remove" || sub === "rm") return cmdRemove(rest, deps);

  return { code: 1, lines: [`Unknown tools mcp command: ${sub}`, "Run `hades tools mcp help` for usage."] };
}

/**
 * The shipped deps: mounts persisted at `<dataDir>/mcp-servers.json` (the same
 * data dir every other durable surface uses), or an in-memory store when this
 * build does not persist. `mount` seams are left at their real defaults — a
 * genuine `child_process.spawn` for stdio and the platform `fetch` for HTTP.
 */
export function defaultToolsMcpDeps(opts: {
  statePath?: string;
  catalog?: ToolCatalog;
  mount?: McpMountDeps;
}): ToolsMcpCommandDeps {
  return {
    store: opts.statePath !== undefined
      ? new JsonFileMcpMountStore(opts.statePath)
      : new InMemoryMcpMountStore(),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    ...(opts.mount !== undefined ? { mount: opts.mount } : {}),
  };
}
