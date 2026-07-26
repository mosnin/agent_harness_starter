/**
 * SkillLibrary — load a whole directory of SKILL.md skills, index them, search
 * them, and resolve a selected set into runnable {@link SwarmSkill}s.
 *
 * File I/O is INJECTED: callers hand in `{ path, content }` records rather than
 * having the library touch the filesystem. That keeps it pure and deterministic
 * — no fs, clock, randomness, or network — so it is trivially testable and safe
 * to run against untrusted skill files.
 *
 * Parsing/validation/binding is delegated to the sibling {@link ./skill-file}
 * module: {@link parseSkillFile} + {@link validateSkillManifest} gate what gets
 * indexed, and {@link toSwarmSkill} binds tool names against a registry when a
 * selection is resolved.
 */

import {
  parseSkillFile,
  validateSkillManifest,
  toSwarmSkill,
  type SkillManifest,
} from "./skill-file";

export interface LoadedSkill {
  manifest: SkillManifest;
  path: string;
  warnings: string[];
}

export interface LoadReport {
  loaded: LoadedSkill[];
  errors: Array<{ path: string; error: string }>;
}

/** Deterministic (locale-free) ascending compare by skill name. */
function byName(a: LoadedSkill, b: LoadedSkill): number {
  const an = a.manifest.name;
  const bn = b.manifest.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SkillLibrary {
  private skills = new Map<string, LoadedSkill>();

  /**
   * Parse + validate each file. Valid manifests are indexed by `manifest.name`
   * (last wins; a name collision keeps the last definition and records a
   * warning on it). Malformed or invalid files land in `errors` — a bad file
   * never throws out of the whole load.
   */
  loadFiles(files: Array<{ path: string; content: string }>): LoadReport {
    const report: LoadReport = { loaded: [], errors: [] };
    for (const { path, content } of files) {
      let warnings: string[];
      let manifest: SkillManifest;
      try {
        const parsed = parseSkillFile(content);
        manifest = parsed.manifest;
        warnings = parsed.warnings;
      } catch (e) {
        report.errors.push({ path, error: errorMessage(e) });
        continue;
      }
      const validation = validateSkillManifest(manifest);
      if (!validation.valid) {
        report.errors.push({ path, error: validation.errors.join("; ") });
        continue;
      }
      report.loaded.push(this.index(manifest, path, warnings));
    }
    return report;
  }

  /** Index a manifest directly (path optional). Last wins; collisions warn. */
  add(manifest: SkillManifest, path?: string): void {
    this.index(manifest, path ?? "", []);
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  /** All indexed skills, sorted by name (deterministic). */
  list(): LoadedSkill[] {
    return [...this.skills.values()].sort(byName);
  }

  /** Case-insensitive substring match over name/description/capabilities/whenToUse. */
  search(query: string): LoadedSkill[] {
    const q = query.toLowerCase();
    if (q === "") return this.list();
    return this.list().filter((s) => {
      const m = s.manifest;
      const haystack = [
        m.name,
        m.description,
        m.whenToUse ?? "",
        ...m.capabilities,
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  /** Skills that provide the given capability (case-insensitive), sorted by name. */
  byCapability(capability: string): LoadedSkill[] {
    const cap = capability.toLowerCase();
    return this.list().filter((s) =>
      s.manifest.capabilities.some((c) => c.toLowerCase() === cap)
    );
  }

  /**
   * Resolve selected skill names into {@link SwarmSkill}s by binding their tool
   * names against `tools`. Returns the bound skills, the merged+deduped
   * capability set, any missing tool names (deduped, first-seen order), and any
   * requested names that are not in the library.
   */
  resolve(
    names: string[],
    tools: { get(name: string): unknown }
  ): {
    skills: Array<ReturnType<typeof toSwarmSkill>["skill"]>;
    capabilities: string[];
    missingTools: string[];
    unknownSkills: string[];
  } {
    const skills: Array<ReturnType<typeof toSwarmSkill>["skill"]> = [];
    const capabilities: string[] = [];
    const capSeen = new Set<string>();
    const missingTools: string[] = [];
    const missingSeen = new Set<string>();
    const unknownSkills: string[] = [];

    for (const name of names) {
      const entry = this.skills.get(name);
      if (!entry) {
        unknownSkills.push(name);
        continue;
      }
      // allowMissingTools: collect missing tools instead of throwing.
      const { skill, missingTools: mt } = toSwarmSkill(entry.manifest, tools, {
        allowMissingTools: true,
      });
      skills.push(skill);
      for (const c of skill.capabilities) {
        if (!capSeen.has(c)) {
          capSeen.add(c);
          capabilities.push(c);
        }
      }
      for (const t of mt) {
        if (!missingSeen.has(t)) {
          missingSeen.add(t);
          missingTools.push(t);
        }
      }
    }

    return { skills, capabilities, missingTools, unknownSkills };
  }

  size(): number {
    return this.skills.size;
  }

  private index(manifest: SkillManifest, path: string, warnings: string[]): LoadedSkill {
    const name = manifest.name;
    const entryWarnings = [...warnings];
    if (this.skills.has(name)) {
      entryWarnings.push(
        `name collision: "${name}" already loaded — keeping the last definition (last wins).`
      );
    }
    const entry: LoadedSkill = { manifest, path, warnings: entryWarnings };
    this.skills.set(name, entry);
    return entry;
  }
}
