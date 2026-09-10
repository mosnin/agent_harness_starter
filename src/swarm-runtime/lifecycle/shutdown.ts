export interface ShutdownOptions {
  /** Signals to trap. Default SIGINT + SIGTERM. */
  signals?: NodeJS.Signals[];
  /** Force-exit after this long if cleanup hangs. Default 10s. */
  timeoutMs?: number;
  /** Process exit fn (injectable for tests). Default process.exit. */
  exit?: (code: number) => void;
  /** Log sink for shutdown messages. */
  log?: (msg: string) => void;
}

export interface ShutdownController {
  /** Run cleanup at most once. Safe to call repeatedly. */
  run(code?: number): Promise<void>;
  /** Remove the installed signal handlers. */
  uninstall(): void;
  /** Whether cleanup has already run. */
  isDone(): boolean;
}

/**
 * Install idempotent graceful-shutdown handling. On SIGINT/SIGTERM (or a manual
 * `run()`), cleanup runs exactly once; a hard timeout force-exits if cleanup
 * hangs, so a wedged drain can never leave a container stuck. Injectable `exit`
 * makes the whole thing unit-testable without killing the test process.
 */
export function installGracefulShutdown(
  cleanup: () => Promise<void>,
  opts: ShutdownOptions = {}
): ShutdownController {
  let ran = false;
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const run = async (code = 0): Promise<void> => {
    if (ran) return;
    ran = true;
    const timer = setTimeout(() => {
      log("shutdown timed out; forcing exit");
      exit(1);
    }, timeoutMs);
    timer.unref?.();
    try {
      await cleanup();
    } catch (e) {
      log(`cleanup error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const signals = opts.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[]);
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const sig of signals) {
    const h = () => {
      log(`received ${sig}, shutting down…`);
      void run(0).then(() => exit(0));
    };
    process.on(sig, h);
    handlers.push([sig, h]);
  }

  return {
    run,
    uninstall: () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    },
    isDone: () => ran,
  };
}
