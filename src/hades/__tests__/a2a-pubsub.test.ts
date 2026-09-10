import { describe, it, expect } from "vitest";
import { InMemoryA2ATransport, AgentEndpoint } from "../a2a/bus";
import { PubSub, ALL_TOPICS } from "../a2a/pubsub";
import type { A2AMessage } from "../a2a/types";

function team(transport: InMemoryA2ATransport, ...ids: string[]) {
  return ids.map((id) => new AgentEndpoint({ agentId: id, team: "t1" }, transport, { idPrefix: id }));
}

describe("PubSub", () => {
  it("delivers a topic publish only to that topic's subscribers", () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob, carol] = team(t, "alice", "bob", "carol");
    const bobPS = new PubSub(bob);
    const carolPS = new PubSub(carol);

    const bobBuild: string[] = [];
    const carolDeploy: string[] = [];
    bobPS.subscribe("build:done", (m) => bobBuild.push((m.payload as { sha: string }).sha));
    carolPS.subscribe("deploy:done", (m) => carolDeploy.push((m.payload as { env: string }).env));

    new PubSub(alice).publish("build:done", { sha: "abc" }, { team: "t1" });
    expect(bobBuild).toEqual(["abc"]);
    expect(carolDeploy).toEqual([]); // different topic
  });

  it("ALL_TOPICS taps every topic (coordination firehose)", () => {
    const t = new InMemoryA2ATransport();
    const [alice, watcher] = team(t, "alice", "watcher");
    const seen: string[] = [];
    new PubSub(watcher).subscribe(ALL_TOPICS, (m: A2AMessage) => seen.push(m.topic ?? "?"));

    const alicePS = new PubSub(alice);
    alicePS.publish("a", {}, { team: "t1" });
    alicePS.publish("b", {}, { team: "t1" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("unsubscribe stops delivery and prunes the topic", () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob] = team(t, "alice", "bob");
    const ps = new PubSub(bob);
    let count = 0;
    const off = ps.subscribe("x", () => count++);
    const alicePS = new PubSub(alice);

    alicePS.publish("x", {}, { team: "t1" });
    off();
    alicePS.publish("x", {}, { team: "t1" });
    expect(count).toBe(1);
    expect(ps.topicsSubscribed()).toEqual([]);
  });

  it("supports multiple subscribers on one topic", () => {
    const t = new InMemoryA2ATransport();
    const [alice, bob] = team(t, "alice", "bob");
    const ps = new PubSub(bob);
    const hits: string[] = [];
    ps.subscribe("t", () => hits.push("h1"));
    ps.subscribe("t", () => hits.push("h2"));
    new PubSub(alice).publish("t", {}, { team: "t1" });
    expect(hits.sort()).toEqual(["h1", "h2"]);
  });
});
