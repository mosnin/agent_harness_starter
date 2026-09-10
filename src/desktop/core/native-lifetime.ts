/** The GUI starts the sidecar in its own process group. Bound teardown even
 * when a native syscall never returns, or the GUI crashes without sending EOF.
 * Headless/imported callers never acquire process-group authority. */
export function nativeLifetime(options: {
  parent: number; parentNow: () => number; stop: () => void;
  terminate: () => void; intervalMs?: number; graceMs?: number;
}) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    deadline = setTimeout(options.terminate, options.graceMs ?? 2000);
    options.stop();
  };
  const poll = setInterval(() => {
    if (options.parentNow() !== options.parent) stop();
  }, options.intervalMs ?? 250);
  poll.unref();
  return {
    stop,
    finish() {
      clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      // There is no surviving native owner to clean up the process group.
      if (options.parentNow() !== options.parent) options.terminate();
    },
  };
}
