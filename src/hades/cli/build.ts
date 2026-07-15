import { HadesCli } from "./cli";
import type { CliResult } from "./cli";
import type { HadesConfig } from "../config/config";
import { defaultModelRegistry } from "../models/defaults";
import { ModelCommand } from "../models/command";
import { InMemoryModelSelection, FileModelSelection } from "../models/selection";
import { defaultPluginRegistry } from "../plugins/registry";
import { builtinSkillPackCatalog } from "../skill-packs/builtin";
import { InMemoryMemoryStore, FileMemoryStore, type MemoryStore } from "../memory/store";
import { InMemoryTrajectoryStore } from "../research/recorder";

export const HADES_VERSION = "0.1.0";

export interface BuildCliOptions {
  /** Override the memory store (default: file-backed at config.memoryPath). */
  memory?: MemoryStore;
  /** Persist model selection + memory to disk (default true). Off for tests. */
  persist?: boolean;
  onChat?: (args: string[]) => Promise<CliResult> | CliResult;
  onGateway?: (args: string[]) => Promise<CliResult> | CliResult;
}

/**
 * Wire a fully-featured {@link HadesCli} from resolved config: the built-in model
 * catalog (with the config's default marked), the plugin + skill-pack catalogs,
 * a memory store (file-backed by default, in-memory when `persist` is false),
 * and a trajectory store. This is what the `hades` bin calls; tests call it with
 * `persist: false` to avoid touching disk.
 */
export function buildHadesCli(config: HadesConfig, opts: BuildCliOptions = {}): HadesCli {
  const persist = opts.persist ?? true;

  const registry = defaultModelRegistry(config.model);
  const selection = persist
    ? new FileModelSelection(`${config.dataDir}/model.json`)
    : new InMemoryModelSelection();
  const models = new ModelCommand(registry, selection);

  const memory =
    opts.memory ??
    (persist && config.memoryPath ? new FileMemoryStore(config.memoryPath) : new InMemoryMemoryStore());

  return new HadesCli({
    version: HADES_VERSION,
    models,
    plugins: defaultPluginRegistry(),
    skillPacks: builtinSkillPackCatalog(),
    memory,
    trajectories: new InMemoryTrajectoryStore(),
    onChat: opts.onChat,
    onGateway: opts.onGateway,
  });
}
