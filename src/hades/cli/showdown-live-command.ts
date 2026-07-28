/**
 * `hades showdown live` / `hades showdown live-verify` — the CLI surface
 * for the LIVE (real, keyed, billed) showdown exit lane.
 *
 *   hades showdown live [--tasks N] [--seed S] [--out DIR] [--max-wall-ms MS]
 *   hades showdown live-verify <dir>
 *   hades showdown live help
 *
 * `live` requires `--out` (a live run is never fire-and-forget — its
 * artifacts + manifest must land somewhere durable) and requires a
 * configured provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`); with
 * no key it refuses to run and says so — there is no modeled fallback.
 *
 * `live-verify` re-reads a previously published directory and
 * independently re-derives every claim in its `manifest.json` (see
 * `../bench/showdown-live`'s `verifyLiveArtifacts`); its exit code mirrors
 * the verification's `ok` flag.
 *
 * Deps-injected and terminal-free, same pattern as `./showdown-command.ts`:
 * all output goes through `deps.write`, so this is fully unit-testable
 * without a real stdout, a real fs, or a real provider key.
 */
import { runLiveShowdown, verifyLiveArtifacts } from "../bench/showdown-live";

/**
 * Injectable dependencies for {@link runShowdownLiveCommand}. `run` and
 * `verify` default to the real `runLiveShowdown` / `verifyLiveArtifacts`
 * in production wiring; tests inject stubs so the command can be exercised
 * without a network, a real fs, or a real provider key.
 */
export interface ShowdownLiveCommandDeps {
  run: typeof runLiveShowdown;
  verify: typeof verifyLiveArtifacts;
  env: Record<string, string | undefined>;
  write: (line: string) => void;
  now?: () => number;
}

const USAGE = [
  "Usage: hades showdown live <command>",
  "",
  "Commands:",
  "  live [--tasks N] [--seed S] [--out DIR] [--max-wall-ms MS]",
  "                          Run a REAL, keyed, wall-clock-budgeted showdown",
  "                          against the live swarm engine vs the",
  "                          self-trusting single-agent baseline.",
  "                          --tasks defaults to 12 (hard cap 50).",
  "                          --seed defaults to 42.",
  "                          --out is REQUIRED: directory for report.md,",
  "                          audit.jsonl, result.json, and manifest.json.",
  "                          --max-wall-ms defaults to 900000 (15 minutes).",
  "  live-verify <dir>       Independently re-verify a previously published",
  "                          live-run directory's manifest.json against its",
  "                          report.md / audit.jsonl / result.json.",
  "  help                    Show this help",
  "",
  "There is no modeled fallback for `live`: with no ANTHROPIC_API_KEY or",
  "OPENAI_API_KEY configured, it refuses to run and names exactly which",
  "env vars it checked. Live numbers exist only when a key was present",
  "and a real run actually happened.",
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

/** Render an optional verified-yield figure. `undefined` (a manifest that
 *  predates the trust-adjusted metric) renders as an honest "n/a", never a
 *  fabricated 0; non-finite numbers render verbatim (same policy as the
 *  V-TPH$ multiple above). */
function yieldStr(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

async function liveSub(rest: string[], deps: ShowdownLiveCommandDeps): Promise<number> {
  const tasksParsed = parsePositiveInt(readFlag(rest, "--tasks"), "--tasks");
  if (tasksParsed.error) {
    deps.write(tasksParsed.error);
    for (const l of USAGE) deps.write(l);
    return 1;
  }

  const seedParsed = parseInteger(readFlag(rest, "--seed"), "--seed");
  if (seedParsed.error) {
    deps.write(seedParsed.error);
    for (const l of USAGE) deps.write(l);
    return 1;
  }
  const seed = seedParsed.value ?? 42;

  const maxWallParsed = parsePositiveInt(readFlag(rest, "--max-wall-ms"), "--max-wall-ms");
  if (maxWallParsed.error) {
    deps.write(maxWallParsed.error);
    for (const l of USAGE) deps.write(l);
    return 1;
  }

  const outDir = readFlag(rest, "--out");
  if (!outDir) {
    deps.write("Missing required --out <dir> for `hades showdown live`.");
    for (const l of USAGE) deps.write(l);
    return 1;
  }

  try {
    const { manifest, files } = await deps.run(
      { seed, taskCount: tasksParsed.value, outDir, maxWallMs: maxWallParsed.value },
      {
        env: deps.env,
        now: deps.now,
        onProgress: (done, total) => deps.write(`showdown live: ${done}/${total} task-runs complete`),
      }
    );

    const multipleStr = Number.isFinite(manifest.vtph.multiple)
      ? `${manifest.vtph.multiple.toFixed(2)}x`
      : String(manifest.vtph.multiple);

    deps.write(
      `Live showdown complete — mode=real provider=${manifest.provider} model=${manifest.model} ` +
        `seed=${manifest.seed} tasks=${manifest.taskCount} wallMs=${manifest.wallMs}`
    );
    deps.write(
      `V-TPH$ — swarm=${manifest.vtph.swarm.toFixed(2)} baseline=${manifest.vtph.baseline.toFixed(2)} ` +
        `multiple=${multipleStr} (swarmVerified=${manifest.vtph.swarmVerified} ` +
        `baselineVerified=${manifest.vtph.baselineVerified})`
    );
    // Trust-adjusted headline (verified-yield/$, silent-wrong penalized 10x).
    // Live figures are real-mode by construction, so no "(modeled)" label —
    // and a manifest predating the metric prints an honest n/a, never 0.
    deps.write(
      `Verified-yield — swarm=${yieldStr(manifest.vtph.swarmVerifiedYield)} ` +
        `baseline=${yieldStr(manifest.vtph.baselineVerifiedYield)}`
    );
    deps.write("Artifacts written:");
    for (const f of files) deps.write(`  ${f}`);
    return 0;
  } catch (err) {
    deps.write(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function liveVerifySub(rest: string[], deps: ShowdownLiveCommandDeps): Promise<number> {
  const dir = rest[0];
  if (!dir) {
    deps.write("Usage: hades showdown live-verify <dir>");
    return 1;
  }

  let outcome: { ok: boolean; findings: string[] };
  try {
    outcome = await deps.verify(dir);
  } catch (err) {
    deps.write(`live-verify: unexpected error reading ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (outcome.ok) {
    deps.write(`Live artifacts in ${dir} verified OK — 0 findings.`);
    return 0;
  }

  deps.write(`Live artifact verification FAILED for ${dir} — ${outcome.findings.length} finding(s):`);
  for (const finding of outcome.findings) deps.write(`  - ${finding}`);
  return 1;
}

/**
 * Entry point for `hades showdown live` / `hades showdown live-verify`.
 * Returns a process exit code (0 success, 1 refusal/failure); all textual
 * output is emitted through `deps.write` rather than a real stdout so the
 * command is fully unit-testable.
 */
export async function runShowdownLiveCommand(argv: string[], deps: ShowdownLiveCommandDeps): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    for (const l of USAGE) deps.write(l);
    return 0;
  }
  if (sub === "live") return liveSub(rest, deps);
  if (sub === "live-verify") return liveVerifySub(rest, deps);

  deps.write(`Unknown showdown-live command: ${sub}`);
  for (const l of USAGE) deps.write(l);
  return 1;
}
