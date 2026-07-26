#!/usr/bin/env node
/**
 * Bundles the Hades desktop webview frontend (the Tauri `frontendDist`)
 * from src/desktop/ui/main.ts + its CSS imports into an output directory
 * (dist/desktop/ by default): main.js, main.css, and a copy of index.html.
 *
 * Honesty: this script only produces the static webview bundle that the
 * native shell loads. Actually launching the app window still requires
 * `cargo tauri dev` / `cargo tauri build`, run locally on a machine with a
 * display and the platform webview runtime installed — that step cannot be
 * performed in this headless environment and is not attempted here.
 */
import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ENTRY = path.join(ROOT, "src/desktop/ui/main.ts");
const INDEX_HTML = path.join(ROOT, "src/desktop/ui/index.html");
const DEFAULT_OUTDIR = path.join(ROOT, "dist/desktop");

/**
 * The esbuild config used to bundle the webview entry. Exported (via
 * `buildDesktop`'s return value) so callers/tests can inspect it even when
 * esbuild itself isn't installed.
 */
export function buildConfig(outdir = DEFAULT_OUTDIR) {
  return {
    entryPoints: { main: ENTRY },
    outdir,
    bundle: true,
    platform: "browser",
    target: "esnext",
    format: "esm",
    sourcemap: false,
    logLevel: "silent",
    loader: { ".css": "css" },
    // `./bridge`'s devBridge statically imports the real sidecar
    // (`../core/sidecar.ts` -> `../../swarm-runtime/server/build-swarm`),
    // which is Node-only (node:events, node:crypto, node:http, ...). That
    // path never actually runs inside the Tauri webview at runtime — main.ts
    // only calls devBridge() when `window.__TAURI__` is absent, i.e. never
    // in the shipped app — but esbuild still needs to statically resolve
    // every import to bundle. Marking node: specifiers external lets the
    // production (tauriBridge) code path bundle cleanly without vendoring
    // Node built-ins into a browser artifact. See build-desktop.test.ts /
    // final report for the caveat this implies for `desktop:dev` bundles.
    external: ["node:*"],
  };
}

/**
 * Bundles src/desktop/ui/main.ts (+ its CSS imports) into `outdir` and
 * copies index.html alongside it. Requires `esbuild` to already be present
 * in node_modules — this script never installs dependencies itself. If
 * esbuild is missing, prints a clear message and returns a non-ok result
 * instead of throwing, so callers (including tests) can still exercise the
 * config-building half of this module.
 */
export async function buildDesktop({ outdir = DEFAULT_OUTDIR } = {}) {
  if (!existsSync(ENTRY) || !existsSync(INDEX_HTML)) {
    throw new Error(
      `[build-desktop] missing frontend source: expected ${ENTRY} and ${INDEX_HTML} to exist.`
    );
  }

  await mkdir(outdir, { recursive: true });
  const config = buildConfig(outdir);

  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.error(
      "[build-desktop] esbuild is not installed in node_modules — cannot bundle the desktop " +
        "frontend. Install it as a devDependency (`npm i -D esbuild`) and re-run " +
        "`node scripts/build-desktop.mjs`."
    );
    return { ok: false, reason: "esbuild-missing", outdir, config };
  }

  await esbuild.build(config);
  await copyFile(INDEX_HTML, path.join(outdir, "index.html"));

  return { ok: true, outdir, config };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await buildDesktop();
  if (!result.ok) {
    process.exitCode = 1;
  } else {
    console.log(
      `✓ desktop bundle → ${path.relative(ROOT, result.outdir)}/{main.js, main.css, index.html}`
    );
  }
}
