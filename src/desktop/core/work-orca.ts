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
  let stopRequested = false;
  const lifetime = new AbortController();
  const deadlineError = new Error("Orca host observation deadline reached; inspect the retained worker and stop receipt. Provider usage remains unknown.");
  const deadline = now() + input.maxRuntimeMs;
  const timer = setTimeout(() => lifetime.abort(deadlineError), input.maxRuntimeMs);
  const parentAbort = () => lifetime.abort(signal.reason);
  signal.addEventListener("abort", parentAbort, { once: true });
  if (signal.aborted) parentAbort();
  const stopOwned = () => {
    if (!attempted) return;
    // A missing service receipt after a crash is not permission to create one.
    if (!stopRequested && host.service.list(scope).some((r) => r.id === engine.requestId)) {
      stopRequested = true;
      void Promise.resolve(host.service.stop(scope, engine.requestId)).catch(() => undefined);
    }
  };
  const abort = () => {
    try {
      stopOwned();
    } catch {
      /* Unknown stop is retained by Orca. */
    }
  };
  lifetime.signal.addEventListener("abort", abort, { once: true });
  const guard = () => {
    if (now() >= deadline && !lifetime.signal.aborted) lifetime.abort(deadlineError);
    lifetime.signal.throwIfAborted();
    try { input.assertActive(); } catch (error) { lifetime.abort(error); throw error; }
  };
  // Retain a rejection handler on detached calls; a late reply never resumes this execution.
  const bounded = <T>(call: () => Promise<T>): Promise<T> => {
    guard();
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(lifetime.signal.reason);
      lifetime.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(() => { guard(); return call(); }).then(
        (value) => {
          lifetime.signal.removeEventListener("abort", cancelled);
          if (lifetime.signal.aborted) { abort(); reject(lifetime.signal.reason); return; }
          try { guard(); resolve(value); } catch (error) { reject(error); }
        },
        (error: unknown) => {
          lifetime.signal.removeEventListener("abort", cancelled);
          if (lifetime.signal.aborted) abort();
          reject(error);
        },
      );
    });
  };
  try {
    guard();
    if (engine.dispatchIntent && !owned)
      throw new Error(
        "Orca dispatch intent has no acknowledged service record. Inspect recovery; no request was replayed.",
      );
    if (!attempted) {
      input.markDispatchIntent();
      attempted = true;
      guard();
      owned = await bounded(() => host.service.start(
        scope,
        {
          requestId: engine.requestId,
          prompt: input.prompt,
          agent: engine.agent,
          ...(engine.model ? { model: engine.model } : {}),
        },
        lifetime.signal,
      ));
    } else owned = await bounded(() => host.service.recover(scope, engine.requestId));
    guard();
    while (owned.state === "ready" || owned.state === "starting") {
      await bounded(() => (host.wait ?? pause)(lifetime.signal));
      guard();
      owned = await bounded(() => host.service.status(scope, engine.requestId));
      guard();
    }
    return {
      answer: "",
      tokens: Number.NaN,
      error: `Orca ${engine.requestId}: ${owned.state}. ${owned.error ?? ""} Provider token usage is unknown and the host reservation is retained. Output is unchecked; source integration and exact artifact acceptance are required. Resume only reconciles this intent.`,
    };
  } catch (error) {
    lifetime.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", parentAbort);
    lifetime.signal.removeEventListener("abort", abort);
    if (lifetime.signal.aborted) abort();
  }
}
