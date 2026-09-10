import type { SwarmSkill } from "../../swarm-runtime/skills/skill";
import type { SkillRegistry } from "../../swarm-runtime/skills/skill";

export interface TrajectoryStep {
  tool: string;
  ok: boolean;
  /** Short description of what the step did (optional). */
  summary?: string;
}

/** A completed unit of work Hades can learn a reusable skill from. */
export interface Trajectory {
  objective: string;
  steps: TrajectoryStep[];
  success: boolean;
}

/** Injectable LLM synthesizer that turns a trajectory into a skill spec. */
export type SkillSynthesizer = (trajectory: Trajectory) => Promise<SwarmSkill | null>;

export interface SkillForgeOptions {
  synthesizer?: SkillSynthesizer;
  /** Minimum distinct successful tools before a trajectory is worth a skill. Default 1. */
  minTools?: number;
}

/**
 * Autonomous skill creation — the "creates skills from experience" half of the
 * learning loop. After a goal completes, the forge distills the trajectory into
 * a reusable playbook `SwarmSkill`: the capabilities/tools that worked and a
 * prompt fragment describing the approach, so the next similar task starts from
 * hard-won experience instead of scratch. Deterministic by default; an injected
 * LLM synthesizer can produce richer skills.
 */
export class SkillForge {
  constructor(private readonly opts: SkillForgeOptions = {}) {}

  /** Distill a trajectory into a skill, or null if it isn't worth one. */
  async forge(trajectory: Trajectory): Promise<SwarmSkill | null> {
    if (this.opts.synthesizer) {
      try {
        return await this.opts.synthesizer(trajectory);
      } catch {
        return this.forgeOffline(trajectory);
      }
    }
    return this.forgeOffline(trajectory);
  }

  /** Forge and, if successful, register the skill so it's usable immediately. */
  async forgeAndRegister(trajectory: Trajectory, registry: SkillRegistry): Promise<SwarmSkill | null> {
    const skill = await this.forge(trajectory);
    if (skill) registry.register(skill);
    return skill;
  }

  private forgeOffline(trajectory: Trajectory): SwarmSkill | null {
    if (!trajectory.success) return null;
    const toolsUsed = [...new Set(trajectory.steps.filter((s) => s.ok).map((s) => s.tool))];
    if (toolsUsed.length < (this.opts.minTools ?? 1)) return null;

    const name = slugifyObjective(trajectory.objective);
    const playbook = trajectory.steps
      .filter((s) => s.ok)
      .map((s, i) => `${i + 1}. ${s.tool}${s.summary ? ` — ${s.summary}` : ""}`)
      .join("\n");

    return {
      name,
      description: `Learned playbook for tasks like: "${truncate(trajectory.objective, 80)}".`,
      capabilities: [name, ...toolsUsed],
      // Capabilities-only (a playbook): tool implementations come from the
      // worker's ToolBox; the skill encodes the *approach* that worked.
      promptFragment:
        `You have prior experience with tasks like "${truncate(trajectory.objective, 80)}". ` +
        `A known-good approach uses these tools: ${toolsUsed.join(", ")}.` +
        (playbook ? `\nSteps that worked:\n${playbook}` : ""),
    };
  }
}

/** Turn an objective into a stable, kebab-case skill name. */
export function slugifyObjective(objective: string): string {
  const slug = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 4)
    .join("-");
  return slug ? `learned-${slug}` : "learned-skill";
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "your", "our"]);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
