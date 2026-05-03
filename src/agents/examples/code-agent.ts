/**
 * Example: Code Execution Agent
 *
 * Writes and runs code in an isolated sandbox to solve programming problems.
 * Wire up: set SANDBOX_PROVIDER=daytona and DAYTONA_API_KEY (or modal).
 *
 * Demonstrates:
 *   - Explicit plugin composition with createCoreHarness
 *   - withGuardrails for input length limiting
 *   - withApprovals for shell execution sign-off
 *   - withObservability for tracing
 *   - Skills-based tool disclosure ("code" skill bundle)
 *
 * Usage:
 *   const harness = createCodeAgent();
 *   const result = await harness.run({ messages: [{ role: "user", content: "Write a Python script that..." }] });
 */

import { createCoreHarness } from "../core";
import { withGuardrails } from "../plugins/guardrails";
import { withApprovals } from "../plugins/approvals";
import { withObservability } from "../plugins/observability";
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

  skills: ["code"],
  tools: ["sandbox_run_code"],

  modelSettings: {
    temperature: 0.1,
    maxTokens: 8192,
  },

  maxTurns: 15,
};

export function createCodeAgent() {
  return createCoreHarness({
    ...codeAgentConfig,
    plugins: [
      // Block requests over 16k chars — prevents prompt injection via massive inputs.
      withGuardrails({
        input: [maxLengthGuardrail(16_000)],
      }),
      // Pause before running shell_exec and wait for human approval.
      // The route handler emits an approval_required SSE event; the frontend
      // displays a confirmation dialog before resuming.
      withApprovals({
        requireApprovalFor: ["shell_exec"],
      }),
      withObservability(),
    ],
  });
}
