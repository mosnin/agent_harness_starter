import { describe, it, expect } from "vitest";
import { SemanticGroundingJudge, cosine } from "../verification/semantic-judge";
import { VerificationGate } from "../verification/gate";
import type { EmbeddingService, EmbeddingResult } from "../../agents/embeddings/types";
import type { WorkerResult } from "../types";

/**
 * Deterministic bag-of-words embedding service: each dimension is the count of a
 * vocabulary word, so texts that share words have high cosine similarity. Good
 * enough to exercise the semantic judge's logic without a real model.
 */
class BagOfWordsEmbeddings implements EmbeddingService {
  readonly dimensions = 64;
  readonly model = "bow-test";
  private vocab = new Map<string, number>();
  private idx(word: string): number {
    if (!this.vocab.has(word)) this.vocab.set(word, this.vocab.size % this.dimensions);
    return this.vocab.get(word)!;
  }
  async embed(text: string): Promise<EmbeddingResult> {
    const v = new Array(this.dimensions).fill(0);
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[this.idx(w)] += 1;
    return { vector: v, model: this.model, cached: false };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("SemanticGroundingJudge", () => {
  const judge = new SemanticGroundingJudge(new BagOfWordsEmbeddings(), { threshold: 0.5 });

  it("scores semantically supported evidence highly", async () => {
    const r = await judge.assess({
      output: "ok",
      claims: [{ statement: "retries five", evidence: ["the config sets retries to five"], confidence: 0.9 }],
      toolTrace: [{ tool: "read_config", args: {}, ok: true, output: "config sets retries to five", at: 0 }],
    });
    expect(r.score).toBeGreaterThan(0.5);
  });

  it("scores unrelated evidence low", async () => {
    const r = await judge.assess({
      output: "ok",
      claims: [{ statement: "x", evidence: ["quarterly revenue projections for the marketing team"], confidence: 0.9 }],
      toolTrace: [{ tool: "read_config", args: {}, ok: true, output: "retries backoff timeout ports", at: 0 }],
    });
    expect(r.score).toBeLessThan(0.5);
  });

  it("plugs into the gate as an independent judge", async () => {
    const gate = new VerificationGate({ judge });
    const result: WorkerResult = {
      taskId: "t", workerId: "w",
      output: "retries are five",
      claims: [{ statement: "retries five", evidence: ["config sets retries to five"], confidence: 0.9 }],
      toolTrace: [{ tool: "read_config", args: {}, ok: true, output: "config sets retries to five", at: 0 }],
      startedAt: 0, finishedAt: 1,
    };
    const report = await gate.verify(result);
    const judgeCheck = report.checks.find((c) => c.name === "llm-judge");
    expect(judgeCheck).toBeDefined();
    expect(judgeCheck!.passed).toBe(true);
    expect(report.verdict).toBe("accept");
  });
});
