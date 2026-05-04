/**
 * Extended skill registry — stores ExtendedSkillDefinitions and provides
 * prerequisite validation, combination resolution, and prompt addendum building.
 */

import type { ExtendedSkillDefinition, SkillRunRecord } from "./types";
import { buildSkillPromptAddendum } from "./builder";
import { registerSkill } from "./index";

const extendedRegistry = new Map<string, ExtendedSkillDefinition>();

export function registerExtendedSkill(skill: ExtendedSkillDefinition): void {
  extendedRegistry.set(skill.name, skill);
  // Also register in the base skills registry so it works with existing harness code
  registerSkill({ name: skill.name, description: skill.description, tools: skill.tools });
}

export function getExtendedSkill(name: string): ExtendedSkillDefinition | undefined {
  return extendedRegistry.get(name);
}

export function getAllExtendedSkills(): ExtendedSkillDefinition[] {
  return Array.from(extendedRegistry.values());
}

// ── Prerequisite validation ───────────────────────────────────────────────────

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  missing: Array<{ name: string; type: string; reason: string }>;
  warnings: Array<{ name: string; type: string; reason: string }>;
}

/**
 * Check if all prerequisites for a skill are met.
 * @param skillName - The skill to check
 * @param availableContext - Keys available in the current context
 * @param availableTools - Tool names currently available to the agent
 * @param availableSkills - Skill names currently active for the agent
 */
export function checkPrerequisites(
  skillName: string,
  availableContext: string[] = [],
  availableTools: string[] = [],
  availableSkills: string[] = []
): PrerequisiteCheckResult {
  const skill = extendedRegistry.get(skillName);
  if (!skill?.prerequisites?.length) {
    return { satisfied: true, missing: [], warnings: [] };
  }

  const missing: PrerequisiteCheckResult["missing"] = [];
  const warnings: PrerequisiteCheckResult["warnings"] = [];

  for (const prereq of skill.prerequisites) {
    const required = prereq.required !== false;
    let met = false;

    switch (prereq.type) {
      case "tool":    met = availableTools.includes(prereq.name); break;
      case "skill":   met = availableSkills.includes(prereq.name); break;
      case "context": met = availableContext.includes(prereq.name); break;
      case "data":    met = availableContext.includes(prereq.name); break;
    }

    if (!met) {
      (required ? missing : warnings).push({
        name: prereq.name,
        type: prereq.type,
        reason: prereq.reason,
      });
    }
  }

  return { satisfied: missing.length === 0, missing, warnings };
}

// ── Combination resolver ──────────────────────────────────────────────────────

/**
 * Resolve a skill combination: return ordered skill names for the given mode.
 */
export function resolveSkillCombination(
  primarySkillName: string,
  partnerSkillNames: string[]
): { skills: string[]; mode: string; description: string } | null {
  const skill = extendedRegistry.get(primarySkillName);
  if (!skill?.combinations) return null;

  const combo = skill.combinations.find(
    (c) => partnerSkillNames.every((p) => c.with.includes(p))
  );
  if (!combo) return null;

  const ordered = combo.order ?? [primarySkillName, ...combo.with];
  return { skills: ordered, mode: combo.mode ?? "sequential", description: combo.description };
}

// ── Prompt addendum aggregator ────────────────────────────────────────────────

/**
 * Build a combined prompt addendum for a list of active skills.
 * Skips skills with no extended definition.
 */
export function buildActiveSkillsPrompt(activeSkillNames: string[]): string {
  const blocks = activeSkillNames
    .map((name) => extendedRegistry.get(name))
    .filter((s): s is ExtendedSkillDefinition => s !== undefined)
    .filter((s) => s.logic || s.inputs?.length || s.outputs?.length || s.boundaries)
    .map(buildSkillPromptAddendum);

  if (blocks.length === 0) return "";
  return "---\n\n## Active Skills\n\n" + blocks.join("\n\n---\n\n");
}

// ── Skill run recorder (for adaptability / evaluation) ───────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __skillRunRecords: Map<string, SkillRunRecord[]> | undefined;
}
const runRecords: Map<string, SkillRunRecord[]> =
  globalThis.__skillRunRecords ?? (globalThis.__skillRunRecords = new Map());

export function recordSkillRun(record: SkillRunRecord): void {
  const existing = runRecords.get(record.skillName) ?? [];
  existing.push(record);
  // Keep last 1000 records per skill
  if (existing.length > 1000) existing.shift();
  runRecords.set(record.skillName, existing);
}

export function getSkillRunRecords(skillName: string): SkillRunRecord[] {
  return runRecords.get(skillName) ?? [];
}

/**
 * Compute average score for a skill over recent runs.
 * Returns null if no scored runs exist.
 */
export function getSkillAverageScore(skillName: string, lastN = 50): number | null {
  const records = getSkillRunRecords(skillName).slice(-lastN);
  const scored = records.filter((r) => r.score !== undefined);
  if (scored.length === 0) return null;
  return scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length;
}
