#!/usr/bin/env node
/**
 * Bundles the Hades desktop sidecar entry point
 * (`src/desktop/sidecar-entry.ts`) into a single, mostly dependency-free
 * Node script under `dist/desktop/sidecar-entry.js`.
 *
 * This is what the native shell (`src-tauri/src/main.rs`) actually spawns —
 * see `src/desktop/sidecar-entry.ts`'s own header comment for the stdio
 * contract. Bundling (rather than shipping raw TS or a `tsx`/`ts-node`
 * wrapper) means the desktop app's install doesn't need a TypeScript
 * toolchain at runtime, just `node dist/desktop/sidecar-entry.js`.
 *
 * Mirrors `scripts/build-swarm.mjs`'s esbuild setup: CJS output (this repo's
 * `package.json` has no `"type": "module"`, so plain `.js` files are loaded
 * as CommonJS by Node), `packages: "external"` so npm dependencies are
 * required at runtime instead of inlined (keeps the bundle small; the
 * sidecar always runs from within this repo's own `node_modules`), and a
 * shebang banner so the output is directly executable.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, readFile } from "node:fs/promises";

const SHEBANG = "#!/usr/bin/env node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

/** Default source entry point: the sidecar's committed TS entry file. */
export const DEFAULT_ENTRY_POINT = path.join(repoRoot, "src/desktop/sidecar-entry.ts");

/** Default bundle destination — what the native shell spawns by default. */
export const DEFAULT_OUTFILE = path.join(repoRoot, "dist/desktop/sidecar-entry.js");

/**
 * Bundle the sidecar entry point with esbuild.
 *
 * Exported (rather than only run as a script) so tests and other build
 * tooling can invoke it directly with a scratch `outfile`, without shelling
 * out to a child process.
 *
 * Never throws just because esbuild isn't installed: `esbuild` is a
 * devDependency, not a hard runtime dependency of this repo, so an
 * environment that skipped dev installs (or trimmed them for a slim CI
 * step) should get a clear, actionable message instead of an unhandled
 * import error. Callers can check `result.skipped` to tell the two outcomes
 * apart.
 */
export async function buildSidecar({ outfile = DEFAULT_OUTFILE, entryPoint = DEFAULT_ENTRY_POINT } = {}) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.error(
      "[build-sidecar] esbuild is not installed — run `npm install` (esbuild is a " +
        "devDependency) before building the desktop sidecar. Skipping bundle; " +
        `expected output: ${outfile}`
    );
    return { skipped: true, reason: "esbuild-missing", outfile };
  }

  // esbuild preserves a leading shebang line on the entry file verbatim in
  // its output (it does not treat it as a comment to strip); `sidecar-entry.ts`
  // already opens with `#!/usr/bin/env node`, so unconditionally passing a
  // `banner` here would double it up into two shebang lines — which Node
  // refuses to parse (`SyntaxError: Invalid or unexpected token` on the
  // second `#!`). Only add the banner when the source doesn't already carry
  // one, so the bundle always starts with exactly one shebang either way.
  const source = await readFile(entryPoint, "utf8");
  const needsBanner = !source.startsWith(SHEBANG);

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    packages: "external",
    ...(needsBanner ? { banner: { js: SHEBANG } } : {}),
    sourcemap: false,
    logLevel: "info",
  });

  // Best-effort: the shebang banner already makes the file self-executing
  // content-wise, but the executable bit matters if anything ever spawns it
  // directly (`./sidecar-entry.js`) instead of via `node <file>`.
  await chmod(outfile, 0o755).catch(() => {});

  console.log(`✓ sidecar bundle → ${path.relative(repoRoot, outfile)}`);
  return { skipped: false, outfile };
}

// Only auto-run when this file is the process entry point (`node
// scripts/build-sidecar.mjs`), never when imported by a test or another
// build script.
const invokedDirectly = process.argv[1] === __filename;
if (invokedDirectly) {
  buildSidecar().catch((err) => {
    console.error("[build-sidecar] build failed:", err);
    process.exitCode = 1;
  });
}
