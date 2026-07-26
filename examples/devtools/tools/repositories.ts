/**
 * DevTools example — repository and CI/CD tools.
 *
 * Shows how to expose your dev platform's core concepts as agent tools.
 * Replace stubs with your actual API calls (GitHub, GitLab, or your own platform).
 */

import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

export const listRepositoriesTool = registerTool({
  name: "dev_list_repos",
  description:
    "List repositories the user has access to. Returns repo name, language, last commit, open issues, and CI status.",
  parameters: z.object({
    org: z.string().optional().describe("Filter by organization/owner"),
    language: z.string().optional().describe("Filter by programming language"),
    limit: z.number().int().default(10),
  }),
  async execute({ org, language, limit }, ctx) {
    // Replace with your platform's API
    return { repos: [], userId: ctx.userId };
  },
});

export const getRepoStatusTool = registerTool({
  name: "dev_get_repo_status",
  description:
    "Get the current status of a repository: latest commit, CI build status, open PRs, failing tests, and deployment status.",
  parameters: z.object({
    repo: z.string().describe("Repository name, e.g. 'owner/repo-name'"),
  }),
  async execute({ repo }, ctx) {
    // Replace with your platform's API
    return { repo, status: "unknown" };
  },
});

export const listOpenIssuesTool = registerTool({
  name: "dev_list_issues",
  description:
    "List open issues for a repository. Filter by label, assignee, or priority.",
  parameters: z.object({
    repo: z.string().describe("Repository name"),
    label: z.string().optional().describe("Filter by label, e.g. 'bug', 'enhancement'"),
    assignee: z.string().optional().describe("Filter by assignee username"),
    priority: z.enum(["high", "medium", "low"]).optional(),
    limit: z.number().int().default(10),
  }),
  async execute({ repo, label, assignee, priority, limit }, ctx) {
    // Replace with your platform's GitHub/GitLab API
    return { issues: [], repo };
  },
});

export const createIssueTool = registerTool({
  name: "dev_create_issue",
  description:
    "Create a new issue in a repository. Confirm details with the user before creating.",
  parameters: z.object({
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Issue title"),
    body: z.string().optional().describe("Issue description in Markdown"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    assignees: z.array(z.string()).optional().describe("Usernames to assign"),
  }),
  async execute({ repo, title, body, labels, assignees }, ctx) {
    // Use Composio: composio_execute("GITHUB_CREATE_ISSUE", { owner, repo, title, body, labels, assignees })
    // Or direct GitHub API:
    return { success: true, repo, title, issueNumber: null };
  },
});

export const getCIRunsTool = registerTool({
  name: "dev_get_ci_runs",
  description:
    "Get recent CI/CD pipeline runs for a repository. Shows pass/fail status, duration, and logs summary.",
  parameters: z.object({
    repo: z.string().describe("Repository name"),
    branch: z.string().optional().describe("Filter by branch name"),
    limit: z.number().int().default(5),
  }),
  async execute({ repo, branch, limit }, ctx) {
    // Replace with your CI platform's API (GitHub Actions, CircleCI, etc.)
    return { runs: [], repo };
  },
});

export const triggerDeploymentTool = registerTool({
  name: "dev_trigger_deployment",
  description:
    "Trigger a deployment for a repository. ONLY use when the user explicitly requests a deployment. Always confirm the target environment before proceeding.",
  parameters: z.object({
    repo: z.string().describe("Repository name"),
    environment: z
      .enum(["development", "staging", "production"])
      .describe("Target deployment environment"),
    branch: z.string().default("main").describe("Branch to deploy"),
    message: z.string().optional().describe("Deployment message/notes"),
  }),
  async execute({ repo, environment, branch, message }, ctx) {
    if (environment === "production") {
      // Extra safety check for production deploys
      // Consider requiring a secondary confirmation via your existing auth
    }
    // Replace with your deployment platform's API
    return {
      success: true,
      deploymentId: `deploy-${Date.now()}`,
      repo,
      environment,
      branch,
      message: `Deployment triggered: ${repo} → ${environment} from ${branch}`,
    };
  },
});
