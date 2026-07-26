import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport } from "../a2a/bus";
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";
import { Team, InProcessAgentSpawner } from "../teams/team";
import { BackendAgentSpawner } from "../teams/backend-spawner";
import { RemoteBackendRegistry } from "../backends/backend";
import { FakeBackend } from "../backends/fake-backend";

async function formShipTeam() {
  const roles = defaultRoleRegistry();
  const former = new TeamFormer(roles);
  const formed = await former.form(
    { objective: "ship", requiredCapabilities: ["code"], roleCounts: { coder: 2 } },
    "team1"
  );
  return { roles, formed };
}

describe("Team with InProcessAgentSpawner", () => {
  it("spawns every roster slot as an addressable A2A endpoint", async () => {
    const { roles, formed } = await formShipTeam();
    const transport = new InMemoryA2ATransport();
    const team = new Team(formed, new InProcessAgentSpawner(), transport, roles);

    const members = await team.spawn();
    expect(members.length).toBe(formed.roster.length);
    expect(team.byRole("coder")).toHaveLength(2);
    // Every member is connected to the shared transport.
    expect(transport.members().sort()).toEqual(formed.roster.map((s) => s.agentId).sort());

    // Two members can actually talk over A2A.
    const [coder0, coder1] = team.byRole("coder");
    void coder0.endpoint.emit(coder1.endpoint.address, { hi: true });
    const got = await coder1.endpoint.receive();
    expect(got.from.agentId).toBe(coder0.agentId);
  });

  it("spawn is idempotent and stop tears everything down", async () => {
    const { roles, formed } = await formShipTeam();
    const transport = new InMemoryA2ATransport();
    const team = new Team(formed, new InProcessAgentSpawner(), transport, roles);
    await team.spawn();
    const again = await team.spawn();
    expect(again.length).toBe(team.size());

    await team.stop();
    expect(team.size()).toBe(0);
    expect(transport.members()).toEqual([]);
  });
});

describe("Team with BackendAgentSpawner (containerized)", () => {
  it("provisions a worker per member and terminates on stop", async () => {
    const { roles, formed } = await formShipTeam();
    const transport = new InMemoryA2ATransport();
    const registry = new RemoteBackendRegistry();
    const backend = new FakeBackend({ name: "modal" });
    registry.register(backend);

    const spawner = new BackendAgentSpawner(registry, {
      backend: "modal",
      managerUrl: "http://mgr",
      authToken: "t",
      image: "hades:latest",
    });
    const team = new Team(formed, spawner, transport, roles);

    const members = await team.spawn();
    expect(members.length).toBe(formed.roster.length);
    // One remote worker provisioned per member.
    expect(registry.list().length).toBe(formed.roster.length);
    expect(members.every((m) => m.handle)).toBe(true);

    await team.stop();
    expect(registry.list().length).toBe(0); // all terminated
  });
});
