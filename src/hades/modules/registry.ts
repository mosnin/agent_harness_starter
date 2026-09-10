import { validateManifest, parseVersion, compareVersions, type ModuleManifest } from "./manifest";
import { resolveModules, type ResolveResult } from "./resolver";

/**
 * One catalog for *all* modules — skills, plugins, and packs alike. It holds
 * every available version, surfaces conflicts (duplicate name+version, or the
 * same name declared with different kinds), and resolves a cross-kind install
 * set through the shared {@link resolveModules}. This is the single registry the
 * CLI/marketplace queries and the loaders draw from.
 */
export class ModuleRegistry {
  private entries: ModuleManifest[] = [];

  add(manifest: ModuleManifest): this {
    const v = validateManifest(manifest);
    if (!v.ok) throw new Error(`invalid manifest ${manifest.name}: ${v.errors.join("; ")}`);
    if (this.entries.some((e) => e.name === manifest.name && e.version === manifest.version)) {
      throw new Error(`duplicate module ${manifest.name}@${manifest.version}`);
    }
    this.entries.push(manifest);
    return this;
  }
  addAll(manifests: ModuleManifest[]): this {
    for (const m of manifests) this.add(m);
    return this;
  }

  available(): ModuleManifest[] {
    return [...this.entries];
  }
  /** All versions of a module, newest first. */
  find(name: string): ModuleManifest[] {
    return this.entries
      .filter((e) => e.name === name)
      .sort((a, b) => -compareVersions(parseVersion(a.version)!, parseVersion(b.version)!));
  }
  latest(name: string): ModuleManifest | undefined {
    return this.find(name)[0];
  }
  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  /** Count by kind. */
  counts(): { skill: number; plugin: number; pack: number } {
    const c = { skill: 0, plugin: 0, pack: 0 };
    for (const e of this.entries) c[e.kind]++;
    return c;
  }

  /** Names declared under more than one kind — a real conflict. */
  conflicts(): string[] {
    const kinds = new Map<string, Set<string>>();
    for (const e of this.entries) {
      const set = kinds.get(e.name) ?? new Set();
      set.add(e.kind);
      kinds.set(e.name, set);
    }
    return [...kinds.entries()].filter(([, k]) => k.size > 1).map(([name]) => name);
  }

  /** Resolve an install set (any kind) into dependency-first order. */
  resolve(names: string[]): ResolveResult {
    return resolveModules(this.entries, names);
  }
}
