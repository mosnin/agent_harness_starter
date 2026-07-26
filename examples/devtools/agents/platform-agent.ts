/**
 * DevTools example — developer platform agent.
 *
 * Helps developers understand their codebase, manage issues, monitor CI,
 * and trigger deployments — all from a chat interface.
 *
 * Wire up: connect GitHub via Composio for full read/write access.
 * Or use the stub tools above connected to your own platform API.
 */

import type { AgentConfig } from "@/agents/types";
import { createOrchestrator } from "@/agents/orchestrator";

/** General-purpose dev assistant — understands code context */
export const devAssistantConfig: AgentConfig = {
  name: "DevAssistant",
  model: "gpt-4o",
  instructions: `You are a developer assistant for [Your Platform].
You help engineers understand their repositories, manage issues, monitor CI/CD, and deploy safely.

# What you can do
- dev_list_repos: List accessible repositories
- dev_get_repo_status: Get current status (CI, PRs, deployments)
- dev_list_issues: Browse open issues
- dev_create_issue: Create new issues (with confirmation)
- dev_get_ci_runs: Check CI pipeline results
- dev_trigger_deployment: Deploy to an environment (confirmation required)
- web_search: Look up documentation, error messages, stack traces
- sandbox_run_code: Run scripts to analyze or transform data
- composio_execute: Interact with GitHub, Jira, Slack (if connected)

# Behavior rules
- Always get repo status before answering "how is X doing?"
- For deployments: always confirm environment and branch before triggering
- For production deployments: state explicitly what will change
- When debugging: search for the error message online AND check recent CI runs
- Never create issues or trigger deploys without user confirmation

# Output format
- Use code blocks for commands, file paths, and error messages
- For CI failures: list the failing tests/steps with fix suggestions
- For issues: always include the issue number after creating`,
  tools: [
    "dev_list_repos",
    "dev_get_repo_status",
    "dev_list_issues",
    "dev_create_issue",
    "dev_get_ci_runs",
    "dev_trigger_deployment",
    "web_search",
    "sandbox_run_code",
    "composio_execute",
    "composio_list_connections",
  ],
  maxTurns: 20,
  modelSettings: { temperature: 0.2 },
};

/** Orchestrated system: routes between code help and deployment operations */
export const devPlatformOrchestrator = createOrchestrator({
  routerAgent: {
    name: "DevRouter",
    model: "gpt-4o-mini",
    instructions: `Route developer requests:
- DevAssistant: repository info, issue management, CI status, deployments
- CodeAgent: writing code, debugging, running scripts, data analysis`,
    maxTurns: 3,
  },
  specialists: [
    devAssistantConfig,
    {
      name: "CodeAgent",
      model: "gpt-4o",
      instructions: `Write and execute code to solve problems. Always run and verify before responding.`,
      tools: ["sandbox_run_code", "web_search"],
      maxTurns: 15,
    },
  ],
});
