import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint, Mailbox } from "../a2a/bus";
import type { A2AMessage } from "../a2a/types";

function endpoints(transport: InMemoryA2ATransport, ...ids: Array<[string, string?]>) {
  return ids.map(([agentId, team], i) =>
    new AgentEndpoint({ agentId, team }, transport, { now: () => 100 + i, idPrefix: agentId })
  );
}

describe("Mailbox", () => {
  it("supports pull-style take() before and after delivery", async () => {
    const mb = new Mailbox();
    const msg = { id: "1" } as unknown as A2AMessage;
    // take() before delivery resolves when it arrives
    const pending = mb.take();
    mb.deliver(msg);
    expect(await pending).toBe(msg);
    // deliver before take() queues
    mb.deliver({ id: "2" } as unknown as A2AMessage);
    expect((await mb.take()).id).toBe("2");
  });

  it("routes to a listener when one is attached", () => {
    const mb = new Mailbox();
    const seen: string[] = [];
    mb.on((m) => seen.push(m.id));
    mb.deliver({ id: "a" } as unknown as A2AMessage);
    expect(seen).toEqual(["a"]);
    expect(mb.size()).toBe(0); // not queued while a listener is present
  });
});

describe("InMemoryA2ATransport + AgentEndpoint", () => {
  it("delivers a direct message to the addressed agent only", async () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob] = endpoints(t, ["alice"], ["bob"]);

    void alice.emit(bob.address, { hello: "bob" });
    const got = await bob.receive();
    expect(got.from.agentId).toBe("alice");
    expect((got.payload as { hello: string }).hello).toBe("bob");
    expect(bob.mailbox.size()).toBe(0);
  });

  it("delivers a broadcast to all others, never echoing to the sender", async () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob, carol] = endpoints(t, ["alice", "t1"], ["bob", "t1"], ["carol", "t1"]);

    const seen: string[] = [];
    bob.on((m) => seen.push(`bob:${(m.payload as { n: string }).n}`));
    carol.on((m) => seen.push(`carol:${(m.payload as { n: string }).n}`));
    let aliceGot = 0;
    alice.on(() => aliceGot++);

    void alice.broadcast({ n: "standup" }, { team: "t1" });
    expect(seen.sort()).toEqual(["bob:standup", "carol:standup"]);
    expect(aliceGot).toBe(0); // sender doesn't receive its own broadcast
  });

  it("scopes a team broadcast to that team", async () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob, carol] = endpoints(t, ["alice", "t1"], ["bob", "t1"], ["carol", "t2"]);
    const seen: string[] = [];
    bob.on((m) => seen.push(`bob`));
    carol.on((m) => seen.push(`carol`));
    void alice.broadcast({ x: 1 }, { team: "t1" });
    expect(seen).toEqual(["bob"]); // carol is in t2
  });

  it("stops delivering after close()", async () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob] = endpoints(t, ["alice"], ["bob"]);
    let count = 0;
    bob.on(() => count++);
    void alice.emit(bob.address, {});
    bob.close();
    void alice.emit(bob.address, {});
    expect(count).toBe(1);
    expect(t.members()).toEqual(["alice"]);
  });
});
