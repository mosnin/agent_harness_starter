/**
 * Skill prompt utilities.
 *
 * buildSkillPromptAddendum renders a SkillDefinition's extended fields
 * (inputs, outputs, logic, boundaries, combinations) into a prompt block
 * injected into the agent's system prompt when the skill is active.
 */

import type { SkillDefinition } from "./types";

/** Build a skill's prompt addendum from its definition fields. */
export function buildSkillPromptAddendum(skill: SkillDefinition): string {
  const parts: string[] = [`## Skill: ${skill.name}`];
  parts.push(skill.description);

  if (skill.inputs?.length) {
    parts.push("**Inputs:**\n" + skill.inputs.map((i) =>
      `  - ${i.name}${i.required === false ? " (optional)" : ""}: ${i.description}`
        + (i.examples ? ` (e.g. ${i.examples.join(", ")})` : "")
    ).join("\n"));
  }

  if (skill.outputs?.length) {
    parts.push("**Outputs:**\n" + skill.outputs.map((o) =>
      `  - ${o.name} (${o.type}): ${o.description}`
    ).join("\n"));
  }

  if (skill.logic) {
    parts.push(`**How to use this skill:**\n${skill.logic}`);
  }

  if (skill.boundaries?.cannotDo?.length) {
    parts.push("**This skill cannot:**\n" + skill.boundaries.cannotDo.map((c) => `  - ${c}`).join("\n"));
  }

  if (skill.boundaries?.deferWhen?.length) {
    parts.push("**Defer to another skill when:**\n" + skill.boundaries.deferWhen.map((d) => `  - ${d}`).join("\n"));
  }

  if (skill.combinations?.length) {
    parts.push("**Works well with:**\n" + skill.combinations.map((c) =>
      `  - ${c.with.join(" + ")} (${c.mode ?? "sequential"}): ${c.description}`
    ).join("\n"));
  }

  return parts.join("\n\n");
}
