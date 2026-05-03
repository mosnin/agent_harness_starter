/**
 * Built-in guardrails and the runner that applies them.
 *
 * Usage in AgentConfig:
 *   guardrails: {
 *     input: [maxLengthGuardrail(4000), profanityGuardrail],
 *     output: [jsonSchemaGuardrail(mySchema)],
 *   }
 */

import type { GuardrailContext, GuardrailSet, InputGuardrail, OutputGuardrail } from "./types";
import { GuardrailBlockError, GuardrailHumanReviewError } from "./types";

export { GuardrailBlockError, GuardrailHumanReviewError };
export type { GuardrailContext, GuardrailSet, InputGuardrail, OutputGuardrail } from "./types";

/** Run all input guardrails in order. Returns the (possibly modified) input. */
export async function runInputGuardrails(
  input: string,
  guardrails: InputGuardrail[],
  ctx: GuardrailContext
): Promise<string> {
  let current = input;
  for (const g of guardrails) {
    current = await g.check(current, ctx);
  }
  return current;
}

/** Run all output guardrails in order. Returns the (possibly modified) output. */
export async function runOutputGuardrails(
  output: string,
  guardrails: OutputGuardrail[],
  ctx: GuardrailContext
): Promise<string> {
  let current = output;
  for (const g of guardrails) {
    current = await g.check(current, ctx);
  }
  return current;
}

// ── Built-in input guardrails ─────────────────────────────────────────────────

/** Reject requests longer than maxChars characters. */
export function maxLengthGuardrail(maxChars: number): InputGuardrail {
  return {
    name: "max_length",
    check(input) {
      if (input.length > maxChars) {
        throw new GuardrailBlockError(
          `Input exceeds maximum length of ${maxChars} characters.`,
          "input_too_long"
        );
      }
      return input;
    },
  };
}

/** Strip or block messages that contain PII patterns (basic heuristic). */
export const piiSanitizerGuardrail: InputGuardrail = {
  name: "pii_sanitizer",
  check(input) {
    return input
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
      .replace(/\b\d{16}\b/g, "[CARD]")
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]");
  },
};

// ── Built-in output guardrails ────────────────────────────────────────────────

/**
 * Require the output to be valid JSON.
 * Useful for structured data extraction agents.
 */
export const requireJsonOutputGuardrail: OutputGuardrail = {
  name: "require_json",
  check(output) {
    try {
      JSON.parse(output);
      return output;
    } catch {
      throw new GuardrailBlockError(
        "Agent output is not valid JSON.",
        "invalid_json_output"
      );
    }
  },
};

/**
 * Block outputs that contain any of the provided keywords (case-insensitive).
 * Useful for preventing the agent from discussing off-limits topics.
 */
export function blockedKeywordsGuardrail(keywords: string[]): OutputGuardrail {
  const lower = keywords.map((k) => k.toLowerCase());
  return {
    name: "blocked_keywords",
    check(output) {
      const lowerOutput = output.toLowerCase();
      const found = lower.find((k) => lowerOutput.includes(k));
      if (found) {
        throw new GuardrailBlockError(
          `Output contains blocked content: "${found}"`,
          "blocked_keyword"
        );
      }
      return output;
    },
  };
}
