/**
 * SkillBuilder — fluent API for defining extended skills.
 *
 * Usage:
 *   import { defineSkillExtended } from "@/agents/skills/builder";
 *
 *   const researchSkill = defineSkillExtended("research")
 *     .description("Search the web and synthesize cited answers.")
 *     .tools(["web_search", "browser_scrape"])
 *     .inputs([
 *       { name: "query", description: "The research question", required: true },
 *       { name: "depth", description: "How many sources to consult", required: false },
 *     ])
 *     .outputs([{ name: "answer", description: "Cited summary", type: "string" }])
 *     .logic("Search → scrape top results → synthesize with citations.")
 *     .boundaries({
 *       cannotDo: ["Execute code", "Modify files"],
 *       deferWhen: ["Task requires real-time data", "Task requires code execution"],
 *     })
 *     .prerequisites([{ type: "tool", name: "web_search", reason: "Needs internet access" }])
 *     .combinations([{ with: ["code"], mode: "sequential", description: "Research then implement" }])
 *     .evaluation({ metrics: [{ name: "citationCount", type: "count", target: 3 }] })
 *     .register();
 */

import type {
  ExtendedSkillDefinition,
  SkillInput,
  SkillOutput,
  SkillBoundaries,
  SkillPrerequisite,
  SkillCombination,
  SkillAdaptability,
  SkillEvaluationConfig,
} from "./types";
import { registerExtendedSkill } from "./extended-registry";

export class SkillBuilder {
  private def: Partial<ExtendedSkillDefinition> = {};

  constructor(name: string) {
    this.def.name = name;
    this.def.tools = [];
    this.def.inputs = [];
    this.def.outputs = [];
    this.def.prerequisites = [];
    this.def.combinations = [];
    this.def.tags = [];
  }

  description(desc: string): this { this.def.description = desc; return this; }
  tools(tools: string[]): this { this.def.tools = tools; return this; }
  inputs(inputs: SkillInput[]): this { this.def.inputs = inputs; return this; }
  outputs(outputs: SkillOutput[]): this { this.def.outputs = outputs; return this; }
  logic(logic: string): this { this.def.logic = logic; return this; }
  boundaries(b: SkillBoundaries): this { this.def.boundaries = b; return this; }
  prerequisites(prereqs: SkillPrerequisite[]): this { this.def.prerequisites = prereqs; return this; }
  combinations(combos: SkillCombination[]): this { this.def.combinations = combos; return this; }
  adaptability(a: SkillAdaptability): this { this.def.adaptability = a; return this; }
  evaluation(e: SkillEvaluationConfig): this { this.def.evaluation = e; return this; }
  tags(tags: string[]): this { this.def.tags = tags; return this; }
  cost(c: ExtendedSkillDefinition["cost"]): this { this.def.cost = c; return this; }
  promptAddendum(text: string): this { this.def.promptAddendum = text; return this; }

  /** Build and return the definition without registering it. */
  build(): ExtendedSkillDefinition {
    if (!this.def.name) throw new Error("Skill must have a name.");
    if (!this.def.description) throw new Error(`Skill "${this.def.name}" must have a description.`);
    return {
      name: this.def.name,
      description: this.def.description,
      tools: this.def.tools ?? [],
      inputs: this.def.inputs,
      outputs: this.def.outputs,
      logic: this.def.logic,
      boundaries: this.def.boundaries,
      prerequisites: this.def.prerequisites,
      combinations: this.def.combinations,
      adaptability: this.def.adaptability,
      evaluation: this.def.evaluation,
      tags: this.def.tags,
      cost: this.def.cost,
      promptAddendum: this.def.promptAddendum,
    };
  }

  /** Build and register in the extended skill registry. */
  register(): ExtendedSkillDefinition {
    const skill = this.build();
    registerExtendedSkill(skill);
    return skill;
  }
}

export function defineSkillExtended(name: string): SkillBuilder {
  return new SkillBuilder(name);
}

/** Build a skill's prompt addendum from its definition fields. */
export function buildSkillPromptAddendum(skill: ExtendedSkillDefinition): string {
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
