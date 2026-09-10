/**
 * sandbox-py: runs model-written Python inside a real `python3` subprocess
 * (isolated mode, `-I`), spoken to over dedicated newline-delimited-JSON
 * frames multiplexed onto the child's stdio pipes. This is the Python
 * sibling of `sandbox-js.ts` (worker_threads for JS); the isolation
 * primitive here is a whole OS process instead of a V8 isolate, so a hard
 * kill is `SIGKILL` on the child pid rather than `worker.terminate()`.
 *
 * REAL vs MOCK: `runSandboxedPython` always spawns a genuine `python3`
 * (or `opts.pythonPath`) child process via `node:child_process.spawn` with
 * `shell: false` and executes real Python bytecode. There is no fallback
 * that fabricates a result when Python is missing — `isPythonAvailable`
 * and the `python_unavailable` error path exist precisely so a missing
 * interpreter is reported honestly instead of silently faked.
 *
 * Isolation honesty (do not overclaim, mirrors the note in `sandbox-js.ts`):
 * a plain `python3 -I` subprocess gives us real crash/hang isolation (a
 * runaway or buggy script cannot corrupt the host Node process's memory,
 * and `SIGKILL` is an unconditional, OS-enforced hard stop even for a
 * synchronous `while True: pass`) and `-I` isolated mode additionally
 * strips `site`-derived `sys.path` entries and ignores `PYTHON*` env vars,
 * so the child doesn't inherit the *host's* installed-package surface by
 * accident. It is NOT an adversarial security sandbox: the child still has
 * the full standard library, including `os`, `socket`, `subprocess`, etc.,
 * to whatever extent the OS user running this process has access to them.
 * Treat this as crash/hang isolation plus a capability-scoped tool bridge
 * for cooperative model output, not confinement against a hostile,
 * resourceful adversary.
 *
 * ---------------------------------------------------------------------
 * Wire protocol
 * ---------------------------------------------------------------------
 * The child's stdout (fd 1) carries three kinds of lines:
 *   1. Ordinary user output (whatever the Python code `print()`s).
 *   2. RPC *requests*, one per line, prefixed `@@HADES_RPC@@` followed by
 *      JSON `{ id, tool, input, _auth }` (id monotone from 1, assigned by
 *      the Python-side `tools_call` helper).
 *   3. Exactly one RPC *result* frame at the very end, prefixed
 *      `@@HADES_RESULT@@` followed by JSON `{ result, _auth, error? }`.
 * The host answers each RPC request by writing one line of JSON — the
 * full `ToolRpcResponse` shape `{ id, ok, output, error?, elapsedMs }` —
 * to the child's stdin (fd 0), which the blocking Python-side
 * `tools_call` reads back synchronously.
 *
 * `_auth` is a token derived deterministically from the user code itself
 * (`sha256(userCode).slice(0, 32)`), embedded once into the generated
 * bootstrap and known independently by the host (which also has the
 * original `userCode` in scope). It is NOT a capability-token secret and
 * is not meant to defend against an adversary willing to read its own
 * source via frame introspection (`sys._getframe`) and recompute the
 * hash — that is out of scope per the isolation-honesty note above. Its
 * purpose is narrower and concrete: **protocol-injection resistance
 * against a user program's own stdout output.** Model-written Python is
 * free to `print()` arbitrary text, including text that happens to start
 * with `@@HADES_RPC@@` or `@@HADES_RESULT@@` followed by well-formed
 * JSON — accidentally (echoing input) or as a deliberate probe. Chosen
 * behavior: such a line is **provably harmless** — the host validates
 * `_auth` before treating any prefixed line as a genuine protocol frame;
 * a forged line whose `_auth` is missing or wrong is dispatched to
 * *nobody* and instead flows straight into `SandboxResult.stdout`
 * verbatim, exactly like any other line of output. `rpcCallCount` is
 * only incremented for frames that pass the `_auth` check, so a forged
 * line can never masquerade as a dispatched tool call, exhaust the host's
 * call budget, or trigger a real tool invocation. This is exercised by
 * the "protocol-injection resistance" test in the suite.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ToolRpcRequest, ToolRpcResponse } from "./tool-rpc";
import type { SandboxOptions, SandboxResult } from "./sandbox-js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_STDOUT_BYTES = 65536;
const DEFAULT_MAX_CODE_BYTES = 262144;
const TRUNCATION_MARKER = "...[truncated]";
const SIGTERM_GRACE_MS = 250;
const RPC_PREFIX = "@@HADES_RPC@@";
const RESULT_PREFIX = "@@HADES_RESULT@@";
const AVAILABILITY_CHECK_TIMEOUT_MS = 5000;
const ERROR_TAIL_MAX_CHARS = 4000;
/** Safety valve against an unbounded single line (no newline yet) growing
 * forever in memory before we ever get a chance to apply the byte cap. */
const LINE_BUFFER_HARD_CAP_SLACK_BYTES = 65536;

// ---------------------------------------------------------------------------
// Auth token derivation (shared by bootstrap generation and frame
// validation — see the file-level doc comment for why this is safe to
// derive from `userCode` alone with no extra plumbing).
// ---------------------------------------------------------------------------

function computeAuthToken(userCode: string): string {
  return createHash("sha256").update(userCode, "utf8").digest("hex").slice(0, 32);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function tailOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${TRUNCATION_MARKER}\n${text.slice(text.length - maxChars)}`;
}

// ---------------------------------------------------------------------------
// Byte-safe capped stream collector (same algorithm/marker as sandbox-js's
// internal CappedStreamCollector; duplicated here because sandbox-js only
// exports types, per the locked import contract).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildPythonBootstrap — pure, deterministic: same userCode always yields
// the same bootstrap source (same base64 blob, same auth token). No
// naive string splicing: the user's source is base64-encoded on the Node
// side and base64-decoded again inside Python before being exec()'d, so
// nothing about its literal content (quotes, backslashes, triple-quotes,
// embedded `-c` terminators) can perturb the surrounding bootstrap source
// — the base64 alphabet contains none of Python's or the shell-less
// argv's special characters.
// ---------------------------------------------------------------------------

/**
 * Builds the full Python source passed as the single argument to
 * `python3 -I -c <bootstrap>`. Exposes exactly two names to the user's
 * code: `tools_call(name: str, input: str) -> dict` (blocking, returns
 * `{"ok": bool, "output": str}`) and `set_result(value)` (str()-ifies
 * `value` and stashes it as the sandbox's final result; absent a call,
 * the result is `""`). User code runs via `exec()` inside a fresh
 * globals dict built inside a dedicated bootstrap function
 * (`__hades_run_user__`), with `tools_call`/`set_result` passed in as
 * explicit parameters rather than picked up by closure — the user's own
 * top-level names never leak into or collide with the bootstrap's
 * internal state (the base64 blob, the RPC id counter, etc.), and vice
 * versa.
 */
export function buildPythonBootstrap(userCode: string): string {
  const codeB64 = Buffer.from(userCode, "utf8").toString("base64");
  const authToken = computeAuthToken(userCode);

  return [
    "import sys, json, base64, traceback",
    "",
    `_AUTH = "${authToken}"`,
    `_CODE_B64 = "${codeB64}"`,
    "",
    // Every protocol frame (RPC request or the final result) MUST start on
    // its own fresh line, or a preceding user write that didn't end in a
    // newline (e.g. `sys.stdout.write("x")` with no trailing "\n") would
    // silently glue onto our frame prefix and the host's line-based parser
    // would never recognize it as a frame. We wrap sys.stdout so every
    // write — the user's own and ours — updates a "currently at the start
    // of a line" flag, and frame emission consults it to prepend a "\n"
    // only when actually needed (never inserting a spurious blank line
    // into otherwise-clean output).
    "class _FrameSafeStdout:",
    "    def __init__(self, real):",
    "        self._real = real",
    "        self.at_line_start = True",
    "",
    "    def write(self, s):",
    "        if not s:",
    "            return 0",
    "        self._real.write(s)",
    '        self.at_line_start = s.endswith("\\n")',
    "        return len(s)",
    "",
    "    def flush(self):",
    "        self._real.flush()",
    "",
    "    def __getattr__(self, name):",
    "        return getattr(self._real, name)",
    "",
    "_stdout = _FrameSafeStdout(sys.stdout)",
    "sys.stdout = _stdout",
    "",
    "def _emit_frame(prefix, payload):",
    "    if not _stdout.at_line_start:",
    '        _stdout.write("\\n")',
    "    _stdout.write(prefix + json.dumps(payload) + \"\\n\")",
    "    _stdout.flush()",
    "",
    "_next_id = [1]",
    "",
    "def tools_call(name, input):",
    "    _id = _next_id[0]",
    "    _next_id[0] += 1",
    '    req = {"id": _id, "tool": str(name), "input": str(input), "_auth": _AUTH}',
    '    _emit_frame("@@HADES_RPC@@", req)',
    "    while True:",
    "        _resp_line = sys.stdin.readline()",
    '        if _resp_line == "":',
    '            raise RuntimeError("hades_rpc_channel_closed")',
    '        _resp_line = _resp_line.rstrip("\\n")',
    "        try:",
    "            _res = json.loads(_resp_line)",
    "        except Exception:",
    "            continue",
    '        if isinstance(_res, dict) and _res.get("id") == _id:',
    '            return {"ok": bool(_res.get("ok")), "output": str(_res.get("output", ""))}',
    "",
    '_result_box = {"value": ""}',
    "",
    "def set_result(value):",
    '    _result_box["value"] = str(value)',
    "",
    "def __hades_run_user__(tools_call, set_result):",
    '    _user_src = base64.b64decode(_CODE_B64).decode("utf-8")',
    "    _user_globals = {",
    '        "tools_call": tools_call,',
    '        "set_result": set_result,',
    '        "__name__": "__hades_user__",',
    '        "__builtins__": __builtins__,',
    "    }",
    '    exec(compile(_user_src, "<user_code>", "exec"), _user_globals)',
    "",
    "_error_tb = None",
    "try:",
    "    __hades_run_user__(tools_call, set_result)",
    "except SystemExit:",
    "    pass",
    "except BaseException:",
    "    _error_tb = traceback.format_exc()",
    "    sys.stderr.write(_error_tb)",
    "    sys.stderr.flush()",
    "",
    '_final = {"result": _result_box["value"], "_auth": _AUTH}',
    "if _error_tb is not None:",
    '    _final["error"] = _error_tb',
    '_emit_frame("@@HADES_RESULT@@", _final)',
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Frame parsing helpers
// ---------------------------------------------------------------------------

interface RawRpcFrame {
  id: number;
  tool: string;
  input: string;
  _auth: string;
}

interface RawResultFrame {
  result: string;
  _auth: string;
  error?: string;
}

function tryParseAuthedRpcFrame(payload: string, authToken: string): RawRpcFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj._auth !== authToken) return null;
  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) return null;
  if (typeof obj.tool !== "string" || typeof obj.input !== "string") return null;
  return { id: obj.id, tool: obj.tool, input: obj.input, _auth: authToken };
}

function tryParseAuthedResultFrame(payload: string, authToken: string): RawResultFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj._auth !== authToken) return null;
  if (typeof obj.result !== "string") return null;
  const error = typeof obj.error === "string" ? obj.error : undefined;
  return { result: obj.result, _auth: authToken, ...(error !== undefined ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// isPythonAvailable
// ---------------------------------------------------------------------------

/**
 * Real availability probe: spawns `<pythonPath> -I -c "import sys; sys.exit(0)"`
 * (never `shell: true`) and resolves `true` only if that process actually
 * starts and exits 0. Never rejects/throws: a missing binary, a permission
 * error, or a hang (bounded by an internal watchdog) all resolve `false`.
 */
export function isPythonAvailable(pythonPath?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const resolveOnce = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ChildProcess;
    try {
      child = spawn(pythonPath ?? "python3", ["-I", "-c", "import sys; sys.exit(0)"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolveOnce(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; nothing to clean up.
      }
      resolveOnce(false);
    }, AVAILABILITY_CHECK_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", () => {
      clearTimeout(timer);
      resolveOnce(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveOnce(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// runSandboxedPython
// ---------------------------------------------------------------------------

/**
 * Runs `code` as Python inside a real, isolated `python3 -I` child process.
 * Never rejects: every failure mode (missing interpreter, syntax error,
 * raised exception, timeout, dispatch failure) resolves to a structured
 * {@link SandboxResult}.
 */
export function runSandboxedPython(
  code: string,
  opts: SandboxOptions & { pythonPath?: string },
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxCodeBytes = opts.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
  const pythonPath = opts.pythonPath ?? "python3";

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

    const authToken = computeAuthToken(code);
    const bootstrapSource = buildPythonBootstrap(code);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pythonPath, ["-I", "-c", bootstrapSource], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolveOnce({
        ok: false,
        result: "",
        stdout: "",
        stderr: "",
        timedOut: false,
        rpcCallCount: 0,
        error: "python_unavailable",
      });
      return;
    }

    // Never let a broken pipe / stream-level error crash the host process
    // via an unhandled 'error' event.
    child.stdin.on("error", () => undefined);
    child.stdout.on("error", () => undefined);
    child.stderr.on("error", () => undefined);

    let rpcCallCount = 0;
    let timedOut = false;
    let spawnFailed = false;

    const stdoutCollector = new CappedStreamCollector(maxStdoutBytes);
    const stderrCollector = new CappedStreamCollector(maxStdoutBytes);

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutLineBuf = "";
    let stderrLineBuf = "";

    let finalResult: string | null = null;
    let finalError: string | undefined;
    let gotResultFrame = false;

    let sigtermTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const cleanupTimers = (): void => {
      if (sigtermTimer !== undefined) clearTimeout(sigtermTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    const writeResponse = (res: ToolRpcResponse): void => {
      if (settled) return;
      try {
        child.stdin.write(`${JSON.stringify(res)}\n`);
      } catch {
        // Child may already be gone (e.g. timed out mid-dispatch); the
        // in-flight dispatch result is simply discarded.
      }
    };

    const handleStdoutLine = (line: string): void => {
      if (line.startsWith(RPC_PREFIX)) {
        const payload = line.slice(RPC_PREFIX.length);
        const frame = tryParseAuthedRpcFrame(payload, authToken);
        if (frame !== null) {
          rpcCallCount += 1;
          const req: ToolRpcRequest = { id: frame.id, tool: frame.tool, input: frame.input };
          opts.dispatch(req).then(
            (res) => writeResponse(res),
            (err: unknown) => {
              writeResponse({
                id: req.id,
                ok: false,
                output: `rpc_error: ${messageOf(err)}`,
                error: "tool_error",
                elapsedMs: 0,
              });
            },
          );
          return;
        }
        // Unauthenticated / malformed "RPC-shaped" line: per the
        // protocol-injection-resistance policy documented at the top of
        // this file, this is never dispatched — it is provably harmless
        // ordinary output.
      } else if (line.startsWith(RESULT_PREFIX)) {
        const payload = line.slice(RESULT_PREFIX.length);
        const frame = tryParseAuthedResultFrame(payload, authToken);
        if (frame !== null) {
          gotResultFrame = true;
          finalResult = frame.result;
          finalError = frame.error;
          return;
        }
        // Unauthenticated / malformed "RESULT-shaped" line: same policy —
        // falls through to plain stdout below.
      }
      stdoutCollector.push(`${line}\n`);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLineBuf += stdoutDecoder.write(chunk);
      let idx: number;
      while ((idx = stdoutLineBuf.indexOf("\n")) !== -1) {
        const line = stdoutLineBuf.slice(0, idx);
        stdoutLineBuf = stdoutLineBuf.slice(idx + 1);
        handleStdoutLine(line);
      }
      if (
        stdoutLineBuf.length > 0 &&
        Buffer.byteLength(stdoutLineBuf, "utf8") > maxStdoutBytes + LINE_BUFFER_HARD_CAP_SLACK_BYTES
      ) {
        // Pathological single line with no newline in sight yet: flush it
        // through the cap now instead of growing the buffer unboundedly.
        stdoutCollector.push(stdoutLineBuf);
        stdoutLineBuf = "";
      }
    });
    child.stdout.on("end", () => {
      const tail = stdoutDecoder.end();
      const leftover = stdoutLineBuf + tail;
      stdoutLineBuf = "";
      if (leftover.length > 0) stdoutCollector.push(leftover);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrLineBuf += stderrDecoder.write(chunk);
      stderrCollector.push(stderrLineBuf);
      stderrLineBuf = "";
    });
    child.stderr.on("end", () => {
      const tail = stderrDecoder.end();
      if (tail.length > 0) stderrCollector.push(tail);
    });

    child.on("error", () => {
      spawnFailed = true;
      cleanupTimers();
      resolveOnce({
        ok: false,
        result: "",
        stdout: stdoutCollector.toString(),
        stderr: stderrCollector.toString(),
        timedOut: false,
        rpcCallCount,
        error: "python_unavailable",
      });
    });

    child.on("close", (exitCode, signal) => {
      if (spawnFailed) return; // Already resolved via the 'error' handler.
      cleanupTimers();

      if (timedOut) {
        resolveOnce({
          ok: false,
          result: "",
          stdout: stdoutCollector.toString(),
          stderr: stderrCollector.toString(),
          timedOut: true,
          rpcCallCount,
          error: "timeout",
        });
        return;
      }

      if (!gotResultFrame) {
        const signalPart = signal !== null ? ` (signal ${signal})` : "";
        resolveOnce({
          ok: false,
          result: "",
          stdout: stdoutCollector.toString(),
          stderr: stderrCollector.toString(),
          timedOut: false,
          rpcCallCount,
          error: `python_exited_without_result: exit code ${exitCode ?? -1}${signalPart}`,
        });
        return;
      }

      if (finalError !== undefined) {
        resolveOnce({
          ok: false,
          result: finalResult ?? "",
          stdout: stdoutCollector.toString(),
          stderr: stderrCollector.toString(),
          timedOut: false,
          rpcCallCount,
          error: tailOf(finalError, ERROR_TAIL_MAX_CHARS),
        });
        return;
      }

      resolveOnce({
        ok: true,
        result: finalResult ?? "",
        stdout: stdoutCollector.toString(),
        stderr: stderrCollector.toString(),
        timedOut: false,
        rpcCallCount,
      });
    });

    sigtermTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, SIGTERM_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    sigtermTimer.unref?.();
  });
}
