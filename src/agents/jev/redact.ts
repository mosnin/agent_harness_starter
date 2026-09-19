/**
 * Zero-RTT secret / PII redaction before anything reaches Qwen.
 *
 * Harvest, compact threads, and tool results used to copy stdout into
 * jevEvidence and the system prompt. Jev screens drafts, but a leaked key
 * in a tool blob never waited for postflight. Code redacts first.
 */

const PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bsk_test_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/g, label: "API_KEY" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, label: "API_KEY" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, label: "AWS_KEY" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, label: "SLACK_TOKEN" },
  { pattern: /\bAIza[A-Za-z0-9_-]{35,}\b/g, label: "API_KEY" },
  { pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, label: "PRIVATE_KEY" },
  { pattern: /\b(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s]+:[^\s]+@[^\s]+/gi, label: "CONNECTION_STRING" },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "EMAIL" },
  { pattern: /\b(?:\d{4}[- ]?){3}\d{4}\b/g, label: "CREDIT_CARD" },
  { pattern: /\bpassword\s*[=:]\s*[^\s]{8,}/gi, label: "PASSWORD" },
  { pattern: /\bsecret\s*[=:]\s*[^\s]{8,}/gi, label: "SECRET" },
  { pattern: /\btoken\s*[=:]\s*[^\s]{20,}/gi, label: "TOKEN" },
];

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

export interface RedactStream {
  push(chunk: string): string;
  flush(): string;
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
