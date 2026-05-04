/**
 * Per-action audit log for agent tool calls.
 *
 * Every tool execution (allowed or blocked) should be logged here.
 * Adapters ship it to your observability stack; the default prints to stdout.
 *
 * SQL schema (Postgres, for reference):
 *   CREATE TABLE agent_audit_log (
 *     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     run_id      TEXT NOT NULL,
 *     user_id     TEXT,
 *     agent_name  TEXT NOT NULL,
 *     tool_name   TEXT NOT NULL,
 *     input_hash  TEXT,            -- SHA-256 of JSON input (PII-safe logging)
 *     outcome     TEXT NOT NULL,   -- 'allowed' | 'blocked' | 'error'
 *     policy_name TEXT,
 *     reason      TEXT,
 *     duration_ms INTEGER,
 *     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   );
 *
 * Usage:
 *   import { audit } from "@/agents/security/audit";
 *   audit.log({ runId, userId, agentName, toolName, input, outcome: "allowed", durationMs });
 */

import { createHash } from "crypto";

export type AuditOutcome = "allowed" | "blocked" | "error";

export interface AuditRecord {
  runId: string;
  userId?: string;
  agentName: string;
  toolName: string;
  /** Raw tool input — hashed before persistence if PII-safe mode is on. */
  input?: unknown;
  outcome: AuditOutcome;
  policyName?: string;
  reason?: string;
  durationMs?: number;
  error?: string;
  timestamp: number;
}

export interface AuditAdapter {
  write(record: AuditRecord): Promise<void> | void;
}

// ── Built-in adapters ─────────────────────────────────────────────────────────

/** Writes structured JSON lines to stdout. Safe for log aggregators. */
export class ConsoleAuditAdapter implements AuditAdapter {
  write(record: AuditRecord): void {
    const safe = sanitizeForLog(record);
    process.stdout.write(JSON.stringify({ audit: safe }) + "\n");
  }
}

/** Collects records in memory — useful for testing. */
export class InMemoryAuditAdapter implements AuditAdapter {
  readonly records: AuditRecord[] = [];
  write(record: AuditRecord): void {
    this.records.push(record);
  }
}

/** No-op adapter for opt-out. */
export class NoopAuditAdapter implements AuditAdapter {
  write(_record: AuditRecord): void {}
}

// ── Input hashing (PII-safe logging) ─────────────────────────────────────────

export function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(typeof input === "string" ? input : JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function sanitizeForLog(record: AuditRecord): Omit<AuditRecord, "input"> & { inputHash: string } {
  const { input, ...rest } = record;
  return { ...rest, inputHash: hashInput(input) };
}

// ── AuditLogger ───────────────────────────────────────────────────────────────

export class AuditLogger {
  private adapter: AuditAdapter;

  constructor(adapter?: AuditAdapter) {
    this.adapter = adapter ?? new ConsoleAuditAdapter();
  }

  setAdapter(adapter: AuditAdapter): void {
    this.adapter = adapter;
  }

  log(record: Omit<AuditRecord, "timestamp">): void {
    const full: AuditRecord = { ...record, timestamp: Date.now() };
    try {
      Promise.resolve(this.adapter.write(full)).catch(() => {});
    } catch {
      // Audit failures must never crash the agent run
    }
  }

  /** Convenience: log a policy violation (blocked outcome). */
  logBlocked(
    partial: Pick<AuditRecord, "runId" | "agentName" | "toolName"> &
      Partial<AuditRecord>,
    policyName: string,
    reason: string
  ): void {
    this.log({ ...partial, outcome: "blocked", policyName, reason });
  }

  /** Convenience: log a successful tool execution. */
  logAllowed(
    partial: Pick<AuditRecord, "runId" | "agentName" | "toolName"> &
      Partial<AuditRecord>
  ): void {
    this.log({ ...partial, outcome: "allowed" });
  }
}

/** Global singleton AuditLogger. */
declare global {
  // eslint-disable-next-line no-var
  var __agentAudit: AuditLogger | undefined;
}
export const audit: AuditLogger =
  globalThis.__agentAudit ?? (globalThis.__agentAudit = new AuditLogger());
