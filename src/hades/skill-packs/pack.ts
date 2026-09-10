import type { SkillRegistry, SwarmSkill } from "../../swarm-runtime/skills/skill";

/**
 * A skill pack is a curated bundle of related skills for a domain (devops,
 * research, finance…) — the analogue of Hermes' skill packs. Installing a pack
 * drops all its skills into a live {@link SkillRegistry} at once.
 */
export interface SkillPack {
  name: string;
  description: string;
  version?: string;
  skills: SwarmSkill[];
}

export interface PackInstallResult {
  pack: string;
  installed: string[];
  /** Skills skipped because a same-named skill was already registered. */
  skipped: string[];
}

/**
 * Installs skill packs into a `SkillRegistry` and tracks which packs are loaded.
 * By default it won't clobber an existing skill of the same name (reports it as
 * `skipped`); pass `{ overwrite: true }` to force. Kept separate from the plugin
 * system: a pack is pure data (skills), no lifecycle or hooks.
 */
export class SkillPackLoader {
  private installed = new Map<string, PackInstallResult>();

  constructor(private readonly registry: SkillRegistry) {}

  load(pack: SkillPack, opts: { overwrite?: boolean } = {}): PackInstallResult {
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const skill of pack.skills) {
      if (!opts.overwrite && this.registry.get(skill.name)) {
        skipped.push(skill.name);
        continue;
      }
      this.registry.register(skill);
      installed.push(skill.name);
    }
    const result: PackInstallResult = { pack: pack.name, installed, skipped };
    this.installed.set(pack.name, result);
    return result;
  }

  loadedPacks(): string[] {
    return [...this.installed.keys()];
  }
  isLoaded(name: string): boolean {
    return this.installed.has(name);
  }
  skillsOf(packName: string): string[] {
    return this.installed.get(packName)?.installed ?? [];
  }
}

/** A catalog of available packs (offline "browse packs" surface). */
export class SkillPackCatalog {
  private packs = new Map<string, SkillPack>();

  constructor(packs: SkillPack[] = []) {
    for (const p of packs) this.add(p);
  }

  add(pack: SkillPack): this {
    this.packs.set(pack.name, pack);
    return this;
  }
  get(name: string): SkillPack | undefined {
    return this.packs.get(name);
  }
  has(name: string): boolean {
    return this.packs.has(name);
  }
  list(): Array<{ name: string; description: string; version?: string; skills: string[] }> {
    return [...this.packs.values()].map((p) => ({
      name: p.name,
      description: p.description,
      version: p.version,
      skills: p.skills.map((s) => s.name),
    }));
  }

  /** Install a catalog pack by name into a loader. */
  install(name: string, loader: SkillPackLoader, opts?: { overwrite?: boolean }): PackInstallResult {
    const pack = this.packs.get(name);
    if (!pack) throw new Error(`Unknown skill pack: ${name}`);
    return loader.load(pack, opts);
  }
}
