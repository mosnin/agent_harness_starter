import type {
  HadesPlugin,
  HookListener,
  HookName,
  PluginContext,
  PluginHookMap,
  PluginServices,
} from "./plugin";

interface Registered {
  plugin: HadesPlugin;
  enabled: boolean;
  listeners: Array<{ hook: HookName; listener: HookListener<HookName> }>;
}

export interface PluginManagerOptions {
  services?: PluginServices;
  /** Per-plugin config, keyed by plugin name. */
  config?: Record<string, Record<string, unknown>>;
  logger?: (line: string) => void;
}

/**
 * Loads plugins, runs their lifecycle, and dispatches runtime hooks. Registering
 * a plugin runs its `register(ctx)` once (wiring hooks + services) and enables
 * it; `disable`/`enable` toggle whether its hook listeners fire without
 * re-registering. `emit` fans a hook out to every enabled plugin — a listener
 * that throws is caught and logged, so one bad plugin can't break a goal.
 * Dependencies are enforced at registration time.
 */
export class PluginManager {
  private plugins = new Map<string, Registered>();
  private readonly services: PluginServices;
  private readonly config: Record<string, Record<string, unknown>>;
  private readonly logger: (line: string) => void;

  constructor(opts: PluginManagerOptions = {}) {
    this.services = opts.services ?? {};
    this.config = opts.config ?? {};
    this.logger = opts.logger ?? (() => {});
  }

  list(): Array<{ name: string; version?: string; enabled: boolean; description?: string }> {
    return [...this.plugins.values()].map((r) => ({
      name: r.plugin.name,
      version: r.plugin.version,
      enabled: r.enabled,
      description: r.plugin.description,
    }));
  }
  get(name: string): HadesPlugin | undefined {
    return this.plugins.get(name)?.plugin;
  }
  isEnabled(name: string): boolean {
    return this.plugins.get(name)?.enabled ?? false;
  }

  /** Register a plugin: validate, run `register(ctx)`, enable it. */
  async register(plugin: HadesPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) throw new Error(`Plugin already registered: ${plugin.name}`);
    for (const dep of plugin.dependencies ?? []) {
      if (!this.plugins.has(dep)) throw new Error(`Plugin ${plugin.name} requires missing dependency: ${dep}`);
    }
    const entry: Registered = { plugin, enabled: true, listeners: [] };
    const ctx: PluginContext = {
      on: <K extends HookName>(hook: K, listener: HookListener<K>) => {
        entry.listeners.push({ hook, listener: listener as HookListener<HookName> });
      },
      addSkill: (skill) => {
        if (!this.services.skills) return false;
        this.services.skills.register(skill);
        return true;
      },
      addConnector: (connector) => {
        if (!this.services.connectors) return false;
        this.services.connectors.register(connector);
        return true;
      },
      addModel: (model) => {
        if (!this.services.models) return false;
        this.services.models.register(model);
        return true;
      },
      config: this.config[plugin.name] ?? {},
      log: (message: string) => this.logger(`[${plugin.name}] ${message}`),
      services: this.services,
    };
    await plugin.register(ctx);
    this.plugins.set(plugin.name, entry);
    await plugin.onEnable?.();
  }

  async disable(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry || !entry.enabled) return;
    entry.enabled = false;
    await entry.plugin.onDisable?.();
  }

  async enable(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry || entry.enabled) return;
    entry.enabled = true;
    await entry.plugin.onEnable?.();
  }

  /** Dispatch a hook to every enabled plugin subscribed to it. */
  async emit<K extends HookName>(hook: K, payload: PluginHookMap[K]): Promise<void> {
    for (const entry of this.plugins.values()) {
      if (!entry.enabled) continue;
      for (const l of entry.listeners) {
        if (l.hook !== hook) continue;
        try {
          await l.listener(payload);
        } catch (err) {
          this.logger(`[${entry.plugin.name}] hook ${hook} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
