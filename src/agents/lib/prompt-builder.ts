/**
 * Dynamic prompt builder for structured PLAN → ACT → VERIFY → CRITIC LOOP protocol.
 *
 * Assembles a multi-section system prompt addendum that steers the model
 * through explicit reasoning phases, reducing hallucinations by making each
 * phase's output checkable before proceeding to the next.
 *
 * Usage:
 *   const block = buildStructuredReasoningPrompt({ role: "analyst", goal: "..." });
 *   instructions = baseInstructions + "\n\n" + block;
 */

export interface CriticRubric {
  /** How to judge factual correctness. */
  accuracy?: string;
  /** How to judge whether the answer fully addresses the goal. */
  completeness?: string;
  /** How to judge adherence to the listed constraints. */
  constraints?: string;
}

export interface MemoryAnchorSpec {
  /** The fact to anchor (e.g. "User timezone is UTC+9"). */
  fact: string;
  /** When this fact should be recalled (e.g. "scheduling, date math"). */
  useFor: string;
  /** Duration string: "5m", "1h", "24h", "forever". Default: "1h". */
  ttl?: string;
  /** What to do when the anchor expires. Default: "expire". */
  evictionPolicy?: "lru" | "expire" | "manual";
}

export interface StructuredReasoningConfig {
  /** One-line description of the agent's persona. */
  role: string;
  /** What the agent must accomplish in this run. */
  goal: string;
  /** Hard constraints the model must not violate (injected verbatim). */
  constraints?: string[];

  // ── PLAN phase ───────────────────────────────────────────────────────────
  /** How many numbered plan steps to require. Default: 3. */
  planSteps?: number;
  /** Free-form note appended below the PLAN section. */
  planNote?: string;

  // ── ACT phase ────────────────────────────────────────────────────────────
  /** Free-form note appended below the ACT section. */
  actNote?: string;

  // ── VERIFY phase ─────────────────────────────────────────────────────────
  /** Specific tests the model must assert pass. */
  verifyTests?: string[];
  /** Free-form note appended below the VERIFY section. */
  verifyNote?: string;

  // ── CRITIC LOOP ──────────────────────────────────────────────────────────
  /** Max critic-loop passes before forcing acceptance. Default: 2. */
  maxCriticLoops?: number;
  /** Scoring rubric categories shown to the critic. */
  rubric?: CriticRubric;
  /** Condition under which the critic loop stops early. */
  stopCondition?: string;

  // ── Memory anchors ───────────────────────────────────────────────────────
  /** Key facts to pin verbatim into the prompt for recall. */
  anchors?: MemoryAnchorSpec[];

  // ── Output format ────────────────────────────────────────────────────────
  /** If true, wrap each phase in XML-like tags for easy parsing. Default: false. */
  taggedOutput?: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function section(title: string, body: string, tagged: boolean): string {
  if (tagged) return `<${title.toLowerCase().replace(/\s+/g, "_")}>\n${body}\n</${title.toLowerCase().replace(/\s+/g, "_")}>`;
  return `## ${title}\n${body}`;
}

function formatConstraints(constraints: string[]): string {
  return constraints.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
}

function formatRubric(rubric: CriticRubric): string {
  const lines: string[] = [];
  if (rubric.accuracy) lines.push(`  - Accuracy: ${rubric.accuracy}`);
  if (rubric.completeness) lines.push(`  - Completeness: ${rubric.completeness}`);
  if (rubric.constraints) lines.push(`  - Constraints: ${rubric.constraints}`);
  return lines.join("\n");
}

function formatAnchor(a: MemoryAnchorSpec, i: number): string {
  const ttl = a.ttl ?? "1h";
  const policy = a.evictionPolicy ?? "expire";
  return [
    `  [anchor_${i + 1}]`,
    `    fact: "${a.fact}"`,
    `    use_for: "${a.useFor}"`,
    `    ttl: "${ttl}"`,
    `    eviction_policy: "${policy}"`,
  ].join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the structured-reasoning addendum to append to an agent's system prompt.
 * Returns empty string if config is minimal (no-op fallback).
 */
export function buildStructuredReasoningPrompt(config: StructuredReasoningConfig): string {
  const {
    role,
    goal,
    constraints = [],
    planSteps = 3,
    planNote,
    actNote,
    verifyTests = [],
    verifyNote,
    maxCriticLoops = 2,
    rubric = {},
    stopCondition,
    anchors = [],
    taggedOutput = false,
  } = config;

  const t = taggedOutput;
  const parts: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  parts.push(`You are: ${role}`);
  parts.push(`Goal: ${goal}`);

  if (constraints.length > 0) {
    parts.push(section("Constraints", formatConstraints(constraints), t));
  }

  // ── Memory anchors ────────────────────────────────────────────────────────
  if (anchors.length > 0) {
    const anchorLines = anchors.map(formatAnchor).join("\n");
    parts.push(section("Memory Anchors", `The following facts are pinned. Reference them precisely as stated:\n${anchorLines}`, t));
  }

  // ── PLAN ──────────────────────────────────────────────────────────────────
  const planBody = [
    `Before acting, output a numbered plan with exactly ${planSteps} steps.`,
    `Each step must be one sentence. Do not start acting until the plan is complete.`,
    planNote ?? "",
  ].filter(Boolean).join("\n");
  parts.push(section("PLAN", planBody, t));

  // ── ACT ───────────────────────────────────────────────────────────────────
  const actBody = [
    "Execute your plan step by step, one step at a time.",
    "Use tools as needed. After each tool call, verify the result matches your expectation.",
    "If a step fails or returns unexpected data, revise the remaining plan before continuing.",
    actNote ?? "",
  ].filter(Boolean).join("\n");
  parts.push(section("ACT", actBody, t));

  // ── VERIFY ────────────────────────────────────────────────────────────────
  const verifyLines: string[] = [
    "After acting, verify your output against each of the following before finalizing:",
  ];
  if (verifyTests.length > 0) {
    verifyTests.forEach((test, i) => verifyLines.push(`  ${i + 1}. ${test}`));
  } else {
    verifyLines.push("  1. The output directly answers the stated goal.");
    verifyLines.push("  2. All constraints are satisfied.");
    verifyLines.push("  3. No steps were skipped.");
  }
  if (verifyNote) verifyLines.push(verifyNote);
  parts.push(section("VERIFY", verifyLines.join("\n"), t));

  // ── CRITIC LOOP ───────────────────────────────────────────────────────────
  const rubricHasEntries = rubric.accuracy || rubric.completeness || rubric.constraints;
  const criticLines: string[] = [
    `Run up to ${maxCriticLoops} critic passes:`,
    "  DRAFT   — your current answer",
    "  CRITIC  — score each rubric category 0–10 and list specific gaps",
    "  REVISE  — if any score < 8, produce an improved answer addressing the gaps",
    "  STOP    — if all scores ≥ 8 OR you have reached the pass limit",
  ];
  if (rubricHasEntries) {
    criticLines.push("Rubric:");
    criticLines.push(formatRubric(rubric));
  }
  if (stopCondition) {
    criticLines.push(`Early stop condition: ${stopCondition}`);
  }
  parts.push(section("CRITIC LOOP", criticLines.join("\n"), t));

  return parts.join("\n\n");
}

/**
 * Merge a structured-reasoning block into existing instructions.
 * Appends with a divider so the base instructions remain intact.
 */
export function mergeInstructions(base: string, block: string): string {
  if (!block) return base;
  return `${base}\n\n---\n\n${block}`;
}
