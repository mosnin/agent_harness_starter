import { readFileSync } from "node:fs";
import type { SwarmMode } from "../server/build-swarm";

/** Shape of a `swarm.config.json` file (all fields optional). */
export interface SwarmConfigFile {
  mode?: SwarmMode;
  capabilities?: string[];
  poolSize?: number;
  controlPort?: number;
  dashboardPort?: number;
  authToken?: string;
  workerImage?: string;
  dockerNetwork?: string;
  model?: string;
  autoscale?: { min: number; max: number };
  maxInFlight?: number;
}

/** Fully-resolved config with defaults applied. */
export interface ResolvedConfig {
  mode: SwarmMode;
  capabilities: string[];
  poolSize: number;
  controlPort: number;
  dashboardPort: number;
  authToken?: string;
  workerImage?: string;
  dockerNetwork?: string;
  model?: string;
  autoscale?: { min: number; max: number };
  maxInFlight?: number;
}

export function defaultConfig(): ResolvedConfig {
  return {
    mode: "inline",
    capabilities: ["research", "code", "analysis"],
    poolSize: 3,
    controlPort: 8787,
    dashboardPort: 8080,
  };
}

/** Extract config overrides from environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<SwarmConfigFile> {
  const out: Partial<SwarmConfigFile> = {};
  if (env.SWARM_MODE) out.mode = env.SWARM_MODE as SwarmMode;
  if (env.SWARM_CAPABILITIES) out.capabilities = env.SWARM_CAPABILITIES.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.SWARM_POOL_SIZE) out.poolSize = Number(env.SWARM_POOL_SIZE);
  if (env.SWARM_CONTROL_PORT) out.controlPort = Number(env.SWARM_CONTROL_PORT);
  if (env.SWARM_DASHBOARD_PORT) out.dashboardPort = Number(env.SWARM_DASHBOARD_PORT);
  if (env.SWARM_AUTH_TOKEN) out.authToken = env.SWARM_AUTH_TOKEN;
  if (env.SWARM_WORKER_IMAGE) out.workerImage = env.SWARM_WORKER_IMAGE;
  if (env.SWARM_DOCKER_NETWORK) out.dockerNetwork = env.SWARM_DOCKER_NETWORK;
  if (env.SWARM_MODEL) out.model = env.SWARM_MODEL;
  if (env.SWARM_MAX_IN_FLIGHT) out.maxInFlight = Number(env.SWARM_MAX_IN_FLIGHT);
  return out;
}

/**
 * Merge config layers with well-defined precedence: **defaults < file < env**.
 * Pure and side-effect-free so precedence is unit-testable; only defined values
 * override, so a partial file/env never clobbers a lower layer with undefined.
 */
export function resolveConfig(
  file: Partial<SwarmConfigFile> | null,
  env: Partial<SwarmConfigFile>,
  base: ResolvedConfig = defaultConfig()
): ResolvedConfig {
  return { ...base, ...clean(file), ...clean(env) };
}

/** Read a JSON config file if present; returns null if missing/unreadable. */
export function loadConfigFile(path: string): SwarmConfigFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SwarmConfigFile;
  } catch {
    return null;
  }
}

/** Convenience: load `swarm.config.json` (or a given path) and apply env overrides. */
export function loadSwarmConfig(opts: { file?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedConfig {
  const file = loadConfigFile(opts.file ?? "swarm.config.json");
  return resolveConfig(file, configFromEnv(opts.env));
}

function clean<T extends object>(o: T | null | undefined): Partial<T> {
  if (!o) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
