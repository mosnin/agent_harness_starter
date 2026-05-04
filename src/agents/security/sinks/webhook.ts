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

import { createHmac } from "crypto";
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

  /**
   * Called on delivery failure (network error or non-2xx response).
   * Default: logs to console.warn.
   */
  onError?: (err: unknown, record: AuditRecord) => void;
}

function signPayload(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Create a webhook-based AuditAdapter.
 * Fires-and-forgets each audit record as a signed POST to the given URL.
 */
export function createWebhookAuditSink(
  url: string,
  options: WebhookAuditSinkOptions = {}
): AuditAdapter {
  const {
    secret,
    timeoutMs = 5000,
    onError = (err: unknown, record: AuditRecord) => {
      console.warn(`[agent-harness] Webhook audit delivery failed for ${record.toolName}:`, err);
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      fetch(url, { method: "POST", headers, body, signal: controller.signal })
        .then((res) => {
          clearTimeout(timer);
          if (!res.ok) {
            onError(new Error(`HTTP ${res.status}`), record);
          }
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          onError(err, record);
        });
    },
  };
}
