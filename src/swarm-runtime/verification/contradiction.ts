import type { Claim } from "../types";

export interface ClaimRef {
  statement: string;
  taskId?: string;
  workerId?: string;
}

export interface Contradiction {
  /** The shared subject two+ claims disagree about. */
  subject: string;
  /** The conflicting assertions. */
  conflicts: Array<{ value: string; statement: string; taskId?: string; workerId?: string }>;
}

const ARTICLES = new Set(["the", "a", "an", "this", "that", "these", "those", "its", "their"]);
const COPULAS = /\s+(?:is|are|was|were|equals?|has|have|=|:)\s+/i;
const NEGATORS = /\b(?:not|no|never|isn't|aren't|wasn't|weren't|cannot|can't|doesn't|don't)\b/i;

/**
 * Detects when different claims across a goal assert **conflicting values for
 * the same subject** — a classic signature of hallucination in a multi-agent
 * swarm (one worker says "retries = 5", another confidently says "retries =
 * 999"). Deliberately conservative: it only fires on structured `subject
 * <copula> value` assertions with short, definite values, so it flags real
 * contradictions rather than stylistic differences.
 *
 * This is a cross-checking layer *on top of* per-result grounding: each claim
 * may be individually well-evidenced, yet the set as a whole is inconsistent —
 * which means at least one is wrong and the goal should not be trusted as-is.
 */
export function detectContradictions(claims: ClaimRef[]): Contradiction[] {
  const bySubject = new Map<string, Array<{ value: string; ref: ClaimRef; negated: boolean }>>();

  for (const ref of claims) {
    const parsed = parseAssertion(ref.statement);
    if (!parsed) continue;
    const list = bySubject.get(parsed.subject) ?? [];
    list.push({ value: parsed.value, ref, negated: parsed.negated });
    bySubject.set(parsed.subject, list);
  }

  const contradictions: Contradiction[] = [];
  for (const [subject, entries] of bySubject) {
    // Distinct normalized values (treating negation as its own value bucket).
    const seen = new Map<string, { value: string; ref: ClaimRef }>();
    for (const e of entries) {
      const key = (e.negated ? "¬" : "") + e.value;
      if (!seen.has(key)) seen.set(key, { value: (e.negated ? "not " : "") + e.value, ref: e.ref });
    }
    if (seen.size >= 2) {
      contradictions.push({
        subject,
        conflicts: [...seen.values()].map((s) => ({
          value: s.value,
          statement: s.ref.statement,
          taskId: s.ref.taskId,
          workerId: s.ref.workerId,
        })),
      });
    }
  }
  return contradictions;
}

/** Convenience: pull ClaimRefs out of per-task verified claim sets. */
export function claimsToRefs(
  entries: Array<{ taskId: string; workerId?: string; claims: Claim[] }>
): ClaimRef[] {
  return entries.flatMap((e) =>
    e.claims.map((c) => ({ statement: c.statement, taskId: e.taskId, workerId: e.workerId }))
  );
}

// ── parsing ──────────────────────────────────────────────────────────────────

function parseAssertion(statement: string): { subject: string; value: string; negated: boolean } | null {
  const parts = statement.split(COPULAS);
  if (parts.length < 2) return null;
  const rawSubject = parts[0];
  const rawValue = parts.slice(1).join(" ");

  const subject = normalizeSubject(rawSubject);
  if (subject.split(" ").length > 8 || subject.length < 2) return null;

  const negated = NEGATORS.test(rawValue);
  const value = normalizeValue(rawValue.replace(NEGATORS, " "));
  // Only treat short, definite values as comparable to avoid false positives on
  // long descriptive clauses.
  if (!value || value.split(" ").length > 6) return null;

  return { subject, value, negated };
}

function normalizeSubject(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !ARTICLES.has(w))
    .join(" ")
    .trim();
}

function normalizeValue(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.;,!?"'`]+$/g, "")
    .replace(/[^a-z0-9%.\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
}
