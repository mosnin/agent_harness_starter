/**
 * STYX primitive (S3) — the anti-gaming layer: isomorphic perturbation + verifier rotation.
 *
 * "A correct answer survives a paraphrase of the question; a gamed answer does not."
 *
 * ## Why this exists (the S1 correlated-bias limitation it repairs)
 *
 * The S1 trust kernel scores answers with a *calibrated verifier ensemble*. That
 * ensemble is powerful but it has a known, load-bearing failure mode (design
 * constraints #2 and #3 in the architecture): the verifiers can be **confidently
 * and correlatedly wrong** — every member sharing one blind spot rubber-stamps
 * the same false positive — and a worker under sustained optimization can
 * **overfit to the verifier**, learning the surface features that make *this*
 * ensemble say "correct" instead of learning to be correct. Reward-hacking of an
 * imperfect proxy is inevitable (Verification Horizon, 2604.15149). No amount of
 * *calibration* fixes this, because the calibration set is drawn from the same
 * biased process. You need an **orthogonal** signal that the gaming strategy
 * cannot see. This module supplies two such signals.
 *
 * ### Defense 1 — isomorphic perturbation ({@link checkRobustness})
 *
 * A *genuinely* correct answer is a function of the task's **meaning**, so it is
 * invariant under semantics-preserving rewrites of the task: reword it, upcase
 * it, jitter its whitespace, relabel its entities — the correct answer tracks
 * the rewrite (and where the rewrite renames something, the correct answer
 * renames with it, and inverse-maps straight back to canonical). A **memorized
 * or gamed** answer cannot do this: it is pinned to a specific *surface form*
 * (the exact string the worker optimized against), so a meaning-preserving edit
 * that leaves the answer's *meaning* untouched nonetheless **breaks** the gamed
 * output. That asymmetry — robust solver stays consistent, brittle/gamed solver
 * diverges — is the entire detector. It needs no ground truth and no trusted
 * verifier; it only needs the solver to be run a few more times.
 *
 * ### Defense 2 — verifier rotation ({@link verifierRotation})
 *
 * Overfitting is, by definition, invisible on the data you overfit to. Split the
 * verifier votes into the set the worker could *see and optimize against* and a
 * **held-out** set it never saw. A truly-correct answer passes both. A gamed
 * answer passes the optimized set (that is what "gamed" means) but **fails the
 * held-out verifiers** — because it learned the optimized verifiers' quirks, not
 * correctness. Passing-optimized-while-failing-held-out is the fingerprint of
 * verifier-overfitting, and it is exactly what the raw ensemble score hides.
 *
 * Together these are the S3 countermeasure to the S1 correlated-bias / gaming
 * limitation: perturbation attacks the *worker-overfits-surface-form* leak,
 * rotation attacks the *worker-overfits-the-judges* leak.
 *
 * ## Purity
 *
 * Everything here is pure and deterministic: no `Math.random`, no clock, no
 * network, no I/O. Given the same solver and inputs you get the same report,
 * which is what lets the anti-gaming suite be a reproducible red-team gate.
 *
 * @module styx/perturb
 */

// ---------------------------------------------------------------------------
// Isomorphic perturbation
// ---------------------------------------------------------------------------

/**
 * A single semantics-preserving transform of a task, paired with the inverse it
 * induces on the *answer*.
 *
 * The pair must satisfy the isomorphism contract: for a solver that depends only
 * on the task's meaning, `inverseAnswer(solve(forward(input)))` must equal
 * `solve(input)` (after normalization). `forward` rewrites the task without
 * changing what a correct answer *means*; `inverseAnswer` undoes whatever
 * relabeling `forward` imposed on the answer's surface form (and is the identity
 * when `forward` renames nothing the answer can contain).
 *
 * @typeParam T - the solver's input type (often `string`, but any task shape).
 */
export interface Perturbation<T> {
  /** Human-readable label, surfaced per-variant in {@link RobustnessReport}. */
  name: string;
  /** Semantics-preserving rewrite of the task input. */
  forward: (input: T) => T;
  /**
   * Undo the transform's effect on the answer. Identity when `forward`
   * introduced no relabeling that could appear in the answer (whitespace, case,
   * synonym rewrites of the *prompt*); a real inverse for entity/number
   * relabeling, which maps the renamed tokens in the answer back to canonical.
   */
  inverseAnswer: (answer: string) => string;
}

/** A deterministic task solver: task in, answer string out. */
export type Solver<T> = (input: T) => string;

/** The verdict of an isomorphic-perturbation robustness check. */
export interface RobustnessReport {
  /** `normalize(solver(input))` — the answer on the un-perturbed task. */
  canonicalAnswer: string;
  /**
   * Fraction of perturbations whose inverse-mapped answer matched
   * `canonicalAnswer` after normalization. `1.0` when there are no
   * perturbations (nothing could disagree).
   */
  agreementRate: number;
  /** `agreementRate >= threshold`. See {@link checkRobustness} for the gate semantics. */
  consistent: boolean;
  /** Per-perturbation detail, in the order the perturbations were supplied. */
  variants: Array<{
    /** The perturbation's `name`. */
    name: string;
    /** Raw (un-normalized) solver output on the perturbed input. */
    rawAnswer: string;
    /** `normalize(inverseAnswer(rawAnswer))` — the answer mapped back to canonical space. */
    mappedAnswer: string;
    /** `mappedAnswer === canonicalAnswer`. */
    matched: boolean;
  }>;
}

/** Default answer normalizer: trim outer whitespace and lowercase. */
function defaultNormalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Run an isomorphic-perturbation robustness check on a solver.
 *
 * Procedure:
 *  1. `canonicalAnswer = normalize(solver(input))` — solve the original task.
 *  2. For each perturbation `p`:
 *       `raw    = solver(p.forward(input))`   — solve the meaning-preserving rewrite
 *       `mapped = normalize(p.inverseAnswer(raw))` — map the answer back to canonical space
 *       `matched = mapped === canonicalAnswer`
 *  3. `agreementRate = matched / total` (`1.0` if there are no perturbations).
 *  4. `consistent = agreementRate >= threshold`.
 *
 * ### The asymmetry that makes this a gaming detector
 *
 * - A **robust** solver — one whose output is a function of the task's *meaning*
 *   (count the words, extract the emails, name the winner) — is invariant under
 *   every semantics-preserving rewrite, so every variant inverse-maps to
 *   `canonicalAnswer`: `agreementRate === 1` → `consistent === true`.
 * - A **brittle / gamed** solver — one that hard-codes the right answer for the
 *   exact original surface form and returns garbage otherwise — diverges on at
 *   least one variant: `agreementRate < 1` → with a strict threshold,
 *   `consistent === false`, and the gate rejects it.
 *
 * This asymmetry is the whole point: it lets the abstention gate reject a gamed
 * answer *without* a trusted verifier or ground truth.
 *
 * ### Threshold
 *
 * `threshold` defaults to `1.0`, i.e. **every** perturbation must agree. A strict
 * anti-gaming gate wants exactly this all-agree behavior: a genuinely correct
 * answer has no reason to break under *any* meaning-preserving rewrite, so a
 * single divergence is already evidence of surface-form pinning. Loosen the
 * threshold (e.g. `0.8`) only when some perturbations are known to be imperfectly
 * semantics-preserving for the domain and you are trading detector precision for
 * recall.
 *
 * @typeParam T - solver input type.
 * @param solver - the deterministic solver under test.
 * @param input - the original, un-perturbed task.
 * @param perturbations - semantics-preserving transforms to probe with.
 * @param opts.threshold - agreement bar for `consistent` (default `1.0`).
 * @param opts.normalize - answer normalizer (default: trim + lowercase).
 */
export function checkRobustness<T>(
  solver: Solver<T>,
  input: T,
  perturbations: Array<Perturbation<T>>,
  opts?: { threshold?: number; normalize?: (s: string) => string },
): RobustnessReport {
  const threshold = opts?.threshold ?? 1.0;
  const normalize = opts?.normalize ?? defaultNormalize;

  const canonicalAnswer = normalize(solver(input));

  const variants = perturbations.map((p) => {
    const rawAnswer = solver(p.forward(input));
    const mappedAnswer = normalize(p.inverseAnswer(rawAnswer));
    return {
      name: p.name,
      rawAnswer,
      mappedAnswer,
      matched: mappedAnswer === canonicalAnswer,
    };
  });

  const total = variants.length;
  const agreed = variants.reduce((n, v) => n + (v.matched ? 1 : 0), 0);
  const agreementRate = total === 0 ? 1.0 : agreed / total;

  return {
    canonicalAnswer,
    agreementRate,
    consistent: agreementRate >= threshold,
    variants,
  };
}

// ---------------------------------------------------------------------------
// Ready-made string perturbations (semantics-preserving)
// ---------------------------------------------------------------------------

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word replace, single left-to-right pass (no chaining: a replacement is
 * never re-scanned by a later key). `\b` word boundaries mean only complete
 * alphanumeric tokens are matched. Keys are tried longest-first so an overlap
 * like `["one", "oneone"]` prefers the longer key.
 */
function replaceWholeWords(text: string, pairs: Array<[string, string]>): string {
  const usable = pairs.filter(([from]) => from.length > 0);
  if (usable.length === 0) return text;
  const lookup = new Map<string, string>();
  for (const [from, to] of usable) {
    if (!lookup.has(from)) lookup.set(from, to);
  }
  const alternation = [...lookup.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(`\\b(?:${alternation})\\b`, "g");
  return text.replace(re, (m) => lookup.get(m) ?? m);
}

/**
 * Whitespace jitter: collapse every run of whitespace to a single space, trim
 * the ends, then append a trailing newline. Semantics-preserving for any solver
 * that tokenizes on whitespace (word count, email extraction, keyword lookup):
 * the *tokens* are unchanged, only their spacing. The answer needs no inverse
 * (`inverseAnswer` is the identity).
 */
export function whitespaceJitter(): Perturbation<string> {
  return {
    name: "whitespaceJitter",
    forward: (input) => `${input.replace(/\s+/g, " ").trim()}\n`,
    inverseAnswer: (answer) => answer,
  };
}

/**
 * Case flip: upcase the entire prompt. Use for tasks whose correct answer is
 * **case-insensitive** (word counts, numeric answers, case-folded lookups): a
 * meaning-preserving solver returns the same answer regardless of prompt case,
 * so `inverseAnswer` is the identity. Do not use when the answer must echo the
 * prompt's original casing.
 */
export function caseFlip(): Perturbation<string> {
  return {
    name: "caseFlip",
    forward: (input) => input.toUpperCase(),
    inverseAnswer: (answer) => answer,
  };
}

/**
 * Synonym swap: whole-word replace each `[from, to]` pair in the **prompt only**.
 * The pairs must be genuine synonyms so the task's meaning is unchanged (e.g.
 * `["quick","fast"]`). Because only the prompt is rewritten and the answer's
 * vocabulary is untouched, `inverseAnswer` is the identity. Replacement is a
 * single whole-word pass, so `["cat","dog"]` will not later turn the injected
 * `dog` back into something else.
 */
export function synonymSwap(pairs: Array<[string, string]>): Perturbation<string> {
  return {
    name: "synonymSwap",
    forward: (input) => replaceWholeWords(input, pairs),
    inverseAnswer: (answer) => answer,
  };
}

/**
 * Number / entity rename: relabel tokens in the **prompt** via `mapping`
 * (`[from, to]`), and — crucially — **inverse-map them back in the answer**.
 *
 * This is the one ready-made perturbation with a non-identity inverse, because
 * the relabeled token can appear in the answer. If the original task is "The
 * winner is Alice — who won?" with mapping `[["Alice","Bob"]]`, the forward
 * prompt becomes "The winner is Bob — who won?"; a correct solver answers `Bob`;
 * `inverseAnswer` maps `Bob → Alice`, recovering the canonical `Alice`. A
 * gamer that hard-codes `Alice` for the original string returns garbage on the
 * renamed prompt, and no inverse map recovers canonical → the variant diverges.
 *
 * Forward and inverse both use the same single-pass whole-word replacement, so
 * the round-trip is exact and deterministic as long as the `from`/`to` token
 * sets do not collide.
 */
export function numberRename(mapping: Array<[string, string]>): Perturbation<string> {
  const inverse = mapping
    .filter(([, to]) => to.length > 0)
    .map(([from, to]) => [to, from] as [string, string]);
  return {
    name: "numberRename",
    forward: (input) => replaceWholeWords(input, mapping),
    inverseAnswer: (answer) => replaceWholeWords(answer, inverse),
  };
}

// ---------------------------------------------------------------------------
// Verifier rotation
// ---------------------------------------------------------------------------

/** The verdict of a verifier-rotation (held-out) check. */
export interface RotationReport {
  /**
   * Fraction of **held-out** verifiers (ids not in `optimizedIds`) that passed
   * the answer. `1.0` when there are no held-out verifiers (vacuously all pass).
   */
  passRateHeldOut: number;
  /** `passRateHeldOut >= minHeldOutPass`; `true` when there are no held-out verifiers. */
  passedHeldOut: boolean;
  /**
   * `true` iff the answer passed the **entire optimized set** yet failed the
   * held-out set (`passRateHeldOut < minHeldOutPass`) — the fingerprint of
   * verifier-overfitting. `false` when there are no held-out verifiers to test
   * against.
   */
  overfitSuspected: boolean;
}

/**
 * Verifier rotation: detect verifier-overfitting by holding out judges.
 *
 * Split `votes` into the **optimized** set (ids in `optimizedIds` — the
 * verifiers the worker could see and optimize against) and the **held-out** set
 * (every other id in `votes`). Then:
 *
 * - `passRateHeldOut` = passing held-out verifiers / held-out verifiers.
 * - `passedHeldOut`   = `passRateHeldOut >= minHeldOutPass`.
 * - `overfitSuspected` = (every optimized verifier passed) **AND**
 *   `passRateHeldOut < minHeldOutPass`.
 *
 * The logic mirrors the module thesis: a truly-correct answer passes optimized
 * and held-out alike; a **gamed** answer passes the optimized judges it was
 * tuned against but stumbles on the held-out judges it never saw — and that
 * pass-optimized-fail-held-out pattern is precisely what the raw ensemble score
 * cannot reveal.
 *
 * ### No-held-out edge case
 *
 * If `optimizedIds` covers every id in `votes` there is nothing held out to
 * corroborate against. We cannot *detect* overfitting, so — documented and
 * deliberate — `overfitSuspected` is `false`, `passedHeldOut` is `true`, and
 * `passRateHeldOut` is `1.0` (vacuous). The absence of a rotation set is treated
 * as "no evidence of gaming from this check", not as a failure; other S1/S3
 * signals still apply.
 *
 * @param votes - map of verifier id → pass/fail for the answer.
 * @param optimizedIds - ids the worker could optimize against; the rest are held out.
 * @param opts.minHeldOutPass - held-out pass-rate bar (default `0.5`).
 */
export function verifierRotation(
  votes: Record<string, boolean>,
  optimizedIds: string[],
  opts?: { minHeldOutPass?: number },
): RotationReport {
  const minHeldOutPass = opts?.minHeldOutPass ?? 0.5;
  const optimizedSet = new Set(optimizedIds);

  const allIds = Object.keys(votes);
  const optimized = allIds.filter((id) => optimizedSet.has(id));
  const heldOut = allIds.filter((id) => !optimizedSet.has(id));

  // No held-out verifiers → cannot test for overfitting; treat as no evidence.
  if (heldOut.length === 0) {
    return {
      passRateHeldOut: 1.0,
      passedHeldOut: true,
      overfitSuspected: false,
    };
  }

  const heldOutPassed = heldOut.reduce((n, id) => n + (votes[id] ? 1 : 0), 0);
  const passRateHeldOut = heldOutPassed / heldOut.length;
  const passedHeldOut = passRateHeldOut >= minHeldOutPass;

  const allOptimizedPassed = optimized.every((id) => votes[id]);
  const overfitSuspected = allOptimizedPassed && passRateHeldOut < minHeldOutPass;

  return { passRateHeldOut, passedHeldOut, overfitSuspected };
}
