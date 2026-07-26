/**
 * Canonical training-example encoder.
 *
 * Turns a verified {@link CorpusEntry} into a byte-deterministic, model-ready
 * {@link TrainingRecord}: secrets redacted, prompt-injection surfaces fenced,
 * budgets honestly enforced (never a mutilated example), and every label
 * field copied verbatim from the entry's {@link VerificationCertificate} -
 * this stage NEVER recomputes, rounds, defaults, or invents a label value.
 * An unlabelled or optimistically-labelled record is impossible to produce:
 * any entry whose certificate cannot source every label field is skipped
 * with `label-inconsistent` rather than emitted with a guessed value.
 *
 * The corpus this module consumes is verified-only (every {@link CorpusEntry}
 * carries a certificate issued by the STYX verification swarm). This stage
 * may never upgrade, embellish, or reinterpret that label - it only encodes.
 *
 * Pure and synchronous: no I/O, no `Date.now()`, no `Math.random()`, no LLM
 * calls. Two calls to {@link encodeExample} on the same entry with the same
 * options always produce byte-identical {@link canonicalRecordJson} output,
 * regardless of the source trajectory's own object key-insertion order -
 * every field this module reads is accessed by name, and every value it
 * re-serializes (tool `input`/`output`, when folded into a step summary)
 * goes through a sorted-key canonicalizer, never a raw `JSON.stringify` of
 * caller-controlled key order.
 *
 * ---------------------------------------------------------------------------
 * `CorpusEntry` / `RealityClass` shape (T1's `./corpus`)
 * ---------------------------------------------------------------------------
 * `RealityClass` is treated fully opaquely (imported as a type, copied
 * verbatim from `entry.provenance.realityClass` into
 * `ExampleLabel.realityClass`, never constructed or compared against a
 * literal by this module), so the encoder is correct for whatever
 * `RealityClass` union `./corpus` ships, unchanged. `trajectorySha256` is
 * copied verbatim from `entry.trajectorySha256` — the hash `admit()`
 * independently recomputed as `sha256Hex(canonicalTrajectoryJson(trajectory))`
 * and bound into the corpus's hash chain — rather than rederived here, so a
 * training record's identity hash is always the one the corpus itself
 * committed to. Every field this module reads off `CorpusEntry` is also
 * defended with a runtime shape check (not just a compile-time cast), so an
 * on-disk entry that fails to match at runtime is skipped as
 * `malformed-entry` / `label-inconsistent` rather than throwing.
 * ---------------------------------------------------------------------------
 */

import type { CorpusEntry, RealityClass } from "./corpus";
import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../research/recorder";
import { sha256Hex, type VerificationCertificate } from "../styx/certificate";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export const EXAMPLE_SCHEMA_VERSION = 1;

/**
 * Wire shapes:
 *  - "sft-prompt-completion": `prompt` holds the sanitized objective,
 *    `completion` holds a deterministic step-by-step narrative built from
 *    the trajectory's tool events. `messages`/`steps` are absent.
 *  - "chat-messages": `messages` holds an ordered system?/user/assistant/tool
 *    turn sequence (system preamble, the objective as the user turn, then
 *    one assistant+tool turn pair per surviving tool step, grouped by task).
 *    `prompt`/`completion`/`steps` are absent.
 *  - "tool-trace": `steps` holds the flattened, optionally duplicate-collapsed
 *    tool-event trace as `EncodedStep[]`; `prompt` holds the sanitized
 *    objective. `messages`/`completion` are absent.
 */
export type ExampleSchema = "sft-prompt-completion" | "chat-messages" | "tool-trace";

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

/**
 * One tool-trace row. `index` is the tool event's position in the flattened,
 * duplicate-collapsed sequence for the WHOLE trajectory - not necessarily
 * contiguous in the emitted `steps` array once `maxSteps` truncation drops a
 * middle range, so a gap in `index` (e.g. 4 then 995) is an honest signal of
 * omitted steps rather than a fabricated placeholder row.
 */
export interface EncodedStep {
  index: number;
  tool: string;
  ok: boolean;
  summary?: string;
  repeat: number;
}

/**
 * Every field here is copied verbatim from the certificate that verified
 * this entry - see the module header. `verified` is always literally `true`
 * because the corpus this module consumes is verified-only; this field
 * exists so a `TrainingRecord` is self-describing without cross-referencing
 * the corpus, not because the encoder ever decides it.
 */
export interface ExampleLabel {
  verified: true;
  certSha256: string;
  pCorrect: number;
  epsilon: number;
  verifierTier: string;
  verifierVersions: string[];
  realityClass: RealityClass;
  issuedAt: number;
}

export interface TrainingRecord {
  id: string;
  schemaVersion: number;
  schema: ExampleSchema;
  trajectorySha256: string;
  objective: string;
  messages?: ChatTurn[];
  prompt?: string;
  completion?: string;
  steps?: EncodedStep[];
  label: ExampleLabel;
  split: "train" | "holdout";
  charCount: number;
  tokensEstimate: number;
  truncated: boolean;
  redactions: number;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactionPolicy {
  patterns: { name: string; re: RegExp }[];
  replacement: string;
  redactHomePaths: boolean;
}

/**
 * Real secret shapes, kept deliberately specific (prefix/format anchored) so
 * ordinary prose, sha256 hex digests, and long identifiers are not mangled.
 * The `home-path` pattern is gated behind `redactHomePaths` since it targets
 * PII-shaped filesystem paths rather than credentials.
 */
export const DEFAULT_REDACTION: RedactionPolicy = {
  replacement: "[REDACTED]",
  redactHomePaths: true,
  patterns: [
    { name: "openai-secret-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
    { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
    {
      name: "aws-secret-access-key",
      // Tolerates a backslash-escaped quote (e.g. inside JSON-stringified
      // tool output: `"...\"wJal...\""`) as well as a plain quote or none.
      re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*\\?['"]?[A-Za-z0-9/+=]{40}\\?['"]?/g,
    },
    { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
    { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
    {
      name: "pem-private-key",
      re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    },
    { name: "postgres-url", re: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+(?:\/[^\s]*)?/g },
    { name: "api-key-query-param", re: /[?&]api_key=[^&\s]+/g },
    {
      name: "home-path",
      re: /(\$HOME\b)|(\/home\/[A-Za-z0-9_.-]+)|(\/Users\/[A-Za-z0-9_.-]+)/g,
    },
  ],
};

function withGlobalFlag(re: RegExp): RegExp {
  return re.global ? new RegExp(re.source, re.flags) : new RegExp(re.source, re.flags + "g");
}

function applyRedaction(text: string, policy: RedactionPolicy): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const pattern of policy.patterns) {
    if (pattern.name === "home-path" && !policy.redactHomePaths) continue;
    const re = withGlobalFlag(pattern.re);
    const matches = out.match(re);
    if (matches) count += matches.length;
    out = out.replace(re, policy.replacement);
  }
  return { text: out, count };
}

// ---------------------------------------------------------------------------
// Injection fencing
//
// Every control/format character referenced below is written as an explicit
// \u escape (never as a literal byte in this source file), so this module
// stays unambiguous under any editor/encoding and is trivially auditable.
// ---------------------------------------------------------------------------

const BOM_RE = /\uFEFF/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NEL_RE = /\u0085/g;
const LINE_PARA_SEP_RE = /[\u2028\u2029]/g;
/** C0 controls except \t \n \r, plus DEL and the C1 control range - includes NUL. */
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ROLE_MARKER_RE = /(^|\r?\n)([ \t]*)(system|user|assistant|tool)([ \t]*):/gi;
const SPECIAL_TOKEN_RE = /<\|([^|>\r\n]{1,64})\|>/g;
const MD_INSTRUCTION_RE = /(^|\r?\n)(#{1,6}[ \t]*(?:Response|Instruction|System|Prompt|Human|AI)[ \t]*):/gi;
const TRIPLE_BACKTICK_RE = /```/g;
const REPLACEMENT_CHAR = "�";
const NUL_CHAR = "\u0000";

/**
 * Neutralizes prompt-injection and JSONL-corruption surfaces in untrusted
 * trajectory text: strips a BOM, repairs lone/unpaired surrogates to U+FFFD,
 * collapses NEL/LINE SEPARATOR/PARAGRAPH SEPARATOR to ordinary space/newline,
 * strips other C0/C1 control characters (including NUL), defuses forged role
 * markers (`\nassistant:`), chat special tokens (`<|im_start|>`), markdown
 * instruction headers (`### Response:`), and triple-backtick fences that
 * could otherwise escape a surrounding code fence. Never throws; always
 * returns a string safe to embed as a single JSON string value.
 */
export function fenceUntrusted(text: string): string {
  let out = typeof text === "string" ? text : String(text ?? "");
  out = out.replace(BOM_RE, "");
  out = out.replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR);
  out = out.replace(NEL_RE, " ");
  out = out.replace(LINE_PARA_SEP_RE, "\n");
  out = out.replace(CONTROL_CHAR_RE, "");
  out = out.replace(ROLE_MARKER_RE, "$1$2[role:$3]$4:");
  out = out.replace(SPECIAL_TOKEN_RE, "<[$1]>");
  out = out.replace(MD_INSTRUCTION_RE, "$1\\$2:");
  out = out.replace(TRIPLE_BACKTICK_RE, "ˋˋˋ");
  return out;
}

function containsNul(text: string): boolean {
  return typeof text === "string" && text.includes(NUL_CHAR);
}

// ---------------------------------------------------------------------------
// Token estimate (documented heuristic - NOT a real tokenizer)
// ---------------------------------------------------------------------------

/**
 * `tokensEstimate` heuristic: ceil(unicode code points / 4), a common rough
 * approximation for English-ish text (~4 chars/token). This is EXPLICITLY
 * AN ESTIMATE - it does not run any real tokenizer (no BPE/SentencePiece
 * vocabulary is loaded) and must never be presented as an exact token count.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const codePoints = Array.from(text).length;
  return Math.max(1, Math.ceil(codePoints / 4));
}

// ---------------------------------------------------------------------------
// Grapheme-safe truncation
// ---------------------------------------------------------------------------

const SEGMENTER_SAFE_LIMIT = 100_000;

function graphemes(text: string): string[] {
  if (text.length <= SEGMENTER_SAFE_LIMIT) {
    try {
      const IntlAny = Intl as unknown as {
        Segmenter?: new (
          locale: undefined,
          opts: { granularity: string },
        ) => { segment(t: string): Iterable<{ segment: string }> };
      };
      if (IntlAny.Segmenter) {
        const seg = new IntlAny.Segmenter(undefined, { granularity: "grapheme" });
        const out: string[] = [];
        for (const s of seg.segment(text)) out.push(s.segment);
        return out;
      }
    } catch {
      /* fall through to code-point splitting */
    }
  }
  // Code-point splitting: used for very large inputs (>100k UTF-16 units) or
  // when Intl.Segmenter is unavailable. Still guarantees no surrogate pair is
  // ever split, which is the hard requirement; only the (rarer, lower-stakes
  // at this scale) combining-mark boundary guarantee is relaxed here.
  return Array.from(text);
}

/**
 * Truncate `text` to at most `maxUnits` grapheme clusters (falling back to
 * code points for very large inputs), keeping deterministic head+tail
 * context around a single ellipsis marker. Never splits a surrogate pair or
 * (when `Intl.Segmenter` is used) a combining character sequence.
 */
function truncateHeadTail(text: string, maxUnits: number): { text: string; truncated: boolean } {
  if (maxUnits <= 0) return { text: "", truncated: text.length > 0 };
  const units = graphemes(text);
  if (units.length <= maxUnits) return { text, truncated: false };
  if (maxUnits === 1) return { text: "…", truncated: true };
  const headLen = Math.ceil((maxUnits - 1) * 0.7);
  const tailLen = maxUnits - 1 - headLen;
  const head = units.slice(0, headLen).join("");
  const tail = tailLen > 0 ? units.slice(units.length - tailLen).join("") : "";
  return { text: head + "…" + tail, truncated: true };
}

function unitCount(text: string): number {
  return Array.from(text).length;
}

// ---------------------------------------------------------------------------
// Split assignment - pure uniform hash bucket, no RNG
// ---------------------------------------------------------------------------

/**
 * Deterministic, leak-free train/holdout split: hashes
 * `trajectorySha256 + "|" + salt` with sha256, maps the first 8 hex digits
 * to a uniform value in [0, 1), and buckets into `"holdout"` when that value
 * is below `holdoutFraction`. Pure function of its inputs - no RNG, no
 * process-local state - so the same trajectory always lands in the same
 * split, in any process, forever, for a given `(holdoutFraction, salt)`.
 */
export function assignSplit(
  trajectorySha256: string,
  holdoutFraction: number,
  salt = "",
): "train" | "holdout" {
  const frac = Number.isFinite(holdoutFraction) ? Math.min(1, Math.max(0, holdoutFraction)) : 0;
  const digest = sha256Hex(`${trajectorySha256}|${salt}`);
  const bucketHex = digest.slice(0, 8);
  const bucketValue = parseInt(bucketHex, 16) / 0x100000000;
  return bucketValue < frac ? "holdout" : "train";
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

const RECORD_KEY_ORDER: (keyof TrainingRecord)[] = [
  "schemaVersion",
  "schema",
  "trajectorySha256",
  "objective",
  "messages",
  "prompt",
  "completion",
  "steps",
  "label",
  "split",
  "charCount",
  "tokensEstimate",
  "truncated",
  "redactions",
];

const LABEL_KEY_ORDER: (keyof ExampleLabel)[] = [
  "verified",
  "certSha256",
  "pCorrect",
  "epsilon",
  "verifierTier",
  "verifierVersions",
  "realityClass",
  "issuedAt",
];

function stableStringifyValue(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    return out === undefined ? "null" : out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringifyValue(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringifyValue(obj[k])).join(",") + "}";
}

/**
 * Stable, key-order-fixed JSON serialization of a `TrainingRecord`, with
 * `id` EXCLUDED from its own preimage (so `recordId` can hash this output).
 * Two records with identical field values always serialize to the same
 * string, regardless of the order those fields were set in.
 */
export function canonicalRecordJson(r: TrainingRecord): string {
  const parts: string[] = [];
  for (const key of RECORD_KEY_ORDER) {
    const value = (r as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "label") {
      const label = value as ExampleLabel;
      const labelParts: string[] = [];
      for (const lk of LABEL_KEY_ORDER) {
        const lv = (label as unknown as Record<string, unknown>)[lk];
        if (lv === undefined) continue;
        labelParts.push(JSON.stringify(lk) + ":" + stableStringifyValue(lv));
      }
      parts.push(JSON.stringify(key) + ":{" + labelParts.join(",") + "}");
    } else {
      parts.push(JSON.stringify(key) + ":" + stableStringifyValue(value));
    }
  }
  return "{" + parts.join(",") + "}";
}

/** `sha256Hex` of `canonicalRecordJson`, with `id` excluded from the preimage. */
export function recordId(r: Omit<TrainingRecord, "id">): string {
  return sha256Hex(canonicalRecordJson({ ...(r as TrainingRecord), id: "" }));
}

// ---------------------------------------------------------------------------
// Bounded, cycle-safe canonicalization of arbitrary tool input/output
// ---------------------------------------------------------------------------

const UNKNOWN_MAX_DEPTH = 6;
const UNKNOWN_MAX_ENTRIES = 40;
const UNKNOWN_MAX_STRING = 400;

function canonicalizeUnknown(value: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return JSON.stringify(s.length > UNKNOWN_MAX_STRING ? s.slice(0, UNKNOWN_MAX_STRING) + "…" : s);
  }
  if (t === "number" || t === "boolean") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  if (t === "function" || t === "symbol") return JSON.stringify(`[${t}]`);
  if (t !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return JSON.stringify("[circular]");
  if (depth >= UNKNOWN_MAX_DEPTH) return JSON.stringify("[max-depth]");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, UNKNOWN_MAX_ENTRIES).map((v) => canonicalizeUnknown(v, depth + 1, seen));
      const suffix = value.length > UNKNOWN_MAX_ENTRIES ? `,"…${value.length - UNKNOWN_MAX_ENTRIES}-more"` : "";
      return "[" + items.join(",") + suffix + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .slice(0, UNKNOWN_MAX_ENTRIES);
    return (
      "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeUnknown(obj[k], depth + 1, seen)).join(",") + "}"
    );
  } catch {
    return JSON.stringify("[unserializable]");
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  schema: ExampleSchema;
  maxSteps?: number;
  maxChars?: number;
  includeFailedSteps?: boolean;
  collapseDuplicates?: boolean;
  systemPreamble?: string;
  redaction?: RedactionPolicy;
  holdoutFraction?: number;
  holdoutSalt?: string;
}

export type EncodeSkipCode =
  | "empty-steps"
  | "empty-objective"
  | "over-budget"
  | "label-inconsistent"
  | "unsafe-content"
  | "malformed-entry";

export type EncodeResult =
  | { ok: true; record: TrainingRecord }
  | { ok: false; skip: { code: EncodeSkipCode; detail: string } };

const MIN_VIABLE_CHARS = 24;
const DEFAULT_HOLDOUT_FRACTION = 0.1;
const HEX64_RE = /^[0-9a-f]{64}$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function skip(code: EncodeSkipCode, detail: string): EncodeResult {
  return { ok: false, skip: { code, detail } };
}

/** Sanitize (redact then fence) a raw text field, accumulating the redaction count. */
function sanitize(raw: unknown, policy: RedactionPolicy, acc: { count: number }): string {
  const text = typeof raw === "string" ? raw : "";
  const redacted = applyRedaction(text, policy);
  acc.count += redacted.count;
  return fenceUntrusted(redacted.text);
}

function deriveRawSummary(event: ToolEvent): string {
  if (typeof event.summary === "string" && event.summary.length > 0) return event.summary;
  if (event.output !== undefined) return canonicalizeUnknown(event.output);
  if (event.input !== undefined) return canonicalizeUnknown(event.input);
  return "";
}

interface FlatStep {
  originalIndex: number;
  taskId: string;
  taskDescription: string;
  tool: string;
  ok: boolean;
  summary: string;
  repeat: number;
}

/**
 * Flattens `tasks[].tools[]` in order, sanitizing every text-bearing field
 * (task description, tool summary / folded output) and optionally collapsing
 * consecutive identical (tool, ok, summary) events WITHIN a task into a
 * single row with `repeat > 1`. Never collapses across a task boundary.
 */
function flattenTrajectory(
  trajectory: GoalTrajectory,
  opts: Pick<EncodeOptions, "includeFailedSteps" | "collapseDuplicates">,
  policy: RedactionPolicy,
  redactionAcc: { count: number },
): FlatStep[] {
  const includeFailedSteps = opts.includeFailedSteps !== false;
  const collapse = opts.collapseDuplicates === true;
  const flat: FlatStep[] = [];
  let originalIndex = 0;
  const tasks: TaskTrajectory[] = Array.isArray(trajectory.tasks) ? trajectory.tasks : [];
  for (const task of tasks) {
    const taskDescription = sanitize(task?.description, policy, redactionAcc);
    const taskId = typeof task?.taskId === "string" ? task.taskId : "";
    const rawTools: ToolEvent[] = Array.isArray(task?.tools) ? task.tools : [];
    let prev: FlatStep | undefined;
    for (const event of rawTools) {
      if (!event || typeof event !== "object") continue;
      const ok = event.ok === true;
      if (!ok && !includeFailedSteps) continue;
      const tool = typeof event.tool === "string" && event.tool.length > 0 ? event.tool : "unknown-tool";
      const summary = sanitize(deriveRawSummary(event), policy, redactionAcc);
      const idx = originalIndex++;
      if (
        collapse &&
        prev &&
        prev.taskId === taskId &&
        prev.tool === tool &&
        prev.ok === ok &&
        prev.summary === summary
      ) {
        prev.repeat += 1;
        continue;
      }
      const row: FlatStep = { originalIndex: idx, taskId, taskDescription, tool, ok, summary, repeat: 1 };
      flat.push(row);
      prev = row;
    }
  }
  return flat;
}

function selectByStepBudget(
  flat: FlatStep[],
  maxSteps: number | undefined,
): { selected: FlatStep[]; truncated: boolean } {
  if (maxSteps === undefined || flat.length <= maxSteps) return { selected: flat, truncated: false };
  const headLen = Math.ceil(maxSteps / 2);
  const tailLen = maxSteps - headLen;
  const head = flat.slice(0, headLen);
  const tail = tailLen > 0 ? flat.slice(flat.length - tailLen) : [];
  return { selected: [...head, ...tail], truncated: true };
}

function scanForNul(entry: { trajectory: GoalTrajectory }): boolean {
  if (containsNul(entry.trajectory.objective ?? "")) return true;
  const tasks: TaskTrajectory[] = Array.isArray(entry.trajectory.tasks) ? entry.trajectory.tasks : [];
  for (const task of tasks) {
    if (containsNul(task?.description ?? "")) return true;
    const tools: ToolEvent[] = Array.isArray(task?.tools) ? task.tools : [];
    for (const event of tools) {
      if (typeof event?.summary === "string" && containsNul(event.summary)) return true;
    }
  }
  return false;
}

function validateEntryShape(entry: CorpusEntry | null | undefined): string | null {
  if (entry === null || entry === undefined || typeof entry !== "object") return "entry is not an object";
  const e = entry as unknown as Record<string, unknown>;
  if (e.label !== "verified") return 'entry.label is not the literal "verified"';
  if (typeof e.trajectorySha256 !== "string" || !HEX64_RE.test(e.trajectorySha256)) {
    return "entry.trajectorySha256 is not a 64-char hex sha256";
  }
  if (typeof e.certSha256 !== "string" || e.certSha256.length === 0) return "entry.certSha256 missing/invalid";
  if (!isPlainObject(e.certificate)) return "entry.certificate missing/invalid";
  if (!isPlainObject((e.certificate as Record<string, unknown>).payload)) {
    return "entry.certificate.payload missing/invalid";
  }
  if (!isPlainObject(e.provenance)) return "entry.provenance missing/invalid";
  const provenance = e.provenance as Record<string, unknown>;
  if (provenance.realityClass === undefined || provenance.realityClass === null) {
    return "entry.provenance.realityClass missing";
  }
  if (!isPlainObject(e.trajectory)) return "entry.trajectory missing/invalid";
  if (typeof (e.trajectory as Record<string, unknown>).objective !== "string") {
    return "entry.trajectory.objective missing/invalid";
  }
  return null;
}

function validateLabelShape(cert: VerificationCertificate, certSha256: string): string | null {
  const p = cert.payload as unknown as Record<string, unknown>;
  if (typeof p.pCorrect !== "number" || !Number.isFinite(p.pCorrect) || p.pCorrect < 0 || p.pCorrect > 1) {
    return "certificate.payload.pCorrect is not a finite number in [0,1]";
  }
  if (typeof p.epsilon !== "number" || !Number.isFinite(p.epsilon) || p.epsilon < 0) {
    return "certificate.payload.epsilon is not a finite non-negative number";
  }
  if (typeof p.verifierTier !== "string" || p.verifierTier.length === 0) {
    return "certificate.payload.verifierTier is not a non-empty string";
  }
  if (!Array.isArray(p.verifierVersions) || !p.verifierVersions.every((v) => typeof v === "string")) {
    return "certificate.payload.verifierVersions is not a string[]";
  }
  if (typeof p.issuedAt !== "number" || !Number.isFinite(p.issuedAt)) {
    return "certificate.payload.issuedAt is not a finite number";
  }
  if (!HEX64_RE.test(certSha256)) {
    return "certSha256 is not a 64-char hex sha256";
  }
  return null;
}

/** Compute a diagnostic (non-label) hash for skip bookkeeping. Never throws. */
function bestEffortTrajectorySha256(entry: unknown): string {
  try {
    const e = entry as { trajectorySha256?: unknown };
    if (typeof e?.trajectorySha256 === "string" && HEX64_RE.test(e.trajectorySha256)) {
      return e.trajectorySha256.toLowerCase();
    }
  } catch {
    /* fall through */
  }
  try {
    return sha256Hex(canonicalizeUnknown(entry));
  } catch {
    return "unknown";
  }
}

function buildLabel(entry: CorpusEntry): ExampleLabel {
  const cert = entry.certificate;
  const p = cert.payload;
  return {
    verified: true,
    certSha256: entry.certSha256,
    pCorrect: p.pCorrect,
    epsilon: p.epsilon,
    verifierTier: p.verifierTier,
    verifierVersions: [...p.verifierVersions],
    realityClass: entry.provenance.realityClass,
    issuedAt: p.issuedAt,
  };
}

function formatStepLine(step: FlatStep): string {
  const status = step.ok ? "ok" : "failed";
  const repeatSuffix = step.repeat > 1 ? ` x${step.repeat}` : "";
  const summary = step.summary.length > 0 ? `: ${step.summary}` : "";
  return `- ${step.tool} (${status}${repeatSuffix})${summary}`;
}

function encodeToolTrace(
  selected: FlatStep[],
  objective: string,
  maxChars: number | undefined,
  objectiveTruncated: boolean,
): { steps: EncodedStep[]; prompt: string; truncated: boolean; text: string } {
  let remaining = maxChars === undefined ? Number.POSITIVE_INFINITY : maxChars - unitCount(objective);
  let truncated = objectiveTruncated || remaining < 0;
  const steps: EncodedStep[] = [];
  const textParts: string[] = [];
  for (const s of selected) {
    if (maxChars !== undefined && remaining <= 0) {
      truncated = true;
      break;
    }
    let summary = s.summary;
    if (maxChars !== undefined) {
      const cap = Math.max(0, Math.min(200, remaining));
      const t = truncateHeadTail(summary, cap);
      if (t.truncated) truncated = true;
      summary = t.text;
      remaining -= unitCount(summary);
    }
    steps.push({ index: s.originalIndex, tool: s.tool, ok: s.ok, summary, repeat: s.repeat });
    textParts.push(formatStepLine({ ...s, summary }));
  }
  return { steps, prompt: objective, truncated, text: objective + "\n" + textParts.join("\n") };
}

function encodeSftPromptCompletion(
  selected: FlatStep[],
  objective: string,
  success: boolean,
  maxChars: number | undefined,
  objectiveTruncated: boolean,
): { prompt: string; completion: string; truncated: boolean } {
  let lastTaskId: string | undefined;
  const lines: string[] = [];
  for (const s of selected) {
    if (s.taskId !== lastTaskId) {
      lines.push(`Task: ${s.taskDescription}`);
      lastTaskId = s.taskId;
    }
    lines.push(formatStepLine(s));
  }
  lines.push(`Result: ${success ? "success" : "failure"}`);
  let completion = lines.join("\n");
  let truncatedBySteps = false;
  if (maxChars !== undefined) {
    const remaining = maxChars - unitCount(objective);
    const cap = Math.max(0, remaining);
    const t = truncateHeadTail(completion, cap);
    completion = t.text;
    truncatedBySteps = t.truncated;
  }
  return { prompt: objective, completion, truncated: objectiveTruncated || truncatedBySteps };
}

function encodeChatMessages(
  selected: FlatStep[],
  objective: string,
  success: boolean,
  systemPreamble: string | undefined,
  maxChars: number | undefined,
  objectiveTruncated: boolean,
): { messages: ChatTurn[]; truncated: boolean } {
  const messages: ChatTurn[] = [];
  let budget = maxChars === undefined ? Number.POSITIVE_INFINITY : maxChars - unitCount(objective);
  let truncated = objectiveTruncated || budget < 0;
  const push = (turn: ChatTurn): boolean => {
    const cost = unitCount(turn.content);
    if (maxChars !== undefined && cost > budget) {
      truncated = true;
      return false;
    }
    messages.push(turn);
    if (maxChars !== undefined) budget -= cost;
    return true;
  };
  if (systemPreamble !== undefined && systemPreamble.length > 0) {
    push({ role: "system", content: systemPreamble });
  }
  if (!push({ role: "user", content: objective })) {
    return { messages, truncated: true };
  }
  let lastTaskId: string | undefined;
  for (const s of selected) {
    if (s.taskId !== lastTaskId) {
      if (!push({ role: "assistant", content: `Task: ${s.taskDescription}` })) break;
      lastTaskId = s.taskId;
    }
    if (!push({ role: "assistant", content: `Calling ${s.tool}${s.repeat > 1 ? ` (x${s.repeat})` : ""}` })) break;
    if (!push({ role: "tool", name: s.tool, content: `${s.ok ? "" : "[failed] "}${s.summary}` })) break;
  }
  push({ role: "assistant", content: `Task ${success ? "succeeded" : "failed"}.` });
  return { messages, truncated };
}

/**
 * Encode one verified `CorpusEntry` into a `TrainingRecord` under `opts`.
 * Pure and synchronous. Never throws - every failure mode returns a typed
 * `{ ok: false, skip }` result instead.
 */
export function encodeExample(entry: CorpusEntry, opts: EncodeOptions): EncodeResult {
  try {
    const shapeError = validateEntryShape(entry);
    if (shapeError) return skip("malformed-entry", shapeError);

    const e = entry as CorpusEntry;
    const labelError = validateLabelShape(e.certificate, e.certSha256);
    if (labelError) return skip("label-inconsistent", labelError);

    if (scanForNul(e)) {
      return skip("unsafe-content", "NUL byte (U+0000) present in objective, task description, or tool summary");
    }

    const rawObjective = e.trajectory.objective;
    if (rawObjective.trim().length === 0) return skip("empty-objective", "trajectory.objective is empty/whitespace");

    if (opts.maxSteps !== undefined && opts.maxSteps < 1) {
      return skip("over-budget", `maxSteps=${opts.maxSteps} cannot fit even one step`);
    }
    if (opts.maxChars !== undefined && opts.maxChars < MIN_VIABLE_CHARS) {
      return skip("over-budget", `maxChars=${opts.maxChars} is below the minimum viable budget (${MIN_VIABLE_CHARS})`);
    }

    const policy = opts.redaction ?? DEFAULT_REDACTION;
    const redactionAcc = { count: 0 };

    const flat = flattenTrajectory(e.trajectory, opts, policy, redactionAcc);
    if (flat.length === 0) return skip("empty-steps", "trajectory has zero tool events across all tasks");

    let objective = sanitize(rawObjective, policy, redactionAcc);
    let objectiveTruncated = false;
    if (opts.maxChars !== undefined) {
      const t = truncateHeadTail(objective, opts.maxChars);
      objective = t.text;
      objectiveTruncated = t.truncated;
    }
    if (objective.trim().length === 0) {
      return skip("unsafe-content", "objective sanitized to empty (all invisible/control content)");
    }

    const { selected, truncated: stepsTruncated } = selectByStepBudget(flat, opts.maxSteps);
    const trajectorySha256 = e.trajectorySha256.toLowerCase();
    const label = buildLabel(e);
    const split = assignSplit(trajectorySha256, opts.holdoutFraction ?? DEFAULT_HOLDOUT_FRACTION, opts.holdoutSalt);
    const success = e.trajectory.success === true;

    let record: Omit<TrainingRecord, "id" | "charCount" | "tokensEstimate">;
    let contentText: string;
    let truncated = objectiveTruncated || stepsTruncated;

    if (opts.schema === "tool-trace") {
      const out = encodeToolTrace(selected, objective, opts.maxChars, objectiveTruncated);
      truncated = truncated || out.truncated;
      contentText = out.text;
      record = {
        schemaVersion: EXAMPLE_SCHEMA_VERSION,
        schema: "tool-trace",
        trajectorySha256,
        objective,
        prompt: out.prompt,
        steps: out.steps,
        label,
        split,
        truncated,
        redactions: redactionAcc.count,
      };
    } else if (opts.schema === "sft-prompt-completion") {
      const out = encodeSftPromptCompletion(selected, objective, success, opts.maxChars, objectiveTruncated);
      truncated = truncated || out.truncated;
      contentText = out.prompt + "\n" + out.completion;
      record = {
        schemaVersion: EXAMPLE_SCHEMA_VERSION,
        schema: "sft-prompt-completion",
        trajectorySha256,
        objective,
        prompt: out.prompt,
        completion: out.completion,
        label,
        split,
        truncated,
        redactions: redactionAcc.count,
      };
    } else if (opts.schema === "chat-messages") {
      const sanitizedPreamble =
        opts.systemPreamble !== undefined ? sanitize(opts.systemPreamble, policy, redactionAcc) : undefined;
      const out = encodeChatMessages(
        selected,
        objective,
        success,
        sanitizedPreamble,
        opts.maxChars,
        objectiveTruncated,
      );
      truncated = truncated || out.truncated;
      contentText = out.messages.map((m) => m.content).join("\n");
      record = {
        schemaVersion: EXAMPLE_SCHEMA_VERSION,
        schema: "chat-messages",
        trajectorySha256,
        objective,
        messages: out.messages,
        label,
        split,
        truncated,
        redactions: redactionAcc.count,
      };
    } else {
      return skip("malformed-entry", `unknown schema "${String(opts.schema)}"`);
    }

    if (contentText.trim().length === 0) {
      return skip("unsafe-content", "encoded content sanitized to empty");
    }

    const charCount = unitCount(contentText);
    const tokensEstimate = estimateTokens(contentText);
    const full: Omit<TrainingRecord, "id"> = { ...record, charCount, tokensEstimate };
    const id = recordId(full);
    return { ok: true, record: { ...full, id } };
  } catch (err) {
    return skip("malformed-entry", `unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Encode a batch, preserving input order in both `records` and `skipped`
 * relative to each other's own subsequence - every dropped entry appears in
 * `skipped` with its reason; nothing is silently dropped.
 */
export function encodeBatch(
  entries: readonly CorpusEntry[],
  opts: EncodeOptions,
): { records: TrainingRecord[]; skipped: { trajectorySha256: string; code: EncodeSkipCode; detail: string }[] } {
  const records: TrainingRecord[] = [];
  const skipped: { trajectorySha256: string; code: EncodeSkipCode; detail: string }[] = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const result = encodeExample(entry, opts);
    if (result.ok) {
      records.push(result.record);
    } else {
      skipped.push({
        trajectorySha256: bestEffortTrajectorySha256(entry),
        code: result.skip.code,
        detail: result.skip.detail,
      });
    }
  }
  return { records, skipped };
}
