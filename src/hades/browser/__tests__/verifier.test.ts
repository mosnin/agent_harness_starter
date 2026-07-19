/**
 * Tests for `verify.browser` (verifier.ts). This file deliberately never
 * imports `./tool` (independence) — every fixture below is a hand-built
 * JSON string matching the LOCKED `browser` tool output contract, proving
 * the verifier can be exercised (and its checklist codes individually
 * caught) purely from the contract, not from calling the real tool.
 * (`tool.test.ts` owns the one integration-direction pairing test.)
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { browserToolVerifier, browserCalibration } from "../verifier";
import type { ToolResult } from "../../agent/tools";

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const URL_A = "https://example.com/page";
const CONTENT_A = "Real body content that was actually extracted from the page.";

function realOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "real",
    op: "browse",
    url: URL_A,
    finalUrl: URL_A,
    title: "A Real Title",
    content: CONTENT_A,
    passages: [
      {
        text: CONTENT_A,
        sourceUrl: URL_A,
        selectorPath: "html>body>main>p",
        sha256: sha256Hex(CONTENT_A),
      },
    ],
    traceRoot: sha256Hex("some-real-trace-payload"),
    eventCount: 5,
    truncated: false,
    ...overrides,
  };
}

function mockContentFor(url: string): string {
  return `[mock] browse of ${url} — no Chromium executable or runner available; deterministic stand-in.`;
}

function mockOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = mockContentFor(URL_A);
  return {
    mode: "mock",
    op: "browse",
    url: URL_A,
    finalUrl: URL_A,
    title: "[mock] browser",
    content,
    passages: [{ text: content, sourceUrl: URL_A, selectorPath: "mock:0", sha256: sha256Hex(content) }],
    traceRoot: sha256Hex(`mock-trace:${URL_A}`),
    eventCount: 0,
    truncated: false,
    note: "[mock] no browse runner was provided; deterministic stand-in used.",
    ...overrides,
  };
}

function ok(output: Record<string, unknown>): ToolResult {
  return { ok: true, output: JSON.stringify(output) };
}

function inputFor(url: string): string {
  return JSON.stringify({ op: "browse", url });
}

const verifier = browserToolVerifier();
const PRIOR = browserCalibration().prior;
const N = 9; // the fixed nine-check checklist

function expectedConfidence(passedCount: number): number {
  return (passedCount / N) * PRIOR;
}

// ---------------------------------------------------------------------------
// Identity / calibration
// ---------------------------------------------------------------------------

describe("browserToolVerifier identity", () => {
  it("has the locked verifierId and toolName", () => {
    expect(verifier.verifierId).toBe("verify.browser");
    expect(verifier.toolName).toBe("browser");
  });
});

describe("browserCalibration", () => {
  it("is tier T4-consistency with a prior in [0.6, 0.75]", () => {
    const c = browserCalibration();
    expect(c.tier).toBe("T4-consistency");
    expect(c.prior).toBeGreaterThanOrEqual(0.6);
    expect(c.prior).toBeLessThanOrEqual(0.75);
  });
});

// ---------------------------------------------------------------------------
// Certain-failure paths (pinned confidence, no calibration needed)
// ---------------------------------------------------------------------------

describe("certain failure detection", () => {
  it("pins confidence at 0.99 and passed:false when result.ok is false", () => {
    const v = verifier.verify(inputFor(URL_A), { ok: false, output: "whatever" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("pins confidence at 0.99 when output is not valid JSON", () => {
    const v = verifier.verify(inputFor(URL_A), { ok: true, output: "not json {{{" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });

  it("pins confidence at 0.99 when output is a JSON array, not an object", () => {
    const v = verifier.verify(inputFor(URL_A), { ok: true, output: "[1,2,3]" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });

  it("pins confidence at 0.99 when output is a bare JSON scalar", () => {
    const v = verifier.verify(inputFor(URL_A), { ok: true, output: "42" });
    expect(v.passed).toBe(false);
    expect(v.confidence).toBeCloseTo(0.99, 12);
  });
});

// ---------------------------------------------------------------------------
// Full-pass baseline
// ---------------------------------------------------------------------------

describe("full pass baseline", () => {
  it("a well-formed real output passes every check at confidence == prior", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput()));
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });

  it("a well-formed mock output passes every check at confidence == prior", () => {
    const v = verifier.verify(inputFor(URL_A), ok(mockOutput()));
    expect(v.passed).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });

  it("a real output with zero passages still passes (vacuously true passage checks)", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(realOutput({ passages: [] }))
    );
    expect(v.passed).toBe(true);
    expect(v.confidence).toBeCloseTo(PRIOR, 12);
  });
});

// ---------------------------------------------------------------------------
// mode-valid
// ---------------------------------------------------------------------------

describe("mode-valid check", () => {
  it("fails when mode is missing", () => {
    const output = realOutput();
    delete output.mode;
    const v = verifier.verify(inputFor(URL_A), ok(output));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-valid");
  });

  it("fails when mode is an unrecognised string", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ mode: "fake" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-valid");
  });
});

// ---------------------------------------------------------------------------
// mode-honest — the fabrication-resistance tests
// ---------------------------------------------------------------------------

describe("mode-honest check (fabrication resistance)", () => {
  it("catches a mock output relabelled as real (content still has [mock] markers)", () => {
    const relabelled = mockOutput({ mode: "real" });
    const v = verifier.verify(inputFor(URL_A), ok(relabelled));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-honest");
  });

  it("catches a real output that dishonestly contains a [mock] marker somewhere", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ title: "[mock] sneaky" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-honest");
  });

  it("catches a mock output whose content deviates from the exact locked template", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(mockOutput({ content: "[mock] some other wording entirely" }))
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-honest");
  });

  it("catches a mock output whose title deviates from '[mock] browser'", () => {
    const v = verifier.verify(inputFor(URL_A), ok(mockOutput({ title: "[mock] something else" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-honest");
  });

  it("catches a mock output whose traceRoot does not recompute from its own url", () => {
    const v = verifier.verify(inputFor(URL_A), ok(mockOutput({ traceRoot: sha256Hex("wrong-input") })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("mode-honest");
  });

  it("passes a real output that legitimately mentions neither markers nor mock wording", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput()));
    expect(v.reasons).not.toContain("mode-honest");
  });
});

// ---------------------------------------------------------------------------
// url-echo
// ---------------------------------------------------------------------------

describe("url-echo check", () => {
  it("fails when output.url does not match the input JSON's url (a url swap)", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ url: "https://different.example.com" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("url-echo");
  });

  it("fails when the original input is not parseable JSON", () => {
    const v = verifier.verify("not json", ok(realOutput()));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("url-echo");
  });

  it("fails when output.url is missing entirely", () => {
    const output = realOutput();
    delete output.url;
    const v = verifier.verify(inputFor(URL_A), ok(output));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("url-echo");
  });

  it("passes when output.url matches the input JSON's url exactly", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput()));
    expect(v.reasons).not.toContain("url-echo");
  });
});

// ---------------------------------------------------------------------------
// tracehash-hex
// ---------------------------------------------------------------------------

describe("tracehash-hex check", () => {
  it("fails on an uppercase traceRoot", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ traceRoot: sha256Hex("x").toUpperCase() })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("tracehash-hex");
  });

  it("fails on a too-short traceRoot", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ traceRoot: "abc123" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("tracehash-hex");
  });

  it("fails on a non-hex traceRoot of the right length", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ traceRoot: "z".repeat(64) })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("tracehash-hex");
  });

  it("fails when traceRoot is missing", () => {
    const output = realOutput();
    delete output.traceRoot;
    const v = verifier.verify(inputFor(URL_A), ok(output));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("tracehash-hex");
  });

  it("passes a genuine 64-char lowercase hex traceRoot", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput()));
    expect(v.reasons).not.toContain("tracehash-hex");
  });
});

// ---------------------------------------------------------------------------
// passages-shape / passages-sha256 / passages-source
// ---------------------------------------------------------------------------

describe("passages-shape check", () => {
  it("fails when passages is not an array", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ passages: "nope" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-shape");
  });

  it("fails when a passage item is missing a required field", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(realOutput({ passages: [{ text: CONTENT_A, sourceUrl: URL_A, selectorPath: "p" /* no sha256 */ }] }))
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-shape");
  });

  it("fails when a passage item has a wrong-typed field", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(
        realOutput({
          passages: [{ text: CONTENT_A, sourceUrl: URL_A, selectorPath: "p", sha256: 12345 }],
        })
      )
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-shape");
  });
});

describe("passages-sha256 check (real recomputation)", () => {
  it("catches a tampered passage sha256 (text/hash mismatch)", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(
        realOutput({
          passages: [
            { text: CONTENT_A, sourceUrl: URL_A, selectorPath: "html>body>main>p", sha256: "0".repeat(64) },
          ],
        })
      )
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-sha256");
  });

  it("passes when the passage sha256 genuinely matches sha256(text)", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput()));
    expect(v.reasons).not.toContain("passages-sha256");
  });

  it("catches tampering even when only one of several passages is tampered", () => {
    const good = { text: CONTENT_A, sourceUrl: URL_A, selectorPath: "p1", sha256: sha256Hex(CONTENT_A) };
    const bad = { text: "other text", sourceUrl: URL_A, selectorPath: "p2", sha256: sha256Hex("not other text") };
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ passages: [good, bad] })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-sha256");
  });
});

describe("passages-source check", () => {
  it("catches a passage sourceUrl that matches neither url nor finalUrl", () => {
    const v = verifier.verify(
      inputFor(URL_A),
      ok(
        realOutput({
          passages: [
            {
              text: CONTENT_A,
              sourceUrl: "https://totally-unrelated.example.org",
              selectorPath: "p",
              sha256: sha256Hex(CONTENT_A),
            },
          ],
        })
      )
    );
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("passages-source");
  });

  it("accepts a passage sourceUrl equal to finalUrl when it differs from the original url (redirect case)", () => {
    const finalUrl = "https://example.com/redirected";
    const v = verifier.verify(
      inputFor(URL_A),
      ok(
        realOutput({
          finalUrl,
          passages: [{ text: CONTENT_A, sourceUrl: finalUrl, selectorPath: "p", sha256: sha256Hex(CONTENT_A) }],
        })
      )
    );
    expect(v.reasons).not.toContain("passages-source");
  });
});

// ---------------------------------------------------------------------------
// eventcount-consistent
// ---------------------------------------------------------------------------

describe("eventcount-consistent check", () => {
  it("fails a real output with eventCount 0 (must be positive)", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: 0 })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("eventcount-consistent");
  });

  it("fails a real output with a negative eventCount", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: -3 })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("eventcount-consistent");
  });

  it("fails a real output with a non-integer eventCount", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: 2.5 })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("eventcount-consistent");
  });

  it("fails a mock output with a nonzero eventCount", () => {
    const v = verifier.verify(inputFor(URL_A), ok(mockOutput({ eventCount: 1 })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("eventcount-consistent");
  });

  it("passes a real output with a positive integer eventCount", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: 12 })));
    expect(v.reasons).not.toContain("eventcount-consistent");
  });

  it("passes a mock output with eventCount 0", () => {
    const v = verifier.verify(inputFor(URL_A), ok(mockOutput()));
    expect(v.reasons).not.toContain("eventcount-consistent");
  });
});

// ---------------------------------------------------------------------------
// truncated-boolean
// ---------------------------------------------------------------------------

describe("truncated-boolean check", () => {
  it("fails when truncated is a string instead of a boolean", () => {
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ truncated: "false" })));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("truncated-boolean");
  });

  it("fails when truncated is missing", () => {
    const output = realOutput();
    delete output.truncated;
    const v = verifier.verify(inputFor(URL_A), ok(output));
    expect(v.passed).toBe(false);
    expect(v.reasons).toContain("truncated-boolean");
  });

  it("passes true and false alike", () => {
    expect(verifier.verify(inputFor(URL_A), ok(realOutput({ truncated: true }))).reasons).not.toContain(
      "truncated-boolean"
    );
    expect(verifier.verify(inputFor(URL_A), ok(realOutput({ truncated: false }))).reasons).not.toContain(
      "truncated-boolean"
    );
  });
});

// ---------------------------------------------------------------------------
// Confidence arithmetic — exact k-of-n damping
// ---------------------------------------------------------------------------

describe("confidence arithmetic", () => {
  it("one failing check out of nine damps confidence to (8/9) * prior exactly", () => {
    // eventCount 0 on a "real" output fails exactly eventcount-consistent
    // and nothing else.
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: 0 })));
    expect(v.reasons).toEqual(["eventcount-consistent"]);
    expect(v.confidence).toBeCloseTo(expectedConfidence(8), 9);
  });

  it("two independent failing checks damp confidence to (7/9) * prior exactly", () => {
    // truncated wrong type + eventCount 0: two independent, isolated failures.
    const v = verifier.verify(inputFor(URL_A), ok(realOutput({ eventCount: 0, truncated: "nope" })));
    expect(v.reasons.sort()).toEqual(["eventcount-consistent", "truncated-boolean"].sort());
    expect(v.confidence).toBeCloseTo(expectedConfidence(7), 9);
  });

  it("every check failing drives confidence toward 0", () => {
    const v = verifier.verify("garbage not json", { ok: true, output: "{}" });
    expect(v.passed).toBe(false);
    // {} has no fields at all: mode-valid fails, mode-honest fails (mode
    // unrecognised), url-echo fails (no url anywhere and unparsable input),
    // tracehash-hex fails, passages-shape fails (not an array), sha256/source
    // fail as a consequence, eventcount-consistent fails, truncated-boolean
    // fails. That is all nine.
    expect(v.reasons).toHaveLength(9);
    expect(v.confidence).toBeCloseTo(0, 9);
  });
});
