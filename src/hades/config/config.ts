/** Resolved Hades configuration. */
export interface HadesConfig {
  /** Default model id (falls back to the model registry default when unset). */
  model?: string;
  /** UI locale for i18n. */
  locale: string;
  /** Root directory for durable state (memory, sessions, history…). */
  dataDir: string;
  /** Path to the memory store file (defaults under dataDir). */
  memoryPath?: string;
  gateway: {
    trigger?: string;
    allowedUsers?: string[];
  };
  /** Plugin names to auto-enable at startup. */
  plugins: string[];
}

export const DEFAULT_CONFIG: HadesConfig = {
  locale: "en",
  dataDir: ".hades",
  gateway: {},
  plugins: [],
};

export interface LoadConfigSources {
  /** Config parsed from a file (highest-priority static source). */
  file?: Partial<HadesConfig>;
  /** Environment variables (HADES_*). */
  env?: Record<string, string | undefined>;
  /** Programmatic overrides (highest priority). */
  overrides?: Partial<HadesConfig>;
}

/** Map HADES_* env vars onto a partial config. */
export function configFromEnv(env: Record<string, string | undefined>): Partial<HadesConfig> {
  const out: Partial<HadesConfig> = {};
  const gateway: HadesConfig["gateway"] = {};
  if (env.HADES_MODEL) out.model = env.HADES_MODEL;
  if (env.HADES_LOCALE) out.locale = env.HADES_LOCALE;
  if (env.HADES_DATA_DIR) out.dataDir = env.HADES_DATA_DIR;
  if (env.HADES_MEMORY_PATH) out.memoryPath = env.HADES_MEMORY_PATH;
  if (env.HADES_GATEWAY_TRIGGER) gateway.trigger = env.HADES_GATEWAY_TRIGGER;
  if (env.HADES_GATEWAY_ALLOWED_USERS) gateway.allowedUsers = splitList(env.HADES_GATEWAY_ALLOWED_USERS);
  if (Object.keys(gateway).length) out.gateway = gateway;
  if (env.HADES_PLUGINS) out.plugins = splitList(env.HADES_PLUGINS);
  return out;
}

function splitList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the effective config by layering sources with clear precedence:
 * built-in defaults < file < environment < programmatic overrides. Nested
 * objects (gateway) are shallow-merged so a partial source doesn't wipe sibling
 * keys. `memoryPath` defaults under `dataDir` when left unset.
 */
export function loadConfig(sources: LoadConfigSources = {}): HadesConfig {
  const env = sources.env ? configFromEnv(sources.env) : {};
  const layers: Array<Partial<HadesConfig>> = [DEFAULT_CONFIG, sources.file ?? {}, env, sources.overrides ?? {}];

  const merged: HadesConfig = { ...DEFAULT_CONFIG };
  for (const layer of layers) {
    if (layer.model !== undefined) merged.model = layer.model;
    if (layer.locale !== undefined) merged.locale = layer.locale;
    if (layer.dataDir !== undefined) merged.dataDir = layer.dataDir;
    if (layer.memoryPath !== undefined) merged.memoryPath = layer.memoryPath;
    if (layer.plugins !== undefined) merged.plugins = layer.plugins;
    if (layer.gateway) merged.gateway = { ...merged.gateway, ...layer.gateway };
  }
  if (!merged.memoryPath) merged.memoryPath = `${merged.dataDir}/memory.json`;
  return merged;
}
