#!/usr/bin/env node
// In-process Work/Orca acceptance: injected models/transports, no listeners or providers.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
await import("node:sqlite");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) throw new Error("Repository dependencies are required; this gate never installs them.");
const suites = [
  "durable-work", "durable-work-review", "work-goals", "work-orca", "work-orca-review",
  "workbench-work-orca", "workbench-durable-work-offline", "helm-orca-service",
  "helm-orca-ownership", "helm-orca-runtime", "helm-orca-tools", "helm-orca-transport",
  "helm-orca-workbench-tools", "helm-orca-review", "helm-orca-ui", "helm-orca-readiness",
].map(name => `src/desktop/__tests__/${name}.test.ts`);
const result = spawnSync(process.execPath, [vitest, "run", ...suites, "--maxWorkers=2"], {
  cwd: root, stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
