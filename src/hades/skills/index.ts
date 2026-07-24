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
// agentskills.io / open-skill-format interop (`hades skills hub`).
export { parseAgentSkill, toHadesManifest, fromHadesManifest } from "./agentskills-compat";
export type { AgentSkillsManifest, AgentSkillParseResult } from "./agentskills-compat";
export {
  defaultHubFs,
  scanSkillInstructions,
  importSkillPackage,
  exportSkillPackage,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
} from "./hub-package";
export type { HubFs, HubDirEntry, HubStat, ImportReport, ImportSkillPackageOptions } from "./hub-package";
