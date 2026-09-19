/**
 * In-memory Jev decision audit log (explainability / jev-explain).
 */

import type { JevAuditEntry, PolicyDecision } from "./types";

const MAX_ENTRIES = 500;
const log: JevAuditEntry[] = [];

export function recordDecision(decision: PolicyDecision, durationMs: number, model?: string): JevAuditEntry {
  const entry: JevAuditEntry = {
    node: decision.node,
    decision: String(decision.value),
    reason: decision.reason,
    action: decision.action,
    confidence: decision.confidence,
    probability: decision.probability,
    model,
    durationMs,
    ts: Date.now(),
    answers: decision.answers,
  };
  log.push(entry);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  return entry;
}

export function getJevAudit(node?: string): JevAuditEntry[] {
  return node ? log.filter((entry) => entry.node === node) : [...log];
}

export function clearJevAudit(): void {
  log.length = 0;
}
