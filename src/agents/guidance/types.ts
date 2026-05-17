export type RiskClass = "critical" | "high" | "medium" | "low" | "info";
export type ToolClass = "edit" | "bash" | "read" | "write" | "mcp" | "task" | "all";
export type TaskIntent = "bug-fix" | "feature" | "refactor" | "security" | "performance" | "testing" | "docs" | "deployment" | "general";
export type GateDecision = "allow" | "block" | "warn" | "require-confirmation";

export interface GuidanceRule {
  id: string;
  text: string;
  riskClass: RiskClass;
  toolClasses: ToolClass[];
  intents: TaskIntent[];
  domains: string[];
  priority: number;        // 1-10, higher = more important
  source: "root" | "local";  // CLAUDE.md vs CLAUDE.local.md
  isConstitution: boolean; // true = always active, false = task-scoped
  verifier?: string;       // e.g. "tests-pass", "lint-clean"
}

export interface PolicyBundle {
  rules: GuidanceRule[];
  constitutionRules: GuidanceRule[];  // subset of rules where isConstitution=true
  manifest: RuleManifest;
  sourceFiles: string[];
  compiledAt: Date;
  hash: string;  // djb2 hash of all rule texts concatenated
}

export interface RuleManifest {
  totalRules: number;
  byRisk: Record<RiskClass, number>;
  byDomain: Record<string, number>;
  criticalRuleIds: string[];
}

export interface GateResult {
  decision: GateDecision;
  gateName: string;
  reason: string;
  triggeredRules: GuidanceRule[];
  remediation?: string;
}

export interface GateContext {
  command?: string;       // shell command being evaluated
  toolName?: string;      // tool being called
  toolArgs?: unknown;     // tool arguments
  editContent?: string;   // content being written
  filePath?: string;      // file being edited
  intent?: TaskIntent;    // detected intent
  runId?: string;
}
