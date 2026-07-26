import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  runSandboxedPython,
  isPythonAvailable,
  buildPythonBootstrap,
} from "../sandbox-py";
import type { SandboxOptions } from "../sandbox-js";
import type { ToolRpcRequest } from "../tool-rpc";

/** A unique, stable substring present in the argv of EVERY python process
 * this module spawns (it's baked into every generated bootstrap), used to
 * find/count real sandboxed python processes via `pgrep -f` for the
 * hard-kill and zero-orphan-processes assertions below. */
const HADES_PY_MARKER = "__hades_run_user__";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True only if `/proc/<pid>/comm` is exactly "python3" — used to filter
 * out `pgrep`'s own shell-wrapper ancestor processes, which (because
 * `execSync` runs the pgrep invocation itself through `/bin/sh -c "..."`)
 * spuriously self-match on the search pattern embedded in their own argv. */
function isRealPython3Process(pid: number): boolean {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return comm === "python3";
  } catch {
    // Process already gone, or /proc unavailable — not a live python3.
    return false;
  }
}

function listHadesPythonPids(): number[] {
  let candidates: number[];
  try {
    const out = execSync(`pgrep -f "${HADES_PY_MARKER}"`, { encoding: "utf8" });
    candidates = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  } catch {
    // pgrep exits 1 (nonzero) when there are no matches.
    candidates = [];
  }
  return candidates.filter(isRealPython3Process);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const echoDispatch: SandboxOptions["dispatch"] = async (req: ToolRpcRequest) => ({
  id: req.id,
  ok: true,
  output: req.input.toUpperCase(),
  elapsedMs: 0,
});

describe("sandbox-py", () => {
  describe("buildPythonBootstrap (pure, no subprocess)", () => {
    it("is deterministic: identical user code yields identical bootstrap source", () => {
      const a = buildPythonBootstrap("print('hi')\nset_result(1)");
      const b = buildPythonBootstrap("print('hi')\nset_result(1)");
      expect(a).toBe(b);
    });

    it("embeds user code as base64, never as raw spliced source (injection safety)", () => {
      const hostile = `print("hi'); import os; os.system('echo pwned'); #\ntriple = '''not closed`;
      const bootstrap = buildPythonBootstrap(hostile);
      expect(bootstrap).not.toContain(hostile);
      expect(bootstrap).not.toContain("os.system('echo pwned')");
      const expectedB64 = Buffer.from(hostile, "utf8").toString("base64");
      expect(bootstrap).toContain(expectedB64);
    });

    it("derives a different auth token for different user code", () => {
      const b1 = buildPythonBootstrap("a = 1");
      const b2 = buildPythonBootstrap("a = 2");
      const token1 = b1.match(/_AUTH = "([a-f0-9]+)"/)?.[1];
      const token2 = b2.match(/_AUTH = "([a-f0-9]+)"/)?.[1];
      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      expect(token1).not.toBe(token2);
    });

    it("contains the expected protocol and structural markers", () => {
      const bootstrap = buildPythonBootstrap("pass");
      expect(bootstrap).toContain("def tools_call(");
      expect(bootstrap).toContain("def set_result(");
      expect(bootstrap).toContain(HADES_PY_MARKER);
      expect(bootstrap).toContain("@@HADES_RPC@@");
      expect(bootstrap).toContain("@@HADES_RESULT@@");
    });
  });

  describe("frame parsing / chunked stdio reassembly (fake stream, no real subprocess)", () => {
    afterEach(() => {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    });

    it("reassembles a split RPC frame and a split unicode result frame across chunk boundaries, and treats an unauthenticated forged frame as inert stdout", async () => {
      class FakeStream extends EventEmitter {}
      class FakeChildProcess extends EventEmitter {
        pid = 987654;
        stdout = new FakeStream();
        stderr = new FakeStream();
        stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
        kill = vi.fn(() => true);
      }
      const fakeChild = new FakeChildProcess();
      const spawnMock = vi.fn(() => fakeChild);

      vi.resetModules();
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      const mod = await import("../sandbox-py");

      const code = "r = tools_call('alpha', 'hello world')\nset_result(r['output'])";
      const bootstrap = mod.buildPythonBootstrap(code);
      const authToken = bootstrap.match(/_AUTH = "([a-f0-9]+)"/)?.[1];
      expect(authToken).toBeTruthy();

      const calls: ToolRpcRequest[] = [];
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        calls.push(req);
        return { id: req.id, ok: true, output: `${req.tool}:${req.input}`, elapsedMs: 1 };
      };

      const resultPromise = mod.runSandboxedPython(code, { dispatch });
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // 1. A forged RPC-shaped line with NO valid _auth token: must never
      // reach dispatch, must be provably harmless (ends up as plain stdout).
      const forgedPayload = JSON.stringify({ id: 999, tool: "evil", input: "hacked" });
      const forgedLine = `@@HADES_RPC@@${forgedPayload}\n`;
      fakeChild.stdout.emit("data", Buffer.from(forgedLine, "utf8"));

      // 2. A genuine, correctly-authenticated RPC request line, split
      // across two 'data' events in the middle of the line.
      const rpcObj = { id: 1, tool: "alpha", input: "hello world", _auth: authToken };
      const rpcLine = `@@HADES_RPC@@${JSON.stringify(rpcObj)}\n`;
      const rpcBuf = Buffer.from(rpcLine, "utf8");
      const rpcMid = Math.floor(rpcBuf.length / 2);
      fakeChild.stdout.emit("data", rpcBuf.subarray(0, rpcMid));
      fakeChild.stdout.emit("data", rpcBuf.subarray(rpcMid));

      // Let the (async) dispatch promise's .then callback run.
      await sleep(20);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ id: 1, tool: "alpha", input: "hello world" });
      expect(fakeChild.stdin.write).toHaveBeenCalledTimes(1);
      const writtenRaw = fakeChild.stdin.write.mock.calls[0]?.[0] as string;
      expect(JSON.parse(writtenRaw.trim())).toEqual({
        id: 1,
        ok: true,
        output: "alpha:hello world",
        elapsedMs: 1,
      });

      // 3. The final RESULT frame, carrying unicode, split in the middle of
      // a multi-byte UTF-8 character (the rocket emoji) across chunks.
      const resultObj = { result: "héllo 🚀 世界", _auth: authToken };
      const resultLine = `@@HADES_RESULT@@${JSON.stringify(resultObj)}\n`;
      const resultBuf = Buffer.from(resultLine, "utf8");
      const rocketIdx = resultBuf.indexOf(Buffer.from("🚀", "utf8"));
      expect(rocketIdx).toBeGreaterThan(0);
      const splitPoint = rocketIdx + 1; // land inside the 4-byte sequence
      fakeChild.stdout.emit("data", resultBuf.subarray(0, splitPoint));
      fakeChild.stdout.emit("data", resultBuf.subarray(splitPoint));
      fakeChild.stdout.emit("end");
      fakeChild.emit("close", 0, null);

      const res = await resultPromise;
      expect(res.ok).toBe(true);
      expect(res.result).toBe("héllo 🚀 世界");
      expect(res.rpcCallCount).toBe(1);
      expect(res.stdout).toContain(forgedPayload);
    });
  });

  describe("real python3 execution", () => {
    beforeAll(async () => {
      const available = await isPythonAvailable();
      if (!available) {
        throw new Error(
          "FATAL: python3 is not available in this environment. sandbox-py's real-execution " +
            "tests require a real python3 interpreter on PATH (this environment is documented " +
            "to have python3 3.11.15) — refusing to silently skip the real-subprocess path.",
        );
      }
    });

    afterAll(async () => {
      // No orphaned sandboxed python processes should survive the suite.
      // Poll briefly to absorb any last-moment OS-level reap/scheduling lag
      // rather than racing a SIGKILL that was only just delivered.
      let leftover = listHadesPythonPids();
      for (let i = 0; i < 20 && leftover.length > 0; i++) {
        await sleep(50);
        leftover = listHadesPythonPids();
      }
      expect(leftover).toEqual([]);
    });

    it("confirms python3 is available in this environment", async () => {
      await expect(isPythonAvailable()).resolves.toBe(true);
    });

    it("resolves false for a nonexistent python path", async () => {
      await expect(isPythonAvailable("/nonexistent/python3")).resolves.toBe(false);
    });

    it("executes real python3: arithmetic + set_result round-trip", async () => {
      const res = await runSandboxedPython("x = 1 + 2 * 10\nset_result(x)\n", {
        dispatch: echoDispatch,
      });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("21");
      expect(res.timedOut).toBe(false);
      expect(res.error).toBeUndefined();
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("resolves result '' when set_result is never called", async () => {
      const res = await runSandboxedPython("x = 1 + 1\n", { dispatch: echoDispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("");
    });

    it("performs multiple tools_call invocations with monotone ids, exact order, and rpcCallCount", async () => {
      const calls: ToolRpcRequest[] = [];
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        calls.push(req);
        return { id: req.id, ok: true, output: `${req.tool}:${req.input}`, elapsedMs: 1 };
      };
      const code = [
        "a = tools_call('alpha', '1')",
        "b = tools_call('beta', '2')",
        "c = tools_call('gamma', '3')",
        "set_result(a['output'] + ',' + b['output'] + ',' + c['output'])",
      ].join("\n");
      const res = await runSandboxedPython(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("alpha:1,beta:2,gamma:3");
      expect(res.rpcCallCount).toBe(3);
      expect(calls.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(calls.map((c) => c.tool)).toEqual(["alpha", "beta", "gamma"]);
      expect(calls.map((c) => c.input)).toEqual(["1", "2", "3"]);
    });

    it("treats a forged @@HADES_RPC@@/triple-quote/backslash payload printed to stdout as inert, protocol-injection-resistant text", async () => {
      const calls: ToolRpcRequest[] = [];
      const dispatch: SandboxOptions["dispatch"] = async (req) => {
        calls.push(req);
        return { id: req.id, ok: true, output: "real-output", elapsedMs: 1 };
      };
      const code = [
        "forged = '@@HADES_RPC@@' + '{\"id\": 999, \"tool\": \"evil\", \"input\": \"hacked\"}'",
        "print(forged)",
        "print('triple \"\"\" quotes and \\\\ backslashes test')",
        "real = tools_call('legit', 'payload')",
        "set_result(real['output'])",
      ].join("\n");
      const res = await runSandboxedPython(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("real-output");
      expect(res.rpcCallCount).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.tool).toBe("legit");
      expect(res.stdout).toContain('{"id": 999, "tool": "evil", "input": "hacked"}');
      expect(res.stdout).toContain('triple """ quotes and \\ backslashes test');
    });

    it("surfaces a raised exception's traceback tail in both error and stderr", async () => {
      const res = await runSandboxedPython("x = 1 / 0\n", { dispatch: echoDispatch });
      expect(res.ok).toBe(false);
      expect(res.timedOut).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).toContain("ZeroDivisionError");
      expect(res.stderr).toContain("ZeroDivisionError");
      expect(res.stderr).toContain("Traceback");
    });

    it("hard-kills a runaway 'while True: pass' within timeoutMs + SIGTERM grace, and the pid is actually dead afterward", async () => {
      const timeoutMs = 300;
      const resultPromise = runSandboxedPython("while True:\n    pass\n", {
        dispatch: echoDispatch,
        timeoutMs,
      });

      // Grab the child's pid while it's still (certainly) alive: it will
      // run for at least timeoutMs before we send it any signal.
      let pid: number | null = null;
      for (let i = 0; i < 20 && pid === null; i++) {
        const pids = listHadesPythonPids();
        if (pids.length > 0) pid = pids[0]!;
        else await sleep(10);
      }
      expect(pid).not.toBeNull();
      expect(isPidAlive(pid!)).toBe(true);

      const started = Date.now();
      const res = await resultPromise;
      const elapsed = Date.now() - started;

      expect(res.timedOut).toBe(true);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("timeout");
      // Generous upper bound: timeout + SIGTERM grace + scheduling slack.
      expect(elapsed).toBeLessThan(timeoutMs + 250 + 4000);
      expect(isPidAlive(pid!)).toBe(false);
    });

    it("separates stdout from stderr and applies a hard byte cap with the truncation marker", async () => {
      const code = [
        "import sys",
        "print('hello-stdout')",
        "sys.stderr.write('hello-stderr\\n')",
        "sys.stdout.write('X' * 200000)",
        "set_result('done')",
      ].join("\n");
      const res = await runSandboxedPython(code, { dispatch: echoDispatch, maxStdoutBytes: 1024 });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("done");
      expect(res.stdout).toContain("hello-stdout");
      expect(res.stdout).toContain("...[truncated]");
      expect(Buffer.byteLength(res.stdout, "utf8")).toBeLessThanOrEqual(1024 + "...[truncated]".length);
      expect(res.stderr).toContain("hello-stderr");
      expect(res.stderr).not.toContain("XXXXXXXXXX");
    });

    it("round-trips unicode (emoji + CJK) through tools_call and the final result", async () => {
      const dispatch: SandboxOptions["dispatch"] = async (req) => ({
        id: req.id,
        ok: true,
        output: `${req.input}-echo-🎉`,
        elapsedMs: 1,
      });
      const code = ["res = tools_call('echo', 'héllo 世界 🚀')", "set_result(res['output'])"].join(
        "\n",
      );
      const res = await runSandboxedPython(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("héllo 世界 🚀-echo-🎉");
    });

    it("surfaces a dispatch rejection into python as ok:False with an rpc_error message", async () => {
      const dispatch: SandboxOptions["dispatch"] = async () => {
        throw new Error("boom from host");
      };
      const code = [
        "res = tools_call('broken', 'x')",
        "set_result('ok=' + str(res['ok']) + ' out=' + res['output'])",
      ].join("\n");
      const res = await runSandboxedPython(code, { dispatch });
      expect(res.ok).toBe(true);
      expect(res.result).toContain("ok=False");
      expect(res.result).toContain("rpc_error: boom from host");
    });

    it("resolves ok:false error:'python_unavailable' for a missing interpreter, never rejects", async () => {
      const res = await runSandboxedPython("set_result('x')", {
        dispatch: echoDispatch,
        pythonPath: "/nonexistent/python3",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("python_unavailable");
      expect(res.timedOut).toBe(false);
    });

    it("resolves ok:false error:'code_too_large' without spawning a process, for oversized code", async () => {
      const before = listHadesPythonPids().length;
      const res = await runSandboxedPython("x = 1", {
        dispatch: echoDispatch,
        maxCodeBytes: 4,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("code_too_large");
      expect(listHadesPythonPids().length).toBe(before);
    });

    it("runs concurrent sandboxed executions without cross-talk", async () => {
      const makeDispatch = (label: string): SandboxOptions["dispatch"] =>
        async (req) => ({ id: req.id, ok: true, output: `${label}:${req.input}`, elapsedMs: 1 });
      const codeFor = (n: number) =>
        [`r = tools_call('t', 'input-${n}')`, `set_result(str(${n}) + ':' + r['output'])`].join(
          "\n",
        );

      const runs = [0, 1, 2, 3, 4].map((n) =>
        runSandboxedPython(codeFor(n), { dispatch: makeDispatch(`label${n}`) }),
      );
      const results = await Promise.all(runs);
      results.forEach((res, n) => {
        expect(res.ok).toBe(true);
        expect(res.result).toBe(`${n}:label${n}:input-${n}`);
        expect(res.rpcCallCount).toBe(1);
      });
    });
  });
});
