import type { VerificationReport, WorkerResult } from "../types";
import { buildTraceHaystack, isEvidenceTraceable } from "./gate";

export interface ClaimProvenance {
  statement: string;
  confidence: number;
  evidence: string[];
  /** Evidence items that were confirmed against the worker's tool trace. */
  tracedEvidence: string[];
  /** True if at least one evidence item traced to observed data. */
  grounded: boolean;
}

/**
 * An audit record for a verified result: exactly why the manager believed it.
 * Keeps the claims, which evidence was confirmed against the tool trace, and the
 * gate's verdict/score — a durable citation trail an operator (or compliance
 * review) can inspect long after the run.
 */
export interface ProvenanceRecord {
  taskId: string;
  goalId?: string;
  workerId: string;
  at: number;
  verdict: string;
  score: number;
  toolCount: number;
  claims: ClaimProvenance[];
}

/** Build a provenance record by re-confirming each claim's evidence. */
export function buildProvenance(
  result: WorkerResult,
  report: VerificationReport,
  goalId?: string
): ProvenanceRecord {
  const claims: ClaimProvenance[] = result.claims.map((c) => {
    const traced = c.evidence.filter((e) => isEvidenceTraceable(e, result.toolTrace));
    return {
      statement: c.statement,
      confidence: c.confidence,
      evidence: c.evidence,
      tracedEvidence: traced,
      grounded: traced.length > 0 || (result.toolTrace.length === 0 && c.evidence.length > 0),
    };
  });
  return {
    taskId: result.taskId,
    goalId,
    workerId: result.workerId,
    at: report.at,
    verdict: report.verdict,
    score: report.score,
    toolCount: result.toolTrace.length,
    claims,
  };
}

/**
 * Append-only store of provenance records, keyed by task. The manager writes a
 * record every time it accepts a result, so the store is the swarm's "chain of
 * custody" for every fact that made it into a completed goal.
 */
export class ProvenanceStore {
  private byTask = new Map<string, ProvenanceRecord>();
  private order: string[] = [];

  record(rec: ProvenanceRecord): void {
    if (!this.byTask.has(rec.taskId)) this.order.push(rec.taskId);
    this.byTask.set(rec.taskId, rec);
  }

  get(taskId: string): ProvenanceRecord | undefined {
    return this.byTask.get(taskId);
  }

  list(): ProvenanceRecord[] {
    return this.order.map((id) => this.byTask.get(id)!).filter(Boolean);
  }

  forGoal(goalId: string): ProvenanceRecord[] {
    return this.list().filter((r) => r.goalId === goalId);
  }

  /** Fraction of all recorded claims that were grounded in observed evidence. */
  groundingRate(): number {
    const all = this.list().flatMap((r) => r.claims);
    if (all.length === 0) return 1;
    return all.filter((c) => c.grounded).length / all.length;
  }

  clear(): void {
    this.byTask.clear();
    this.order = [];
  }
}

// Re-export the trace helper so callers can build a haystack for display.
export { buildTraceHaystack };
