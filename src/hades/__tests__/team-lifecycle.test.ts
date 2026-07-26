import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport } from "../a2a/bus";
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";
import { InProcessAgentSpawner } from "../teams/team";
import type { AgentSpawner, SpawnedAgent } from "../teams/team";
import { TeamRunner } from "../teams/lifecycle";
import type { TeamState } from "../teams/lifecycle";

function deps(spawner?: AgentSpawner) {
  const roles = defaultRoleRegistry();
  const states: TeamState[] = [];
  return {
    states,
    runner: new TeamRunner({
      former: new TeamFormer(roles),
      spawner: spawner ?? new InProcessAgentSpawner(),
      transport: new InMemoryA2ATransport(),
      roles,
      onState: (s) => states.push(s),
    }),
  };
}

const task = { objective: "ship it", requiredCapabilities: ["code"] };

describe("TeamRunner", () => {
  it("forms → works → disbands on success", async () => {
    const { runner, states } = deps();
    let sawTeamSize = 0;
    const out = await runner.run(task, async (team) => {
      sawTeamSize = team.size();
      return "done";
    });
    expect(out).toBe("done");
    expect(sawTeamSize).toBeGreaterThan(0);
    expect(states).toEqual(["forming", "ready", "working", "disbanded"]);
    expect(runner.state).toBe("disbanded");
  });

  it("tears down and ends failed when work throws", async () => {
    const { runner, states } = deps();
    await expect(
      runner.run(task, async () => {
        throw new Error("work exploded");
      })
    ).rejects.toThrow("work exploded");
    expect(runner.state).toBe("failed");
    expect(runner.lastError?.message).toBe("work exploded");
    expect(states).toContain("failed");
  });

  it("always stops every spawned agent, even on failure", async () => {
    const stopped: string[] = [];
    const base = new InProcessAgentSpawner();
    const tracking: AgentSpawner = {
      spawn: (ctx) => base.spawn(ctx),
      stop: async (a: SpawnedAgent) => {
        stopped.push(a.agentId);
        await base.stop(a);
      },
    };
    const { runner } = deps(tracking);
    await runner
      .run(task, async (team) => {
        expect(team.size()).toBeGreaterThan(0);
        throw new Error("boom");
      })
      .catch(() => undefined);
    expect(stopped.length).toBeGreaterThan(0); // teardown ran despite the throw
  });
});
