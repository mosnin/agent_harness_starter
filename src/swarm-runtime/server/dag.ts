import type { WorkerTask, WorkerTaskStatus } from "../types";

export interface DagNode {
  id: string;
  label: string;
  status: WorkerTaskStatus;
  /** Topological depth (0 = no dependencies). */
  level: number;
  consensus?: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Node ids grouped by level, for column/row rendering. */
  levels: string[][];
}

/**
 * Compute a renderable layout for a goal's task DAG: each task's topological
 * depth (longest dependency chain to a root), plus the edges. Pure and
 * cycle-safe, so the dashboard can draw the plan and the manager's tests can
 * assert the structure without a browser.
 */
export function computeDagLayout(tasks: WorkerTask[]): DagLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const levelCache = new Map<string, number>();
  const visiting = new Set<string>();

  const levelOf = (id: string): number => {
    if (levelCache.has(id)) return levelCache.get(id)!;
    if (visiting.has(id)) return 0; // break cycles defensively
    visiting.add(id);
    const task = byId.get(id);
    const deps = (task?.dependsOn ?? []).filter((d) => byId.has(d));
    const level = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(levelOf));
    visiting.delete(id);
    levelCache.set(id, level);
    return level;
  };

  const nodes: DagNode[] = tasks.map((t) => ({
    id: t.id,
    label: t.description,
    status: t.status,
    level: levelOf(t.id),
    consensus: t.consensus?.replicas,
  }));

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (byId.has(dep)) edges.push({ from: dep, to: t.id });
    }
  }

  const maxLevel = nodes.reduce((m, n) => Math.max(m, n.level), 0);
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of nodes) levels[n.level].push(n.id);

  return { nodes, edges, levels };
}
