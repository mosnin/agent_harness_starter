/**
 * Example: Code Execution Agent
 *
 * Writes and runs code in an isolated sandbox to solve programming problems.
 * Wire up: set SANDBOX_PROVIDER=daytona and DAYTONA_API_KEY (or modal).
 *
 * Usage:
 *   const harness = createCodeAgent();
 *   const result = await harness.run({ messages: [{ role: "user", content: "Write a Python script that..." }] });
 */

import { createHarness } from "../harness";
import type { AgentConfig } from "../types";

export const codeAgentConfig: AgentConfig = {
  name: "CodeAgent",
  instructions: `You are an expert programmer who can write and execute code to solve problems.

When given a coding task:
1. Think step-by-step about the solution.
2. Write the code and run it using sandbox_run_code to verify it works.
3. Fix any errors iteratively — re-run after each fix.
4. Return the final working code along with its output.

Prefer Python for data tasks, Node.js for web tasks, and bash for system tasks.
Always explain what the code does before running it.`,
  tools: ["sandbox_run_code", "web_search"],
  maxTurns: 15,
};

export function createCodeAgent() {
  return createHarness(codeAgentConfig);
}
