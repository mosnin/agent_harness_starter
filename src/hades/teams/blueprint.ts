import type { RoleRegistry } from "./role";

/** How many agents of a role a team wants (a fixed count or a bounded range). */
export interface RoleRequirement {
  role: string;
  /** Exact count, or a min/max range the former resolves within. */
  count: number;
  min?: number;
  max?: number;
}

/** A recipe for a team: which roles, how many, and an overall cap. */
export interface TeamBlueprint {
  name: string;
  description?: string;
  requirements: RoleRequirement[];
  /** Hard ceiling on total agents (defense against runaway spawning). */
  maxAgents?: number;
}

/** Total agents a blueprint asks for at its nominal `count`s. */
export function blueprintSize(bp: TeamBlueprint): number {
  return bp.requirements.reduce((n, r) => n + Math.max(0, r.count), 0);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a blueprint against a role registry: every required role must exist,
 * counts must be positive and within any declared min/max, and the total must
 * not exceed `maxAgents`. Pure — no spawning.
 */
export function validateBlueprint(bp: TeamBlueprint, registry: RoleRegistry): ValidationResult {
  const errors: string[] = [];
  if (!bp.requirements.length) errors.push("blueprint has no role requirements");
  for (const req of bp.requirements) {
    if (!registry.has(req.role)) errors.push(`unknown role: ${req.role}`);
    if (req.count < 1) errors.push(`role ${req.role} must request at least 1 agent`);
    if (req.min != null && req.count < req.min) errors.push(`role ${req.role} count ${req.count} below min ${req.min}`);
    if (req.max != null && req.count > req.max) errors.push(`role ${req.role} count ${req.count} above max ${req.max}`);
  }
  const size = blueprintSize(bp);
  if (bp.maxAgents != null && size > bp.maxAgents) {
    errors.push(`team size ${size} exceeds maxAgents ${bp.maxAgents}`);
  }
  return { ok: errors.length === 0, errors };
}

/** A concrete assignment produced from a blueprint: one entry per agent slot. */
export interface RosterSlot {
  agentId: string;
  role: string;
}

/**
 * Expand a validated blueprint into a concrete roster of `{ agentId, role }`
 * slots, ids namespaced by team + role + index. Pure and deterministic.
 */
export function expandRoster(bp: TeamBlueprint, teamId: string): RosterSlot[] {
  const slots: RosterSlot[] = [];
  for (const req of bp.requirements) {
    for (let i = 0; i < req.count; i++) {
      slots.push({ agentId: `${teamId}.${req.role}.${i}`, role: req.role });
    }
  }
  return slots;
}
