import { randomUUID } from "node:crypto";
import type { WorkerTask } from "../types";

export interface PlannedTask {
  description: string;
  requiredCapabilities: string[];
  input: Record<string, unknown>;
  /** Indices (into the returned array) of tasks this one depends on. */
  dependsOn?: number[];
  priority?: number;
}

/**
 * A planner turns a high-level objective into a dependency-ordered set of
 * worker tasks. Implementations range from deterministic (split by capability,
 * good for tests and offline) to LLM-backed (decompose with a model).
 */
export interface Planner {
  plan(objective: string, availableCapabilities: string[]): Promise<PlannedTask[]>;
}

/**
 * Deterministic fan-out planner. With no LLM available it produces a defensible
 * default plan: one research/gather task per available capability, then a final
 * synthesis task that depends on all of them. This keeps the whole runtime
 * exercisable — and CI green — without any API calls, and gives the LLM planner
 * a well-formed shape to imitate.
 */
export class DeterministicPlanner implements Planner {
  async plan(objective: string, capabilities: string[]): Promise<PlannedTask[]> {
    const caps = capabilities.length > 0 ? capabilities : ["general"];
    const tasks: PlannedTask[] = caps.map((cap, i) => ({
      description: `Investigate the objective from the "${cap}" angle: ${objective}`,
      requiredCapabilities: [cap],
      input: { objective, angle: cap },
      priority: 5,
      dependsOn: [],
    }));
    // Final synthesis depends on every prior task.
    tasks.push({
      description: `Synthesize a single grounded answer to: ${objective}`,
      requiredCapabilities: [caps[0]],
      input: { objective, mode: "synthesize" },
      dependsOn: tasks.map((_, i) => i),
      priority: 8,
    });
    return tasks;
  }
}

/**
 * LLM-backed planner. Delegates decomposition to a model via an injected
 * `complete` function (kept as a dependency so the runtime doesn't hard-bind to
 * any SDK). Falls back to the deterministic planner if the model output can't
 * be parsed — the swarm must always get *a* plan.
 */
export class LLMPlanner implements Planner {
  private readonly fallback = new DeterministicPlanner();

  constructor(
    private readonly complete: (prompt: string) => Promise<string>,
    private readonly maxTasks = 8
  ) {}

  async plan(objective: string, capabilities: string[]): Promise<PlannedTask[]> {
    const prompt = this.buildPrompt(objective, capabilities);
    try {
      const raw = await this.complete(prompt);
      const parsed = extractJson(raw);
      const tasks = this.coerce(parsed, capabilities);
      if (tasks.length === 0) throw new Error("empty plan");
      return tasks.slice(0, this.maxTasks);
    } catch {
      return this.fallback.plan(objective, capabilities);
    }
  }

  private buildPrompt(objective: string, capabilities: string[]): string {
    return [
      "You are the planning module of a multi-agent swarm.",
      "Decompose the OBJECTIVE into independent, verifiable worker tasks.",
      "Each task MUST be groundable in tool output (no tasks that require guessing).",
      `Available worker capabilities: ${capabilities.join(", ") || "general"}.`,
      "Return ONLY JSON: an array of",
      '{ "description": string, "requiredCapabilities": string[], "input": object, "dependsOn": number[], "priority": number }.',
      "dependsOn holds indices of earlier tasks that must finish first.",
      "Include exactly one final synthesis task depending on all others.",
      "",
      `OBJECTIVE: ${objective}`,
    ].join("\n");
  }

  private coerce(parsed: unknown, capabilities: string[]): PlannedTask[] {
    if (!Array.isArray(parsed)) return [];
    const capSet = new Set(capabilities.length ? capabilities : ["general"]);
    return parsed
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => {
        const req = Array.isArray(t.requiredCapabilities)
          ? (t.requiredCapabilities as unknown[]).map(String).filter((c) => capSet.has(c))
          : [];
        return {
          description: String(t.description ?? "unnamed task"),
          requiredCapabilities: req.length ? req : [[...capSet][0]],
          input: (t.input && typeof t.input === "object" ? t.input : {}) as Record<string, unknown>,
          dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(Number) : [],
          priority: typeof t.priority === "number" ? t.priority : 5,
        };
      });
  }
}

/** Materialize planned tasks into concrete WorkerTasks with real ids + deps. */
export function materializeTasks(planned: PlannedTask[], goalId: string, maxAttempts = 3): WorkerTask[] {
  const ids = planned.map(() => randomUUID());
  return planned.map((p, i) => ({
    id: ids[i],
    goalId,
    description: p.description,
    requiredCapabilities: p.requiredCapabilities,
    input: p.input,
    dependsOn: (p.dependsOn ?? []).filter((d) => d >= 0 && d < ids.length).map((d) => ids[d]),
    priority: p.priority ?? 5,
    status: "pending",
    attempts: 0,
    maxAttempts,
    createdAt: Date.now(),
  }));
}

// ── helpers ────────────────────────────────────────────────────────────────

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  return JSON.parse(trimmed);
}
