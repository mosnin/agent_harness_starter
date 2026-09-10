#!/usr/bin/env node
// Build and package the actual OpenCode fork. Dependencies must already be installed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceState, uiFiles } from "./helm-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const sourceArg = argv.indexOf("--source");
if (sourceArg >= 0 && (!argv[sourceArg + 1]?.trim() || argv[sourceArg + 1].startsWith("-"))) throw new Error("--source requires a path to the Helm integration fork. See docs/HELM.md.");
const source = resolve(sourceArg >= 0 ? argv[sourceArg + 1] : process.env.HADES_HELM_OPENCODE_SOURCE ?? join(root, "vendor/opencode"));
const bun = process.env.HADES_BUN ?? "bun";
const env = { ...process.env, OPENCODE_VERSION: "1.18.21", OPENCODE_CHANNEL: "prod", HELM_BUILD: "1" };
for (const key of Object.keys(env)) if (key.startsWith("SENTRY_") || key.startsWith("VITE_SENTRY_")) delete env[key];
delete env.OPENCODE_RELEASE;
delete env.OPENCODE_BUMP;
if (bun.includes("/")) env.PATH = dirname(bun) + ":" + (env.PATH ?? "");
function run(command, args, cwd = source, capture = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell: false });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}
if (!existsSync(join(source, "packages/app/src/helm-host.ts"))) throw new Error("Choose the Helm integration fork with --source. See docs/HELM.md; this command does not download or install software.");
const guardSource = join(source, "packages/opencode/src/server/shared/ui.ts");
if (!existsSync(guardSource) || !readFileSync(guardSource, "utf8").includes("OPENCODE_HELM_LOCAL_UI")) throw new Error("This fork is missing the managed local UI guard (OPENCODE_HELM_LOCAL_UI). Update the Helm integration fork selected by --source before packaging; see docs/HELM.md.");
const version = JSON.parse(readFileSync(join(source, "packages/opencode/package.json"), "utf8")).version;
if (version !== "1.18.21") throw new Error("This Hades integration requires the pinned OpenCode 1.18.21 fork.");
const revision = run("git", ["rev-parse", "HEAD"], source, true);
const dirty = !!run("git", ["status", "--porcelain"], source, true);
const before = sourceState(source);
const bunVersion = run(bun, ["--version"], source, true);
if(bunVersion !== "1.3.14") throw new Error("Helm fork requires Bun 1.3.14; no rebuild attempted.");
let releasePin;
if (process.env.HADES_HELM_REQUIRE_PIN === "1") {
  const pin = JSON.parse(readFileSync(join(root, "third_party/helm-opencode.json"), "utf8"));
  if (dirty || revision !== pin.revision || version !== pin.version) throw new Error("Release build requires the clean OpenCode revision pinned in third_party/helm-opencode.json.");
  if(run(bun,["--version"],source,true)!==pin.bun) throw new Error("Release build requires the Bun version pinned in third_party/helm-opencode.json.");
  releasePin=pin;
}
run(bun, ["run", "build"], join(source, "packages/app"));
// The gateway serves the fork UI separately. Do not embed a duplicate in the runtime.
run(bun, ["run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"], join(source, "packages/opencode"));
if(releasePin && (run("git",["rev-parse","HEAD"],source,true)!==releasePin.revision || run("git",["status","--porcelain"],source,true))) throw new Error("OpenCode source changed during release build; packaging refused.");

if(JSON.stringify(sourceState(source))!==JSON.stringify(before)) throw new Error("OpenCode source changed during build; assets were not packaged. Rebuild from stable source.");
const assets = join(root, "dist/helm-ui");
const runtime = join(root, "dist/runtime/helm-opencode");
mkdirSync(dirname(runtime), { recursive: true });
rmSync(assets, { recursive: true, force: true });
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const item of readdirSync(from, { withFileTypes: true })) {
    if (item.name.endsWith(".map")) continue;
    if (item.isDirectory()) copyTree(join(from, item.name), join(to, item.name));
    else if (item.isFile()) copyFileSync(join(from, item.name), join(to, item.name));
  }
}
copyTree(join(source, "packages/app/dist"), assets);
copyFileSync(join(source, "LICENSE"), join(assets, "OPENCODE-LICENSE.txt"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const binary = join(source, "packages/opencode/dist", `opencode-${platform}-${process.arch}`, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
// APFS cloning keeps native builds from duplicating large local binaries.
if (process.platform === "darwin") run("/bin/cp", ["-c", binary, runtime], root);
else copyFileSync(binary, runtime);
if(JSON.stringify(sourceState(source))!==JSON.stringify(before)) throw new Error("OpenCode source changed during asset staging; no valid provenance emitted.");
writeFileSync(join(assets, "helm-provenance.json"), JSON.stringify({ schema: 2, sourceSha256: before.sourceSha256, bun: bunVersion, uiFiles: uiFiles(assets), fork: "https://github.com/mosnin/opencode", upstream: "https://github.com/anomalyco/opencode", upstreamRevision: "826d9ad46a22bef0294998e08daa3c4904fea28f", revision, version, dirty, runtimeSha256: createHash("sha256").update(readFileSync(runtime)).digest("hex"), builtAt: new Date().toISOString(), source: "Actual fork packages/app and packages/opencode; no remote UI fallback" }, null, 2) + "\n");
console.log(`Helm fork ${revision}${dirty ? " (uncommitted changes)" : ""} packaged at ${assets}`);
