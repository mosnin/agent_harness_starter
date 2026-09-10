/**
 * Bundles the swarm worker entrypoint and the hermes-swarm CLI to plain,
 * dependency-free Node JS under dist-swarm/. Workers spawned by the process and
 * docker providers run these compiled files with `node` — fast startup, no
 * per-worker `npx`/transpile cost.
 */
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: { "worker/entrypoint": "src/swarm-runtime/worker/entrypoint.ts" },
  outdir: "dist-swarm",
});

await build({
  ...common,
  entryPoints: { "cli": "src/swarm-runtime/cli.ts" },
  outdir: "dist-swarm",
  banner: { js: "#!/usr/bin/env node" },
});

await chmod("dist-swarm/cli.js", 0o755).catch(() => {});
console.log("✓ swarm bundle → dist-swarm/{worker/entrypoint.js, cli.js}");
