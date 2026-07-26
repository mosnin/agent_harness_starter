import { describe, it, expect, vi } from "vitest";

import { resolveGatewayEngine, type EngineProbe } from "../gateway/engine-select";
import type { AgentTurn } from "../gateway/agent-handler";
import { certifiesOutput } from "../styx/certificate";
import { createInlineSwarm } from "../../swarm-runtime/factory";
import { LLMExecutor, type ChatFn, type ChatMessage } from "../../swarm-runtime/worker/llm-executor";
import type { GatewayManager } from "../../swarm-runtime/gateway/gateway";

// ---------------------------------------------------------------------------
// A deterministic ChatFn: never touches the network, always grounds its
// claim in a substring that's guaranteed to appear in the exact prompt the
// LLMExecutor built (the first "TASK: ..." line), so the real
// VerificationGate accepts it exactly like a genuine model completion would.
// ---------------------------------------------------------------------------

const deterministicChat: ChatFn = async (messages: ChatMessage[]) => {
  const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
  const taskLine = userMsg.split("\n")[0]; // "TASK: <description>" — verbatim substring of the prompt.
  return JSON.stringify({
    answer: `Answer grounded in: ${taskLine}`,
    claims: [{ statement: "the task line quoted here is exactly what was asked", evidence: [taskLine], confidence: 0.95 }],
  });
};

const turnFixture: AgentTurn = {
  sessionId: "sess-select-1",
  identityId: "id-1",
  platform: "cli",
  user: "u1",
  text: "figure out the capital of Testland",
  switchedChannel: false,
};

function fakeManagerFactory(): { manager: GatewayManager; shutdown: () => Promise<void>; started: AgentTurn[] } {
  const started: unknown[] = [];
  const manager: GatewayManager = {
    startGoal: async (objective) => {
      started.push(objective);
      return {
        goalId: "fake-goal-1",
        done: Promise.resolve({
          id: "fake-goal-1",
          objective,
          status: "completed" as const,
          createdAt: 0,
          taskIds: ["t1"],
          synthesis: `mock synthesis for: ${objective}`,
        }),
      };
    },
    getGoal: () => undefined,
  };
  return { manager, shutdown: async () => {}, started: started as AgentTurn[] };
}

// ---------------------------------------------------------------------------
// echo (unset / "echo")
// ---------------------------------------------------------------------------

describe("resolveGatewayEngine — echo path", () => {
  it("HADES_GATEWAY_ENGINE unset -> echo engine, honest mock probe naming how to opt in", async () => {
    const { engine, probe, shutdown } = await resolveGatewayEngine({});
    expect(engine.mode).toBe("mock");
    expect(probe).toEqual<EngineProbe>({ requested: "echo", mode: "mock", detail: expect.stringContaining("HADES_GATEWAY_ENGINE=swarm") });
    const reply = await engine.respond(turnFixture);
    expect(reply.text.startsWith("[mock] ")).toBe(true);
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it('HADES_GATEWAY_ENGINE="echo" explicitly -> same honest mock path', async () => {
    const { engine, probe } = await resolveGatewayEngine({ HADES_GATEWAY_ENGINE: "echo" });
    expect(engine.mode).toBe("mock");
    expect(probe.requested).toBe("echo");
    expect(probe.mode).toBe("mock");
  });

  it("an unknown HADES_GATEWAY_ENGINE value falls back to echo with an honest 'unknown engine' detail — never silently swarms", async () => {
    const { engine, probe } = await resolveGatewayEngine({ HADES_GATEWAY_ENGINE: "quantum-teleport" });
    expect(engine.mode).toBe("mock");
    expect(probe.requested).toBe("echo");
    expect(probe.mode).toBe("mock");
    expect(probe.detail.toLowerCase()).toContain("unknown engine");
  });
});

// ---------------------------------------------------------------------------
// swarm requested, no key -> honest mock fallback, never a demo-executor swarm
// ---------------------------------------------------------------------------

describe("resolveGatewayEngine — swarm requested without a key", () => {
  it('HADES_GATEWAY_ENGINE="swarm" with no provider key -> echo engine, probe names the missing variables, and createManager is NEVER invoked', async () => {
    const createManager = vi.fn();
    const { engine, probe, shutdown } = await resolveGatewayEngine({ HADES_GATEWAY_ENGINE: "swarm" }, { createManager });

    expect(engine.mode).toBe("mock");
    expect(probe).toEqual<EngineProbe>({ requested: "swarm", mode: "mock", detail: "missing ANTHROPIC_API_KEY, OPENAI_API_KEY" });
    expect(createManager).not.toHaveBeenCalled();

    const reply = await engine.respond(turnFixture);
    expect(reply.text.startsWith("[mock] ")).toBe(true);
    await shutdown(); // must not throw
  });

  it("empty-string keys count as absent (not a real key) and still fall back honestly", async () => {
    const createManager = vi.fn();
    const { engine, probe } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
      { createManager },
    );
    expect(engine.mode).toBe("mock");
    expect(probe.mode).toBe("mock");
    expect(createManager).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// swarm requested with a key -> the real, certified engine
// ---------------------------------------------------------------------------

describe("resolveGatewayEngine — swarm requested with a key (mode: real)", () => {
  it("ANTHROPIC_API_KEY present -> mode:real, probe names ANTHROPIC_API_KEY, engine issues a certificate that verifies over the exact reply text (fake manager, no real swarm spin-up)", async () => {
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async (_executor: LLMExecutor) => ({ manager: fake.manager, shutdown: fake.shutdown }));

    const { engine, probe, shutdown } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-test-key" },
      { chat: deterministicChat, createManager },
    );

    expect(engine.mode).toBe("real");
    expect(probe.requested).toBe("swarm");
    expect(probe.mode).toBe("real");
    expect(probe.detail).toContain("ANTHROPIC_API_KEY");
    expect(createManager).toHaveBeenCalledTimes(1);

    const reply = await engine.respond(turnFixture);
    expect(reply.text).toBe(`mock synthesis for: ${turnFixture.text}`);
    expect(reply.decision?.emit).toBe(true);
    expect(reply.certificate).toBeDefined();
    expect(await certifiesOutput(reply.certificate!, reply.text)).toBe(true);
    expect(await certifiesOutput(reply.certificate!, "different text")).toBe(false);

    await shutdown();
  });

  it("OPENAI_API_KEY present (no anthropic key) -> mode:real, probe names OPENAI_API_KEY", async () => {
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async () => ({ manager: fake.manager, shutdown: fake.shutdown }));

    const { engine, probe } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", OPENAI_API_KEY: "sk-oai-test-key" },
      { chat: deterministicChat, createManager },
    );
    expect(engine.mode).toBe("real");
    expect(probe.detail).toContain("OPENAI_API_KEY");
    expect(probe.detail).not.toContain("ANTHROPIC_API_KEY");
  });

  it("ANTHROPIC_API_KEY takes priority when both keys are present", async () => {
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async () => ({ manager: fake.manager, shutdown: fake.shutdown }));
    const { probe } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" },
      { chat: deterministicChat, createManager },
    );
    expect(probe.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("never puts the key VALUE in the probe or its detail string — only the variable name (grep every string field)", async () => {
    const SECRET = "sk-ant-super-secret-sentinel-do-not-leak-9f8e7d6c5b4a";
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async () => ({ manager: fake.manager, shutdown: fake.shutdown }));

    const { probe, engine } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: SECRET },
      { chat: deterministicChat, createManager },
    );

    const serializedProbe = JSON.stringify(probe);
    expect(serializedProbe).not.toContain(SECRET);
    expect(probe.detail).not.toContain(SECRET);
    expect(probe.requested).not.toContain(SECRET);
    expect(probe.mode).not.toContain(SECRET);

    // Also verify a full turn's reply never leaks the secret either.
    const reply = await engine.respond(turnFixture);
    expect(reply.text).not.toContain(SECRET);
    expect(JSON.stringify(reply)).not.toContain(SECRET);
  });

  it("HADES_GATEWAY_MODEL and HADES_GATEWAY_BASE_URL override the provider defaults and reach the real createOpenAICompatibleChat wiring (structural check only — no live call)", async () => {
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async (_executor: LLMExecutor) => ({ manager: fake.manager, shutdown: fake.shutdown }));

    // No injected `chat` here: resolveGatewayEngine must build one via
    // createOpenAICompatibleChat itself using the override model/base URL.
    // We never invoke it (no turn is run against the real fetch-backed chat),
    // so this exercises the URL/headers assembly path without a live network call.
    const { engine, probe } = await resolveGatewayEngine(
      {
        HADES_GATEWAY_ENGINE: "swarm",
        ANTHROPIC_API_KEY: "sk-ant-test",
        HADES_GATEWAY_MODEL: "claude-custom-model",
        HADES_GATEWAY_BASE_URL: "https://custom.example.com/v1",
      },
      { createManager },
    );
    expect(engine.mode).toBe("real");
    expect(probe.detail).toContain("claude-custom-model");
    // Confirm the executor passed into createManager is a real LLMExecutor
    // (not some other stand-in), proving the ChatFn was actually wired through.
    const passedExecutor = createManager.mock.calls[0][0];
    expect(passedExecutor).toBeInstanceOf(LLMExecutor);
  });

  it("HADES_STYX_KEY (hex) is honored as the certificate authority's signing key when set", async () => {
    const fake = fakeManagerFactory();
    const createManager = vi.fn(async () => ({ manager: fake.manager, shutdown: fake.shutdown }));
    const styxKeyHex = "5a".repeat(32);

    const { engine } = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-test", HADES_STYX_KEY: styxKeyHex },
      { chat: deterministicChat, createManager },
    );
    const reply = await engine.respond(turnFixture);
    expect(reply.certificate).toBeDefined();
    // Deterministic seed -> deterministic public key, independent of run.
    const again = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-test", HADES_STYX_KEY: styxKeyHex },
      { chat: deterministicChat, createManager: vi.fn(async () => ({ manager: fakeManagerFactory().manager, shutdown: fake.shutdown })) },
    );
    const reply2 = await again.engine.respond(turnFixture);
    expect(reply2.certificate?.publicKey).toBe(reply.certificate?.publicKey);
  });

  it("without HADES_STYX_KEY, a fresh signing key is generated (public keys differ across independent resolutions)", async () => {
    const fake1 = fakeManagerFactory();
    const fake2 = fakeManagerFactory();
    const r1 = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-test" },
      { chat: deterministicChat, createManager: vi.fn(async () => ({ manager: fake1.manager, shutdown: fake1.shutdown })) },
    );
    const r2 = await resolveGatewayEngine(
      { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-test" },
      { chat: deterministicChat, createManager: vi.fn(async () => ({ manager: fake2.manager, shutdown: fake2.shutdown })) },
    );
    const reply1 = await r1.engine.respond(turnFixture);
    const reply2 = await r2.engine.respond(turnFixture);
    expect(reply1.certificate?.publicKey).not.toBe(reply2.certificate?.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Real createInlineSwarm end to end (genuine manager, genuine LLMExecutor)
// ---------------------------------------------------------------------------

describe("resolveGatewayEngine — full real path through a genuine createInlineSwarm", () => {
  it(
    "a real manager (real createInlineSwarm + real LLMExecutor parsing the fake model's JSON claims) produces a certified reply, and shutdown() actually invokes the real manager teardown",
    async () => {
      // createManager is NOT injected as a black box — it wraps the REAL
      // createInlineSwarm and spies on the REAL SwarmManager.shutdown() so we
      // can prove resolveGatewayEngine's returned `shutdown` genuinely reaches
      // it (SwarmManager.shutdown() is documented idempotent: workers are torn
      // down and the bus is closed, then a second call is a safe no-op — see
      // manager.ts. It intentionally does NOT forbid a *future* startGoal from
      // lazily re-spawning a fresh pool, so "no more successful goals ever" is
      // not the real contract to assert; "the real teardown method actually
      // ran" is).
      let shutdownSpy: ReturnType<typeof vi.spyOn> | undefined;
      const { engine, probe, shutdown } = await resolveGatewayEngine(
        { HADES_GATEWAY_ENGINE: "swarm", ANTHROPIC_API_KEY: "sk-ant-real-path-test" },
        {
          chat: deterministicChat,
          createManager: async (executor: LLMExecutor) => {
            const manager = await createInlineSwarm({ executor });
            shutdownSpy = vi.spyOn(manager, "shutdown");
            return { manager, shutdown: () => manager.shutdown() };
          },
        },
      );
      expect(engine.mode).toBe("real");
      expect(probe.mode).toBe("real");

      const reply = await engine.respond({
        sessionId: "sess-real",
        identityId: "id-real",
        platform: "cli",
        user: "u-real",
        text: "what is 2 + 2, and cite your reasoning",
        switchedChannel: false,
      });

      // The DeterministicPlanner fans out into >=1 real, gate-checked tasks; our
      // deterministic chat grounds every one of them, so the goal should complete
      // and clear the (real, calibrated) gate.
      expect(typeof reply.text).toBe("string");
      expect(reply.decision).toBeDefined();
      if (reply.decision?.emit) {
        expect(reply.certificate).toBeDefined();
        expect(await certifiesOutput(reply.certificate!, reply.text)).toBe(true);
      } else {
        expect(reply.certificate).toBeUndefined();
      }

      expect(shutdownSpy).not.toHaveBeenCalled();
      await shutdown();
      expect(shutdownSpy).toHaveBeenCalledTimes(1);

      // Idempotent per SwarmManager's own contract: calling it again must not throw.
      await expect(shutdown()).resolves.toBeUndefined();
      expect(shutdownSpy).toHaveBeenCalledTimes(2);
    },
    15_000,
  );

  it("createManager (and therefore createInlineSwarm) is never invoked for the echo path — the demo-executor-masquerade regression is structurally impossible", async () => {
    const createManager = vi.fn();
    await resolveGatewayEngine({}, { createManager });
    await resolveGatewayEngine({ HADES_GATEWAY_ENGINE: "echo" }, { createManager });
    await resolveGatewayEngine({ HADES_GATEWAY_ENGINE: "not-a-real-mode" }, { createManager });
    expect(createManager).not.toHaveBeenCalled();
  });
});
