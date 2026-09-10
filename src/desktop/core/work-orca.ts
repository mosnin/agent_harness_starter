import type { WorkExecution } from "./durable-work";
import type { HelmOrcaService } from "./helm-orca-service";

export interface WorkOrcaHost {
  service: Pick<
    HelmOrcaService,
    "list" | "start" | "recover" | "status" | "stop"
  >;
  preflight(): void;
  wait?: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

/** Orca owns its isolated worktree. A terminal process is not accepted source output. */
export async function executeWorkOrca(
  host: WorkOrcaHost,
  input: WorkExecution,
  signal: AbortSignal,
) {
  const engine = input.engine;
  if (engine?.kind !== "orca") throw new Error("Orca engine was not selected");
  const scope = { root: input.root, profile: input.profile },
    now = host.now ?? Date.now;
  input.assertActive();
  signal.throwIfAborted();
  host.preflight(); // No effect/intent allocation when packaged artifacts are missing.
  input.assertActive();
  let owned = host.service.list(scope).find((r) => r.id === engine.requestId);
  let attempted = engine.dispatchIntent === true || !!owned;
  let stop: Promise<unknown> | undefined;
  const stopOwned = () => {
    if (!attempted) return;
    // A missing service receipt after a crash is not permission to create one.
    if (host.service.list(scope).some((r) => r.id === engine.requestId))
      stop ??= host.service
        .stop(scope, engine.requestId)
        .catch(() => undefined);
  };
  const abort = () => {
    try {
      stopOwned();
    } catch {
      /* Unknown stop is retained by Orca. */
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  const deadline = now() + input.maxRuntimeMs;
  try {
    if (engine.dispatchIntent && !owned)
      throw new Error(
        "Orca dispatch intent has no acknowledged service record. Inspect recovery; no request was replayed.",
      );
    if (!attempted) {
      input.markDispatchIntent();
      attempted = true;
      input.assertActive();
      signal.throwIfAborted();
      owned = await host.service.start(
        scope,
        {
          requestId: engine.requestId,
          prompt: input.prompt,
          agent: engine.agent,
          ...(engine.model ? { model: engine.model } : {}),
        },
        signal,
      );
    } else owned = await host.service.recover(scope, engine.requestId);
    input.assertActive();
    signal.throwIfAborted();
    while (owned.state === "ready" || owned.state === "starting") {
      if (now() >= deadline) {
        stopOwned();
        await stop;
        throw new Error(
          "Orca host observation deadline reached; inspect the retained worker and stop receipt. Provider usage remains unknown.",
        );
      }
      await (host.wait ?? pause)(signal);
      input.assertActive();
      owned = await host.service.status(scope, engine.requestId);
      input.assertActive();
      signal.throwIfAborted();
    }
    return {
      answer: "",
      tokens: Number.NaN,
      error: `Orca ${engine.requestId}: ${owned.state}. ${owned.error ?? ""} Provider token usage is unknown and the host reservation is retained. Output is unchecked; source integration and exact artifact acceptance are required. Resume only reconciles this intent.`,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      abort();
      await stop;
    }
  }
}
