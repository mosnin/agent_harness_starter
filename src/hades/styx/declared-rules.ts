/**
 * Declared-rule references — the second, wider substrate for T1-reference
 * verification.
 *
 * ## The gap this closes
 *
 * `./reference-spec.ts` can only verify a task whose prompt carries a
 * `SPEC:{json}` line naming the operands INLINE (`{"family":"transform",
 * "text":"Hello World","op":"rot13"}`). That works for a generator that mints
 * its own tasks, and for nothing else. The real evaluation corpus
 * (`../bench/eval-suite.ts`) is written in prose: the operands live inside
 * the request text, not in a JSON blob appended to it. Every one of its tasks
 * therefore carried no spec, the T1 verifier abstained on all of them, and
 * `hades trust calibrate --from-eval` correctly reported "NO discrimination —
 * THRESHOLD IS +INFINITY". A gate that abstains on 100% of the corpus
 * certifies nothing.
 *
 * A **declared rule** closes that gap without inlining the operands. It names
 * a deterministic transform — `extract-emails`, `per-item-length` — that is
 * applied TO THE REQUEST TEXT ITSELF. The request already contains everything
 * needed: `"Extract all email addresses from: Contact alice@example.com or
 * bob@test.org for details."` plus the declaration `extract-emails` is a
 * complete, machine-checkable statement of what the correct answer is. The
 * declaration says HOW the answer is computed; it never says WHAT the answer
 * is.
 *
 * ## The boundary that makes this honest (read before extending)
 *
 * A verifier is only worth anything if it can be WRONG about a right answer
 * and RIGHT about a wrong one, independently of whoever produced either. So:
 *
 *   - Everything in this module is a pure function of TEXT. No function here
 *     takes an `EvalTask`, a grader, an expected value, or anything derived
 *     from one. It imports nothing from `../bench/**` — the dependency runs
 *     the other way (the corpus imports these regexes so there is exactly ONE
 *     definition of "what an email address looks like" and it cannot drift).
 *   - The rule vocabulary is CLOSED ({@link DECLARED_RULE_IDS}) and each entry
 *     has ONE implementation. A rule is a general transform over a list or a
 *     body of text, not a per-prompt pattern that only ever fires once — a
 *     vocabulary of single-use patterns would be an answer key wearing a
 *     costume.
 *   - The declaration travels in the REQUEST, on a `REF:` line, exactly like
 *     `SPEC:`. That is deliberate: the request is authored by whoever ASKS,
 *     while `evidence` and `trace` are authored by whoever ANSWERS. A verifier
 *     that let the answerer declare its own success criterion would certify
 *     nothing at all, so the rule must never be carried by anything the
 *     answerer controls.
 *
 * ## Recomputation must be able to say "I don't decide this"
 *
 * Every rule returns `undefined` when it cannot produce a reference from the
 * request (no items parsed, an empty token set, a numeric op over words). The
 * caller then ABSTAINS. This matters: an empty recomputed reference that was
 * compared literally would "match" an empty answer and certify a refusal as
 * correct. Failing closed is the only safe direction for a verifier.
 *
 * @module hades/styx/declared-rules
 */

// ---------------------------------------------------------------------------
// Shared token patterns — THE single definition
// ---------------------------------------------------------------------------

/**
 * These four patterns are the ONE definition of each token class in this repo.
 * `../bench/eval-suite.ts` imports them for its graders and the T1 verifier
 * recomputes through them, so a grader and a verifier can never disagree about
 * what counts as an email address because someone edited one copy. That is not
 * a shortcut: it is the only way "the verifier reproduces the answer" is a
 * statement about correctness rather than about two regexes happening to
 * agree today.
 *
 * All four are `g`-flagged and used exclusively via `String.prototype.match`,
 * which resets `lastIndex` on entry and exit — so sharing one instance across
 * callers is safe.
 */
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const HASHTAG_RE = /#[A-Za-z0-9_]+/g;
export const URL_RE = /https?:\/\/[^\s,]+/g;
/** Unsigned integer runs. Deliberately NOT `-?\d+`: the corpus asks for
 *  "unique integers ascending" over counts, never signed values. */
export const INTEGER_RE = /\d+/g;

/**
 * `key:value` pairs in free text — the answer format of every `multi-*` task
 * ("Return as `word:length`, comma-separated"). Shared with the corpus grader
 * for the same anti-drift reason as the patterns above.
 */
export const LABELED_PAIR_RE = /([A-Za-z0-9]+)\s*:\s*([A-Za-z0-9]+)/g;

// ---------------------------------------------------------------------------
// Normalization — the equivalence relations the rules compare under
// ---------------------------------------------------------------------------

/**
 * Canonicalize a bag of extracted tokens: optionally lowercase, deduplicate,
 * sort lexicographically, join with commas.
 *
 * Order and duplication are not part of a set-valued answer, so they must not
 * be part of the comparison. Applying this to BOTH the recomputed reference
 * and the candidate answer is what lets the verifier accept
 * `"alice@example.com, bob@test.org"` (a real, correct, prose-spaced answer)
 * while rejecting `"alice@example.com"` — a strict string compare against one
 * canonical rendering would fail the first, which is a false alarm, and a
 * false alarm is just as much a verification failure as a false pass.
 */
export function normalizeTokenSet(tokens: readonly string[], lowercase: boolean): string {
  const mapped = lowercase ? tokens.map((t) => t.toLowerCase()) : tokens.slice();
  return Array.from(new Set(mapped)).sort().join(",");
}

/** Canonicalize the unsigned integers in `text`: unique, numerically ascending. */
export function normalizeIntegerSetAscending(text: string): string {
  const found = (text.match(INTEGER_RE) ?? []).map(Number);
  return Array.from(new Set(found))
    .sort((a, b) => a - b)
    .join(",");
}

/**
 * Parse `key:value` pairs out of free text, lowercased. The LAST value for a
 * key wins, which is what makes the pair comparison ungameable by flooding: an
 * answer that hedges (`apple:5,apple:6`) collapses to its last claim instead of
 * matching whichever value the checker was hoping for.
 */
export function parseLabeledPairs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  LABELED_PAIR_RE.lastIndex = 0;
  while ((m = LABELED_PAIR_RE.exec(text)) !== null) {
    map.set(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return map;
}

// ---------------------------------------------------------------------------
// The closed rule vocabulary
// ---------------------------------------------------------------------------

/**
 * Every declared rule this build understands. Closed on purpose: an unknown
 * rule id makes {@link extractDeclaredReference} return `undefined`, so a
 * request carrying a rule from a newer build makes the verifier abstain rather
 * than guess.
 */
export const DECLARED_RULE_IDS = [
  // Token extraction over the whole request body.
  "extract-emails",
  "extract-hashtags",
  "extract-urls",
  "extract-integers-ascending",
  // Per-item transforms over the item list the request enumerates.
  "per-item-length",
  "per-item-first-letter",
  "per-item-vowel-count",
  "per-item-double",
  "per-item-half",
  "per-item-square",
  "per-item-plus-ten",
  "per-item-parity",
  "per-item-is-prime",
  "per-item-celsius-to-fahrenheit",
] as const;

export type DeclaredRuleId = (typeof DECLARED_RULE_IDS)[number];

/** A declaration attached to a request: which rule decides its answer. */
export interface DeclaredReference {
  rule: DeclaredRuleId;
}

/**
 * One rule's implementation. Both halves take the REQUEST as their first
 * argument and nothing else — there is no seam through which an expected
 * value could be passed in, by construction.
 */
interface DeclaredRuleImpl {
  /** Human-readable statement of the transform, for verdict reasons. */
  describe: string;
  /** Recompute the canonical answer from the request; `undefined` = does not decide. */
  compute(request: string): string | undefined;
  /** Does `output` answer `request` under this rule? */
  accepts(request: string, output: string): boolean;
}

// ---------------------------------------------------------------------------
// Token-extraction rules
// ---------------------------------------------------------------------------

/**
 * Build a set-valued rule from ONE canonicalizer, used on both sides: the
 * reference is `canonical(request)` and the candidate is `canonical(output)`.
 *
 * Running the same function over the answer is what makes the comparison an
 * equivalence rather than a string identity check — `"alice@x.com, bob@y.org"`
 * and `"bob@y.org,alice@x.com"` are the same set-valued answer, and a verifier
 * that failed one of them would be a false-alarm machine on real model output.
 * It is safe because every canonicalizer here is idempotent: canonical output
 * fed back through it is unchanged.
 */
function canonicalSetRule(describe: string, canonical: (text: string) => string): DeclaredRuleImpl {
  // An empty reference decides nothing — see the module note on failing closed.
  const compute = (request: string): string | undefined => {
    const expected = canonical(request);
    return expected.length > 0 ? expected : undefined;
  };
  return {
    describe,
    compute,
    accepts(request, output) {
      const expected = compute(request);
      return expected !== undefined && canonical(output) === expected;
    },
  };
}

/**
 * Build a rule that extracts one token class from the request body.
 *
 * The pattern is applied to the ENTIRE request, instruction text included,
 * rather than to a heuristically-sliced "source span". Two reasons: a
 * span-slicing heuristic is a silent guess (a prompt shaped slightly
 * differently yields a silently different reference), whereas whole-body
 * scanning has no hidden state; and the corpus-wide consistency test proves,
 * per annotated task, that the instruction text contributes no tokens of the
 * extracted class. If a future prompt broke that, the test fails loudly
 * instead of the verifier drifting quietly.
 */
function tokenSetRule(describe: string, pattern: RegExp, lowercase: boolean): DeclaredRuleImpl {
  return canonicalSetRule(describe, (text) => normalizeTokenSet(text.match(pattern) ?? [], lowercase));
}

/** Integers need a numeric sort, so they get their own canonicalizer. */
function integerSetRule(): DeclaredRuleImpl {
  return canonicalSetRule(
    "the unique integers in the request, ascending, comma-separated",
    normalizeIntegerSetAscending,
  );
}

// ---------------------------------------------------------------------------
// Per-item rules
// ---------------------------------------------------------------------------

/**
 * The item list a `multi-*` request enumerates: the comma-separated run
 * between the request's first `:` or `?` and the `.` that closes it.
 *
 * Prompts in this family are shaped `"<instruction><:|?> a, b, c. Return as
 * ...`" — the parse takes the FIRST such delimiter so a later `word:length`
 * format hint cannot be mistaken for the list, and stops at the first `.`
 * followed by `Return`, so anything appended after the instruction (including
 * the `REF:` line itself) is outside the span.
 *
 * This is a conservative parse, not a general one, and it announces failure:
 * no match, or an empty list, yields `undefined` and the verifier abstains. A
 * mis-parse can therefore only cost a false alarm on a correct answer, never a
 * false certification of a wrong one. Every task annotated with a per-item
 * rule is proved against its own grader by the corpus consistency test, which
 * is what pins this parse to reality.
 */
export function declaredItemList(request: string): string[] | undefined {
  const m = /[:?]\s*([\s\S]*?)\s*\.\s*Return\b/i.exec(request);
  if (!m) return undefined;
  const items = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Vowel count, matching the corpus's stated alphabet (a, e, i, o, u). */
function countVowels(s: string): number {
  return (s.match(/[aeiouAEIOU]/g) ?? []).length;
}

function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

/**
 * Build a rule that maps each enumerated item to a value.
 *
 * `op` returns `undefined` when the item is outside its domain (a numeric op
 * over the word "apple"), which makes the whole reference `undefined` rather
 * than emitting `apple:NaN` and then confidently failing every answer.
 *
 * Comparison is per declared key, against a pair map parsed from the answer:
 * the answer must bind every item the request enumerated to the recomputed
 * value. Keys are compared lowercased because the echoed key is the question,
 * not the answer, and its case carries no information. Unrelated extra pairs
 * are ignored — they cannot help, because {@link parseLabeledPairs} keeps only
 * the last value per key, so an answer cannot pass by enumerating alternatives.
 */
function perItemRule(describe: string, op: (item: string) => string | undefined): DeclaredRuleImpl {
  const reference = (request: string): Map<string, string> | undefined => {
    const items = declaredItemList(request);
    if (!items) return undefined;
    const out = new Map<string, string>();
    for (const item of items) {
      const value = op(item);
      if (value === undefined) return undefined;
      out.set(item.toLowerCase(), value.toLowerCase());
    }
    return out.size > 0 ? out : undefined;
  };
  return {
    describe,
    compute(request) {
      const ref = reference(request);
      if (!ref) return undefined;
      return Array.from(ref, ([k, v]) => `${k}:${v}`).join(",");
    },
    accepts(request, output) {
      const ref = reference(request);
      if (!ref) return false;
      const got = parseLabeledPairs(output);
      for (const [k, v] of ref) if (got.get(k) !== v) return false;
      return true;
    },
  };
}

/** Numeric per-item op: `undefined` for anything that is not a finite number. */
function numericOp(f: (n: number) => number): (item: string) => string | undefined {
  return (item) => {
    const n = Number(item);
    return Number.isFinite(n) && item.trim() !== "" ? String(f(n)) : undefined;
  };
}

// ---------------------------------------------------------------------------
// The table — exactly one implementation per rule id
// ---------------------------------------------------------------------------

/**
 * `Record<DeclaredRuleId, …>` rather than a lookup with a default, so adding
 * an id to {@link DECLARED_RULE_IDS} without implementing it is a compile
 * error instead of a silent abstention.
 */
const RULES: Record<DeclaredRuleId, DeclaredRuleImpl> = {
  "extract-emails": tokenSetRule(
    "the email addresses in the request, lowercased, unique, sorted, comma-separated",
    EMAIL_RE,
    true,
  ),
  "extract-hashtags": tokenSetRule(
    "the hashtags in the request, lowercased, unique, sorted, comma-separated",
    HASHTAG_RE,
    true,
  ),
  "extract-urls": tokenSetRule(
    "the URLs in the request, unique, sorted, comma-separated (case preserved)",
    URL_RE,
    false,
  ),
  "extract-integers-ascending": integerSetRule(),
  "per-item-length": perItemRule("each listed item paired with its character count", (item) =>
    String(item.length),
  ),
  "per-item-first-letter": perItemRule("each listed item paired with its first letter", (item) =>
    item.charAt(0),
  ),
  "per-item-vowel-count": perItemRule("each listed item paired with its vowel count", (item) =>
    String(countVowels(item)),
  ),
  "per-item-double": perItemRule("each listed number paired with twice itself", numericOp((n) => n * 2)),
  "per-item-half": perItemRule("each listed number paired with half itself", numericOp((n) => n / 2)),
  "per-item-square": perItemRule("each listed number paired with its square", numericOp((n) => n * n)),
  "per-item-plus-ten": perItemRule("each listed number paired with itself plus ten", numericOp((n) => n + 10)),
  "per-item-parity": perItemRule("each listed number paired with even/odd", (item) => {
    const n = Number(item);
    if (!Number.isInteger(n)) return undefined;
    return n % 2 === 0 ? "even" : "odd";
  }),
  "per-item-is-prime": perItemRule("each listed number paired with yes/no for primality", (item) => {
    const n = Number(item);
    if (!Number.isInteger(n)) return undefined;
    return isPrime(n) ? "yes" : "no";
  }),
  "per-item-celsius-to-fahrenheit": perItemRule(
    "each listed Celsius temperature paired with its Fahrenheit value",
    numericOp((n) => (n * 9) / 5 + 32),
  ),
};

/** Is `value` one of the ids this build implements? */
export function isDeclaredRuleId(value: unknown): value is DeclaredRuleId {
  return typeof value === "string" && (DECLARED_RULE_IDS as readonly string[]).includes(value);
}

/** Human-readable statement of what a rule computes (used in verdict reasons). */
export function describeDeclaredRule(ref: DeclaredReference): string {
  return RULES[ref.rule].describe;
}

/**
 * Recompute the reference answer for `request` under `ref`, or `undefined`
 * when the rule does not decide this request. The ONLY input is the request
 * text.
 */
export function computeDeclaredReference(ref: DeclaredReference, request: string): string | undefined {
  return RULES[ref.rule].compute(request);
}

/**
 * Does `output` answer `request` under `ref`? Compared under the rule's own
 * equivalence relation (see {@link normalizeTokenSet} / {@link perItemRule}),
 * never by string identity against one arbitrary rendering.
 */
export function matchesDeclaredReference(ref: DeclaredReference, request: string, output: string): boolean {
  if (typeof output !== "string") return false;
  return RULES[ref.rule].accepts(request, output);
}

// ---------------------------------------------------------------------------
// Carrying a declaration in a request
// ---------------------------------------------------------------------------

/** The line prefix that carries a declared rule inside a request. */
export const REF_PREFIX = "REF:";

/** Render a declaration as the line a request carries. */
export function formatDeclaredReference(ref: DeclaredReference): string {
  return `${REF_PREFIX}${JSON.stringify({ rule: ref.rule })}`;
}

/**
 * Extract the declared rule a request carries, or `undefined` for a request
 * that carries none, carries something malformed, or names a rule this build
 * does not implement. Never throws: a verifier that cannot find a declaration
 * must abstain, and abstaining is only safe if extraction cannot blow up on
 * adversarial text.
 *
 * The LAST well-formed `REF:` line wins, mirroring `SPEC:` — text quoted
 * inside a request (including an attacker echoing a rule that would be easier
 * to satisfy) cannot displace the declaration the asker appended.
 */
export function extractDeclaredReference(request: string): DeclaredReference | undefined {
  if (typeof request !== "string" || !request.includes(REF_PREFIX)) return undefined;
  let found: DeclaredReference | undefined;
  for (const line of request.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REF_PREFIX)) continue;
    const json = trimmed.slice(REF_PREFIX.length).trim();
    if (!json) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object" && isDeclaredRuleId((parsed as { rule?: unknown }).rule)) {
        found = { rule: (parsed as { rule: DeclaredRuleId }).rule };
      }
    } catch {
      // Malformed JSON on a REF: line is not an error — it just is not a
      // usable declaration. Keep scanning; abstention is the safe outcome.
    }
  }
  return found;
}
