/**
 * `hades setup`, `hades doctor`, `hades update` — the front door.
 *
 * These are the three commands a new user reaches for before they know
 * anything else about the product, so they follow three rules:
 *
 *  1. **Nothing is written without being asked for.** `setup` defaults to a
 *     preview; `--write` is what actually touches disk. `doctor` and the
 *     `update` check are read-only, always.
 *  2. **Nothing is guessed.** Every readiness line comes from a real probe of
 *     this machine — the running node version, whether the data dir exists and
 *     is writable, which provider key variables are actually set (names only,
 *     never values). A key that is absent is reported absent, not assumed.
 *  3. **No self-mutating magic.** `update` reports what is installed and what
 *     is available and prints the exact command to run. It never downloads or
 *     overwrites a running install behind the user's back; see
 *     {@link runUpdateCommand}.
 *
 * Everything here is dependency-injected ({@link SetupDeps}) so the whole
 * surface is unit-testable with a fake filesystem and a fake registry — no
 * network, no writes, no real home directory.
 */

import type { CliResult } from "./cli";
import type { HadesConfig } from "../config/config";

// ---------------------------------------------------------------------------
// Injected environment
// ---------------------------------------------------------------------------

/** The slice of the filesystem these commands need. */
export interface SetupFs {
  exists(path: string): boolean;
  isWritable(path: string): boolean;
  mkdirp(path: string): void;
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
}

/** A published-version lookup. Returns null when it cannot be determined offline. */
export type LatestVersionLookup = () => Promise<string | null> | string | null;

export interface SetupDeps {
  config: HadesConfig;
  env: NodeJS.ProcessEnv;
  fs: SetupFs;
  /** Version of the running install (from package.json). */
  version: string;
  /** Absolute path of the config file `setup --write` would create. */
  configPath: string;
  /** `process.versions.node`, injected so tests can pin it. */
  nodeVersion: string;
  /** Platform string (`process.platform`). */
  platform: string;
  /** Looks up the newest published version; omitted -> update runs offline. */
  latestVersion?: LatestVersionLookup;
}

/** Node major version this build requires (mirrors package.json `engines`). */
export const MIN_NODE_MAJOR = 20;

/** Provider key variables, checked by NAME only — values are never read out. */
export const PROVIDER_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  /** Human-readable finding. Never contains a secret value. */
  detail: string;
  /** Set when !ok: what the user should actually do about it. */
  fix?: string;
}

function majorOf(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

/** Which provider key variables are present. Returns NAMES, never values. */
export function detectProviderKeys(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_KEY_VARS.filter((name) => {
    const v = env[name];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * Every readiness check, run against the injected machine. Pure: it probes,
 * it does not repair. `hades doctor` prints these; `setup` shows them first so
 * you see what you are walking into before anything is written.
 */
export function runChecks(deps: SetupDeps): CheckResult[] {
  const checks: CheckResult[] = [];

  const major = majorOf(deps.nodeVersion);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: "node", ok: true, detail: `v${deps.nodeVersion} (>= ${MIN_NODE_MAJOR} required)` }
      : {
          name: "node",
          ok: false,
          detail: `v${deps.nodeVersion} is below the required v${MIN_NODE_MAJOR}`,
          fix: `Install Node ${MIN_NODE_MAJOR}+ and re-run.`,
        }
  );

  const dataDir = deps.config.dataDir;
  if (!deps.fs.exists(dataDir)) {
    checks.push({
      name: "data-dir",
      ok: false,
      detail: `${dataDir} does not exist yet`,
      fix: "Run `hades setup --write` to create it.",
    });
  } else if (!deps.fs.isWritable(dataDir)) {
    checks.push({
      name: "data-dir",
      ok: false,
      detail: `${dataDir} exists but is not writable`,
      fix: `Fix permissions on ${dataDir}, or set HADES_DATA_DIR to a writable path.`,
    });
  } else {
    checks.push({ name: "data-dir", ok: true, detail: `${dataDir} exists and is writable` });
  }

  checks.push(
    deps.fs.exists(deps.configPath)
      ? { name: "config", ok: true, detail: `${deps.configPath}` }
      : {
          name: "config",
          ok: false,
          detail: `no config file at ${deps.configPath}`,
          fix: "Run `hades setup --write` to create one (defaults are used until then).",
        }
  );

  const keys = detectProviderKeys(deps.env);
  checks.push(
    keys.length > 0
      ? { name: "provider-keys", ok: true, detail: `set: ${keys.join(", ")}` }
      : {
          name: "provider-keys",
          ok: false,
          detail: `none of ${PROVIDER_KEY_VARS.join(", ")} are set — every provider path runs as a labelled [mock]`,
          fix: "Export a provider key to enable real inference. The harness runs offline without one.",
        }
  );

  checks.push({ name: "platform", ok: true, detail: deps.platform });

  return checks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderChecks(checks: CheckResult[]): string[] {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  ${c.ok ? "ok  " : "warn"}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`        ${" ".repeat(width)}  -> ${c.fix}`);
  }
  return lines;
}

/** The config `setup --write` produces. Only non-default values are written. */
export function buildConfigFile(deps: SetupDeps): Record<string, unknown> {
  const out: Record<string, unknown> = { dataDir: deps.config.dataDir, locale: deps.config.locale };
  if (deps.config.model) out.model = deps.config.model;
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const SETUP_USAGE: string[] = [
  "Usage: hades setup [--write] [--json]",
  "",
  "  Preview (default) or apply first-run setup: create the data directory",
  "  and a config file, and report what this machine can actually do.",
  "",
  "  --write   Apply the changes. Without it nothing is written.",
  "  --json    Machine-readable output.",
];

/**
 * `hades setup` — preview by default, apply with `--write`.
 *
 * The preview and the apply path run the SAME checks and describe the SAME
 * actions, so what you are shown is what you get. An existing config file is
 * never clobbered: setup reports it and leaves it alone.
 */
export function runSetupCommand(args: string[], deps: SetupDeps): CliResult {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { code: 0, lines: SETUP_USAGE };
  }
  const json = args.includes("--json");
  const write = args.includes("--write");

  const checks = runChecks(deps);
  const actions: string[] = [];
  const applied: string[] = [];

  const needDataDir = !deps.fs.exists(deps.config.dataDir);
  if (needDataDir) actions.push(`create data directory ${deps.config.dataDir}`);

  const configExists = deps.fs.exists(deps.configPath);
  if (!configExists) actions.push(`write config ${deps.configPath}`);

  if (write) {
    if (needDataDir) {
      deps.fs.mkdirp(deps.config.dataDir);
      applied.push(`created ${deps.config.dataDir}`);
    }
    if (!configExists) {
      deps.fs.writeFile(deps.configPath, `${JSON.stringify(buildConfigFile(deps), null, 2)}\n`);
      applied.push(`wrote ${deps.configPath}`);
    }
  }

  if (json) {
    return {
      code: 0,
      lines: [
        JSON.stringify(
          {
            mode: write ? "apply" : "preview",
            version: deps.version,
            dataDir: deps.config.dataDir,
            configPath: deps.configPath,
            checks,
            plannedActions: actions,
            appliedActions: applied,
            providerKeys: detectProviderKeys(deps.env),
          },
          null,
          2
        ),
      ],
    };
  }

  const lines: string[] = [];
  lines.push(write ? "hades setup — applying" : "hades setup — preview (nothing written)");
  lines.push("");
  lines.push("Readiness:");
  lines.push(...renderChecks(checks));
  lines.push("");

  if (actions.length === 0) {
    lines.push("Nothing to do — this machine is already set up.");
  } else if (write) {
    lines.push("Applied:");
    for (const a of applied) lines.push(`  + ${a}`);
  } else {
    lines.push("Would do:");
    for (const a of actions) lines.push(`  + ${a}`);
    lines.push("");
    lines.push("Re-run with --write to apply.");
  }

  if (configExists && !write) {
    lines.push("");
    lines.push(`An existing config at ${deps.configPath} is left untouched.`);
  }

  lines.push("");
  lines.push("Next: `hades doctor` to re-check, `hades help` for every command.");
  return { code: 0, lines };
}

export const DOCTOR_USAGE: string[] = [
  "Usage: hades doctor [--json]",
  "",
  "  Read-only diagnosis of this machine's readiness. Writes nothing.",
];

/**
 * `hades doctor` — read-only. Exits non-zero when a check fails, so it is
 * usable as a CI/pre-flight gate, not just something a human squints at.
 */
export function runDoctorCommand(args: string[], deps: SetupDeps): CliResult {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { code: 0, lines: DOCTOR_USAGE };
  }
  const checks = runChecks(deps);
  const failed = checks.filter((c) => !c.ok);

  if (args.includes("--json")) {
    return {
      code: failed.length === 0 ? 0 : 1,
      lines: [JSON.stringify({ ok: failed.length === 0, version: deps.version, checks }, null, 2)],
    };
  }

  const lines = [`hades doctor — v${deps.version}`, ""];
  lines.push(...renderChecks(checks));
  lines.push("");
  lines.push(
    failed.length === 0
      ? "All checks passed."
      : failed.length === 1
        ? "1 check needs attention (see -> line above)."
        : `${failed.length} checks need attention (see -> lines above).`
  );
  return { code: failed.length === 0 ? 0 : 1, lines };
}

export const UPDATE_USAGE: string[] = [
  "Usage: hades update [--json]",
  "",
  "  Report the installed version and the newest published one, and print the",
  "  exact upgrade command. This NEVER modifies your install by itself.",
];

/** Semver-ish compare. Returns true when `latest` is strictly newer. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((p) => Number(p) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * `hades update` — a reporter, deliberately not an updater.
 *
 * Self-updating a running process is how installs get corrupted halfway
 * through, and it hides what changed. This tells you exactly where you stand
 * and hands you the one command to run. If the newest version cannot be
 * determined (offline, no lookup injected) it says so rather than implying
 * you are current.
 */
export async function runUpdateCommand(args: string[], deps: SetupDeps): Promise<CliResult> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { code: 0, lines: UPDATE_USAGE };
  }

  let latest: string | null = null;
  let lookupFailed = false;
  if (deps.latestVersion) {
    try {
      latest = (await deps.latestVersion()) ?? null;
    } catch {
      lookupFailed = true;
    }
  }

  const command = "npm install -g hades-agent@latest";
  const behind = latest !== null && isNewer(latest, deps.version);

  if (args.includes("--json")) {
    return {
      code: 0,
      lines: [
        JSON.stringify(
          { current: deps.version, latest, behind, checked: latest !== null, command },
          null,
          2
        ),
      ],
    };
  }

  const lines = [`installed: v${deps.version}`];
  if (latest === null) {
    lines.push(
      lookupFailed
        ? "latest:    could not be determined (the version lookup failed)"
        : "latest:    not checked (no network lookup configured)"
    );
    lines.push("");
    lines.push(`To upgrade regardless: ${command}`);
    return { code: 0, lines };
  }

  lines.push(`latest:    v${latest}`);
  lines.push("");
  if (behind) {
    lines.push(`An update is available. To upgrade:  ${command}`);
    lines.push("(hades never rewrites its own install — run that yourself.)");
  } else {
    lines.push("You are on the newest published version.");
  }
  return { code: 0, lines };
}
