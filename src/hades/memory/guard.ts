/**
 * STYX memory write-guard: the beyond-Hermes moat for the closed learning
 * loop. Every write to long-term memory passes through a verification gate
 * before it lands — deterministic contradiction detection against existing
 * high-salience facts, a `VerifierVote`-compatible calibrated verdict, and a
 * quarantine/resolution workflow. A contradicting fact is never silently
 * overwritten; it is flagged for a human (or a higher-tier verifier) to
 * resolve.
 *
 * ---------------------------------------------------------------------------
 * What this module can and cannot attest to
 * ---------------------------------------------------------------------------
 * Detection here is REAL deterministic lexical/structural analysis — content-
 * word overlap, a curated antonym table, number/unit parsing, negation-cue
 * matching. There is no LLM call, no randomness, no network I/O. Precisely
 * because of that, this module can prove two facts share enough surface-level
 * topic overlap AND contain an explicit contradiction marker (a negation, a
 * conflicting number, an antonym, or a mismatched exclusive value). It CANNOT
 * prove semantic contradiction in general — paraphrases that share no content
 * words, or contradictions that require world knowledge, will slip through as
 * false negatives; coincidental phrase overlap can in principle produce a
 * false positive. That honesty is why `memoryWriteCalibration()` labels this
 * T4-consistency (self-consistency over the store's own text) with a
 * conservative prior, the same style as `../tools/verifiers.ts`'s stubs — see
 * that file's docstring for the shared calibration philosophy.
 *
 * ---------------------------------------------------------------------------
 * Detection kinds
 * ---------------------------------------------------------------------------
 *   negation         "user likes coffee" vs "user does not like coffee" — one
 *                     side negates a predicate the two sides otherwise share.
 *                     Handles 'not', "n't" contractions, 'no longer', 'never',
 *                     and 'stopped Xing'. Requires >=60% content-word overlap
 *                     on the shorter side so unrelated negated facts (e.g.
 *                     "does not like mornings") do not misfire.
 *   numeric          "timeout is 30s" vs "timeout is 45s" — same attribute
 *                     context, a conflicting number or unit. Equal values, or
 *                     numbers attached to different attributes, do not fire.
 *   antonym          A curated antonym table (35 pairs) fires only when the
 *                     surrounding (non-trigger) context also overlaps, so
 *                     "enabled notifications" vs "disabled logging" — same
 *                     antonym pair, different topic — does not fire.
 *   exclusive-value   "default model is alpha" vs "default model is beta" —
 *                     same attribute phrase, mutually exclusive values. An
 *                     additive/superset value ("prefers coffee" vs "prefers
 *                     coffee and tea") does not fire.
 *
 * Every kind is a pure function of two strings; `detectContradictions` runs
 * them, in this fixed order, once per candidate existing-record pair — a
 * single pass over `existing`, no per-pair quadratic blowup across records.
 */

import { randomUUID } from "node:crypto";
import type { MemoryRecord, MemoryStore } from "./store";
import type { TierId, VerifierVote } from "../styx/tiers";

// ===========================================================================
// Locked public contract
// ===========================================================================

export type ContradictionKind = "negation" | "numeric" | "antonym" | "exclusive-value";

export interface ContradictionFinding {
  existing: MemoryRecord;
  kind: ContradictionKind;
  detail: string;
  confidence: number;
}

export interface MemoryWriteVerdict extends VerifierVote {
  verifierId: "verify.memory-write";
  passed: boolean;
  confidence: number;
  reasons: string[];
  contradictions: ContradictionFinding[];
}

export interface FlaggedWrite {
  id: string;
  candidate: { fact: string; salience: number; tags: string[]; source?: string };
  verdict: MemoryWriteVerdict;
  at: number;
  resolution?: "accept-new" | "keep-existing" | "supersede";
}

const DEFAULT_SALIENCE_FLOOR = 0.7;

// ===========================================================================
// Fixed, documented per-kind confidences.
// ---------------------------------------------------------------------------
// These are NOT tuned on data (there is no labelled corpus at inference
// time) — they are hand-set, ordered by how unambiguous each marker is once
// the context-overlap gate has already passed. Numeric conflicts are the
// least ambiguous (a number either matches or it doesn't); negation next
// (an explicit negator is a strong, if occasionally noisy, signal);
// exclusive-value next (two distinct nouns in the same value slot could in
// principle both be a valid multi-valued fact the check under-approximated
// as exclusive); antonym is the weakest of the four (a curated table can
// itself be wrong for polysemous words, e.g. "light" meaning weight vs
// illumination).
// ===========================================================================
const NEGATION_CONFIDENCE = 0.8;
const NUMERIC_CONFIDENCE = 0.85;
const ANTONYM_CONFIDENCE = 0.75;
const EXCLUSIVE_VALUE_CONFIDENCE = 0.7;

// ===========================================================================
// Shared lexical helpers (pure, deterministic, no locale/unicode surprises
// beyond the ASCII-word tokenizer documented below).
// ===========================================================================

/** Lowercase + expand contractions to their two-word form so "not"/negation
 *  detection has a single surface form to match against. Irregular
 *  contractions are special-cased before the generic `n't` -> " not" rule
 *  (which alone would mangle "won't" -> "wo not" and "can't" -> "ca not"). */
function normalizeText(text: string): string {
  let t = (text ?? "").toLowerCase();
  t = t.replace(/\bwon't\b/g, "will not");
  t = t.replace(/\bcan't\b/g, "cannot");
  t = t.replace(/\bshan't\b/g, "shall not");
  t = t.replace(/\bain't\b/g, "is not");
  t = t.replace(/(\w+)n't\b/g, "$1 not");
  return t;
}

/** ASCII word tokenizer. Non-ASCII letters (accents, CJK, …) are not matched
 *  by design — they simply drop out of the content-word set rather than
 *  crashing or being mis-tokenized, so unicode facts degrade to "no overlap
 *  found" (safe: no contradiction is ever fabricated from unparsed text). */
function wordTokens(normalized: string): string[] {
  return normalized.match(/[a-z0-9]+/g) ?? [];
}

/** Light stemmer — good enough to unify "likes"/"like", "drinks"/"drinking",
 *  "enabled"/"disabled" plural/participle forms for overlap comparison. Not a
 *  linguistically complete stemmer; deliberately simple and deterministic. */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "doing", "has", "have", "had", "having",
  "to", "of", "for", "and", "or", "but", "if", "in", "on", "at", "with",
  "this", "that", "these", "those", "it", "its", "as", "by", "from", "so",
  "than", "then", "there", "here", "just", "also", "very", "really", "every",
  "i", "you", "he", "she", "they", "we", "my", "your", "his", "her", "their", "our",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "not", "never", "cannot", "no", "longer",
]);

/** Common light/state verbs excluded from NEGATION overlap only — otherwise a
 *  shared predicate verb like "like"/"likes" inflates overlap enough that
 *  "user likes coffee" vs "user does not like mornings" would (wrongly) look
 *  like a negation of the SAME fact. Not used by the antonym/exclusive-value
 *  checks, which have their own, more targeted exclusions. */
const LIGHT_VERBS = new Set(["like", "love", "want", "need", "prefer", "hate", "avoid", "enjoy"]);

/** Content words (stemmed, stopwords + "stop*" negation-marker words removed)
 *  for a normalized sentence. `extraExclude` lets a caller drop additional
 *  low-signal stems (see `LIGHT_VERBS`). */
function contentWords(normalized: string, extraExclude?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const t of wordTokens(normalized)) {
    if (STOPWORDS.has(t)) continue;
    if (t === "stop" || t === "stops" || t === "stopped" || t === "stopping") continue;
    const s = stem(t);
    if (extraExclude && extraExclude.has(s)) continue;
    out.push(s);
  }
  return out;
}

/** Fraction of the SHORTER side's distinct terms that also appear on the
 *  longer side. 0 if either side is empty (nothing to compare). */
function overlapFraction(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const w of smaller) if (larger.has(w)) inter++;
  return inter / smaller.size;
}

function sharedTerms(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of a) {
    if (setB.has(w) && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/** Negation cue detector — 'not'/'never'/'cannot' (post `n't` expansion),
 *  'no longer', and 'stopped Xing'. Operates on the normalized (but still
 *  punctuated) text so `\b` word boundaries work correctly. */
function hasNegationCue(normalized: string): boolean {
  return (
    /\b(not|never|cannot)\b/.test(normalized) ||
    /\bno\s+longer\b/.test(normalized) ||
    /\bstopped\s+\w+ing\b/.test(normalized)
  );
}

// ===========================================================================
// Kind: negation
// ===========================================================================

const NEGATION_OVERLAP_THRESHOLD = 0.6;

function checkNegation(candidate: string, existingFact: string): { detail: string } | null {
  const cNorm = normalizeText(candidate);
  const eNorm = normalizeText(existingFact);
  const cNeg = hasNegationCue(cNorm);
  const eNeg = hasNegationCue(eNorm);
  if (cNeg === eNeg) return null; // both assert or both negate -> not a negation conflict

  const cContent = contentWords(cNorm, LIGHT_VERBS);
  const eContent = contentWords(eNorm, LIGHT_VERBS);
  const overlap = overlapFraction(cContent, eContent);
  if (overlap < NEGATION_OVERLAP_THRESHOLD) return null;

  const shared = sharedTerms(cContent, eContent);
  return {
    detail: `candidate ${cNeg ? "negates" : "asserts"} vs existing ${eNeg ? "negates" : "asserts"} shared content [${shared.join(", ")}] (overlap ${(overlap * 100).toFixed(0)}%)`,
  };
}

// ===========================================================================
// Kind: numeric
// ===========================================================================

const UNIT_ALIASES: Record<string, string> = {
  milliseconds: "ms", millisecond: "ms", ms: "ms",
  seconds: "s", second: "s", secs: "s", sec: "s", s: "s",
  minutes: "min", minute: "min", mins: "min", min: "min",
  hours: "h", hour: "h", hrs: "h", hr: "h", h: "h",
  days: "d", day: "d", d: "d",
  kilograms: "kg", kilogram: "kg", kg: "kg",
  grams: "g", gram: "g", g: "g",
  milligrams: "mg", milligram: "mg", mg: "mg",
  gigabytes: "gb", gigabyte: "gb", gb: "gb",
  megabytes: "mb", megabyte: "mb", mb: "mb",
  kilobytes: "kb", kilobyte: "kb", kb: "kb",
  terabytes: "tb", terabyte: "tb", tb: "tb",
  percent: "%", "%": "%",
  pixels: "px", pixel: "px", px: "px",
  kilometers: "km", kilometer: "km", km: "km",
  meters: "m", meter: "m", m: "m",
  centimeters: "cm", centimeter: "cm", cm: "cm",
  millimeters: "mm", millimeter: "mm", mm: "mm",
  times: "x", x: "x",
};

// Longest key first so e.g. "minutes" is matched whole before the "min" or
// "m" alternatives get a chance — JS regex alternation takes the first
// alternative that matches at the current position, not the longest overall.
const UNIT_KEYS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const NUMBER_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)(?:\\s*(${UNIT_KEYS.map(escapeRe).join("|")})\\b)?`,
  "gi",
);

interface NumMatch {
  value: number;
  unit: string | null;
}

function extractNumbers(normalized: string): NumMatch[] {
  const out: NumMatch[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(normalized)) !== null) {
    const value = Number.parseFloat(m[1]);
    const unit = m[2] ? (UNIT_ALIASES[m[2].toLowerCase()] ?? m[2].toLowerCase()) : null;
    out.push({ value, unit });
    if (m[0].length === 0) NUMBER_RE.lastIndex++; // guard against zero-width matches
  }
  return out;
}

function stripNumbers(normalized: string): string {
  NUMBER_RE.lastIndex = 0;
  return normalized.replace(NUMBER_RE, " ");
}

const NUMERIC_CONTEXT_THRESHOLD = 0.5;

function checkNumeric(candidate: string, existingFact: string): { detail: string } | null {
  const cNorm = normalizeText(candidate);
  const eNorm = normalizeText(existingFact);
  const cNums = extractNumbers(cNorm);
  const eNums = extractNumbers(eNorm);
  if (cNums.length === 0 || eNums.length === 0) return null;

  const cContext = contentWords(stripNumbers(cNorm));
  const eContext = contentWords(stripNumbers(eNorm));
  if (overlapFraction(cContext, eContext) < NUMERIC_CONTEXT_THRESHOLD) return null;

  for (const cn of cNums) {
    for (const en of eNums) {
      const bothHaveUnit = cn.unit !== null && en.unit !== null;
      const sameUnit = cn.unit === en.unit;
      const differentValue = cn.value !== en.value;
      const conflicting = (bothHaveUnit && !sameUnit) || (sameUnit && differentValue) || (!bothHaveUnit && differentValue);
      if (conflicting) {
        const shared = sharedTerms(cContext, eContext);
        return {
          detail: `candidate ${cn.value}${cn.unit ?? ""} vs existing ${en.value}${en.unit ?? ""} in shared context [${shared.join(", ")}]`,
        };
      }
    }
  }
  return null;
}

// ===========================================================================
// Kind: antonym
// ===========================================================================

// >=25 curated pairs, hand-picked for the kind of durable user-preference /
// config facts this store holds. Both directions are registered.
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["enabled", "disabled"],
  ["always", "never"],
  ["prefers", "avoids"],
  ["on", "off"],
  ["dark", "light"],
  ["likes", "dislikes"],
  ["likes", "hates"],
  ["loves", "hates"],
  ["allow", "deny"],
  ["allowed", "denied"],
  ["remote", "office"],
  ["true", "false"],
  ["yes", "no"],
  ["open", "closed"],
  ["active", "inactive"],
  ["public", "private"],
  ["visible", "hidden"],
  ["start", "stop"],
  ["begin", "end"],
  ["increase", "decrease"],
  ["high", "low"],
  ["online", "offline"],
  ["mute", "unmute"],
  ["lock", "unlock"],
  ["accept", "reject"],
  ["approve", "reject"],
  ["agree", "disagree"],
  ["subscribe", "unsubscribe"],
  ["import", "export"],
  ["push", "pull"],
  ["big", "small"],
  ["fast", "slow"],
  ["early", "late"],
  ["hot", "cold"],
  ["win", "lose"],
];

const ANTONYM_LOOKUP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
  };
  for (const [a, b] of ANTONYM_PAIRS) {
    const sa = stem(a);
    const sb = stem(b);
    add(sa, sb);
    add(sb, sa);
  }
  return map;
})();

const ANTONYM_CONTEXT_THRESHOLD = 0.6;

function checkAntonym(candidate: string, existingFact: string): { detail: string } | null {
  const cNorm = normalizeText(candidate);
  const eNorm = normalizeText(existingFact);
  const cStems = wordTokens(cNorm).map(stem);
  const eStems = wordTokens(eNorm).map(stem);
  const eSet = new Set(eStems);

  let pair: [string, string] | null = null;
  for (const cw of cStems) {
    const opposites = ANTONYM_LOOKUP.get(cw);
    if (!opposites) continue;
    for (const ew of eSet) {
      if (opposites.has(ew)) {
        pair = [cw, ew];
        break;
      }
    }
    if (pair) break;
  }
  if (!pair) return null;
  const [wa, wb] = pair;

  const cContext = contentWords(cNorm).filter((w) => w !== wa);
  const eContext = contentWords(eNorm).filter((w) => w !== wb);
  const overlap = overlapFraction(cContext, eContext);
  if (overlap < ANTONYM_CONTEXT_THRESHOLD) return null;

  const shared = sharedTerms(cContext, eContext);
  return { detail: `antonym pair "${wa}"/"${wb}" with shared context [${shared.join(", ")}]` };
}

// ===========================================================================
// Kind: exclusive-value
// ===========================================================================

const VALUE_TRIGGER_WORDS = new Set(["is", "are", "was", "were", "prefers", "prefer", "uses", "use", "runs", "run"]);
const EXCLUSIVE_ATTR_THRESHOLD = 0.6;
const EXCLUSIVE_VALUE_OVERLAP_CEILING = 0.5; // >= this looks additive/superset, not exclusive

function extractAttrValue(normalized: string): { attr: string[]; value: string[] } | null {
  const tokens = wordTokens(normalized);
  const idx = tokens.findIndex((t) => VALUE_TRIGGER_WORDS.has(t));
  if (idx <= 0 || idx >= tokens.length - 1) return null;
  return { attr: tokens.slice(0, idx), value: tokens.slice(idx + 1) };
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function checkExclusiveValue(candidate: string, existingFact: string): { detail: string } | null {
  const cNorm = normalizeText(candidate);
  const eNorm = normalizeText(existingFact);
  // Negated statements are handled by `checkNegation`; skip here to avoid
  // double-classifying "X is not A" as an exclusive-value swap.
  if (hasNegationCue(cNorm) || hasNegationCue(eNorm)) return null;

  const cParsed = extractAttrValue(cNorm);
  const eParsed = extractAttrValue(eNorm);
  if (!cParsed || !eParsed) return null;

  const cAttr = cParsed.attr.filter((t) => !STOPWORDS.has(t)).map(stem);
  const eAttr = eParsed.attr.filter((t) => !STOPWORDS.has(t)).map(stem);
  if (cAttr.length === 0 || eAttr.length === 0) return null;
  if (overlapFraction(cAttr, eAttr) < EXCLUSIVE_ATTR_THRESHOLD) return null;

  const cValue = cParsed.value.filter((t) => !STOPWORDS.has(t)).map(stem);
  const eValue = eParsed.value.filter((t) => !STOPWORDS.has(t)).map(stem);
  if (cValue.length === 0 || eValue.length === 0) return null;

  const cValSet = new Set(cValue);
  const eValSet = new Set(eValue);
  if (setsEqual(cValSet, eValSet)) return null; // identical value -> duplicate, not a conflict

  if (overlapFraction(cValue, eValue) >= EXCLUSIVE_VALUE_OVERLAP_CEILING) return null; // additive/superset

  return {
    detail: `attribute "${cAttr.join(" ")}" candidate value "${cValue.join(" ")}" conflicts with existing value "${eValue.join(" ")}"`,
  };
}

// ===========================================================================
// Public detection + verdict API
// ===========================================================================

/**
 * Deterministic contradiction scan of `candidate` against `existing`. Pure —
 * no clock, no randomness. Only records with `salience >= opts.salienceFloor`
 * (default 0.7) are considered: low-salience facts never veto a new write.
 * Single pass over `existing`; each per-record check is O(len(candidate) +
 * len(record.fact)), so this scales linearly with store size.
 */
export function detectContradictions(
  candidate: string,
  existing: MemoryRecord[],
  opts?: { salienceFloor?: number },
): ContradictionFinding[] {
  if (typeof candidate !== "string" || candidate.trim() === "") return [];
  const floor = opts?.salienceFloor ?? DEFAULT_SALIENCE_FLOOR;
  const findings: ContradictionFinding[] = [];

  for (const rec of existing) {
    if (!rec || typeof rec.fact !== "string") continue;
    if (rec.salience < floor) continue; // below-floor facts never veto
    if (rec.fact.trim() === "") continue;
    if (normalizeText(rec.fact).trim() === normalizeText(candidate).trim()) continue; // exact duplicate, not a contradiction

    const neg = checkNegation(candidate, rec.fact);
    if (neg) findings.push({ existing: rec, kind: "negation", detail: neg.detail, confidence: NEGATION_CONFIDENCE });

    const num = checkNumeric(candidate, rec.fact);
    if (num) findings.push({ existing: rec, kind: "numeric", detail: num.detail, confidence: NUMERIC_CONFIDENCE });

    const ant = checkAntonym(candidate, rec.fact);
    if (ant) findings.push({ existing: rec, kind: "antonym", detail: ant.detail, confidence: ANTONYM_CONFIDENCE });

    const excl = checkExclusiveValue(candidate, rec.fact);
    if (excl) {
      findings.push({ existing: rec, kind: "exclusive-value", detail: excl.detail, confidence: EXCLUSIVE_VALUE_CONFIDENCE });
    }
  }

  return findings;
}

const REASON_ORDER: readonly ContradictionKind[] = ["negation", "numeric", "antonym", "exclusive-value"];

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Verify a candidate memory write against `existing`. `passed` iff no
 * contradictions were found. `reasons` are machine-readable codes
 * (`contradiction.<kind>`), one per distinct kind found, in the fixed
 * `REASON_ORDER` — empty iff `passed`, matching `../tools/verifiers.ts`'s
 * reasons-code convention.
 *
 * Confidence: a clean verdict reports this module's calibrated ceiling (see
 * `memoryWriteCalibration()`) — "no contradiction detected" is evidence of
 * absence only up to that ceiling, never certainty. A contradicted verdict
 * reports the strongest individual finding's own fixed per-kind confidence
 * (already calibrated for that marker; not further damped), since the
 * verdict's job at that point is to communicate how much to trust the
 * STRONGEST reason to quarantine, not to average away a strong signal with
 * co-occurring weaker ones.
 */
export function verifyMemoryWrite(
  candidate: string,
  existing: MemoryRecord[],
  opts?: { salienceFloor?: number },
): MemoryWriteVerdict {
  const contradictions = detectContradictions(candidate, existing, opts);
  const kindsPresent = new Set(contradictions.map((c) => c.kind));
  const reasons = REASON_ORDER.filter((k) => kindsPresent.has(k)).map((k) => `contradiction.${k}`);
  const passed = contradictions.length === 0;

  const confidence = passed
    ? clamp01(memoryWriteCalibration().prior)
    : clamp01(Math.max(...contradictions.map((c) => c.confidence)));

  return {
    verifierId: "verify.memory-write",
    passed,
    confidence,
    reasons,
    contradictions,
  };
}

/**
 * This verifier's honest tier + calibrated prior — see the module docstring
 * and the inline reasoning below for why 0.6 (T4-consistency, mid-pack of
 * the T4 range used across `../tools/verifiers.ts`).
 */
export function memoryWriteCalibration(): { tier: TierId; prior: number } {
  // Deterministic lexical contradiction detection has no oracle and no
  // semantic model behind it — like the T4-consistency stubs in
  // tools/verifiers.ts, it can only attest to a *pattern match* (shared
  // content words plus an explicit negation/numeric/antonym/value-swap
  // marker), not to real-world truth. It is a self-consistency check over the
  // store's own text, nothing more, so T0-T3 (which require an oracle,
  // reference source, rubric grader, or independent model family) would all
  // overclaim.
  //
  // The prior is a deliberately conservative ceiling. This module's own test
  // corpus (guard.test.ts) is ~100% precise/recall by construction — it is
  // the specification the detectors were written against, so it is not
  // evidence about unseen phrasing. Real user facts will use paraphrases,
  // indirection, and domain vocabulary this stemmed bag-of-words approach
  // cannot see (false negatives), and short overlapping facts about unrelated
  // things can occasionally share enough surface form to look related (false
  // positives) even after the context-overlap gates above. 0.6 sits mid-pack
  // of tools/verifiers.ts's T4 range (0.4 for the weakest banned-word scan up
  // to 0.65 for the most decisive structural checks): higher than a pure
  // format check because contradiction detection requires BOTH topical
  // overlap AND an explicit marker, but capped well below anything claiming
  // semantic understanding.
  return { tier: "T4-consistency", prior: 0.6 };
}

// ===========================================================================
// GuardedMemoryStore
// ===========================================================================

/**
 * Wraps any `MemoryStore` so every `add()` passes through the verification
 * gate first. A clean write goes straight to `inner`. A contradicted write is
 * quarantined: it is recorded as a `FlaggedWrite` (never touching `inner`,
 * so it is provably absent from `inner.all()`/`inner.search()`), and the
 * caller gets back a synthetic `MemoryRecord` tagged `"quarantined"` so
 * callers that only look at the return value still see *something* landed —
 * just not durably, and not silently overwriting anything.
 */
export class GuardedMemoryStore implements MemoryStore {
  private readonly inner: MemoryStore;
  private readonly salienceFloor: number;
  private readonly now: () => number;
  private readonly flagsById = new Map<string, FlaggedWrite>();
  private readonly flagOrder: string[] = [];

  constructor(
    inner: MemoryStore,
    opts?: {
      salienceFloor?: number;
      now?: () => number;
      /** Rehydrate previously-raised flags (e.g. from disk) in their original
       *  order — so a quarantine raised in one process can be resolved in a
       *  later one. Entries are shallow-copied; resolution state is kept. */
      restoreFlags?: FlaggedWrite[];
    },
  ) {
    this.inner = inner;
    this.salienceFloor = opts?.salienceFloor ?? DEFAULT_SALIENCE_FLOOR;
    this.now = opts?.now ?? (() => Date.now());
    for (const flag of opts?.restoreFlags ?? []) {
      if (this.flagsById.has(flag.id)) continue; // ids are unique; first wins
      const copy: FlaggedWrite = { ...flag, candidate: { ...flag.candidate, tags: [...flag.candidate.tags] } };
      this.flagsById.set(copy.id, copy);
      this.flagOrder.push(copy.id);
    }
  }

  /**
   * Runs the verification gate and either writes through to `inner` (clean
   * verdict) or quarantines the candidate as a new `FlaggedWrite` (a
   * contradiction was found). Always returns a `record` — real for a clean
   * write, a synthetic `"quarantined"`-tagged one otherwise — so `add()` can
   * satisfy the plain `MemoryStore` contract by delegating here.
   */
  addChecked(input: Parameters<MemoryStore["add"]>[0]): {
    record?: MemoryRecord;
    verdict: MemoryWriteVerdict;
    flagged?: FlaggedWrite;
  } {
    const existing = this.inner.all();
    const verdict = verifyMemoryWrite(input.fact, existing, { salienceFloor: this.salienceFloor });

    if (verdict.passed) {
      const record = this.inner.add(input);
      return { record, verdict };
    }

    const at = this.now();
    const flag: FlaggedWrite = {
      id: randomUUID(),
      candidate: {
        fact: input.fact,
        salience: clamp01(input.salience ?? 0.5),
        tags: input.tags ?? [],
        source: input.source,
      },
      verdict,
      at,
    };
    this.flagsById.set(flag.id, flag);
    this.flagOrder.push(flag.id);

    const record: MemoryRecord = {
      id: flag.id,
      fact: flag.candidate.fact,
      salience: flag.candidate.salience,
      tags: [...flag.candidate.tags, "quarantined"],
      source: flag.candidate.source,
      createdAt: at,
      accessCount: 0,
    };
    return { record, verdict, flagged: flag };
  }

  add(input: Parameters<MemoryStore["add"]>[0]): MemoryRecord {
    const { record } = this.addChecked(input);
    // addChecked always populates `record` (real on a clean write, synthetic
    // quarantined otherwise) — the non-null assertion documents that
    // invariant rather than papering over an unhandled branch.
    return record!;
  }

  /** All flags ever raised (both pending and resolved), oldest first,
   *  stable-id ordered — the audit trail survives resolution. */
  flags(): FlaggedWrite[] {
    return this.flagOrder.map((id) => this.flagsById.get(id)!);
  }

  /**
   * Resolve a pending flag. `"accept-new"` writes the candidate to `inner`
   * as-is. `"supersede"` writes the candidate AND forgets every contradicted
   * existing record from `inner`. `"keep-existing"` discards the candidate —
   * `inner` is untouched. Every resolution marks the flag resolved.
   * Idempotent: resolving an already-resolved or unknown flag id returns
   * `false` and has no side effect.
   */
  resolve(flagId: string, resolution: "accept-new" | "keep-existing" | "supersede"): boolean {
    const flag = this.flagsById.get(flagId);
    if (!flag || flag.resolution) return false;

    if (resolution === "accept-new" || resolution === "supersede") {
      this.inner.add({
        fact: flag.candidate.fact,
        salience: flag.candidate.salience,
        tags: flag.candidate.tags,
        source: flag.candidate.source,
      });
    }
    if (resolution === "supersede") {
      const ids = new Set(flag.verdict.contradictions.map((c) => c.existing.id));
      for (const id of ids) this.inner.forget(id);
    }
    // "keep-existing": candidate discarded, inner untouched.

    flag.resolution = resolution;
    return true;
  }

  // --- MemoryStore delegation -----------------------------------------
  get(id: string): MemoryRecord | undefined {
    return this.inner.get(id);
  }
  all(): MemoryRecord[] {
    return this.inner.all();
  }
  search(query: string, opts?: { limit?: number; tag?: string; now?: number }) {
    return this.inner.search(query, opts);
  }
  forget(id: string): boolean {
    return this.inner.forget(id);
  }
  size(): number {
    return this.inner.size();
  }
}
