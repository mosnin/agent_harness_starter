/**
 * `hades showdown verify` / `hades showdown ready` — one-command closing of
 * the two standing keyed-showdown gates:
 *
 *   hades showdown verify --dir <path>   Independent byte-level audit of a
 *                                        published `runs/live-*` directory
 *                                        (see ../bench/live-manifest-verify's
 *                                        `verifyLiveRunDir`). Exit 0 iff
 *                                        every check passes.
 *   hades showdown ready                 Honest readiness report for a keyed
 *                                        live run in THIS environment (see
 *                                        `livePreflightSummary`, a thin
 *                                        wrapper over the real
 *                                        `preflightLiveShowdown`). Exit 0
 *                                        when ready, 1 when not — so CI can
 *                                        gate on it.
 *
 * Terminal-free (returns `CliResult`), same house shape as
 * `./backends-command.ts`: all dynamic output is control-character
 * sanitized before it is returned, so a manifest whose `model`/goal-ish
 * strings embed ANSI escapes or `\r` can never inject control sequences
 * into the CLI's output stream.
 *
 * Import boundary (locked, shared with ../bench/live-manifest-verify.ts):
 * `../bench/showdown-live` (types/constants/preflight), `../styx/certificate`
 * (`sha256Hex`), node builtins, `./cli` (type only), and this team's own
 * files (`../bench/live-manifest-verify`). Routing `hades showdown
 * verify|ready` into `HadesCli` is central integration's job, not this
 * file's — this module only exports the two command functions below.
 */
import { isAbsolute, join } from "node:path";
import type { CliResult } from "./cli";
import {
  livePreflightSummary,
  renderManifestAudit,
  verifyLiveRunDir,
  type AuditFsDeps,
} from "../bench/live-manifest-verify";

export interface ShowdownVerifyCommandDeps {
  fs?: AuditFsDeps;
  env: Record<string, string | undefined>;
  cwd: string;
}

const VERIFY_USAGE = ["Usage: hades showdown verify --dir <path>"];

// ---------------------------------------------------------------------------
// local helpers (own copies, matching the house convention documented in
// backends-command.ts — this file never imports another CLI command
// module's internals)
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00-0x1F, 0x7F) from any dynamic
 *  string before it is returned in a CliResult line, so a manifest field
 *  (model, an error message, a directory path) can never inject control
 *  sequences into the terminal. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]/g, "");
}

function sanitizeAll(lines: string[]): string[] {
  return lines.map(sanitize);
}

/** Pulls a `--flag value` pair out of `args`. A repeated flag is hardened
 *  deterministically: the LAST occurrence's value wins. `present` is true
 *  whenever the flag token itself was seen, even with a missing value, so
 *  callers can distinguish "absent" from "malformed". */
function extractValueFlag(args: string[], flag: string): { present: boolean; value: string | undefined; rest: string[] } {
  let present = false;
  let value: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      present = true;
      if (i + 1 < args.length) {
        value = args[i + 1];
        i += 1;
      } else {
        value = undefined;
      }
      continue;
    }
    rest.push(args[i]);
  }
  return { present, value, rest };
}

// ---------------------------------------------------------------------------
// hades showdown verify --dir <path>
// ---------------------------------------------------------------------------

/**
 * Independently audits a published live-showdown run directory. `--dir` is
 * required and is resolved against `deps.cwd` when relative (an absolute
 * `--dir` is used as-is). Exit 0 iff every audit check passes; exit 1 with
 * every failed check's name+detail otherwise. Usage errors (missing/absent
 * `--dir`, unexpected extra args) also exit 1.
 */
export async function runShowdownVerifyCommand(args: string[], deps: ShowdownVerifyCommandDeps): Promise<CliResult> {
  const dirFlag = extractValueFlag(args, "--dir");

  if (!dirFlag.present) {
    return { code: 1, lines: sanitizeAll(["Missing required --dir <path>.", ...VERIFY_USAGE]) };
  }
  if (dirFlag.value === undefined) {
    return { code: 1, lines: sanitizeAll(["--dir requires a value.", ...VERIFY_USAGE]) };
  }
  if (dirFlag.rest.length > 0) {
    return { code: 1, lines: sanitizeAll([`Unexpected argument: ${dirFlag.rest[0]}`, ...VERIFY_USAGE]) };
  }

  const resolvedDir = isAbsolute(dirFlag.value) ? dirFlag.value : join(deps.cwd, dirFlag.value);

  const audit = await verifyLiveRunDir(resolvedDir, deps.fs);
  const rendered = renderManifestAudit(audit);
  return { code: audit.ok ? 0 : 1, lines: sanitizeAll(rendered) };
}

// ---------------------------------------------------------------------------
// hades showdown ready
// ---------------------------------------------------------------------------

/**
 * Prints an honest readiness report for a keyed live showdown in this
 * environment (`livePreflightSummary(deps.env)`), unchanged apart from
 * control-character sanitization. Exit 0 when ready, exit 1 when not, so
 * CI can gate a "closed" claim on this command's exit code alone.
 */
export async function runShowdownReadyCommand(deps: ShowdownVerifyCommandDeps): Promise<CliResult> {
  const summary = livePreflightSummary(deps.env);
  return { code: summary.ready ? 0 : 1, lines: sanitizeAll(summary.lines) };
}
