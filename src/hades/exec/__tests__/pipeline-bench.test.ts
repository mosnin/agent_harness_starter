import { describe, it, expect } from "vitest";
import { runPipelineBench, buildPipelineRegistry } from "../pipeline-bench";
import { ProvenanceLedger } from "../provenance";
import type { ProvenanceEvent } from "../tool-rpc";

// ---------------------------------------------------------------------------
// Independently-computed ground truth. This is deliberately NOT copy-pasted
// from pipeline-bench.ts's own tool implementations: it re-derives the
// expected mean from the fixture corpus's documented contents (see the
// CORPUS comment in pipeline-bench.ts) using nothing but plain arithmetic,
// so a bug in the bench's own search/extract/summarize chain can't silently
// validate itself.
// ---------------------------------------------------------------------------

const EXPECTED_MATCHING_VALUES = [12.5, 9.25, 18.0, 6.25, 15.0]; // docs 1,2,4,6,8
const EXPECTED_SUM = EXPECTED_MATCHING_VALUES.reduce((a, b) => a + b, 0);
const EXPECTED_MEAN = EXPECTED_SUM / EXPECTED_MATCHING_VALUES.length;
const EXPECTED_ANSWER = String(EXPECTED_MEAN); // "12.2" — decimal terminates exactly, no fp noise

describe("buildPipelineRegistry", () => {
  it("registers exactly the three chained tools", () => {
    const registry = buildPipelineRegistry();
    expect(registry.names().sort()).toEqual(["corpus_search", "doc_extract", "summarize_stats"]);
  });

  it("search -> extract -> summarize genuinely chains through real tool calls", async () => {
    const registry = buildPipelineRegistry();

    const searchRes = await registry.run({ tool: "corpus_search", input: "sensor-alpha" });
    expect(searchRes.ok).toBe(true);
    const ids = searchRes.output.split(",").filter(Boolean);
    expect(ids).toEqual(["doc1", "doc2", "doc4", "doc6", "doc8"]);

    const numbers: string[] = [];
    for (const id of ids) {
      const res = await registry.run({ tool: "doc_extract", input: id });
      expect(res.ok).toBe(true);
      const parsed = JSON.parse(res.output) as { numbers: string; emails: string };
      numbers.push(...parsed.numbers.split(","));
    }
    expect(numbers.map(Number)).toEqual(EXPECTED_MATCHING_VALUES);

    const statsRes = await registry.run({ tool: "summarize_stats", input: numbers.join(",") });
    expect(statsRes.ok).toBe(true);
    const stats = JSON.parse(statsRes.output) as {
      count: number;
      min: string;
      max: string;
      sum: string;
      mean: string;
    };
    expect(stats.count).toBe(5);
    expect(stats.mean).toBe(EXPECTED_ANSWER);
  });

  it("corpus_search excludes decoy documents that don't mention the term", async () => {
    const registry = buildPipelineRegistry();
    const res = await registry.run({ tool: "corpus_search", input: "sensor-alpha" });
    const ids = new Set(res.output.split(","));
    // decoys: sensor-beta, weather station, sensor-gamma, network switch, battery bank
    expect(ids.has("doc3")).toBe(false);
    expect(ids.has("doc5")).toBe(false);
    expect(ids.has("doc7")).toBe(false);
    expect(ids.has("doc9")).toBe(false);
    expect(ids.has("doc10")).toBe(false);
  });
});

describe("runPipelineBench — the Phase 1 checkpoint", () => {
  it("counts real steps/toolCalls on both sides and both answers match ground truth", async () => {
    const result = await runPipelineBench();

    // --- ReAct side: a real multi-turn AgentLoop run. ---
    expect(result.react.steps).toBeGreaterThanOrEqual(4);
    expect(result.react.toolCalls).toBeGreaterThan(0);
    expect(result.react.verifiedTrace).toBe(false); // documented asymmetry

    // --- Programmatic side: exactly one execute_code invocation. ---
    expect(result.programmatic.steps).toBe(1);
    expect(result.programmatic.toolCalls).toBeGreaterThan(0);
    expect(result.programmatic.verifiedTrace).toBe(true);

    // Same underlying work: both sides make the same three-tool chain calls.
    expect(result.programmatic.toolCalls).toBe(result.react.toolCalls);

    // Reductions are derived from the counted values above, not hardcoded.
    const expectedToolCallReduction =
      (result.react.toolCalls - result.programmatic.toolCalls) / result.react.toolCalls;
    const expectedStepReduction = (result.react.steps - result.programmatic.steps) / result.react.steps;
    expect(result.toolCallReduction).toBeCloseTo(expectedToolCallReduction, 12);
    expect(result.stepReduction).toBeCloseTo(expectedStepReduction, 12);
    expect(result.stepReduction).toBeGreaterThan(0);

    // Both answers agree with each other AND with the independently
    // computed ground truth.
    expect(result.answersAgree).toBe(true);
    expect(result.react.answer).toBe(EXPECTED_ANSWER);
    expect(result.programmatic.answer).toBe(EXPECTED_ANSWER);
  }, 20000);

  it("is deterministic across two invocations (deep-equal PipelineBenchResult)", async () => {
    const first = await runPipelineBench();
    const second = await runPipelineBench();
    expect(second).toEqual(first);
  }, 20000);

  it("documents the verifiedTrace asymmetry explicitly: programmatic true, react false", async () => {
    const result = await runPipelineBench();
    expect(result.programmatic.verifiedTrace).toBe(true);
    expect(result.react.verifiedTrace).toBe(false);
  }, 20000);
});

describe("tampering with a provenance ledger flips verify().ok (unit-level)", () => {
  function sampleEvent(seq: number): ProvenanceEvent {
    return {
      seq,
      tool: "corpus_search",
      inputSha256: "a".repeat(64),
      outputSha256: "b".repeat(64),
      ok: true,
      startedAt: 1_700_000_000_000,
      elapsedMs: 5,
    };
  }

  it("a freshly built ledger verifies ok", () => {
    const ledger = new ProvenanceLedger();
    ledger.append(sampleEvent(1));
    ledger.append(sampleEvent(2));
    expect(ledger.verify().ok).toBe(true);
  });

  it("mutating a record's serialized output flips verify().ok to false", () => {
    const ledger = new ProvenanceLedger();
    ledger.append(sampleEvent(1));
    ledger.append(sampleEvent(2));

    const tampered = JSON.parse(ledger.toJSON()) as {
      genesis: string;
      records: Array<{ event: ProvenanceEvent; prevSha256: string; recordSha256: string }>;
    };
    // Flip a single byte of real, load-bearing data: the outcome of the
    // first dispatched call.
    tampered.records[0].event.ok = false;

    const verdict = ProvenanceLedger.verifyJSON(JSON.stringify(tampered));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("hash_mismatch");
  });

  it("ProvenanceLedger.fromJSON throws on the same tampered ledger", () => {
    const ledger = new ProvenanceLedger();
    ledger.append(sampleEvent(1));
    const tampered = JSON.parse(ledger.toJSON()) as {
      genesis: string;
      records: Array<{ event: ProvenanceEvent; prevSha256: string; recordSha256: string }>;
    };
    tampered.records[0].event.tool = "something_else_entirely";
    expect(() => ProvenanceLedger.fromJSON(JSON.stringify(tampered))).toThrow();
  });
});
