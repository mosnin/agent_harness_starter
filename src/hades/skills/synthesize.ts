/**
 * Skill synthesis — GATE-VERIFIED trajectories → re-loadable SKILL.md skills.
 *
 * This module is the one and only bridge from "the swarm actually did
 * something" to "here is a skill any worker can load". It is deliberately
 * paranoid: a trajectory only becomes a skill if it carries a real
 * ed25519-signed {@link VerificationCertificate} whose payload independently
 * re-hashes to the trajectory bytes, whose numbers are internally consistent
 * with having cleared the STYX abstention gate, whose underlying task
 * actually succeeded, and whose text contains no attempt to forge SKILL.md
 * frontmatter or break out of the embedded provenance fence.
 *
 * There is no LLM anywhere in this file. Synthesis is a deterministic
 * distillation of the trajectory's own structure: capabilities come from
 * `TaskTrajectory.capability`, tools come from tools that actually succeeded
 * at least once, and the step-by-step instructions come from a positional
 * merge ("majority ordering") of the successful tool sequences across every
 * accepted source. Same inputs, byte-identical output.
 *
 * @module hades/skills/synthesize
 */

import type { GoalTrajectory, TaskTrajectory, ToolEvent } from "../research/recorder";
import {
  canonicalize,
  sha256Hex,
  verifyCertificate,
  type VerificationCertificate,
} from "../styx/certificate";
import {
  parseSkillFile,
  serializeSkillFile,
  validateSkillManifest,
  type SkillManifest,
} from "./skill-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A trajectory paired with the certificate that (claims to) attest it. */
export interface VerifiedTrajectory {
  trajectory: GoalTrajectory;
  certificate: VerificationCertificate;
}

/** Why a trajectory (or a whole synthesis) was refused. */
export interface SynthesisRejection {
  code:
    | "unsigned"
    | "bad-signature"
    | "hash-mismatch"
    | "not-emitted"
    | "failed-trajectory"
    | "too-thin"
    | "suspicious-content";
  detail: string;
}

/** Provenance embedded (and later extracted) from a synthesized skill's body. */
export interface SkillProvenance {
  /** sha256Hex(canonicalize(payload)) of the representative source certificate. */
  certSha256: string;
  trajectoryGoalId: string;
  objective: string;
  pCorrect: number;
  epsilon: number;
  synthesizedAt: number;
  sourceCount: number;
}

/** Knobs for {@link synthesizeSkill}. */
export interface SynthesisOptions {
  name?: string;
  version?: string;
  /** Minimum distinct successful tools required across ALL accepted sources. Default 2. */
  minSuccessfulTools?: number;
  /** Injectable clock for `synthesizedAt` / determinism in tests. Default Date.now(). */
  now?: number;
}

/** Outcome of a synthesis attempt. */
export interface SynthesisResult {
  ok: boolean;
  manifest?: SkillManifest;
  content?: string;
  provenance?: SkillProvenance;
  rejections: SynthesisRejection[];
}

// ---------------------------------------------------------------------------
// Canonical trajectory JSON (for independent trace-hash recomputation)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization of a full {@link GoalTrajectory}: object
 * keys sorted lexicographically at every level, array order preserved,
 * `undefined` fields dropped (matching `JSON.stringify` semantics so the
 * output is unambiguous), and — critically — every timestamp field
 * (`startedAt`, `endedAt`, `at`) is a real, non-optional property on these
 * types so it is never silently dropped by the recursion below.
 *
 * This is intentionally independent of `canonicalize()` in `../styx/certificate`
 * (which only knows about `CertificatePayload`): it lets a verifier recompute
 * `traceSha256` straight from the trajectory object a certificate claims to
 * attest, without trusting anything the certificate issuer says about it.
 */
export function canonicalTrajectoryJson(t: GoalTrajectory): string {
  return stableStringify(t);
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    // Only reachable for array elements (object properties are filtered
    // below before recursing) — JSON has no `undefined`; null is the closest
    // faithful, stable representation.
    return "null";
  }
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    return out === undefined ? "null" : out;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Suspicious-content detection (prompt-injection / frontmatter-forgery guard)
// ---------------------------------------------------------------------------

const SUSPICIOUS_PATTERNS: RegExp[] = [
  // A bare `---` line — the exact delimiter SKILL.md frontmatter parsing
  // looks for. Trajectory text must never be trusted to sit safely next to
  // that syntax, so we refuse to synthesize rather than rely on positional
  // luck about where the text ends up in the generated document.
  /(^|\n)[ \t]*---[ \t]*(\n|$)/,
  // Triple-backtick fences: could break out of the ```hades-provenance fence
  // this module embeds, or forge a fake closing/opening fence in the body.
  /```/,
  // Classic prompt-injection phrasing.
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above)\s+instructions/i,
  /new\s+instructions\s*:/i,
  /system\s*:\s*you\s+are\b/i,
  // A YAML-looking `key: value` line that reads like forged frontmatter.
  /(^|\n)[ \t]*(name|description|capabilities|tools|whentouse|model|version)\s*:\s*\S/i,
];

function findSuspiciousText(t: GoalTrajectory): string | null {
  const candidates: string[] = [t.objective ?? ""];
  for (const task of t.tasks ?? []) {
    candidates.push(task.description ?? "");
    for (const tool of task.tools ?? []) {
      candidates.push(tool.summary ?? "");
    }
  }
  for (const text of candidates) {
    if (typeof text !== "string" || text.length === 0) continue;
    for (const re of SUSPICIOUS_PATTERNS) {
      if (re.test(text)) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-trajectory verification
// ---------------------------------------------------------------------------

function reject(code: SynthesisRejection["code"], detail: string): { ok: false; rejection: SynthesisRejection } {
  return { ok: false, rejection: { code, detail } };
}

/**
 * Gate a single trajectory for synthesis eligibility. Checks, in order:
 *
 *  1. `unsigned`     — the certificate is structurally not a signed object
 *                       (missing signature/publicKey/payload).
 *  2. `bad-signature` — well-formed but the ed25519 signature does not verify.
 *  3. `hash-mismatch` — signature verifies, but an independently recomputed
 *                       `sha256Hex(canonicalTrajectoryJson(trajectory))` does
 *                       not equal `certificate.payload.traceSha256`.
 *  4. `not-emitted`   — the payload's own numbers are inconsistent with having
 *                       cleared the conformal gate (`pCorrect` must be at
 *                       least `1 - epsilon`, and `epsilon` must lie in (0, 1]).
 *  5. `failed-trajectory` — `trajectory.success` is not `true`.
 *  6. `too-thin`      — the trajectory has zero `ok: true` tool events anywhere.
 *  7. `suspicious-content` — objective/description/summary text contains
 *                       frontmatter-forgery or prompt-injection material.
 */
export async function verifyTrajectoryForSynthesis(
  vt: VerifiedTrajectory
): Promise<{ ok: true } | { ok: false; rejection: SynthesisRejection }> {
  const { trajectory, certificate } = vt ?? ({} as VerifiedTrajectory);

  if (
    trajectory === null ||
    typeof trajectory !== "object" ||
    certificate === null ||
    typeof certificate !== "object" ||
    typeof certificate.signature !== "string" ||
    certificate.signature.trim() === "" ||
    typeof certificate.publicKey !== "string" ||
    certificate.publicKey.trim() === "" ||
    certificate.payload === null ||
    typeof certificate.payload !== "object"
  ) {
    return reject("unsigned", "certificate is missing a signature, public key, or payload.");
  }

  let signatureValid: boolean;
  try {
    signatureValid = await verifyCertificate(certificate);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return reject("bad-signature", "ed25519 signature does not verify against the certificate's public key.");
  }

  let recomputedTraceSha256: string;
  try {
    recomputedTraceSha256 = sha256Hex(canonicalTrajectoryJson(trajectory));
  } catch (err) {
    return reject("hash-mismatch", `could not canonicalize trajectory for hashing: ${String(err)}`);
  }
  const claimedTraceSha256 =
    typeof certificate.payload.traceSha256 === "string" ? certificate.payload.traceSha256.toLowerCase() : "";
  if (recomputedTraceSha256 !== claimedTraceSha256) {
    return reject(
      "hash-mismatch",
      `recomputed traceSha256 (${recomputedTraceSha256}) does not match certificate payload traceSha256 (${claimedTraceSha256}).`
    );
  }

  const { pCorrect, epsilon } = certificate.payload;
  if (
    typeof epsilon !== "number" ||
    !Number.isFinite(epsilon) ||
    epsilon <= 0 ||
    epsilon >= 1 ||
    typeof pCorrect !== "number" ||
    !Number.isFinite(pCorrect) ||
    pCorrect < 0 ||
    pCorrect > 1 ||
    pCorrect < 1 - epsilon
  ) {
    return reject(
      "not-emitted",
      `certificate payload (pCorrect=${String(pCorrect)}, epsilon=${String(
        epsilon
      )}) is not consistent with a result that cleared the conformal abstention gate.`
    );
  }

  if (trajectory.success !== true) {
    return reject("failed-trajectory", "trajectory.success is not true — the underlying task did not succeed.");
  }

  const hasOkTool = (trajectory.tasks ?? []).some((task) => (task.tools ?? []).some((tool) => tool.ok === true));
  if (!hasOkTool) {
    return reject("too-thin", "trajectory has zero ok:true tool events — nothing actionable to synthesize.");
  }

  const suspicious = findSuspiciousText(trajectory);
  if (suspicious !== null) {
    return reject(
      "suspicious-content",
      `trajectory text contains frontmatter-forgery or prompt-injection material: ${JSON.stringify(
        suspicious.slice(0, 120)
      )}`
    );
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Distillation helpers (pure, deterministic, no LLM)
// ---------------------------------------------------------------------------

const MAX_NAME_LEN = 64;
const MAX_TEXT_LEN = 400;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trimEnd() + "…";
}

function slugify(s: string, maxLen = MAX_NAME_LEN): string {
  const cleaned = (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = cleaned.length > maxLen ? cleaned.slice(0, maxLen).replace(/-+$/, "") : cleaned;
  return truncated.length > 0 ? truncated : "synthesized-skill";
}

/** Neutralize characters that would be dangerous to interpolate into markdown body text. */
function sanitizeForBody(text: string): string {
  return (text ?? "")
    .replace(/```/g, "'''")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "---" ? "\\-\\-\\-" : line))
    .join(" ")
    .trim();
}

interface RankedTool {
  tool: string;
  summary: string;
  rank: number;
}

/**
 * Positional "majority ordering" merge: each accepted trajectory contributes
 * an ordered sequence of distinct successful tool names (task order, then
 * tool order within a task). Every tool's merged rank is the average of its
 * 0-based position across the sequences it appears in (sequences it is
 * absent from do not contribute); ties broken by first-seen source order.
 * The result is the union of tools sorted by that merged rank.
 */
function mergeToolOrdering(sequences: { tool: string; summary: string }[][]): RankedTool[] {
  const positionSums = new Map<string, number>();
  const positionCounts = new Map<string, number>();
  const firstSeenOrder = new Map<string, number>();
  const firstSummary = new Map<string, string>();
  let seenIndex = 0;

  for (const seq of sequences) {
    seq.forEach((step, idx) => {
      if (!firstSeenOrder.has(step.tool)) {
        firstSeenOrder.set(step.tool, seenIndex++);
      }
      if (!firstSummary.has(step.tool) && step.summary.trim() !== "") {
        firstSummary.set(step.tool, step.summary);
      }
      positionSums.set(step.tool, (positionSums.get(step.tool) ?? 0) + idx);
      positionCounts.set(step.tool, (positionCounts.get(step.tool) ?? 0) + 1);
    });
  }

  const tools = [...positionCounts.keys()];
  tools.sort((a, b) => {
    const avgA = (positionSums.get(a) ?? 0) / (positionCounts.get(a) ?? 1);
    const avgB = (positionSums.get(b) ?? 0) / (positionCounts.get(b) ?? 1);
    if (avgA !== avgB) return avgA - avgB;
    return (firstSeenOrder.get(a) ?? 0) - (firstSeenOrder.get(b) ?? 0);
  });

  return tools.map((tool, i) => ({
    tool,
    summary: firstSummary.get(tool) ?? "",
    rank: i,
  }));
}

/** Distinct successful (ok:true) tool events in trajectory order. */
function successfulStepSequence(trajectory: GoalTrajectory): { tool: string; summary: string }[] {
  const steps: { tool: string; summary: string }[] = [];
  const seen = new Set<string>();
  for (const task of trajectory.tasks ?? []) {
    for (const event of task.tools ?? []) {
      if (event.ok !== true) continue;
      if (seen.has(event.tool)) continue;
      seen.add(event.tool);
      steps.push({ tool: event.tool, summary: (event.summary ?? task.description ?? "").toString() });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Provenance embedding / extraction
// ---------------------------------------------------------------------------

const PROVENANCE_FENCE_OPEN = "```hades-provenance";
const PROVENANCE_FENCE_CLOSE = "```";
const PROVENANCE_RE = /```hades-provenance\r?\n([\s\S]*?)\r?\n```/;

function renderProvenanceBlock(p: SkillProvenance): string {
  // Stable key order for byte-identical, human-diffable output.
  const ordered = {
    certSha256: p.certSha256,
    trajectoryGoalId: p.trajectoryGoalId,
    objective: p.objective,
    pCorrect: p.pCorrect,
    epsilon: p.epsilon,
    synthesizedAt: p.synthesizedAt,
    sourceCount: p.sourceCount,
  };
  return `${PROVENANCE_FENCE_OPEN}\n${JSON.stringify(ordered, null, 2)}\n${PROVENANCE_FENCE_CLOSE}`;
}

/**
 * Read a {@link SkillProvenance} block back out of a synthesized skill's
 * `instructions` body. Returns `null` (never throws) if no well-formed
 * provenance fence is present or its JSON does not match the expected shape.
 */
export function extractProvenance(instructions: string): SkillProvenance | null {
  if (typeof instructions !== "string") return null;
  const match = PROVENANCE_RE.exec(instructions);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<SkillProvenance>;
    if (
      typeof parsed.certSha256 !== "string" ||
      typeof parsed.trajectoryGoalId !== "string" ||
      typeof parsed.objective !== "string" ||
      typeof parsed.pCorrect !== "number" ||
      typeof parsed.epsilon !== "number" ||
      typeof parsed.synthesizedAt !== "number" ||
      typeof parsed.sourceCount !== "number"
    ) {
      return null;
    }
    return {
      certSha256: parsed.certSha256,
      trajectoryGoalId: parsed.trajectoryGoalId,
      objective: parsed.objective,
      pCorrect: parsed.pCorrect,
      epsilon: parsed.epsilon,
      synthesizedAt: parsed.synthesizedAt,
      sourceCount: parsed.sourceCount,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// synthesizeSkill
// ---------------------------------------------------------------------------

/**
 * Turn a set of GATE-VERIFIED trajectories into a re-loadable SKILL.md skill.
 * Deterministic, no LLM, never throws — every failure mode is an honest
 * `{ ok: false, rejections }`.
 */
export async function synthesizeSkill(
  sources: VerifiedTrajectory[],
  opts?: SynthesisOptions
): Promise<SynthesisResult> {
  const rejections: SynthesisRejection[] = [];

  if (!Array.isArray(sources) || sources.length === 0) {
    return { ok: false, rejections: [{ code: "too-thin", detail: "no sources provided for synthesis." }] };
  }

  const accepted: VerifiedTrajectory[] = [];
  for (const source of sources) {
    let verdict: { ok: true } | { ok: false; rejection: SynthesisRejection };
    try {
      verdict = await verifyTrajectoryForSynthesis(source);
    } catch (err) {
      verdict = { ok: false, rejection: { code: "unsigned", detail: `verification threw: ${String(err)}` } };
    }
    if (verdict.ok) {
      accepted.push(source);
    } else {
      rejections.push(verdict.rejection);
    }
  }

  if (accepted.length === 0) {
    return { ok: false, rejections };
  }

  const minSuccessfulTools = opts?.minSuccessfulTools ?? 2;

  // Distinct successful tools across ALL accepted sources.
  const sequences = accepted.map((s) => successfulStepSequence(s.trajectory));
  const merged = mergeToolOrdering(sequences);
  if (merged.length < minSuccessfulTools) {
    rejections.push({
      code: "too-thin",
      detail: `only ${merged.length} distinct successful tool(s) across ${accepted.length} accepted source(s); need at least ${minSuccessfulTools}.`,
    });
    return { ok: false, rejections };
  }

  // Capabilities: distinct TaskTrajectory.capability, first-seen order.
  const capabilities: string[] = [];
  const seenCaps = new Set<string>();
  for (const s of accepted) {
    for (const task of s.trajectory.tasks) {
      const cap = task.capability;
      if (typeof cap === "string" && cap.trim() !== "" && !seenCaps.has(cap)) {
        seenCaps.add(cap);
        capabilities.push(cap);
      }
    }
  }

  // Objectives: distinct, first-seen order, for description/whenToUse.
  const objectives: string[] = [];
  const seenObjectives = new Set<string>();
  for (const s of accepted) {
    const obj = (s.trajectory.objective ?? "").toString();
    if (obj.trim() !== "" && !seenObjectives.has(obj)) {
      seenObjectives.add(obj);
      objectives.push(obj);
    }
  }
  const primaryObjective = objectives[0] ?? "unnamed objective";

  const now = opts?.now ?? Date.now();
  const name = opts?.name ?? slugify(primaryObjective);
  const version = opts?.version ?? "0.1.0";

  const description = truncate(
    `Synthesized from ${accepted.length} GATE-VERIFIED trajector${accepted.length === 1 ? "y" : "ies"} for: ${sanitizeForBody(
      truncate(primaryObjective, MAX_TEXT_LEN)
    )}`,
    MAX_TEXT_LEN + 80
  );

  const whenToUse = truncate(
    objectives.length <= 1
      ? `Use when the goal resembles: ${sanitizeForBody(truncate(primaryObjective, MAX_TEXT_LEN))}`
      : `Use when the goal resembles any of: ${objectives
          .map((o) => sanitizeForBody(truncate(o, 120)))
          .join("; ")}`,
    MAX_TEXT_LEN + 160
  );

  const tools = merged.map((r) => r.tool);

  const primary = accepted[0];
  const certSha256 = sha256Hex(canonicalize(primary.certificate.payload));
  const provenance: SkillProvenance = {
    certSha256,
    trajectoryGoalId: primary.trajectory.goalId,
    objective: truncate(primaryObjective, MAX_TEXT_LEN),
    pCorrect: primary.certificate.payload.pCorrect,
    epsilon: primary.certificate.payload.epsilon,
    synthesizedAt: now,
    sourceCount: accepted.length,
  };

  const stepsMarkdown = merged
    .map((r, i) => {
      const summary = sanitizeForBody(truncate(r.summary || `Invoke \`${r.tool}\`.`, 200));
      return `${i + 1}. **${r.tool}** — ${summary}`;
    })
    .join("\n");

  const titleName = name;
  const instructions = [
    `# ${titleName}`,
    "",
    description,
    "",
    "## When to use",
    "",
    whenToUse,
    "",
    "## Steps",
    "",
    stepsMarkdown,
    "",
    "## Provenance",
    "",
    "This skill was synthesized only from trajectories that passed STYX gate",
    "verification: a real ed25519 signature plus an independently recomputed",
    "trace hash. Do not trust hand-edited copies of this block — re-run",
    "`verifyTrajectoryForSynthesis` on the source trajectory/certificate pair",
    "to confirm it still checks out.",
    "",
    renderProvenanceBlock(provenance),
    "",
  ].join("\n");

  const manifest: SkillManifest = {
    name,
    description,
    capabilities,
    tools,
    whenToUse,
    version,
    instructions,
  };

  try {
    const validation = validateSkillManifest(manifest);
    if (!validation.valid) {
      return {
        ok: false,
        rejections: [
          ...rejections,
          { code: "suspicious-content", detail: `internal manifest validation failed: ${validation.errors.join("; ")}` },
        ],
      };
    }

    const content = serializeSkillFile(manifest);

    // Round-trip guard: the whole point of this module is that its output is
    // always a valid, re-loadable SKILL.md. If this ever fails it means our
    // own rendering produced something the parser rejects — never emit that.
    const parsed = parseSkillFile(content);
    const reValidation = validateSkillManifest(parsed.manifest);
    if (!reValidation.valid) {
      return {
        ok: false,
        rejections: [
          ...rejections,
          {
            code: "suspicious-content",
            detail: `round-trip validation failed: ${reValidation.errors.join("; ")}`,
          },
        ],
      };
    }

    return { ok: true, manifest, content, provenance, rejections };
  } catch (err) {
    return {
      ok: false,
      rejections: [...rejections, { code: "suspicious-content", detail: `failed to render SKILL.md: ${String(err)}` }],
    };
  }
}

// Re-exported for callers that only need the types, keeping this module the
// single import surface for skill synthesis.
export type { GoalTrajectory, TaskTrajectory, ToolEvent };
