import { describe, it, expect } from "vitest";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";
// Gateway
import { ConnectorHub } from "../gateway/connector";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import { RateLimiter } from "../gateway/rate-limiter";
import { InMemoryIdentityStore, ContinuityRouter } from "../gateway/continuity";
// Backends
import { RemoteBackendRegistry } from "../backends/backend";
import { FakeBackend } from "../backends/fake-backend";
import { ScaleToZeroManager } from "../backends/scale-to-zero";
// Learning + research
import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";
import { TrajectoryRecorder, InMemoryTrajectoryStore } from "../research/recorder";
// REPL
import { ConversationalAgent } from "../repl/agent";
import type { ConversationBrain } from "../repl/agent";
import type { ReplIO } from "../repl/core";

/**
 * End-to-end: a message arrives on a channel, is routed to a handler that
 * provisions a worker on a remote backend and records a trajectory, replies
 * through the gateway, and later scales the worker to zero and back — while a
 * separate REPL exercises the learning loop and cross-platform continuity.
 */
describe("Hades end-to-end", () => {
  it("gateway → remote backend → trajectory, then scale-to-zero and wake", async () => {
    let clock = 0;
    const registry = new RemoteBackendRegistry();
    registry.register(new FakeBackend({ name: "modal", now: () => clock }));
    const scaler = new ScaleToZeroManager(registry, { idleMs: 1000, now: () => clock });

    const recorder = new TrajectoryRecorder(() => ++clock);
    const dataset = new InMemoryTrajectoryStore();

    let goalSeq = 0;
    // The handler = a mini "manager": ensure a worker, run one goal, record it.
    const handler = async (msg: InboundMessage): Promise<OutboundReply> => {
      const workerId = `w-${msg.user}`;
      if (!registry.handle(workerId)) await registry.provision({ workerId, capabilities: ["chat"], managerUrl: "m", authToken: "t" }, "modal");
      await scaler.acquire(workerId);

      const goalId = `g${++goalSeq}`;
      recorder.beginGoal(goalId, msg.text);
      recorder.beginTask(goalId, `${goalId}-t`, "handle message");
      recorder.recordTool(goalId, `${goalId}-t`, { tool: "respond", ok: true });
      recorder.endTask(goalId, `${goalId}-t`, true);
      const traj = recorder.endGoal(goalId, true)!;
      dataset.add(traj);

      return { text: `handled: ${msg.text}`, accepted: true };
    };

    const hub = new ConnectorHub(handler, { rateLimiter: new RateLimiter({ capacity: 5, refillMs: 1000, now: () => clock * 1000 }) });
    const chat = new InMemoryConnector("telegram");
    hub.register(chat);
    await hub.startAll();

    // Inbound message → routed → backend provisioned → reply delivered.
    const reply = await chat.receive({ user: "u1", text: "summarize the news" });
    expect(reply.text).toBe("handled: summarize the news");
    expect(chat.sent.at(-1)?.text).toBe("handled: summarize the news");
    expect(registry.handle("w-u1")?.state).toBe("running");
    expect(dataset.size()).toBe(1);
    expect(dataset.all()[0].objective).toBe("summarize the news");

    // Worker goes idle → swept to zero.
    clock = 5000;
    const hibernated = await scaler.sweep();
    expect(hibernated).toEqual(["w-u1"]);
    expect(await registry.status("w-u1")).toBe("hibernated");

    // A second message wakes it and records another trajectory.
    await chat.receive({ user: "u1", text: "follow up" });
    expect(await registry.status("w-u1")).toBe("running");
    expect(dataset.size()).toBe(2);

    await hub.stopAll();
  });

  it("learning loop remembers a fact and continuity unifies channels", async () => {
    const memory = new InMemoryMemoryStore();
    const sessions = new InMemorySessionStore();

    const brain: ConversationBrain = async (ctx, stream) => {
      const known = ctx.memories.map((m) => m.fact).join("; ");
      const reply = known ? `known: ${known}` : `noted: ${ctx.input}`;
      stream(reply);
      return reply;
    };
    const agent = new ConversationalAgent({ brain, memory, sessions });
    const io: ReplIO = { write: () => {}, writeLine: () => {} };
    const repl = agent.repl(io);

    await repl.feedLine("/remember I prefer dark mode");
    const res = await repl.feedLine("what UI theme?");
    expect(res.result).toContain("I prefer dark mode"); // memory retrieved into the turn

    // Cross-platform continuity: telegram + slack resolve to one identity/session.
    const identities = new InMemoryIdentityStore();
    const tg = identities.resolveOrCreate({ platform: "telegram", user: "111" });
    identities.link(tg.id, { platform: "slack", user: "U9" });

    const seenSessions = new Set<string>();
    const router = new ContinuityRouter(
      identities,
      async (_m, ctx) => {
        seenSessions.add(ctx.sessionId);
        return { text: "ok", accepted: true };
      },
      { newSessionId: () => "shared-session" }
    );
    await router.handle({ platform: "telegram", user: "111", text: "hi" });
    await router.handle({ platform: "slack", user: "U9", text: "still me" });
    expect(seenSessions.size).toBe(1); // one conversation across two channels
  });
});
