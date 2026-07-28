#!/usr/bin/env node
/**
 * Orchestrates the Hades desktop packaging pipeline — the honest, headless-safe
 * front half of "make an installer".
 *
 * What this script does, in order:
 *   1. Bundles the Node sidecar (`scripts/build-sidecar.mjs` → buildSidecar).
 *   2. Bundles the webview UI     (`scripts/build-desktop.mjs`  → buildDesktop).
 *   3. Checks the prerequisites for the native packaging step (a `cargo`
 *      toolchain, the `cargo tauri` CLI, and a display / webview runtime) and
 *      prints the EXACT command that produces the installers:
 *
 *          cd src-tauri && cargo tauri build --features gui
 *
 * What this script deliberately does NOT do here: it never fakes the Tauri
 * build. `cargo tauri build` needs a machine with a display + the platform
 * webview libraries (WebKitGTK / WebView2 / WKWebView) + the `cargo tauri`
 * CLI + a `gui` Cargo feature on `src-tauri` (being added in parallel — see
 * docs/DESKTOP_APP.md). None of that exists in a headless sandbox, so when the
 * prerequisites (or a display) are absent the script runs in `--dry-run` mode:
 * it still performs the two JS bundle halves for real, then REPORTS what the
 * Tauri step would do instead of pretending it ran. Pass `--dry-run` to force
 * that mode even where the toolchain exists.
 *
 * Exit code contract: non-zero ONLY when a step this script actually attempted
 * really failed (a bundle throwing). A dry-run that skips the Tauri step is a
 * success (exit 0); a bundle no-op because esbuild isn't installed is a warned
 * skip, not a failure.
 *
 * The orchestration is factored into small, injectable, side-effect-light
 * functions (detectPrerequisites / planPackage / packageDesktop) so the whole
 * flow is unit-testable without a display and without ever shelling out to
 * cargo — see src/desktop/__tests__/package-desktop.test.ts.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildSidecar } from "./build-sidecar.mjs";
import { buildDesktop } from "./build-desktop.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

/**
 * The one and only command that turns the bundled halves into real installers.
 * Kept as an exported constant so docs, the CLI output, and the tests all
 * assert against a single source of truth.
 */
export const TAURI_BUILD_COMMAND = "cd src-tauri && cargo tauri build --features gui";

/** The installer targets tauri.conf.json declares, for honest reporting. */
export const BUNDLE_TARGETS = Object.freeze([
  { target: "dmg", platform: "macos-latest" },
  { target: "app", platform: "macos-latest" },
  { target: "deb", platform: "ubuntu-latest" },
  { target: "appimage", platform: "ubuntu-latest" },
  { target: "msi", platform: "windows-latest" },
  { target: "nsis", platform: "windows-latest" },
]);

/**
 * Resolve a command name against a PATH-like environment WITHOUT spawning a
 * child process (no `which`/`where` shell-out). Pure w.r.t. its inputs: feed it
 * a fake `env`/`platform` and it becomes fully deterministic. Returns the
 * resolved absolute path, or null if the command isn't found.
 *
 * @param {string} cmd
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env] PATH-like environment.
 *   Typed as a plain readonly bag (not `NodeJS.ProcessEnv`) for the same
 *   reason `detectPrerequisites` below is: this function only READS `PATH`,
 *   so demanding the full `ProcessEnv` shape — which `@types/node` augments
 *   to require `NODE_ENV` — would force every caller and test to supply a
 *   variable it never looks at.
 * @param {NodeJS.Platform} [opts.platform]
 * @returns {string|null}
 */
export function lookupOnPath(cmd, { env = process.env, platform = process.platform } = {}) {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) return null;
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Detect the prerequisites for the native `cargo tauri build` step. PURE with
 * respect to its injected inputs — pass a fake `lookup(cmd) => string|null` and
 * a fake `env`/`platform` and it computes a fully deterministic result with no
 * I/O of its own. That's what makes it unit-testable without a real toolchain.
 *
 * @param {object} [opts]
 * @param {(cmd: string) => string|null} [opts.lookup] command resolver
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {NodeJS.Platform} [opts.platform]
 * @returns {{cargo:boolean, cargoTauri:boolean, hasDisplay:boolean, ready:boolean, missing:string[]}}
 */
export function detectPrerequisites({ lookup, env = process.env, platform = process.platform } = {}) {
  const resolve = lookup ?? ((cmd) => lookupOnPath(cmd, { env, platform }));

  const cargo = Boolean(resolve("cargo"));
  // `cargo tauri` is provided by the `cargo-tauri` binary on PATH; a bare
  // `tauri` CLI is also accepted as an equivalent.
  const cargoTauri = Boolean(resolve("cargo-tauri")) || Boolean(resolve("tauri"));
  // macOS/Windows ship a system webview and always have a display context for a
  // GUI build; on Linux a running X/Wayland session is required.
  const hasDisplay =
    platform === "darwin" ||
    platform === "win32" ||
    Boolean(env.DISPLAY) ||
    Boolean(env.WAYLAND_DISPLAY);

  const missing = [];
  if (!cargo) missing.push("cargo (Rust toolchain)");
  if (!cargoTauri) missing.push("cargo-tauri (Tauri CLI: `cargo install tauri-cli`)");
  if (!hasDisplay) missing.push("a display / webview runtime (headless: no DISPLAY)");

  return { cargo, cargoTauri, hasDisplay, ready: missing.length === 0, missing };
}

/**
 * Build the packaging plan from a prerequisites result and a dry-run decision.
 * Pure — no I/O — so a test can assert the exact ordered steps and the command
 * string that WOULD run, without anything actually running.
 *
 * @param {object} opts
 * @param {ReturnType<typeof detectPrerequisites>} opts.prerequisites
 * @param {boolean} opts.dryRun
 */
export function planPackage({ prerequisites, dryRun }) {
  return {
    dryRun,
    tauriCommand: TAURI_BUILD_COMMAND,
    prerequisites,
    steps: [
      { name: "bundle-sidecar", action: "run", description: "esbuild → dist/desktop/sidecar-entry.js" },
      { name: "bundle-ui", action: "run", description: "esbuild → dist/desktop/{main.js,main.css,index.html}" },
      {
        name: "tauri-build",
        action: dryRun ? "skip" : "run",
        command: TAURI_BUILD_COMMAND,
        description: dryRun
          ? "SKIPPED: needs cargo + cargo-tauri + a display; run the command manually / in CI"
          : "produces installers into src-tauri/target/release/bundle/",
      },
    ],
  };
}

/**
 * Default runner for the real Tauri step. Only ever invoked when NOT in
 * dry-run mode, i.e. never in the headless sandbox / tests (which either force
 * dry-run or inject a fake runner). Returns the child process status.
 */
function defaultRunTauri({ log } = { log: console.log }) {
  const srcTauri = path.join(repoRoot, "src-tauri");
  log(`[package-desktop] running: ${TAURI_BUILD_COMMAND}`);
  const result = spawnSync("cargo", ["tauri", "build", "--features", "gui"], {
    cwd: srcTauri,
    stdio: "inherit",
  });
  return { status: result.status ?? 1, error: result.error };
}

/**
 * Run the packaging pipeline. Everything with a side effect is injectable so
 * the flow can be exercised in tests without touching esbuild, cargo, or a
 * display.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] force dry-run; default = auto (dry-run when
 *        prerequisites are absent)
 * @param {typeof buildSidecar} [options.buildSidecarFn]
 * @param {() => Promise<{ok?:boolean, reason?:string, outdir?:string, config?:object}>} [options.buildUiFn]
 *   The UI-bundling seam. Declared by CONTRACT rather than as
 *   `typeof buildDesktop`: tying it to the real implementation pins every
 *   injected fake to esbuild's full inferred config shape, so a test double
 *   could not supply the two fields this function actually reads (`ok`,
 *   `reason`/`outdir`) without reproducing the entire build config.
 * @param {(cmd:string)=>string|null} [options.lookup]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(...a:any[])=>void} [options.log]
 * @param {(...a:any[])=>void} [options.logError]
 * @param {(ctx:{log:Function})=>{status:number,error?:Error}} [options.runTauri]
 * @returns {Promise<{ok:boolean, dryRun:boolean,
 *          plan:ReturnType<typeof planPackage>,
 *          sidecar:object, ui:object, prerequisites:object, tauriRan:boolean,
 *          failedStep?:string}>}
 */
export async function packageDesktop(options = {}) {
  const {
    dryRun,
    buildSidecarFn = buildSidecar,
    buildUiFn = buildDesktop,
    lookup,
    env = process.env,
    platform = process.platform,
    log = console.log,
    logError = console.error,
    runTauri = defaultRunTauri,
  } = options;

  const prerequisites = detectPrerequisites({ lookup, env, platform });
  // Auto: dry-run unless the caller explicitly said otherwise. If the caller
  // forces dryRun:false but prerequisites are missing, we honor the request and
  // let the real step fail loudly rather than silently swallowing it.
  const effectiveDryRun = dryRun ?? !prerequisites.ready;
  const plan = planPackage({ prerequisites, dryRun: effectiveDryRun });

  log("── Hades desktop packaging ──────────────────────────────────");
  log(`mode: ${effectiveDryRun ? "DRY RUN (no installer produced)" : "FULL (cargo tauri build)"}`);
  log(
    `prerequisites: cargo=${prerequisites.cargo} cargo-tauri=${prerequisites.cargoTauri} ` +
      `display=${prerequisites.hasDisplay}`
  );

  // ── Step 1: sidecar bundle ────────────────────────────────────────────────
  log("\n[1/3] bundling Node sidecar …");
  let sidecar;
  try {
    sidecar = await buildSidecarFn();
  } catch (err) {
    logError("[package-desktop] sidecar bundle FAILED:", err);
    return { ok: false, dryRun: effectiveDryRun, plan, prerequisites, tauriRan: false, failedStep: "bundle-sidecar", sidecar: { error: String(err) }, ui: undefined };
  }
  if (sidecar?.skipped) {
    log(`      ↳ skipped (${sidecar.reason ?? "unknown"}) — esbuild not installed; not a failure.`);
  } else {
    log(`      ↳ ok → ${relFromRoot(sidecar?.outfile)}`);
  }

  // ── Step 2: UI bundle ─────────────────────────────────────────────────────
  log("[2/3] bundling webview UI …");
  let ui;
  try {
    ui = await buildUiFn();
  } catch (err) {
    logError("[package-desktop] UI bundle FAILED:", err);
    return { ok: false, dryRun: effectiveDryRun, plan, prerequisites, tauriRan: false, failedStep: "bundle-ui", sidecar, ui: { error: String(err) } };
  }
  if (ui && ui.ok === false) {
    log(`      ↳ skipped (${ui.reason ?? "unknown"}) — esbuild not installed; not a failure.`);
  } else {
    log(`      ↳ ok → ${relFromRoot(ui?.outdir)}/{main.js,main.css,index.html}`);
  }

  // ── Step 3: native Tauri build ────────────────────────────────────────────
  log("[3/3] native installer (cargo tauri build) …");
  if (effectiveDryRun) {
    log("      ↳ SKIPPED (dry run). To produce installers, run on a machine with a display:");
    log(`\n          ${TAURI_BUILD_COMMAND}\n`);
    if (prerequisites.missing.length > 0) {
      log("      missing prerequisites here:");
      for (const m of prerequisites.missing) log(`        • ${m}`);
    }
    log(
      "      would emit: " +
        BUNDLE_TARGETS.map((t) => t.target).join(", ") +
        " → src-tauri/target/release/bundle/"
    );
    return { ok: true, dryRun: true, plan, prerequisites, tauriRan: false, sidecar, ui };
  }

  const tauri = runTauri({ log });
  if (tauri.error || (tauri.status ?? 0) !== 0) {
    logError(`[package-desktop] cargo tauri build FAILED (status=${tauri.status})`, tauri.error ?? "");
    return { ok: false, dryRun: false, plan, prerequisites, tauriRan: true, failedStep: "tauri-build", sidecar, ui };
  }
  log("      ↳ ok → installers under src-tauri/target/release/bundle/");
  return { ok: true, dryRun: false, plan, prerequisites, tauriRan: true, sidecar, ui };
}

function relFromRoot(p) {
  if (!p) return "(unknown)";
  return path.relative(repoRoot, p) || p;
}

/** Parse argv into options for packageDesktop. Exported for testability. */
export function parseArgs(argv = []) {
  const opts = {};
  if (argv.includes("--dry-run")) opts.dryRun = true;
  if (argv.includes("--no-dry-run") || argv.includes("--full")) opts.dryRun = false;
  return opts;
}

// Auto-run only as a script entry point, never on import.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  packageDesktop(opts)
    .then((result) => {
      if (!result.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[package-desktop] unexpected failure:", err);
      process.exitCode = 1;
    });
}
