#!/usr/bin/env node
/**
 * Bundles the `hades` CLI entry (`src/hades/bin/hades.ts`) to
 * `dist-hades/hades.js` — the file package.json's `bin.hades` points at, and
 * therefore what `npx hades` / a global install actually executes.
 *
 * Mirrors `scripts/build-sidecar.mjs`: CJS output (this package has no
 * `"type": "module"`), a single shebang, and the executable bit set.
 *
 * Bundling policy matches the sidecar's, and for the same reason: a globally
 * installed CLI has no access to this repo's `node_modules`, so the real
 * runtime dependencies are inlined. Only the genuinely OPTIONAL provider SDKs
 * (the package's `peerDependencies`) stay external — they are `require`d
 * lazily and only when a provider key is present, so force-bundling ones the
 * user never installed would break the build for everyone else.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, readFile } from "node:fs/promises";

const SHEBANG = "#!/usr/bin/env node";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

/** Optional provider SDKs — lazily required, never force-inlined. */
const OPTIONAL_EXTERNALS = [
  "openai",
  "@openai/agents",
  "@anthropic-ai/sdk",
  "zod",
  "@tavily/core",
  "@pinecone-database/pinecone",
  "playwright-core",
  "@daytonaio/sdk",
  "modal",
  "@browserbasehq/sdk",
];

export const DEFAULT_ENTRY_POINT = path.join(repoRoot, "src/hades/bin/hades.ts");
export const DEFAULT_OUTFILE = path.join(repoRoot, "dist-hades/hades.js");

/**
 * Bundle the CLI. Exported so tests can build to a scratch outfile without
 * shelling out. Never throws merely because esbuild is absent (it is a
 * devDependency): callers check `result.skipped`.
 */
export async function buildHades({ outfile = DEFAULT_OUTFILE, entryPoint = DEFAULT_ENTRY_POINT } = {}) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.error(
      "[build-hades] esbuild is not installed — run `npm install` (esbuild is a " +
        `devDependency) before building the CLI. Skipping; expected output: ${outfile}`
    );
    return { skipped: true, reason: "esbuild-missing", outfile };
  }

  // esbuild preserves a leading shebang from the entry file verbatim, so
  // adding the banner unconditionally would produce two — which Node refuses
  // to parse. Only add one when the source lacks it.
  const source = await readFile(entryPoint, "utf8");
  const needsBanner = !source.startsWith(SHEBANG);

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: OPTIONAL_EXTERNALS,
    ...(needsBanner ? { banner: { js: SHEBANG } } : {}),
    sourcemap: false,
    logLevel: "info",
  });

  await chmod(outfile, 0o755).catch(() => {});
  console.log(`✓ hades CLI → ${path.relative(repoRoot, outfile)}`);
  return { skipped: false, outfile };
}

const invokedDirectly = process.argv[1] === __filename;
if (invokedDirectly) {
  buildHades().catch((err) => {
    console.error("[build-hades] build failed:", err);
    process.exitCode = 1;
  });
}
