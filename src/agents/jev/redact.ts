/**
 * Zero-RTT secret / PII redaction before anything reaches Qwen or TypeSafe.
 *
 * Harvest, compact threads, and tool results used to copy stdout into
 * jevEvidence and the system prompt. System One `state` used to leave the
 * box with the same keys so Jev could score `secret_leak`. Code now redacts
 * first, labels locally, and forces those nouls — TypeSafe never sees the
 * raw blob.
 */

import type { JevAnswers, JevQuestions, JevState, PolicyDecision, SystemOneRequest } from "./types";

const PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bgh[pours]_[A-Za-z0-9]{36,}\b/g, label: "API_KEY" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: "AWS_KEY" },
  { pattern: /\bASIA[A-Z0-9]{16}\b/g, label: "AWS_KEY" },
  { pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/g, label: "SECRET" },
  { pattern: /\bxai-[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bdop_v1_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bshpat_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\brk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bxox[baprse]-[A-Za-z0-9-]{20,}\b/g, label: "SLACK_TOKEN" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "TOKEN" },
  { pattern: /\bAIza[A-Za-z0-9_-]{35,}\b/g, label: "API_KEY" },
  { pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, label: "PRIVATE_KEY" },
  { pattern: /\b(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s]+:[^\s]+@[^\s]+/gi, label: "CONNECTION_STRING" },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "EMAIL" },
  { pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/g, label: "CREDIT_CARD" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, label: "SSN" },
  { pattern: /\bpassword\s*[=:]\s*[^\s]{8,}/gi, label: "PASSWORD" },
  { pattern: /\bsecret\s*[=:]\s*[^\s]{8,}/gi, label: "SECRET" },
  { pattern: /\btoken\s*[=:]\s*[^\s]{20,}/gi, label: "TOKEN" },
  {
    pattern: /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*[=:]\s*(?!\[[A-Z_]+\])\S+/g,
    label: "SECRET",
  },
];

/** Labels that fail-close locally. EMAIL is PII but not a credential dump. SSN is. */
export const SEVERE_SECRET_LABELS = new Set([
  "API_KEY",
  "AWS_KEY",
  "SLACK_TOKEN",
  "PRIVATE_KEY",
  "CONNECTION_STRING",
  "CREDIT_CARD",
  "SSN",
  "PASSWORD",
  "SECRET",
  "TOKEN",
]);

const SECRET_NOUL_IDS = new Set(["secret_leak", "leaks_secret"]);

export interface SanitizeJevRequest {
  request: SystemOneRequest;
  labels: string[];
  severe: boolean;
}

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let next = text;
  let redacted = false;
  for (const { pattern, label } of PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(next)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;
    next = next.replace(pattern, `[${label}]`);
    pattern.lastIndex = 0;
    redacted = true;
  }
  return { text: next, redacted };
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (typeof value === "string") return redactSecrets(value).text;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function secretLabels(text: string): string[] {
  const found = new Set<string>();
  for (const { pattern, label } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.add(label);
    pattern.lastIndex = 0;
  }
  return [...found];
}

export function collectSecretLabels(value: unknown, depth = 0): string[] {
  const found = new Set<string>();
  walkLabels(value, depth, found);
  return [...found];
}

function walkLabels(value: unknown, depth: number, found: Set<string>): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    for (const label of secretLabels(value)) found.add(label);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkLabels(item, depth + 1, found);
    return;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      walkLabels(child, depth + 1, found);
    }
  }
}

export function hasSevereSecret(value: unknown): boolean {
  return collectSecretLabels(value).some((label) => SEVERE_SECRET_LABELS.has(label));
}

export function localSecretBlock(node: string): PolicyDecision {
  return { action: "block", value: "secret", reason: "leaks-secret-local", node };
}

export function overlayLocalSecretAnswers(
  questions: JevQuestions,
  answers: JevAnswers,
  severe: boolean
): JevAnswers {
  if (!severe) return answers;
  const next = { ...answers };
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul" && SECRET_NOUL_IDS.has(id)) {
      next[id] = { type: "noul", noul: 1 };
    }
  }
  return next;
}

export function sanitizeJevRequest(request: SystemOneRequest): SanitizeJevRequest {
  const labels = collectSecretLabels(request.state);
  return {
    request: {
      ...request,
      state: redactValue(request.state) as JevState,
    },
    labels,
    severe: labels.some((label) => SEVERE_SECRET_LABELS.has(label)),
  };
}

export interface RedactStream {
  push(chunk: string): string;
  flush(): string;
}

/** Persist / stream exception text without leaking a raw key. */
export function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).text;
}

/** Hold a short tail so a key split across SSE deltas is still redacted. */
export function createRedactStream(hold = 64): RedactStream {
  const keep = Math.max(64, hold);
  let carry = "";
  return {
    push(chunk: string): string {
      const combined = carry + chunk;
      if (combined.length <= keep) {
        carry = combined;
        return "";
      }
      const flush = combined.slice(0, combined.length - keep);
      carry = combined.slice(combined.length - keep);
      return redactSecrets(flush).text;
    },
    flush(): string {
      const out = redactSecrets(carry).text;
      carry = "";
      return out;
    },
  };
}
