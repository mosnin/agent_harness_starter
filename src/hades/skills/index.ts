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
// Phase-10 skill evolution — synthesis from GATE-VERIFIED trajectories.
export {
  canonicalTrajectoryJson,
  verifyTrajectoryForSynthesis,
  synthesizeSkill,
  extractProvenance,
} from "./synthesize";
export type {
  VerifiedTrajectory,
  SynthesisRejection,
  SkillProvenance,
  SynthesisOptions,
  SynthesisResult,
} from "./synthesize";
// (GoalTrajectory/TaskTrajectory/ToolEvent are re-exported by synthesize.ts for
// direct importers, but NOT here — the root barrel already exports them via
// ../research/index and duplicating them would make `export *` ambiguous.)
// Phase-10 skill evolution — hash-chained, Brier/Wilson-scored track record.
export { SkillTrackRecordStore, TrackRecordValidationError, brierScore, wilsonLowerBound } from "./track-record";
export type {
  SkillOutcome,
  TrackRecordEntry,
  SkillTrackSummary,
  TrackRecordFs,
  TrackRecordStoreOptions,
} from "./track-record";
// Phase-10 skill evolution — pure trust lifecycle / demotion policy.
export {
  defaultSkillTrustPolicy,
  evaluateSkillTrust,
  applyOutcomeToStreak,
  serializeTrustStates,
  parseTrustStates,
} from "./demotion";
export type {
  SkillTrustStatus,
  SkillTrustPolicy,
  SkillTrustState,
  DemotionDecision,
  TrustStateStoreShape,
} from "./demotion";
// Phase-10 skill evolution — deterministic refine-on-use engine.
export { refineSkill, extractRefinementLedger } from "./refine";
export type { VerifiedUse, RefineOpKind, RefineOp, RefineResult, RefineOptions } from "./refine";
// Phase-10 skill evolution — read-side, fail-closed trust selection over the
// persisted skill-trust.json + skill-track.json stores (`hades skill trust show`,
// the TUI SKILLS/TRUST pane, and the desktop Skills badges all read through this).
export { SkillTrustReader, resolveWithTrust, orderByTrust } from "./trust-selection";
export type {
  EffectiveTrustStatus,
  SkillTrustRow,
  TrustReaderFs,
  TrustAwareResolution,
} from "./trust-selection";
// Phase-10 skill evolution — paired holdout exit gate (`hades skill holdout`).
export { runHoldoutValidation, applyHoldoutDecision } from "./holdout";
export type {
  HoldoutCase,
  HoldoutRunResult,
  HoldoutRunner,
  HoldoutArmStats,
  HoldoutVerdict,
  HoldoutDecision,
  HoldoutOptions,
  HoldoutFs,
  ApplyResult,
} from "./holdout";
// Phase-10 skill evolution — gate-verdict -> track-record machine path
// (`hades skill track-batch`), idempotent and integrity-guarded.
export { gateUseToOutcome, GateTrackRecorder } from "./gate-track-hook";
export type { GatedSkillUse, SkipReason, RecordReport } from "./gate-track-hook";
