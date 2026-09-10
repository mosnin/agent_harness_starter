export { PluginManager } from "./manager";
export type { PluginManagerOptions } from "./manager";
export { LocalPluginRegistry, defaultPluginRegistry } from "./registry";
export type { PluginEntry, PluginMetadata } from "./registry";
export { AchievementsPlugin } from "./examples/achievements";
export type { Achievement } from "./examples/achievements";
export { KanbanPlugin } from "./examples/kanban";
export type { KanbanCard, KanbanColumn } from "./examples/kanban";
export { BrowserPlugin } from "./examples/browser";
export type {
  HadesPlugin,
  PluginContext,
  PluginServices,
  PluginHookMap,
  HookName,
  HookListener,
} from "./plugin";
