/**
 * Prompt injection and jailbreak detection guardrail.
 *
 * Detects adversarial inputs that attempt to override instructions, switch
 * the agent's role, trigger jailbreak modes, inject fake system messages,
 * abuse delimiters, use encoding tricks, or extract system prompts.
 *
 * Usage:
 *   withGuardrails({ input: [promptInjectionGuardrail()] })
 */

import type { InputGuardrail, GuardrailContext } from "./types";
import { GuardrailBlockError } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface InjectionPattern {
  pattern: RegExp;
  type: string;
  confidence: number;
}

export interface DetectionResult {
  detected: boolean;
  matches: Array<{ type: string; confidence: number; adjusted: number }>;
  maxConfidence: number;
}

export interface InjectionDetectorOptions {
  /** Confidence threshold to block. Default: 0.85 */
  blockThreshold?: number;
  /** Confidence threshold to warn (metadata only, not blocked). Default: 0.6 */
  warnThreshold?: number;
  /** Custom additional patterns */
  additionalPatterns?: Array<{ pattern: RegExp; type: string; confidence: number }>;
}

// ── Built-in patterns ────────────────────────────────────────────────────────

const INJECTION_PATTERNS: InjectionPattern[] = [
  // Instruction override
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i, type: "instruction_override", confidence: 0.9 },
  { pattern: /disregard\s+(your\s+)?(previous|prior|system|all)\s+(instructions?|prompt|context)/i, type: "instruction_override", confidence: 0.9 },
  { pattern: /forget\s+(everything|all)\s+(you\s+)?(were\s+)?(told|instructed|trained)/i, type: "instruction_override", confidence: 0.85 },
  // Role switching
  { pattern: /you\s+are\s+now\s+(a\s+)?(different|new|another|an?\s+evil|an?\s+unrestricted)/i, type: "role_switch", confidence: 0.85 },
  { pattern: /act\s+as\s+(if\s+you\s+(are|were)\s+)?(a\s+)?(different|unrestricted|jailbroken|DAN|evil)/i, type: "role_switch", confidence: 0.85 },
  { pattern: /pretend\s+(you\s+)?(are|have\s+no|don't\s+have)\s+(a?\s*)?(restrictions?|limits?|guidelines?|rules?)/i, type: "role_switch", confidence: 0.8 },
  // DAN / jailbreak modes
  { pattern: /\bDAN\b.*\bdo\s+anything\s+now\b/i, type: "jailbreak", confidence: 0.95 },
  { pattern: /developer\s+mode\s+(enabled|activated|on)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /jailbreak(ed|ing)?\s+(mode|prompt|this)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /\[JAILBREAK\]|\[DAN\]|\[UNRESTRICTED\]/i, type: "jailbreak", confidence: 0.95 },
  // Fake system messages
  { pattern: /\[system\]\s*:/i, type: "fake_system", confidence: 0.8 },
  { pattern: /<\|system\|>|<system>.*<\/system>/i, type: "fake_system", confidence: 0.85 },
  { pattern: /system\s+prompt\s*:\s*you\s+are/i, type: "fake_system", confidence: 0.85 },
  // Delimiter abuse
  { pattern: /```\s*\n.*ignore.*instructions/is, type: "delimiter_abuse", confidence: 0.75 },
  { pattern: /---+\s*\n.*new\s+(instructions?|task|objective)/i, type: "delimiter_abuse", confidence: 0.75 },
  // Encoding attacks
  { pattern: /base64\s*:\s*[A-Za-z0-9+/]{20,}={0,2}/i, type: "encoding", confidence: 0.7 },
  { pattern: /decode\s+this\s+and\s+(follow|execute|run)/i, type: "encoding", confidence: 0.8 },
  // Prompt extraction
  { pattern: /repeat\s+(your\s+)?(system\s+)?prompt\s+(word\s+for\s+word|verbatim|exactly)/i, type: "extraction", confidence: 0.85 },
  { pattern: /what\s+(is|are|was)\s+your\s+(original\s+)?(system\s+prompt|instructions?|initial\s+prompt)/i, type: "extraction", confidence: 0.75 },
];

// ── Confidence adjustment ─────────────────────────────────────────────────────

function adjustConfidence(
  base: number,
  matchIndex: number,
  totalMatches: number,
  input: string,
  matchStart: number
): number {
  let conf = base;

  // Multiple pattern matches: add 0.1 per additional match (beyond the first), cap at 1.0
  if (totalMatches > 1) {
    conf += 0.1 * (totalMatches - 1);
  }

  // Short input: lower confidence
  if (input.length < 20) {
    conf *= 0.5;
  }

  // Match near the start of the input (first 50 chars): boost confidence
  if (matchStart < 50) {
    conf += 0.1;
  }

  return Math.min(conf, 1.0);
}

// ── Core detection logic ──────────────────────────────────────────────────────

export function detectInjection(
  input: string,
  patterns: InjectionPattern[]
): DetectionResult {
  const rawMatches: Array<{ type: string; confidence: number; matchStart: number }> = [];

  for (const { pattern, type, confidence } of patterns) {
    const match = pattern.exec(input);
    if (match) {
      rawMatches.push({ type, confidence, matchStart: match.index ?? 0 });
    }
  }

  if (rawMatches.length === 0) {
    return { detected: false, matches: [], maxConfidence: 0 };
  }

  const totalMatches = rawMatches.length;
  const adjustedMatches = rawMatches.map((m, i) => ({
    type: m.type,
    confidence: m.confidence,
    adjusted: adjustConfidence(m.confidence, i, totalMatches, input, m.matchStart),
  }));

  const maxConfidence = Math.max(...adjustedMatches.map((m) => m.adjusted));

  return {
    detected: true,
    matches: adjustedMatches,
    maxConfidence,
  };
}

// ── Guardrail factory ─────────────────────────────────────────────────────────

/**
 * Detect prompt injection, jailbreak attempts, and role-switching attacks.
 * Use as an input guardrail to protect agents from adversarial inputs.
 *
 * @example
 *   withGuardrails({ input: [promptInjectionGuardrail()] })
 */
export function promptInjectionGuardrail(options?: InjectionDetectorOptions): InputGuardrail {
  const blockThreshold = options?.blockThreshold ?? 0.85;
  const warnThreshold = options?.warnThreshold ?? 0.6;
  const allPatterns: InjectionPattern[] = [
    ...INJECTION_PATTERNS,
    ...(options?.additionalPatterns ?? []),
  ];

  return {
    name: "prompt_injection",
    check(input: string, ctx: GuardrailContext): string {
      const result = detectInjection(input, allPatterns);

      if (!result.detected) {
        return input;
      }

      const highestMatch = result.matches.reduce((a, b) =>
        a.adjusted >= b.adjusted ? a : b
      );

      if (highestMatch.adjusted >= blockThreshold) {
        const detectedTypes = [...new Set(result.matches.map((m) => m.type))].join(", ");
        throw new GuardrailBlockError(
          `Prompt injection detected (confidence ${highestMatch.adjusted.toFixed(2)}). ` +
            `Attack type(s): ${detectedTypes}. ` +
            `Rephrase your request without instruction overrides, role-switching, or jailbreak attempts.`,
          "prompt_injection_detected",
          "prompt_injection"
        );
      }

      if (highestMatch.adjusted >= warnThreshold) {
        // Warn: attach detection metadata to context but do not block
        if (ctx.meta) {
          ctx.meta["promptInjectionWarning"] = {
            maxConfidence: result.maxConfidence,
            matches: result.matches,
          };
        }
      }

      return input;
    },
  };
}
