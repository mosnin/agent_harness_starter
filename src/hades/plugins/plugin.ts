import type { SkillRegistry, SwarmSkill } from "../../swarm-runtime/skills/skill";
import type { ModelRegistry } from "../models/registry";
import type { ConnectorHub, PlatformConnector } from "../gateway/connector";

/**
 * Runtime hooks a plugin can subscribe to. Payloads are read-mostly snapshots;
 * plugins observe and react (log an achievement, mirror to a board, tweak a
 * counter) rather than mutating core control flow — keeping the swarm's
 * guarantees intact no matter what's installed.
 */
export interface PluginHookMap {
  "goal:start": { objective: string; goalId?: string };
  "goal:complete": { objective: string; goalId?: string; status: string; summary?: string };
  "message:inbound": { platform: string; user: string; text: string };
  "message:outbound": { platform: string; user: string; text: string };
  "tool:before": { tool: string; input: unknown };
  "tool:after": { tool: string; output: unknown; ok: boolean };
}

export type HookName = keyof PluginHookMap;
export type HookListener<K extends HookName> = (payload: PluginHookMap[K]) => void | Promise<void>;

/** Host services a plugin may extend. All optional — a plugin uses what it needs. */
export interface PluginServices {
  skills?: SkillRegistry;
  models?: ModelRegistry;
  connectors?: ConnectorHub;
}

/** What a plugin receives at registration time. */
export interface PluginContext {
  /** Subscribe to a runtime hook. Auto-removed when the plugin is disabled. */
  on<K extends HookName>(hook: K, listener: HookListener<K>): void;
  /** Register a skill (if the host wired a SkillRegistry). Returns false if not. */
  addSkill(skill: SwarmSkill): boolean;
  /** Register a messaging connector (if the host wired a ConnectorHub). */
  addConnector(connector: PlatformConnector): boolean;
  /** Register a model (if the host wired a ModelRegistry). */
  addModel(model: Parameters<ModelRegistry["register"]>[0]): boolean;
  /** Plugin-scoped config from the host. */
  config: Record<string, unknown>;
  /** Namespaced logger. */
  log(message: string): void;
  services: PluginServices;
}

/**
 * A Hades plugin. `register` is the one required lifecycle step — it wires hooks
 * and services. `onEnable`/`onDisable` fire when the plugin is toggled at
 * runtime. Everything is optional beyond `name` + `register`.
 */
export interface HadesPlugin {
  name: string;
  version?: string;
  description?: string;
  /** Other plugin names that must be registered first. */
  dependencies?: string[];
  register(ctx: PluginContext): void | Promise<void>;
  onEnable?(): void | Promise<void>;
  onDisable?(): void | Promise<void>;
}
