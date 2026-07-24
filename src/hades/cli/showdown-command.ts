/**
 * `hades showdown <sub>` — the killer demo CLI.
 *
 *   hades showdown run [--tasks N] [--seed S] [--mode modeled|real] [--out dir]
 *   hades showdown verify <dir>
 *   hades showdown help
 *
 * `run` executes the 200-task (default) suite through the REAL swarm engine
 * vs the self-trusting single-agent baseline (see `../bench/showdown`),
 * prints the honest scoreboard, and — with `--out` — writes durable,
 * hash-chain-audited artifacts (`report.md`, `audit.jsonl`, `result.json`).
 *
 * `verify` re-reads a previously written `audit.jsonl` from disk and
 * independently re-verifies its hash chain — it catches both a truncated
 * (malformed-JSON) log and a reordered/tampered one, and never trusts
 * anything about the file beyond what it can re-derive.
 *
 * Terminal-free (`{ code, lines }`) like the rest of `src/hades/cli/*`, so
 * it unit-tests without a shell or real stdout.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runShowdown } from "../bench/showdown";
import type { AuditRecord, ShowdownMode } from "../bench/showdown";
import { renderShowdownText, writeShowdownArtifacts } from "../bench/showdown-report";
import type { ShowdownFsDeps } from "../bench/showdown-report";
import { verifyAuditChain } from "../bench/showdown";

export interface ShowdownCommandResult {
  code: number;
  lines: string[];
}

export interface ShowdownCommandFsDeps extends ShowdownFsDeps {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
}

export interface ShowdownCommandDeps {
  now?: () => number;
  fs?: ShowdownCommandFsDeps;
  /** Optional live sink for progress/output lines as they're produced;
   *  the returned `lines` array always carries the full final report
   *  regardless of whether this is provided. */
  stdout?: (line: string) => void;
}

// Lazily wire the default fs deps from node:fs/promises — resolved on first
// use so tests can always fully inject their own instead.
async function resolveDefaultFs(): Promise<ShowdownCommandFsDeps> {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  return { mkdir, writeFile, rename, readFile };
}

const USAGE = [
  "Usage: hades showdown <command>",
  "",
  "Commands:",
  "  run [--tasks N] [--seed S] [--mode modeled|real] [--out dir]",
  "                       Run the showdown suite (swarm vs single-agent baseline)",
  "                       and print the honest V-TPH$ scoreboard.",
  "                       --tasks defaults to 200, --seed defaults to 42,",
  "                       --mode defaults to modeled (deterministic, no keys needed).",
  "                       --out writes report.md + audit.jsonl + result.json.",
  "  verify <dir>         Re-read <dir>/audit.jsonl and independently re-verify",
  "                       its hash chain (catches truncation, tampering, reordering).",
  "  live / live-verify   The LIVE (keyed, billed, wall-clock-budgeted) exit lane",
  "                       with a sha256 manifest.json — run `hades showdown live help`.",
  "  help                 Show this help",
  "",
  "mode=modeled uses deterministic scripted providers (no network, no API key);",
  "every figure it prints is labeled (modeled). mode=real requires",
  "ANTHROPIC_API_KEY or OPENAI_API_KEY and runs live inference through the same",
  "real swarm engine and baseline runner `hades bench` uses.",
];

function readFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parsePositiveInt(raw: string | undefined, flag: string): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: `Invalid ${flag} value: "${raw}" — expected a positive integer.` };
  }
  return { value: n };
}

function parseInteger(raw: string | undefined, flag: string): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return { error: `Invalid ${flag} value: "${raw}" — expected an integer.` };
  }
  return { value: n };
}

async function runSub(rest: string[], deps: ShowdownCommandDeps): Promise<ShowdownCommandResult> {
  const modeRaw = readFlag(rest, "--mode") ?? "modeled";
  if (modeRaw !== "modeled" && modeRaw !== "real") {
    return { code: 1, lines: [`Invalid --mode "${modeRaw}" — expected "modeled" or "real".`] };
  }
  const mode = modeRaw as ShowdownMode;

  const tasksParsed = parsePositiveInt(readFlag(rest, "--tasks"), "--tasks");
  if (tasksParsed.error) return { code: 1, lines: [tasksParsed.error] };

  const seedParsed = parseInteger(readFlag(rest, "--seed"), "--seed");
  if (seedParsed.error) return { code: 1, lines: [seedParsed.error] };
  const seed = seedParsed.value ?? 42;

  const outDir = readFlag(rest, "--out");
  const now = deps.now ?? Date.now;

  let result;
  try {
    result = await runShowdown({
      mode,
      seed,
      taskCount: tasksParsed.value,
      now,
      onProgress: (done, total) => deps.stdout?.(`showdown: ${done}/${total} task-runs complete`),
    });
  } catch (err) {
    return { code: 1, lines: [err instanceof Error ? err.message : String(err)] };
  }

  let lines: string[];
  try {
    lines = renderShowdownText(result);
  } catch (err) {
    return {
      code: 1,
      lines: [`showdown run: audit verification failed after the run completed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  for (const l of lines) deps.stdout?.(l);

  const outLines = [...lines];
  if (outDir) {
    const fs = deps.fs ?? (await resolveDefaultFs());
    const { files } = await writeShowdownArtifacts(result, outDir, fs);
    outLines.push("", `Artifacts written:`, ...files.map((f) => `  ${f}`));
  }

  return { code: 0, lines: outLines };
}

async function verifySub(rest: string[], deps: ShowdownCommandDeps): Promise<ShowdownCommandResult> {
  const dir = rest[0];
  if (!dir) return { code: 1, lines: ["Usage: hades showdown verify <dir>"] };

  const fs = deps.fs ?? (await resolveDefaultFs());
  const auditPath = join(dir, "audit.jsonl");

  let raw: string;
  try {
    raw = await fs.readFile(auditPath, "utf8");
  } catch (err) {
    return { code: 1, lines: [`Could not read ${auditPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const records: AuditRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]) as AuditRecord);
    } catch {
      return {
        code: 1,
        lines: [
          `${auditPath} is truncated or malformed at line ${i + 1} of ${lines.length} — could not parse JSON.`,
        ],
      };
    }
  }

  const check = verifyAuditChain(records);
  if (!check.ok) {
    return {
      code: 1,
      lines: [
        `Audit chain verification FAILED at record ${check.brokenAt} (read ${records.length} record(s) from ${auditPath}).`,
        "The log is truncated, reordered, or tampered — refusing to treat it as trustworthy.",
      ],
    };
  }

  return { code: 0, lines: [`Audit chain OK — ${records.length} record(s) independently re-verified from ${auditPath}.`] };
}

export async function runShowdownCommand(
  args: string[],
  deps: ShowdownCommandDeps = {}
): Promise<ShowdownCommandResult> {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { code: 0, lines: USAGE };
  }
  if (sub === "run") return runSub(rest, deps);
  if (sub === "verify") return verifySub(rest, deps);

  return { code: 1, lines: [`Unknown showdown command: ${sub}`, "Run `hades showdown help` for usage."] };
}
