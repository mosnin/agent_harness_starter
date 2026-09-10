import type { EmbeddingService } from "../../agents/embeddings/types";
import type { Claim, ToolCallRecord } from "../types";
import type { Judge } from "./gate";

export interface SemanticJudgeOptions {
  /** Min cosine similarity for a claim to count as semantically grounded. Default 0.6. */
  threshold?: number;
  /** Cap on trace entries embedded per assessment (cost guard). Default 40. */
  maxTraceChunks?: number;
}

/**
 * Semantic grounding judge. Where the gate's lexical `evidence-traceable` check
 * catches only literal/token overlap, this uses embeddings to ask a deeper
 * question: is each claim's evidence *semantically* supported by something the
 * worker actually observed? It plugs into the gate's independent-`Judge` slot,
 * so it augments — never replaces — the deterministic checks, and degrades to a
 * no-op (handled by the gate) if the embedding backend is unavailable.
 *
 * This both reduces false rejections of correctly-paraphrased evidence and
 * catches "semantic fabrication": evidence that shares keywords with the trace
 * but means something different.
 */
export class SemanticGroundingJudge implements Judge {
  private readonly threshold: number;
  private readonly maxTraceChunks: number;

  constructor(
    private readonly embeddings: EmbeddingService,
    opts: SemanticJudgeOptions = {}
  ) {
    this.threshold = opts.threshold ?? 0.6;
    this.maxTraceChunks = opts.maxTraceChunks ?? 40;
  }

  async assess(input: {
    output: unknown;
    claims: Claim[];
    toolTrace: ToolCallRecord[];
  }): Promise<{ score: number; rationale: string }> {
    const claimsWithEvidence = input.claims.filter((c) => c.evidence.length > 0);
    if (claimsWithEvidence.length === 0) {
      return { score: 0, rationale: "no evidence to semantically ground" };
    }

    const traceTexts = input.toolTrace
      .map((t) => `${t.tool} ${t.output}`)
      .filter((s) => s.trim().length > 0)
      .slice(0, this.maxTraceChunks);
    if (traceTexts.length === 0) {
      return { score: 0, rationale: "no tool trace to ground against" };
    }

    const traceVecs = (await this.embeddings.embedBatch(traceTexts)).map((r) => r.vector);

    let grounded = 0;
    let simSum = 0;
    let count = 0;
    for (const claim of claimsWithEvidence) {
      const evVecs = (await this.embeddings.embedBatch(claim.evidence)).map((r) => r.vector);
      // Best similarity between any evidence item and any trace chunk.
      let best = 0;
      for (const ev of evVecs) {
        for (const tv of traceVecs) best = Math.max(best, cosine(ev, tv));
      }
      simSum += best;
      count += 1;
      if (best >= this.threshold) grounded += 1;
    }

    const score = count > 0 ? simSum / count : 0;
    return {
      score,
      rationale: `${grounded}/${count} claims semantically grounded (avg sim ${score.toFixed(2)}, threshold ${this.threshold})`,
    };
  }
}

/** Cosine similarity of two vectors; 0 if either is degenerate. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
