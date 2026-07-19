/**
 * STYX verifier for the `browser` catalog tool.
 *
 * Independent by construction: this file imports ONLY `type { ToolResult }`
 * from `../agent/tools`, `type { ToolVerdict, ToolOutputVerifier }` from
 * `../tools/verifiers`, `type { TierId }` from `../styx/tiers`, and
 * `node:crypto` — it never imports `./tool` (per the Phase 2 verifier
 * convention: a verifier checks the LOCKED output contract, not the
 * implementation that produced it, so it cannot be gamed by a tool that
 * imports its own verifier and reverse-engineers what passes).
 *
 * ---------------------------------------------------------------------------
 * Tool output contract checked here (restated, LOCKED — see `tool.ts`'s own
 * header for the canonical copy; this file duplicates it structurally,
 * exactly like `../tools/verifiers.ts` duplicates the other eight tools'
 * shapes without importing their factory files)
 * ---------------------------------------------------------------------------
 *   browser  { mode: "real"|"mock", op: "browse", url, finalUrl, title,
 *              content, passages: [{ text, sourceUrl, selectorPath, sha256 }],
 *              traceRoot, eventCount, truncated, note? }
 *
 *   MOCK mode is always, byte-for-byte:
 *     title:   "[mock] browser"
 *     content: "[mock] browse of <url> — no Chromium executable or runner
 *               available; deterministic stand-in."
 *     traceRoot: sha256 hex of the literal string "mock-trace:" + url
 *     eventCount: 0
 *   REAL mode never contains the substring "[mock]" anywhere in its output.
 *
 * ---------------------------------------------------------------------------
 * Calibration math (identical shape to `../tools/verifiers.ts`)
 * ---------------------------------------------------------------------------
 * `result.ok === false`, or `result.output` that fails to parse as a single
 * JSON object, is a CERTAIN failure — no calibration needed to notice the
 * tool itself reported failure, or produced garbage. Those pin
 * `confidence` at `FAILURE_DETECTION_CONFIDENCE` with `passed:false`.
 *
 * Otherwise this verifier runs a FIXED nine-check checklist (see
 * `CHECK_CODES` below) against the parsed output (and, where needed, the
 * original request JSON). Every check always contributes exactly one
 * pass/fail to the denominator — none are conditionally skipped — so:
 *
 *     confidence = clamp01( (passedChecks / 9) * prior )
 *
 * `prior` is the calibrated ceiling this class of check can ever claim (see
 * `browserCalibration()`): every check here proves internal structural
 * consistency (hashes recompute, shapes are well-formed, mode labelling is
 * honest) — NONE of it proves the page content is true, that the browser
 * actually visited a live site, or that the citations are relevant. That is
 * why the tier is T4-consistency, never higher, exactly like every other
 * Phase 2 tool verifier in this build.
 */

import type { ToolResult } from "../agent/tools";
import type { ToolVerdict, ToolOutputVerifier } from "../tools/verifiers";
import type { TierId } from "../styx/tiers";
import { createHash } from "node:crypto";

const MOCK_MARKER = "[mock]";
const MOCK_TITLE = "[mock] browser";
const BROWSER_VERIFIER_ID = "verify.browser";

/** Detecting `ok:false` or unparsable output needs no calibration — pin high,
 *  matching the shipped `../tools/verifiers.ts` convention exactly. */
const FAILURE_DETECTION_CONFIDENCE = 0.99;

// The fixed, LOCKED nine-code checklist, in check order. Every entry is
// always evaluated — none are conditionally omitted — so the denominator
// for the confidence fraction is always exactly `CHECK_CODES.length`.
const CHECK_CODES = [
  "mode-valid",
  "mode-honest",
  "url-echo",
  "tracehash-hex",
  "passages-shape",
  "passages-sha256",
  "passages-source",
  "eventcount-consistent",
  "truncated-boolean",
] as const;

type CheckCode = (typeof CHECK_CODES)[number];

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
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

/** Best-effort extraction of the `url` field out of the ORIGINAL request
 *  JSON string, independent of (and structurally duplicating just enough
 *  of) `tool.ts#validateBrowseInput` to avoid importing it. Returns
 *  `undefined` on anything unparsable — callers treat that as "cannot
 *  confirm the echo", i.e. the `url-echo` check fails. */
function extractInputUrl(input: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const url = (parsed as Record<string, unknown>).url;
  return typeof url === "string" ? url : undefined;
}

function isPassageShapeValid(p: unknown): p is { text: string; sourceUrl: string; selectorPath: string; sha256: string } {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const obj = p as Record<string, unknown>;
  return (
    typeof obj.text === "string" &&
    typeof obj.sourceUrl === "string" &&
    typeof obj.selectorPath === "string" &&
    typeof obj.sha256 === "string"
  );
}

/**
 * Run the fixed nine-check structural/self-consistency checklist. Returns a
 * map from every `CheckCode` to its boolean result — always all nine keys,
 * regardless of how badly malformed `obj` is (missing/wrong-typed fields
 * simply evaluate their check to `false`, never throw and never get
 * skipped).
 */
function runChecklist(obj: Record<string, unknown>, raw: string, input: string): Record<CheckCode, boolean> {
  const mode = obj.mode;
  const modeValid = mode === "real" || mode === "mock";

  // ---- mode-honest ---------------------------------------------------
  let modeHonest = false;
  if (modeValid && mode === "real") {
    modeHonest = !raw.includes(MOCK_MARKER);
  } else if (modeValid && mode === "mock") {
    const url = obj.url;
    if (typeof url === "string") {
      const expectedContent = `[mock] browse of ${url} — no Chromium executable or runner available; deterministic stand-in.`;
      const expectedTraceRoot = sha256Hex(`mock-trace:${url}`);
      modeHonest =
        obj.title === MOCK_TITLE &&
        obj.content === expectedContent &&
        obj.traceRoot === expectedTraceRoot &&
        raw.includes(MOCK_MARKER);
    }
  }

  // ---- url-echo --------------------------------------------------------
  const inputUrl = extractInputUrl(input);
  const urlEcho = typeof obj.url === "string" && inputUrl !== undefined && obj.url === inputUrl;

  // ---- tracehash-hex -----------------------------------------------------
  const tracehashHex = typeof obj.traceRoot === "string" && /^[0-9a-f]{64}$/.test(obj.traceRoot);

  // ---- passages-shape / passages-sha256 / passages-source ----------------
  const passagesRaw = obj.passages;
  const passagesIsArray = Array.isArray(passagesRaw);
  const passagesShape = passagesIsArray && passagesRaw.every((p) => isPassageShapeValid(p));

  let passagesSha256 = true;
  let passagesSource = true;
  if (passagesShape && passagesIsArray) {
    const finalUrl = obj.finalUrl;
    for (const raw2 of passagesRaw) {
      const p = raw2 as { text: string; sourceUrl: string; selectorPath: string; sha256: string };
      if (sha256Hex(p.text) !== p.sha256) passagesSha256 = false;
      if (p.sourceUrl !== obj.url && p.sourceUrl !== finalUrl) passagesSource = false;
    }
  } else {
    // Can't recompute/cross-check hashes or sources against a malformed
    // passages array — these checks cannot pass without a valid shape.
    passagesSha256 = false;
    passagesSource = false;
  }

  // ---- eventcount-consistent ----------------------------------------------
  let eventcountConsistent = false;
  if (modeValid && mode === "mock") {
    eventcountConsistent = obj.eventCount === 0;
  } else if (modeValid && mode === "real") {
    eventcountConsistent =
      typeof obj.eventCount === "number" && Number.isInteger(obj.eventCount) && obj.eventCount > 0;
  }

  // ---- truncated-boolean -------------------------------------------------
  const truncatedBoolean = typeof obj.truncated === "boolean";

  return {
    "mode-valid": modeValid,
    "mode-honest": modeHonest,
    "url-echo": urlEcho,
    "tracehash-hex": tracehashHex,
    "passages-shape": passagesShape,
    "passages-sha256": passagesSha256,
    "passages-source": passagesSource,
    "eventcount-consistent": eventcountConsistent,
    "truncated-boolean": truncatedBoolean,
  };
}

/**
 * Build the `verify.browser` output verifier. `verify` never throws: every
 * branch (tool failure, unparsable output, well-formed output) returns a
 * complete `ToolVerdict`.
 */
export function browserToolVerifier(): ToolOutputVerifier {
  const verifierId = BROWSER_VERIFIER_ID;
  return {
    verifierId,
    toolName: "browser",
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

      const checklist = runChecklist(parsed.value, parsed.raw, input);
      const failedCodes = CHECK_CODES.filter((code) => !checklist[code]);
      const passed = failedCodes.length === 0;
      const prior = browserCalibration().prior;
      const fraction = (CHECK_CODES.length - failedCodes.length) / CHECK_CODES.length;
      const confidence = clamp01(fraction * prior);

      return { verifierId, passed, confidence, reasons: [...failedCodes] };
    },
  };
}

/**
 * `browser`'s honest tier + calibrated prior. Tier is T4-consistency: every
 * check above is a self-consistency / structural check (recomputed sha256
 * hashes, well-formed shapes, honest mode labelling) with no oracle, no
 * retrieved reference, and no rubric-grading model in the loop — a "real"
 * result that fabricates plausible page text and cites its own invented
 * passages (with correctly recomputed hashes over that invented text)
 * passes every check here, so this can never honestly claim a stronger
 * tier. Prior 0.68 sits mid-range in the locked [0.6, 0.75] band: `browser`'s
 * checklist is more decisive than a plain format check (it RECOMPUTES
 * sha256 over passage text and the mock traceRoot rather than merely
 * validating shape, which is real, non-gameable internal-consistency
 * evidence — closer to `file_ops`'s 0.65 jail-escape check than to
 * `image_gen`'s 0.5 shape-only check in `../tools/verifiers.ts`), but it
 * still cannot see whether the browser genuinely visited the page, so it
 * does not reach the top of the band either.
 */
export function browserCalibration(): { tier: TierId; prior: number } {
  return { tier: "T4-consistency", prior: 0.68 };
}
