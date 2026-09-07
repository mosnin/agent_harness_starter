import { copyFile, mkdir, cp, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const destination = resolve(process.argv[2]);
const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
const pkg = `node_modules/@openai/codex-darwin-${process.arch}`;
const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
if (!manifest.version.startsWith("0.145.0")) throw new Error("Codex runtime must match the tested 0.145.0 protocol.");
await mkdir(destination, { recursive: true });
await copyFile(join(pkg, "vendor", target, "bin", "codex"), join(destination, "codex"));
await mkdir(join(destination, "licenses"), { recursive: true });
await cp("third_party", join(destination, "licenses"), { recursive: true });
const licensePackages = ["codemirror", "playwright-core", ...(await readdir("node_modules/@codemirror")).map(name => "@codemirror/" + name), ...(await readdir("node_modules/@lezer")).map(name => "@lezer/" + name)];
for (const name of licensePackages) {
  for (const file of await readdir(join("node_modules", name))) if (/^(LICENSE|NOTICE)(\.|$)/i.test(file)) {
    await copyFile(join("node_modules", name, file), join(destination, "licenses", name.replaceAll("/", "-") + "-" + file));
  }
}
await cp("node_modules/playwright-core", join(destination, "node_modules/playwright-core"), { recursive: true });
await writeFile(join(destination, "codex-runtime.json"), JSON.stringify({ package: "@openai/codex", version: "0.145.0", platform: process.platform, arch: process.arch }, null, 2));
console.log("Bundled Codex 0.145.0 and browser runtime.");
