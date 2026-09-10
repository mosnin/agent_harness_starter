import { AgentTaskExecutor } from "../../hades/runtime/task-executor";
import { resolveModel } from "../../hades/runtime/model";
import { workspaceTools } from "../../hades/runtime/tools";
import { DemoExecutor, type TaskExecutor } from "../worker/executor";
import { FileStateStore, type StateStore } from "../persistence/state-store";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HttpControlPlane } from "../bus/http-control-plane";
import { DockerProvider } from "../providers/docker";
import { LocalProcessProvider } from "../providers/local-process";
import { SwarmManager } from "../manager/manager";
import type { Planner } from "../manager/planner";
import { createInlineSwarm } from "../factory";
import type { GuardrailPolicy } from "../verification/guardrails";
import type { ContainerProvider, ResourceLimits } from "../types";

export type SwarmMode = "inline" | "process" | "docker";

export interface BuildSwarmOptions {
  mode: SwarmMode;
  /** Explicit fixture/demo mode; never silently selected for missing credentials. */
  demo?: boolean;
  executor?: TaskExecutor;
  stateStore?: StateStore;
  workspaceRoot?: string;
  capabilities?: string[];
  poolSize?: number;
  planner?: Planner;
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
  const demo = opts.demo === true || process.env.HADES_DEMO === "1";
  const modelConfig = !demo && !opts.executor ? resolveModel(process.env, { model: opts.model }) : undefined;
  const executor = opts.executor ?? (demo ? new DemoExecutor() : new AgentTaskExecutor(modelConfig!.client, modelConfig!.model, workspaceTools(opts.workspaceRoot ?? process.cwd())));
  // One real task by default: parallel workers must not race on shared files.
  // Callers with isolated workspaces may supply a decomposing planner.
  const planner: Planner | undefined = opts.planner ?? (demo ? undefined : { async plan(objective) { return [{ description: objective, requiredCapabilities: [capabilities[0]], input: { objective }, dependsOn: [], priority: 5 }]; } });
  const stateStore = opts.stateStore ?? (demo ? undefined : new FileStateStore(resolve(process.env.HADES_DATA_DIR ?? ".hades", "swarm-state.json")));
  const workerEnv: Record<string, string> = { HADES_DEMO: demo ? "1" : "0" };
  if (modelConfig) {
    workerEnv.HADES_PROVIDER = modelConfig.provider;
    const names = modelConfig.provider === "anthropic" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]
      : modelConfig.provider === "local" ? ["HADES_API_KEY", "HADES_BASE_URL", "SWARM_BASE_URL", "OPENAI_BASE_URL"]
      : ["SWARM_API_KEY", "OPENAI_API_KEY", "HADES_BASE_URL", "SWARM_BASE_URL", "OPENAI_BASE_URL"];
    for (const name of names) if (process.env[name]) workerEnv[name] = process.env[name]!;
  }
  if (opts.mode === "process") workerEnv.HADES_WORKSPACE = resolve(opts.workspaceRoot ?? process.cwd());


  if (opts.mode === "inline") {
    const manager = await createInlineSwarm({
      capabilities,
      poolSize: opts.poolSize,
      planner,
      executor,
      stateStore,
      guardrailPolicy: opts.guardrailPolicy,
      maxAttempts: opts.maxAttempts,
      model: modelConfig?.model ?? opts.model,
    });
    return {
      manager,
      mode: "inline",
      async start() {
        await manager.loadState();
        await manager.ensurePool();
      },
      async stop() {
        await manager.shutdown();
      },
    };
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
    planner,
    stateStore,
    guardrailPolicy: opts.guardrailPolicy,
    workerLimits: opts.workerLimits,
    workerImage: opts.workerImage,
    workerEnv,
    maxAttempts: opts.maxAttempts,
    model: modelConfig?.model ?? opts.model,
  });

  return {
    manager,
    mode: opts.mode,
    controlPlane,
    async start() {
      await manager.loadState();
      await controlPlane.listen();
      await manager.ensurePool();
    },
    async stop() {
      await manager.shutdown();
    },
  };
}
