/**
 * Container entrypoint for a swarm worker.
 *
 * This is the process that runs as PID 1 inside each isolated worker container
 * (or as a child process under LocalProcessProvider). It reads its identity and
 * the manager's address from the environment, connects to the control plane
 * over HTTP, and runs the {@link WorkerRuntime} loop until the container is
 * stopped.
 *
 * Environment (injected by the provider):
 *   SWARM_WORKER_ID     unique worker id
 *   SWARM_MANAGER_URL   base URL of the manager control plane
 *   SWARM_AUTH_TOKEN    shared bus bearer token
 *   SWARM_CAPABILITIES  comma-separated capability list
 *   SWARM_MODEL         (optional) model id for the executor
 */
import { HttpWorkerClient } from "../bus/http-worker-client";
import { WorkerRuntime } from "./runtime";

async function main(): Promise<void> {
  const workerId = required("SWARM_WORKER_ID");
  const managerUrl = required("SWARM_MANAGER_URL");
  const authToken = required("SWARM_AUTH_TOKEN");
  const capabilities = (process.env.SWARM_CAPABILITIES ?? "general")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const model = process.env.SWARM_MODEL;

  const bus = new HttpWorkerClient({ managerUrl, authToken });
  const runtime = new WorkerRuntime({ workerId, capabilities, bus, model });

  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // eslint-disable-next-line no-console
  console.log(`[worker ${workerId}] online, capabilities=[${capabilities.join(",")}]`);
  await runtime.start(abort.signal);
  // eslint-disable-next-line no-console
  console.log(`[worker ${workerId}] shutting down`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`[worker] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal:", e);
  process.exit(1);
});
