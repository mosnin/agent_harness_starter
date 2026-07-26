import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { defaultConfig, configFromEnv, resolveConfig, loadConfigFile, loadSwarmConfig } from "../config/config";

describe("resolveConfig precedence (defaults < file < env)", () => {
  it("applies defaults when nothing is set", () => {
    const c = resolveConfig(null, {});
    expect(c.mode).toBe("inline");
    expect(c.poolSize).toBe(3);
    expect(c.dashboardPort).toBe(8080);
  });

  it("lets the file override defaults", () => {
    const c = resolveConfig({ mode: "docker", poolSize: 8 }, {});
    expect(c.mode).toBe("docker");
    expect(c.poolSize).toBe(8);
    expect(c.dashboardPort).toBe(8080); // untouched default
  });

  it("lets env override the file", () => {
    const c = resolveConfig({ mode: "docker", poolSize: 8 }, { poolSize: 12 });
    expect(c.mode).toBe("docker"); // from file
    expect(c.poolSize).toBe(12); // env wins
  });

  it("ignores undefined values so partial layers don't clobber", () => {
    const c = resolveConfig({ mode: undefined, poolSize: 5 }, {});
    expect(c.mode).toBe("inline"); // default preserved
    expect(c.poolSize).toBe(5);
  });
});

describe("configFromEnv", () => {
  it("parses SWARM_* variables", () => {
    const env = { SWARM_MODE: "process", SWARM_CAPABILITIES: "a, b ,c", SWARM_POOL_SIZE: "4", SWARM_AUTH_TOKEN: "t" };
    const c = configFromEnv(env as unknown as NodeJS.ProcessEnv);
    expect(c.mode).toBe("process");
    expect(c.capabilities).toEqual(["a", "b", "c"]);
    expect(c.poolSize).toBe(4);
    expect(c.authToken).toBe("t");
  });
});

describe("file loading", () => {
  it("loads a JSON config file and applies env overrides via loadSwarmConfig", () => {
    const path = join(tmpdir(), `swarm-config-${process.pid}-${Math.floor(performance.now())}.json`);
    writeFileSync(path, JSON.stringify({ mode: "docker", poolSize: 6, workerImage: "img:1" }));
    try {
      expect(loadConfigFile(path)?.mode).toBe("docker");
      const resolved = loadSwarmConfig({ file: path, env: { SWARM_POOL_SIZE: "9" } as unknown as NodeJS.ProcessEnv });
      expect(resolved.mode).toBe("docker"); // file
      expect(resolved.workerImage).toBe("img:1"); // file
      expect(resolved.poolSize).toBe(9); // env override
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("returns null for a missing file and falls back to defaults", () => {
    expect(loadConfigFile("/nope/swarm.config.json")).toBeNull();
    expect(loadSwarmConfig({ file: "/nope/swarm.config.json", env: {} as NodeJS.ProcessEnv })).toEqual(defaultConfig());
  });
});
