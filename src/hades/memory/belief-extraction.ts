/**
 * Belief extraction — the deterministic, no-LLM path from a real recorded
 * `SessionRecord` to structured, taxonomy-keyed `BeliefAssertion`s.
 *
 * This is the "honest extractive mode" analogue of `./summarizer.ts`'s
 * `extractiveSummary`/`extractFacts`: a fixed, calibrated regex/rule engine,
 * never an LLM, and never a fabricated confidence number. Every emitted
 * assertion traces back to a verbatim line the USER actually typed, and its
 * evidence flows through `evidenceFromExtractedFact` (`./belief-evidence.ts`)
 * so it inherits that module's real certificate-verification and tier-cap
 * machinery — no confidence here is ever hand-waved above what the evidence
 * (and, where bound, a genuinely verified `VerificationCertificate`) earns.
 *
 * ---------------------------------------------------------------------------
 * The "never model the user from text the user didn't say" invariant
 * ---------------------------------------------------------------------------
 * Three independent guards enforce this, and the test suite exercises all
 * three directly rather than trusting the docstring:
 *
 *  1. Role gate — the direct line-scan (`extractBeliefAssertions` step 1)
 *     only ever iterates `session.messages` entries with `role === "user"`.
 *     Assistant and system turns are structurally invisible to it.
 *  2. Cross-check — `extractFacts()` (`./summarizer.ts`) *does* see every
 *     role, because it is also used for cross-session recall. When this
 *     module re-parses its `ExtractedFact`s, it keeps a candidate only if
 *     that fact's verbatim excerpt is independently present as a clean user
 *     line (see guard 3) — an assistant- or system-authored fact can never
 *     pass this check, because it never appears in the clean-user-line pool.
 *  3. Injection-fence guard — a line inside a ```-fenced block, a
 *     `<context>`/`<untrusted>` span, or a `> `-quoted line is marked
 *     "excluded" during the line scan and is never handed to the pattern
 *     engine, and never enters the clean-user-line pool guard 2 relies on.
 *     So a user message that *pastes* attacker-controlled text (a scraped
 *     web page, a tool result) inside a fence still cannot inject a belief —
 *     the user themselves would have to say it OUTSIDE the fence.
 *
 * Guards 2 and 3 are deliberately layered on the SAME set (`cleanUserLines`)
 * rather than two independent checks: membership in that set is, by
 * construction, exactly "occurs verbatim in a user turn AND is not inside an
 * injection-fenced/quoted span" — so a single `Set.has()` enforces both
 * requirements at once for the cross-checked (`ExtractedFact`-sourced) path.
 */

import {
  type BeliefAssertion,
  type BeliefEvidence,
  type EvidencePolarity,
  normalizeAttribute,
  normalizeValue,
} from "./user-model";
import { extractFacts, type ExtractedFact } from "./summarizer";
import type { SessionRecord, SessionMessage } from "./session-store";
import { evidenceFromExtractedFact, tierCap } from "./belief-evidence";
import { type VerificationCertificate, sha256Hex } from "../styx/certificate";

// ===========================================================================
// ATTRIBUTE_TAXONOMY — the closed vocabulary extraction may ever emit.
// ===========================================================================

/**
 * Canonical dotted attribute keys. `parseAssertionCandidates` only ever
 * emits keys from this list — an unrecognised phrase maps to NO candidate,
 * never to an invented attribute. Kept as a plain readonly array (not a
 * union type) so it can be iterated/validated at runtime, per the locked
 * export shape.
 */
export const ATTRIBUTE_TAXONOMY: readonly string[] = [
  "identity.name",
  "identity.location",
  "identity.timezone",
  "identity.language",
  "stack.primary",
  "stack.tools",
  "preference.style",
  "preference.workflow",
  "preference.communication",
  "project.current",
  "constraint.explicit",
] as const;

const ATTRIBUTE_SET = new Set(ATTRIBUTE_TAXONOMY);

// ===========================================================================
// ParsedAssertionCandidate + the pattern engine's internal shape
// ===========================================================================

export interface ParsedAssertionCandidate {
  /** Always one of ATTRIBUTE_TAXONOMY. */
  attribute: string;
  value: string;
  polarity: EvidencePolarity;
  patternId: string;
  /** Verbatim line this candidate was parsed from (the input to parseAssertionCandidates). */
  excerpt: string;
  /** Calibrated per-pattern ceiling; always in (0, tierCap("T4-consistency")]. */
  baseConfidence: number;
}

interface PatternMatch {
  attribute: string;
  rawValue: string;
  polarity: EvidencePolarity;
}

interface AssertionPattern {
  id: string;
  baseConfidence: number;
  match: (line: string) => PatternMatch[];
}

// ===========================================================================
// Value cleanup — trailing punctuation/quote strip + runaway-clause guard
// ===========================================================================

// Regex value-captures use `[^.?!\n]+` (stop at sentence terminators only),
// which is deliberately permissive about commas so genuine multi-item values
// ("VS Code, Docker, and tmux") survive intact. The risk that permissiveness
// creates is a captured value bleeding into the NEXT clause of a multi-fact
// sentence ("My name is Alice and I use TypeScript" — the naive capture for
// "my name is X" would swallow "Alice and I use TypeScript"). This regex
// truncates at the first " and/but/so " that is immediately followed by a
// first-person subject ("I", "I'm", "I've", "my") — the tell that a new
// independent clause started — while leaving compound VALUES ("React and
// Redux", "Docker, and tmux") completely untouched, since nothing there is
// followed by a first-person marker.
const CLAUSE_BREAK_RE = /^(.*?)(?:,?\s+(?:and|but|so)\s+(?:i'?m|i've|i|my)\b.*)$/i;
const WRAP_QUOTE_RE = /^["'‘’“”]+|["'‘’“”]+$/g;
const TRAILING_PUNCT_RE = /[\s.,;:!?]+$/;

function cleanupRawValue(raw: string): string {
  let v = raw;
  const cut = v.match(CLAUSE_BREAK_RE);
  if (cut && cut[1] !== undefined) v = cut[1];
  v = v.trim();
  v = v.replace(WRAP_QUOTE_RE, "");
  v = v.trim();
  v = v.replace(TRAILING_PUNCT_RE, "");
  return v.trim();
}

// ===========================================================================
// preference.* classifier — one regex family, three taxonomy destinations
// ===========================================================================

// Keyword sets are deliberately narrow and literal (substring match on the
// lowercased captured clause) rather than a fuzzy classifier: a clause that
// matches none of them yields NO candidate at all rather than a guessed
// bucket, which is the taxonomy's "unknown patterns map to none" rule
// applied one level down (unknown SUB-classification also maps to none).
const PREFERENCE_STYLE_KEYWORDS = [
  "indentation", "tabs", "spaces", "formatting", "naming convention",
  "code style", "semicolons", "quotes", "brace style", "line length",
  "snake_case", "camelcase", "trailing comma",
];
const PREFERENCE_WORKFLOW_KEYWORDS = [
  "workflow", "pull request", "code review", "git flow", "branching",
  "ci/cd", "standup", "sprint", "commit message", "merge", "rebase",
  "review process",
];
const PREFERENCE_COMMUNICATION_KEYWORDS = [
  "concise answer", "detailed explanation", "verbosity", "tone of voice",
  "step-by-step", "bullet point", "short answer", "long explanation",
  "plain language", "technical jargon", "explanations",
];

function classifyPreference(clause: string): string | undefined {
  const lower = clause.toLowerCase();
  if (PREFERENCE_STYLE_KEYWORDS.some((k) => lower.includes(k))) return "preference.style";
  if (PREFERENCE_WORKFLOW_KEYWORDS.some((k) => lower.includes(k))) return "preference.workflow";
  if (PREFERENCE_COMMUNICATION_KEYWORDS.some((k) => lower.includes(k))) return "preference.communication";
  return undefined;
}

// ===========================================================================
// Pattern constructors
// ===========================================================================

function regexPattern(
  id: string,
  attribute: string,
  regex: RegExp,
  polarity: EvidencePolarity,
  baseConfidence: number,
): AssertionPattern {
  return {
    id,
    baseConfidence,
    match(line: string): PatternMatch[] {
      const m = line.match(regex);
      if (!m || typeof m[1] !== "string") return [];
      return [{ attribute, rawValue: m[1], polarity }];
    },
  };
}

function preferenceClassifierPattern(
  id: string,
  regex: RegExp,
  polarity: EvidencePolarity,
  baseConfidence: number,
): AssertionPattern {
  return {
    id,
    baseConfidence,
    match(line: string): PatternMatch[] {
      const m = line.match(regex);
      if (!m || typeof m[1] !== "string") return [];
      const attribute = classifyPreference(m[1]);
      if (!attribute) return [];
      return [{ attribute, rawValue: m[1], polarity }];
    },
  };
}

/**
 * "I moved/switched from X to Y" — a single utterance that is really TWO
 * pieces of evidence for the SAME attribute: a retraction of the old value
 * and support for the new one. Both are emitted from one pattern firing so a
 * caller never sees a bare retraction with no replacement, or vice versa.
 */
function transitionPattern(
  id: string,
  attribute: string,
  regex: RegExp,
  baseConfidence: number,
): AssertionPattern {
  return {
    id,
    baseConfidence,
    match(line: string): PatternMatch[] {
      const m = line.match(regex);
      if (!m || typeof m[1] !== "string" || typeof m[2] !== "string") return [];
      return [
        { attribute, rawValue: m[1], polarity: "retracts" },
        { attribute, rawValue: m[2], polarity: "supports" },
      ];
    },
  };
}

// ===========================================================================
// The pattern table
// ===========================================================================
//
// Every baseConfidence below is a calibrated CEILING for that class of
// phrase, in the same spirit as `../tools/verifiers.ts`'s per-checklist
// prior: a direct first-person declarative statement ("my name is X") earns
// more than a broader/looser trigger ("I use X", which fires on almost any
// noun phrase) or an inferential one ("I'm from X", which may describe
// origin rather than current residence). All values are held well under
// `tierCap("T4-consistency")` (module-load-asserted below) because this is
// consistency-only, self-reported extraction with no independent oracle.

const ALL_PATTERNS: AssertionPattern[] = [
  // -- identity.name ---------------------------------------------------
  // Direct, unambiguous self-declaration — the strongest phrase class here.
  regexPattern("identity.name.my-name-is", "identity.name", /\bmy name is\s+([^.?!\n]+)/i, "supports", 0.52),
  // An explicit instruction, not just description — equally direct.
  regexPattern("identity.name.call-me", "identity.name", /\bcall me\s+([^.?!\n]+)/i, "supports", 0.5),
  regexPattern("identity.name.im-called", "identity.name", /\bI'?m called\s+([^.?!\n]+)/i, "supports", 0.48),
  // Negation: the captured name is the one being disowned, hence "retracts".
  regexPattern("identity.name.stop-calling-me", "identity.name", /\bstop calling me\s+([^.?!\n]+)/i, "retracts", 0.46),

  // -- identity.location ------------------------------------------------
  regexPattern("identity.location.based-in", "identity.location", /\bI'?m based (?:in|out of)\s+([^.?!\n]+)/i, "supports", 0.5),
  regexPattern("identity.location.live-in", "identity.location", /\bI live in\s+([^.?!\n]+)/i, "supports", 0.5),
  // Lower ceiling: "I'm from X" often names origin/nationality, not current base.
  regexPattern("identity.location.im-from", "identity.location", /\bI'?m from\s+([^.?!\n]+)/i, "supports", 0.42),
  transitionPattern("identity.location.moved-from-to", "identity.location", /\bI moved from\s+([^.?!\n]+?)\s+to\s+([^.?!\n]+)/i, 0.48),

  // -- identity.timezone --------------------------------------------------
  regexPattern("identity.timezone.my-tz-is", "identity.timezone", /\bmy timezone is\s+([^.?!\n]+)/i, "supports", 0.52),
  regexPattern("identity.timezone.im-in-tz", "identity.timezone", /\bI'?m in(?: the)?\s+([^.?!\n]+?)\s+timezone\b/i, "supports", 0.46),

  // -- identity.language (spoken/written language, not a stack choice) ----
  regexPattern("identity.language.i-speak", "identity.language", /\bI speak\s+([^.?!\n]+)/i, "supports", 0.44),
  regexPattern("identity.language.my-language-is", "identity.language", /\bmy (?:native |first )?language is\s+([^.?!\n]+)/i, "supports", 0.48),

  // -- stack.primary --------------------------------------------------------
  // Broadest trigger of the whole table ("I use X" fires on nearly any noun
  // phrase) — lowest ceiling in the file for exactly that reason.
  regexPattern("stack.primary.i-use", "stack.primary", /\bI\s+(?:use|work with)\s+([^.?!\n]+)/i, "supports", 0.4),
  regexPattern("stack.primary.i-code-in", "stack.primary", /\bI\s+(?:code|program|develop)\s+in\s+([^.?!\n]+)/i, "supports", 0.48),
  regexPattern("stack.primary.no-longer-use", "stack.primary", /\bI no longer use\s+([^.?!\n]+)/i, "retracts", 0.46),
  regexPattern("stack.primary.dont-use-anymore", "stack.primary", /\bI don'?t use\s+([^.?!\n]+?)\s+anymore\b/i, "retracts", 0.46),
  transitionPattern("stack.primary.switched-from-to", "stack.primary", /\bI switched from\s+([^.?!\n]+?)\s+to\s+([^.?!\n]+)/i, 0.46),

  // -- stack.tools ------------------------------------------------------
  regexPattern("stack.tools.my-tools-are", "stack.tools", /\bmy tools?\s+(?:are|is)\s+([^.?!\n]+)/i, "supports", 0.48),
  regexPattern("stack.tools.i-use-as-editor", "stack.tools", /\bI use\s+([^.?!\n]+?)\s+as my (?:editor|ide)\b/i, "supports", 0.5),

  // -- preference.style / preference.workflow / preference.communication --
  // Same trigger family as the summarizer's own "preference" FactPattern
  // ("I prefer/like/love/hate/dislike/enjoy X"), sub-classified below by
  // keyword. A clause that doesn't classify emits nothing (see
  // classifyPreference) rather than an invented sub-bucket.
  preferenceClassifierPattern(
    "preference.prefer-like",
    /\bI\s+(?:really\s+|absolutely\s+)?(?:prefer|like|love|hate|dislike|enjoy)\s+([^.?!\n]+)/i,
    "supports",
    0.42,
  ),
  preferenceClassifierPattern("preference.always", /\bI always\s+([^.?!\n]+)/i, "supports", 0.4),
  preferenceClassifierPattern("preference.never", /\bI never\s+([^.?!\n]+)/i, "supports", 0.4),

  // -- project.current ------------------------------------------------------
  regexPattern("project.current.working-on", "project.current", /\bI'?m (?:currently )?working on\s+([^.?!\n]+)/i, "supports", 0.5),
  regexPattern("project.current.my-project-is", "project.current", /\bmy (?:current )?project is\s+([^.?!\n]+)/i, "supports", 0.5),

  // -- constraint.explicit ----------------------------------------------
  regexPattern("constraint.explicit.remember-that", "constraint.explicit", /\bremember that\s+([^.?!\n]+)/i, "supports", 0.45),
  // Imperative, subjectless framing ("Always X." / "Never X.") — a directive
  // to the agent, distinct from a first-person preference statement
  // ("I always/never X", handled by the preference.* patterns above).
  regexPattern("constraint.explicit.imperative-always", "constraint.explicit", /^\s*always\s+([^.?!\n]+)/i, "supports", 0.4),
  regexPattern("constraint.explicit.imperative-never", "constraint.explicit", /^\s*never\s+([^.?!\n]+)/i, "supports", 0.4),
];

// ===========================================================================
// Module-load calibration guard — REAL-VS-MOCK invariant, enforced not just
// documented: every pattern's baseConfidence must sit in (0, tierCap(T4)].
// ===========================================================================

const T4_CONSISTENCY_CAP = tierCap("T4-consistency");

for (const pattern of ALL_PATTERNS) {
  if (!(pattern.baseConfidence > 0 && pattern.baseConfidence <= T4_CONSISTENCY_CAP)) {
    throw new Error(
      `belief-extraction: pattern "${pattern.id}" has baseConfidence ${pattern.baseConfidence}, ` +
        `outside the required (0, tierCap("T4-consistency")=${T4_CONSISTENCY_CAP}] range`,
    );
  }
}

// ===========================================================================
// parseAssertionCandidates — pure, deterministic, single-line rule engine
// ===========================================================================

const MAX_LINE_CHARS = 2000;

/**
 * PURE. Runs every registered pattern against ONE line and returns every
 * match as a `ParsedAssertionCandidate`, sorted best-confidence-first (ties
 * broken by pattern registration order, which array iteration already
 * preserves — `Array.prototype.sort` is stable). Never throws: a malformed
 * input or a misbehaving individual pattern degrades to "that pattern
 * contributed nothing" rather than aborting the whole line.
 */
export function parseAssertionCandidates(line: string): ParsedAssertionCandidate[] {
  if (typeof line !== "string") return [];
  if (line.length === 0 || line.length > MAX_LINE_CHARS) return [];
  if (line.trim().length === 0) return [];

  const out: ParsedAssertionCandidate[] = [];
  for (const pattern of ALL_PATTERNS) {
    let matches: PatternMatch[];
    try {
      matches = pattern.match(line);
    } catch {
      continue;
    }
    for (const m of matches) {
      if (!ATTRIBUTE_SET.has(m.attribute)) continue;
      const value = normalizeValue(cleanupRawValue(m.rawValue));
      if (!value) continue;
      out.push({
        attribute: m.attribute,
        value,
        polarity: m.polarity,
        patternId: pattern.id,
        excerpt: line,
        baseConfidence: pattern.baseConfidence,
      });
    }
  }
  return out.sort((a, b) => b.baseConfidence - a.baseConfidence);
}

/**
 * PURE helper exposing the taxonomy mapping for callers (CLI / central
 * integration) that just need "what attribute (if any) does this text look
 * like it's about" without the full candidate shape. Returns the
 * highest-confidence match's attribute, or undefined if nothing matches.
 */
export function attributeOf(candidateText: string): string | undefined {
  if (typeof candidateText !== "string") return undefined;
  const candidates = parseAssertionCandidates(candidateText);
  return candidates[0]?.attribute;
}

// ===========================================================================
// Injection-fence / quoted-context line scanner
// ===========================================================================

interface ScannedLine {
  text: string;
  excluded: boolean;
}

const FENCE_MARKER_RE = /^```/;
const CONTEXT_OPEN_RE = /<(context|untrusted)\b[^>]*>/i;
const CONTEXT_CLOSE_RE = /<\/(context|untrusted)>/i;

/**
 * Splits one message's content into lines and marks which ones are safe to
 * treat as first-person user statements. A line is EXCLUDED when it is:
 *   - inside a ``` ... ``` fence (the delimiter lines themselves too),
 *   - inside (or itself touches the boundary of) a <context>/<untrusted>
 *     span — including a self-closing single-line span,
 *   - a ">"-prefixed quote line.
 * State (fence/context depth) is scoped to a single message's content only —
 * a span is not assumed to survive across a message boundary.
 */
function scanMessageLines(content: string): ScannedLine[] {
  const rawLines = content.split(/\r\n|\r|\n/);
  const out: ScannedLine[] = [];
  let inFence = false;
  let contextDepth = 0;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    let excluded = inFence || contextDepth > 0 || trimmed.startsWith(">");

    if (FENCE_MARKER_RE.test(trimmed)) {
      inFence = !inFence;
      excluded = true;
    }

    const hasOpen = CONTEXT_OPEN_RE.test(trimmed);
    const hasClose = CONTEXT_CLOSE_RE.test(trimmed);
    if (hasOpen || hasClose) {
      excluded = true;
      if (hasOpen && !hasClose) contextDepth++;
      else if (hasClose && !hasOpen) contextDepth = Math.max(0, contextDepth - 1);
    }

    out.push({ text: raw, excluded });
  }
  return out;
}

// ===========================================================================
// extractBeliefAssertions — the real pipeline
// ===========================================================================

export interface ExtractionOptions {
  /** Keyed by sha256Hex of the evidence excerpt — pass-through to evidenceFromExtractedFact. */
  certificates?: Map<string, VerificationCertificate>;
  now?: () => number;
  /** Default 32, best-confidence-first truncation. */
  maxAssertionsPerSession?: number;
}

const DEFAULT_MAX_ASSERTIONS_PER_SESSION = 32;

function dedupeKey(attribute: string, value: string, polarity: EvidencePolarity): string {
  return `${normalizeAttribute(attribute)}\u0000${normalizeValue(value)}\u0000${polarity}`;
}

/**
 * The real, no-LLM belief-extraction pipeline. See the module docstring for
 * the three-guard "never model the user from text they didn't say" argument;
 * this function is where all three are wired together.
 */
export async function extractBeliefAssertions(
  session: SessionRecord,
  opts: ExtractionOptions = {},
): Promise<BeliefAssertion[]> {
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) return [];

  const nowFn = typeof opts.now === "function" ? opts.now : Date.now;
  const maxAssertions =
    opts.maxAssertionsPerSession !== undefined &&
    Number.isFinite(opts.maxAssertionsPerSession) &&
    opts.maxAssertionsPerSession >= 0
      ? Math.floor(opts.maxAssertionsPerSession)
      : DEFAULT_MAX_ASSERTIONS_PER_SESSION;

  // ---- Step 1: direct scan of USER-role lines only, honest about fences. --
  const cleanUserLines = new Set<string>();
  const rawCandidates: ParsedAssertionCandidate[] = [];

  const messages: SessionMessage[] = session.messages;
  for (const msg of messages) {
    if (!msg || msg.role !== "user" || typeof msg.content !== "string") continue;
    for (const { text, excluded } of scanMessageLines(msg.content)) {
      if (excluded) continue;
      const trimmed = text.trim();
      if (!trimmed) continue;
      cleanUserLines.add(trimmed);
      for (const cand of parseAssertionCandidates(trimmed)) rawCandidates.push(cand);
    }
  }

  // ---- Step 2 + 3: cross-check against the summarizer's own (all-role) ---
  // fact extraction, re-parsed through the SAME taxonomy engine, kept only
  // when the excerpt is itself a member of cleanUserLines (see docstring:
  // that single membership test enforces both "occurs in a user turn" and
  // "not inside an injection fence/quote" at once).
  let facts: ExtractedFact[];
  try {
    facts = extractFacts(session);
  } catch {
    facts = [];
  }
  for (const fact of facts) {
    for (const field of [fact.evidence, fact.fact]) {
      if (typeof field !== "string") continue;
      const trimmed = field.trim();
      if (!trimmed || !cleanUserLines.has(trimmed)) continue;
      for (const cand of parseAssertionCandidates(trimmed)) rawCandidates.push(cand);
    }
  }

  if (rawCandidates.length === 0) return [];

  // ---- Dedupe by (attribute, normalized value, polarity), highest confidence wins. --
  const bestByKey = new Map<string, ParsedAssertionCandidate>();
  for (const cand of rawCandidates) {
    const key = dedupeKey(cand.attribute, cand.value, cand.polarity);
    const existing = bestByKey.get(key);
    if (!existing || cand.baseConfidence > existing.baseConfidence) {
      bestByKey.set(key, cand);
    }
  }

  // ---- Best-confidence-first, deterministic cap. --------------------------
  const ordered = [...bestByKey.values()].sort((a, b) => {
    if (b.baseConfidence !== a.baseConfidence) return b.baseConfidence - a.baseConfidence;
    if (a.attribute !== b.attribute) return a.attribute < b.attribute ? -1 : 1;
    if (a.value !== b.value) return a.value < b.value ? -1 : 1;
    return a.polarity < b.polarity ? -1 : a.polarity > b.polarity ? 1 : 0;
  });
  const capped = ordered.slice(0, maxAssertions);

  // ---- Build real BeliefEvidence (certificate-aware) for each survivor. --
  const assertions: BeliefAssertion[] = [];
  for (const cand of capped) {
    const certKey = sha256Hex(cand.excerpt);
    const certificate = opts.certificates?.get(certKey);
    const evidence: BeliefEvidence = await evidenceFromExtractedFact(
      { fact: cand.value, salience: cand.baseConfidence, evidence: cand.excerpt },
      { sessionId: session.id, certificate, polarity: cand.polarity, now: nowFn },
    );
    assertions.push({
      attribute: cand.attribute,
      value: cand.value,
      polarity: cand.polarity,
      evidence,
      now: evidence.at,
    });
  }
  return assertions;
}
