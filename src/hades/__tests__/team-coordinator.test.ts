import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";
import { PubSub } from "../a2a/pubsub";
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";
import { Team, InProcessAgentSpawner } from "../teams/team";
import { TeamCoordinator } from "../teams/coordinator";

async function spawnTeam() {
  const roles = defaultRoleRegistry();
  const transport = new InMemoryA2ATransport();
  const formed = await new TeamFormer(roles).form(
    { objective: "parallel build", requiredCapabilities: ["code"], roleCounts: { coder: 3 } },
    "team1"
  );
  const team = new Team(formed, new InProcessAgentSpawner(), transport, roles);
  await team.spawn();
  return { roles, transport, team };
}

describe("TeamCoordinator", () => {
  it("requests a member over RPC and gets a response", async () => {
    const { transport, team } = await spawnTeam();
    const coder0 = team.byRole("coder")[0];
    // The member serves RPC on its own endpoint.
    new RpcPeer(coder0.endpoint).serve(async (payload) => {
      const { x } = payload as { x: number };
      return { doubled: x * 2 };
    });

    const coord = new TeamCoordinator(team, transport);
    const res = await coord.request<{ doubled: number }>(coder0.agentId, { x: 21 });
    expect(res.doubled).toBe(42);
    coord.close();
  });

  it("announces a topic to the whole team", async () => {
    const { transport, team } = await spawnTeam();
    const seen: string[] = [];
    // Each coder subscribes to the "work" topic via its own PubSub.
    for (const coder of team.byRole("coder")) {
      new PubSub(coder.endpoint).subscribe("work", (m) => seen.push((m.payload as { id: string }).id));
    }
    const coord = new TeamCoordinator(team, transport);
    await coord.announce("work", { id: "task-1" });
    expect(seen.filter((s) => s === "task-1").length).toBe(team.byRole("coder").length);
    coord.close();
  });

  it("sends a direct directive to one member only", async () => {
    const { transport, team } = await spawnTeam();
    const [c0, c1] = team.byRole("coder");
    let c0got = 0;
    let c1got = 0;
    c0.endpoint.on(() => c0got++);
    c1.endpoint.on(() => c1got++);
    const coord = new TeamCoordinator(team, transport);
    await coord.direct(c0.agentId, { go: true });
    expect(c0got).toBe(1);
    expect(c1got).toBe(0);
    coord.close();
  });

  it("throws for an unknown member", async () => {
    const { transport, team } = await spawnTeam();
    const coord = new TeamCoordinator(team, transport);
    await expect(coord.request("ghost", {})).rejects.toThrow(/No such member/);
    coord.close();
  });
});
