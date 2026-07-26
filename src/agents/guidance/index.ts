export { compileGuidance } from "./compiler";
export type { CompilerOptions } from "./compiler";
export { withGuidance } from "./plugin";
export type { GuidancePluginOptions } from "./plugin";
export { destructiveOpsGate, secretsGate, toolAllowlistGate, diffSizeGate, aggregateGateResults } from "./gates";
export type { GuidanceRule, PolicyBundle, RuleManifest, GateDecision, GateResult, GateContext, RiskClass, ToolClass, TaskIntent } from "./types";
