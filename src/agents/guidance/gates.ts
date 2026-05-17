import type { GateResult, GateContext, GuidanceRule, GateDecision } from "./types";

// ── Gate 1: Destructive Operations ────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: string[] = [
  "rm -rf",
  "rm -fr",
  "DROP TABLE",
  "DROP DATABASE",
  "DROP SCHEMA",
  "TRUNCATE TABLE",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "format c:",
  "mkfs",
  "dd if=/dev/zero",
  "dd if=/dev/urandom",
  "kubectl delete",
  "terraform destroy",
  "> /dev/sda",
];

export function destructiveOpsGate(ctx: GateContext, rules: GuidanceRule[]): GateResult {
  const content = [ctx.command ?? "", ctx.editContent ?? ""].join("\n");

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (content.includes(pattern)) {
      const triggeredRules = rules.filter(
        (r) => r.riskClass === "critical" || r.riskClass === "high"
      );
      return {
        decision: "require-confirmation",
        gateName: "destructiveOpsGate",
        reason: `Destructive operation detected: ${pattern}`,
        triggeredRules,
        remediation:
          "Confirm the operation is intentional and a rollback plan exists before proceeding.",
      };
    }
  }

  return {
    decision: "allow",
    gateName: "destructiveOpsGate",
    reason: "No destructive operations detected.",
    triggeredRules: [],
  };
}

// ── Gate 2: Secrets ────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  // API keys
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /AKIA[A-Z0-9]{16}/,
  /xoxb-[A-Za-z0-9-]{50,}/,
  /AIza[A-Za-z0-9_-]{35,}/,
  // Private keys
  /BEGIN RSA PRIVATE KEY/,
  /BEGIN PRIVATE KEY/,
  /BEGIN EC PRIVATE KEY/,
  // Generic
  /password\s*[=:]\s*[^\s]{8,}/i,
  /secret\s*[=:]\s*[^\s]{8,}/i,
  /token\s*[=:]\s*[^\s]{20,}/i,
];

export function secretsGate(ctx: GateContext, rules: GuidanceRule[]): GateResult {
  const editContent = ctx.editContent ?? "";
  const toolArgsStr =
    ctx.toolArgs !== undefined ? JSON.stringify(ctx.toolArgs) : "";
  const combined = `${editContent}\n${toolArgsStr}`;

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(combined)) {
      const triggeredRules = rules.filter(
        (r) =>
          r.riskClass === "critical" ||
          r.riskClass === "high" ||
          r.intents.includes("security") ||
          r.domains.includes("@security")
      );
      return {
        decision: "block",
        gateName: "secretsGate",
        reason: "Secret or credential detected in content",
        triggeredRules,
        remediation:
          "Use environment variables or a secrets manager. Never commit secrets to files or include them in tool calls.",
      };
    }
  }

  return {
    decision: "allow",
    gateName: "secretsGate",
    reason: "No secrets detected.",
    triggeredRules: [],
  };
}

// ── Gate 3: Tool Allowlist ────────────────────────────────────────────────────

export function toolAllowlistGate(
  ctx: GateContext,
  allowlist: string[],
  rules: GuidanceRule[]
): GateResult {
  // Empty allowlist = no restriction
  if (allowlist.length === 0) {
    return {
      decision: "allow",
      gateName: "toolAllowlistGate",
      reason: "No allowlist configured — all tools permitted.",
      triggeredRules: [],
    };
  }

  const toolName = ctx.toolName ?? "";

  if (allowlist.includes(toolName)) {
    return {
      decision: "allow",
      gateName: "toolAllowlistGate",
      reason: `Tool "${toolName}" is in the configured allowlist.`,
      triggeredRules: [],
    };
  }

  const triggeredRules = rules.filter(
    (r) => r.toolClasses.includes("all") || r.riskClass === "high" || r.riskClass === "critical"
  );

  return {
    decision: "block",
    gateName: "toolAllowlistGate",
    reason: `Tool "${toolName}" is not in the configured allowlist`,
    triggeredRules,
    remediation: `Permitted tools: ${allowlist.join(", ")}`,
  };
}

// ── Gate 4: Diff Size ─────────────────────────────────────────────────────────

export function diffSizeGate(
  ctx: GateContext,
  maxLines: number,
  rules: GuidanceRule[]
): GateResult {
  const content = ctx.editContent ?? "";
  if (!content) {
    return {
      decision: "allow",
      gateName: "diffSizeGate",
      reason: "No edit content to evaluate.",
      triggeredRules: [],
    };
  }

  const lineCount = content.split("\n").length;

  if (lineCount > maxLines) {
    return {
      decision: "warn",
      gateName: "diffSizeGate",
      reason: `Edit contains ${lineCount} lines (limit: ${maxLines})`,
      triggeredRules: rules.filter((r) => r.priority >= 7),
      remediation:
        "Consider breaking this into smaller, focused commits. Stage and review incrementally.",
    };
  }

  return {
    decision: "allow",
    gateName: "diffSizeGate",
    reason: `Edit size (${lineCount} lines) is within the limit (${maxLines}).`,
    triggeredRules: [],
  };
}

// ── Aggregator ────────────────────────────────────────────────────────────────

const SEVERITY: Record<GateDecision, number> = {
  block: 3,
  "require-confirmation": 2,
  warn: 1,
  allow: 0,
};

export function aggregateGateResults(results: GateResult[]): GateResult {
  if (results.length === 0) {
    return {
      decision: "allow",
      gateName: "aggregate",
      reason: "No gates evaluated.",
      triggeredRules: [],
    };
  }

  // Find the maximum severity
  let maxSeverity = -1;
  for (const r of results) {
    if (SEVERITY[r.decision] > maxSeverity) maxSeverity = SEVERITY[r.decision];
  }

  // Collect all results at the max severity
  const top = results.filter((r) => SEVERITY[r.decision] === maxSeverity);

  const decision = top[0].decision;
  const reason = top.map((r) => r.reason).join("; ");
  const triggeredRules = top.flatMap((r) => r.triggeredRules);
  const remediations = top
    .map((r) => r.remediation)
    .filter((s): s is string => !!s);
  const remediation = remediations.length > 0 ? remediations.join(" ") : undefined;

  // Deduplicate triggered rules by id
  const seen = new Set<string>();
  const uniqueRules: GuidanceRule[] = [];
  for (const rule of triggeredRules) {
    if (!seen.has(rule.id)) {
      seen.add(rule.id);
      uniqueRules.push(rule);
    }
  }

  return {
    decision,
    gateName: "aggregate",
    reason,
    triggeredRules: uniqueRules,
    remediation,
  };
}
