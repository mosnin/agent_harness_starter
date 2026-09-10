import { InMemoryA2ATransport } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";
import { Team, InProcessAgentSpawner } from "../teams/team";
import { TeamCoordinator } from "../teams/coordinator";
import { FanOutCoordinator } from "../parallel/fanout";
import { modelSpeedup } from "../parallel/speedup";

export interface TeamRunSummary {
  teamId: string;
  members: number;
  results: number[];
  byAgent: Record<string, number>;
  /** Modeled speedup of the parallel run vs serial, given per-task costs. */
  speedup: number;
}

/**
 * A runnable, dependency-free demo of the Hades v2 team stack: form a team for a
 * task, spawn its members in-process, have each member serve an A2A RPC handler,
 * then fan a batch of subtasks across the roster in parallel and aggregate. It
 * returns the results plus the modeled speedup — showing "form a team, work in
 * parallel, in a fraction of the time" end-to-end with no containers or network.
 */
export async function demoTeamParallel(): Promise<TeamRunSummary> {
  const roles = defaultRoleRegistry();
  const transport = new InMemoryA2ATransport();

  // 1) Form + spawn a team of coders.
  const formed = await new TeamFormer(roles).form(
    { objective: "process a batch in parallel", requiredCapabilities: ["code"], roleCounts: { coder: 4 } },
    "batch-team"
  );
  const team = new Team(formed, new InProcessAgentSpawner(), transport, roles);
  await team.spawn();

  // 2) Each coder serves an A2A RPC handler (square the number).
  const coders = team.byRole("coder");
  for (const coder of coders) {
    new RpcPeer(coder.endpoint).serve(async (payload) => {
      const { n } = payload as { n: number };
      return n * n;
    });
  }

  // 3) The coordinator fans 12 subtasks across the coders in parallel over A2A.
  const coord = new TeamCoordinator(team, transport);
  const rpc = new RpcPeer(coord.endpoint);
  const fan = new FanOutCoordinator<number, number>(
    coders.map((c) => c.agentId),
    async (agentId, n) => {
      const member = team.get(agentId)!;
      return rpc.request<number>(member.endpoint.address, { n });
    }
  );
  const items = Array.from({ length: 12 }, (_, i) => i + 1);
  const { results, byAgent } = await fan.map(items);

  // 4) Report the modeled speedup (equal-cost tasks across the roster).
  const speedup = modelSpeedup(items.map(() => 10), coders.length).speedup;

  coord.close();
  await team.stop();

  return { teamId: team.teamId, members: formed.roster.length, results, byAgent, speedup };
}
