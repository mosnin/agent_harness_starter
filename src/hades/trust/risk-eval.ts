/**
 * Phase 14 checkpoint — the silent-wrong-rate proof obligation.
 *
 * This module drives the REAL eval corpus (`EVAL_TASKS` /
 * `EVAL_CATEGORIES`, `../bench/eval-suite`) through an INJECTED admission
 * port (`AdmitFn`), grades every produced output with the task's own
 * ground-truth grader (never the gate's score, never a solver's self-claim),
 * and measures the *silent-wrong rate* — `accepted AND wrong / accepted` —
 * against a configured `epsilon`. It also independently re-verifies EVERY
 * certificate issued for an accepted output with the REAL ed25519
 * `verifyCertificate` and the REAL bound-output check `certifiesOutput`
 * (`../styx/certificate`), so a gate cannot "pass" this checkpoint by
 * issuing certificates it never has to defend against re-audit.
 *
 * ## Real vs. scripted — read this before trusting any number this module
 * produces
 *
 *   - `EVAL_TASKS[i].grade` is the ONLY authority on correctness. It is
 *     imported unmodified from the real V-TPH$ harness (`../bench/eval-suite`)
 *     and invoked exactly as written there.
 *   - `AdmitFn` is INJECTED. This module makes no claim about what admits —
 *     production callers wire in the real `UnifiedTrustGate.admit`
 *     (`./unified-gate`); tests may wire in a simplified or adversarial
 *     admit function, and every such test says so in its title.
 *   - `scriptedSolvers()` returns four DETERMINISTIC, NON-MODEL answer
 *     generators — real regex/arithmetic/string transforms over each real
 *     task's `prompt` text, executed synchronously in this process. They are
 *     NOT calls to any language model; see `RiskEvalReport.provenance` for
 *     the verbatim statement this module ships in every report it produces.
 *   - Certificates are re-verified independently of whatever gate issued
 *     them: this module never trusts `admission.accepted` as proof a
 *     certificate is valid, it recomputes the ed25519 check and the
 *     output-hash binding itself, from scratch, every time.
 *
 * Deterministic: no `Date.now`, no `Math.random`, no reliance on Map/Set
 * iteration order for anything that lands in the report — every aggregate
 * is built by iterating the caller-supplied `tasks`/`solvers` arrays in
 * order and inserting into plain objects in that same order.
 *
 * @module hades/trust/risk-eval
 */

import { EVAL_TASKS, EVAL_CATEGORIES } from "../bench/eval-suite";
import type { EvalTask } from "../bench/vtph";
import {
  verifyCertificate,
  certifiesOutput,
  sha256Hex,
  type VerificationCertificate,
} from "../styx/certificate";

// ===========================================================================
// Locked public surface
// ===========================================================================

/** Structural mirror of `TrustSubject` (`./registry`) — declared here, NOT imported. */
export interface RiskEvalSubject {
  domain: string;
  subjectId: string;
  taskId: string;
  input: string;
  output: string;
  evidence: Readonly<Record<string, unknown>>;
  trace: readonly { seq: number; kind: string; detail: string }[];
}

/** Structural mirror of `Admission` (`./unified-gate`) — declared here, NOT imported. */
export interface RiskEvalAdmission {
  accepted: boolean;
  domain: string;
  taskId: string;
  score: number;
  threshold: number;
  pCorrect: number;
  epsilon: number;
  tier: string;
  certificate?: VerificationCertificate;
  abstention?: { code: string; message: string };
}

export type AdmitFn = (subject: RiskEvalSubject) => Promise<RiskEvalAdmission>;

/** A deterministic, non-model answer generator. Never network, never a model call. */
export interface ScriptedSolver {
  id: string;
  label: "faithful" | "lossy" | "fabricating" | "refusing";
  answer(task: EvalTask): {
    output: string;
    evidence: Record<string, unknown>;
    trace: { seq: number; kind: string; detail: string }[];
  };
}

export interface RiskEvalOptions {
  /** defaults to the REAL EVAL_TASKS */
  tasks?: EvalTask[];
  solvers?: ScriptedSolver[];
  epsilon: number;
  admit: AdmitFn;
  now?: () => number;
}

export interface RiskEvalReport {
  epsilon: number;
  taskCount: number;
  attempts: number;
  accepted: number;
  abstained: number;
  coverage: number;
  silentWrong: number;
  silentWrongRate: number;
  withinBound: boolean;
  /** the honest cost of abstention */
  abstainedButCorrect: number;
  certificatesIssued: number;
  certificatesVerified: number;
  certificateFailures: { taskId: string; reason: string }[];
  perCategory: Record<
    string,
    { attempts: number; accepted: number; silentWrong: number; silentWrongRate: number }
  >;
  perSolver: Record<string, { attempts: number; accepted: number; silentWrong: number }>;
  abstentionsByCode: Record<string, number>;
  provenance: { graderSource: string; solverSource: string; realComponents: string[] };
}

// ===========================================================================
// Scripted-solver answer derivation — real, deterministic string/regex/
// arithmetic transforms over each real task's prompt text. No task-id
// lookup tables: every derivation below is computed from `task.prompt` /
// `task.category`, so it generalizes to any future addition to EVAL_TASKS
// that follows the same category shapes, not just the 48 tasks that exist
// today.
// ===========================================================================

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HASHTAG_PATTERN = /#[A-Za-z0-9_]+/g;
const URL_PATTERN = /https?:\/\/[^\s,]+/g;
const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

function deriveExtractionAnswer(prompt: string): string {
  const headMatch = /extract all\s+([\s\S]*?)\s+from:/i.exec(prompt);
  const head = (headMatch ? headMatch[1] : "").toLowerCase();
  const sourceMatch = /from:\s*([\s\S]*?)\s*return\b/i.exec(prompt);
  const source = sourceMatch ? sourceMatch[1] : prompt;

  let pattern: RegExp;
  let numeric = false;
  if (head.includes("email")) pattern = EMAIL_PATTERN;
  else if (head.includes("hashtag")) pattern = HASHTAG_PATTERN;
  else if (head.includes("url")) pattern = URL_PATTERN;
  else if (head.includes("number")) {
    pattern = NUMBER_PATTERN;
    numeric = true;
  } else {
    throw new Error(`risk-eval: unrecognized extraction target in prompt: ${prompt}`);
  }

  const found = source.match(pattern) ?? [];
  const lower = /lowercased/i.test(prompt);
  const tokens = found.map((t) => (lower ? t.toLowerCase() : t));
  const unique = Array.from(new Set(tokens));

  if (numeric) {
    return unique
      .map(Number)
      .sort((a, b) => a - b)
      .join(",");
  }
  unique.sort();
  return unique.join(",");
}

function deriveClassificationAnswer(prompt: string): string {
  const labelMatch = /\(([a-z]+(?:\/[a-z]+)+)\)/i.exec(prompt);
  const labels = labelMatch ? labelMatch[1].split("/").map((s) => s.toLowerCase()) : [];
  const textMatch = /\):\s*([\s\S]*?)\s*answer\b/i.exec(prompt);
  const text = (textMatch ? textMatch[1] : prompt).toLowerCase();

  if (labels.includes("positive")) {
    const negativeWords = ["worst", "terrible", "hate", "bad", "awful", "horrible"];
    const positiveWords = ["love", "great", "excellent", "amazing", "wonderful", "fantastic", "happy"];
    if (negativeWords.some((w) => text.includes(w))) return "negative";
    if (positiveWords.some((w) => text.includes(w))) return "positive";
    return "neutral";
  }
  if (labels.includes("english")) {
    const frenchWords = ["bonjour", "comment", "vous", "aujourd'hui", "merci"];
    const spanishWords = ["hola", "llamo", "vivo", "gracias"];
    if (frenchWords.some((w) => text.includes(w))) return "french";
    if (spanishWords.some((w) => text.includes(w))) return "spanish";
    return "english";
  }
  if (labels.includes("sports")) {
    const techWords = ["smartphone", "processor", "camera", "software", "computer", "tech"];
    const politicsWords = ["senator", "bill", "election", "president", "congress", "tax", "law", "vote"];
    if (techWords.some((w) => text.includes(w))) return "technology";
    if (politicsWords.some((w) => text.includes(w))) return "politics";
    return "sports";
  }
  throw new Error(`risk-eval: unrecognized classification label set in prompt: ${prompt}`);
}

/** Pull the first balanced {...} object out of prose and JSON.parse it. Local
 *  re-implementation (module-private), independent of ../bench/eval-suite's
 *  private helper of the same shape. */
function firstJsonObject(s: string): unknown {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function deriveTransformationAnswer(prompt: string): string {
  const csvMatch = /CSV row `([^`]*)` with header `([^`]*)`/i.exec(prompt);
  if (csvMatch) {
    const rowVals = csvMatch[1].split(",").map((s) => s.trim());
    const headerKeys = csvMatch[2].split(",").map((s) => s.trim());
    const typeHints: Record<string, string> = {};
    const typeRe = /(\w+)\s+as\s+an?\s+(string|number|boolean)/gi;
    let tm: RegExpExecArray | null;
    while ((tm = typeRe.exec(prompt)) !== null) {
      typeHints[tm[1].toLowerCase()] = tm[2].toLowerCase();
    }
    const obj: Record<string, unknown> = {};
    headerKeys.forEach((key, i) => {
      const raw = rowVals[i] ?? "";
      const type = typeHints[key.toLowerCase()] ?? "string";
      if (type === "number") obj[key] = Number(raw);
      else if (type === "boolean") obj[key] = raw.toLowerCase() === "true";
      else obj[key] = raw;
    });
    return JSON.stringify(obj);
  }

  if (/swap keys and values/i.test(prompt)) {
    const src = firstJsonObject(prompt) as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = {};
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) out[String(v)] = k;
    }
    return JSON.stringify(out);
  }

  if (/uppercase every string value/i.test(prompt)) {
    const src = firstJsonObject(prompt) as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = {};
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src)) out[k] = typeof v === "string" ? v.toUpperCase() : v;
    }
    return JSON.stringify(out);
  }

  throw new Error(`risk-eval: no transformation derivation rule matched prompt: ${prompt}`);
}

function deriveReasoningAnswer(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes(" some ") && p.includes(" all ")) return "no";
  if (p.includes("necessarily")) return "no";
  if (p.includes("is every")) return "no";
  return "yes";
}

function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}
function sumPrimesBelow(n: number): number {
  let sum = 0;
  for (let i = 2; i < n; i++) if (isPrime(i)) sum += i;
  return sum;
}
function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
function countVowels(s: string): number {
  const m = s.match(/[aeiouAEIOU]/g);
  return m ? m.length : 0;
}

function deriveArithmeticAnswer(prompt: string): number {
  let m: RegExpExecArray | null;
  if ((m = /sum of all prime numbers below (\d+)/i.exec(prompt))) {
    return sumPrimesBelow(Number(m[1]));
  }
  if ((m = /(\d+(?:\.\d+)?)% of (\d+(?:\.\d+)?)/i.exec(prompt))) {
    return (Number(m[1]) / 100) * Number(m[2]);
  }
  if ((m = /(\d+)\s*factorial|\((\d+)!\)/i.exec(prompt))) {
    return factorial(Number(m[1] ?? m[2]));
  }
  if ((m = /\$(\d+(?:\.\d+)?)[\s\S]*?discounted (\d+(?:\.\d+)?)%/i.exec(prompt))) {
    return Number(m[1]) * (1 - Number(m[2]) / 100);
  }
  if ((m = /sum of the first (\d+) positive integers/i.exec(prompt))) {
    const n = Number(m[1]);
    return (n * (n + 1)) / 2;
  }
  if ((m = /travels (\d+(?:\.\d+)?) miles in (\d+(?:\.\d+)?) hours/i.exec(prompt))) {
    return Number(m[1]) / Number(m[2]);
  }
  if ((m = /(\d+) to the power of (\d+)/i.exec(prompt))) {
    return Math.pow(Number(m[1]), Number(m[2]));
  }
  if ((m = /greatest common divisor of (\d+) and (\d+)/i.exec(prompt))) {
    return gcd(Number(m[1]), Number(m[2]));
  }
  throw new Error(`risk-eval: no arithmetic derivation rule matched prompt: ${prompt}`);
}

const CITY_COUNTRY: Record<string, string> = {
  paris: "france",
  tokyo: "japan",
  cairo: "egypt",
};

function detectMultiPartOp(promptLower: string): string {
  if (promptLower.includes("first letter")) return "first-letter";
  if (promptLower.includes("double")) return "double";
  if (promptLower.includes("even or odd")) return "parity";
  if (promptLower.includes("square")) return "square";
  if (promptLower.includes("country")) return "country";
  if (promptLower.includes("vowel")) return "vowel-count";
  if (promptLower.includes("add 10")) return "plus-ten";
  if (promptLower.includes("prime")) return "is-prime";
  if (promptLower.includes("fahrenheit")) return "celsius-to-fahrenheit";
  if (promptLower.includes("number of letters")) return "length";
  if (promptLower.includes("half")) return "half";
  if (promptLower.includes("length")) return "length";
  return "unknown";
}

function deriveMultiPartAnswer(prompt: string): string {
  const listMatch = /[:?]\s*([\s\S]*?)\.\s*return\b/i.exec(prompt);
  const itemsRaw = listMatch ? listMatch[1] : "";
  const items = itemsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const op = detectMultiPartOp(prompt.toLowerCase());

  const pairs = items.map((item) => {
    let value: string;
    switch (op) {
      case "length":
        value = String(item.length);
        break;
      case "first-letter":
        value = item.charAt(0).toLowerCase();
        break;
      case "double":
        value = String(Number(item) * 2);
        break;
      case "parity":
        value = Number(item) % 2 === 0 ? "even" : "odd";
        break;
      case "square":
        value = String(Number(item) ** 2);
        break;
      case "country":
        value = CITY_COUNTRY[item.toLowerCase()] ?? "unknown";
        break;
      case "vowel-count":
        value = String(countVowels(item));
        break;
      case "plus-ten":
        value = String(Number(item) + 10);
        break;
      case "is-prime":
        value = isPrime(Number(item)) ? "yes" : "no";
        break;
      case "celsius-to-fahrenheit":
        value = String((Number(item) * 9) / 5 + 32);
        break;
      case "half":
        value = String(Number(item) / 2);
        break;
      default:
        throw new Error(`risk-eval: no multi-part operation derivation for prompt: ${prompt}`);
    }
    return `${item}:${value}`;
  });

  return pairs.join(",");
}

function deriveFaithfulOutput(task: EvalTask): string {
  switch (task.category) {
    case "extraction":
      return deriveExtractionAnswer(task.prompt);
    case "classification":
      return deriveClassificationAnswer(task.prompt);
    case "transformation":
      return deriveTransformationAnswer(task.prompt);
    case "reasoning":
      return deriveReasoningAnswer(task.prompt);
    case "arithmetic":
      return String(deriveArithmeticAnswer(task.prompt));
    case "multi-part":
      return deriveMultiPartAnswer(task.prompt);
    default:
      throw new Error(
        `risk-eval: no faithful-answer derivation rule for category "${task.category}" (task ${task.id})`,
      );
  }
}

/** Always-different truncation: a real (lossy, information-destroying) string
 *  transform of the faithful answer — not a fabrication, a degradation. */
function lossyTransform(faithful: string): string {
  if (faithful.length <= 1) return "";
  const cut = Math.max(1, Math.floor(faithful.length / 2));
  return faithful.slice(0, cut);
}

/**
 * Deterministic, structurally-plausible-but-wrong mutation of the faithful
 * answer, tailored per category so the mutated output still has the RIGHT
 * SHAPE (a real label, a real number, valid JSON, a real pairs string) —
 * exactly the adversary a shallow structural check cannot catch, and exactly
 * what the real ground-truth grader must catch instead.
 */
function fabricateTransform(task: EvalTask, faithful: string): string {
  switch (task.category) {
    case "extraction": {
      if (faithful.length === 0) return "999999";
      const head = task.prompt.toLowerCase();
      const suffix = head.includes("email")
        ? ",zzzz@fabricated.example"
        : head.includes("hashtag")
          ? ",#fabricated"
          : head.includes("url")
            ? ",https://fabricated.example"
            : ",999999";
      return faithful + suffix;
    }
    case "classification": {
      const cycle: Record<string, string> = {
        positive: "negative",
        negative: "neutral",
        neutral: "positive",
        english: "french",
        french: "spanish",
        spanish: "english",
        sports: "politics",
        politics: "technology",
        technology: "sports",
      };
      return cycle[faithful] ?? `${faithful}-fabricated`;
    }
    case "reasoning":
      return faithful === "yes" ? "no" : "yes";
    case "arithmetic": {
      const n = Number(faithful);
      return String(Number.isFinite(n) ? n + 7 : 7);
    }
    case "transformation": {
      const obj = firstJsonObject(faithful) as Record<string, unknown> | undefined;
      if (!obj || typeof obj !== "object") return `${faithful}-fabricated`;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "number") out[k] = v + 1;
        else if (typeof v === "boolean") out[k] = !v;
        else if (typeof v === "string") out[k] = `${v}X`;
        else out[k] = v;
      }
      return JSON.stringify(out);
    }
    case "multi-part": {
      if (faithful.length === 0) return "x:1";
      const pairs = faithful.split(",").map((p) => {
        const idx = p.indexOf(":");
        if (idx < 0) return p;
        const key = p.slice(0, idx);
        const value = p.slice(idx + 1);
        return /^\d+$/.test(value) ? `${key}:${Number(value) + 1}` : `${key}:${value}x`;
      });
      return pairs.join(",");
    }
    default:
      return `${faithful}-fabricated`;
  }
}

/** The four scripted, non-model, deterministic answer generators. */
export function scriptedSolvers(): ScriptedSolver[] {
  return [
    {
      id: "solver-faithful",
      label: "faithful",
      answer(task) {
        const output = deriveFaithfulOutput(task);
        return {
          output,
          evidence: { solverId: "solver-faithful", label: "faithful", taskId: task.id, category: task.category },
          trace: [
            { seq: 1, kind: "parse-prompt", detail: `parsed prompt for task ${task.id}` },
            { seq: 2, kind: "derive-answer", detail: `derived answer via ${task.category} rule (deterministic, no model)` },
            { seq: 3, kind: "emit", detail: `emitted output of length ${output.length}` },
          ],
        };
      },
    },
    {
      id: "solver-lossy",
      label: "lossy",
      answer(task) {
        const faithful = deriveFaithfulOutput(task);
        const output = lossyTransform(faithful);
        return {
          output,
          evidence: { solverId: "solver-lossy", label: "lossy", taskId: task.id, sourceLength: faithful.length },
          trace: [
            { seq: 1, kind: "parse-prompt", detail: `parsed prompt for task ${task.id}` },
            { seq: 2, kind: "derive-answer", detail: `derived faithful answer via ${task.category} rule` },
            {
              seq: 3,
              kind: "truncate",
              detail: `truncated faithful answer from ${faithful.length} to ${output.length} chars`,
            },
          ],
        };
      },
    },
    {
      id: "solver-fabricating",
      label: "fabricating",
      answer(task) {
        const faithful = deriveFaithfulOutput(task);
        const output = fabricateTransform(task, faithful);
        return {
          output,
          evidence: { solverId: "solver-fabricating", label: "fabricating", taskId: task.id, basedOn: faithful },
          trace: [
            { seq: 1, kind: "parse-prompt", detail: `parsed prompt for task ${task.id}` },
            { seq: 2, kind: "derive-answer", detail: `derived faithful answer via ${task.category} rule` },
            {
              seq: 3,
              kind: "fabricate",
              detail: "mutated to a structurally-plausible but ground-truth-incorrect value",
            },
          ],
        };
      },
    },
    {
      id: "solver-refusing",
      label: "refusing",
      answer(task) {
        return {
          output: "",
          evidence: { solverId: "solver-refusing", label: "refusing", taskId: task.id },
          trace: [{ seq: 1, kind: "refuse", detail: `declined to answer task ${task.id}` }],
        };
      },
    },
  ];
}

// ===========================================================================
// Independent certificate audit
// ===========================================================================

/**
 * Independently re-verify one certificate against one delivered output,
 * from scratch — never trusting the gate that issued it. Returns a distinct
 * `reason` string for each independent failure class so an audit trail can
 * tell a missing certificate from a malformed signature from a tampered
 * payload from a certificate bound to the wrong output.
 */
async function auditCertificate(
  cert: VerificationCertificate | undefined,
  output: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (cert === undefined) return { ok: false, reason: "missing-certificate" };

  const sigOk = typeof cert.signature === "string" && /^[0-9a-fA-F]{128}$/.test(cert.signature);
  const pubOk = typeof cert.publicKey === "string" && /^[0-9a-fA-F]{64}$/.test(cert.publicKey);
  if (!sigOk || !pubOk) return { ok: false, reason: "signature-malformed" };

  let sigValid: boolean;
  try {
    sigValid = await verifyCertificate(cert);
  } catch {
    sigValid = false;
  }
  if (!sigValid) return { ok: false, reason: "signature-invalid" };

  // Independent output-hash cross-check (real sha256, recomputed here) in
  // addition to the real bound-output check — belt and suspenders, and the
  // reason a swapped-certificate attack is distinguished from a tampered
  // signature above.
  const expectedHash = sha256Hex(output);
  const hashOk =
    typeof cert.payload?.outputSha256 === "string" && cert.payload.outputSha256.toLowerCase() === expectedHash;

  let boundOk: boolean;
  try {
    boundOk = await certifiesOutput(cert, output);
  } catch {
    boundOk = false;
  }

  if (!hashOk || !boundOk) return { ok: false, reason: "output-mismatch" };
  return { ok: true };
}

// ===========================================================================
// The checkpoint runner
// ===========================================================================

function emptyCategoryBucket(): { attempts: number; accepted: number; silentWrong: number; silentWrongRate: number } {
  return { attempts: 0, accepted: 0, silentWrong: 0, silentWrongRate: 0 };
}
function emptySolverBucket(): { attempts: number; accepted: number; silentWrong: number } {
  return { attempts: 0, accepted: 0, silentWrong: 0 };
}

export async function runRiskEval(opts: RiskEvalOptions): Promise<RiskEvalReport> {
  const epsilon = opts.epsilon;
  if (typeof epsilon !== "number" || !Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1) {
    throw new RangeError(`runRiskEval: epsilon must be strictly inside (0, 1); got ${String(epsilon)}`);
  }
  const tasks = opts.tasks ?? EVAL_TASKS;
  const solvers = opts.solvers ?? scriptedSolvers();
  const now = opts.now ?? ((): number => 0); // never Date.now — deterministic by default

  let attempts = 0;
  let accepted = 0;
  let abstained = 0;
  let silentWrong = 0;
  let abstainedButCorrect = 0;
  let certificatesIssued = 0;
  let certificatesVerified = 0;
  const certificateFailures: { taskId: string; reason: string }[] = [];

  // Pre-seed every REAL category (from the real EVAL_CATEGORIES taxonomy) so
  // the report always accounts for the full corpus shape, even categories
  // with zero attempts in a filtered run.
  const perCategory: RiskEvalReport["perCategory"] = {};
  for (const cat of EVAL_CATEGORIES) perCategory[cat] = emptyCategoryBucket();

  const perSolver: RiskEvalReport["perSolver"] = {};
  const abstentionsByCode: Record<string, number> = {};

  const bumpCode = (code: string): void => {
    abstentionsByCode[code] = (abstentionsByCode[code] ?? 0) + 1;
  };

  for (const solver of solvers) {
    if (perSolver[solver.id] === undefined) perSolver[solver.id] = emptySolverBucket();
    const solverBucket = perSolver[solver.id];

    for (const task of tasks) {
      if (perCategory[task.category] === undefined) perCategory[task.category] = emptyCategoryBucket();
      const catBucket = perCategory[task.category];

      attempts += 1;
      catBucket.attempts += 1;
      solverBucket.attempts += 1;

      let produced: { output: string; evidence: Record<string, unknown>; trace: { seq: number; kind: string; detail: string }[] };
      try {
        produced = solver.answer(task);
      } catch (err) {
        // A scripted solver that cannot answer a given task is a harness
        // condition, never a silent pass: record it as abstained, never
        // graded, and move on without aborting the run.
        const message = err instanceof Error ? err.message : String(err);
        abstained += 1;
        bumpCode(`harness-solver-error:${message.slice(0, 80)}`);
        continue;
      }

      const subject: RiskEvalSubject = {
        domain: "procedure",
        subjectId: `${solver.id}::${task.id}`,
        taskId: task.id,
        input: task.prompt,
        output: produced.output,
        evidence: Object.freeze({ ...produced.evidence }),
        trace: [
          ...produced.trace,
          { seq: produced.trace.length + 1, kind: "harness-dispatch", detail: `dispatched to admit() at clock=${now()}` },
        ],
      };

      let admission: RiskEvalAdmission;
      try {
        admission = await opts.admit(subject);
      } catch (err) {
        // An admit() that throws or rejects is never allowed to abort the
        // run or to be silently treated as acceptance: it becomes a
        // first-class abstention with its own reason code.
        const message = err instanceof Error ? err.message : String(err);
        admission = {
          accepted: false,
          domain: subject.domain,
          taskId: subject.taskId,
          score: 0,
          threshold: Number.POSITIVE_INFINITY,
          pCorrect: 0,
          epsilon,
          tier: "unknown",
          abstention: { code: "harness-admit-error", message: `admit() threw/rejected: ${message.slice(0, 300)}` },
        };
      }

      // Correctness is decided ONLY by the task's own real grader — never by
      // admission.score, never by the solver's own label. A throwing grader
      // is a harness error and is NEVER silently treated as correct.
      let correct: boolean;
      try {
        correct = task.grade(produced.output);
      } catch (err) {
        correct = false;
        const message = err instanceof Error ? err.message : String(err);
        bumpCode(`harness-grader-error:${task.id}:${message.slice(0, 60)}`);
      }

      if (admission.accepted) {
        accepted += 1;
        catBucket.accepted += 1;
        solverBucket.accepted += 1;
        if (!correct) {
          silentWrong += 1;
          catBucket.silentWrong += 1;
          solverBucket.silentWrong += 1;
        }

        if (admission.certificate !== undefined) certificatesIssued += 1;
        const audit = await auditCertificate(admission.certificate, produced.output);
        if (audit.ok) {
          certificatesVerified += 1;
        } else {
          certificateFailures.push({ taskId: task.id, reason: audit.reason });
        }
      } else {
        abstained += 1;
        if (correct) abstainedButCorrect += 1;
        bumpCode(admission.abstention?.code ?? "unknown-abstention");
      }
    }
  }

  for (const cat of Object.keys(perCategory)) {
    const b = perCategory[cat];
    b.silentWrongRate = b.accepted > 0 ? b.silentWrong / b.accepted : 0;
  }

  const coverage = attempts > 0 ? accepted / attempts : 0;
  const silentWrongRate = accepted > 0 ? silentWrong / accepted : 0;
  // A certificate-audit failure is a hard fail regardless of the numeric
  // rate: an accepted output whose "proof" does not independently check out
  // is exactly the failure mode this checkpoint exists to catch.
  const withinBound = certificateFailures.length === 0 && silentWrongRate <= epsilon;

  return {
    epsilon,
    taskCount: tasks.length,
    attempts,
    accepted,
    abstained,
    coverage,
    silentWrong,
    silentWrongRate,
    withinBound,
    abstainedButCorrect,
    certificatesIssued,
    certificatesVerified,
    certificateFailures,
    perCategory,
    perSolver,
    abstentionsByCode,
    provenance: {
      graderSource:
        "EvalTask.grade from the REAL eval corpus (src/hades/bench/eval-suite.ts EVAL_TASKS) — " +
        "pure, deterministic, ground-truth graders; never the gate's score, never a solver's self-claim.",
      solverSource:
        "scripted deterministic answer generators (src/hades/trust/risk-eval.ts scriptedSolvers()) — " +
        "NOT model calls: no LLM inference, no network I/O; pure regex/arithmetic/string transforms over " +
        "each real EvalTask.prompt, executed synchronously in-process.",
      realComponents: [
        `EVAL_TASKS + EVAL_CATEGORIES (${EVAL_CATEGORIES.join(", ")}) — the real eval corpus (../bench/eval-suite)`,
        "AdmitFn — injected; production callers pass the real UnifiedTrustGate.admit (../trust/unified-gate)",
        "verifyCertificate — real ed25519 signature check (../styx/certificate)",
        "certifiesOutput — real bound-output check recomputing sha256 (../styx/certificate)",
        "sha256Hex — real sha256, used for an independent output-hash cross-check in the certificate audit (../styx/certificate)",
      ],
    },
  };
}

// ===========================================================================
// Reporting — aligned ASCII terminal output. No HTML, no web output.
// ===========================================================================

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render a `RiskEvalReport` as aligned plain ASCII text — CLI/TUI-ready
 * (`hades` speaks the terminal, never a browser). Zero-coverage runs are
 * flagged as DEGENERATE rather than presented as a PASS, so an abstain-all
 * run can never be read as a checkpoint pass.
 */
export function formatRiskEvalReport(r: RiskEvalReport): string {
  const lines: string[] = [];
  lines.push("V-TPH RISK EVAL -- SILENT-WRONG CHECKPOINT");
  lines.push("=".repeat(60));
  lines.push(`epsilon (configured bound)          : ${r.epsilon.toFixed(4)}`);
  lines.push(`tasks in corpus                     : ${r.taskCount}`);
  lines.push(`attempts (tasks x solvers)          : ${r.attempts}`);
  lines.push(`accepted                            : ${r.accepted}`);
  lines.push(`abstained                           : ${r.abstained}`);
  lines.push(`coverage (accepted / attempts)      : ${r.coverage.toFixed(4)}`);
  lines.push(`silent-wrong (accepted AND wrong)   : ${r.silentWrong}`);
  lines.push(`silent-wrong rate (MEASURED)        : ${r.silentWrongRate.toFixed(4)}`);
  lines.push(`abstained-but-correct               : ${r.abstainedButCorrect}`);
  lines.push(`certificates issued                 : ${r.certificatesIssued}`);
  lines.push(`certificates independently verified : ${r.certificatesVerified}`);
  lines.push(`certificate failures                : ${r.certificateFailures.length}`);
  lines.push("");

  if (r.accepted === 0) {
    lines.push(
      `RESULT: DEGENERATE (zero coverage -- ${r.attempts} attempt(s), 0 accepted; ` +
        `PASS/FAIL cannot be honestly claimed)`,
    );
  } else if (r.withinBound) {
    lines.push(
      `RESULT: PASS  (silent-wrong rate ${r.silentWrongRate.toFixed(4)} <= epsilon ${r.epsilon.toFixed(4)}, ` +
        `0 certificate failures)`,
    );
  } else {
    const reasons: string[] = [];
    if (r.silentWrongRate > r.epsilon) {
      reasons.push(`silent-wrong rate ${r.silentWrongRate.toFixed(4)} exceeds epsilon ${r.epsilon.toFixed(4)}`);
    }
    if (r.certificateFailures.length > 0) {
      reasons.push(`${r.certificateFailures.length} certificate failure(s)`);
    }
    lines.push(`RESULT: FAIL  (${reasons.join("; ")})`);
  }
  lines.push("");

  const catNames = Object.keys(r.perCategory).sort();
  if (catNames.length > 0) {
    lines.push("PER-CATEGORY");
    const headers = ["CATEGORY", "ATTEMPTS", "ACCEPTED", "SILENT-WRONG", "RATE"];
    const rows = catNames.map((c) => {
      const b = r.perCategory[c];
      return [c, String(b.attempts), String(b.accepted), String(b.silentWrong), b.silentWrongRate.toFixed(4)];
    });
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) lines.push(row.map((c, i) => padRight(c, widths[i])).join("  "));
    lines.push("");
  }

  const solverNames = Object.keys(r.perSolver).sort();
  if (solverNames.length > 0) {
    lines.push("PER-SOLVER");
    const headers = ["SOLVER", "ATTEMPTS", "ACCEPTED", "SILENT-WRONG"];
    const rows = solverNames.map((s) => {
      const b = r.perSolver[s];
      return [s, String(b.attempts), String(b.accepted), String(b.silentWrong)];
    });
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
    lines.push(headers.map((h, i) => padRight(h, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) lines.push(row.map((c, i) => padRight(c, widths[i])).join("  "));
    lines.push("");
  }

  const codeNames = Object.keys(r.abstentionsByCode)
    .filter((k) => r.abstentionsByCode[k] > 0)
    .sort();
  if (codeNames.length > 0) {
    lines.push("ABSTENTION / HARNESS CODES");
    for (const c of codeNames) lines.push(`  ${c} = ${r.abstentionsByCode[c]}`);
    lines.push("");
  }

  if (r.certificateFailures.length > 0) {
    lines.push("CERTIFICATE FAILURES (independent audit)");
    for (const f of r.certificateFailures) lines.push(`  task=${f.taskId} reason=${f.reason}`);
    lines.push("");
  }

  lines.push("PROVENANCE");
  lines.push(`  grader source   : ${r.provenance.graderSource}`);
  lines.push(`  solver source   : ${r.provenance.solverSource}`);
  lines.push("  real components :");
  for (const c of r.provenance.realComponents) lines.push(`    - ${c}`);

  return lines.join("\n");
}
