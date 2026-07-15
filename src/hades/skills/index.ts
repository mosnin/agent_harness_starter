/**
 * @module hades/skills
 *
 * Author skills in portable SKILL.md (markdown + frontmatter) — no code, no
 * recompile — and load a whole folder of them into a searchable library that
 * binds real tools and specializes a worker. The `hades skill` CLI scaffolds,
 * validates, and lists them; the MCP server exposes them to other agents.
 */
export {
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
  toSwarmSkill,
  skillTemplate,
} from "./skill-file";
// ManifestValidation is intentionally not re-exported here (name clashes with
// modules/*); import it from "./skill-file" directly if needed.
export type { SkillManifest, ParseResult } from "./skill-file";
export { SkillLibrary } from "./library";
export type { LoadedSkill, LoadReport } from "./library";
