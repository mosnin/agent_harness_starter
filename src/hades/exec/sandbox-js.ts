/**
 * sandbox-js: runs model-written JavaScript inside a node:worker_threads
 * Worker, never in the host process's own V8 context (no eval / new Function
 * on the host side — only the worker, which is a separate isolate/thread,
 * ever evaluates user code).
 *
 * Isolation honesty (do not overclaim): worker_threads gives the sandboxed
 * code its own V8 isolate, heap and event loop. That is enough to stop a
 * runaway or buggy script from corrupting host memory or wedging the host's
 * event loop, and `worker.terminate()` gives us a hard, unconditional kill
 * even for a synchronous infinite loop. It is NOT a security boundary
 * against a hostile, resourceful adversary: the worker still has `require`,
 * `process`, filesystem and network access (to the extent the host process
 * itself has them), and V8-level side channels (timing, Spectre-class
 * attacks) are not mitigated. Treat this as crash/hang isolation for
 * cooperative model output, not a sandbox for adversarial code execution.
 * A capability-scoped tool bridge (below) is what actually limits what the
 * sandboxed code can *do*; the worker boundary limits how it can *fail*.
 */

import { Worker } from "node:worker_threads";
import type { ToolRpcRequest, ToolRpcResponse } from "./tool-rpc";

export interface SandboxOptions {
  dispatch: (req: ToolRpcRequest) => Promise<ToolRpcResponse>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxCodeBytes?: number;
}

export interface SandboxResult {
  ok: boolean;
  result: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  rpcCallCount: number;
  durationMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_STDOUT_BYTES = 65536;
const DEFAULT_MAX_CODE_BYTES = 262144;
const TRUNCATION_MARKER = "...[truncated]";

// ---------------------------------------------------------------------------
// Worker <-> host wire protocol (internal only, not exported).
// ---------------------------------------------------------------------------

type WorkerToHostMessage =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "rpc"; req: ToolRpcRequest }
  | { type: "done"; result: string }
  | { type: "error"; error: string };

type HostToWorkerMessage = { type: "rpc_result"; res: ToolRpcResponse };

/**
 * Source for the worker's entry point. This is `eval`'d ONLY by
 * `new Worker(..., { eval: true })`, i.e. only inside the spawned worker
 * thread — the host process (this file, running normally) never evaluates
 * any of this or any user code. Written as plain ES5-ish CommonJS since it
 * is compiled/parsed by V8 directly, not by our own TS toolchain.
 *
 * Ambient surface exposed to user code: exactly `tools.call(name, input)`
 * and `console.log/console.error/console.warn/console.info`, passed in as
 * explicit function parameters to an AsyncFunction — not picked up via
 * closure — so the only way user code observes them is through those two
 * names, even though (per the isolation-honesty note above) the worker's
 * real globals (`require`, `process`, etc.) remain reachable directly.
 */
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

let nextRpcId = 1;
const pendingRpc = new Map();

parentPort.on("message", function (msg) {
  if (msg && msg.type === "rpc_result" && msg.res) {
    const resolver = pendingRpc.get(msg.res.id);
    if (resolver) {
      pendingRpc.delete(msg.res.id);
      resolver(msg.res);
    }
  }
});

function toolsCall(name, input) {
  return new Promise(function (resolve) {
    const id = nextRpcId++;
    pendingRpc.set(id, function (res) {
      resolve({ ok: !!res.ok, output: typeof res.output === "string" ? res.output : "" });
    });
    parentPort.postMessage({
      type: "rpc",
      req: { id: id, tool: String(name), input: String(input) },
    });
  });
}

const tools = { call: toolsCall };

function stringifyArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch (e) {
    return String(a);
  }
}

function makeLogger(stream) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    const line = args.map(stringifyArg).join(" ");
    parentPort.postMessage({ type: stream, text: line + "\\n" });
  };
}

const sandboxConsole = {
  log: makeLogger("stdout"),
  info: makeLogger("stdout"),
  error: makeLogger("stderr"),
  warn: makeLogger("stderr"),
};

async function runUserCode() {
  const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;
  const userFn = new AsyncFunctionCtor("tools", "console", workerData.code);
  const value = await userFn(tools, sandboxConsole);
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

runUserCode().then(
  function (result) {
    parentPort.postMessage({ type: "done", result: result });
  },
  function (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ type: "error", error: message });
  }
);
`;

/** Accumulates a stream up to a hard byte cap, appending a truncation marker once exceeded. */
class CappedStreamCollector {
  private readonly parts: string[] = [];
  private byteLength = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(text: string): void {
    if (this.truncated || text.length === 0) return;

    const incomingBytes = Buffer.byteLength(text, "utf8");
    if (this.byteLength + incomingBytes <= this.maxBytes) {
      this.parts.push(text);
      this.byteLength += incomingBytes;
      return;
    }

    const remaining = this.maxBytes - this.byteLength;
    if (remaining > 0) {
      const buf = Buffer.from(text, "utf8");
      let cut = Math.min(remaining, buf.length);
      // Never split a multi-byte UTF-8 sequence: back off to a byte that
      // isn't a continuation byte (10xxxxxx).
      while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
      const kept = buf.subarray(0, cut).toString("utf8");
      this.parts.push(kept);
      this.byteLength += Buffer.byteLength(kept, "utf8");
    }
    this.parts.push(TRUNCATION_MARKER);
    this.truncated = true;
  }

  toString(): string {
    return this.parts.join("");
  }
}

function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Runs `code` inside an isolated worker thread. Never rejects: every
 * failure mode (syntax error, thrown exception, worker crash, dispatch
 * rejection, timeout) resolves to a structured {@link SandboxResult}.
 */
export function runSandboxedJs(code: string, opts: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxCodeBytes = opts.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;

  const startedAt = process.hrtime.bigint();

  return new Promise<SandboxResult>((resolvePromise) => {
    let settled = false;
    const resolveOnce = (partial: Omit<SandboxResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      resolvePromise({ ...partial, durationMs });
    };

    const codeBytes = Buffer.byteLength(code, "utf8");
    if (codeBytes > maxCodeBytes) {
      resolveOnce({
        ok: false,
        result: "",
        stdout: "",
        stderr: "",
        timedOut: false,
        rpcCallCount: 0,
        error: "code_too_large",
      });
      return;
    }

    const stdout = new CappedStreamCollector(maxStdoutBytes);
    const stderr = new CappedStreamCollector(maxStdoutBytes);
    let rpcCallCount = 0;
    let timedOut = false;

    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { code } });
    } catch (spawnErr) {
      const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      resolveOnce({
        ok: false,
        result: "",
        stdout: "",
        stderr: "",
        timedOut: false,
        rpcCallCount: 0,
        error: `spawn_error: ${message}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // Resolve immediately: `worker.terminate()` forcibly stops the worker,
      // which always reports exit code 1 (that is simply what a forced
      // termination looks like, not a semantic failure code from user code),
      // and its returned promise settles via the same "exit" event our own
      // listener below observes. Gating our resolution on that promise would
      // race the "exit" listener below, which would then win with a bogus
      // "worker_exited_unexpectedly" result. So: resolve first with the
      // authoritative timeout result, then terminate (fire-and-forget) purely
      // for cleanup — resolveOnce's idempotency makes the later "exit" event
      // a harmless no-op.
      resolveOnce({
        ok: false,
        result: "",
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut: true,
        rpcCallCount,
        error: "timeout",
      });
      void worker.terminate().catch(() => undefined);
    }, timeoutMs);
    // Never let the sandbox's internal watchdog keep the host process alive.
    timer.unref?.();

    const clearTimer = (): void => clearTimeout(timer);

    const finishAfterTerminate = (partial: Omit<SandboxResult, "durationMs">): void => {
      clearTimer();
      // See the timeout branch above for why we resolve before terminating
      // rather than waiting on terminate()'s promise.
      resolveOnce(partial);
      void worker.terminate().catch(() => undefined);
    };

    worker.on("message", (raw: unknown) => {
      if (!isWorkerToHostMessage(raw)) return;

      switch (raw.type) {
        case "stdout":
          stdout.push(raw.text);
          return;
        case "stderr":
          stderr.push(raw.text);
          return;
        case "rpc": {
          rpcCallCount += 1;
          const req = raw.req;
          opts.dispatch(req).then(
            (res) => {
              const reply: HostToWorkerMessage = { type: "rpc_result", res };
              try {
                worker.postMessage(reply);
              } catch {
                // Worker may already be gone (e.g. timed out); nothing to do.
              }
            },
            (dispatchErr: unknown) => {
              const message = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
              // ToolRpcResponse.error is the locked ToolRpcErrorCode union
              // (owned by tool-rpc.ts), not a free-form string, so a
              // dispatch-level rejection (as opposed to a normal tool-level
              // failure, which the real bridge already encodes with a more
              // specific code) is reported as "tool_error"; the actual
              // message is preserved in `output` for the sandboxed caller.
              const res: ToolRpcResponse = {
                id: req.id,
                ok: false,
                output: `rpc_error: ${message}`,
                error: "tool_error",
                elapsedMs: 0,
              };
              const reply: HostToWorkerMessage = { type: "rpc_result", res };
              try {
                worker.postMessage(reply);
              } catch {
                // Worker may already be gone (e.g. timed out); nothing to do.
              }
            },
          );
          return;
        }
        case "done":
          finishAfterTerminate({
            ok: true,
            result: raw.result,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            timedOut: false,
            rpcCallCount,
          });
          return;
        case "error":
          finishAfterTerminate({
            ok: false,
            result: "",
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            timedOut: false,
            rpcCallCount,
            error: raw.error,
          });
          return;
        default:
          return;
      }
    });

    worker.on("error", (err: Error) => {
      clearTimer();
      resolveOnce({
        ok: false,
        result: "",
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        rpcCallCount,
        error: `worker_error: ${err.message}`,
      });
    });

    worker.on("exit", (exitCode: number) => {
      clearTimer();
      // If a "done"/"error"/timeout path already resolved us, this is a
      // harmless no-op (resolveOnce is idempotent). This branch only ever
      // produces the final result when the worker exits on its own without
      // ever posting "done"/"error" (e.g. process.exit() called from user
      // code, or an abrupt native crash).
      resolveOnce({
        ok: false,
        result: "",
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        rpcCallCount,
        error: `worker_exited_unexpectedly: code ${exitCode}`,
      });
    });
  });
}
