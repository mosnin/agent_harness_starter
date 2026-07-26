export interface AgentsMdConfig {
  name: string;
  description: string;
  version?: string;
  skills?: string[];          // skill names from the harness skill registry
  tools?: string[];           // tool names
  model?: string;             // e.g. "claude-opus-4-7"
  systemPrompt?: string;
  autonomy?: "manual" | "assisted" | "supervised" | "full";
  maxTurns?: number;
  requireApprovalFor?: string[];
  metadata?: Record<string, unknown>;
}

export interface SkillMarkdown {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  tools: string[];
  parameters?: Array<{ name: string; type: string; description: string; required: boolean }>;
}

export interface CodexTomlConfig {
  agent: {
    name: string;
    model: string;
    max_turns: number;
  };
  tools: Array<{ name: string; enabled: boolean }>;
  skills: Array<{ name: string }>;
  safety: {
    require_approval_for: string[];
    autonomy: string;
  };
}

export interface MigrationResult {
  sourceFormat: "claude-md" | "openai-agents" | "unknown";
  agentsMd: string;           // generated AGENTS.md content
  warnings: string[];
  rulesPreserved: number;
}
