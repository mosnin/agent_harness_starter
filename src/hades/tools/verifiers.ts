/**
 * STYX verifier stubs for the eight new catalog tools.
 *
 * Every verifier here checks *output format*, not *implementation* — it never
 * imports `web-search.ts` / `fetch-extract.ts` / `file-ops.ts` / `shell.ts` /
 * `http.ts` (other teams' files) or anything from `../tools/catalog`. Instead
 * each verifier is a deterministic, pure structural check against the LOCKED
 * JSON contract for its tool, built from `result.output` and (where the
 * contract needs it, e.g. `fetch_extract`'s `maxBytes`) the original `input`
 * string alone. This keeps the module honest about what it can attest to: it
 * can prove an output is well-formed and internally consistent (mode-honesty,
 * byte budgets, no leaked secrets, decodable binary payloads); it CANNOT
 * prove an output is *true* (a "real" web_search result full of plausible
 * fabricated titles passes every check here). That is why every entry in
 * `calibrationTable()` is honestly labelled T4-consistency, never T0/T1 — see
 * the tier docstring below and `../styx/tiers.ts`'s own tier documentation.
 *
 * ---------------------------------------------------------------------------
 * Tool output contracts checked here
 * ---------------------------------------------------------------------------
 * Five of the eight tools (`web_search`, `fetch_extract`, `file_ops`, `shell`,
 * `http_request`) already have real implementations elsewhere in this build
 * (`web-search.ts`, `fetch-extract.ts`, `file-ops.ts`, `shell.ts`, `http.ts`)
 * and this file's checks are written to match those tools' actual, shipped
 * JSON shapes exactly (read, not imported, per the no-cross-team-import rule).
 *
 * The remaining three (`image_gen`, `tts`, `vision_describe`) shipped real
 * implementations in the same cycle (`image-gen.ts`, `tts.ts`, `vision.ts`);
 * their checks below were reconciled during central integration to match
 * those tools' actual, shipped JSON shapes exactly (again read, not
 * imported), including the shipped real-vs-mock format coupling: `image_gen`
 * is always `png-base64` in real mode and `svg` in mock mode; `tts` is
 * always `mp3-base64` in real mode and `wav-base64` in mock mode. A
 * mode/format combination the shipped tool can never produce is therefore
 * treated as evidence of a relabelled (fabricated) result.
 *
 *   web_search       { mode, query, results: [{ title, url, snippet }] }
 *   fetch_extract     { mode, url, extract, content, truncated }
 *   file_ops          { mode, op, path, result?, truncated?, error? }
 *   shell              { mode, cmd, args, code, stdout, stderr, timedOut, truncated }
 *                       (or, on a policy/parse failure: { mode, error, ... })
 *   http_request       { mode, method, url, requestHeaders, status?, headers?,
 *                         body?, truncated?, error? }
 *   image_gen          { mode, prompt, format: "png-base64"|"svg", data, note? }
 *   tts                { mode, text, format: "mp3-base64"|"wav-base64", data,
 *                         durationMs, note? }
 *   vision_describe    { mode, question, description, note? } — a mock
 *                       description must follow the shipped byte-derived
 *                       template exactly (format/dimensions/byteLength only,
 *                       cross-checked against the tool's own base64 input)
 *
 * ---------------------------------------------------------------------------
 * Calibration math
 * ---------------------------------------------------------------------------
 * For an `ok:true` result whose output parses as a single JSON object, each
 * verifier runs a fixed checklist of independent boolean checks (mode
 * validity, mode-honesty, and the tool's own structural checks). Confidence
 * is the fraction of checks that passed, DAMPED (multiplicatively) by the
 * tool's calibrated prior from `calibrationTable()`:
 *
 *     confidence = clamp01( (passedChecks / totalChecks) * prior )
 *
 * The prior is the calibrated CEILING this class of check can ever claim —
 * even a perfect pass (fraction = 1) tops out at `prior`, because passing
 * every structural check is evidence of well-formedness, not of truth. A
 * result that fails some checks is damped further, proportionally.
 *
 * Two situations are treated as CERTAIN failures rather than damped ones,
 * because detecting them needs no calibration at all — they are trivial
 * boolean facts, not fuzzy structural judgment: `result.ok === false` (the
 * tool itself reported failure) and unparsable/non-object `result.output`.
 * Both pin `confidence` near 1 (see `FAILURE_DETECTION_CONFIDENCE`) with
 * `passed:false`, per the locked contract ("failure detection is certain").
 */

import type { ToolResult } from "../agent/tools";
import type { TierId, VerifierVote } from "../styx/tiers";

// ---------------------------------------------------------------------------
// Public contract (LOCKED)
// ---------------------------------------------------------------------------

export interface ToolVerdict extends VerifierVote {
  /** Calibrated P(this output is well-formed and mode-honest), in [0,1]. */
  confidence: number;
  /** Every failed check's machine-readable code, in check-order. Empty iff `passed`. */
  reasons: string[];
}

export interface ToolOutputVerifier {
  verifierId: string;
  toolName: string;
  verify(input: string, result: ToolResult): ToolVerdict;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const MOCK_MARKER = "[mock]";

/** Detecting `ok:false` or unparsable output needs no calibration — pin high. */
const FAILURE_DETECTION_CONFIDENCE = 0.99;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

interface Check {
  code: string;
  ok: boolean;
}

type ParsedOutput =
  | { ok: true; value: Record<string, unknown>; raw: string }
  | { ok: false; reason: string };

/** Parse `output` as a single JSON object (JSON.parse rejects trailing
 *  garbage after a valid value on its own, so this also enforces "single"). */
function parseJsonObject(output: string): ParsedOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { ok: false, reason: "JSON_PARSE_ERROR" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "JSON_NOT_OBJECT" };
  }
  return { ok: true, value: parsed as Record<string, unknown>, raw: output };
}

function isParseableUrl(u: unknown): boolean {
  if (typeof u !== "string" || u.length === 0) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

function isValidBase64(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  // Strict charset + padding check first — Buffer.from(..., "base64") is
  // lenient (silently skips invalid characters), so it cannot be trusted
  // alone to reject hostile input.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  try {
    return Buffer.from(s, "base64").length > 0;
  } catch {
    return false;
  }
}

/** Hand-written stack-based tag-balance checker for SVG/XML-ish markup.
 *  Deliberately simple (a `>` inside a quoted attribute value can confuse
 *  it) — documented limitation, acceptable for this stub's scope. Processing
 *  instructions (`<?xml ... ?>`) and comments (`<!-- ... -->`) are naturally
 *  skipped: the tag regex only matches `<` followed by a letter. */
function isXmlTagBalanced(svg: string): boolean {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)\b[^>]*?(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  let sawAnyTag = false;
  while ((match = tagRe.exec(svg)) !== null) {
    const closingSlash = match[1];
    const name = match[2].toLowerCase();
    const selfCloseSlash = match[3];
    sawAnyTag = true;
    if (closingSlash === "/") {
      if (stack.length === 0 || stack[stack.length - 1] !== name) return false;
      stack.pop();
    } else if (selfCloseSlash === "/") {
      // self-closing: no push
    } else {
      stack.push(name);
    }
  }
  return sawAnyTag && stack.length === 0;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Parse a WAV byte buffer's `fmt `/`data` subchunks and compute the
 *  duration (ms) implied by `dataSize / byteRate`. Returns null if the
 *  buffer is too short or no `data` subchunk is found before EOF. */
function computeWavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44) return null;
  const byteRate = buf.readUInt32LE(28);
  if (byteRate <= 0) return null;
  let offset = 36;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      return (chunkSize / byteRate) * 1000;
    }
    // Chunks are word-aligned: an odd chunkSize has one pad byte after it.
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

/** Parse `maxBytes` out of `fetch_extract`'s own input shape (a bare URL, or
 *  JSON `{url, extract?, maxBytes?}`), duplicating just enough of
 *  `fetch-extract.ts#parseFetchExtractInput`'s parsing to recover the same
 *  default (65536) without importing that file. */
const FETCH_EXTRACT_DEFAULT_MAX_BYTES = 65536;
function parseFetchExtractMaxBytes(input: string): number {
  const trimmed = (input ?? "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const mb = (parsed as Record<string, unknown>).maxBytes;
        if (typeof mb === "number" && Number.isFinite(mb) && mb > 0) {
          return Math.floor(mb);
        }
      }
    } catch {
      // fall through to default
    }
  }
  return FETCH_EXTRACT_DEFAULT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Per-tool structural checklists
// ---------------------------------------------------------------------------

function checkWebSearch(obj: Record<string, unknown>, _input: string, mode: string): Check[] {
  const checks: Check[] = [];
  const results = obj.results;
  const isArray = Array.isArray(results);
  checks.push({ code: "RESULTS_NOT_ARRAY", ok: isArray });
  if (isArray) {
    let allTitleUrlValid = true;
    let allUnderMockInvalid = true;
    let anyUnderMockInvalid = false;
    for (const raw of results) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const title = item.title;
      const url = item.url;
      const titleOk = typeof title === "string" && title.trim() !== "";
      let urlOk = false;
      let underMockInvalid = false;
      if (typeof url === "string") {
        try {
          const parsedUrl = new URL(url);
          urlOk = true;
          underMockInvalid =
            parsedUrl.hostname === "mock.invalid" || parsedUrl.hostname.endsWith(".mock.invalid");
        } catch {
          urlOk = false;
        }
      }
      if (!titleOk || !urlOk) allTitleUrlValid = false;
      if (!underMockInvalid) allUnderMockInvalid = false;
      if (underMockInvalid) anyUnderMockInvalid = true;
    }
    checks.push({ code: "RESULT_TITLE_OR_URL_INVALID", ok: allTitleUrlValid });
    if (results.length > 0) {
      if (mode === "mock") {
        checks.push({ code: "MOCK_URL_NOT_UNDER_MOCK_INVALID", ok: allUnderMockInvalid });
      } else if (mode === "real") {
        checks.push({ code: "REAL_URL_UNDER_MOCK_INVALID", ok: !anyUnderMockInvalid });
      }
    }
  }
  const queryOk = typeof obj.query === "string";
  checks.push({ code: "QUERY_NOT_STRING", ok: queryOk });
  return checks;
}

function checkFetchExtract(obj: Record<string, unknown>, input: string): Check[] {
  const checks: Check[] = [];
  const extractOk = obj.extract === "text" || obj.extract === "title" || obj.extract === "links";
  checks.push({ code: "EXTRACT_FIELD_INVALID", ok: extractOk });
  const contentOk = typeof obj.content === "string";
  checks.push({ code: "CONTENT_NOT_STRING", ok: contentOk });
  const truncatedOk = typeof obj.truncated === "boolean";
  checks.push({ code: "TRUNCATED_NOT_BOOLEAN", ok: truncatedOk });
  if (contentOk) {
    const maxBytes = parseFetchExtractMaxBytes(input);
    const byteLen = Buffer.byteLength(obj.content as string, "utf8");
    checks.push({ code: "CONTENT_EXCEEDS_MAXBYTES", ok: byteLen <= maxBytes });
  }
  checks.push({ code: "URL_INVALID", ok: isParseableUrl(obj.url) });
  return checks;
}

function checkFileOps(obj: Record<string, unknown>): Check[] {
  const checks: Check[] = [];
  const pathVal = obj.path;
  const pathIsString = typeof pathVal === "string" && pathVal.length > 0;
  checks.push({ code: "PATH_MISSING", ok: pathIsString });
  if (pathIsString) {
    const p = pathVal as string;
    const isAbsolute = p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p);
    checks.push({ code: "PATH_ABSOLUTE", ok: !isAbsolute });
    const segments = p.split(/[\\/]/);
    const hasDotDot = segments.includes("..");
    checks.push({ code: "PATH_CONTAINS_DOTDOT", ok: !hasDotDot });
  }
  const opOk = typeof obj.op === "string" && obj.op.length > 0;
  checks.push({ code: "OP_MISSING", ok: opOk });
  return checks;
}

function checkShell(obj: Record<string, unknown>): Check[] {
  const checks: Check[] = [];
  const code = obj.code;
  const codeOk = code === null || (typeof code === "number" && Number.isInteger(code));
  checks.push({ code: "CODE_INVALID", ok: codeOk });
  checks.push({ code: "TIMEDOUT_NOT_BOOLEAN", ok: typeof obj.timedOut === "boolean" });
  checks.push({ code: "TRUNCATED_NOT_BOOLEAN", ok: typeof obj.truncated === "boolean" });
  const argsOk = Array.isArray(obj.args) && obj.args.every((a) => typeof a === "string");
  checks.push({ code: "ARGS_NOT_STRING_ARRAY", ok: argsOk });
  return checks;
}

function checkHttpRequest(obj: Record<string, unknown>): Check[] {
  const checks: Check[] = [];
  const rh = obj.requestHeaders;
  const rhIsObject = rh !== null && typeof rh === "object" && !Array.isArray(rh);
  checks.push({ code: "REQUEST_HEADERS_MISSING", ok: rhIsObject });
  if (rhIsObject) {
    let leaked = false;
    for (const [key, value] of Object.entries(rh as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if ((lower === "authorization" || lower === "cookie") && value !== "[redacted]") {
        leaked = true;
      }
    }
    checks.push({ code: "HEADER_LEAK", ok: !leaked });
  }
  const methodOk = obj.method === "GET" || obj.method === "POST" || obj.method === "HEAD";
  checks.push({ code: "METHOD_INVALID", ok: methodOk });
  checks.push({ code: "URL_INVALID", ok: isParseableUrl(obj.url) });
  return checks;
}

function checkImageGen(obj: Record<string, unknown>, _input: string, mode: string): Check[] {
  const checks: Check[] = [];
  const format = obj.format;
  const formatOk = format === "svg" || format === "png-base64";
  checks.push({ code: "FORMAT_INVALID", ok: formatOk });
  checks.push({ code: "PROMPT_NOT_STRING", ok: typeof obj.prompt === "string" });
  const data = obj.data;
  const dataOk = typeof data === "string" && data.length > 0;
  checks.push({ code: "DATA_MISSING", ok: dataOk });
  // Shipped coupling (image-gen.ts): the real path only ever relays the
  // provider's PNG; the mock path only ever renders a procedural SVG. A
  // "real" SVG or "mock" PNG is a relabelled result, not a possible output.
  if (formatOk && mode === "real") {
    checks.push({ code: "REAL_FORMAT_NOT_PNG", ok: format === "png-base64" });
  } else if (formatOk && mode === "mock") {
    checks.push({ code: "MOCK_FORMAT_NOT_SVG", ok: format === "svg" });
  }
  if (formatOk && dataOk) {
    const str = data as string;
    if (format === "svg") {
      checks.push({ code: "SVG_TAGS_UNBALANCED", ok: isXmlTagBalanced(str) });
    } else {
      const base64Ok = isValidBase64(str);
      checks.push({ code: "PNG_BASE64_INVALID", ok: base64Ok });
      if (base64Ok) {
        const buf = Buffer.from(str, "base64");
        const magicOk = buf.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => buf[i] === b);
        checks.push({ code: "PNG_MAGIC_INVALID", ok: magicOk });
      }
    }
  }
  return checks;
}

function checkTts(obj: Record<string, unknown>, _input: string, mode: string): Check[] {
  const checks: Check[] = [];
  checks.push({ code: "TEXT_NOT_STRING", ok: typeof obj.text === "string" });
  const format = obj.format;
  const formatOk = format === "mp3-base64" || format === "wav-base64";
  checks.push({ code: "FORMAT_INVALID", ok: formatOk });
  const data = obj.data;
  const base64Ok = typeof data === "string" && isValidBase64(data);
  checks.push({ code: "AUDIO_BASE64_INVALID", ok: base64Ok });
  const durationMs = obj.durationMs;
  const durationOk = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0;
  checks.push({ code: "DURATION_MS_INVALID", ok: durationOk });
  // Shipped coupling (tts.ts): the real path relays the provider's MP3;
  // the mock path synthesizes a WAV. Any other pairing is a relabelling.
  if (formatOk && mode === "real") {
    checks.push({ code: "REAL_FORMAT_NOT_MP3", ok: format === "mp3-base64" });
  } else if (formatOk && mode === "mock") {
    checks.push({ code: "MOCK_FORMAT_NOT_WAV", ok: format === "wav-base64" });
  }
  if (base64Ok && formatOk) {
    const buf = Buffer.from(data as string, "base64");
    if (format === "wav-base64") {
      const magicOk =
        buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
      checks.push({ code: "WAV_MAGIC_INVALID", ok: magicOk });
      if (magicOk && durationOk) {
        const actualMs = computeWavDurationMs(buf);
        const consistent =
          actualMs !== null && Math.abs(actualMs - (durationMs as number)) <= Math.max(5, actualMs * 0.02);
        checks.push({ code: "DURATION_INCONSISTENT", ok: consistent });
      }
    } else {
      // MP3: either an ID3v2 container header or a raw MPEG frame sync
      // (11 set bits: 0xFF then top-3 bits of the next byte).
      const id3 = buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3";
      const frameSync = buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
      checks.push({ code: "MP3_MAGIC_INVALID", ok: id3 || frameSync });
    }
  }
  return checks;
}

// Locked mock template — exactly the shipped `vision.ts` mock output: the
// ONLY vocabulary a mock vision_describe description may use is
// byte-derivable facts (sniffed container format, parsed dimensions, byte
// length). Any color or object noun beyond this exact phrase set is
// fabrication.
const VISION_MOCK_RE =
  /^\[mock\] byte-level analysis only — no vision model was called: format=(png|jpeg|gif|svg|ppm|unknown), dimensions=(\d+x\d+|unknown), byteLength=(\d+)$/;

const BANNED_VISION_WORDS =
  /\b(red|orange|yellow|green|blue|purple|pink|brown|black|white|gray|grey|gold|silver|violet|indigo|cyan|magenta|cat|dog|person|people|man|woman|child|children|car|tree|house|building|mountain|ocean|sky|flower|bird|chair|table|computer|phone|book|food|animal|face|hand|eye|dress|shirt|hat|road|water|cloud|sun|moon|star|boat|plane|horse)\b/i;

/** Recover the decoded byte length of `vision_describe`'s own input (a bare
 *  base64 string, or JSON `{imageBase64, question?}`) without importing
 *  vision.ts. Returns null when the input isn't syntactically valid base64 —
 *  the tool itself would have rejected it, so no cross-check is possible. */
function parseVisionInputByteLength(input: string): number | null {
  let b64 = (input ?? "").trim();
  if (b64.startsWith("{")) {
    try {
      const parsed = JSON.parse(b64);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const img = (parsed as Record<string, unknown>).imageBase64;
        if (typeof img !== "string") return null;
        b64 = img;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  if (b64.length === 0 || b64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function checkVisionDescribe(obj: Record<string, unknown>, input: string, mode: string): Check[] {
  const checks: Check[] = [];
  const description = obj.description;
  const descriptionOk = typeof description === "string" && description.length > 0;
  checks.push({ code: "DESCRIPTION_MISSING", ok: descriptionOk });
  checks.push({ code: "QUESTION_NOT_STRING", ok: typeof obj.question === "string" });

  if (mode === "mock" && descriptionOk) {
    const text = description as string;
    const match = VISION_MOCK_RE.exec(text);
    checks.push({ code: "MOCK_DESCRIPTION_NOT_LOCKED_FORMAT", ok: match !== null });
    checks.push({ code: "MOCK_FABRICATED_CONTENT", ok: !BANNED_VISION_WORDS.test(text) });
    if (match !== null) {
      // The claimed byteLength must equal what the tool's own base64 input
      // actually decodes to — a mock cannot honestly have seen other bytes.
      const inputBytes = parseVisionInputByteLength(input);
      if (inputBytes !== null) {
        checks.push({ code: "MOCK_LENGTH_MISMATCH", ok: Number(match[3]) === inputBytes });
      }
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Verifier factory
// ---------------------------------------------------------------------------

type StructuralCheckFn = (obj: Record<string, unknown>, input: string, mode: string) => Check[];

function makeVerifier(toolName: string, verifierId: string, structuralChecks: StructuralCheckFn): ToolOutputVerifier {
  return {
    verifierId,
    toolName,
    verify(input: string, result: ToolResult): ToolVerdict {
      if (!result.ok) {
        return {
          verifierId,
          passed: false,
          confidence: FAILURE_DETECTION_CONFIDENCE,
          reasons: ["TOOL_REPORTED_FAILURE"],
        };
      }

      const parsed = parseJsonObject(result.output);
      if (!parsed.ok) {
        return {
          verifierId,
          passed: false,
          confidence: FAILURE_DETECTION_CONFIDENCE,
          reasons: [parsed.reason],
        };
      }

      const obj = parsed.value;
      const modeVal = obj.mode;
      const modeValid = modeVal === "real" || modeVal === "mock";
      const checks: Check[] = [{ code: "MODE_INVALID", ok: modeValid }];

      if (modeValid) {
        const hasMarker = parsed.raw.includes(MOCK_MARKER);
        if (modeVal === "real") {
          checks.push({ code: "MODE_MISMATCH", ok: !hasMarker });
        } else {
          checks.push({ code: "MOCK_LABEL_MISSING", ok: hasMarker });
        }
      }

      checks.push(...structuralChecks(obj, input, modeValid ? (modeVal as string) : "unknown"));

      const failedCodes = checks.filter((c) => !c.ok).map((c) => c.code);
      const passed = failedCodes.length === 0;
      const prior = calibrationTable()[verifierId]?.prior ?? 0.5;
      const fraction = checks.length === 0 ? 0 : (checks.length - failedCodes.length) / checks.length;
      const confidence = clamp01(fraction * prior);

      return { verifierId, passed, confidence, reasons: failedCodes };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exactly the eight verifiers, keyed by `verifierId`. Every entry's
 * `verifierId` matches its key and matches a `calibrationTable()` key.
 */
export function toolVerifiers(): Map<string, ToolOutputVerifier> {
  const verifiers: ToolOutputVerifier[] = [
    makeVerifier("web_search", "verify.web_search", checkWebSearch),
    makeVerifier("fetch_extract", "verify.fetch_extract", checkFetchExtract),
    makeVerifier("file_ops", "verify.file_ops", (obj) => checkFileOps(obj)),
    makeVerifier("shell", "verify.shell", (obj) => checkShell(obj)),
    makeVerifier("http_request", "verify.http_request", (obj) => checkHttpRequest(obj)),
    makeVerifier("image_gen", "verify.image_gen", checkImageGen),
    makeVerifier("tts", "verify.tts", checkTts),
    makeVerifier("vision_describe", "verify.vision_describe", checkVisionDescribe),
  ];
  const map = new Map<string, ToolOutputVerifier>();
  for (const v of verifiers) map.set(v.verifierId, v);
  return map;
}

/**
 * Each stub's honest tier + calibrated prior. Every prior is in (0,1]; every
 * tier is T4-consistency — these are self-consistency / format checks with no
 * oracle, no reference source, and no rubric-grading model in the loop, so
 * T0/T1/T2/T3 would all overclaim. Priors are hand-set relative to how
 * decisive each tool's checklist is (e.g. `file_ops`'s jail-escape check and
 * `http_request`'s header-leak check are close to unambiguous; a mock
 * `vision_describe`'s banned-word scan is comparatively the weakest signal).
 */
export function calibrationTable(): Record<string, { tier: TierId; prior: number }> {
  return {
    "verify.web_search": { tier: "T4-consistency", prior: 0.55 },
    "verify.fetch_extract": { tier: "T4-consistency", prior: 0.55 },
    "verify.file_ops": { tier: "T4-consistency", prior: 0.65 },
    "verify.shell": { tier: "T4-consistency", prior: 0.6 },
    "verify.http_request": { tier: "T4-consistency", prior: 0.65 },
    "verify.image_gen": { tier: "T4-consistency", prior: 0.5 },
    "verify.tts": { tier: "T4-consistency", prior: 0.55 },
    "verify.vision_describe": { tier: "T4-consistency", prior: 0.4 },
  };
}
