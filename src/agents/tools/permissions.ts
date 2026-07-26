/**
 * Tool permission system — per-agent tool access control.
 *
 * Defines which agents are allowed to use which tools, independently of the
 * security policy (which enforces at execution time). Permissions are checked
 * when the harness resolves tools for an agent: non-permitted tools are simply
 * not provided to the model, so it can't even attempt to call them.
 *
 * Usage:
 *   const permissions = createToolPermissions()
 *     .allow("researcher",  ["web_search", "browser_scrape"])
 *     .allow("coder",       ["sandbox_run_code", "shell_exec"])
 *     .allow("*",           ["get_current_time"])  // all agents
 *     .deny("coder",        ["db_delete"])
 *     .build();
 *
 *   const tools = permissions.resolve("researcher", getAllTools());
 */

import type { ToolDefinition } from "./types";

export interface ToolPermissionRule {
  /** Agent name, or "*" for all agents. */
  agent: string;
  /** Tool names covered by this rule. */
  tools: string[];
  /** "allow" grants access; "deny" blocks it (deny takes precedence). */
  effect: "allow" | "deny";
}

export interface ToolPermissionSet {
  /** Resolve the list of tools available to a given agent. */
  resolve(agentName: string, allTools: ToolDefinition[]): ToolDefinition[];
  /** Check if a specific agent can use a specific tool. */
  canUse(agentName: string, toolName: string): boolean;
}

class ToolPermissions implements ToolPermissionSet {
  constructor(private readonly rules: ToolPermissionRule[]) {}

  canUse(agentName: string, toolName: string): boolean {
    let allowed = false;

    for (const rule of this.rules) {
      if (rule.agent !== "*" && rule.agent !== agentName) continue;
      if (!rule.tools.includes(toolName)) continue;
      if (rule.effect === "deny") return false;
      if (rule.effect === "allow") allowed = true;
    }

    return allowed;
  }

  resolve(agentName: string, allTools: ToolDefinition[]): ToolDefinition[] {
    return allTools.filter((tool) => this.canUse(agentName, tool.name));
  }
}

export class ToolPermissionsBuilder {
  private readonly rules: ToolPermissionRule[] = [];

  allow(agent: string, tools: string[]): this {
    this.rules.push({ agent, tools, effect: "allow" });
    return this;
  }

  deny(agent: string, tools: string[]): this {
    this.rules.push({ agent, tools, effect: "deny" });
    return this;
  }

  build(): ToolPermissionSet {
    return new ToolPermissions([...this.rules]);
  }
}

export function createToolPermissions(): ToolPermissionsBuilder {
  return new ToolPermissionsBuilder();
}
