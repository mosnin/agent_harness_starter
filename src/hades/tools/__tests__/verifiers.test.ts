import { describe, it, expect } from "vitest";
import { toolVerifiers, calibrationTable, type ToolVerdict } from "../verifiers";
import { WeakVerifierEnsemble, type VerifierVote } from "../../styx/tiers";
import type { ToolResult } from "../../agent/tools";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngB64(withMagic: boolean, tailBytes = 16): string {
  const tail = Buffer.alloc(tailBytes, 0x01);
  const buf = withMagic ? Buffer.concat([PNG_MAGIC, tail]) : Buffer.concat([Buffer.from("NOTPNG!!"), tail]);
  return buf.toString("base64");
}

/** Build a real, well-formed 16-bit mono PCM WAV buffer of exactly
 *  `durationMs`, at `sampleRate` Hz, so `byteRate`/`dataSize` genuinely
 *  determine the duration (used to build both consistent and inconsistent
 *  `tts` fixtures against the SAME real WAV-parsing math the verifier uses). */
function buildWavBuffer(durationMs: number, sampleRate = 8000): Buffer {
  const bytesPerSample = 2;
  const channels = 1;
  const numSamples = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = numSamples * bytesPerSample * channels;
  const byteRate = sampleRate * bytesPerSample * channels;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(bytesPerSample * channels, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function wavB64(durationMs: number, sampleRate = 8000): string {
  return buildWavBuffer(durationMs, sampleRate).toString("base64");
}

function actualWavDurationMs(durationMs: number, sampleRate = 8000): number {
  const buf = buildWavBuffer(durationMs, sampleRate);
  const byteRate = buf.readUInt32LE(28);
  const dataSize = buf.readUInt32LE(40);
  return (dataSize / byteRate) * 1000;
}

function ok(output: unknown): ToolResult {
  return { ok: true, output: JSON.stringify(output) };
}

function okRaw(output: string): ToolResult {
  return { ok: true, output };
}

function failed(output = "boom"): ToolResult {
  return { ok: false, output };
}

function verdictFor(verifierId: string, input: string, result: ToolResult): ToolVerdict {
  const v = toolVerifiers().get(verifierId);
  if (!v) throw new Error(`no verifier registered for ${verifierId}`);
  return v.verify(input, result);
}

// ---------------------------------------------------------------------------
// toolVerifiers() / calibrationTable() shape + honesty
// ---------------------------------------------------------------------------

const EXPECTED_VERIFIER_IDS = [
  "verify.web_search",
  "verify.fetch_extract",
  "verify.file_ops",
  "verify.shell",
  "verify.http_request",
  "verify.image_gen",
  "verify.tts",
  "verify.vision_describe",
].sort();

describe("toolVerifiers()", () => {
  it("registers exactly the eight locked verifierIds", () => {
    const ids = [...toolVerifiers().keys()].sort();
    expect(ids).toEqual(EXPECTED_VERIFIER_IDS);
  });

  it("every verifier's own verifierId matches its map key and toolName is set", () => {
    for (const [key, v] of toolVerifiers()) {
      expect(v.verifierId).toBe(key);
      expect(v.toolName.length).toBeGreaterThan(0);
      expect(key).toBe(`verify.${v.toolName}`);
    }
  });
});

describe("calibrationTable() honesty", () => {
  const table = calibrationTable();

  it("has exactly the same keys as toolVerifiers(), no more, no fewer", () => {
    expect(Object.keys(table).sort()).toEqual(EXPECTED_VERIFIER_IDS);
  });

  it("never claims T0-execution or T1-reference for a format-checking stub", () => {
    for (const [id, entry] of Object.entries(table)) {
      expect(entry.tier, `${id} tier`).not.toBe("T0-execution");
      expect(entry.tier, `${id} tier`).not.toBe("T1-reference");
    }
  });

  it("every prior is in (0,1]", () => {
    for (const [id, entry] of Object.entries(table)) {
      expect(entry.prior, `${id} prior`).toBeGreaterThan(0);
      expect(entry.prior, `${id} prior`).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Universal ok:false / unparsable-output handling
// ---------------------------------------------------------------------------

describe("universal failure handling", () => {
  it("ok:false ToolResult yields passed:false with certain confidence, for every verifier", () => {
    for (const [id, v] of toolVerifiers()) {
      const verdict = v.verify("irrelevant input", failed("some real failure message"));
      expect(verdict.passed, id).toBe(false);
      expect(verdict.confidence, id).toBeGreaterThanOrEqual(0.9);
      expect(verdict.reasons, id).toContain("TOOL_REPORTED_FAILURE");
    }
  });

  it("unparsable JSON output fails with JSON_PARSE_ERROR and near-certain confidence", () => {
    const verdict = verdictFor("verify.web_search", "q", okRaw("not json at all {{{"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(["JSON_PARSE_ERROR"]);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("a JSON array (not object) output fails with JSON_NOT_OBJECT", () => {
    const verdict = verdictFor("verify.file_ops", "{}", okRaw("[1,2,3]"));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(["JSON_NOT_OBJECT"]);
  });

  it("verification is deterministic: identical input/result -> identical verdict", () => {
    const input = "styx";
    const result = ok({
      mode: "real",
      query: "styx",
      results: [{ title: "Styx docs", url: "https://example.com/styx", snippet: "docs" }],
    });
    const v1 = verdictFor("verify.web_search", input, result);
    const v2 = verdictFor("verify.web_search", input, result);
    expect(v2).toEqual(v1);
  });
});

// ---------------------------------------------------------------------------
// verify.web_search
// ---------------------------------------------------------------------------

describe("verify.web_search", () => {
  it("passes a conforming mock output", () => {
    const verdict = verdictFor(
      "verify.web_search",
      "hades",
      ok({
        mode: "mock",
        query: "hades",
        results: [
          {
            title: '[mock] Result 1 for "hades" (aabbccdd)',
            url: "https://mock.invalid/search/hades/aabbccdd",
            snippet: '[mock] Deterministic placeholder result #1 for query "hades".',
          },
        ],
      })
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.confidence).toBeGreaterThan(0);
  });

  it("passes a conforming real output", () => {
    const verdict = verdictFor(
      "verify.web_search",
      "hades",
      ok({
        mode: "real",
        query: "hades",
        results: [{ title: "Hades (video game)", url: "https://example.com/hades", snippet: "an action roguelike" }],
      })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: claims real but a result title carries the mock marker -> MODE_MISMATCH", () => {
    const verdict = verdictFor(
      "verify.web_search",
      "hades",
      ok({
        mode: "real",
        query: "hades",
        results: [{ title: '[mock] fabricated real-looking result', url: "https://example.com/x", snippet: "s" }],
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MODE_MISMATCH");
  });

  it("HOSTILE: results is not an array -> RESULTS_NOT_ARRAY", () => {
    const verdict = verdictFor("verify.web_search", "hades", ok({ mode: "real", query: "hades", results: "oops" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("RESULTS_NOT_ARRAY");
  });

  it("HOSTILE: mock mode but url is not under mock.invalid -> MOCK_URL_NOT_UNDER_MOCK_INVALID", () => {
    const verdict = verdictFor(
      "verify.web_search",
      "hades",
      ok({
        mode: "mock",
        query: "hades",
        results: [{ title: "[mock] result", url: "https://real-looking-domain.example/hades", snippet: "[mock] s" }],
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MOCK_URL_NOT_UNDER_MOCK_INVALID");
  });

  it("HOSTILE: a result has an empty title and an unparseable url -> RESULT_TITLE_OR_URL_INVALID", () => {
    const verdict = verdictFor(
      "verify.web_search",
      "hades",
      ok({ mode: "real", query: "hades", results: [{ title: "", url: "not-a-url" }] })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("RESULT_TITLE_OR_URL_INVALID");
  });
});

// ---------------------------------------------------------------------------
// verify.fetch_extract
// ---------------------------------------------------------------------------

describe("verify.fetch_extract", () => {
  it("passes a conforming output within the default maxBytes", () => {
    const verdict = verdictFor(
      "verify.fetch_extract",
      "https://example.com",
      ok({ mode: "real", url: "https://example.com", extract: "text", content: "hello world", truncated: false })
    );
    expect(verdict.passed).toBe(true);
  });

  it("passes a conforming mock output", () => {
    const verdict = verdictFor(
      "verify.fetch_extract",
      "https://example.com",
      ok({
        mode: "mock",
        url: "https://example.com",
        extract: "title",
        content: "[mock] Fixture for https://example.com",
        truncated: false,
      })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE truncation lie: truncated:false but content exceeds the input's maxBytes -> CONTENT_EXCEEDS_MAXBYTES", () => {
    const bigContent = "x".repeat(500);
    const verdict = verdictFor(
      "verify.fetch_extract",
      JSON.stringify({ url: "https://example.com", maxBytes: 10 }),
      ok({ mode: "real", url: "https://example.com", extract: "text", content: bigContent, truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("CONTENT_EXCEEDS_MAXBYTES");
  });

  it("HOSTILE money case: claims real but content carries the mock marker -> MODE_MISMATCH", () => {
    const verdict = verdictFor(
      "verify.fetch_extract",
      "https://example.com",
      ok({
        mode: "real",
        url: "https://example.com",
        extract: "text",
        content: "[mock] this is secretly a mock fixture pretending to be real",
        truncated: false,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MODE_MISMATCH");
  });

  it("HOSTILE: invalid extract field -> EXTRACT_FIELD_INVALID", () => {
    const verdict = verdictFor(
      "verify.fetch_extract",
      "https://example.com",
      ok({ mode: "real", url: "https://example.com", extract: "bogus", content: "hi", truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("EXTRACT_FIELD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// verify.file_ops
// ---------------------------------------------------------------------------

describe("verify.file_ops", () => {
  it("passes a conforming, root-relative output", () => {
    const verdict = verdictFor(
      "verify.file_ops",
      JSON.stringify({ op: "read", path: "sub/dir/file.txt" }),
      ok({ mode: "real", op: "read", path: "sub/dir/file.txt", result: "file contents" })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: path is absolute -> PATH_ABSOLUTE", () => {
    const verdict = verdictFor(
      "verify.file_ops",
      JSON.stringify({ op: "read", path: "/etc/passwd" }),
      ok({ mode: "real", op: "read", path: "/etc/passwd", result: "root:x:0:0..." })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("PATH_ABSOLUTE");
  });

  it("HOSTILE money case: path escapes via '..' -> PATH_CONTAINS_DOTDOT", () => {
    const verdict = verdictFor(
      "verify.file_ops",
      JSON.stringify({ op: "read", path: "a/../../etc/passwd" }),
      ok({ mode: "real", op: "read", path: "a/../../etc/passwd", result: "leaked" })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("PATH_CONTAINS_DOTDOT");
  });

  it("HOSTILE: op field missing -> OP_MISSING", () => {
    const verdict = verdictFor(
      "verify.file_ops",
      JSON.stringify({ path: "sub/file.txt" }),
      ok({ mode: "real", path: "sub/file.txt", result: "x" })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("OP_MISSING");
  });

  it("HOSTILE: claims real but result text carries the mock marker -> MODE_MISMATCH", () => {
    const verdict = verdictFor(
      "verify.file_ops",
      JSON.stringify({ op: "read", path: "a.txt" }),
      ok({ mode: "real", op: "read", path: "a.txt", result: "[mock] fabricated file contents" })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MODE_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// verify.shell
// ---------------------------------------------------------------------------

describe("verify.shell", () => {
  it("passes a conforming output", () => {
    const verdict = verdictFor(
      "verify.shell",
      "echo hi",
      ok({ mode: "real", cmd: "echo", args: ["hi"], code: 0, stdout: "hi\n", stderr: "", timedOut: false, truncated: false })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE: code is a string, not an integer -> CODE_INVALID", () => {
    const verdict = verdictFor(
      "verify.shell",
      "echo hi",
      ok({ mode: "real", cmd: "echo", args: ["hi"], code: "0", stdout: "hi\n", stderr: "", timedOut: false, truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("CODE_INVALID");
  });

  it("HOSTILE: timedOut is not boolean -> TIMEDOUT_NOT_BOOLEAN", () => {
    const verdict = verdictFor(
      "verify.shell",
      "echo hi",
      ok({ mode: "real", cmd: "echo", args: ["hi"], code: 0, stdout: "hi\n", stderr: "", timedOut: "false", truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("TIMEDOUT_NOT_BOOLEAN");
  });

  it("HOSTILE: args is not a string array -> ARGS_NOT_STRING_ARRAY", () => {
    const verdict = verdictFor(
      "verify.shell",
      "echo hi",
      ok({ mode: "real", cmd: "echo", args: [1, 2, 3], code: 0, stdout: "", stderr: "", timedOut: false, truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("ARGS_NOT_STRING_ARRAY");
  });
});

// ---------------------------------------------------------------------------
// verify.http_request
// ---------------------------------------------------------------------------

describe("verify.http_request", () => {
  it("passes a conforming output with a redacted authorization header", () => {
    const verdict = verdictFor(
      "verify.http_request",
      JSON.stringify({ method: "GET", url: "https://example.com", headers: { authorization: "secret" } }),
      ok({
        mode: "real",
        method: "GET",
        url: "https://example.com",
        requestHeaders: { authorization: "[redacted]", "x-foo": "bar" },
        status: 200,
        headers: {},
        body: "ok",
        truncated: false,
      })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: authorization header value leaks through unredacted -> HEADER_LEAK", () => {
    const verdict = verdictFor(
      "verify.http_request",
      JSON.stringify({ method: "GET", url: "https://example.com", headers: { authorization: "Bearer sk-live-abc123" } }),
      ok({
        mode: "real",
        method: "GET",
        url: "https://example.com",
        requestHeaders: { authorization: "Bearer sk-live-abc123" },
        status: 200,
        headers: {},
        body: "ok",
        truncated: false,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("HEADER_LEAK");
  });

  it("HOSTILE: cookie header value leaks through unredacted -> HEADER_LEAK", () => {
    const verdict = verdictFor(
      "verify.http_request",
      JSON.stringify({ method: "GET", url: "https://example.com" }),
      ok({
        mode: "real",
        method: "GET",
        url: "https://example.com",
        requestHeaders: { cookie: "session=deadbeef; secret=1" },
        status: 200,
        headers: {},
        body: "ok",
        truncated: false,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("HEADER_LEAK");
  });

  it("HOSTILE: requestHeaders field missing entirely -> REQUEST_HEADERS_MISSING", () => {
    const verdict = verdictFor(
      "verify.http_request",
      JSON.stringify({ method: "GET", url: "https://example.com" }),
      ok({ mode: "real", method: "GET", url: "https://example.com", status: 200, headers: {}, body: "ok", truncated: false })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("REQUEST_HEADERS_MISSING");
  });
});

// ---------------------------------------------------------------------------
// verify.image_gen
// ---------------------------------------------------------------------------

const IMAGE_GEN_MOCK_NOTE = "[mock] procedurally generated placeholder — no image model was called";

describe("verify.image_gen", () => {
  it("passes a conforming, well-formed mock SVG output (the shipped mock shape)", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "a red circle on white background",
      ok({
        mode: "mock",
        prompt: "a red circle on white background",
        format: "svg",
        data: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
        note: IMAGE_GEN_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("passes a conforming, valid real PNG output (the shipped real shape)", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "a blue square",
      ok({ mode: "real", prompt: "a blue square", format: "png-base64", data: pngB64(true) })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: svg tags don't balance -> SVG_TAGS_UNBALANCED", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "broken svg",
      ok({
        mode: "mock",
        prompt: "broken svg",
        format: "svg",
        data: "<svg><rect><circle></svg>",
        note: IMAGE_GEN_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("SVG_TAGS_UNBALANCED");
  });

  it("HOSTILE: png data is not valid base64 -> PNG_BASE64_INVALID", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "invalid base64",
      ok({ mode: "real", prompt: "x", format: "png-base64", data: "not-valid-base64!!!" })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("PNG_BASE64_INVALID");
  });

  it("HOSTILE: png base64 decodes but lacks the PNG magic header -> PNG_MAGIC_INVALID", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "wrong magic",
      ok({ mode: "real", prompt: "x", format: "png-base64", data: pngB64(false) })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("PNG_MAGIC_INVALID");
  });

  it("HOSTILE: a mock SVG relabelled as a real result -> REAL_FORMAT_NOT_PNG", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "relabelled",
      ok({
        mode: "real",
        prompt: "relabelled",
        format: "svg",
        data: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>',
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("REAL_FORMAT_NOT_PNG");
  });

  it("HOSTILE: a PNG claimed as mock output (the shipped mock can only render SVG) -> MOCK_FORMAT_NOT_SVG", () => {
    const verdict = verdictFor(
      "verify.image_gen",
      "impossible mock",
      ok({ mode: "mock", prompt: "impossible mock", format: "png-base64", data: pngB64(true), note: IMAGE_GEN_MOCK_NOTE })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MOCK_FORMAT_NOT_SVG");
  });
});

// ---------------------------------------------------------------------------
// verify.tts
// ---------------------------------------------------------------------------

const TTS_MOCK_NOTE = "[mock] procedurally synthesized tone sequence — no speech model was called";

/** A minimal but genuinely MP3-shaped payload: an ID3v2 header followed by
 *  filler bytes — enough for the verifier's container sniff, built by hand. */
function mp3B64(): string {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a]);
  return Buffer.concat([id3, Buffer.alloc(32, 0x00)]).toString("base64");
}

describe("verify.tts", () => {
  it("passes a conforming mock WAV output whose durationMs matches the real header math", () => {
    const durationMs = actualWavDurationMs(1000);
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "mock", text: "hello world", format: "wav-base64", data: wavB64(1000), durationMs, note: TTS_MOCK_NOTE })
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("passes a conforming real MP3 output (the shipped real shape)", () => {
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "real", text: "hello world", format: "mp3-base64", data: mp3B64(), durationMs: 1234 })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: base64 decodes to bytes that do not start RIFF...WAVE -> WAV_MAGIC_INVALID", () => {
    const notAudio = Buffer.from("hello world this is definitely not audio data at all").toString("base64");
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "mock", text: "hello world", format: "wav-base64", data: notAudio, durationMs: 1000, note: TTS_MOCK_NOTE })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("WAV_MAGIC_INVALID");
  });

  it("HOSTILE: data is not valid base64 -> AUDIO_BASE64_INVALID", () => {
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "real", text: "hello world", format: "mp3-base64", data: "###not-base64###", durationMs: 1000 })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("AUDIO_BASE64_INVALID");
  });

  it("HOSTILE: durationMs is wildly inconsistent with the real WAV header math -> DURATION_INCONSISTENT", () => {
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "mock", text: "hello world", format: "wav-base64", data: wavB64(1000), durationMs: 50000, note: TTS_MOCK_NOTE })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("DURATION_INCONSISTENT");
  });

  it("HOSTILE: mock WAV relabelled as a real result -> REAL_FORMAT_NOT_MP3", () => {
    const durationMs = actualWavDurationMs(500);
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "real", text: "hello world", format: "wav-base64", data: wavB64(500), durationMs })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("REAL_FORMAT_NOT_MP3");
  });

  it("HOSTILE: data claims mp3-base64 but decodes to neither ID3 nor a frame sync -> MP3_MAGIC_INVALID", () => {
    const notMp3 = Buffer.from("just some text bytes, definitely not mpeg audio").toString("base64");
    const verdict = verdictFor(
      "verify.tts",
      "hello world",
      ok({ mode: "real", text: "hello world", format: "mp3-base64", data: notMp3, durationMs: 1000 })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MP3_MAGIC_INVALID");
  });
});

// ---------------------------------------------------------------------------
// verify.vision_describe
// ---------------------------------------------------------------------------

function shippedMockDescription(format: string, dimensions: string, byteLength: number): string {
  return `[mock] byte-level analysis only — no vision model was called: format=${format}, dimensions=${dimensions}, byteLength=${byteLength}`;
}

const VISION_MOCK_NOTE = "[mock] byte-level analysis only — no vision model was called";

/** 1024 opaque bytes as base64 — the tool input a mock verdict is checked against. */
const VISION_INPUT_B64 = Buffer.alloc(1024, 0x2a).toString("base64");

describe("verify.vision_describe", () => {
  it("passes a conforming mock output using exactly the shipped byte-derived phrase set", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      VISION_INPUT_B64,
      ok({
        mode: "mock",
        question: "Describe this image in detail.",
        description: shippedMockDescription("unknown", "unknown", 1024),
        note: VISION_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("passes a conforming real output (free-form description allowed)", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      JSON.stringify({ imageBase64: VISION_INPUT_B64, question: "describe this image" }),
      ok({ mode: "real", question: "describe this image", description: "A red bicycle leaning against a brick wall." })
    );
    expect(verdict.passed).toBe(true);
  });

  it("HOSTILE money case: mock description fabricates color/object content -> MOCK_FABRICATED_CONTENT", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      VISION_INPUT_B64,
      ok({
        mode: "mock",
        question: "Describe this image in detail.",
        description: shippedMockDescription("unknown", "unknown", 1024) + " It shows a red car in a driveway.",
        note: VISION_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MOCK_FABRICATED_CONTENT");
  });

  it("HOSTILE: mock description doesn't use the locked template at all -> MOCK_DESCRIPTION_NOT_LOCKED_FORMAT", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      VISION_INPUT_B64,
      ok({
        mode: "mock",
        question: "Describe this image in detail.",
        description: "[mock] this is a cat sitting on a green chair",
        note: VISION_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MOCK_DESCRIPTION_NOT_LOCKED_FORMAT");
  });

  it("HOSTILE: locked-format mock description whose claimed byteLength disagrees with the tool's own input -> MOCK_LENGTH_MISMATCH", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      VISION_INPUT_B64, // decodes to exactly 1024 bytes
      ok({
        mode: "mock",
        question: "Describe this image in detail.",
        description: shippedMockDescription("unknown", "unknown", 999),
        note: VISION_MOCK_NOTE,
      })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("MOCK_LENGTH_MISMATCH");
  });

  it("HOSTILE: question field missing from the output -> QUESTION_NOT_STRING", () => {
    const verdict = verdictFor(
      "verify.vision_describe",
      VISION_INPUT_B64,
      ok({ mode: "real", description: "An abstract pattern." })
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("QUESTION_NOT_STRING");
  });
});

// ---------------------------------------------------------------------------
// Ensemble integration: a seeded batch of honest + dishonest verdict streams
// must down-weight the dishonest source (weight ordering, no fabricated
// thresholds beyond the algorithm's own documented neutral-init value 0.5).
// ---------------------------------------------------------------------------

describe("WeakVerifierEnsemble integration with real ToolVerdicts", () => {
  it("down-weights a systematically dishonest verifier relative to honest ones", () => {
    // Twelve real, hand-built (web_search / file_ops alternating) fixtures —
    // six conforming (ground truth: pass), six hostile (ground truth: fail).
    // "honest-a"/"honest-b" report the REAL verifier's verdict; "dishonest"
    // always reports the opposite.
    type Fixture = { verifierId: string; input: string; result: ToolResult };
    const fixtures: Fixture[] = [];
    for (let i = 0; i < 6; i++) {
      fixtures.push({
        verifierId: "verify.web_search",
        input: `q${i}`,
        result: ok({
          mode: "real",
          query: `q${i}`,
          results: [{ title: `Result ${i}`, url: `https://example.com/${i}`, snippet: "s" }],
        }),
      });
      fixtures.push({
        verifierId: "verify.file_ops",
        input: JSON.stringify({ op: "read", path: `/etc/passwd${i}` }),
        result: ok({ mode: "real", op: "read", path: `/etc/passwd${i}`, result: "leaked" }),
      });
    }

    const votes: VerifierVote[][] = fixtures.map((f) => {
      const truth = verdictFor(f.verifierId, f.input, f.result).passed;
      return [
        { verifierId: "honest-a", passed: truth },
        { verifierId: "honest-b", passed: truth },
        { verifierId: "dishonest", passed: !truth },
      ];
    });

    // Sanity: the fixtures actually produced a genuine mix of pass/fail
    // ground truth (all six file_ops fixtures are absolute-path violations,
    // all six web_search fixtures are conforming) — otherwise this test
    // would trivially pass without exercising real disagreement.
    const truths = votes.map((item) => item.find((v) => v.verifierId === "honest-a")!.passed);
    expect(truths.some((t) => t)).toBe(true);
    expect(truths.some((t) => !t)).toBe(true);

    const ensemble = new WeakVerifierEnsemble();
    ensemble.fitPredict(votes);
    const weights = ensemble.reliabilities();

    // Weight ORDERING, not a fabricated numeric threshold: both honest
    // sources must outrank the dishonest one, and the dishonest source must
    // sit at or below the algorithm's own neutral 0.5 init value.
    expect(weights["honest-a"]).toBeGreaterThan(weights["dishonest"]);
    expect(weights["honest-b"]).toBeGreaterThan(weights["dishonest"]);
    expect(weights["dishonest"]).toBeLessThanOrEqual(0.5);
    expect(weights["honest-a"]).toBeGreaterThan(0.5);
    expect(weights["honest-b"]).toBeGreaterThan(0.5);
  });
});
