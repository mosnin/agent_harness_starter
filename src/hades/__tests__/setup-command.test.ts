import { describe, it, expect } from "vitest";
import {
  runSetupCommand,
  runDoctorCommand,
  runUpdateCommand,
  runChecks,
  detectProviderKeys,
  isNewer,
  buildConfigFile,
  MIN_NODE_MAJOR,
  type SetupDeps,
  type SetupFs,
} from "../cli/setup-command";
import { renderBanner, shouldShowBanner, shouldUseColor, BANNER_MIN_WIDTH } from "../cli/banner";
import type { HadesConfig } from "../config/config";

/** In-memory filesystem: records every write so tests can assert on them. */
function fakeFs(seed: Record<string, string> = {}, writable = true) {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  const writes: string[] = [];
  const fs: SetupFs = {
    exists: (p) => files.has(p) || dirs.has(p),
    isWritable: () => writable,
    mkdirp: (p) => {
      dirs.add(p);
      writes.push(`mkdir:${p}`);
    },
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => {
      files.set(p, c);
      writes.push(`write:${p}`);
    },
  };
  return { fs, files, dirs, writes };
}

const CONFIG: HadesConfig = { locale: "en", dataDir: "/tmp/hades-data", gateway: {}, plugins: [] };

function deps(over: Partial<SetupDeps> = {}): SetupDeps {
  const { fs } = fakeFs();
  return {
    config: CONFIG,
    env: {},
    fs,
    version: "1.2.3",
    configPath: "/tmp/hades-data/config.json",
    nodeVersion: "20.11.0",
    platform: "linux",
    ...over,
  };
}

describe("provider key detection", () => {
  it("reports key NAMES only, never values", () => {
    const env = { ANTHROPIC_API_KEY: "sk-super-secret-value" };
    const names = detectProviderKeys(env);
    expect(names).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain("sk-super-secret");
  });

  it("treats blank and whitespace-only keys as absent", () => {
    expect(detectProviderKeys({ OPENAI_API_KEY: "" })).toEqual([]);
    expect(detectProviderKeys({ OPENAI_API_KEY: "   " })).toEqual([]);
  });

  it("never leaks a secret into rendered doctor output", () => {
    const d = deps({ env: { OPENAI_API_KEY: "sk-leak-me-please" } });
    const out = runDoctorCommand([], d).lines.join("\n");
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).not.toContain("sk-leak-me-please");
  });
});

describe("runChecks", () => {
  it("fails the node check below the required major", () => {
    const c = runChecks(deps({ nodeVersion: "18.0.0" })).find((x) => x.name === "node")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(String(MIN_NODE_MAJOR));
    expect(c.fix).toBeTruthy();
  });

  it("passes the node check at and above the required major", () => {
    expect(runChecks(deps({ nodeVersion: "20.0.0" })).find((x) => x.name === "node")!.ok).toBe(true);
    expect(runChecks(deps({ nodeVersion: "22.4.1" })).find((x) => x.name === "node")!.ok).toBe(true);
  });

  it("distinguishes a missing data dir from an unwritable one", () => {
    const missing = runChecks(deps()).find((x) => x.name === "data-dir")!;
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("does not exist");

    const { fs } = fakeFs({}, false);
    fs.mkdirp(CONFIG.dataDir);
    const unwritable = runChecks(deps({ fs })).find((x) => x.name === "data-dir")!;
    expect(unwritable.ok).toBe(false);
    expect(unwritable.detail).toContain("not writable");
  });

  it("flags absent provider keys as mock-only rather than as an error", () => {
    const c = runChecks(deps()).find((x) => x.name === "provider-keys")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("[mock]");
  });
});

describe("hades setup", () => {
  it("writes NOTHING without --write and says so", () => {
    const { fs, writes } = fakeFs();
    const res = runSetupCommand([], deps({ fs }));
    expect(res.code).toBe(0);
    expect(writes).toEqual([]);
    const out = res.lines.join("\n");
    expect(out).toContain("nothing written");
    expect(out).toContain("Would do:");
    expect(out).toContain("--write");
  });

  it("creates the data dir and config only with --write", () => {
    const { fs, writes, files } = fakeFs();
    const res = runSetupCommand(["--write"], deps({ fs }));
    expect(res.code).toBe(0);
    expect(writes).toContain(`mkdir:${CONFIG.dataDir}`);
    expect(writes).toContain("write:/tmp/hades-data/config.json");
    expect(JSON.parse(files.get("/tmp/hades-data/config.json")!)).toMatchObject({
      dataDir: CONFIG.dataDir,
      locale: "en",
    });
  });

  it("never clobbers an existing config", () => {
    const original = '{"dataDir":"/custom","locale":"fr"}';
    const { fs, files, writes } = fakeFs({ "/tmp/hades-data/config.json": original });
    runSetupCommand(["--write"], deps({ fs }));
    expect(files.get("/tmp/hades-data/config.json")).toBe(original);
    expect(writes.some((w) => w.startsWith("write:"))).toBe(false);
  });

  it("reports nothing to do when already set up", () => {
    const { fs } = fakeFs({ "/tmp/hades-data/config.json": "{}" });
    fs.mkdirp(CONFIG.dataDir);
    expect(runSetupCommand([], deps({ fs })).lines.join("\n")).toContain("already set up");
  });

  it("--json emits parseable output carrying the real checks", () => {
    const parsed = JSON.parse(runSetupCommand(["--json"], deps()).lines.join("\n"));
    expect(parsed.mode).toBe("preview");
    expect(parsed.appliedActions).toEqual([]);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.version).toBe("1.2.3");
  });

  it("buildConfigFile omits an unset model rather than writing a null", () => {
    expect(buildConfigFile(deps())).not.toHaveProperty("model");
    expect(
      buildConfigFile(deps({ config: { ...CONFIG, model: "claude-x" } }))
    ).toMatchObject({ model: "claude-x" });
  });
});

describe("hades doctor", () => {
  it("exits non-zero when any check fails, so it gates CI", () => {
    expect(runDoctorCommand([], deps()).code).toBe(1);
  });

  it("exits zero when everything passes", () => {
    const { fs } = fakeFs({ "/tmp/hades-data/config.json": "{}" });
    fs.mkdirp(CONFIG.dataDir);
    const res = runDoctorCommand([], deps({ fs, env: { ANTHROPIC_API_KEY: "k" } }));
    expect(res.code).toBe(0);
    expect(res.lines.join("\n")).toContain("All checks passed");
  });

  it("writes nothing at all", () => {
    const { fs, writes } = fakeFs();
    runDoctorCommand([], deps({ fs }));
    expect(writes).toEqual([]);
  });

  it("--json carries the ok flag matching the exit code", () => {
    const res = runDoctorCommand(["--json"], deps());
    expect(JSON.parse(res.lines.join("\n")).ok).toBe(false);
    expect(res.code).toBe(1);
  });
});

describe("hades update", () => {
  it("never claims currency when the lookup is unavailable", async () => {
    const out = (await runUpdateCommand([], deps())).lines.join("\n");
    expect(out).toContain("not checked");
    expect(out).not.toContain("newest published version");
  });

  it("says so honestly when the lookup throws", async () => {
    const d = deps({
      latestVersion: () => {
        throw new Error("offline");
      },
    });
    expect((await runUpdateCommand([], d)).lines.join("\n")).toContain("could not be determined");
  });

  it("reports an available update and prints the command, without applying it", async () => {
    const d = deps({ version: "1.0.0", latestVersion: () => "2.0.0" });
    const out = (await runUpdateCommand([], d)).lines.join("\n");
    expect(out).toContain("An update is available");
    expect(out).toContain("npm install -g");
    expect(out).toContain("never rewrites its own install");
  });

  it("confirms currency only when actually current", async () => {
    const d = deps({ version: "2.0.0", latestVersion: () => "2.0.0" });
    expect((await runUpdateCommand([], d)).lines.join("\n")).toContain("newest published version");
  });

  it("compares versions numerically, not lexically", () => {
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
    expect(isNewer("1.9.0", "1.10.0")).toBe(false);
    expect(isNewer("2.0.0", "2.0.0")).toBe(false);
    expect(isNewer("v1.2.4", "1.2.3")).toBe(true);
  });
});

describe("banner", () => {
  it("renders the block wordmark at full width and a compact mark below it", () => {
    expect(renderBanner({ width: BANNER_MIN_WIDTH }).split("\n").length).toBe(3);
    expect(renderBanner({ width: 20 })).toContain("hades");
    expect(renderBanner({ width: 20 }).split("\n").length).toBe(1);
  });

  it("emits no ANSI escapes unless colour is requested", () => {
    expect(renderBanner({ color: false })).not.toContain("[");
    expect(renderBanner({ color: true })).toContain("[");
  });

  it("appends a tagline only when non-blank", () => {
    expect(renderBanner({ tagline: "  " }).split("\n").length).toBe(3);
    expect(renderBanner({ tagline: "prove it" })).toContain("prove it");
  });

  it("suppresses itself off-TTY, in CI, and when opted out", () => {
    expect(shouldShowBanner({}, false)).toBe(false);
    expect(shouldShowBanner({ CI: "1" }, true)).toBe(false);
    expect(shouldShowBanner({ HADES_NO_BANNER: "1" }, true)).toBe(false);
    expect(shouldShowBanner({}, true)).toBe(true);
  });

  it("honours NO_COLOR and dumb terminals", () => {
    expect(shouldUseColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldUseColor({ TERM: "dumb" }, true)).toBe(false);
    expect(shouldUseColor({}, false)).toBe(false);
    expect(shouldUseColor({}, true)).toBe(true);
  });
});
