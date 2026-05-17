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

export type ThreatType =
  | "instruction_override"
  | "role_switch"
  | "jailbreak"
  | "fake_system"
  | "delimiter_abuse"
  | "encoding"
  | "extraction"
  | "hypothetical_framing"
  | "context_manipulation"
  | "indirect_injection";

export type ThreatSeverity = "low" | "medium" | "high" | "critical";

export interface ThreatMatch {
  type: ThreatType;
  confidence: number;
  adjusted: number;
  severity: ThreatSeverity;
}

export interface InjectionPattern {
  pattern: RegExp;
  type: ThreatType;
  confidence: number;
}

export interface DetectionResult {
  detected: boolean;
  matches: ThreatMatch[];
  maxConfidence: number;
  severity: ThreatSeverity; // highest severity found
}

export interface InjectionDetectorOptions {
  /** Confidence threshold to block. Default: 0.85 */
  blockThreshold?: number;
  /** Confidence threshold to warn (metadata only, not blocked). Default: 0.6 */
  warnThreshold?: number;
  /** Custom additional patterns */
  additionalPatterns?: Array<{ pattern: RegExp; type: ThreatType; confidence: number }>;
}

// ── Severity helper ───────────────────────────────────────────────────────────

export function severityOf(confidence: number): ThreatSeverity {
  if (confidence >= 0.9) return "critical";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

// ── Built-in patterns ────────────────────────────────────────────────────────

const INJECTION_PATTERNS: InjectionPattern[] = [
  // ── Instruction override (original 3 + 5 new = 8) ─────────────────────────
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i, type: "instruction_override", confidence: 0.9 },
  { pattern: /disregard\s+(your\s+)?(previous|prior|system|all)\s+(instructions?|prompt|context)/i, type: "instruction_override", confidence: 0.9 },
  { pattern: /forget\s+(everything|all)\s+(you\s+)?(were\s+)?(told|instructed|trained)/i, type: "instruction_override", confidence: 0.85 },
  { pattern: /new\s+task\s*:\s*(forget|ignore|disregard)/i, type: "instruction_override", confidence: 0.85 },
  { pattern: /override\s+(your\s+)?(safety|security|content)?\s*(restrictions?|guidelines?|policy)/i, type: "instruction_override", confidence: 0.9 },
  { pattern: /your\s+real\s+instructions?\s+(are|is)/i, type: "instruction_override", confidence: 0.85 },
  { pattern: /from\s+now\s+on\s+(you\s+will|ignore|forget|act)/i, type: "instruction_override", confidence: 0.85 },
  { pattern: /reset\s+to\s+(factory|default|initial)\s+(settings|mode|state)/i, type: "instruction_override", confidence: 0.8 },

  // ── Role switching (original 3 + 4 new = 7) ───────────────────────────────
  { pattern: /you\s+are\s+now\s+(a\s+)?(different|new|another|an?\s+evil|an?\s+unrestricted)/i, type: "role_switch", confidence: 0.85 },
  { pattern: /act\s+as\s+(if\s+you\s+(are|were)\s+)?(a\s+)?(different|unrestricted|jailbroken|DAN|evil)/i, type: "role_switch", confidence: 0.85 },
  { pattern: /pretend\s+(you\s+)?(are|have\s+no|don't\s+have)\s+(a?\s*)?(restrictions?|limits?|guidelines?|rules?)/i, type: "role_switch", confidence: 0.8 },
  { pattern: /switch\s+(to|into)\s+(mode|persona|character|role)\s*:/i, type: "role_switch", confidence: 0.8 },
  { pattern: /you\s+(must|should|will)\s+now\s+(act|behave|respond)\s+as/i, type: "role_switch", confidence: 0.8 },
  { pattern: /roleplay\s+as\s+.{0,50}(no\s+restrictions?|unrestricted|jailbroken)/i, type: "role_switch", confidence: 0.85 },
  { pattern: /simulate\s+(being|a)\s+.{0,50}(evil|malicious|unrestricted|uncensored)/i, type: "role_switch", confidence: 0.85 },

  // ── Jailbreak modes (original 4 + 6 new = 10) ────────────────────────────
  { pattern: /\bDAN\b.*\bdo\s+anything\s+now\b/i, type: "jailbreak", confidence: 0.95 },
  { pattern: /developer\s+mode\s+(enabled|activated|on)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /jailbreak(ed|ing)?\s+(mode|prompt|this)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /\[JAILBREAK\]|\[DAN\]|\[UNRESTRICTED\]/i, type: "jailbreak", confidence: 0.95 },
  { pattern: /\bAIM\b.*\bAlways\s+Intelligent\s+and\s+Machiavellian\b/i, type: "jailbreak", confidence: 0.95 },
  { pattern: /\bSDA\b.*\bSelf\s+Destructive\s+Agent\b/i, type: "jailbreak", confidence: 0.95 },
  { pattern: /token\s+budget\s+(bypass|override|exceeded|unlimited)/i, type: "jailbreak", confidence: 0.85 },
  { pattern: /safe\s+mode\s*(disabled|off|bypassed)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /content\s+(filter|policy|guard)\s*(bypass|disabled|removed|off)/i, type: "jailbreak", confidence: 0.9 },
  { pattern: /you\s+are\s+now\s+in\s+.{0,30}\s+mode/i, type: "jailbreak", confidence: 0.8 },

  // ── Fake system messages (original 3 + 4 new = 7) ─────────────────────────
  { pattern: /\[system\]\s*:/i, type: "fake_system", confidence: 0.8 },
  { pattern: /<\|system\|>|<system>.*<\/system>/i, type: "fake_system", confidence: 0.85 },
  { pattern: /system\s+prompt\s*:\s*you\s+are/i, type: "fake_system", confidence: 0.85 },
  { pattern: /\[INST\].*\[\/INST\]/is, type: "fake_system", confidence: 0.8 },
  { pattern: /<\|im_start\|>system/i, type: "fake_system", confidence: 0.9 },
  { pattern: /###\s*(Human|System|Assistant)\s*:/i, type: "fake_system", confidence: 0.75 },
  { pattern: /SYSTEM:\s+You\s+are\s+(now\s+)?(a\s+)?/i, type: "fake_system", confidence: 0.85 },

  // ── Delimiter abuse (original 2, unchanged) ───────────────────────────────
  { pattern: /```\s*\n.*ignore.*instructions/is, type: "delimiter_abuse", confidence: 0.75 },
  { pattern: /---+\s*\n.*new\s+(instructions?|task|objective)/i, type: "delimiter_abuse", confidence: 0.75 },

  // ── Encoding attacks (original 2 + 4 new = 6) ────────────────────────────
  { pattern: /base64\s*:\s*[A-Za-z0-9+/]{20,}={0,2}/i, type: "encoding", confidence: 0.7 },
  { pattern: /decode\s+this\s+and\s+(follow|execute|run)/i, type: "encoding", confidence: 0.8 },
  { pattern: /\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){4,}/i, type: "encoding", confidence: 0.75 },
  { pattern: /rot13\s*[:({]\s*[a-zA-Z]/i, type: "encoding", confidence: 0.75 },
  { pattern: /(%[0-9a-f]{2}){5,}/i, type: "encoding", confidence: 0.7 },
  { pattern: /atob\s*\(\s*['"][A-Za-z0-9+/]{20,}/i, type: "encoding", confidence: 0.85 },

  // ── Prompt extraction (original 2 + 4 new = 6) ───────────────────────────
  { pattern: /repeat\s+(your\s+)?(system\s+)?prompt\s+(word\s+for\s+word|verbatim|exactly)/i, type: "extraction", confidence: 0.85 },
  { pattern: /what\s+(is|are|was)\s+your\s+(original\s+)?(system\s+prompt|instructions?|initial\s+prompt)/i, type: "extraction", confidence: 0.75 },
  { pattern: /print\s+(your\s+)?(system\s+)?prompt\s*(verbatim|exactly|in\s+full)?/i, type: "extraction", confidence: 0.85 },
  { pattern: /output\s+(your\s+)?(system\s+message|initial\s+instructions?|context\s+window)/i, type: "extraction", confidence: 0.85 },
  { pattern: /reveal\s+(your|the)\s+(system|hidden|original)\s+(prompt|instructions?|rules?)/i, type: "extraction", confidence: 0.9 },
  { pattern: /show\s+me\s+(your\s+)?(full\s+)?(prompt|instructions?|training\s+data)/i, type: "extraction", confidence: 0.75 },

  // ── Hypothetical framing (new category, 5 patterns) ──────────────────────
  { pattern: /hypothetically\s+(speaking|if|suppose)\s*,?\s*(you\s+could|what\s+would)/i, type: "hypothetical_framing", confidence: 0.65 },
  { pattern: /in\s+a\s+(fictional|hypothetical|creative)\s+(scenario|story|world)\s*,?\s*(how|what|explain)/i, type: "hypothetical_framing", confidence: 0.65 },
  { pattern: /for\s+(educational|research|academic)\s+(purposes?|reasons?)\s*(only\s*)?,?\s*(explain|show|demonstrate)/i, type: "hypothetical_framing", confidence: 0.65 },
  { pattern: /imagine\s+(you\s+are|you're|you\s+were)\s+an?\s+AI\s+(without|that\s+has\s+no)/i, type: "hypothetical_framing", confidence: 0.75 },
  { pattern: /\bwhat\s+if\s+you\s+(had\s+no|didn't\s+have|could\s+bypass)\s+(restrictions?|limits?|ethics)/i, type: "hypothetical_framing", confidence: 0.75 },

  // ── Context manipulation (new category, 4 patterns) ──────────────────────
  { pattern: /the\s+(above|previous|following)\s+(text|instructions?|context)\s+(is|are)\s+(fake|fictional|a\s+test)/i, type: "context_manipulation", confidence: 0.75 },
  { pattern: /ignore\s+(the\s+)?context\s+(above|below|provided)/i, type: "context_manipulation", confidence: 0.85 },
  { pattern: /the\s+real\s+(task|objective|goal)\s+(is|was|will\s+be)/i, type: "context_manipulation", confidence: 0.8 },
  { pattern: /everything\s+(above|before)\s+this\s+(line|point)\s+(is\s+)?(fake|wrong|invalid|a\s+test)/i, type: "context_manipulation", confidence: 0.8 },

  // ── Indirect injection (new category, 4 patterns) ────────────────────────
  { pattern: /STOP[.\s]*IGNORE[.\s]*PREVIOUS/i, type: "indirect_injection", confidence: 0.9 },
  { pattern: /\[HIDDEN\s+INSTRUCTION\]/i, type: "indirect_injection", confidence: 0.95 },
  { pattern: /<!--\s*(ignore|system|instruction)/i, type: "indirect_injection", confidence: 0.85 },
  { pattern: /\/\*\s*(ignore|system|new\s+task|instruction)/i, type: "indirect_injection", confidence: 0.85 },
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
  const rawMatches: Array<{ type: ThreatType; confidence: number; matchStart: number }> = [];

  for (const { pattern, type, confidence } of patterns) {
    const match = pattern.exec(input);
    if (match) {
      rawMatches.push({ type, confidence, matchStart: match.index ?? 0 });
    }
  }

  if (rawMatches.length === 0) {
    return { detected: false, matches: [], maxConfidence: 0, severity: "low" };
  }

  const totalMatches = rawMatches.length;
  const adjustedMatches: ThreatMatch[] = rawMatches.map((m, i) => {
    const adjusted = adjustConfidence(m.confidence, i, totalMatches, input, m.matchStart);
    return {
      type: m.type,
      confidence: m.confidence,
      adjusted,
      severity: severityOf(adjusted),
    };
  });

  const maxConfidence = Math.max(...adjustedMatches.map((m) => m.adjusted));
  const severity = severityOf(maxConfidence);

  return {
    detected: true,
    matches: adjustedMatches,
    maxConfidence,
    severity,
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
          `Prompt injection detected (confidence ${highestMatch.adjusted.toFixed(2)}, severity: ${result.severity}). ` +
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
            severity: result.severity,
            matches: result.matches,
          };
        }
      }

      return input;
    },
  };
}
