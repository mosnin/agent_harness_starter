/**
 * Tests for `../action-adapters.ts`. Every fixture is a genuine, well-formed
 * (or genuinely tampered) object matching the LOCKED contracts the real
 * wrapped verifiers (`../../tools/verifiers.ts`, `../../browser/verifier.ts`,
 * `../../backends/verifier.ts`, `../../exec/provenance.ts`) already check —
 * nothing here mocks the wrapped verifiers. Fidelity tests call the REAL
 * verifier directly and assert the adapter reproduces its exact verdict.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  toolCallVerifiers,
  execProvenanceVerifier,
  execProvenanceCalibration,
  actionVerifiers,
  ACTION_ADAPTER_VERSION,
} from "../action-adapters";
import { toolVerifiers, calibrationTable, type ToolVerdict } from "../../tools/verifiers";
import type { ToolResult } from "../../agent/tools";
import { ProvenanceLedger } from "../../exec/provenance";
import type { ProvenanceEvent, ToolRpcErrorCode } from "../../exec/tool-rpc";
import { BackendProvenanceLedger } from "../../backends/provenance";
import type { BackendLifecycleRecord } from "../../backends/provenance";
import type { BackendFleetReport } from "../../backends/verifier";
import type { TrustSubject, UniversalVerifier } from "../registry";
import { VerifierRegistry } from "../registry";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function ok(output: unknown): ToolResult {
  return { ok: true, output: typeof output === "string" ? output : JSON.stringify(output) };
}

function failed(output = "boom"): ToolResult {
  return { ok: false, output };
}

function toolSubject(toolName: string, input: string, toolResult: ToolResult | undefined): TrustSubject {
  return {
    domain: "tool",
    subjectId: toolName,
    taskId: "t1",
    input,
    output: "",
    evidence: toolResult === undefined ? {} : { toolResult },
    trace: [],
  };
}

// ---------------------------------------------------------------------------
// Genuine well-formed / mode-dishonest fixtures for all ten tool verifiers
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngB64(): string {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(16, 0x01)]).toString("base64");
}
function mp3B64(): string {
  return Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(10, 0)]).toString("base64");
}

const URL_A = "https://example.com/page";
const CONTENT_A = "Real body content that was actually extracted from the page.";

function browserRealOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "real",
    op: "browse",
    url: URL_A,
    finalUrl: URL_A,
    title: "A Real Title",
    content: CONTENT_A,
    passages: [
      { text: CONTENT_A, sourceUrl: URL_A, selectorPath: "html>body>main>p", sha256: sha256Hex(CONTENT_A) },
    ],
    traceRoot: sha256Hex("some-real-trace-payload"),
    eventCount: 5,
    truncated: false,
    ...overrides,
  };
}

function buildGenuineBackendsReport(): BackendFleetReport {
  let clock = 1000;
  const ledger = new BackendProvenanceLedger({ now: () => (clock += 10) });
  ledger.append({ type: "provision", backend: "docker", workerId: "w1", nativeId: "d1", detail: { latencyMs: 12 } });
  ledger.append({ type: "hibernate", backend: "docker", workerId: "w1", nativeId: "d1" });
  ledger.append({ type: "wake", backend: "docker", workerId: "w1", nativeId: "d1" });
  ledger.append({ type: "provision", backend: "modal", workerId: "w2", nativeId: "m1" });
  ledger.append({ type: "terminate", backend: "modal", workerId: "w2" });
  return {
    backends: [
      { name: "docker", kind: "container", available: true },
      { name: "modal", kind: "serverless", available: true },
    ],
    handles: [
      { workerId: "w1", backend: "docker", state: "running" },
      { workerId: "w2", backend: "modal", state: "stopped" },
    ],
    certificate: ledger.toCertificateFields(),
    records: ledger.records() as BackendLifecycleRecord[],
  };
}

interface ToolFixture {
  verifierId: string;
  toolName: string;
  input: string;
  wellFormed: ToolResult;
  malformed: ToolResult;
}

function buildToolFixtures(): ToolFixture[] {
  const goodBackends = buildGenuineBackendsReport();
  const badBackends: BackendFleetReport = JSON.parse(JSON.stringify(goodBackends));
  // Flip one hex character of the first record's hash — a byte-level tamper
  // that breaks the real chain-recompute check without touching shape.
  const firstHash = badBackends.records[0].hash;
  badBackends.records[0] = {
    ...badBackends.records[0],
    hash: (firstHash[0] === "0" ? "1" : "0") + firstHash.slice(1),
  } as BackendLifecycleRecord;

  return [
    {
      verifierId: "verify.web_search",
      toolName: "web_search",
      input: "weather today",
      wellFormed: ok({ mode: "real", query: "weather today", results: [{ title: "Weather", url: "https://example.com/weather" }] }),
      malformed: ok({ mode: "real", query: "weather today", results: [{ title: "Weather", url: "https://example.com/weather" }], note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.fetch_extract",
      toolName: "fetch_extract",
      input: URL_A,
      wellFormed: ok({ mode: "real", url: URL_A, extract: "text", content: "hello world", truncated: false }),
      malformed: ok({ mode: "real", url: URL_A, extract: "text", content: "hello world", truncated: false, note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.file_ops",
      toolName: "file_ops",
      input: "read relative/path.txt",
      wellFormed: ok({ mode: "real", op: "read", path: "relative/path.txt", result: "contents" }),
      malformed: ok({ mode: "real", op: "read", path: "relative/path.txt", result: "contents", note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.shell",
      toolName: "shell",
      input: "echo hi",
      wellFormed: ok({ mode: "real", cmd: "echo", args: ["hi"], code: 0, stdout: "hi\n", stderr: "", timedOut: false, truncated: false }),
      malformed: ok({ mode: "real", cmd: "echo", args: ["hi"], code: 0, stdout: "hi\n", stderr: "", timedOut: false, truncated: false, note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.http_request",
      toolName: "http_request",
      input: URL_A,
      wellFormed: ok({ mode: "real", method: "GET", url: URL_A, requestHeaders: {}, status: 200, headers: {}, body: "ok", truncated: false }),
      malformed: ok({ mode: "real", method: "GET", url: URL_A, requestHeaders: {}, status: 200, headers: {}, body: "ok", truncated: false, note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.image_gen",
      toolName: "image_gen",
      input: "a cat",
      wellFormed: ok({ mode: "real", prompt: "a cat", format: "png-base64", data: pngB64() }),
      malformed: ok({ mode: "real", prompt: "a cat", format: "png-base64", data: pngB64(), note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.tts",
      toolName: "tts",
      input: "hello",
      wellFormed: ok({ mode: "real", text: "hello", format: "mp3-base64", data: mp3B64(), durationMs: 500 }),
      malformed: ok({ mode: "real", text: "hello", format: "mp3-base64", data: mp3B64(), durationMs: 500, note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.vision_describe",
      toolName: "vision_describe",
      input: "irrelevant-for-real-mode",
      wellFormed: ok({ mode: "real", question: "what is this?", description: "A red car." }),
      malformed: ok({ mode: "real", question: "what is this?", description: "A red car.", note: "[mock] leaked marker" }),
    },
    {
      verifierId: "verify.browser",
      toolName: "browser",
      input: JSON.stringify({ op: "browse", url: URL_A }),
      wellFormed: ok(browserRealOutput()),
      malformed: ok(browserRealOutput({ note: "[mock] leaked marker" })),
    },
    {
      verifierId: "verify.backends",
      toolName: "backends",
      input: "{}",
      wellFormed: ok(goodBackends),
      malformed: ok(badBackends),
    },
  ];
}

const FIXTURES = buildToolFixtures();

// ---------------------------------------------------------------------------
// Coverage proof
// ---------------------------------------------------------------------------

describe("toolCallVerifiers coverage", () => {
  it("produces exactly one adapter per REAL toolVerifiers() key, with matching id", () => {
    const realIds = [...toolVerifiers().keys()].sort();
    const adapters = toolCallVerifiers();
    const adapterIds = adapters.map((a) => a.id).sort();
    expect(adapterIds).toEqual(realIds);
    expect(adapters.length).toBe(10);
  });

  it("every adapter's tier/prior deep-equals the real calibrationTable() entry", () => {
    const calib = calibrationTable();
    for (const adapter of toolCallVerifiers()) {
      const real = calib[adapter.id];
      expect(real).toBeDefined();
      expect(adapter.tier).toBe(real.tier);
      expect(adapter.prior).toBe(real.prior);
      expect(adapter.domain).toBe("tool");
      expect(adapter.version).toBe(ACTION_ADAPTER_VERSION);
    }
  });

  it("adding a hypothetical tool verifier upstream would add an adapter automatically (no hardcoded id list)", () => {
    // toolCallVerifiers() iterates the real toolVerifiers() map directly —
    // this test documents that invariant by cross-checking against the live
    // map's size rather than a literal count.
    expect(toolCallVerifiers().length).toBe(toolVerifiers().size);
  });
});

// ---------------------------------------------------------------------------
// Fidelity proof — adapter must reproduce the real verdict EXACTLY
// ---------------------------------------------------------------------------

describe("toolCallVerifiers fidelity", () => {
  for (const fx of FIXTURES) {
    describe(fx.verifierId, () => {
      it("reproduces the real verifier's verdict on a genuine well-formed output", () => {
        const real = toolVerifiers().get(fx.verifierId)!;
        const expected: ToolVerdict = real.verify(fx.input, fx.wellFormed);
        expect(expected.passed).toBe(true); // sanity: fixture really is well-formed

        const adapter = toolCallVerifiers().find((a) => a.id === fx.verifierId)!;
        const subject = toolSubject(fx.toolName, fx.input, fx.wellFormed);
        const adapted = adapter.verify(subject) as ReturnType<UniversalVerifier["verify"]>;
        const verdict = adapted as { passed: boolean; confidence: number; reasons: string[]; abstained: boolean };

        expect(verdict.passed).toBe(expected.passed);
        expect(verdict.confidence).toBe(expected.confidence);
        expect(verdict.reasons).toEqual(expected.reasons);
        expect(verdict.abstained).toBe(false);
      });

      it("reproduces the real verifier's verdict on a genuine mode-dishonest output", () => {
        const real = toolVerifiers().get(fx.verifierId)!;
        const expected: ToolVerdict = real.verify(fx.input, fx.malformed);
        expect(expected.passed).toBe(false); // sanity: fixture really is malformed

        const adapter = toolCallVerifiers().find((a) => a.id === fx.verifierId)!;
        const subject = toolSubject(fx.toolName, fx.input, fx.malformed);
        const adapted = adapter.verify(subject) as ReturnType<UniversalVerifier["verify"]>;
        const verdict = adapted as { passed: boolean; confidence: number; reasons: string[]; abstained: boolean };

        expect(verdict.passed).toBe(expected.passed);
        expect(verdict.confidence).toBe(expected.confidence);
        expect(verdict.reasons).toEqual(expected.reasons);
        expect(verdict.abstained).toBe(false);
      });

      it("reproduces the real verifier's verdict on result.ok === false (certain failure)", () => {
        const real = toolVerifiers().get(fx.verifierId)!;
        const failure = failed("tool blew up");
        const expected: ToolVerdict = real.verify(fx.input, failure);

        const adapter = toolCallVerifiers().find((a) => a.id === fx.verifierId)!;
        const subject = toolSubject(fx.toolName, fx.input, failure);
        const verdict = adapter.verify(subject) as { passed: boolean; confidence: number; reasons: string[] };

        expect(verdict.passed).toBe(expected.passed);
        expect(verdict.confidence).toBe(expected.confidence);
        expect(verdict.reasons).toEqual(expected.reasons);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// appliesTo — routing discipline
// ---------------------------------------------------------------------------

describe("toolCallVerifiers appliesTo", () => {
  it("applies only to its own tool name, within the tool domain", () => {
    const webSearch = toolCallVerifiers().find((a) => a.id === "verify.web_search")!;
    expect(webSearch.appliesTo(toolSubject("web_search", "q", undefined))).toBe(true);
    expect(webSearch.appliesTo(toolSubject("shell", "q", undefined))).toBe(false);
    expect(
      webSearch.appliesTo({ ...toolSubject("web_search", "q", undefined), domain: "memory" } as TrustSubject),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing-evidence discipline — never fabricate a pass, never throw
// ---------------------------------------------------------------------------

describe("toolCallVerifiers missing-evidence discipline", () => {
  const webSearch = toolCallVerifiers().find((a) => a.id === "verify.web_search")!;

  it("abstains when evidence.toolResult is absent", () => {
    const subject = toolSubject("web_search", "q", undefined);
    const v = webSearch.verify(subject) as { passed: boolean; confidence: number; abstained: boolean; reasons: string[] };
    expect(v.passed).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.abstained).toBe(true);
    expect(v.reasons).toEqual(["TOOL_RESULT_MISSING_OR_INVALID"]);
  });

  it("abstains when evidence.toolResult is wrong-typed", () => {
    const subject: TrustSubject = {
      domain: "tool",
      subjectId: "web_search",
      taskId: "t",
      input: "q",
      output: "",
      evidence: { toolResult: "not-a-tool-result" },
      trace: [],
    };
    const v = webSearch.verify(subject) as { passed: boolean; abstained: boolean; reasons: string[] };
    expect(v.passed).toBe(false);
    expect(v.abstained).toBe(true);
    expect(v.reasons).toEqual(["TOOL_RESULT_MISSING_OR_INVALID"]);
  });

  it("abstains, never throws, when the subject is routed to the wrong tool's adapter", () => {
    const subject = toolSubject("shell", "echo hi", ok({ mode: "real", cmd: "echo", args: [], code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }));
    expect(() => webSearch.verify(subject)).not.toThrow();
    const v = webSearch.verify(subject) as { abstained: boolean; reasons: string[] };
    expect(v.abstained).toBe(true);
    expect(v.reasons).toEqual(["SUBJECT_TOOL_MISMATCH"]);
  });

  it("abstains on a wrong-domain subject", () => {
    const subject = { ...toolSubject("web_search", "q", undefined), domain: "memory" } as TrustSubject;
    const v = webSearch.verify(subject) as { abstained: boolean; reasons: string[] };
    expect(v.abstained).toBe(true);
    expect(v.reasons).toEqual(["SUBJECT_DOMAIN_MISMATCH"]);
  });
});

// ---------------------------------------------------------------------------
// execProvenanceVerifier
// ---------------------------------------------------------------------------

const TOOLS = ["fs.read", "fs.write", "exec.shell", "net.fetch", "json.parse"];
const ERRORS: ToolRpcErrorCode[] = ["unknown_tool", "not_allowed", "tool_error", "timeout", "malformed_request"];

function ev(seq: number, overrides: Partial<ProvenanceEvent> = {}): ProvenanceEvent {
  const okFlag = seq % 7 !== 0;
  const base: ProvenanceEvent = {
    seq,
    tool: TOOLS[seq % TOOLS.length],
    inputSha256: sha256Hex(`input-${seq}`),
    outputSha256: sha256Hex(`output-${seq}`),
    ok: okFlag,
    startedAt: 1_700_000_000_000 + seq * 100,
    elapsedMs: 10 + (seq % 50),
  };
  if (!okFlag) (base as { error?: ToolRpcErrorCode }).error = ERRORS[seq % ERRORS.length];
  return { ...base, ...overrides };
}

function buildLedger(n: number): ProvenanceLedger {
  const ledger = new ProvenanceLedger();
  for (let i = 1; i <= n; i++) ledger.append(ev(i));
  return ledger;
}

function provenanceSubject(ledgerJSON: unknown): TrustSubject {
  return {
    domain: "tool",
    subjectId: "run-1",
    taskId: "t1",
    input: "",
    output: "",
    evidence: ledgerJSON === undefined ? {} : { ledgerJSON },
    trace: [],
  };
}

describe("execProvenanceVerifier", () => {
  it("has id verify.exec-provenance, domain tool, and a prior at/below the highest existing T4 prior (0.72)", () => {
    const v = execProvenanceVerifier();
    expect(v.id).toBe("verify.exec-provenance");
    expect(v.domain).toBe("tool");
    expect(v.tier).toBe("T4-consistency");
    expect(v.prior).toBeLessThanOrEqual(0.72);
    expect(v.prior).toBe(execProvenanceCalibration().prior);
  });

  it("passes a genuinely valid ledger chain built via the real append() path", () => {
    const ledger = buildLedger(8);
    const v = execProvenanceVerifier();
    const verdict = v.verify(provenanceSubject(ledger.toJSON())) as { passed: boolean; abstained: boolean; reasons: string[] };
    expect(verdict.passed).toBe(true);
    expect(verdict.abstained).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it("fails and reports the real firstBadSeq on a flipped byte (hash mismatch)", () => {
    const ledger = buildLedger(5);
    const parsed = JSON.parse(ledger.toJSON());
    // Flip one hex character of a mid-chain record's recordSha256.
    const rec = parsed.records[2];
    rec.recordSha256 = (rec.recordSha256[0] === "0" ? "1" : "0") + rec.recordSha256.slice(1);
    const tampered = JSON.stringify(parsed);

    const real = ProvenanceLedger.verifyJSON(tampered);
    expect(real.ok).toBe(false);
    expect(real.reason).toBe("hash_mismatch");

    const v = execProvenanceVerifier();
    const verdict = v.verify(provenanceSubject(tampered)) as { passed: boolean; reasons: string[] };
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toContain("LEDGER_HASH_MISMATCH");
    expect(verdict.reasons[0]).toContain(`firstBadSeq=${real.firstBadSeq}`);
  });

  it("fails on a spliced (deleted) record — chain_break", () => {
    const ledger = buildLedger(6);
    const parsed = JSON.parse(ledger.toJSON());
    parsed.records.splice(2, 1); // delete the third record, splicing the rest together
    const tampered = JSON.stringify(parsed);

    const real = ProvenanceLedger.verifyJSON(tampered);
    expect(real.ok).toBe(false);

    const v = execProvenanceVerifier();
    const verdict = v.verify(provenanceSubject(tampered)) as { passed: boolean; reasons: string[] };
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toContain(real.reason === "seq_gap" ? "LEDGER_SEQ_GAP" : "LEDGER_CHAIN_BREAK");
  });

  it("fails on a seq gap (duplicated seq)", () => {
    const ledger = buildLedger(4);
    const parsed = JSON.parse(ledger.toJSON());
    parsed.records[3].event.seq = parsed.records[2].event.seq; // duplicate seq, creating a gap after
    const tampered = JSON.stringify(parsed);

    const v = execProvenanceVerifier();
    const verdict = v.verify(provenanceSubject(tampered)) as { passed: boolean; reasons: string[] };
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.length).toBe(1);
  });

  it("abstains (never throws) when evidence.ledgerJSON is absent or wrong-typed", () => {
    const v = execProvenanceVerifier();
    const missing = v.verify(provenanceSubject(undefined)) as { abstained: boolean; reasons: string[] };
    expect(missing.abstained).toBe(true);
    expect(missing.reasons).toEqual(["LEDGER_JSON_MISSING_OR_INVALID"]);

    expect(() => v.verify(provenanceSubject(12345))).not.toThrow();
    const wrongTyped = v.verify(provenanceSubject(12345)) as { abstained: boolean };
    expect(wrongTyped.abstained).toBe(true);
  });

  it("abstains, never throws, on garbage (non-JSON) ledgerJSON", () => {
    const v = execProvenanceVerifier();
    expect(() => v.verify(provenanceSubject("{not json"))).not.toThrow();
    const verdict = v.verify(provenanceSubject("{not json")) as { passed: boolean; reasons: string[] };
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toContain("LEDGER_MALFORMED");
  });

  it("appliesTo is false for a non-tool domain or missing ledgerJSON", () => {
    const v = execProvenanceVerifier();
    expect(v.appliesTo(provenanceSubject(buildLedger(1).toJSON()))).toBe(true);
    expect(v.appliesTo(provenanceSubject(undefined))).toBe(false);
    expect(v.appliesTo({ ...provenanceSubject(buildLedger(1).toJSON()), domain: "memory" } as TrustSubject)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// actionVerifiers — the union
// ---------------------------------------------------------------------------

describe("actionVerifiers", () => {
  it("is toolCallVerifiers() plus execProvenanceVerifier() — 11 verifiers total", () => {
    const all = actionVerifiers();
    expect(all.length).toBe(11);
    expect(all.filter((v) => v.id === "verify.exec-provenance").length).toBe(1);
    expect(new Set(all.map((v) => v.id)).size).toBe(11); // no duplicate ids
  });

  it("registers cleanly into the real VerifierRegistry and fuses a genuine passing tool call", async () => {
    const registry = new VerifierRegistry();
    registry.registerAll(actionVerifiers());

    const fx = FIXTURES.find((f) => f.verifierId === "verify.web_search")!;
    const subject: TrustSubject = {
      domain: "tool",
      subjectId: "web_search",
      taskId: "t1",
      input: fx.input,
      output: "",
      evidence: { toolResult: fx.wellFormed },
      trace: [],
    };
    const fused = await registry.verify(subject);
    expect(fused.domain).toBe("tool");
    expect(fused.degraded).toBe(true); // exactly one applicable verifier for this subjectId
    expect(fused.degradedReason).toBe("single-verifier");
    expect(fused.verdicts.some((v) => v.verifierId === "verify.web_search" && v.passed)).toBe(true);
  });
});
