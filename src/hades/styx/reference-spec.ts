/**
 * Machine-checkable reference specs — the substrate for T1-reference
 * verification.
 *
 * A **reference spec** is a self-contained, deterministic description of what
 * a task's correct answer IS, carried inside the task prompt itself on a
 * `SPEC:{json}` line. Because the spec is embedded in the request, any party
 * holding only the prompt and the answer — a grader, a verifier, an auditor
 * re-checking a published run months later — can recompute the truth
 * independently. Nobody has to be trusted to have "already checked."
 *
 * That property is what makes a **T1-reference** verdict honest here. The
 * STYX tier ladder (`./tiers.ts`) defines T1-reference as "entailment against
 * a retrieved ground-truth source"; for a deterministic task the prompt IS
 * that source, and recomputation IS the entailment check. Contrast with
 * T4-consistency, which can only ask whether an answer is *shaped* like a
 * good answer — the exact weakness that let a confidently-formatted wrong
 * answer pass the gate.
 *
 * This module is deliberately layered BELOW both the benchmark
 * (`../bench/showdown.ts`) and the verifier (`../trust/reference-verifier.ts`)
 * so there is exactly ONE ground-truth implementation shared by the task
 * generator, the grader and the verifier. If those three ever disagreed, the
 * scoreboard would be measuring the disagreement rather than the agent.
 *
 * ## Two ways a request can carry a reference
 *
 * A `SPEC:` line inlines the operands (`{"family":"transform","text":"Hello
 * World","op":"rot13"}`) and is what a task GENERATOR emits, because a
 * generator knows the operands before it writes the prose. Prose corpora
 * written by hand cannot do that — their operands are in the sentence. Those
 * carry a `REF:` line naming a declared RULE instead (`./declared-rules.ts`),
 * which is recomputed against the request text itself. {@link resolveReference}
 * is the single entry point that accepts either, so the T1 verifier has one
 * code path and cannot treat one carrier as stronger evidence than the other.
 *
 * @module hades/styx/reference-spec
 */

import {
  computeDeclaredReference,
  describeDeclaredRule,
  extractDeclaredReference,
  matchesDeclaredReference,
} from "./declared-rules";

/** The task families that carry a machine-checkable reference spec. */
export type ReferenceFamily = "arithmetic" | "extraction" | "transform" | "checksum";

export interface ArithmeticSpec {
  family: "arithmetic";
  start: number;
  ops: Array<["add" | "sub" | "mul", number]>;
}
export interface ExtractionSpec {
  family: "extraction";
  record: Record<string, string>;
  field: string;
}
export interface TransformSpec {
  family: "transform";
  text: string;
  op: "reverse" | "upper" | "lower" | "rot13" | "wordcount";
}
export interface ChecksumSpec {
  family: "checksum";
  text: string;
}

export type ReferenceSpec = ArithmeticSpec | ExtractionSpec | TransformSpec | ChecksumSpec;

/** Deterministic FNV-1a 32-bit checksum, rendered as 8 lowercase hex chars. */
export function fnv1aHex(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** ROT13 over ASCII letters; every other character is passed through. */
export function rot13(s: string): string {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * THE ground-truth function. The task generator, the grader and the
 * T1-reference verifier all compute through this one implementation — real
 * code every time, never a precomputed constant threaded around.
 */
export function computeSpec(spec: ReferenceSpec): string {
  switch (spec.family) {
    case "arithmetic": {
      const result = spec.ops.reduce((acc, [op, val]) => {
        if (op === "add") return acc + val;
        if (op === "sub") return acc - val;
        return acc * val;
      }, spec.start);
      return String(result);
    }
    case "extraction":
      return spec.record[spec.field] ?? "";
    case "transform": {
      switch (spec.op) {
        case "reverse":
          return spec.text.split("").reverse().join("");
        case "upper":
          return spec.text.toUpperCase();
        case "lower":
          return spec.text.toLowerCase();
        case "rot13":
          return rot13(spec.text);
        case "wordcount":
          return String(spec.text.trim().split(/\s+/).filter(Boolean).length);
      }
      break;
    }
    case "checksum":
      return fnv1aHex(spec.text);
  }
}

/** The line prefix that carries a spec inside a prompt. */
export const SPEC_PREFIX = "SPEC:";

/**
 * Structural validation. A spec arrives as untrusted text parsed out of a
 * prompt, so every field is checked before {@link computeSpec} sees it — a
 * malformed spec must make the verifier ABSTAIN, never throw and never
 * silently compute nonsense that would be compared against a real answer.
 */
export function isReferenceSpec(value: unknown): value is ReferenceSpec {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.family) {
    case "arithmetic":
      return (
        typeof v.start === "number" &&
        Number.isFinite(v.start) &&
        Array.isArray(v.ops) &&
        v.ops.every(
          (o) =>
            Array.isArray(o) &&
            o.length === 2 &&
            (o[0] === "add" || o[0] === "sub" || o[0] === "mul") &&
            typeof o[1] === "number" &&
            Number.isFinite(o[1]),
        )
      );
    case "extraction":
      return (
        typeof v.record === "object" &&
        v.record !== null &&
        !Array.isArray(v.record) &&
        Object.values(v.record as Record<string, unknown>).every((x) => typeof x === "string") &&
        typeof v.field === "string"
      );
    case "transform":
      return (
        typeof v.text === "string" &&
        (v.op === "reverse" || v.op === "upper" || v.op === "lower" || v.op === "rot13" || v.op === "wordcount")
      );
    case "checksum":
      return typeof v.text === "string";
    default:
      return false;
  }
}

/**
 * Extract the reference spec embedded in a prompt, or `undefined` when the
 * prompt carries none (or carries something malformed). Returning
 * `undefined` rather than throwing is load-bearing: a verifier that cannot
 * find a reference must abstain, and abstaining is only safe if extraction
 * never blows up on adversarial input.
 *
 * The LAST well-formed `SPEC:` line wins, so text quoted inside a task
 * (including an attacker echoing a fake spec earlier in the prompt) cannot
 * displace the spec the harness appended.
 */
export function extractReferenceSpec(prompt: string): ReferenceSpec | undefined {
  if (typeof prompt !== "string" || !prompt.includes(SPEC_PREFIX)) return undefined;
  let found: ReferenceSpec | undefined;
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(SPEC_PREFIX)) continue;
    const json = trimmed.slice(SPEC_PREFIX.length).trim();
    if (!json) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      if (isReferenceSpec(parsed)) found = parsed;
    } catch {
      // Malformed JSON on a SPEC: line is not an error — it just isn't a
      // usable reference. Keep scanning; abstention is the safe outcome.
    }
  }
  return found;
}

/**
 * Compare a produced answer against the spec's recomputed truth.
 *
 * Comparison is deliberately strict-after-trim: the showdown prompts say
 * "Respond with only the exact result and nothing else", so surrounding
 * whitespace is forgiven and nothing else is. A looser comparison (substring,
 * case-insensitive) would let an answer that merely CONTAINS the truth pass,
 * which is precisely the kind of generosity that turns a verifier into a
 * rubber stamp.
 */
export function matchesReference(spec: ReferenceSpec, output: string): boolean {
  if (typeof output !== "string") return false;
  return output.trim() === computeSpec(spec);
}

// ---------------------------------------------------------------------------
// Unified resolution — the one entry point a verifier uses
// ---------------------------------------------------------------------------

/**
 * A reference recomputed from a request, ready to judge an answer.
 *
 * Note what is NOT in this interface: the task, its grader, its expected
 * value, or any handle that could reach one. A `ResolvedReference` is built
 * from a string and closes over that string alone, so a verifier holding one
 * is structurally incapable of asking the answer key anything. That is the
 * whole point — a check that consulted the grader would certify nothing,
 * because it would pass exactly when the grader passes and therefore measure
 * the grader rather than the answer.
 */
export interface ResolvedReference {
  /** Stable label for verdict reasons: a spec family, or `rule:<id>`. */
  label: string;
  /** What the reference computes, in words, so a human can audit the call. */
  describe: string;
  /** What this reference says the answer IS, recomputed from the request. */
  expected: string;
  /** Does `output` satisfy the reference, under its own equivalence relation? */
  matches(output: string): boolean;
}

/**
 * Resolve whatever machine-checkable reference `request` carries — an inline
 * `SPEC:` first, then a declared `REF:` rule — or `undefined` when it carries
 * neither, when it carries something malformed, or when the declared rule does
 * not actually decide this request (e.g. it extracts an empty set).
 *
 * `SPEC:` wins a tie because it is fully self-contained: its operands are
 * written down, so nothing about the surrounding prose can change what it
 * computes. Ties are not expected in practice; resolving them in a fixed,
 * documented order is what keeps two requests that differ only in carrier
 * order from being judged differently.
 */
export function resolveReference(request: string): ResolvedReference | undefined {
  const spec = extractReferenceSpec(request);
  if (spec) {
    return {
      label: spec.family,
      describe: `the ${spec.family} reference inlined in the request`,
      expected: computeSpec(spec),
      matches: (output) => matchesReference(spec, output),
    };
  }

  const ref = extractDeclaredReference(request);
  if (!ref) return undefined;
  const expected = computeDeclaredReference(ref, request);
  // A rule that cannot recompute an answer from this request decides nothing.
  // Returning `undefined` makes the caller abstain instead of comparing against
  // an empty string, which any empty answer would trivially "match".
  if (expected === undefined) return undefined;
  return {
    label: `rule:${ref.rule}`,
    describe: describeDeclaredRule(ref),
    expected,
    matches: (output) => matchesDeclaredReference(ref, request, output),
  };
}
