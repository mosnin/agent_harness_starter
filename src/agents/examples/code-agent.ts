/**
 * Example: Code Execution Agent
 *
 * Writes and runs code in an isolated sandbox to solve programming problems.
 * Wire up: set SANDBOX_PROVIDER=daytona and DAYTONA_API_KEY (or modal).
 *
 * Demonstrates:
 *   - Skills-based tool disclosure ("code" skill bundle)
 *   - Tool approval for shell execution (requires human sign-off)
 *   - Guardrails to cap input length
 *
 * Usage:
 *   const harness = createCodeAgent();
 *   const result = await harness.run({ messages: [{ role: "user", content: "Write a Python script that..." }] });
 */

import { createHarness } from "../harness";
import { maxLengthGuardrail } from "../guardrails/index";
import type { AgentConfig } from "../types";

export const codeAgentConfig: AgentConfig = {
  name: "CodeAgent",

  instructions: `You are an expert programmer who can write and execute code to solve problems.

When given a coding task:
1. Think step-by-step about the solution.
2. Write the code, then run it using shell_exec or the sandbox tool to verify it works.
3. Fix any errors iteratively — re-run after each fix.
4. Return the final working code along with its output.

Prefer Python for data tasks, Node.js for web tasks, bash for system tasks.
Always explain what the code does before running it.`,

  // Use "code" skill — exposes shell_exec, file_read, file_write, file_list
  skills: ["code"],

  // Additional explicit tool (Daytona/Modal remote sandbox)
  tools: ["sandbox_run_code"],

  modelSettings: {
    temperature: 0.1,  // deterministic code generation
    maxTokens: 8192,
  },

  // Shell execution requires human approval before the harness runs it
  requireApprovalFor: ["shell_exec"],

  guardrails: {
    input: [maxLengthGuardrail(16_000)],
  },

  maxTurns: 15,
};

export function createCodeAgent() {
  return createHarness(codeAgentConfig);
}
