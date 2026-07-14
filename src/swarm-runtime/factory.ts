import { randomBytes } from "node:crypto";
import { InMemoryBus } from "./bus/in-memory";
import { InlineProvider } from "./providers/inline";
import { SwarmManager } from "./manager/manager";
import type { Planner } from "./manager/planner";
import { WorkerRuntime } from "./worker/runtime";
import type { TaskExecutor } from "./worker/executor";
import { VerificationGate, type GateConfig } from "./verification/gate";
import { AntiRogueGuardrail, type GuardrailPolicy } from "./verification/guardrails";
import type { ConsensusSpec } from "./types";

export interface InlineSwarmOptions {
  capabilities?: string[];
  poolSize?: number;
  planner?: Planner;
  /** Executor each inline worker runs. */
  executor?: TaskExecutor;
  gate?: GateConfig | VerificationGate;
  guardrailPolicy?: GuardrailPolicy;
  maxAttempts?: number;
  model?: string;
  /** Run every task redundantly across N workers with quorum agreement. */
  defaultConsensus?: ConsensusSpec;
}

/**
 * Assemble a fully-wired swarm that runs in the current process: an
 * {@link InMemoryBus} shared between manager and workers, and an
 * {@link InlineProvider} that runs each worker's {@link WorkerRuntime} inline.
 * No Docker, no sockets — ideal for tests, demos, and CI. The verification
 * gate and guardrails run exactly as they do in the containerized topology, so
 * the trust guarantees are identical; only the isolation boundary differs.
 */
export async function createInlineSwarm(opts: InlineSwarmOptions = {}): Promise<SwarmManager> {
  const bus = new InMemoryBus();
  const capabilities = opts.capabilities ?? ["general"];
  const authToken = randomBytes(16).toString("hex");

  const provider = new InlineProvider(async (spec, signal) => {
    const runtime = new WorkerRuntime({
      workerId: spec.workerId,
      capabilities: spec.capabilities,
      bus, // inline workers share the manager's in-memory bus
      executor: opts.executor,
      model: spec.model,
      heartbeatMs: 1000,
      pollTimeoutMs: 2000,
    });
    await runtime.start(signal);
  });

  const gate =
    opts.gate instanceof VerificationGate ? opts.gate : new VerificationGate(opts.gate ?? {});

  const manager = new SwarmManager({
    provider,
    bus,
    managerUrl: "inline://local",
    authToken,
    capabilities,
    poolSize: opts.poolSize ?? Math.min(3, capabilities.length + 1),
    planner: opts.planner,
    gate,
    guardrail: new AntiRogueGuardrail(opts.guardrailPolicy),
    maxAttempts: opts.maxAttempts,
    model: opts.model,
    defaultConsensus: opts.defaultConsensus,
  });

  return manager;
}
