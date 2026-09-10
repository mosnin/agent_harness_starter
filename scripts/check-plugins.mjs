#!/usr/bin/env node
// In-process acceptance only: no app launch, listener, account, install or deployment.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  await import("node:sqlite");
} catch {
  throw new Error("The desktop Plugins gate needs Node with node:sqlite enabled. Verified with Node 22.22.2; it performs no runtime installation.");
}
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) throw new Error("Install the repository dependencies before running the Plugins gate.");
const suites = [
  "ecosystem-service", "ecosystem-events", "ecosystem-recovery",
  "ecosystem-catalog", "ecosystem-tools", "ecosystem-plugins-ui",
  "ecosystem-detail-ui", "ecosystem-scopes-review", "workbench-ecosystem-ui",
  "ecosystem-read-review", "ecosystem-scalar-review", "ecosystem-write-ack-review",
  "ecosystem-stream-fallback", "ecosystem-stream-fallback-review",
  "workbench-ecosystem", "company-os", "company-os-resilience",
  "company-os-resources",
  "workbench-shutdown", "desktop-request-routing", "workbench-experience",
].map((name) => `src/desktop/__tests__/${name}.test.ts`);
const result = spawnSync(process.execPath, [vitest, "run", ...suites, "--maxWorkers=2"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
