import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runSandboxedJs, type SandboxOptions } from "../sandbox-js";
import type { ToolRpcRequest, ToolRpcResponse } from "../tool-rpc";

const TRUNCATION_MARKER = "...[truncated]";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counts currently-live worker-thread-related handles (undocumented Node
 * internal, used here only as a real-world leak signal in tests). */
function countWorkerHandles(): number {
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  const handles = getActiveHandles ? getActiveHandles.call(process) : [];
  return handles.filter((h) => {
    const ctorName = (h as { constructor?: { name?: string } })?.constructor?.name;
    return ctorName === "Worker" || ctorName === "MessagePort";
  }).length;
}

const echoDispatch: SandboxOptions["dispatch"] = async (req: ToolRpcRequest) => ({
  id: req.id,
  ok: true,
  output: `${req.input.toUpperCase()}`,
  elapsedMs: 0,
});

describe("runSandboxedJs", () => {
  describe("happy path execution", () => {
    it("returns a computed value", async () => {
      const res = await runSandboxedJs("return 1 + 2 * 10;", { dispatch: echoDispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("21");
      expect(res.timedOut).toBe(false);
      expect(res.error).toBeUndefined();
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns '' for undefined / no return", async () => {
      const res = await runSandboxedJs("const x = 1;", { dispatch: echoDispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("");
    });

    it("JSON-stringifies an object return value", async () => {
      const res = await runSandboxedJs("return { a: 1, b: 'x', c: [1, 2, 3] };", {
        dispatch: echoDispatch,
      });
      expect(res.ok).toBe(true);
      expect(JSON.parse(res.result)).toEqual({ a: 1, b: "x", c: [1, 2, 3] });
    });

    it("round-trips unicode through the result", async () => {
      const res = await runSandboxedJs("return 'héllo 🚀 世界';", {
        dispatch: echoDispatch,
      });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("héllo 🚀 世界");
    });
  });

  describe("tools.call RPC bridge", () => {
    it("performs sequential tools.call round-trips via the injected dispatch", async () => {
      const calls: ToolRpcRequest[] = [];
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        calls.push(req);
        return { id: req.id, ok: true, output: `${req.tool}:${req.input}`, elapsedMs: 1 };
      };
      const code = `
        const a = await tools.call("alpha", "1");
        const b = await tools.call("beta", "2");
        return JSON.stringify([a.output, b.output]);
      `;
      const res = await runSandboxedJs(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(JSON.parse(res.result)).toEqual(["alpha:1", "beta:2"]);
      expect(res.rpcCallCount).toBe(2);
      expect(calls.map((c) => c.tool)).toEqual(["alpha", "beta"]);
      // ids are worker-assigned, monotone from 1
      expect(calls.map((c) => c.id)).toEqual([1, 2]);
    });

    it("performs concurrent tools.call round-trips (echo/uppercase dispatch)", async () => {
      const code = `
        const [a, b, c] = await Promise.all([
          tools.call("echo", "one"),
          tools.call("echo", "two"),
          tools.call("echo", "three"),
        ]);
        return JSON.stringify([a.output, b.output, c.output]);
      `;
      const res = await runSandboxedJs(code, { dispatch: echoDispatch });
      expect(res.ok).toBe(true);
      expect(JSON.parse(res.result)).toEqual(["ONE", "TWO", "THREE"]);
      expect(res.rpcCallCount).toBe(3);
    });

    it("resolves out-of-order RPC responses to the correct caller by id", async () => {
      // "slow" is dispatched first but answers last; if the bridge matched
      // responses by arrival order instead of id, the "slow" call would
      // incorrectly receive the "fast" answer.
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        const delayMs = req.tool === "slow" ? 60 : 5;
        await sleep(delayMs);
        return { id: req.id, ok: true, output: `${req.tool}:${req.input}`, elapsedMs: delayMs };
      };
      const code = `
        const pSlow = tools.call("slow", "X");
        const pFast = tools.call("fast", "Y");
        const [a, b] = await Promise.all([pSlow, pFast]);
        return JSON.stringify([a.output, b.output]);
      `;
      const res = await runSandboxedJs(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(JSON.parse(res.result)).toEqual(["slow:X", "fast:Y"]);
      expect(res.rpcCallCount).toBe(2);
    });

    it("counts rpcCallCount exactly under high concurrency", async () => {
      const N = 25;
      let dispatchCount = 0;
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        dispatchCount++;
        return { id: req.id, ok: true, output: req.input, elapsedMs: 0 };
      };
      const code = `
        const calls = [];
        for (let i = 0; i < ${N}; i++) calls.push(tools.call("t", String(i)));
        const results = await Promise.all(calls);
        return results.length;
      `;
      const res = await runSandboxedJs(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe(String(N));
      expect(res.rpcCallCount).toBe(N);
      expect(dispatchCount).toBe(N);
    });

    it("surfaces a rejecting dispatch as a structured rpc_error, never crashing the sandbox", async () => {
      const dispatch: SandboxOptions["dispatch"] = async () => {
        throw new Error("dispatch boom");
      };
      const code = `
        const r = await tools.call("x", "y");
        return JSON.stringify(r);
      `;
      const res = await runSandboxedJs(code, { dispatch });
      expect(res.ok).toBe(true);
      const parsed = JSON.parse(res.result) as { ok: boolean; output: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.output).toBe("rpc_error: dispatch boom");
    });

    it("times out the sandbox when dispatch never settles", async () => {
      const dispatch: SandboxOptions["dispatch"] = () => new Promise<ToolRpcResponse>(() => {});
      const code = `
        await tools.call("x", "y");
        return "unreachable";
      `;
      const res = await runSandboxedJs(code, { dispatch, timeoutMs: 200 });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(true);
      expect(res.error).toBe("timeout");
      expect(res.durationMs).toBeGreaterThanOrEqual(180);
      expect(res.durationMs).toBeLessThan(2000);
    });
  });

  describe("error handling", () => {
    it("resolves (never rejects) on a syntax error", async () => {
      const res = await runSandboxedJs("this is not [valid js syntax (((", {
        dispatch: echoDispatch,
      });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(false);
      expect(typeof res.error).toBe("string");
      expect(res.error!.length).toBeGreaterThan(0);
    });

    it("surfaces a thrown error's message", async () => {
      const res = await runSandboxedJs("throw new Error('boom from sandbox');", {
        dispatch: echoDispatch,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("boom from sandbox");
    });

    it("resolves ok:false, code_too_large without spawning a worker when code exceeds maxCodeBytes", async () => {
      const bigCode = `// ${"x".repeat(200)}\nreturn 1;`;
      const res = await runSandboxedJs(bigCode, { dispatch: echoDispatch, maxCodeBytes: 32 });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("code_too_large");
      expect(res.timedOut).toBe(false);
      expect(res.rpcCallCount).toBe(0);
      // No worker was ever spawned, so this should resolve near-instantly.
      expect(res.durationMs).toBeLessThan(50);
    });

    it("handles a worker exiting on its own (process.exit) via the exit event, not a hang", async () => {
      const res = await runSandboxedJs("process.exit(1); return 'never';", {
        dispatch: echoDispatch,
        timeoutMs: 3000,
      });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(false);
      expect(res.error).toMatch(/exit/i);
    });
  });

  describe("hard wall-clock kill", () => {
    it("terminates an infinite synchronous loop within timeoutMs + slack and leaves no active handle", async () => {
      const before = countWorkerHandles();
      const timeoutMs = 250;
      const res = await runSandboxedJs("while (true) {}", { dispatch: echoDispatch, timeoutMs });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(true);
      expect(res.error).toBe("timeout");
      // Real proof the kill was prompt, not that the test just waited for
      // vitest's own timeout to eventually reap things.
      expect(res.durationMs).toBeGreaterThanOrEqual(timeoutMs - 20);
      expect(res.durationMs).toBeLessThan(timeoutMs + 2000);

      // Give the terminate()'d worker's handles a tick to fully unwind, then
      // confirm no worker-thread handle is left registered on the process —
      // i.e. nothing keeping the (v)itest process from exiting cleanly.
      await sleep(50);
      const after = countWorkerHandles();
      expect(after).toBeLessThanOrEqual(before);
    });

    it("does not leak handles across repeated timeout kills", async () => {
      for (let i = 0; i < 3; i++) {
        const res = await runSandboxedJs("while (true) {}", {
          dispatch: echoDispatch,
          timeoutMs: 100,
        });
        expect(res.timedOut).toBe(true);
      }
      await sleep(50);
      expect(countWorkerHandles()).toBe(0);
    });
  });

  describe("stdout / stderr capture", () => {
    it("captures stdout and stderr separately, preserving per-stream order", async () => {
      const code = `
        console.log("out1");
        console.error("err1");
        console.log("out2");
        console.error("err2");
        return "done";
      `;
      const res = await runSandboxedJs(code, { dispatch: echoDispatch });
      expect(res.ok).toBe(true);
      expect(res.stdout).toBe("out1\nout2\n");
      expect(res.stderr).toBe("err1\nerr2\n");
    });

    it("truncates stdout with an exact trailing marker at the byte cap (single oversized write)", async () => {
      const res = await runSandboxedJs('console.log("A".repeat(100)); return "ok";', {
        dispatch: echoDispatch,
        maxStdoutBytes: 20,
      });
      expect(res.ok).toBe(true);
      expect(res.stdout).toBe("A".repeat(20) + TRUNCATION_MARKER);
    });

    it("truncates mid-write when the cap falls between two console.log calls", async () => {
      const code = `
        console.log("abc");
        console.log("defgh");
        return "ok";
      `;
      const res = await runSandboxedJs(code, { dispatch: echoDispatch, maxStdoutBytes: 6 });
      expect(res.ok).toBe(true);
      // "abc\n" = 4 bytes fits; "defgh\n" = 6 bytes overflows with 2 bytes
      // of room left ("de"), then the marker.
      expect(res.stdout).toBe("abc\nde" + TRUNCATION_MARKER);
    });

    it("caps stdout and stderr independently", async () => {
      const code = `
        console.log("x".repeat(50));
        console.error("y".repeat(5));
        return "ok";
      `;
      const res = await runSandboxedJs(code, { dispatch: echoDispatch, maxStdoutBytes: 10 });
      expect(res.stdout).toBe("x".repeat(10) + TRUNCATION_MARKER);
      expect(res.stderr).toBe("yyyyy\n");
    });
  });

  describe("no unhandled rejections", () => {
    let unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled = [];
      process.on("unhandledRejection", onUnhandled);
    });

    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
    });

    it("produces zero unhandled rejections across reject / never-settle / happy scenarios", async () => {
      const rejectingDispatch: SandboxOptions["dispatch"] = async () => {
        throw new Error("nope");
      };
      const neverSettleDispatch: SandboxOptions["dispatch"] = () =>
        new Promise<ToolRpcResponse>(() => {});

      await Promise.all([
        runSandboxedJs('const r = await tools.call("a","b"); return JSON.stringify(r);', {
          dispatch: rejectingDispatch,
        }),
        runSandboxedJs('await tools.call("a","b"); return "x";', {
          dispatch: neverSettleDispatch,
          timeoutMs: 150,
        }),
        runSandboxedJs("return 1 + 1;", { dispatch: echoDispatch }),
        runSandboxedJs("throw new Error('boom');", { dispatch: echoDispatch }),
        runSandboxedJs("while (true) {}", { dispatch: echoDispatch, timeoutMs: 150 }),
      ]);

      // Give any straggling microtask/macrotask a chance to surface.
      await sleep(50);
      expect(unhandled).toEqual([]);
    });
  });
});
