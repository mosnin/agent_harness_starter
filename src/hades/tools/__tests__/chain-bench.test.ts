import { describe, it, expect } from "vitest";
import { runToolchainBench } from "../chain-bench";
import { builtinRegistry, ToolRegistry, type Tool, type ToolResult } from "../../agent/tools";
import { execEnabledRegistry } from "../../exec";

// ---------------------------------------------------------------------------
// In-test fixture tools — web_search / fetch_extract emitting the LOCKED
// output shapes, built fresh for this test file (never shipped under src).
// A `sabotaged` flag flips fetch_extract into a dishonest "real" output that
// still carries a mock marker, so `allVerified` genuinely depends on the
// verifiers catching it rather than a hardcoded true/false.
// ---------------------------------------------------------------------------

function fixtureWebSearchTool(): Tool {
  return {
    name: "web_search",
    description: "fixture web_search",
    run: (input: string): ToolResult => {
      const query = input.trim();
      return {
        ok: true,
        output: JSON.stringify({
          mode: "mock",
          query,
          results: [
            {
              title: `[mock] Result 1 for "${query}"`,
              url: "https://mock.invalid/search/fixture/1",
              snippet: `[mock] Deterministic fixture result for "${query}".`,
            },
          ],
        }),
      };
    },
  };
}

const FETCH_EXTRACT_CONTENT =
  "styx toolchain bench fixture document with a modest number of whitespace separated tokens for word count";

function fixtureFetchExtractTool(opts: { sabotaged: boolean }): Tool {
  return {
    name: "fetch_extract",
    description: "fixture fetch_extract",
    run: (input: string): ToolResult => {
      let url = "";
      try {
        const parsed = JSON.parse(input) as { url?: unknown };
        url = typeof parsed.url === "string" ? parsed.url : "";
      } catch {
        url = input.trim();
      }
      if (url === "") {
        return { ok: false, output: JSON.stringify({ mode: "mock", error: "no url supplied" }) };
      }
      if (opts.sabotaged) {
        // Dishonest: claims "real" but the content still carries the mock
        // marker — exactly the MODE_MISMATCH scenario the verifier exists to
        // catch.
        return {
          ok: true,
          output: JSON.stringify({
            mode: "real",
            url,
            extract: "text",
            content: "[mock] this fixture lies about being real",
            truncated: false,
          }),
        };
      }
      return {
        ok: true,
        output: JSON.stringify({
          mode: "mock",
          url,
          extract: "text",
          content: `[mock] ${FETCH_EXTRACT_CONTENT}`,
          truncated: false,
        }),
      };
    },
  };
}

function buildFixtureRegistry(opts?: { sabotaged?: boolean }): ToolRegistry {
  const registry = builtinRegistry(); // includes the real, builtin word_count
  registry.register(fixtureWebSearchTool());
  registry.register(fixtureFetchExtractTool({ sabotaged: opts?.sabotaged ?? false }));
  return execEnabledRegistry(registry);
}

// ---------------------------------------------------------------------------
// Registry-completeness assertion
// ---------------------------------------------------------------------------

describe("runToolchainBench — registry assertion", () => {
  it("throws a precise error listing every missing required tool", async () => {
    const registry = new ToolRegistry(); // empty: no execute_code, no web_search, no fetch_extract
    await expect(runToolchainBench(registry)).rejects.toThrow(
      /missing required tool\(s\): execute_code, web_search, fetch_extract/
    );
  });

  it("throws listing only the tools that are actually missing", async () => {
    const registry = execEnabledRegistry(builtinRegistry()); // has execute_code + word_count, not web_search/fetch_extract
    await expect(runToolchainBench(registry)).rejects.toThrow(/missing required tool\(s\): web_search, fetch_extract/);
  });

  it("respects a custom requiredTools list", async () => {
    const registry = execEnabledRegistry(builtinRegistry());
    await expect(runToolchainBench(registry, { requiredTools: ["calc"] })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The conforming chain: web_search -> fetch_extract -> word_count
// ---------------------------------------------------------------------------

describe("runToolchainBench — conforming fixture", () => {
  it("genuinely chains three tool calls in exactly one program turn", async () => {
    const registry = buildFixtureRegistry();
    const result = await runToolchainBench(registry);

    expect(result.programTurns).toBe(1);
    expect(result.toolCallCount).toBeGreaterThanOrEqual(3);
    expect(result.steps.map((s) => s.tool)).toEqual(["web_search", "fetch_extract", "word_count"]);
    for (const step of result.steps) {
      expect(step.ok).toBe(true);
      expect(step.outputBytes).toBeGreaterThan(0);
    }
  });

  it("outputBytes is the real measured UTF-8 byte length of each captured step, not a constant", async () => {
    const registry = buildFixtureRegistry();
    const result = await runToolchainBench(registry);

    const searchStep = result.steps.find((s) => s.tool === "web_search")!;
    const extractStep = result.steps.find((s) => s.tool === "fetch_extract")!;
    const wcStep = result.steps.find((s) => s.tool === "word_count")!;

    // The three steps have genuinely different payload sizes (search JSON
    // with an embedded query, larger extracted-text JSON, then a tiny
    // numeric word count) — a hardcoded constant could never satisfy all
    // three simultaneously.
    expect(searchStep.outputBytes).not.toBe(extractStep.outputBytes);
    expect(extractStep.outputBytes).toBeGreaterThan(wcStep.outputBytes);
    // word_count's output is just the digit "N" for the fixture content.
    const expectedWordCount = FETCH_EXTRACT_CONTENT.trim().split(/\s+/).length;
    expect(wcStep.outputBytes).toBe(Buffer.byteLength(String(expectedWordCount), "utf8"));
  });

  it("verifies web_search and fetch_extract (not word_count, which has no locked-format verifier)", async () => {
    const registry = buildFixtureRegistry();
    const result = await runToolchainBench(registry);

    const verifierIds = result.verdicts.map((v) => v.verifierId).sort();
    expect(verifierIds).toEqual(["verify.fetch_extract", "verify.web_search"]);
  });

  it("allVerified is true on the conforming fixture", async () => {
    const registry = buildFixtureRegistry();
    const result = await runToolchainBench(registry);

    expect(result.allVerified).toBe(true);
    for (const verdict of result.verdicts) {
      expect(verdict.passed, verdict.verifierId).toBe(true);
      expect(verdict.reasons, verdict.verifierId).toEqual([]);
    }
  });

  it("ensembleScore is a real, non-degenerate probability derived from the actual verdicts", async () => {
    const registry = buildFixtureRegistry();
    const result = await runToolchainBench(registry);

    expect(result.ensembleScore).toBeGreaterThan(0);
    expect(result.ensembleScore).toBeLessThanOrEqual(1);
    // Both verdicts passed, so the ensemble's reliability-weighted pass
    // fraction for this item should itself read as "pass" (> 0.5).
    expect(result.ensembleScore).toBeGreaterThan(0.5);
  });

  it("two identical runs against equivalent fixture registries produce identical verdicts and ensembleScore", async () => {
    const r1 = await runToolchainBench(buildFixtureRegistry());
    const r2 = await runToolchainBench(buildFixtureRegistry());

    expect(r2.verdicts).toEqual(r1.verdicts);
    expect(r2.ensembleScore).toBe(r1.ensembleScore);
    expect(r2.allVerified).toBe(r1.allVerified);
    expect(r2.steps.map((s) => ({ tool: s.tool, ok: s.ok, outputBytes: s.outputBytes }))).toEqual(
      r1.steps.map((s) => ({ tool: s.tool, ok: s.ok, outputBytes: s.outputBytes }))
    );
  });
});

// ---------------------------------------------------------------------------
// The sabotaged fixture: fetch_extract lies about its mode
// ---------------------------------------------------------------------------

describe("runToolchainBench — sabotaged fixture", () => {
  it("allVerified is false when a fixture lies about its mode, and the reason is MODE_MISMATCH", async () => {
    const registry = buildFixtureRegistry({ sabotaged: true });
    const result = await runToolchainBench(registry);

    expect(result.allVerified).toBe(false);
    const fetchVerdict = result.verdicts.find((v) => v.verifierId === "verify.fetch_extract");
    expect(fetchVerdict).toBeDefined();
    expect(fetchVerdict!.passed).toBe(false);
    expect(fetchVerdict!.reasons).toContain("MODE_MISMATCH");

    // web_search itself is still honest — only the sabotaged tool fails.
    const searchVerdict = result.verdicts.find((v) => v.verifierId === "verify.web_search");
    expect(searchVerdict!.passed).toBe(true);
  });

  it("ensembleScore on the sabotaged run is lower than on the conforming run", async () => {
    const conforming = await runToolchainBench(buildFixtureRegistry({ sabotaged: false }));
    const sabotaged = await runToolchainBench(buildFixtureRegistry({ sabotaged: true }));

    expect(sabotaged.ensembleScore).toBeLessThan(conforming.ensembleScore);
  });

  it("toolCallCount and step bookkeeping are still measured honestly even when a step is dishonest", async () => {
    const registry = buildFixtureRegistry({ sabotaged: true });
    const result = await runToolchainBench(registry);

    expect(result.toolCallCount).toBeGreaterThanOrEqual(3);
    // The sabotaged fetch_extract still returns ok:true (it lies about
    // *mode*, not about succeeding) — so step-level `ok` stays true and only
    // the verifier catches the dishonesty.
    const extractStep = result.steps.find((s) => s.tool === "fetch_extract")!;
    expect(extractStep.ok).toBe(true);
  });
});
