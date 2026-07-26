/**
 * A role an agent can play on a team. The capabilities route tasks to it; the
 * skills (names into a `SkillRegistry`) and prompt fragment specialize it. This
 * is the "team-native" piece Hermes has that a flat worker pool didn't.
 */
export interface AgentRole {
  name: string;
  capabilities: string[];
  description?: string;
  /** Skill names granted to an agent in this role. */
  skills?: string[];
  promptFragment?: string;
}

/** Registry of roles a team can be composed from. */
export class RoleRegistry {
  private roles = new Map<string, AgentRole>();

  constructor(roles: AgentRole[] = []) {
    for (const r of roles) this.register(r);
  }

  register(role: AgentRole): this {
    this.roles.set(role.name, role);
    return this;
  }
  get(name: string): AgentRole | undefined {
    return this.roles.get(name);
  }
  has(name: string): boolean {
    return this.roles.has(name);
  }
  list(): AgentRole[] {
    return [...this.roles.values()];
  }
  /** Roles whose capabilities include the given capability. */
  withCapability(capability: string): AgentRole[] {
    return this.list().filter((r) => r.capabilities.includes(capability));
  }
}

/** The built-in role catalog — a sensible default team vocabulary. */
export function defaultRoleRegistry(): RoleRegistry {
  return new RoleRegistry([
    {
      name: "planner",
      capabilities: ["plan", "decompose"],
      description: "Decomposes the objective into parallel work",
      promptFragment: "Break the objective into independent tasks that can run in parallel; assign each to a role.",
    },
    {
      name: "researcher",
      capabilities: ["search", "browse", "summarize"],
      description: "Gathers and synthesizes information",
      skills: ["literature-search", "synthesis"],
      promptFragment: "Gather from primary sources, note dates, and cite every non-obvious claim.",
    },
    {
      name: "coder",
      capabilities: ["code", "edit", "build"],
      description: "Implements changes",
      promptFragment: "Write code that matches the surrounding style; keep changes focused and testable.",
    },
    {
      name: "reviewer",
      capabilities: ["review", "verify"],
      description: "Checks correctness and quality",
      promptFragment: "Review for correctness first, then simplification; flag anything unverified.",
    },
    {
      name: "tester",
      capabilities: ["test", "verify"],
      description: "Writes and runs tests",
      promptFragment: "Cover the failure modes, not just the happy path; assert on observable behavior.",
    },
  ]);
}
