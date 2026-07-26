/**
 * `hades tools <sub>` — inspect and toggle the tool catalog managed by a
 * `ToolsetManager`.
 *
 *   hades tools [list]        List every catalog entry (aligned columns)
 *   hades tools list --json   Machine-readable `ToolsetManager.status()` dump
 *   hades tools enable <name>   Enable a tool (persists immediately)
 *   hades tools disable <name>  Disable a tool (persists immediately)
 *   hades tools info <name>     Full metadata for one tool
 *
 * Terminal-free (returns `{ code, lines }`) so it unit-tests without a
 * shell or real stdout, matching the rest of `src/hades/cli/*`.
 */
import type { CliResult } from "./cli";
import type { ToolsetManager, ToolStatus } from "../tools/manager";

export interface ToolsCommandDeps {
  manager: ToolsetManager;
}

const USAGE = [
  "Usage: hades tools <command>",
  "",
  "Commands:",
  "  list [--json]     List every tool in the catalog (default)",
  "  enable <name>     Enable a tool",
  "  disable <name>    Disable a tool",
  "  info <name>       Show full metadata for one tool",
  "  help              Show this help",
];

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function formatTable(rows: ToolStatus[]): string[] {
  if (rows.length === 0) return ["No tools in the catalog."];

  const headers = ["NAME", "CATEGORY", "MODE", "STATUS", "KEYS"];
  const cells = rows.map((r) => [
    r.id,
    r.category,
    r.mode,
    r.enabled ? "enabled" : "disabled",
    r.requiredEnvKeys.length > 0 ? `needs: ${r.requiredEnvKeys.join(",")}` : "-",
  ]);

  const widths = headers.map((h, col) =>
    Math.max(h.length, ...cells.map((row) => row[col].length))
  );

  const renderRow = (cols: string[]): string =>
    cols.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();

  return [renderRow(headers), ...cells.map((row) => renderRow(row))];
}

function formatInfo(s: ToolStatus): string[] {
  return [
    `name:            ${s.id}`,
    `category:        ${s.category}`,
    `mode:            ${s.mode}`,
    `enabled:         ${s.enabled}`,
    `requiresNetwork: ${s.requiresNetwork}`,
    `requiredEnvKeys: ${s.requiredEnvKeys.length ? s.requiredEnvKeys.join(", ") : "(none)"}`,
    `verifierId:      ${s.verifierId}`,
    `description:     ${s.description}`,
  ];
}

export function runToolsCommand(args: string[], deps: ToolsCommandDeps): CliResult {
  const { manager } = deps;
  const [sub, ...rest] = args;

  if (sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }

  if (sub === undefined || sub === "list") {
    const json = rest.includes("--json");
    const status = manager.status();
    if (json) {
      return { code: 0, lines: [JSON.stringify(status, null, 2)] };
    }
    return { code: 0, lines: formatTable(status) };
  }

  if (sub === "enable" || sub === "disable") {
    const name = rest[0];
    if (!name) {
      return { code: 1, lines: [`Usage: hades tools ${sub} <name>`] };
    }
    const ok = sub === "enable" ? manager.enable(name) : manager.disable(name);
    if (!ok) {
      return { code: 1, lines: [`Unknown tool: ${name}`, "Run `hades tools list` to see available tools."] };
    }
    return { code: 0, lines: [`${sub === "enable" ? "Enabled" : "Disabled"} ${name}.`] };
  }

  if (sub === "info") {
    const name = rest[0];
    if (!name) {
      return { code: 1, lines: ["Usage: hades tools info <name>"] };
    }
    const status = manager.status().find((s) => s.id === name);
    if (!status) {
      return { code: 1, lines: [`Unknown tool: ${name}`, "Run `hades tools list` to see available tools."] };
    }
    return { code: 0, lines: formatInfo(status) };
  }

  return { code: 1, lines: [`Unknown tools command: ${sub}`, "Run `hades tools help` for usage."] };
}
