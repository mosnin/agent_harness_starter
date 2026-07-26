/**
 * Webhook audit sink — ships agent security events to an external SIEM or webhook.
 *
 * Signs each payload with HMAC-SHA256 so receivers can verify authenticity.
 * Implements the AuditAdapter interface, compatible with createAuditedPolicy().
 *
 * Usage:
 *   import { createWebhookAuditSink } from "@/agents/security/sinks/webhook";
 *   import { createAuditedPolicy } from "@/agents/security";
 *
 *   const policy = createAuditedPolicy(
 *     { allow: ["web_search"] },
 *     createWebhookAuditSink("https://siem.example.com/ingest", {
 *       secret: process.env.AUDIT_WEBHOOK_SECRET!,
 *     })
 *   );
 *
 * Each event is a POST with JSON body and header:
 *   X-Agent-Harness-Signature: sha256=<hmac-hex>
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { AuditRecord, AuditAdapter } from "../audit";

export interface WebhookAuditSinkOptions {
  /**
   * HMAC-SHA256 secret for signing payloads.
   * Receivers should verify: sha256=hmac(secret, body) matches header.
   * If omitted, no signature header is sent.
   */
  secret?: string;

  /**
   * Maximum milliseconds to wait for webhook delivery.
   * Default: 5000 (5 seconds).
   */
  timeoutMs?: number;

  /** Max delivery attempts. Default: 3. */
  maxAttempts?: number;

  /**
   * Called on each failed attempt (not necessarily fatal).
   * Default: logs to console.warn.
   */
  onError?: (err: unknown, record: AuditRecord, attempt: number) => void;

  /**
   * Called when all retries are exhausted — last chance to persist the record.
   */
  onDeadLetter?: (record: AuditRecord) => void;
}

function signPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verify a webhook signature from X-Agent-Harness-Signature header.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = signPayload(body, secret);
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch — not equal
  }
}

async function deliverWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  record: AuditRecord,
  options: Required<Pick<WebhookAuditSinkOptions, "maxAttempts" | "timeoutMs" | "onError" | "onDeadLetter">>
): Promise<void> {
  const delays = [0, 500, 1000, 2000];
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, delays[attempt - 1] ?? 2000));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      options.onError(err, record, attempt);
      if (attempt === options.maxAttempts) options.onDeadLetter(record);
    }
  }
}

/**
 * Create a webhook-based AuditAdapter.
 * Delivers each audit record as a signed POST to the given URL with
 * exponential-backoff retry (default 3 attempts) and a dead-letter callback
 * for records that exhaust all retries.
 */
export function createWebhookAuditSink(
  url: string,
  options: WebhookAuditSinkOptions = {}
): AuditAdapter {
  const {
    secret,
    timeoutMs = 5000,
    maxAttempts = 3,
    onError = (err: unknown, record: AuditRecord, attempt: number) => {
      console.warn(`[agent-harness] Webhook audit delivery attempt ${attempt} failed for ${record.toolName}:`, err);
    },
    onDeadLetter = (record: AuditRecord) => {
      console.error(`[agent-harness] Webhook audit dead-letter: all retries exhausted for ${record.toolName}.`, record);
    },
  } = options;

  return {
    write(record: AuditRecord): void {
      const body = JSON.stringify({
        ...record,
        timestamp: new Date(record.timestamp ?? Date.now()).toISOString(),
        source: "agent-harness",
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "agent-harness-audit/1.0",
      };

      if (secret) {
        headers["X-Agent-Harness-Signature"] = signPayload(body, secret);
      }

      deliverWithRetry(url, headers, body, record, { maxAttempts, timeoutMs, onError, onDeadLetter }).catch(() => {});
    },
  };
}
