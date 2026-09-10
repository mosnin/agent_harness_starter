/**
 * execute_code — the programmatic-tool-use Tool.
 *
 * Wraps the real sandbox stack (`sandbox-js.ts` / `sandbox-py.ts`) and the
 * real Tool-RPC bridge (`tool-rpc.ts`) behind a single {@link Tool} whose
 * `run(input)` lets a model write one program — JavaScript by default, or
 * Python via a `#lang: python` first-line directive — that calls every
 * allowed tool in the host {@link ToolRegistry} through `tools.call(name,
 * input)` (JS) / `tools_call(name, input)` (Python), instead of spending one
 * conversational turn per tool call the way the ReAct `AgentLoop` does. See
 * `pipeline-bench.ts` for a real, counted comparison of the two styles.
 *
 * Every invocation gets a FRESH {@link ToolRpcBridge} and a FRESH
 * {@link ProvenanceLedger}: the bridge's `onEvent` appends each dispatched
 * call's {@link ProvenanceEvent} straight into the ledger, so by the time
 * the sandbox settles, the ledger is a complete, hash-chained, tamper-
 * evident record of exactly which tools ran, with what input, and what came
 * back — the STYX provenance trail for this one program. `traceSha256()` is
 * reported on every call (even a failing one) so a caller can bind it into
 * a Verification Certificate.
 *
 * Self-invocation is always denied: the tool named "execute_code" is added
 * to the sandbox's deny list on every call, regardless of the caller's own
 * `allow`/`deny`, so a program can never dispatch into itself recursively.
 *
 * REAL vs MOCK: the registry, bridge, ledger, and (unless a test injects a
 * fake) the JS/Python sandboxes are all real. `run()` never throws — every
 * failure mode (parse trouble, a denied/unknown tool, a sandbox timeout, an
 * injected runner that itself throws) is caught and reported as a
 * structured, always-JSON-parseable {@link ExecuteCodeReport}.
 */

import type { Tool, ToolRegistry } from "../agent/tools";
import { createToolRpcBridge, type ProvenanceEvent } from "./tool-rpc";
import { runSandboxedJs, type SandboxOptions, type SandboxResult } from "./sandbox-js";
import { runSandboxedPython } from "./sandbox-py";
import { ProvenanceLedger } from "./provenance";

// ---------------------------------------------------------------------------
// Public contract (LOCKED)
// ---------------------------------------------------------------------------

export interface ExecuteCodeOptions {
  registry: ToolRegistry;
  /** If set, only these tool names may be called (subject to `deny`). */
  allow?: string[];
  /** Tool names that may never be called. `execute_code` is always denied
   *  in addition to whatever is listed here, regardless of `allow`. */
  deny?: string[];
  /** Max total RPC dispatch attempts serviced per invocation. */
  maxCalls?: number;
  /** Wall-clock budget per individual tool call, in ms. */
  perCallTimeoutMs?: number;
  /** Wall-clock budget for the whole sandboxed program, in ms. */
  timeoutMs?: number;
  /** Injectable clock, threaded through to the Tool-RPC bridge. */
  now?: () => number;
  /** Injectable JS sandbox runner; defaults to the real `runSandboxedJs`. */
  jsRunner?: typeof runSandboxedJs;
  /** Injectable Python sandbox runner; defaults to the real `runSandboxedPython`. */
  pyRunner?: typeof runSandboxedPython;
  /** Called once per invocation with the completed, per-call provenance ledger. */
  onLedger?: (ledger: ProvenanceLedger) => void;
}

export interface ExecuteCodeReport {
  ok: boolean;
  result: string;
  stdout: string;
  stderr: string;
  language: "js" | "python";
  rpcCalls: number;
  timedOut: boolean;
  traceSha256: string;
  error?: string;
}

const EXECUTE_CODE_TOOL_NAME = "execute_code";

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

/**
 * A well-formed directive is the ENTIRE first line, `#lang:` (case
 * insensitive) followed by optional whitespace, a single non-whitespace
 * token, and nothing else on that line. Anything else on the first line
 * (an unknown language, trailing prose, a bare `#lang:` with no value) is
 * NOT treated as a directive at all — the input is run as-is, as JS, so a
 * malformed directive line simply becomes (invalid) JS source rather than
 * being silently swallowed. `run()` still always returns a structured
 * report in that case; it just won't be `ok: true`.
 */
const LANG_DIRECTIVE_RE = /^#lang:\s*(\S+)\s*$/i;

export function parseExecuteCodeInput(input: string): { language: "js" | "python"; code: string } {
  const newlineIdx = input.indexOf("\n");
  const firstLine = newlineIdx === -1 ? input : input.slice(0, newlineIdx);
  const rest = newlineIdx === -1 ? "" : input.slice(newlineIdx + 1);

  const match = firstLine.match(LANG_DIRECTIVE_RE);
  if (!match) {
    return { language: "js", code: input };
  }

  const token = (match[1] ?? "").toLowerCase();
  if (token === "python" || token === "py") {
    return { language: "python", code: rest };
  }
  if (token === "js" || token === "javascript") {
    return { language: "js", code: rest };
  }
  // Recognized shape, unrecognized language: leave the directive line in
  // place (unstripped) and fall back to the js runner.
  return { language: "js", code: input };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const DESCRIPTION =
  "Execute one program that can call EVERY allowed tool in this registry via " +
  "tools.call(name, input) (JavaScript, the default) or tools_call(name, input) " +
  "(Python, opt in with a '#lang: python' first line) — chain search/extract/" +
  "compute steps inside a single program instead of spending one conversational " +
  "turn per tool call. Input is the program source, optionally preceded by a " +
  "'#lang: python' or '#lang: js' directive line. Returns a JSON report: " +
  '{ ok, result, stdout, stderr, language, rpcCalls, timedOut, traceSha256, error? }. ' +
  "execute_code cannot call itself.";

/**
 * Build the `execute_code` Tool. Every `run(input)` call: parses the
 * optional language directive, spins up a brand-new Tool-RPC bridge and
 * provenance ledger scoped to just this call, runs the requested sandbox
 * with `execute_code` itself always denied, hands the completed ledger to
 * `onLedger`, and returns a structured report. Never throws.
 */
export function createExecuteCodeTool(opts: ExecuteCodeOptions): Tool {
  const jsRunner = opts.jsRunner ?? runSandboxedJs;
  const pyRunner = opts.pyRunner ?? runSandboxedPython;

  const run: Tool["run"] = async (input: string) => {
    const { language, code } = parseExecuteCodeInput(input);

    const ledger = new ProvenanceLedger();

    // execute_code can never invoke itself, no matter what the caller's own
    // allow/deny lists say — deny wins over allow in the bridge, so adding
    // it here is a hard, unconditional guarantee against recursion.
    const deny = new Set(opts.deny ?? []);
    deny.add(EXECUTE_CODE_TOOL_NAME);

    const bridge = createToolRpcBridge(opts.registry, {
      allow: opts.allow,
      deny: [...deny],
      maxCalls: opts.maxCalls,
      perCallTimeoutMs: opts.perCallTimeoutMs,
      now: opts.now,
      onEvent: (event: ProvenanceEvent) => {
        try {
          ledger.append(event);
        } catch {
          // The bridge guarantees a monotone, gap-free seq starting at 1
          // (see tool-rpc.ts), so this can only fire on a caller bug we
          // cannot recover from mid-run; swallowing keeps the tool total
          // rather than propagating a bridge-internal inconsistency as an
          // uncaught throw out of a Tool.run.
        }
      },
    });

    const sandboxOptions: SandboxOptions = {
      dispatch: (req) => bridge.dispatch(req),
      timeoutMs: opts.timeoutMs,
    };

    let sandboxResult: SandboxResult;
    try {
      sandboxResult =
        language === "python"
          ? await pyRunner(code, sandboxOptions)
          : await jsRunner(code, sandboxOptions);
    } catch (err) {
      // An injected (or, in principle, a misbehaving real) runner that
      // throws/rejects instead of resolving a SandboxResult must still
      // produce a structured, honest report rather than crash the tool.
      sandboxResult = {
        ok: false,
        result: "",
        stdout: "",
        stderr: "",
        timedOut: false,
        rpcCallCount: bridge.callCount(),
        durationMs: 0,
        error: `runner_threw: ${messageOf(err)}`,
      };
    }

    if (opts.onLedger) {
      try {
        opts.onLedger(ledger);
      } catch {
        // A hostile or broken observer must never break the tool.
      }
    }

    const report: ExecuteCodeReport = {
      ok: sandboxResult.ok,
      result: sandboxResult.result,
      stdout: sandboxResult.stdout,
      stderr: sandboxResult.stderr,
      language,
      rpcCalls: sandboxResult.rpcCallCount,
      timedOut: sandboxResult.timedOut,
      traceSha256: ledger.traceSha256(),
      ...(sandboxResult.error !== undefined ? { error: sandboxResult.error } : {}),
    };

    // All ExecuteCodeReport fields are plain strings/booleans/numbers
    // (traceSha256 is our own hex-digest output, rpcCalls/timedOut come
    // from the sandbox, and stdout/stderr/result are strings the runner
    // already produced), so JSON.stringify here can never throw — no
    // circular references, no BigInt, nothing exotic. Any string content,
    // however large or however much non-ASCII/unicode it contains, is
    // JSON-safe.
    return { ok: report.ok, output: JSON.stringify(report) };
  };

  return {
    name: EXECUTE_CODE_TOOL_NAME,
    description: DESCRIPTION,
    run,
  };
}
