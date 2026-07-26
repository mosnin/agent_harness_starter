import { describe, it, expect, afterEach } from "vitest";
import { MemoryAugmentedExecutor } from "../learning/memory-augmentor";
import { InMemoryMemoryStore } from "../memory/store";
import { UserModel } from "../learning/user-model";
import { createInlineSwarm } from "../../swarm-runtime/factory";
import type { SwarmManager } from "../../swarm-runtime/manager/manager";
import type { TaskExecutor, WorkerContext } from "../../swarm-runtime/worker/executor";
import type { WorkerTask } from "../../swarm-runtime/types";

const ctx: WorkerContext = { workerId: "w", log: () => {} };

function task(): WorkerTask {
  return {
    id: "t", goalId: "g", description: "How should we deploy?", requiredCapabilities: [],
    input: { objective: "deployment strategy" }, dependsOn: [], priority: 5, status: "dispatched",
    attempts: 0, maxAttempts: 3, createdAt: 0,
  };
}

describe("MemoryAugmentedExecutor", () => {
  it("injects relevant memories + user model into the task the inner executor sees", async () => {
    const mem = new InMemoryMemoryStore();
    mem.add({ fact: "The team deploys on Fridays using blue-green", salience: 0.9, tags: ["ops"] });
    mem.add({ fact: "The sky is blue", salience: 0.3 });
    const model = new UserModel();
    model.assert({ attribute: "role", value: "platform engineer", confidence: 0.8 });

    let seen: WorkerTask | undefined;
    const inner: TaskExecutor = {
      async execute(t) {
        seen = t;
        return { output: "ok", claims: [], toolTrace: [] };
      },
    };

    const augmentor = new MemoryAugmentedExecutor(inner, { memory: mem, userModel: model });
    await augmentor.execute(task(), ctx);

    const injected = (seen!.input as { _memoryContext?: { relevantMemories: string[]; userProfile?: string } })._memoryContext!;
    expect(injected.relevantMemories.some((m) => m.includes("blue-green"))).toBe(true);
    expect(injected.userProfile).toContain("platform engineer");
  });

  it("passes the task through unchanged when nothing has been learned", async () => {
    let seen: WorkerTask | undefined;
    const inner: TaskExecutor = {
      async execute(t) { seen = t; return { output: "ok", claims: [], toolTrace: [] }; },
    };
    const augmentor = new MemoryAugmentedExecutor(inner, { memory: new InMemoryMemoryStore() });
    const orig = task();
    await augmentor.execute(orig, ctx);
    expect((seen!.input as { _memoryContext?: unknown })._memoryContext).toBeUndefined();
  });

  it("runs inside a real swarm and still completes with verification", async () => {
    let swarm: SwarmManager | undefined;
    try {
      const mem = new InMemoryMemoryStore();
      mem.add({ fact: "The user prefers concise answers", salience: 0.8 });
      // Inner executor that grounds its output normally (demo-like).
      const inner: TaskExecutor = {
        async execute(t) {
          const hasCtx = !!(t.input as { _memoryContext?: unknown })._memoryContext;
          return {
            output: `done (augmented=${hasCtx})`,
            claims: [{ statement: `augmented=${hasCtx}`, evidence: [`observed augmented=${hasCtx}`], confidence: 0.85 }],
            toolTrace: [{ tool: "obs", args: {}, ok: true, output: `observed augmented=${hasCtx}`, at: 0 }],
          };
        },
      };
      swarm = await createInlineSwarm({
        capabilities: ["general"],
        poolSize: 2,
        executor: new MemoryAugmentedExecutor(inner, { memory: mem }),
      });
      const goal = await swarm.runGoal("Give me a concise plan", { timeoutMs: 15_000 });
      expect(goal.status).toBe("completed");
    } finally {
      await swarm?.shutdown();
    }
  });
});
