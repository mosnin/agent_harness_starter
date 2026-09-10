import { describe, it, expect } from "vitest";
import { SkillTuner } from "../learning/skill-tuner";
import type { SwarmSkill } from "../../swarm-runtime/skills/skill";

const skill: SwarmSkill = { name: "research", description: "d", capabilities: ["web_search"], promptFragment: "search first" };

function feed(tuner: SkillTuner, name: string, successes: number, failures: number) {
  for (let i = 0; i < successes; i++) tuner.recordOutcome(name, true);
  for (let i = 0; i < failures; i++) tuner.recordOutcome(name, false);
}

describe("SkillTuner", () => {
  it("tracks success rate", () => {
    const t = new SkillTuner();
    feed(t, "research", 3, 1);
    expect(t.stats("research")?.uses).toBe(4);
    expect(t.stats("research")?.successRate).toBeCloseTo(0.75);
  });

  it("keeps a skill with too few uses", async () => {
    const t = new SkillTuner({ minUses: 5 });
    feed(t, "research", 2, 0);
    expect((await t.improve(skill)).action).toBe("kept");
  });

  it("recommends retiring a chronic under-performer", async () => {
    const t = new SkillTuner({ minUses: 5, retireBelow: 0.4 });
    feed(t, "research", 1, 9); // 10% success
    expect((await t.improve(skill)).action).toBe("retire");
  });

  it("annotates a high performer with its track record", async () => {
    const t = new SkillTuner({ minUses: 5, promoteAbove: 0.7 });
    feed(t, "research", 9, 1); // 90%
    const res = await t.improve(skill);
    expect(res.action).toBe("annotated");
    expect(res.skill.promptFragment).toContain("Track record");
    expect(res.skill.promptFragment).toContain("90%");
  });

  it("uses an injected refiner when provided", async () => {
    const t = new SkillTuner({
      minUses: 3,
      refiner: async (s, stats) => ({ ...s, description: `refined after ${stats.uses} uses` }),
    });
    feed(t, "research", 3, 2);
    const res = await t.improve(skill);
    expect(res.action).toBe("annotated");
    expect(res.skill.description).toContain("refined after 5 uses");
  });

  it("reports skills worst-first", () => {
    const t = new SkillTuner();
    feed(t, "good", 9, 1);
    feed(t, "bad", 1, 9);
    expect(t.report()[0].name).toBe("bad");
  });
});
