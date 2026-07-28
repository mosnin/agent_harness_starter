/**
 * eval-suite.ts — LLM-shaped, programmatically-gradable tasks for the V-TPH$
 * harness.
 *
 * Each task is something a language model must actually *do* (extraction,
 * classification, transformation, structured reasoning, multi-step arithmetic),
 * yet every task ships a PURE, DETERMINISTIC grader so correctness is measured
 * without a human in the loop. Many tasks are `decomposable` — they split into
 * independent per-item subtasks, the workload class where a swarm can beat a
 * single agent.
 *
 * Grader contract (enforced by the test suite):
 *   - correct answer            -> true
 *   - a plausible WRONG answer  -> false
 *   - "" (empty string)         -> false
 *   - no Math.random, no clock, no network — pure functions of `output`.
 *
 * ## Reference annotations (`reference:`) — what they are and are NOT
 *
 * Some of these tasks are decidable from their own prompt: the emails to
 * extract are in the sentence, the words to measure are in the list. Those
 * carry a `reference` declaring WHICH deterministic rule
 * (`../styx/declared-rules.ts`) computes their answer, and {@link EVAL_TASKS}
 * renders that declaration into the prompt as a `REF:` line so it travels
 * inside the REQUEST — the only channel a verifier is allowed to read.
 *
 * A `reference` is not an answer key. It names a transform; the transform is
 * recomputed from the prompt text by code that has never seen `grade` and
 * cannot reach it. The two are proved to agree by the corpus consistency test
 * (`__tests__/declared-reference-corpus.test.ts`), which is the only place in
 * the repo where a declared rule and a grader meet.
 *
 * Tasks that need judgement (sentiment, language, topic), prose reasoning, or
 * world knowledge (which country a city is in) carry NO annotation, on purpose.
 * The T1-reference verifier abstains on them, which is the honest outcome — a
 * rule stretched to "decide" a task it cannot decide would certify guesses.
 */

import type { EvalTask } from "./vtph";
import {
  EMAIL_RE,
  HASHTAG_RE,
  URL_RE,
  formatDeclaredReference,
  normalizeIntegerSetAscending,
  normalizeTokenSet,
  parseLabeledPairs,
} from "../styx/declared-rules";

// ---------------------------------------------------------------------------
// Grading helpers (module-private, all pure)
//
// The token patterns and set/pair normalizers are IMPORTED from
// `../styx/declared-rules` rather than declared here, so the grader and the
// T1-reference verifier share exactly one definition of "what an email address
// looks like" and one definition of set equality. A second copy could drift,
// and a drifted copy would make the two disagree about a correct answer —
// which would show up as a verifier false alarm and be blamed on the model.
// ---------------------------------------------------------------------------

/** All numbers in `s` (thousands separators tolerated, decimals kept). */
function numbersIn(s: string): number[] {
  const cleaned = s.replace(/(\d),(\d)/g, "$1$2");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number) : [];
}

/** The last number mentioned — robust to prose that restates the question. */
function lastNumber(s: string): number | null {
  const n = numbersIn(s);
  return n.length ? n[n.length - 1] : null;
}

/** Numeric-equality grader for arithmetic answers. */
function gradeNumber(expected: number) {
  return (output: string): boolean => {
    const got = lastNumber(output);
    return got !== null && Math.abs(got - expected) < 1e-9;
  };
}

/** Extract yes/no from possibly-prosey output (first standalone token wins). */
function yesNo(s: string): "yes" | "no" | null {
  const m = s.match(/\b(yes|no)\b/i);
  return m ? (m[1].toLowerCase() as "yes" | "no") : null;
}

function gradeYesNo(expected: "yes" | "no") {
  return (output: string): boolean => yesNo(output) === expected;
}

/**
 * Single-label classifier grader. Passes iff the expected label appears AND no
 * competing label from `labels` appears — so a blank, an off-topic answer, or a
 * wrong label all fail.
 */
function gradeLabel(labels: readonly string[], expected: string) {
  const lower = labels.map((l) => l.toLowerCase());
  const want = expected.toLowerCase();
  return (output: string): boolean => {
    const o = output.toLowerCase();
    const present = lower.filter((l) => new RegExp(`\\b${l}\\b`).test(o));
    return present.length === 1 && present[0] === want;
  };
}

/** Grade an extraction task against an expected normalized token set. */
function gradeTokenSet(re: RegExp, expected: string, lowercase = true) {
  return (output: string): boolean => {
    const norm = normalizeTokenSet(output.match(re) ?? [], lowercase);
    return norm === expected && expected.length > 0;
  };
}

/** Grade a unique-ascending-integer extraction task. */
function gradeIntSetAscending(expected: number[]) {
  const want = expected.join(",");
  return (output: string): boolean => {
    return normalizeIntegerSetAscending(output) === want && expected.length > 0;
  };
}

/** Pull the first balanced {...} object out of prose and JSON.parse it. */
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function gradeJson(expected: unknown) {
  return (output: string): boolean => deepEqual(firstJsonObject(output), expected);
}

/**
 * Grade a multi-part task: every expected key must be present with the expected
 * value. A missing key or any wrong value fails; "" yields an empty map -> fail.
 */
function gradePairs(expected: Record<string, string | number>) {
  const entries = Object.entries(expected).map(
    ([k, v]) => [k.toLowerCase(), String(v).toLowerCase()] as const,
  );
  return (output: string): boolean => {
    const map = parseLabeledPairs(output);
    if (map.size === 0) return false;
    return entries.every(([k, v]) => map.get(k) === v);
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const EVAL_CATEGORIES: readonly string[] = [
  "extraction",
  "classification",
  "transformation",
  "reasoning",
  "arithmetic",
  "multi-part",
] as const;

const SENTIMENT = ["positive", "negative", "neutral"] as const;
const LANGUAGE = ["english", "french", "spanish"] as const;
const TOPIC = ["sports", "politics", "technology"] as const;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const RAW_EVAL_TASKS: EvalTask[] = [
  // ---- extraction (6) -----------------------------------------------------
  {
    id: "extract-01-emails",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all email addresses from: Contact alice@example.com or bob@test.org for details. Return comma-separated, sorted.",
    grade: gradeTokenSet(EMAIL_RE, "alice@example.com,bob@test.org"),
    reference: { rule: "extract-emails" },
  },
  {
    id: "extract-02-emails-url-distractor",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all email addresses from: Email sales@acme.io. Visit www.acme.io (not an email). Reach carol@acme.io too. Return comma-separated, sorted.",
    grade: gradeTokenSet(EMAIL_RE, "carol@acme.io,sales@acme.io"),
    reference: { rule: "extract-emails" },
  },
  {
    id: "extract-03-emails-case-mailto",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all email addresses from: From: john.doe@work.net, cc: JANE@WORK.NET. Also mailto:admin@work.net. Return comma-separated, sorted, lowercased.",
    grade: gradeTokenSet(EMAIL_RE, "admin@work.net,jane@work.net,john.doe@work.net"),
    reference: { rule: "extract-emails" },
  },
  {
    id: "extract-04-hashtags",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all hashtags from: Love #Coding and #AI but #coding again. Return unique, lowercased, comma-separated, sorted.",
    grade: gradeTokenSet(HASHTAG_RE, "#ai,#coding"),
    reference: { rule: "extract-hashtags" },
  },
  {
    id: "extract-05-numbers",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all numbers from: I have 3 cats, 12 dogs, and 3 birds. Return unique integers ascending, comma-separated.",
    grade: gradeIntSetAscending([3, 12]),
    reference: { rule: "extract-integers-ascending" },
  },
  {
    id: "extract-06-urls",
    category: "extraction",
    decomposable: false,
    prompt:
      "Extract all URLs from: See https://a.com and http://b.org for info. Return comma-separated, sorted.",
    grade: gradeTokenSet(URL_RE, "http://b.org,https://a.com", false),
    reference: { rule: "extract-urls" },
  },

  // ---- classification (7) -------------------------------------------------
  {
    id: "classify-01-sentiment-pos",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the sentiment (positive/negative/neutral): I absolutely love this product, it works great! Answer with one word.",
    grade: gradeLabel(SENTIMENT, "positive"),
  },
  {
    id: "classify-02-sentiment-neg",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the sentiment (positive/negative/neutral): This is the worst experience I have ever had. Answer with one word.",
    grade: gradeLabel(SENTIMENT, "negative"),
  },
  {
    id: "classify-03-sentiment-neutral",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the sentiment (positive/negative/neutral): The package arrived on Tuesday afternoon. Answer with one word.",
    grade: gradeLabel(SENTIMENT, "neutral"),
  },
  {
    id: "classify-04-language-fr",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the language (english/french/spanish): Bonjour, comment allez-vous aujourd'hui? Answer with one word.",
    grade: gradeLabel(LANGUAGE, "french"),
  },
  {
    id: "classify-05-language-es",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the language (english/french/spanish): Hola, me llamo Maria y vivo en Madrid. Answer with one word.",
    grade: gradeLabel(LANGUAGE, "spanish"),
  },
  {
    id: "classify-06-topic-tech",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the topic (sports/politics/technology): The new smartphone features a faster processor and a better camera. Answer with one word.",
    grade: gradeLabel(TOPIC, "technology"),
  },
  {
    id: "classify-07-topic-politics",
    category: "classification",
    decomposable: false,
    prompt:
      "Classify the topic (sports/politics/technology): The senator proposed a new bill on tax reform this week. Answer with one word.",
    grade: gradeLabel(TOPIC, "politics"),
  },

  // ---- transformation (6) -------------------------------------------------
  {
    id: "transform-01-csv-strings",
    category: "transformation",
    decomposable: false,
    prompt:
      "Convert this CSV row `Alice,Engineer,London` with header `name,role,city` to a JSON object (all values as strings). Output only JSON.",
    grade: gradeJson({ name: "Alice", role: "Engineer", city: "London" }),
  },
  {
    id: "transform-02-csv-strings",
    category: "transformation",
    decomposable: false,
    prompt:
      "Convert this CSV row `red,circle,large` with header `color,shape,size` to a JSON object (all values as strings). Output only JSON.",
    grade: gradeJson({ color: "red", shape: "circle", size: "large" }),
  },
  {
    id: "transform-03-csv-typed",
    category: "transformation",
    decomposable: false,
    prompt:
      "Convert this CSV row `Dune,1965` with header `title,year` to a JSON object, with title as a string and year as a number. Output only JSON.",
    grade: gradeJson({ title: "Dune", year: 1965 }),
  },
  {
    id: "transform-04-swap",
    category: "transformation",
    decomposable: false,
    prompt:
      'Given the JSON {"a":"x","b":"y"}, swap keys and values. Output only JSON.',
    grade: gradeJson({ x: "a", y: "b" }),
  },
  {
    id: "transform-05-uppercase-values",
    category: "transformation",
    decomposable: false,
    prompt:
      'Given the JSON {"first":"hi","second":"bye"}, uppercase every string value (keep keys unchanged). Output only JSON.',
    grade: gradeJson({ first: "HI", second: "BYE" }),
  },
  {
    id: "transform-06-csv-bool-num",
    category: "transformation",
    decomposable: false,
    prompt:
      "Convert this CSV row `true,42` with header `active,score` to a JSON object, with active as a boolean and score as a number. Output only JSON.",
    grade: gradeJson({ active: true, score: 42 }),
  },

  // ---- reasoning (7) ------------------------------------------------------
  {
    id: "reason-01-syllogism",
    category: "reasoning",
    decomposable: false,
    prompt:
      "If all Bloops are Razzies and all Razzies are Lazzies, are all Bloops Lazzies? Answer yes or no.",
    grade: gradeYesNo("yes"),
  },
  {
    id: "reason-02-some-quantifier",
    category: "reasoning",
    decomposable: false,
    prompt:
      "If some cats are dogs and all dogs are blue, are all cats blue? Answer yes or no.",
    grade: gradeYesNo("no"),
  },
  {
    id: "reason-03-transitive-height",
    category: "reasoning",
    decomposable: false,
    prompt:
      "A is taller than B, and B is taller than C. Is A taller than C? Answer yes or no.",
    grade: gradeYesNo("yes"),
  },
  {
    id: "reason-04-youngest",
    category: "reasoning",
    decomposable: false,
    prompt:
      "Tom is older than Sue, and Sue is older than Ben. Is Ben the youngest of the three? Answer yes or no.",
    grade: gradeYesNo("yes"),
  },
  {
    id: "reason-05-affirming-consequent",
    category: "reasoning",
    decomposable: false,
    prompt:
      "If it is raining then the ground is wet. The ground is wet. Is it necessarily raining? Answer yes or no.",
    grade: gradeYesNo("no"),
  },
  {
    id: "reason-06-square-rectangle",
    category: "reasoning",
    decomposable: false,
    prompt:
      "All squares are rectangles. Is every rectangle a square? Answer yes or no.",
    grade: gradeYesNo("no"),
  },
  {
    id: "reason-07-transitive-numbers",
    category: "reasoning",
    decomposable: false,
    prompt:
      "5 is greater than 3, and 3 is greater than 1. Is 5 greater than 1? Answer yes or no.",
    grade: gradeYesNo("yes"),
  },

  // ---- arithmetic / multi-step (8) ---------------------------------------
  {
    id: "arith-01-sum-primes",
    category: "arithmetic",
    decomposable: false,
    prompt:
      "What is the sum of all prime numbers below 20? Answer with just the number.",
    grade: gradeNumber(77),
  },
  {
    id: "arith-02-percent",
    category: "arithmetic",
    decomposable: false,
    prompt: "What is 15% of 200? Answer with just the number.",
    grade: gradeNumber(30),
  },
  {
    id: "arith-03-factorial",
    category: "arithmetic",
    decomposable: false,
    prompt: "What is 7 factorial (7!)? Answer with just the number.",
    grade: gradeNumber(5040),
  },
  {
    id: "arith-04-discount",
    category: "arithmetic",
    decomposable: false,
    prompt:
      "A shirt costs $40 and is discounted 25%. What is the sale price in dollars? Answer with just the number.",
    grade: gradeNumber(30),
  },
  {
    id: "arith-05-sum-1-to-10",
    category: "arithmetic",
    decomposable: false,
    prompt:
      "What is the sum of the first 10 positive integers? Answer with just the number.",
    grade: gradeNumber(55),
  },
  {
    id: "arith-06-speed",
    category: "arithmetic",
    decomposable: false,
    prompt:
      "If a train travels 60 miles in 1.5 hours, what is its speed in miles per hour? Answer with just the number.",
    grade: gradeNumber(40),
  },
  {
    id: "arith-07-power",
    category: "arithmetic",
    decomposable: false,
    prompt: "What is 2 to the power of 10? Answer with just the number.",
    grade: gradeNumber(1024),
  },
  {
    id: "arith-08-gcd",
    category: "arithmetic",
    decomposable: false,
    prompt:
      "What is the greatest common divisor of 48 and 36? Answer with just the number.",
    grade: gradeNumber(12),
  },

  // ---- multi-part (14, all decomposable) ---------------------------------
  {
    id: "multi-01-word-length",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, give its length: apple, kiwi, banana. Return as `word:length`, comma-separated.",
    grade: gradePairs({ apple: 5, kiwi: 4, banana: 6 }),
    reference: { rule: "per-item-length" },
  },
  {
    id: "multi-02-first-letter",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, give its first letter: dog, cat, fish. Return as `word:letter`, comma-separated.",
    grade: gradePairs({ dog: "d", cat: "c", fish: "f" }),
    reference: { rule: "per-item-first-letter" },
  },
  {
    id: "multi-03-double",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, give its double: 3, 8, 10. Return as `number:double`, comma-separated.",
    grade: gradePairs({ 3: 6, 8: 16, 10: 20 }),
    reference: { rule: "per-item-double" },
  },
  {
    id: "multi-04-parity",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, is it even or odd? 4, 7, 12. Return as `number:parity`, comma-separated.",
    grade: gradePairs({ 4: "even", 7: "odd", 12: "even" }),
    reference: { rule: "per-item-parity" },
  },
  {
    id: "multi-05-word-length-2",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, give its length: hello, hi, world. Return as `word:length`, comma-separated.",
    grade: gradePairs({ hello: 5, hi: 2, world: 5 }),
    reference: { rule: "per-item-length" },
  },
  {
    id: "multi-06-square",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, give its square: 2, 5, 9. Return as `number:square`, comma-separated.",
    grade: gradePairs({ 2: 4, 5: 25, 9: 81 }),
    reference: { rule: "per-item-square" },
  },
  {
    id: "multi-07-capital",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each city, give its country: Paris, Tokyo, Cairo. Return as `city:country`, comma-separated.",
    grade: gradePairs({ paris: "france", tokyo: "japan", cairo: "egypt" }),
  },
  {
    id: "multi-08-vowel-count",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, count its vowels (a, e, i, o, u): apple, sky, ocean. Return as `word:count`, comma-separated.",
    grade: gradePairs({ apple: 2, sky: 0, ocean: 3 }),
    reference: { rule: "per-item-vowel-count" },
  },
  {
    id: "multi-09-plus-ten",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, add 10: 5, 15, 100. Return as `number:sum`, comma-separated.",
    grade: gradePairs({ 5: 15, 15: 25, 100: 110 }),
    reference: { rule: "per-item-plus-ten" },
  },
  {
    id: "multi-10-word-length-3",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, give its length: sun, moon, star, comet. Return as `word:length`, comma-separated.",
    grade: gradePairs({ sun: 3, moon: 4, star: 4, comet: 5 }),
    reference: { rule: "per-item-length" },
  },
  {
    id: "multi-11-is-prime",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, is it prime (yes/no)? 7, 8, 11. Return as `number:answer`, comma-separated.",
    grade: gradePairs({ 7: "yes", 8: "no", 11: "yes" }),
    reference: { rule: "per-item-is-prime" },
  },
  {
    id: "multi-12-celsius-fahrenheit",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each temperature in Celsius, give it in Fahrenheit: 0, 100. Return as `celsius:fahrenheit`, comma-separated.",
    grade: gradePairs({ 0: 32, 100: 212 }),
    reference: { rule: "per-item-celsius-to-fahrenheit" },
  },
  {
    id: "multi-13-color-length",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each word, give the number of letters: red, green, blue. Return as `word:length`, comma-separated.",
    grade: gradePairs({ red: 3, green: 5, blue: 4 }),
    reference: { rule: "per-item-length" },
  },
  {
    id: "multi-14-half",
    category: "multi-part",
    decomposable: true,
    prompt:
      "For each number, give its half: 10, 30, 8. Return as `number:half`, comma-separated.",
    grade: gradePairs({ 10: 5, 30: 15, 8: 4 }),
    reference: { rule: "per-item-half" },
  },
];

/**
 * Render an annotated task's declaration into its own prompt as a `REF:` line.
 *
 * The declaration has to reach the verifier somehow, and the request is the
 * only honest carrier: `evidence` and `trace` are written by whoever produced
 * the ANSWER, so a rule carried there would let the answerer choose the
 * criterion it is judged by. Putting it in the prompt also keeps agent and
 * verifier reading the SAME request — nobody is judged against a question they
 * were not asked.
 *
 * Deriving the line from the field (rather than typing it into both places)
 * is what makes drift impossible: there is one declaration per task and the
 * prompt is a projection of it.
 *
 * The line does not make the task easier. It is a machine-readable restatement
 * of normalization the prose already demands ("Return unique, lowercased,
 * comma-separated, sorted"), and it names a transform rather than an answer —
 * a solver that reads it still has to do the extraction itself.
 */
function withDeclaredReferenceLine(task: EvalTask): EvalTask {
  if (!task.reference) return task;
  return { ...task, prompt: `${task.prompt}\n${formatDeclaredReference(task.reference)}` };
}

/**
 * The corpus. Annotated tasks carry their declaration in the prompt; the rest
 * are passed through untouched, so the T1-reference verifier abstains on them.
 */
export const EVAL_TASKS: EvalTask[] = RAW_EVAL_TASKS.map(withDeclaredReferenceLine);

/** Tasks whose answer a declared rule decides (see the module note). */
export function referenceAnnotatedTasks(): EvalTask[] {
  return EVAL_TASKS.filter((t) => t.reference !== undefined);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function tasksByCategory(category: string): EvalTask[] {
  return EVAL_TASKS.filter((t) => t.category === category);
}

export function decomposableTasks(): EvalTask[] {
  return EVAL_TASKS.filter((t) => t.decomposable);
}
