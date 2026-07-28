/**
 * Real-machine wiring for `hades setup` / `doctor` / `update`.
 *
 * Kept out of `setup-command.ts` so that module stays pure and testable: this
 * is the only place that touches `node:fs`, `process.versions` or the network.
 * Built lazily by the CLI router, so `hades help` never pays for it.
 */

import { existsSync, accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { HadesConfig } from "../config/config";
import type { SetupDeps, SetupFs, LatestVersionLookup } from "./setup-command";

/** Real filesystem. `isWritable` probes the nearest existing ancestor. */
export function nodeSetupFs(): SetupFs {
  return {
    exists: (p) => existsSync(p),
    isWritable(p) {
      let probe = p;
      // A path that does not exist yet is writable iff its nearest existing
      // ancestor is — otherwise `setup --write` would claim it can create a
      // directory it will actually be denied.
      while (probe && !existsSync(probe)) {
        const parent = dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
      try {
        accessSync(probe, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    mkdirp: (p) => {
      mkdirSync(p, { recursive: true });
    },
    readFile(p) {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(p, contents) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, contents, "utf8");
    },
  };
}

/**
 * Read the running install's version from its own package.json. Falls back to
 * "0.0.0-unknown" rather than inventing a number — a wrong version claim is
 * worse than an obviously-absent one.
 */
export function readInstalledVersion(repoRoot: string, fs: SetupFs = nodeSetupFs()): string {
  const raw = fs.readFile(join(repoRoot, "package.json"));
  if (!raw) return "0.0.0-unknown";
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

/**
 * Registry lookup for the newest published version.
 *
 * Returns null on ANY failure — offline, 404, bad JSON, timeout. `update`
 * renders null as "could not be determined", never as "you are current",
 * because silently implying currency is the one lie this command must not
 * tell. Requires an injected `fetch`; without one there is no lookup at all.
 */
export function registryLatestVersion(
  pkg: string,
  fetchImpl?: typeof fetch,
  timeoutMs = 3000
): LatestVersionLookup {
  return async () => {
    const f = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await f(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface BuildSetupDepsOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  /** Enables the network version lookup. Off by default — `update` stays offline unless asked. */
  fetchImpl?: typeof fetch;
}

/** Compose the real {@link SetupDeps} for this machine. */
export function defaultSetupDeps(config: HadesConfig, opts: BuildSetupDepsOptions = {}): SetupDeps {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? env.HADES_REPO_ROOT ?? process.cwd();
  const fs = nodeSetupFs();
  return {
    config,
    env,
    fs,
    version: readInstalledVersion(repoRoot, fs),
    configPath: join(config.dataDir, "config.json"),
    nodeVersion: process.versions.node,
    platform: process.platform,
    latestVersion: opts.fetchImpl ? registryLatestVersion("hades-agent", opts.fetchImpl) : undefined,
  };
}
