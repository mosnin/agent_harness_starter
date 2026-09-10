import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { harnessCatalog, parseHarnessArgs, shellQuote } from "../core/harness-catalog";
describe("desktop harness capability access", () => {
  it("covers every canonical command in the actual CLI dispatcher", () => {
    const source = readFileSync("src/hades/cli/cli.ts", "utf8");
    const run = source.slice(source.indexOf("switch (sub)"), source.indexOf("private help()"));
    const commands = [...run.matchAll(/case "([^"]+)":/g)].map(m => m[1]).filter(s => !s.startsWith("-") && s !== "upgrade");
    expect(commands.length).toBeGreaterThan(25);
    expect(harnessCatalog.map(x => x.command).sort()).toEqual([...new Set(commands)].sort());
  });
  it("quotes argv literally through the actual shell without command expansion", () => {
    const malicious = ["$(exit 9)", "`exit 8`", "a'b", "with spaces", "; exit 7", "$HOME", "*.md"];
    const command = [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...malicious].map(shellQuote).join(" ");
    expect(JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }))).toEqual(malicious);
    expect(parseHarnessArgs("doctor", "[]")).toEqual(["doctor"]);
    expect(() => parseHarnessArgs("unknown", "[]")).toThrow();
    expect(() => parseHarnessArgs("chat", '["bad\\nline"]')).toThrow();
  });
});
