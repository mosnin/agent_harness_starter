import type { GoalTrajectory } from "./recorder";

export interface CompressedStep {
  tool: string;
  ok: boolean;
  summary?: string;
  /** How many consecutive identical steps this represents (>=1). */
  repeat: number;
}

export interface CompressedTrajectory {
  objective: string;
  model?: string;
  success: boolean;
  steps: CompressedStep[];
  toolCounts: Record<string, number>;
  taskCount: number;
  /** True if steps were dropped by a `maxSteps` cap. */
  truncated: boolean;
}

export interface CompressOptions {
  /** Drop failed tool steps (keep only what worked). Default false. */
  dropFailed?: boolean;
  /** Collapse runs of the identical tool+ok into one step. Default true. */
  collapseDuplicates?: boolean;
  /** Keep at most this many steps (head + tail), dropping the middle. */
  maxSteps?: number;
}

/**
 * Compress a recorded trajectory into a compact training example. Flattens
 * tasks→tools, optionally drops failures, collapses consecutive duplicate tool
 * calls into a repeat-counted step, and caps length (head+tail) — shrinking a
 * verbose recording to the signal a model needs while keeping the objective,
 * outcome, and tool sequence. Pure and deterministic.
 */
export function compressTrajectory(goal: GoalTrajectory, opts: CompressOptions = {}): CompressedTrajectory {
  const collapse = opts.collapseDuplicates ?? true;

  let flat = goal.tasks.flatMap((task) =>
    task.tools.map((t) => ({ tool: t.tool, ok: t.ok, summary: t.summary }))
  );
  if (opts.dropFailed) flat = flat.filter((s) => s.ok);

  const toolCounts: Record<string, number> = {};
  for (const s of flat) toolCounts[s.tool] = (toolCounts[s.tool] ?? 0) + 1;

  // Collapse consecutive identical (tool, ok) pairs.
  const collapsed: CompressedStep[] = [];
  for (const s of flat) {
    const last = collapsed[collapsed.length - 1];
    if (collapse && last && last.tool === s.tool && last.ok === s.ok) {
      last.repeat++;
      if (!last.summary && s.summary) last.summary = s.summary;
    } else {
      collapsed.push({ tool: s.tool, ok: s.ok, summary: s.summary, repeat: 1 });
    }
  }

  // Cap length: keep head + tail, drop the middle.
  let steps = collapsed;
  let truncated = false;
  const cap = opts.maxSteps;
  if (cap != null && cap > 0 && collapsed.length > cap) {
    const head = Math.ceil(cap / 2);
    const tail = cap - head;
    steps = [...collapsed.slice(0, head), ...(tail > 0 ? collapsed.slice(-tail) : [])];
    truncated = true;
  }

  return {
    objective: goal.objective,
    model: goal.model,
    success: goal.success,
    steps,
    toolCounts,
    taskCount: goal.tasks.length,
    truncated,
  };
}

export interface TrainingExample {
  prompt: string;
  completion: string;
  success: boolean;
}

/** Render a compressed trajectory as a prompt/completion training pair. */
export function toTrainingExample(c: CompressedTrajectory): TrainingExample {
  const plan = c.steps
    .map((s, i) => {
      const rep = s.repeat > 1 ? ` (x${s.repeat})` : "";
      const mark = s.ok ? "" : " [failed]";
      const note = s.summary ? ` — ${s.summary}` : "";
      return `${i + 1}. ${s.tool}${rep}${mark}${note}`;
    })
    .join("\n");
  return {
    prompt: c.objective,
    completion: plan,
    success: c.success,
  };
}

/** Serialize training examples as JSONL (one JSON object per line). */
export function toJsonl(examples: TrainingExample[]): string {
  return examples.map((e) => JSON.stringify(e)).join("\n");
}
