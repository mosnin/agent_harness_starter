import type { RoleRegistry } from "./role";
import { validateBlueprint, expandRoster } from "./blueprint";
import type { TeamBlueprint, RosterSlot } from "./blueprint";

/** A task to assemble a team for. */
export interface TaskSpec {
  objective: string;
  /** Capabilities the work needs; each maps to a role. */
  requiredCapabilities?: string[];
  /** Desired agent count per role (overrides the default of 1). */
  roleCounts?: Record<string, number>;
  /** Hard cap on total team size. */
  maxAgents?: number;
}

/** Injectable decomposer (LLM-driven team design). Overrides the heuristic. */
export type Decomposer = (task: TaskSpec, registry: RoleRegistry) => TeamBlueprint | Promise<TeamBlueprint>;

export interface TeamFormerOptions {
  decompose?: Decomposer;
  /** Always add a planner (default true) and reviewer (default true). */
  includePlanner?: boolean;
  includeReviewer?: boolean;
}

export interface FormedTeam {
  teamId: string;
  blueprint: TeamBlueprint;
  roster: RosterSlot[];
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

/**
 * Turns a task into a concrete team. An injectable `decompose` (LLM) can design
 * the blueprint; otherwise the offline heuristic maps each required capability to
 * a role (always bracketing the work with a planner and a reviewer), applies any
 * per-role count overrides, validates against the registry, and expands to a
 * namespaced roster. This is what lets Hades "form the right team around a task"
 * on demand.
 */
export class TeamFormer {
  constructor(
    private readonly registry: RoleRegistry,
    private readonly opts: TeamFormerOptions = {}
  ) {}

  async form(task: TaskSpec, teamId = slugify(task.objective)): Promise<FormedTeam> {
    const blueprint = this.opts.decompose
      ? await this.opts.decompose(task, this.registry)
      : this.heuristic(task);
    const validation = validateBlueprint(blueprint, this.registry);
    if (!validation.ok) {
      throw new Error(`Cannot form team "${blueprint.name}": ${validation.errors.join("; ")}`);
    }
    return { teamId, blueprint, roster: expandRoster(blueprint, teamId) };
  }

  private heuristic(task: TaskSpec): TeamBlueprint {
    const roles = new Map<string, number>();
    if (this.opts.includePlanner ?? true) roles.set("planner", 1);

    for (const cap of task.requiredCapabilities ?? []) {
      const role = this.registry.withCapability(cap)[0];
      if (role && !roles.has(role.name)) roles.set(role.name, 1);
    }
    // If no capability mapped to a working role, add a coder as the default worker.
    const working = [...roles.keys()].filter((r) => r !== "planner");
    if (working.length === 0 && this.registry.has("coder")) roles.set("coder", 1);

    if ((this.opts.includeReviewer ?? true) && this.registry.has("reviewer")) {
      if (!roles.has("reviewer")) roles.set("reviewer", 1);
    }

    // Apply explicit per-role count overrides.
    for (const [role, count] of Object.entries(task.roleCounts ?? {})) {
      if (roles.has(role) || this.registry.has(role)) roles.set(role, count);
    }

    return {
      name: slugify(task.objective),
      description: task.objective,
      requirements: [...roles.entries()].map(([role, count]) => ({ role, count })),
      maxAgents: task.maxAgents,
    };
  }
}
