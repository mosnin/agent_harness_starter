import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HttpControlPlane } from "../bus/http-control-plane";
import { DockerProvider } from "../providers/docker";
import { LocalProcessProvider } from "../providers/local-process";
import { SwarmManager } from "../manager/manager";
import type { Planner } from "../manager/planner";
import { createInlineSwarm } from "../factory";
import { LLMPlanner } from "../manager/planner";
import { createOpenAICompatibleChat, chatToPlannerComplete } from "../worker/llm-executor";
import type { GuardrailPolicy } from "../verification/guardrails";
import { VerificationGate, type GateConfig } from "../verification/gate";
import type { TaskExecutor } from "../worker/executor";
import type { ContainerProvider, ResourceLimits } from "../types";

/**
 * Build a model-backed planner from the environment when an API key + model are
 * available; otherwise return undefined so the manager uses its deterministic
 * planner. Keeps the swarm runnable with or without model access.
 */
function plannerFromEnv(model?: string): LLMPlanner | undefined {
  const apiKey = process.env.SWARM_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey || !model) return undefined;
  const chat = createOpenAICompatibleChat({
    apiKey,
    model,
    baseUrl: process.env.SWARM_BASE_URL ?? process.env.OPENAI_BASE_URL,
  });
  return new LLMPlanner(chatToPlannerComplete(chat));
}

export type SwarmMode = "inline" | "process" | "docker";

export interface BuildSwarmOptions {
  mode: SwarmMode;
  capabilities?: string[];
  poolSize?: number;
  planner?: Planner;
  /**
   * Executor every worker runs — **inline mode only**. Process/docker workers
   * live in their own process/container and select an executor from the worker
   * environment (`SWARM_MODEL` + `SWARM_API_KEY`/`OPENAI_API_KEY`; see
   * `worker/entrypoint.ts`), so an injected executor cannot reach them:
   * passing one with a non-inline mode throws rather than being silently
   * ignored.
   */
  executor?: TaskExecutor;
  /**
   * Verification gate (or its config) every worker result is scored by —
   * applies to ALL modes, because the gate runs manager-side, not in the
   * worker.
   *
   * This is the seam a composition root uses to hand the manager a
   * CORRECTNESS oracle (`GateConfig.externalVerifier`); the swarm CLI passes
   * `src/hades/trust/swarm-bridge.ts`'s bridge through here. Declared as a
   * plain option rather than imported, so this module keeps depending on
   * nothing above it — same inversion as {@link decorateProvider}.
   * Omitted: the manager builds its default `VerificationGate`, exactly as
   * before.
   */
  gate?: GateConfig | VerificationGate;
  model?: string;
  maxAttempts?: number;
  guardrailPolicy?: GuardrailPolicy;
  workerLimits?: ResourceLimits;
  /** Control-plane port for process/docker modes. Default 8787. */
  controlPort?: number;
  controlHost?: string;
  /** URL workers use to reach the control plane. Default derived from port. */
  managerUrl?: string;
  /** Docker image for workers (docker mode). */
  workerImage?: string;
  /** Docker network for workers (docker mode). */
  dockerNetwork?: string;
  /** Path to the built worker entrypoint (process mode). */
  workerEntry?: string;
  /**
   * Decoration seam for the REAL container provider (process/docker modes
   * only — inline mode has no `ContainerProvider`). The default
   * `LocalProcessProvider`/`DockerProvider` is built exactly as always, then
   * passed through this hook before the manager sees it. Central wiring uses
   * it to wrap the provider with worker->backend attribution
   * (`src/hades/backends/fleet-provider.ts`'s `AttributedContainerProvider`)
   * without this module ever depending on `src/hades/**`. The decorated
   * provider must delegate the actual spawn/stop to the inner one.
   */
  decorateProvider?: (provider: ContainerProvider, mode: "process" | "docker") => ContainerProvider;
}

export interface BuiltSwarm {
  manager: SwarmManager;
  mode: SwarmMode;
  /** Present for process/docker modes. */
  controlPlane?: HttpControlPlane;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Resolve the worker entrypoint script. Prefers a compiled JS build; falls back
 * to running the TypeScript source through `tsx` for dev convenience.
 */
function resolveWorkerEntry(explicit?: string): {
  command?: string;
  commandArgs?: string[];
  entry: string;
} {
  if (explicit) return { entry: explicit };
  const candidates = [
    resolve(process.cwd(), "dist-swarm/worker/entrypoint.js"),
    resolve(process.cwd(), "dist/swarm-runtime/worker/entrypoint.js"),
  ];
  for (const c of candidates) if (existsSync(c)) return { entry: c };
  // Dev fallback: run the TS source via `npx tsx <entry>`.
  return {
    command: "npx",
    commandArgs: ["tsx"],
    entry: resolve(process.cwd(), "src/swarm-runtime/worker/entrypoint.ts"),
  };
}

/**
 * Build a swarm for the requested isolation mode. Inline runs everything in one
 * process; process spawns each worker as an OS child process; docker spawns
 * each worker in its own container. Process and docker modes stand up an
 * authenticated HTTP control plane workers call home to.
 */
export async function buildSwarm(opts: BuildSwarmOptions): Promise<BuiltSwarm> {
  const capabilities = opts.capabilities ?? ["general"];

  if (opts.mode === "inline") {
    const manager = await createInlineSwarm({
      capabilities,
      poolSize: opts.poolSize,
      planner: opts.planner ?? plannerFromEnv(opts.model),
      executor: opts.executor,
      ...(opts.gate === undefined ? {} : { gate: opts.gate }),
      guardrailPolicy: opts.guardrailPolicy,
      maxAttempts: opts.maxAttempts,
      model: opts.model,
    });
    return {
      manager,
      mode: "inline",
      async start() {
        await manager.ensurePool();
      },
      async stop() {
        await manager.shutdown();
      },
    };
  }

  // Never silently drop an injected executor: outside inline mode the workers
  // are separate processes/containers and would run something else entirely.
  if (opts.executor) {
    throw new Error(
      `executor injection is inline-only: ${opts.mode} workers run in their own ` +
        `${opts.mode === "docker" ? "container" : "process"} and select an executor from the worker ` +
        `environment (SWARM_MODEL + SWARM_API_KEY/OPENAI_API_KEY)`,
    );
  }

  const port = opts.controlPort ?? 8787;
  const host = opts.controlHost ?? "127.0.0.1";
  const authToken = randomBytes(24).toString("hex");
  const managerUrl = opts.managerUrl ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const controlPlane = new HttpControlPlane({ port, host, authToken });

  const baseProvider =
    opts.mode === "docker"
      ? new DockerProvider({
          image: opts.workerImage ?? "hermes-swarm-worker:latest",
          network: opts.dockerNetwork,
          swarmLabel: "hermes-swarm",
        })
      : (() => {
          const { command, commandArgs, entry } = resolveWorkerEntry(opts.workerEntry);
          return new LocalProcessProvider({ command, commandArgs, workerEntry: entry });
        })();
  const provider = opts.decorateProvider ? opts.decorateProvider(baseProvider, opts.mode) : baseProvider;

  const manager = new SwarmManager({
    provider,
    bus: controlPlane,
    managerUrl,
    authToken,
    capabilities,
    poolSize: opts.poolSize,
    planner: opts.planner ?? plannerFromEnv(opts.model),
    // The gate is manager-side, so process/docker workers are scored by it
    // exactly like inline ones — the isolation boundary changes where the work
    // runs, never what it takes to be accepted.
    ...(opts.gate === undefined
      ? {}
      : { gate: opts.gate instanceof VerificationGate ? opts.gate : new VerificationGate(opts.gate) }),
    guardrailPolicy: opts.guardrailPolicy,
    workerLimits: opts.workerLimits,
    workerImage: opts.workerImage,
    maxAttempts: opts.maxAttempts,
    model: opts.model,
  });

  return {
    manager,
    mode: opts.mode,
    controlPlane,
    async start() {
      await controlPlane.listen();
      await manager.ensurePool();
    },
    async stop() {
      await manager.shutdown();
    },
  };
}
