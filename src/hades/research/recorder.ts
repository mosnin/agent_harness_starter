import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Trajectory } from "../learning/skill-forge";

/** One tool invocation inside a task. */
export interface ToolEvent {
  tool: string;
  ok: boolean;
  input?: unknown;
  output?: unknown;
  summary?: string;
  at: number;
}

/** A task's slice of a goal trajectory. */
export interface TaskTrajectory {
  taskId: string;
  description: string;
  capability?: string;
  tools: ToolEvent[];
  success: boolean;
  startedAt: number;
  endedAt?: number;
}

/** A full goal→task→tool→result trajectory, the training-data unit. */
export interface GoalTrajectory {
  goalId: string;
  objective: string;
  model?: string;
  tasks: TaskTrajectory[];
  success: boolean;
  startedAt: number;
  endedAt?: number;
}

/**
 * Records goal→task→tool→result trajectories as the swarm runs — the raw
 * material for research/training. Built incrementally (`beginGoal` →
 * `beginTask` → `recordTool` → `endTask` → `endGoal`) with an injectable clock,
 * so recordings are deterministic in tests. Completed goals are retained and can
 * be distilled to the lighter {@link Trajectory} that `SkillForge` consumes.
 */
export class TrajectoryRecorder {
  private active = new Map<string, GoalTrajectory>();
  private completed: GoalTrajectory[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  beginGoal(goalId: string, objective: string, model?: string): void {
    this.active.set(goalId, { goalId, objective, model, tasks: [], success: false, startedAt: this.now() });
  }

  beginTask(goalId: string, taskId: string, description: string, capability?: string): void {
    const goal = this.active.get(goalId);
    if (!goal) return;
    goal.tasks.push({ taskId, description, capability, tools: [], success: false, startedAt: this.now() });
  }

  recordTool(goalId: string, taskId: string, event: Omit<ToolEvent, "at">): void {
    const task = this.active.get(goalId)?.tasks.find((t) => t.taskId === taskId);
    if (!task) return;
    task.tools.push({ ...event, at: this.now() });
  }

  endTask(goalId: string, taskId: string, success: boolean): void {
    const task = this.active.get(goalId)?.tasks.find((t) => t.taskId === taskId);
    if (!task) return;
    task.success = success;
    task.endedAt = this.now();
  }

  /** Finalize a goal, move it to the completed set, and return it. */
  endGoal(goalId: string, success: boolean): GoalTrajectory | undefined {
    const goal = this.active.get(goalId);
    if (!goal) return undefined;
    goal.success = success;
    goal.endedAt = this.now();
    this.active.delete(goalId);
    this.completed.push(goal);
    return goal;
  }

  all(): GoalTrajectory[] {
    return [...this.completed];
  }
  size(): number {
    return this.completed.length;
  }
}

/** Flatten a recorded goal into the lighter trajectory `SkillForge` learns from. */
export function toSkillTrajectory(goal: GoalTrajectory): Trajectory {
  return {
    objective: goal.objective,
    success: goal.success,
    steps: goal.tasks.flatMap((task) =>
      task.tools.map((tool) => ({ tool: tool.tool, ok: tool.ok, summary: tool.summary ?? task.description }))
    ),
  };
}

/** Persisted trajectory store — atomic-write file backing for datasets. */
export class InMemoryTrajectoryStore {
  protected trajectories: GoalTrajectory[] = [];

  add(trajectory: GoalTrajectory): void {
    this.trajectories.push(trajectory);
    this.persist();
  }
  addAll(trajectories: GoalTrajectory[]): void {
    this.trajectories.push(...trajectories);
    this.persist();
  }
  all(): GoalTrajectory[] {
    return [...this.trajectories];
  }
  size(): number {
    return this.trajectories.length;
  }

  protected persist(): void {}
}

export class FileTrajectoryStore extends InMemoryTrajectoryStore {
  constructor(private readonly path: string) {
    super();
    try {
      this.trajectories = JSON.parse(readFileSync(path, "utf8")) as GoalTrajectory[];
    } catch {
      /* fresh */
    }
  }
  protected override persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* exists */
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.trajectories));
    renameSync(tmp, this.path);
  }
}
