import { describe, it, expect, afterEach } from "vitest";
import { SwarmGateway, parseSlack, parseTelegram, parseDiscord } from "../gateway/gateway";
import { createInlineSwarm } from "../factory";
import type { SwarmManager } from "../manager/manager";

let swarm: SwarmManager | undefined;
afterEach(async () => {
  await swarm?.shutdown();
  swarm = undefined;
});

describe("platform parsers", () => {
  it("normalizes Slack, Telegram, and Discord payloads", () => {
    expect(parseSlack({ event: { user: "U1", text: "hi", channel: "C1" } })).toMatchObject({
      platform: "slack", user: "U1", text: "hi", channel: "C1",
    });
    expect(parseTelegram({ message: { from: { id: 42 }, chat: { id: 7 }, text: "hey" } })).toMatchObject({
      platform: "telegram", user: "42", channel: "7", text: "hey",
    });
    expect(parseDiscord({ author: { id: "D1" }, channel_id: "CH", content: "yo" })).toMatchObject({
      platform: "discord", user: "D1", channel: "CH", text: "yo",
    });
  });
});

describe("SwarmGateway", () => {
  it("launches a goal from a message and replies with the verified synthesis", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 2 });
    const gw = new SwarmGateway(swarm, { trigger: "/swarm", timeoutMs: 15_000 });

    const reply = await gw.handle({ platform: "slack", user: "U1", text: "/swarm analyze the repo" });
    expect(reply.accepted).toBe(true);
    expect(reply.status).toBe("completed");
    expect(reply.text).toContain("✅");
    expect(reply.goalId).toBeTruthy();
  });

  it("ignores messages missing the trigger", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 1 });
    const gw = new SwarmGateway(swarm, { trigger: "/swarm" });
    const reply = await gw.handle({ platform: "slack", user: "U1", text: "just chatting" });
    expect(reply.accepted).toBe(false);
    expect(reply.text).toBe("");
  });

  it("enforces the allowlist", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 1 });
    const gw = new SwarmGateway(swarm, { allowedUsers: ["boss"] });
    const reply = await gw.handle({ platform: "discord", user: "rando", text: "do stuff" });
    expect(reply.accepted).toBe(false);
    expect(reply.text).toContain("not authorized");
  });

  it("supports async (fire-and-forget) mode", async () => {
    swarm = await createInlineSwarm({ capabilities: ["research"], poolSize: 1 });
    const gw = new SwarmGateway(swarm, { awaitCompletion: false });
    const reply = await gw.handle({ platform: "cli", user: "u", text: "analyze" });
    expect(reply.accepted).toBe(true);
    expect(reply.status).toBe("running");
    expect(reply.text).toContain("started goal");
  });
});
