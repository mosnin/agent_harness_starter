import type { TaskExecutor, ExecutionOutput, WorkerContext } from "../../swarm-runtime/worker/executor";
import type { WorkerTask } from "../../swarm-runtime/types";
import type { MemoryStore } from "../memory/store";
import type { UserModel } from "./user-model";

export interface MemoryAugmentOptions {
  memory?: MemoryStore;
  userModel?: UserModel;
  /** Max memories to inject per task. Default 5. */
  maxMemories?: number;
}

/**
 * Build the context block injected into a task — the relevant memories and the
 * user profile. Pure and exported for testing / prompt reuse.
 */
export function buildContextBlock(
  relevantMemories: string[],
  userProfile?: string
): { relevantMemories: string[]; userProfile?: string } {
  return { relevantMemories, ...(userProfile ? { userProfile } : {}) };
}

/**
 * Closes the learning loop on the execution side: wraps any swarm
 * {@link TaskExecutor} and, before running it, retrieves memories relevant to
 * the task plus the durable user model and injects them into `task.input`
 * (`_memoryContext`). Prompt-building executors (LLM/harness) surface that
 * context automatically, so a worker benefits from everything Hades has learned
 * — without changing the executor. Grounding still applies: injected context is
 * guidance, not evidence the verification gate will trust on its own.
 */
export class MemoryAugmentedExecutor implements TaskExecutor {
  constructor(
    private readonly inner: TaskExecutor,
    private readonly opts: MemoryAugmentOptions
  ) {}

  async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
    const query = String((task.input as { objective?: unknown }).objective ?? task.description);

    const memories = this.opts.memory
      ? this.opts.memory.search(query, { limit: this.opts.maxMemories ?? 5 }).map((m) => m.fact)
      : [];
    const userProfile = this.opts.userModel?.describe();

    if (memories.length === 0 && !userProfile) {
      return this.inner.execute(task, ctx); // nothing learned yet — pass through
    }

    const augmented: WorkerTask = {
      ...task,
      input: { ...task.input, _memoryContext: buildContextBlock(memories, userProfile) },
    };
    ctx.log(`augmented task with ${memories.length} memories${userProfile ? " + user model" : ""}`);
    return this.inner.execute(augmented, ctx);
  }
}
