#!/usr/bin/env node
// Bundle an already staged, signed native Maus app; never download or rebrand a
// different executable and never silently replace a running standalone install.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
// Debug Swift implementations live in the debug dylib and package frameworks;
// binding just the launcher would not identify the code actually being shipped.
function bundleDigest(root) {
  const digest = createHash("sha256");
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        stat = lstatSync(path),
        entry = relative(root, path);
      if (stat.isSymbolicLink())
        digest.update(
          JSON.stringify([entry, "link", readlinkSync(path)]) + "\n",
        );
      else if (stat.isDirectory()) visit(path);
      else if (stat.isFile())
        digest.update(
          JSON.stringify([
            entry,
            "file",
            createHash("sha256").update(readFileSync(path)).digest("hex"),
          ]) + "\n",
        );
      else throw new Error("Unexpected file type inside Maus bundle");
    }
  }
  visit(root);
  return digest.digest("hex");
}
export function bundleMaus(source, resources) {
  if (process.platform !== "darwin") throw new Error("Maus requires macOS");
  source = realpathSync(source);
  resources = resolve(resources);
  mkdirSync(resources, { recursive: true });
  resources = realpathSync(resources);
  const rel = relative(source, resources);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new Error("Output must be outside the source app");
  const executable = join(source, "Contents/MacOS/HadesMaus"),
    bridge = join(source, "Contents/MacOS/hadesmaus-mcp-bridge");
  for (const path of [executable, bridge])
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error("Expected regular Maus executables");
  const identifier = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(source, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  if (identifier !== "com.hadesmaus.app")
    throw new Error("Unexpected Maus bundle identity");
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", source],
    { stdio: "pipe" },
  );
  const target = join(resources, "HadesMaus.app"),
    staged = target + ".stage-" + randomUUID();
  const backup = target + ".previous-" + randomUUID();
  try {
    execFileSync("/bin/cp", ["-cR", source, staged]);
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", staged],
      { stdio: "pipe" },
    );
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(staged, target);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    }
    const receipt = {
      bundleId: identifier,
      bundleSha256: bundleDigest(target),
      executableSha256: createHash("sha256")
        .update(readFileSync(executable))
        .digest("hex"),
      bridgeSha256: createHash("sha256")
        .update(readFileSync(bridge))
        .digest("hex"),
    };
    writeFileSync(
      join(resources, "maus-build.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    // Only an earlier bundle copy made by this staging operation is removed.
    if (existsSync(backup)) rmSync(backup, { recursive: true });
    return receipt;
  } finally {
    if (existsSync(staged)) rmSync(staged, { recursive: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , source, resources] = process.argv;
  if (!source || !resources)
    throw new Error(
      "Usage: node scripts/bundle-maus.mjs /path/to/staged/HadesMaus.app /path/to/Hades.app/Contents/Resources",
    );
  console.log(JSON.stringify(bundleMaus(source, resources)));
}
