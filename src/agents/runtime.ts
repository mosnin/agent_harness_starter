/**
 * Runtime validation and discovery utilities.
 * Call validateRuntime() at startup to catch configuration problems early.
 */

import { getAllTools } from "./tools/registry";
import { getAllSkills } from "./skills/index";
import type { AgentConfig } from "./types";
import type { SkillDefinition } from "./skills/types";
import type { ToolDefinition } from "./tools/types";

export interface RuntimeValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate agent runtime configuration.
 * Call at app startup to catch missing env vars, misconfigured adapters, etc.
 *
 * @example
 * // In Next.js instrumentation.ts or app startup:
 * const result = validateRuntime({ warnOnInMemory: process.env.NODE_ENV === "production" });
 * if (!result.valid) throw new Error(result.errors.join("\n"));
 * result.warnings.forEach(w => console.warn("[agent-runtime]", w));
 */
export function validateRuntime(options: {
  /** Warn when memory adapter is in-memory (dangerous in serverless). Default: true in production. */
  warnOnInMemory?: boolean;
  /** Require OPENAI_API_KEY to be set. Default: true. */
  requireOpenAIKey?: boolean;
  /** Require AGENT_CAPABILITY_SECRET to be set and ≥32 chars. Default: true. */
  requireCapabilitySecret?: boolean;
  /**
   * Require AGENT_JTI_STORE to be set in production. Default: false.
   * Set to true when token replay prevention must be enforced across all instances.
   * Without a shared store, revocation only applies within the current process.
   */
  requireJtiStore?: boolean;
} = {}): RuntimeValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const {
    warnOnInMemory = process.env.NODE_ENV === "production",
    requireOpenAIKey = true,
    requireCapabilitySecret = true,
    requireJtiStore = false,
  } = options;

  if (requireOpenAIKey && !process.env.OPENAI_API_KEY) {
    errors.push("OPENAI_API_KEY is not set. Agents will fail to run.");
  }

  if (requireCapabilitySecret) {
    const hasRs256 =
      process.env.AGENT_CAPABILITY_PRIVATE_KEY && process.env.AGENT_CAPABILITY_PUBLIC_KEY;
    const secret = process.env.AGENT_CAPABILITY_SECRET;
    if (!hasRs256 && (!secret || secret.length < 32)) {
      errors.push(
        "AGENT_CAPABILITY_SECRET must be set and at least 32 characters long. " +
        "For production: prefer RS256 by setting AGENT_CAPABILITY_PRIVATE_KEY + AGENT_CAPABILITY_PUBLIC_KEY."
      );
    }
  }

  const privateKeyEnv = process.env.AGENT_CAPABILITY_PRIVATE_KEY;
  const publicKeyEnv = process.env.AGENT_CAPABILITY_PUBLIC_KEY;
  if (privateKeyEnv !== undefined && !privateKeyEnv.startsWith("-----BEGIN")) {
    errors.push(
      "AGENT_CAPABILITY_PRIVATE_KEY must be a PEM-encoded private key (-----BEGIN ...)"
    );
  }
  if (publicKeyEnv !== undefined && !publicKeyEnv.startsWith("-----BEGIN")) {
    errors.push(
      "AGENT_CAPABILITY_PUBLIC_KEY must be a PEM-encoded public key (-----BEGIN ...)"
    );
  }

  if (warnOnInMemory) {
    warnings.push(
      "Memory adapter is in-memory (default). State will be lost between serverless invocations. " +
      "Set a persistent adapter with setMemoryAdapter() before handling requests."
    );
  }

  if (!process.env.AGENT_JTI_STORE) {
    const msg =
      "JTI revocation store is in-process — revoked tokens are visible only to this process. " +
      "For multi-instance deployments set AGENT_JTI_STORE=redis and wire a shared store, " +
      "or use short token TTLs (≤5 min) and skip revocation.";
    if (requireJtiStore) {
      errors.push(msg);
    } else if (process.env.NODE_ENV === "production") {
      warnings.push(msg);
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

/**
 * Returns all tools currently registered in the tool registry.
 * Use to discover what tools are available before configuring an agent.
 *
 * @example
 * const tools = getRegisteredTools();
 * console.log(tools.map(t => `${t.name}: ${t.description}`));
 */
export function getRegisteredTools(): ToolDefinition[] {
  return getAllTools();
}

/**
 * Returns all skills currently registered.
 * Use to discover what skill bundles are available.
 */
export function getRegisteredSkills(): SkillDefinition[] {
  return getAllSkills();
}

/**
 * Resolve what tools an agent config will actually have access to.
 * Useful for debugging "why can't my agent call X" issues.
 *
 * @example
 * const tools = resolveAgentAccess({ tools: ["web_search"], skills: ["research"] });
 * console.log("Agent can call:", tools.map(t => t.name));
 */
export function resolveAgentAccess(config: Pick<AgentConfig, "tools" | "skills">): ToolDefinition[] {
  const { resolveAgentTools } = require("./skills/index");
  return resolveAgentTools(config.tools ?? [], config.skills ?? []);
}
