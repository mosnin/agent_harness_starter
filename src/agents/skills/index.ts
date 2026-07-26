/**
 * Skills — named bundles of tools for progressive disclosure.
 *
 * Instead of exposing every tool at once (which overwhelms the model and burns
 * tokens on irrelevant descriptions), skills let you curate focused subsets:
 *
 *   defineSkill({
 *     name: "research",
 *     description: "Search the web and summarize findings",
 *     tools: ["web_search", "browser_scrape"],
 *   });
 *
 * Then in an AgentConfig:
 *   skills: ["research", "code"]   // only these tools are visible to the model
 *
 * Extended fields (inputs, outputs, logic, boundaries, etc.) are optional on
 * every SkillDefinition — no separate registration path needed.
 *
 * Built-in skills are registered below. Add domain-specific skills for your
 * product in this file (or import them from a separate file and call
 * defineSkill() there).
 */

import type { ToolDefinition } from "../tools/types";
import { getAllTools, getTools } from "../tools/registry";
import { registerExtendedSkill } from "./extended-registry";
import type { SkillDefinition } from "./types";

export type { SkillDefinition, ExtendedSkillDefinition, SkillInput, SkillOutput, SkillBoundaries, SkillPrerequisite, SkillCombination, SkillAdaptability, SkillEvaluationConfig, SkillMetric, SkillRunRecord } from "./types";
export type { PrerequisiteCheckResult } from "./extended-registry";

const skillRegistry = new Map<string, SkillDefinition>();

/** Define and register a skill. The only registration path. */
export function defineSkill(skill: SkillDefinition): SkillDefinition {
  skillRegistry.set(skill.name, skill);
  registerExtendedSkill(skill);
  return skill;
}

export function getSkill(name: string): SkillDefinition | undefined {
  return skillRegistry.get(name);
}

export function getAllSkills(): SkillDefinition[] {
  return Array.from(skillRegistry.values());
}

/**
 * Resolve a list of skill names to their constituent ToolDefinitions.
 * Deduplicates — a tool referenced by multiple skills is only returned once.
 */
export function resolveSkillTools(skillNames: string[]): ToolDefinition[] {
  const toolNames = new Set<string>();
  for (const skillName of skillNames) {
    const skill = skillRegistry.get(skillName);
    if (!skill) {
      console.warn(`[skills] Unknown skill: "${skillName}". Skipping.`);
      continue;
    }
    for (const t of skill.tools) toolNames.add(t);
  }
  return getTools(Array.from(toolNames));
}

/**
 * Resolve skill names + explicit tool names into a deduplicated ToolDefinition[].
 * Used by the harness to build the final tool list for an agent.
 *
 * @param fallbackToAll - When true, returns all registered tools if neither tools nor skills are specified.
 *   Defaults to false — returns an empty array when both are empty. Pass true to match legacy behavior.
 */
export function resolveAgentTools(
  toolNames: string[] = [],
  skillNames: string[] = [],
  fallbackToAll = false,
): ToolDefinition[] {
  if (toolNames.length === 0 && skillNames.length === 0) {
    return fallbackToAll ? getAllTools() : [];
  }

  const seen = new Set<string>();
  const results: ToolDefinition[] = [];

  const add = (t: ToolDefinition) => {
    if (!seen.has(t.name)) {
      seen.add(t.name);
      results.push(t);
    }
  };

  for (const t of getTools(toolNames)) add(t);
  for (const t of resolveSkillTools(skillNames)) add(t);

  return results;
}

// ── Extended skill utilities (merged from extended-registry) ──────────────────

export { checkPrerequisites, resolveSkillCombination, buildActiveSkillsPrompt, recordSkillRun, getSkillRunRecords, getSkillAverageScore } from "./extended-registry";

// ── Built-in skills ────────────────────────────────────────────────────────────
// These cover the tools shipped with the starter kit.
// Comment out or override any that don't apply to your product.

defineSkill({
  name: "web",
  description: "Search the web and scrape pages",
  tools: ["web_search", "browser_scrape"],
});

defineSkill({
  name: "code",
  description: "Execute code and manage files in a sandboxed environment",
  tools: ["shell_exec", "file_read", "file_write", "file_list"],
});

defineSkill({
  name: "integrations",
  description: "Interact with connected third-party apps via Composio (GitHub, Slack, etc.)",
  tools: ["composio_execute", "composio_list_connections", "composio_connect_app"],
});

defineSkill({
  name: "research",
  description: "Deep research — combines web search with page scraping",
  tools: ["web_search", "browser_scrape"],
});

export { buildSkillPromptAddendum } from "./builder";
