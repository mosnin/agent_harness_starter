import { describe, it, expect } from "vitest";
import { AuditLog, AuditingA2ATransport } from "../security/audit";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";

describe("AuditLog", () => {
  it("records and queries typed events", () => {
    let t = 0;
    const log = new AuditLog(() => ++t);
    log.spawn("team1", "coder0", "modal");
    log.authorize("coder0", "deploy", false);
    log.terminate("team1", "coder0");

    expect(log.ofType("spawn")).toHaveLength(1);
    expect(log.ofType("authorize")[0].detail?.granted).toBe(false);
    expect(log.forTeam("team1").map((e) => e.type)).toEqual(["spawn", "terminate"]);
    expect(log.all()[0].at).toBe(1);
  });
});

describe("AuditingA2ATransport", () => {
  it("captures the who-talked-to-whom conversation graph", async () => {
    const log = new AuditLog(() => 0);
    const transport = new AuditingA2ATransport(new InMemoryA2ATransport(), log);
    const alice = new AgentEndpoint({ agentId: "alice", team: "t1" }, transport, { idPrefix: "a" });
    const bob = new AgentEndpoint({ agentId: "bob", team: "t1" }, transport, { idPrefix: "b" });

    void alice.emit(bob.address, { hi: 1 });
    void alice.emit(bob.address, { hi: 2 });
    void bob.emit(alice.address, { re: 1 });
    void alice.broadcast({ note: 1 }, { team: "t1" });

    const graph = log.conversationGraph();
    expect(graph["alice>bob"]).toBe(2);
    expect(graph["bob>alice"]).toBe(1);
    expect(graph["alice>broadcast"]).toBe(1);
  });

  it("records team + kind detail for each message", async () => {
    const log = new AuditLog(() => 0);
    const transport = new AuditingA2ATransport(new InMemoryA2ATransport(), log);
    const a = new AgentEndpoint({ agentId: "a", team: "t9" }, transport, { idPrefix: "a" });
    const b = new AgentEndpoint({ agentId: "b", team: "t9" }, transport, { idPrefix: "b" });
    void a.emit(b.address, {}, "coord");

    const ev = log.ofType("a2a")[0];
    expect(ev.team).toBe("t9");
    expect(ev.detail?.kind).toBe("event");
    expect(ev.detail?.topic).toBe("coord");
  });
});
