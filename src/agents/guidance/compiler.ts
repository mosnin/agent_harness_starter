import { readFile } from "fs/promises";
import { join } from "path";
import type { GuidanceRule, PolicyBundle, RiskClass, ToolClass, TaskIntent, RuleManifest } from "./types";

export interface CompilerOptions {
  rootPath?: string;    // default: process.cwd() + "/CLAUDE.md"
  localPath?: string;   // default: process.cwd() + "/CLAUDE.local.md"
}

// ── djb2 hash ─────────────────────────────────────────────────────────────────

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // uint32
  }
  return hash.toString(16);
}

// ── Constitution section detection ────────────────────────────────────────────

const CONSTITUTION_SECTIONS = [
  /^##\s+core\s+principles/i,
  /^##\s+constitution/i,
  /^##\s+non-negotiable/i,
];

function isConstitutionSection(sectionHeader: string): boolean {
  return CONSTITUTION_SECTIONS.some((re) => re.test(sectionHeader));
}

// ── Pattern extractors ────────────────────────────────────────────────────────

const EXPLICIT_RULE_ID_RE = /(?:^|\s)(?:\[?(R\d{3})\]?|RULE-(\d{3}):?|-\s*\[(R\d{3})\])/;

function extractRuleId(line: string): string | null {
  const m = line.match(EXPLICIT_RULE_ID_RE);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  if (!raw) return null;
  // Normalise: "001" → "R001", "R001" → "R001"
  return raw.startsWith("R") ? raw : `R${raw}`;
}

const RISK_PATTERNS: Array<{ re: RegExp; risk: RiskClass }> = [
  { re: /\(critical\)|\[critical\]|critical[-\s]risk/i, risk: "critical" },
  { re: /\(high\)|\[high[-\s]?risk\]|\[high\]|high[-\s]risk/i, risk: "high" },
  { re: /\(medium\)|\[medium\]|medium[-\s]risk/i, risk: "medium" },
  { re: /\(low\)|\[low\]|low[-\s]risk/i, risk: "low" },
  { re: /\(info\)|\[info\]/i, risk: "info" },
];

function extractRisk(line: string): RiskClass {
  for (const { re, risk } of RISK_PATTERNS) {
    if (re.test(line)) return risk;
  }
  return "medium"; // default
}

const TOOL_CLASS_RE = /\[(edit|bash|read|write|mcp|task|all)\]/gi;

function extractToolClasses(line: string): ToolClass[] {
  const found = new Set<ToolClass>();
  let m: RegExpExecArray | null;
  const re = new RegExp(TOOL_CLASS_RE.source, "gi");
  while ((m = re.exec(line)) !== null) {
    found.add(m[1].toLowerCase() as ToolClass);
  }
  return found.size > 0 ? [...found] : ["all"];
}

const INTENT_RE = /#(bug-fix|feature|refactor|security|performance|testing|docs|deployment|general)\b/gi;

function extractIntents(line: string): TaskIntent[] {
  const found = new Set<TaskIntent>();
  let m: RegExpExecArray | null;
  const re = new RegExp(INTENT_RE.source, "gi");
  while ((m = re.exec(line)) !== null) {
    found.add(m[1].toLowerCase() as TaskIntent);
  }
  return [...found];
}

const DOMAIN_RE = /@(security|testing|performance|database|auth|api|[a-z][a-z0-9-]*)\b/gi;

function extractDomains(line: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(DOMAIN_RE.source, "gi");
  while ((m = re.exec(line)) !== null) {
    found.add(`@${m[1].toLowerCase()}`);
  }
  return [...found];
}

const VERIFIER_RE = /verify:(tests-pass|lint-clean|type-check)/i;

function extractVerifier(line: string): string | undefined {
  const m = line.match(VERIFIER_RE);
  return m ? m[1] : undefined;
}

const PRIORITY_RE = /priority:(\d+)/i;

function extractPriority(line: string): number {
  const m = line.match(PRIORITY_RE);
  if (!m) return 5;
  const n = parseInt(m[1], 10);
  return Math.min(10, Math.max(1, n));
}

// ── Keyword-based intent/domain inference ─────────────────────────────────────

function inferIntentsAndDomains(
  line: string,
  explicit: { intents: TaskIntent[]; domains: string[] }
): { intents: TaskIntent[]; domains: string[] } {
  const intents = new Set<TaskIntent>(explicit.intents);
  const domains = new Set<string>(explicit.domains);
  const lower = line.toLowerCase();

  if (/\btest(s|ing)?\b|spec\b|coverage\b/.test(lower)) intents.add("testing");
  if (/\bsecurity\b|\bauth(en|or)?\b|\btoken\b/.test(lower)) {
    intents.add("security");
    domains.add("@security");
  }
  if (/\bdatabase\b|\bsql\b|\bquery\b/.test(lower)) domains.add("@database");
  if (/\bapi\b|\bendpoint\b|\broute\b/.test(lower)) domains.add("@api");

  return { intents: [...intents], domains: [...domains] };
}

// ── Action-verb detection for implicit rules ──────────────────────────────────

const ACTION_VERBS_RE = /\b(always|never|must|should|do not|avoid|ensure|require|forbid|prohibit)\b/i;

function isBulletWithActionVerb(line: string): boolean {
  return /^[-*]\s+/.test(line) && ACTION_VERBS_RE.test(line);
}

// ── Main compiler ─────────────────────────────────────────────────────────────

export async function compileGuidance(options?: CompilerOptions): Promise<PolicyBundle> {
  const cwd = process.cwd();
  const rootPath = options?.rootPath ?? join(cwd, "CLAUDE.md");
  const localPath = options?.localPath ?? join(cwd, "CLAUDE.local.md");

  const sourceFiles: string[] = [];
  const rules: GuidanceRule[] = [];
  let implCounter = 0;

  async function parseFile(filePath: string, source: "root" | "local"): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      // File is optional (local) or missing (root) — return empty
      return;
    }
    sourceFiles.push(filePath);

    const lines = content.split(/\r?\n/);
    let inConstitutionSection = false;
    let currentSectionHeader = "";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Track section headers
      if (/^#{1,3}\s+/.test(line)) {
        currentSectionHeader = line;
        inConstitutionSection = isConstitutionSection(line);
        continue;
      }

      // Skip blank lines and non-rule lines
      if (!line) continue;

      const explicitId = extractRuleId(line);

      if (explicitId) {
        // Explicit rule line
        const risk = extractRisk(line);
        const toolClasses = extractToolClasses(line);
        const intents = extractIntents(line);
        const domains = extractDomains(line);
        const inferred = inferIntentsAndDomains(line, { intents, domains });
        const verifier = extractVerifier(line);
        const priority = extractPriority(line);
        const isConstitution =
          inConstitutionSection || risk === "critical";

        rules.push({
          id: explicitId,
          text: line,
          riskClass: risk,
          toolClasses,
          intents: inferred.intents,
          domains: inferred.domains,
          priority,
          source,
          isConstitution,
          verifier,
        });
      } else if (isBulletWithActionVerb(line)) {
        // Implicit rule from bullet
        implCounter++;
        const id = `IMPL-${String(implCounter).padStart(3, "0")}`;
        const risk = extractRisk(line);
        const toolClasses = extractToolClasses(line);
        const intents = extractIntents(line);
        const domains = extractDomains(line);
        const inferred = inferIntentsAndDomains(line, { intents, domains });
        const verifier = extractVerifier(line);
        const priority = extractPriority(line);
        const isConstitution =
          inConstitutionSection || risk === "critical";

        rules.push({
          id,
          text: line,
          riskClass: risk,
          toolClasses,
          intents: inferred.intents,
          domains: inferred.domains,
          priority,
          source,
          isConstitution,
          verifier,
        });
      }
      // Non-rule lines are ignored
    }
  }

  await parseFile(rootPath, "root");
  await parseFile(localPath, "local");

  // Build manifest
  const byRisk: Record<RiskClass, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byDomain: Record<string, number> = {};
  const criticalRuleIds: string[] = [];

  for (const rule of rules) {
    byRisk[rule.riskClass] = (byRisk[rule.riskClass] ?? 0) + 1;
    for (const domain of rule.domains) {
      byDomain[domain] = (byDomain[domain] ?? 0) + 1;
    }
    if (rule.riskClass === "critical") criticalRuleIds.push(rule.id);
  }

  const manifest: RuleManifest = {
    totalRules: rules.length,
    byRisk,
    byDomain,
    criticalRuleIds,
  };

  const constitutionRules = rules.filter((r) => r.isConstitution);
  const hash = djb2(rules.map((r) => r.text).join("\n"));

  return {
    rules,
    constitutionRules,
    manifest,
    sourceFiles,
    compiledAt: new Date(),
    hash,
  };
}
