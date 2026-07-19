import { ModelRegistry } from "./registry";

/**
 * The built-in model catalog. IDs match the current Claude lineup; a deployment
 * can register more or override the default. `defaultId` marks the preferred
 * model when it's one of the known ids.
 */
export function defaultModelRegistry(defaultId?: string): ModelRegistry {
  const registry = new ModelRegistry()
    .register({ id: "claude-opus-4-1", provider: "anthropic", displayName: "Claude Opus 4.1", aliases: ["opus"], contextWindow: 200000, tags: ["flagship"] })
    .register({ id: "claude-sonnet-5", provider: "anthropic", displayName: "Claude Sonnet 5", aliases: ["sonnet"], contextWindow: 200000, tags: ["balanced"] })
    .register({ id: "claude-haiku-4-5-20251001", provider: "anthropic", displayName: "Claude Haiku 4.5", aliases: ["haiku"], contextWindow: 200000, tags: ["fast"] })
    .register({ id: "claude-fable-5", provider: "anthropic", displayName: "Claude Fable 5", aliases: ["fable"], tags: ["creative"] });

  if (defaultId && registry.has(defaultId)) {
    const resolved = registry.resolve(defaultId)!;
    registry.register(resolved, { default: true });
  }
  return registry;
}
