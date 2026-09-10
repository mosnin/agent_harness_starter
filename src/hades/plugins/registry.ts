import type { HadesPlugin } from "./plugin";
import type { PluginManager } from "./manager";
import { AchievementsPlugin } from "./examples/achievements";
import { KanbanPlugin } from "./examples/kanban";
import { BrowserPlugin } from "./examples/browser";

export interface PluginEntry {
  name: string;
  description?: string;
  version?: string;
  /** Factory — a fresh plugin instance each load. */
  create: () => HadesPlugin;
}

export type PluginMetadata = Omit<PluginEntry, "create">;

/**
 * A local catalog of installable plugins (the offline analogue of a plugin
 * marketplace). Deployments seed it with the built-in examples plus any local
 * plugins; the CLI/REPL list it and `load` one into a live {@link PluginManager}.
 */
export class LocalPluginRegistry {
  private entries = new Map<string, PluginEntry>();

  add(entry: PluginEntry): this {
    this.entries.set(entry.name, entry);
    return this;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Catalog metadata (without the factory), for listing. */
  available(): PluginMetadata[] {
    return [...this.entries.values()].map(({ create, ...meta }) => {
      void create;
      return meta;
    });
  }

  create(name: string): HadesPlugin | undefined {
    return this.entries.get(name)?.create();
  }

  /** Instantiate and register a catalog plugin into a manager. */
  async load(name: string, manager: PluginManager): Promise<HadesPlugin> {
    const plugin = this.create(name);
    if (!plugin) throw new Error(`Unknown plugin: ${name}`);
    await manager.register(plugin);
    return plugin;
  }
}

/** The built-in example catalog (browser, kanban, achievements). */
export function defaultPluginRegistry(): LocalPluginRegistry {
  return new LocalPluginRegistry()
    .add({ name: "browser", description: "Web-browsing skill + fetch tracking", create: () => new BrowserPlugin() })
    .add({ name: "kanban", description: "Mirror goals onto a kanban board", create: () => new KanbanPlugin() })
    .add({ name: "achievements", description: "Unlock achievements as goals complete", create: () => new AchievementsPlugin() });
}
