/**
 * Swarm hierarchy — Hades's signature mode. Instead of one manager driving a
 * flat pool, a **tree** of coordinators recursively decomposes a goal: the root
 * splits it among sub-coordinators, who split again, down to worker leaves that
 * execute — and results aggregate back up. Every level fans out in parallel, so
 * a branching factor B and depth D marshal B^D workers with only D hops of
 * coordination latency. This module is the tree model; the orchestrator runs it.
 */

export type NodeKind = "root" | "coordinator" | "worker";

export interface HierarchyNodeInfo {
  id: string;
  kind: NodeKind;
  /** 0 = root. */
  depth: number;
  /** Ids from root to this node. */
  path: string[];
  childIds: string[];
}

export interface HierarchyNode {
  info: HierarchyNodeInfo;
  children: HierarchyNode[];
}

export interface HierarchyStats {
  nodes: number;
  coordinators: number;
  workers: number;
  maxDepth: number;
  /** Widest single level = the peak parallel fan-out. */
  maxWidth: number;
}

/**
 * Build a balanced hierarchy: `coordinatorLevels` levels of coordinators under
 * the root, then a final level of `branching` workers per coordinator. Total
 * workers = branching^(coordinatorLevels+1). Deterministic ids (`n/0/2/...`).
 */
export function buildBalancedHierarchy(branching: number, coordinatorLevels: number, rootId = "n"): HierarchyNode {
  if (branching < 1) throw new Error("branching must be >= 1");
  if (coordinatorLevels < 0) throw new Error("coordinatorLevels must be >= 0");
  const workerDepth = coordinatorLevels + 1;

  const build = (id: string, depth: number, path: string[]): HierarchyNode => {
    const kind: NodeKind = depth === 0 ? "root" : depth >= workerDepth ? "worker" : "coordinator";
    const nodePath = [...path, id];
    if (kind === "worker") {
      return { info: { id, kind, depth, path: nodePath, childIds: [] }, children: [] };
    }
    const children: HierarchyNode[] = [];
    for (let i = 0; i < branching; i++) {
      children.push(build(`${id}/${i}`, depth + 1, nodePath));
    }
    return {
      info: { id, kind, depth, path: nodePath, childIds: children.map((c) => c.info.id) },
      children,
    };
  };

  return build(rootId, 0, []);
}

/** Walk the tree, calling `visit` on every node (pre-order). */
export function walk(node: HierarchyNode, visit: (node: HierarchyNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

export function hierarchyStats(root: HierarchyNode): HierarchyStats {
  let nodes = 0;
  let coordinators = 0;
  let workers = 0;
  let maxDepth = 0;
  const widthByDepth = new Map<number, number>();
  walk(root, (n) => {
    nodes++;
    if (n.info.kind === "worker") workers++;
    else coordinators++; // root counts as a coordinator level
    maxDepth = Math.max(maxDepth, n.info.depth);
    widthByDepth.set(n.info.depth, (widthByDepth.get(n.info.depth) ?? 0) + 1);
  });
  return { nodes, coordinators, workers, maxDepth, maxWidth: Math.max(...widthByDepth.values()) };
}
