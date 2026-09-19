/**
 * Zero-RTT block for canned destructive commands.
 *
 * Auto Mode already asks Jev whether a call is destructive. `rm -rf`,
 * `git push --force`, and `DROP TABLE` do not need a 70–500ms hop — and
 * they should not leave the box if Jev is down. Code scans `command` /
 * `cmd` / `args` only so a README that mentions "rm -rf" is not blocked.
 */

import type { PolicyDecision } from "./types";

const WIPE_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bformat\s+c:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=\/dev\/(?:zero|urandom)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
];

const FORCE_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+(?:[^\n]*\s+)?(?:--force|-f)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

export function commandFromToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const rec = args as Record<string, unknown>;
  const command = String(rec.command ?? rec.cmd ?? rec.shell ?? "");
  const extra = Array.isArray(rec.args) ? rec.args.map(String).join(" ") : "";
  return `${command} ${extra}`.trim();
}

export function hasDestructiveCommand(text: string): boolean {
  return Boolean(localDestructiveDecision(text));
}

export function localDestructiveBlock(node = "auto_mode"): PolicyDecision {
  return { action: "block", value: "destructive", reason: "destructive-local", node };
}

export function localDestructiveDecision(text: string): PolicyDecision | null {
  if (!text) return null;
  if (matchesAny(text, WIPE_PATTERNS)) return localDestructiveBlock("auto_mode");
  if (matchesAny(text, FORCE_GIT_PATTERNS)) {
    return { action: "review", value: "destructive", reason: "destructive-local", node: "jev_git" };
  }
  return null;
}
