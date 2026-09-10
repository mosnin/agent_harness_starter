import { SkillRegistry, type SwarmSkill } from "../../swarm-runtime/skills/skill";
import { validateManifest, type ModuleManifest } from "./manifest";
import { resolveModules } from "./resolver";

/** A skill packaged with its manifest — the unit the loader manages. */
export interface SkillModule {
  manifest: ModuleManifest;
  skill: SwarmSkill;
}

export type ModuleEvent = { type: "load" | "unload" | "reload"; name: string; version: string };

export interface ModuleLoaderOptions {
  onEvent?: (event: ModuleEvent) => void;
}

export interface UnloadResult {
  ok: boolean;
  /** Loaded modules that depend on the target (block unload unless forced). */
  blockedBy?: string[];
}

/**
 * Hot loader for skill modules. Unlike the static `SkillRegistry`, modules can
 * be **loaded, unloaded, and reloaded** at runtime; `skillRegistry()` projects
 * the currently-loaded set into a fresh registry for the swarm to resolve
 * against. `loadAll` resolves dependency order first (via {@link resolveModules})
 * so a module never loads before what it needs. Unloading a module other loaded
 * modules depend on is refused unless forced.
 */
export class SkillModuleLoader {
  private modules = new Map<string, SkillModule>();

  constructor(private readonly opts: ModuleLoaderOptions = {}) {}

  private emit(type: ModuleEvent["type"], m: ModuleManifest): void {
    this.opts.onEvent?.({ type, name: m.name, version: m.version });
  }

  /** Load one module (validating its manifest). Replaces any prior version. */
  load(mod: SkillModule): void {
    const v = validateManifest(mod.manifest);
    if (!v.ok) throw new Error(`Invalid module ${mod.manifest.name}: ${v.errors.join("; ")}`);
    const existed = this.modules.has(mod.manifest.name);
    this.modules.set(mod.manifest.name, mod);
    this.emit(existed ? "reload" : "load", mod.manifest);
  }

  /** Load a set in dependency-first order (resolved against the set itself). */
  loadAll(mods: SkillModule[]): void {
    const manifests = mods.map((m) => m.manifest);
    const byName = new Map(mods.map((m) => [m.manifest.name, m]));
    const res = resolveModules(manifests, manifests.map((m) => m.name));
    if (!res.ok) throw new Error(`Cannot load modules: ${res.errors.join("; ")}`);
    for (const manifest of res.order) {
      const mod = byName.get(manifest.name);
      if (mod) this.load(mod);
    }
  }

  reload(mod: SkillModule): void {
    this.load(mod);
  }

  /** Which loaded modules declare a dependency on `name`. */
  dependentsOf(name: string): string[] {
    return [...this.modules.values()]
      .filter((m) => m.manifest.dependencies && name in m.manifest.dependencies)
      .map((m) => m.manifest.name);
  }

  unload(name: string, opts: { force?: boolean } = {}): UnloadResult {
    if (!this.modules.has(name)) return { ok: false };
    const blockedBy = this.dependentsOf(name);
    if (blockedBy.length && !opts.force) return { ok: false, blockedBy };
    const manifest = this.modules.get(name)!.manifest;
    this.modules.delete(name);
    this.emit("unload", manifest);
    return { ok: true };
  }

  isLoaded(name: string): boolean {
    return this.modules.has(name);
  }
  loaded(): ModuleManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }
  size(): number {
    return this.modules.size;
  }

  /** Project the currently-loaded skills into a fresh registry. */
  skillRegistry(): SkillRegistry {
    return new SkillRegistry([...this.modules.values()].map((m) => m.skill));
  }
}
