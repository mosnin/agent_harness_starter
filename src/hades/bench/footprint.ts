/**
 * Footprint / lightweight pass. Hades stays lean by **not building what it
 * doesn't use**: modules, skills, and connectors register a *factory* and are
 * only instantiated on first access. Registering a 100-module catalog costs
 * almost nothing until something is actually requested — which is how a Hades
 * gateway starts faster and lighter than an eager one.
 */

/** A value built at most once, on first `get()`. */
export class Lazy<T> {
  private value?: T;
  private built = false;
  constructor(private readonly factory: () => T) {}

  get(): T {
    if (!this.built) {
      this.value = this.factory();
      this.built = true;
    }
    return this.value as T;
  }
  get loaded(): boolean {
    return this.built;
  }
}

/**
 * A registry that holds factories and instantiates lazily, caching the result.
 * `instantiatedCount()` vs `size()` is the footprint metric — the gap is what
 * lazy loading saved.
 */
export class LazyModuleRegistry<T> {
  private factories = new Map<string, () => T>();
  private cache = new Map<string, T>();

  register(name: string, factory: () => T): this {
    this.factories.set(name, factory);
    return this;
  }
  has(name: string): boolean {
    return this.factories.has(name);
  }
  names(): string[] {
    return [...this.factories.keys()];
  }
  size(): number {
    return this.factories.size;
  }

  /** Build (once) and return the module, or undefined if unregistered. */
  get(name: string): T | undefined {
    if (this.cache.has(name)) return this.cache.get(name);
    const factory = this.factories.get(name);
    if (!factory) return undefined;
    const value = factory();
    this.cache.set(name, value);
    return value;
  }

  isInstantiated(name: string): boolean {
    return this.cache.has(name);
  }
  instantiatedCount(): number {
    return this.cache.size;
  }

  /** Drop an instantiated module (free memory) while keeping its factory. */
  evict(name: string): boolean {
    return this.cache.delete(name);
  }
}

export interface FootprintReport {
  registered: number;
  instantiated: number;
  /** Fraction of the catalog actually built (lower = lighter). */
  ratio: number;
  lazyNames: string[];
}

export function footprintReport<T>(registry: LazyModuleRegistry<T>): FootprintReport {
  const registered = registry.size();
  const instantiated = registry.instantiatedCount();
  return {
    registered,
    instantiated,
    ratio: registered === 0 ? 0 : instantiated / registered,
    lazyNames: registry.names().filter((n) => !registry.isInstantiated(n)),
  };
}
