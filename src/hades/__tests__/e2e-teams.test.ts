import { describe, it, expect } from "vitest";
// A2A + security transports
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { RpcPeer } from "../a2a/rpc";
import { HmacSigner, SigningA2ATransport } from "../security/signing";
import { AuditLog, AuditingA2ATransport } from "../security/audit";
// Security scopes/tokens
import { CapabilityMinter, CapabilityChecker } from "../security/tokens";
import { LeastPrivilege } from "../security/scopes";
import { applySpawnPolicy } from "../security/spawn-policy";
// Teams
import { defaultRoleRegistry } from "../teams/role";
import { TeamFormer } from "../teams/former";
import { TeamRunner } from "../teams/lifecycle";
import { BackendAgentSpawner } from "../teams/backend-spawner";
import { TeamCoordinator } from "../teams/coordinator";
// Backends + parallel
import { RemoteBackendRegistry } from "../backends/backend";
import { FakeBackend } from "../backends/fake-backend";
import { mapReduce } from "../parallel/mapreduce";
import type { A2AMessage } from "../a2a/types";

/**
 * Full Hades v2 stack, end to end and secure: a task forms a containerized team
 * over a signed + audited A2A fabric, mints least-privilege tokens, runs parallel
 * work each member must be authorized for, aggregates the verified result, and
 * disbands — leaking nothing.
 */
describe("Hades v2 end-to-end", () => {
  it("forms a secure team, runs authorized parallel work, aggregates, and disbands", async () => {
    const secret = "team-secret";
    const audit = new AuditLog(() => 0);
    const inner = new InMemoryA2ATransport();
    const transport = new AuditingA2ATransport(new SigningA2ATransport(inner, new HmacSigner(secret)), audit);

    const roles = defaultRoleRegistry();
    const registry = new RemoteBackendRegistry();
    registry.register(new FakeBackend({ name: "modal" }));

    // Secure-by-default spawn limits (clamped, no network).
    const hardened = applySpawnPolicy({ maxCpus: 2, maxMemoryMb: 1024 }, { cpus: 1 });
    expect(hardened.limits.noNetwork).toBe(true);

    const spawner = new BackendAgentSpawner(registry, {
      backend: "modal",
      managerUrl: "m",
      authToken: "t",
      image: "hades:latest",
      limits: { cpus: hardened.limits.cpus, memory: hardened.limits.memory, timeoutMs: hardened.limits.timeoutMs },
    });
    const runner = new TeamRunner({ former: new TeamFormer(roles), spawner, transport, roles });

    const minter = new CapabilityMinter({ now: () => 0 });
    const checker = new CapabilityChecker({ now: () => 0 });
    const lp = new LeastPrivilege({ team: "e2e", allow: ["code"] }); // coders scoped to just "code"

    let authorizedCalls = 0;

    const aggregate = await runner.run(
      { objective: "square a batch", requiredCapabilities: ["code"], roleCounts: { coder: 3 } },
      async (team) => {
        // Mint least-privilege tokens for the roster.
        const tokens = lp.mintScopedTokens(
          minter,
          team.members().map((m) => ({ agentId: m.agentId, role: m.role, capabilities: roles.get(m.role)!.capabilities }))
        );
        expect(tokens.get(team.byRole("coder")[0].agentId)!.capabilities).toEqual(["code"]);

        // Each coder serves an A2A RPC, enforcing its capability token first.
        for (const coder of team.byRole("coder")) {
          const tok = tokens.get(coder.agentId)!;
          new RpcPeer(coder.endpoint).serve(async (payload) => {
            checker.assert(tok, "code"); // least-privilege enforcement
            authorizedCalls++;
            const { n } = payload as { n: number };
            return n * n;
          });
        }

        // Coordinator scatters the batch across the coders in parallel and reduces.
        const coord = new TeamCoordinator(team, transport);
        const coders = team.byRole("coder");
        const items = [1, 2, 3, 4, 5, 6];
        const { result } = await mapReduce(
          coders.map((c) => c.agentId),
          items,
          {
            map: async (agentId, n: number) => coord.request<number>(agentId, { n }),
            reduce: (acc, sq) => acc + sq,
            initial: 0,
          }
        );
        coord.close();
        return result;
      },
      "e2e"
    );

    // Verified aggregate: 1+4+9+16+25+36 = 91.
    expect(aggregate).toBe(91);
    expect(authorizedCalls).toBe(6);

    // Team disbanded cleanly — no leaked containers.
    expect(runner.state).toBe("disbanded");
    expect(registry.list().length).toBe(0);

    // The whole run is audited (A2A traffic recorded, conversation graph non-empty).
    expect(audit.ofType("a2a").length).toBeGreaterThan(0);
    expect(Object.keys(audit.conversationGraph()).length).toBeGreaterThan(0);
  });

  it("rejects a forged (unsigned/mis-signed) A2A message injected onto the bus", async () => {
    const inner = new InMemoryA2ATransport();
    const transport = new SigningA2ATransport(inner, new HmacSigner("real-secret"));
    const bob = new AgentEndpoint({ agentId: "bob", team: "e2e" }, transport, { idPrefix: "b" });
    let delivered = 0;
    bob.on(() => delivered++);

    // Attacker publishes straight onto the inner bus with a bogus signature.
    const forged: A2AMessage = {
      id: "evil-1",
      from: { agentId: "attacker", team: "e2e" },
      to: bob.address,
      kind: "request",
      payload: { command: "exfiltrate" },
      ts: 0,
      sig: "not-a-real-signature",
    };
    inner.publish(forged);
    expect(delivered).toBe(0); // dropped before reaching bob
  });
});
