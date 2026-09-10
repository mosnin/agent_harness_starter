import { satisfies, parseVersion, compareVersions } from "./manifest";
import type { ModuleManifest } from "./manifest";

export interface ResolveResult {
  ok: boolean;
  /** Chosen manifests in dependency-first load order. */
  order: ModuleManifest[];
  errors: string[];
}

/** Pick the highest available version of `name` satisfying every range. */
function pickVersion(candidates: ModuleManifest[], ranges: string[]): ModuleManifest | undefined {
  return candidates
    .filter((c) => ranges.every((r) => satisfies(c.version, r)))
    .sort((a, b) => -compareVersions(parseVersion(a.version)!, parseVersion(b.version)!))[0];
}

/**
 * Resolve a set of root modules against an available catalog: choose one version
 * per module satisfying **all** accumulated dependency ranges (highest wins),
 * report missing modules and unsatisfiable version conflicts, and return the
 * chosen set in **dependency-first topological order** (deps load before
 * dependents), detecting cycles. Constraints only tighten as dependents are
 * discovered, so the fixpoint is bounded.
 */
export function resolveModules(available: ModuleManifest[], roots: string[]): ResolveResult {
  const byName = new Map<string, ModuleManifest[]>();
  for (const m of available) {
    const arr = byName.get(m.name) ?? [];
    arr.push(m);
    byName.set(m.name, arr);
  }

  const errors: string[] = [];
  const constraints = new Map<string, Set<string>>();
  const chosen = new Map<string, ModuleManifest>();

  const addConstraint = (name: string, range: string) => {
    let set = constraints.get(name);
    if (!set) {
      set = new Set();
      constraints.set(name, set);
    }
    set.add(range);
  };

  const worklist: Array<{ name: string; range: string }> = roots.map((name) => ({ name, range: "*" }));
  let guard = 0;
  const maxIters = (available.length + roots.length) * 8 + 16;

  while (worklist.length && guard++ < maxIters) {
    const { name, range } = worklist.shift()!;
    addConstraint(name, range);
    const candidates = byName.get(name);
    if (!candidates || candidates.length === 0) {
      if (!errors.some((e) => e.includes(`missing module: ${name}`))) errors.push(`missing module: ${name}`);
      continue;
    }
    const ranges = [...constraints.get(name)!];
    const pick = pickVersion(candidates, ranges);
    if (!pick) {
      errors.push(`version conflict for ${name}: no version satisfies ${ranges.join(" && ")}`);
      continue;
    }
    const prev = chosen.get(name);
    if (prev && prev.version === pick.version) continue; // stable
    chosen.set(name, pick);
    for (const [dep, r] of Object.entries(pick.dependencies ?? {})) {
      worklist.push({ name: dep, range: r });
    }
  }

  if (errors.length) return { ok: false, order: [], errors };

  // Topological sort (Kahn) over chosen modules; edge dependency → dependent.
  const nodes = [...chosen.values()];
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const m of nodes) indeg.set(m.name, 0);
  for (const m of nodes) {
    for (const dep of Object.keys(m.dependencies ?? {})) {
      if (!chosen.has(dep)) continue;
      indeg.set(m.name, (indeg.get(m.name) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), m.name]);
    }
  }
  const queue = nodes.filter((m) => (indeg.get(m.name) ?? 0) === 0).map((m) => m.name).sort();
  const order: ModuleManifest[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    order.push(chosen.get(name)!);
    for (const d of (dependents.get(name) ?? []).sort()) {
      indeg.set(d, (indeg.get(d) ?? 0) - 1);
      if (indeg.get(d) === 0) queue.push(d);
    }
  }
  if (order.length !== nodes.length) {
    const cyc = nodes.filter((m) => !order.includes(m)).map((m) => m.name);
    return { ok: false, order: [], errors: [`dependency cycle among: ${cyc.sort().join(", ")}`] };
  }

  return { ok: true, order, errors: [] };
}
