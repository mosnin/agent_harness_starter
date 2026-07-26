import type { AgentsMdConfig, MigrationResult } from "./types";
import { generateAgentsMd } from "./generators";

/** Known tool mention tokens found in CLAUDE.md rule lines. */
const TOOL_TOKENS = ["[bash]", "[edit]", "[read]", "[write]", "[mcp]", "[task]"] as const;

/**
 * Parse a CLAUDE.md file and produce an AGENTS.md-compatible MigrationResult.
 */
export function migrateClaude(claudeMdContent: string): MigrationResult {
  const warnings: string[] = [];
  const lines = claudeMdContent.split("\n");

  // Detect format
  const isClaudeMd =
    /\[R\d{3,}\]/.test(claudeMdContent) || /RULE-/.test(claudeMdContent);
  const sourceFormat: MigrationResult["sourceFormat"] = isClaudeMd ? "claude-md" : "unknown";

  if (sourceFormat === "unknown") {
    warnings.push("Format not recognised as CLAUDE.md — parsed as plain Markdown.");
  }

  // Extract agent name from first H1 heading
  let name = "Agent";
  for (const line of lines) {
    const h1Match = /^#\s+(.+)$/.exec(line.trim());
    if (h1Match) {
      name = h1Match[1].trim();
      break;
    }
  }

  // Extract model
  let model: string | undefined;
  for (const line of lines) {
    const modelMatch = /^model:\s*(.+)$/i.exec(line.trim());
    if (modelMatch) {
      model = modelMatch[1].trim();
      break;
    }
  }

  // Extract tool mentions
  const toolsFound = new Set<string>();
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const token of TOOL_TOKENS) {
      if (lower.includes(token)) {
        // Store without brackets, e.g. "bash", "edit"
        toolsFound.add(token.replace(/^\[|\]$/g, ""));
      }
    }
  }

  // Extract approval requirements: lines with "(critical)" or "requires confirmation"
  const requireApprovalFor: string[] = [];
  let rulesPreserved = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Count any line that looks like a rule
    if (
      /\[R\d{3,}\]/.test(line) ||
      /RULE-/.test(line) ||
      /^-\s+/.test(line.trim())
    ) {
      rulesPreserved++;
    }

    if (lower.includes("(critical)") || lower.includes("requires confirmation")) {
      const cleaned = line
        .replace(/\[R\d{3,}\]/g, "")
        .replace(/RULE-\w+/g, "")
        .replace(/^\s*[-*]\s*/, "")
        .trim();
      if (cleaned) {
        requireApprovalFor.push(cleaned);
      }
    }
  }

  // Warn about sections we couldn't migrate
  const sectionHeadings = lines
    .filter((l) => /^#{2,}\s+/.test(l.trim()))
    .map((l) => l.replace(/^#+\s+/, "").trim());

  const knownSections = new Set([
    "configuration",
    "model",
    "tools",
    "skills",
    "rules",
    "system prompt",
    "approval",
  ]);
  for (const heading of sectionHeadings) {
    if (!knownSections.has(heading.toLowerCase())) {
      warnings.push(`Section "${heading}" could not be migrated automatically.`);
    }
  }

  const agentConfig: AgentsMdConfig = {
    name,
    description: `Migrated from CLAUDE.md (${sourceFormat})`,
    ...(model !== undefined ? { model } : {}),
    tools: toolsFound.size > 0 ? Array.from(toolsFound) : undefined,
    requireApprovalFor: requireApprovalFor.length > 0 ? requireApprovalFor : undefined,
  };

  const agentsMd = generateAgentsMd(agentConfig);

  return {
    sourceFormat,
    agentsMd,
    warnings,
    rulesPreserved,
  };
}

/**
 * Accept a plain object (parsed from an openai-agents config JSON) and produce
 * an AGENTS.md-compatible MigrationResult.
 */
export function migrateOpenAIAgents(openAIConfig: object): MigrationResult {
  const warnings: string[] = [];

  // Cast to a loose record for safe property access
  const cfg = openAIConfig as Record<string, unknown>;

  const name = typeof cfg["name"] === "string" ? cfg["name"] : "Agent";
  const model = typeof cfg["model"] === "string" ? cfg["model"] : undefined;
  const systemPrompt =
    typeof cfg["instructions"] === "string" ? cfg["instructions"] : undefined;

  // Extract tools array
  let tools: string[] | undefined;
  if (Array.isArray(cfg["tools"])) {
    const extracted = (cfg["tools"] as unknown[]).flatMap((t) => {
      if (typeof t === "string") return [t];
      if (t && typeof t === "object") {
        const toolObj = t as Record<string, unknown>;
        if (typeof toolObj["name"] === "string") return [toolObj["name"]];
        if (typeof toolObj["type"] === "string") return [toolObj["type"]];
      }
      return [];
    });
    if (extracted.length > 0) tools = extracted;
  }

  // Warn about unrecognised top-level keys
  const knownKeys = new Set(["name", "model", "instructions", "tools"]);
  for (const key of Object.keys(cfg)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Field "${key}" is not mapped and was skipped.`);
    }
  }

  const agentConfig: AgentsMdConfig = {
    name,
    description: "Migrated from OpenAI Agents config",
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };

  const agentsMd = generateAgentsMd(agentConfig);

  return {
    sourceFormat: "openai-agents",
    agentsMd,
    warnings,
    rulesPreserved: 0,
  };
}
