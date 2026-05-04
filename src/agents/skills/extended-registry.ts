/**
 * Extended skill registry — prerequisite validation, combination resolution,
 * prompt addendum building, and run recording.
 *
 * Populated automatically when defineSkill() is called in skills/index.ts.
 * Do not import registerExtendedSkill directly — use defineSkill instead.
 */

import type { SkillDefinition, SkillRunRecord } from "./types";
import { buildSkillPromptAddendum } from "./builder";

const extendedRegistry = new Map<string, SkillDefinition>();

export function registerExtendedSkill(skill: SkillDefinition): void {
  extendedRegistry.set(skill.name, skill);
}

export function getExtendedSkill(name: string): SkillDefinition | undefined {
  return extendedRegistry.get(name);
}

export function getAllExtendedSkills(): SkillDefinition[] {
  return Array.from(extendedRegistry.values());
}

// ── Prerequisite validation ───────────────────────────────────────────────────

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  missing: Array<{ name: string; type: string; reason: string }>;
  warnings: Array<{ name: string; type: string; reason: string }>;
}

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

export function buildActiveSkillsPrompt(activeSkillNames: string[]): string {
  const blocks = activeSkillNames
    .map((name) => extendedRegistry.get(name))
    .filter((s): s is SkillDefinition => s !== undefined)
    .filter((s) => s.logic || s.inputs?.length || s.outputs?.length || s.boundaries)
    .map(buildSkillPromptAddendum);

  if (blocks.length === 0) return "";
  return "---\n\n## Active Skills\n\n" + blocks.join("\n\n---\n\n");
}

// ── Skill run recorder ────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __skillRunRecords: Map<string, SkillRunRecord[]> | undefined;
}
const runRecords: Map<string, SkillRunRecord[]> =
  globalThis.__skillRunRecords ?? (globalThis.__skillRunRecords = new Map());

export function recordSkillRun(record: SkillRunRecord): void {
  const existing = runRecords.get(record.skillName) ?? [];
  existing.push(record);
  if (existing.length > 1000) existing.shift();
  runRecords.set(record.skillName, existing);
}

export function getSkillRunRecords(skillName: string): SkillRunRecord[] {
  return runRecords.get(skillName) ?? [];
}

export function getSkillAverageScore(skillName: string, lastN = 50): number | null {
  const records = getSkillRunRecords(skillName).slice(-lastN);
  const scored = records.filter((r) => r.score !== undefined);
  if (scored.length === 0) return null;
  return scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length;
}
