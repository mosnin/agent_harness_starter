import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  AgentGatewayHandler,
  echoEngine,
  swarmEngine,
  type AgentTurn,
  type AgentTurnResult,
  type GatewayAgentEngine,
} from "../gateway/agent-handler";
import type { ContinuityContext, Identity } from "../gateway/continuity";
import type { InboundMessage, OutboundReply, GatewayManager } from "../../swarm-runtime/gateway/gateway";
import type { Goal } from "../../swarm-runtime/types";
import type { BadgeEvidence } from "../gateway/badge";
import { CertificateAuthority, generatePrivateKeyHex } from "../styx/certificate";
import type { GateDecision } from "../styx/gate";

function inbound(platform: string, user: string, text: string, channel?: string): InboundMessage {
  return { platform: platform as InboundMessage["platform"], user, channel, text };
}

function makeIdentity(id: string, overrides: Partial<Identity> = {}): Identity {
  return { id, links: [{ platform: "telegram", user: id }], updatedAt: 0, ...overrides };
}

function ctxFor(sessionId: string, identity: Identity, switchedChannel = false): ContinuityContext {
  return { identity, sessionId, switchedChannel };
}

/** A "deferred" — lets a test control exactly when an engine call resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// echoEngine
// ---------------------------------------------------------------------------

describe("echoEngine", () => {
  it("is mode:mock, deterministic, and always prefixed [mock] with the session prefix and the exact input", async () => {
    const engine = echoEngine();
    expect(engine.mode).toBe("mock");

    const turn: AgentTurn = {
      sessionId: "session-1234567890",
      identityId: "id-1",
      platform: "telegram",
      user: "u1",
      text: "what's the weather like",
      switchedChannel: false,
    };
    const result = await engine.respond(turn);
    expect(result.text.startsWith("[mock] ")).toBe(true);
    expect(result.text).toContain(turn.sessionId.slice(0, 8));
    expect(result.text).toContain(turn.text);
    expect(result.decision).toBeUndefined();
    expect(result.certificate).toBeUndefined();
  });

  it("never fabricates evidence and is byte-for-byte deterministic across calls with the same input", async () => {
    const engine = echoEngine();
    const turn: AgentTurn = {
      sessionId: "abcdefgh-ignore-rest",
      identityId: "id-1",
      platform: "slack",
      user: "u2",
      text: "hi",
      switchedChannel: true,
    };
    const r1 = await engine.respond(turn);
    const r2 = await engine.respond(turn);
    expect(r1).toEqual(r2);
    expect(r1.text).toBe(`[mock] abcdefgh hi`);
  });
});

// ---------------------------------------------------------------------------
// swarmEngine
// ---------------------------------------------------------------------------

function fakeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    objective: "do the thing",
    status: "completed",
    createdAt: 0,
    taskIds: [],
    synthesis: "the answer is 42",
    ...overrides,
  };
}

function fakeManager(startGoal: GatewayManager["startGoal"]): GatewayManager {
  return { startGoal, getGoal: () => undefined };
}

const turnFixture: AgentTurn = {
  sessionId: "sess-1",
  identityId: "id-1",
  platform: "telegram",
  user: "u1",
  text: "please compute something",
  switchedChannel: false,
};

describe("swarmEngine", () => {
  it("mode:real, and maps a completed goal's synthesis honestly", async () => {
    const manager = fakeManager(async (objective) => ({
      goalId: "g1",
      done: Promise.resolve(fakeGoal({ synthesis: `synthesized: ${objective}` })),
    }));
    const engine = swarmEngine(manager);
    expect(engine.mode).toBe("real");

    const result = await engine.respond(turnFixture);
    expect(result.text).toBe(`synthesized: ${turnFixture.text}`);
    expect(result.decision).toBeUndefined();
    expect(result.certificate).toBeUndefined();
  });

  it("appends a contradiction warning when the goal recorded contradictions", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g1",
      done: Promise.resolve(
        fakeGoal({
          synthesis: "answer",
          contradictions: [{ a: "x", b: "y" } as unknown as Goal["contradictions"] extends (infer U)[] | undefined ? U : never],
        }),
      ),
    }));
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text).toContain("answer");
    expect(result.text).toContain("1 contradiction");
  });

  it("an aborted goal maps to an honest cancellation notice, never a fabricated success", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g1",
      done: Promise.resolve(fakeGoal({ status: "aborted", synthesis: undefined })),
    }));
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text.toLowerCase()).toContain("cancelled");
    expect(result.text.toLowerCase()).not.toContain("42");
  });

  it("a failed goal maps to an honest failure notice naming the status, not invented text", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g1",
      done: Promise.resolve(fakeGoal({ status: "failed", synthesis: undefined })),
    }));
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text).toContain("failed");
    expect(result.text.toLowerCase()).toContain("could not produce a verified answer");
  });

  it("a rejected `done` promise yields an honest failure result, never a thrown exception or invented text", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g1",
      done: Promise.reject(new Error("worker crashed mid-execution")),
    }));
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text).toContain("worker crashed mid-execution");
    expect(result.text.toLowerCase()).not.toContain("42");
  });

  it("startGoal itself throwing is caught and mapped honestly rather than propagating", async () => {
    const manager = fakeManager(async () => {
      throw new Error("manager is at capacity");
    });
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text).toContain("manager is at capacity");
  });

  it("passes opts.timeoutMs through to startGoal, mirroring SwarmGateway's own contract", async () => {
    const seen: (number | undefined)[] = [];
    const manager = fakeManager(async (_objective, opts) => {
      seen.push(opts?.timeoutMs);
      return { goalId: "g1", done: Promise.resolve(fakeGoal()) };
    });
    const engine = swarmEngine(manager, { timeoutMs: 12_345 });
    await engine.respond(turnFixture);
    expect(seen).toEqual([12_345]);
  });

  it("a goal whose done resolves to a non-terminal-success status (e.g. planning/running left dangling) is still reported honestly, not as success", async () => {
    const manager = fakeManager(async () => ({
      goalId: "g1",
      done: Promise.resolve(fakeGoal({ status: "running", synthesis: undefined })),
    }));
    const engine = swarmEngine(manager);
    const result = await engine.respond(turnFixture);
    expect(result.text.toLowerCase()).toContain("could not produce a verified answer");
    expect(result.text).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// AgentGatewayHandler — FIFO, timeout, throw-safety, evidence, prefix
// ---------------------------------------------------------------------------

describe("AgentGatewayHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the AgentTurn correctly from (msg, ctx) and returns accepted:true with the engine's text on success", async () => {
    const seen: AgentTurn[] = [];
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(turn) {
        seen.push(turn);
        return { text: "the reply" };
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-1");
    const reply = await handler.handle(inbound("discord", "d1", "hello there"), ctxFor("sess-a", identity));

    expect(reply).toEqual({ text: "the reply", accepted: true, evidence: { decision: undefined, certificate: undefined } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      sessionId: "sess-a",
      identityId: "identity-1",
      platform: "discord",
      user: "d1",
      text: "hello there",
      switchedChannel: false,
    });
  });

  it("FIFO: five concurrent turns on ONE session execute strictly in order even though they resolve out of order", async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<AgentTurnResult>>>();
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(turn) {
        order.push(`enter:${turn.text}`);
        const gate = deferred<AgentTurnResult>();
        gates.set(turn.text, gate);
        const result = await gate.promise;
        order.push(`exit:${turn.text}`);
        return result;
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-fifo");

    const labels = ["a", "b", "c", "d", "e"];
    const promises = labels.map((label) =>
      handler.handle(inbound("telegram", "u1", label), ctxFor("sess-fifo", identity)),
    );

    // Let each turn's microtasks run so it can register in `gates`/`order`,
    // one at a time — strict FIFO means only ONE should have entered so far.
    await vi.waitFor(() => expect(order).toEqual(["enter:a"]));
    expect(handler.pendingFor("sess-fifo")).toBe(5);

    // Resolve out of order: c, then a, then e, then b, then d. If the queue
    // were not truly FIFO, resolving c early could let it run before b/a.
    gates.get("a")!.resolve({ text: "A" });
    await vi.waitFor(() => expect(order).toEqual(["enter:a", "exit:a", "enter:b"]));

    gates.get("b")!.resolve({ text: "B" });
    await vi.waitFor(() => expect(order).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c"]));

    gates.get("c")!.resolve({ text: "C" });
    await vi.waitFor(() =>
      expect(order).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c", "enter:d"]),
    );

    gates.get("d")!.resolve({ text: "D" });
    await vi.waitFor(() =>
      expect(order).toEqual([
        "enter:a",
        "exit:a",
        "enter:b",
        "exit:b",
        "enter:c",
        "exit:c",
        "enter:d",
        "exit:d",
        "enter:e",
      ]),
    );

    gates.get("e")!.resolve({ text: "E" });
    const results = await Promise.all(promises);
    expect(results.map((r) => r.text)).toEqual(["A", "B", "C", "D", "E"]);
    expect(order).toEqual([
      "enter:a",
      "exit:a",
      "enter:b",
      "exit:b",
      "enter:c",
      "exit:c",
      "enter:d",
      "exit:d",
      "enter:e",
      "exit:e",
    ]);

    // No leak: the Map entry for a drained session is gone, not just zero.
    expect(handler.pendingFor("sess-fifo")).toBe(0);
  });

  it("two different sessions run fully concurrently: both engines are entered before either resolves", async () => {
    const order: string[] = [];
    const gateA = deferred<AgentTurnResult>();
    const gateB = deferred<AgentTurnResult>();
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(turn) {
        order.push(`enter:${turn.sessionId}`);
        const result = await (turn.sessionId === "sess-A" ? gateA.promise : gateB.promise);
        order.push(`exit:${turn.sessionId}`);
        return result;
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const idA = makeIdentity("id-A");
    const idB = makeIdentity("id-B");

    const pA = handler.handle(inbound("telegram", "a", "hi"), ctxFor("sess-A", idA));
    const pB = handler.handle(inbound("slack", "b", "hi"), ctxFor("sess-B", idB));

    await vi.waitFor(() => expect(order.sort()).toEqual(["enter:sess-A", "enter:sess-B"]));

    gateA.resolve({ text: "a-done" });
    gateB.resolve({ text: "b-done" });
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.text).toBe("a-done");
    expect(rB.text).toBe("b-done");
    expect(handler.pendingFor("sess-A")).toBe(0);
    expect(handler.pendingFor("sess-B")).toBe(0);
  });

  it("timeout: an engine that never resolves yields the honest failure reply at turnTimeoutMs, and calls onError with the real error", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond: () => new Promise(() => undefined), // never resolves
    };
    const errors: unknown[] = [];
    const turns: AgentTurn[] = [];
    const handler = new AgentGatewayHandler({
      engine,
      turnTimeoutMs: 5_000,
      onError: (err, turn) => {
        errors.push(err);
        turns.push(turn);
      },
    });
    const identity = makeIdentity("identity-timeout");

    const promise = handler.handle(inbound("telegram", "u1", "hang forever"), ctxFor("sess-t", identity));
    await vi.advanceTimersByTimeAsync(5_000);
    const reply = await promise;

    expect(reply.accepted).toBe(false);
    expect(reply.text).toBe(
      "I hit a problem completing that — the failure was recorded and nothing unverified was reported as done.",
    );
    expect(reply.text).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack-frame-shaped text
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(turns[0].text).toBe("hang forever");
    expect(handler.pendingFor("sess-t")).toBe(0);
  });

  it("a LATE resolution after timeout does not double-send and produces no unhandled rejection", async () => {
    const gate = deferred<AgentTurnResult>();
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond: () => gate.promise,
    };
    const handler = new AgentGatewayHandler({ engine, turnTimeoutMs: 1_000 });
    const identity = makeIdentity("identity-late");

    const promise = handler.handle(inbound("telegram", "u1", "slow"), ctxFor("sess-late", identity));
    await vi.advanceTimersByTimeAsync(1_000);
    const reply = await promise;
    expect(reply.accepted).toBe(false);

    // Resolve long after the timeout already fired and the caller already
    // got a reply. This must not throw, reject, or change anything.
    gate.resolve({ text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // Queue is still clean — the late resolution didn't re-enqueue or leak.
    expect(handler.pendingFor("sess-late")).toBe(0);
  });

  it("engine throw (synchronous rejection) yields the honest failure reply, onError gets the real error, and the reply text has no stack frames", async () => {
    const boom = new Error("kaboom: verifier ensemble unavailable\n    at somewhere (file.ts:10:5)");
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond() {
        throw boom;
      },
    };
    const errors: unknown[] = [];
    const handler = new AgentGatewayHandler({ engine, onError: (err) => errors.push(err) });
    const identity = makeIdentity("identity-throw");

    const reply = await handler.handle(inbound("telegram", "u1", "hi"), ctxFor("sess-throw", identity));
    expect(reply.accepted).toBe(false);
    expect(reply.text).toBe(
      "I hit a problem completing that — the failure was recorded and nothing unverified was reported as done.",
    );
    expect(reply.text).not.toContain("kaboom");
    expect(reply.text).not.toContain("file.ts");
    expect(errors).toEqual([boom]);
  });

  it("a throw on turn N does not stall turns N+1.. queued behind it in the same session", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond(turn) {
        if (turn.text === "boom") throw new Error("boom");
        return { text: `ok:${turn.text}` };
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-chain");

    const p1 = handler.handle(inbound("telegram", "u1", "boom"), ctxFor("sess-chain", identity));
    const p2 = handler.handle(inbound("telegram", "u1", "next"), ctxFor("sess-chain", identity));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.accepted).toBe(false);
    expect(r2.accepted).toBe(true);
    expect(r2.text).toBe("ok:next");
    expect(handler.pendingFor("sess-chain")).toBe(0);
  });

  it("switchedChannel: prefixes the reply with the exact locked continuation string, sourced from identity.lastSeen.platform", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond() {
        return { text: "welcome back" };
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-switch", { lastSeen: { platform: "telegram", user: "u1" } });

    const reply = await handler.handle(
      inbound("email", "alice@example.test", "continuing here"),
      ctxFor("sess-switch", identity, true),
    );
    expect(reply.text).toBe("(continuing our conversation from telegram) welcome back");
  });

  it("does not prefix when switchedChannel is false, even if lastSeen happens to be set", async () => {
    const engine: GatewayAgentEngine = {
      mode: "mock",
      async respond() {
        return { text: "plain reply" };
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-noswitch", { lastSeen: { platform: "telegram", user: "u1" } });

    const reply = await handler.handle(
      inbound("telegram", "u1", "hi again"),
      ctxFor("sess-noswitch", identity, false),
    );
    expect(reply.text).toBe("plain reply");
  });

  it("evidence passthrough: a real GateDecision + certificate from the STYX CertificateAuthority arrives intact on the reply", async () => {
    const ca = new CertificateAuthority(generatePrivateKeyHex(() => new Uint8Array(32).fill(7)));
    const cert = await ca.issue({
      outputSha256: "0".repeat(64),
      taskId: "task-1",
      verifierTier: "T0-execution",
      ensembleScore: 0.97,
      pCorrect: 0.98,
      epsilon: 0.02,
      traceSha256: "1".repeat(64),
      verifierVersions: ["exec-oracle@1.0.0"],
      issuedAt: 1_700_000_000_000,
    });
    const decision: GateDecision = { emit: true, score: 0.97, threshold: 0.9, pCorrectEstimate: 0.98 };

    const engine: GatewayAgentEngine = {
      mode: "real",
      async respond() {
        return { text: "verified answer", decision, certificate: cert };
      },
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-evidence");

    const reply = (await handler.handle(
      inbound("slack", "u1", "give me the verified answer"),
      ctxFor("sess-evidence", identity),
    )) as OutboundReply & { evidence?: BadgeEvidence };

    expect(reply.text).toBe("verified answer");
    expect(reply.accepted).toBe(true);
    expect(reply.evidence?.decision).toEqual(decision);
    expect(reply.evidence?.certificate).toEqual(cert);
  });

  it("defaults turnTimeoutMs to 300000", async () => {
    let sawTimeout: number | undefined;
    const engine: GatewayAgentEngine = {
      mode: "mock",
      respond: () =>
        new Promise((resolve) => {
          sawTimeout = 1; // marker: at least entered
          setTimeout(() => resolve({ text: "ok" }), 299_000);
        }),
    };
    const handler = new AgentGatewayHandler({ engine });
    const identity = makeIdentity("identity-default-timeout");

    const promise = handler.handle(inbound("telegram", "u1", "hi"), ctxFor("sess-default", identity));
    await vi.advanceTimersByTimeAsync(299_000);
    const reply = await promise;
    expect(sawTimeout).toBe(1);
    expect(reply.accepted).toBe(true);
    expect(reply.text).toBe("ok");
  });
});
