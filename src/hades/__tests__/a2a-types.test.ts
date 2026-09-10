import { describe, it, expect } from "vitest";
import { MessageFactory, deliversTo, isBroadcast, sameAddress } from "../a2a/types";
import type { AgentAddress } from "../a2a/types";

const alice: AgentAddress = { agentId: "alice", role: "researcher", team: "t1" };
const bob: AgentAddress = { agentId: "bob", role: "coder", team: "t1" };
const carol: AgentAddress = { agentId: "carol", role: "coder", team: "t2" };

describe("A2A addressing", () => {
  it("delivers direct messages only to the addressed agent", () => {
    expect(deliversTo(bob, bob)).toBe(true);
    expect(deliversTo(bob, alice)).toBe(false);
  });

  it("delivers broadcasts to everyone, scoped by team when set", () => {
    expect(deliversTo({ broadcast: true }, alice)).toBe(true);
    expect(deliversTo({ broadcast: true, team: "t1" }, bob)).toBe(true);
    expect(deliversTo({ broadcast: true, team: "t1" }, carol)).toBe(false); // wrong team
  });

  it("identifies addresses and broadcasts", () => {
    expect(sameAddress(alice, { agentId: "alice" })).toBe(true);
    expect(isBroadcast({ broadcast: true })).toBe(true);
    expect(isBroadcast(bob)).toBe(false);
  });
});

describe("MessageFactory", () => {
  it("stamps deterministic ids + clock and builds each envelope kind", () => {
    let t = 1000;
    const f = new MessageFactory(alice, { now: () => t++, idPrefix: "m" });

    const ev = f.event(bob, { hi: true }, "greetings");
    expect(ev).toMatchObject({ id: "m-1", from: alice, to: bob, kind: "event", topic: "greetings", ts: 1000 });

    const req = f.request(bob, { q: "status?" });
    expect(req.kind).toBe("request");
    expect(req.correlationId).toBe(req.id); // request seeds its own correlation id
    expect(req.id).toBe("m-2");

    const res = f.respond(alice, req.correlationId!, { a: "ok" });
    expect(res).toMatchObject({ kind: "response", to: alice, correlationId: req.correlationId });
  });

  it("builds team-scoped broadcasts", () => {
    const f = new MessageFactory(alice, { now: () => 5 });
    const bc = f.broadcast({ note: "standup" }, { team: "t1", topic: "coord" });
    expect(isBroadcast(bc.to)).toBe(true);
    expect(bc.topic).toBe("coord");
    expect(deliversTo(bc.to, bob)).toBe(true);
    expect(deliversTo(bc.to, carol)).toBe(false);
  });
});
