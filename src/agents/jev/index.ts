/**
 * Jev — TypeSafe System One decision layer for Hades.
 *
 * Jev does not generate text. It evaluates state + typed questions and
 * returns calibrated noul / choice / score answers. Hades uses those
 * answers to route Qwen (OpenRouter), gate tools (Auto Mode), and
 * verify outputs. Voice stays on OpenAI.
 */

export { noul, choice, score, hardenInstructions, noulConfidence, choiceMargin } from "./questions";
export { createJevClient, createJevAsker, createMockJevClient, resetDefaultJevClient, JevUnavailableError, DEFAULT_JEV_MODEL } from "./client";
export { validateResult, validateAnswer, requireNoul, requireChoice, requireScore } from "./validate";
export { GATES, NOUL, SCORE, passesGate, noulBand, decideChoice, decideUnavailable } from "./policy";
export { HADES_QWEN_ROUTES, HADES_ROUTE_ORDER, DEFAULT_HADES_SKILLS, COMPLEXITY_LEVELS, IMPACT_LEVELS } from "./catalog";
export { routeModel, routeSkill, routeIntent, detectRouteOverride } from "./router";
export { assessToolRisk } from "./auto-mode";
export { screenExternal, screenOutput, verifyCitation, scanMalicious } from "./guardrails";
export { scoreQuality, rerankResults, compositeScore, scorePage } from "./scoring";
export { quietAsk, decideCompletion, decideCompaction, classifyCommandFailure, decideBrowserStep, judge } from "./decisions";
export { triageItems, curateLabel } from "./curate";
export { evaluateCases, suggestedThreshold, runEval } from "./eval";
export { superviseWorker, judgePatch } from "./symbolic";
export { approveCompanyAction } from "./company";
export { recordDecision, getJevAudit, clearJevAudit } from "./audit";
export { registerJevMcpTools } from "./mcp";

export type {
  JsonValue,
  JevState,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  JevQuestion,
  JevQuestions,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  JevAnswer,
  JevAnswers,
  SystemOneRequest,
  SystemOneResult,
  PolicyAction,
  PolicyDecision,
  JevClient,
  JevAsker,
  JevAskResult,
  JevClientConfig,
  JevAuditEntry,
  ModelRoute,
  SkillRoute,
  VoiceChannel,
} from "./types";

export type { ModelRouterInput, ModelRouterResult, SkillRouterInput, IntentRouterInput } from "./router";
export type { AutoModeInput } from "./auto-mode";
export type { QualityScore, RankCandidate, RankedCandidate } from "./scoring";
export type { TriageItem, TriageResult } from "./curate";
export type { GoldCase, NodeCalibration, EvalReport } from "./eval";
export type { ForemanObservation, ForemanVerdict } from "./symbolic";
export type { CompanyAction } from "./company";
