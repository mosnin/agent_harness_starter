import type { SwarmSkill } from "../../swarm-runtime/skills/skill";

export interface SkillStats {
  name: string;
  uses: number;
  successes: number;
  failures: number;
  successRate: number;
  lastUsedAt?: number;
}

export type SkillRefiner = (
  skill: SwarmSkill,
  stats: SkillStats
) => Promise<SwarmSkill>;

export type TuneAction = "kept" | "annotated" | "retire";

export interface SkillTunerOptions {
  /** Min uses before a skill can be improved/retired. Default 5. */
  minUses?: number;
  /** Below this success rate, recommend retirement. Default 0.4. */
  retireBelow?: number;
  /** At/above this success rate, annotate as trusted. Default 0.7. */
  promoteAbove?: number;
  /** Optional LLM refiner for richer rewrites. */
  refiner?: SkillRefiner;
}

/**
 * Skill self-improvement — the "skills improve during use" half of the learning
 * loop. It records how each skill performs in the field and, once there's enough
 * signal, refines it: high performers get annotated as trusted, chronic
 * under-performers are flagged for retirement, and an optional LLM refiner can
 * rewrite the playbook from the observed failures. Skills earn their keep.
 */
export class SkillTuner {
  private readonly opts: Required<Omit<SkillTunerOptions, "refiner">> & Pick<SkillTunerOptions, "refiner">;
  private statsByName = new Map<string, SkillStats>();

  constructor(opts: SkillTunerOptions = {}) {
    this.opts = {
      minUses: opts.minUses ?? 5,
      retireBelow: opts.retireBelow ?? 0.4,
      promoteAbove: opts.promoteAbove ?? 0.7,
      refiner: opts.refiner,
    };
  }

  /** Record the outcome of using a skill. */
  recordOutcome(name: string, success: boolean, now = Date.now()): void {
    const st = this.statsByName.get(name) ?? { name, uses: 0, successes: 0, failures: 0, successRate: 0 };
    st.uses += 1;
    if (success) st.successes += 1;
    else st.failures += 1;
    st.successRate = st.successes / st.uses;
    st.lastUsedAt = now;
    this.statsByName.set(name, st);
  }

  stats(name: string): SkillStats | undefined {
    return this.statsByName.get(name);
  }

  /** All tracked skills, worst success-rate first (candidates for attention). */
  report(): SkillStats[] {
    return [...this.statsByName.values()].sort((a, b) => a.successRate - b.successRate);
  }

  /**
   * Improve a skill from its accumulated stats. Returns the (possibly rewritten)
   * skill and the action taken. `retire` means the caller should stop using it.
   */
  async improve(skill: SwarmSkill): Promise<{ skill: SwarmSkill; action: TuneAction }> {
    const st = this.statsByName.get(skill.name);
    if (!st || st.uses < this.opts.minUses) return { skill, action: "kept" };

    if (st.successRate < this.opts.retireBelow) {
      return { skill, action: "retire" };
    }

    if (this.opts.refiner) {
      const refined = await this.opts.refiner(skill, st);
      return { skill: refined, action: "annotated" };
    }

    if (st.successRate >= this.opts.promoteAbove) {
      const note = `\n[Track record: ${(st.successRate * 100).toFixed(0)}% success over ${st.uses} uses — trusted.]`;
      return {
        skill: { ...skill, promptFragment: `${skill.promptFragment ?? ""}${note}` },
        action: "annotated",
      };
    }

    return { skill, action: "kept" };
  }
}
