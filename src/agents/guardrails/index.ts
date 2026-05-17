/**
 * Built-in guardrails and the runner that applies them.
 *
 * Usage in AgentConfig:
 *   guardrails: {
 *     input: [maxLengthGuardrail(4000), piiSanitizerGuardrail],
 *     output: [blockedKeywordsGuardrail(["confidential", "internal"])],
 *   }
 */

import type { GuardrailContext, GuardrailSet, InputGuardrail, OutputGuardrail } from "./types";
import { GuardrailBlockError, GuardrailHumanReviewError } from "./types";

export { GuardrailBlockError, GuardrailHumanReviewError };
export type { GuardrailContext, GuardrailSet, InputGuardrail, OutputGuardrail } from "./types";

// ── Prompt injection / jailbreak detection ────────────────────────────────────
export { promptInjectionGuardrail, detectInjection, severityOf } from "./injection";
export type { InjectionDetectorOptions, InjectionPattern, DetectionResult } from "./injection";
export type { ThreatType, ThreatSeverity, ThreatMatch } from "./injection";

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
          "input_too_long",
          "max_length"
        );
      }
      return input;
    },
  };
}

// ── PII patterns (shared between sanitizer and detector) ──────────────────────

const PII_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, type: "email" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, type: "ssn" },
  { pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/g, type: "credit_card" },
  { pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, type: "phone" },
  // API keys
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, type: "api_key" },         // OpenAI
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/g, type: "api_key" },         // GitHub PAT
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, type: "api_key" },             // AWS access key
  { pattern: /\bxoxb-[A-Za-z0-9-]{50,}\b/g, type: "api_key" },      // Slack bot token
  // Private key material
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g, type: "private_key" },
  { pattern: /\bpassword\s*[:=]\s*[^\s]{8,}/i, type: "password" },
];

/** Strip or block messages that contain PII patterns. */
export const piiSanitizerGuardrail: InputGuardrail = {
  name: "pii_sanitizer",
  check(input) {
    let result = input;
    for (const { pattern, type } of PII_PATTERNS) {
      // Reset lastIndex for global regexes reused across calls
      pattern.lastIndex = 0;
      const tag = type.toUpperCase();
      result = result.replace(pattern, `[${tag}]`);
      pattern.lastIndex = 0;
    }
    return result;
  },
};

// ── PII detection guardrail (blocks on PII in output) ─────────────────────────

export interface PiiDetectionOptions {
  /** Block if PII detected. Default: true */
  block?: boolean;
  /** Custom additional PII patterns */
  additionalPatterns?: Array<{ pattern: RegExp; type: string }>;
}

export interface PiiDetectionResult {
  found: boolean;
  types: string[];
}

/**
 * Scan text for PII and return which types were found.
 *
 * @param text     The string to scan.
 * @param patterns Optional additional patterns to check (merged with built-ins).
 */
export function detectPII(
  text: string,
  patterns?: Array<{ pattern: RegExp; type: string }>
): PiiDetectionResult {
  const allPatterns = [...PII_PATTERNS, ...(patterns ?? [])];
  const foundTypes = new Set<string>();

  for (const { pattern, type } of allPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      foundTypes.add(type);
    }
    pattern.lastIndex = 0;
  }

  return {
    found: foundTypes.size > 0,
    types: [...foundTypes],
  };
}

/**
 * Block output that contains PII — prevents sensitive data from leaking
 * to callers. Use as an output guardrail.
 *
 * @example
 *   withGuardrails({ output: [piiDetectionGuardrail()] })
 */
export function piiDetectionGuardrail(options?: PiiDetectionOptions): OutputGuardrail {
  const shouldBlock = options?.block ?? true;

  return {
    name: "pii_detection",
    check(output: string): string {
      const result = detectPII(output, options?.additionalPatterns);

      if (result.found && shouldBlock) {
        throw new GuardrailBlockError(
          `Output contains PII and was blocked. Detected type(s): ${result.types.join(", ")}.`,
          "pii_detected_in_output",
          "pii_detection"
        );
      }

      return output;
    },
  };
}

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
        "invalid_json_output",
        "require_json"
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
          "blocked_keyword",
          "blocked_keywords"
        );
      }
      return output;
    },
  };
}

// ── Sensitive file guardrail ──────────────────────────────────────────────────

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env(\.\w+)?/i,
  /\.(pem|key|crt|cer|p12|pfx)/i,
  /id_rsa(\.(pub))?/i,
  /\.ssh\//i,
  /secret/i,
  /password/i,
  /credential/i,
];

/**
 * Block agent responses that attempt to modify sensitive files.
 * Detects: .env, .pem, .key, *secret*, *password*, *credential*, id_rsa, .ssh/
 *
 * @example
 *   withGuardrails({ output: [sensitiveFileGuardrail()] })
 */
export function sensitiveFileGuardrail(options?: { additionalPatterns?: RegExp[] }): OutputGuardrail {
  const allPatterns = [...SENSITIVE_FILE_PATTERNS, ...(options?.additionalPatterns ?? [])];
  return {
    name: "sensitive_file",
    check(output: string): string {
      for (const pattern of allPatterns) {
        if (pattern.test(output)) {
          throw new GuardrailBlockError(
            `Agent response references a sensitive file path (matched: ${pattern}). ` +
              `Do not write, read, or expose sensitive files such as .env, .pem, .key, credential, or secret files.`,
            "sensitive_file_access",
            "sensitive_file"
          );
        }
      }
      return output;
    },
  };
}

// ── Destructive command guardrail ─────────────────────────────────────────────

const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,              // rm -rf / rm -fr etc.
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,     // SQL DROP
  /\bgit\s+reset\s+--hard\b/i,              // git reset --hard
  /\bgit\s+push\s+.*--force\b/i,            // git push --force
  /\bformat\s+c:/i,                         // Windows format c:
  /\bmkfs\b/i,                              // Linux filesystem format
  /\bdd\s+if=\/dev\/zero\b/i,               // dd zero-wipe
  /\bdd\s+if=\/dev\/urandom\b/i,            // dd random-wipe
];

/**
 * Block agent responses containing destructive commands.
 * Detects: rm -rf, DROP TABLE/DATABASE, git reset --hard, git push --force,
 *          format c:, mkfs, dd if=/dev/zero, DROP SCHEMA
 *
 * @example
 *   withGuardrails({ output: [destructiveCommandGuardrail()] })
 */
export function destructiveCommandGuardrail(options?: { additionalPatterns?: RegExp[] }): OutputGuardrail {
  const allPatterns = [...DESTRUCTIVE_COMMAND_PATTERNS, ...(options?.additionalPatterns ?? [])];
  return {
    name: "destructive_command",
    check(output: string): string {
      for (const pattern of allPatterns) {
        if (pattern.test(output)) {
          throw new GuardrailBlockError(
            `Agent response contains a potentially destructive command (matched: ${pattern}). ` +
              `Commands such as 'rm -rf', 'DROP TABLE', 'git reset --hard', 'git push --force', ` +
              `'format c:', 'mkfs', and 'dd if=/dev/zero' are blocked for safety.`,
            "destructive_command_detected",
            "destructive_command"
          );
        }
      }
      return output;
    },
  };
}
