import { describe, it, expect, afterEach } from "vitest";
import { SkillRegistry, defineSkill, createSkilledExecutor, researchSkill } from "../skills/skill";
import { defineTool } from "../worker/toolbox";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

const research = researchSkill(async (q) => [{ title: "T", url: "u", snippet: `${q}: Paris.` }]);
const coding = defineSkill({
  name: "coding",
  description: "Write and run code.",
  capabilities: ["code"],
  tools: [defineTool("run_code", "run code", async (a) => `ran: ${String(a.code)}`)],
  promptFragment: "You are a careful engineer.",
});

describe("SkillRegistry", () => {
  it("resolves and merges skills into capabilities, tools, and prompts", () => {
    const reg = new SkillRegistry([research, coding]);
    const resolved = reg.resolve(["research", "coding"]);
    expect(resolved.capabilities.sort()).toEqual(["code", "research", "web_search"]);
    expect(resolved.toolbox.list().map((t) => t.name).sort()).toEqual(["run_code", "web_search"]);
    expect(resolved.promptFragments.length).toBe(2);
  });

  it("throws on an unknown skill", () => {
    expect(() => new SkillRegistry([research]).resolve(["nope"])).toThrow();
  });

  it("dedupes tools shared across skills", () => {
    const reg = new SkillRegistry([research, defineSkill({ ...research, name: "research2" })]);
    const resolved = reg.resolve(["research", "research2"]);
    expect(resolved.toolbox.list().filter((t) => t.name === "web_search").length).toBe(1);
  });
});

describe("skilled worker in a swarm", () => {
  let swarm: SwarmManager | undefined;
  afterEach(async () => {
    await swarm?.shutdown();
    swarm = undefined;
  });

  it("runs a swarm with a skilled, tool-grounded executor", async () => {
    const reg = new SkillRegistry([research]);
    const resolved = reg.resolve(["research"]);
    const executor = createSkilledExecutor(resolved, async (task, tools, _ctx, skillPrompt) => {
      expect(skillPrompt).toContain("researcher");
      const r = (await tools.call("web_search", { query: "capital of France" })) as Array<{ snippet: string }>;
      return { output: r[0].snippet };
    });

    swarm = await createInlineSwarm({ capabilities: resolved.capabilities, poolSize: 2, executor });
    const goal = await swarm.runGoal("Research the capital", { timeoutMs: 15_000 });
    expect(goal.status).toBe("completed");
  });
});
