/**
 * Typed Tool-RPC protocol and host-side bridge.
 *
 * This is the real, load-bearing boundary between a sandboxed runtime (e.g.
 * the worker_threads sandbox in `sandbox-js.ts`, or any other out-of-process
 * runtime) and the host's real {@link ToolRegistry}. The sandbox never talks
 * to the registry directly — it sends `{ id, tool, input }` frames over
 * whatever channel it has (postMessage, a pipe, ...) and the host answers
 * with `{ id, ok, output, error?, elapsedMs }` after applying capability
 * policy, a call budget, a per-call timeout and an output cap.
 *
 * Every dispatch that reaches tool resolution (i.e. is not `malformed_request`)
 * produces exactly one {@link ProvenanceEvent} — a STYX provenance record
 * binding the tool name, sha256 of the exact input and (possibly truncated)
 * output bytes, outcome, and timing. This is the evidence trail STYX
 * verification consumes; it does not itself assert correctness, only "this
 * is exactly what was called and exactly what came back".
 *
 * REAL vs MOCK: everything in this file is real, deterministic, synchronous-
 * or-awaited code. No network, no filesystem, no randomness. The only
 * non-determinism is wall-clock time, which is fully injectable via
 * `opts.now`. Hashing is real node:crypto sha256 (the same encoding
 * `styx/certificate.ts` uses: `createHash("sha256").update(data, "utf8").digest("hex")`).
 */

import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ToolRegistry } from "../agent/tools";

// ---------------------------------------------------------------------------
// Protocol types (LOCKED — imported type-only by other teams).
// ---------------------------------------------------------------------------

export type ToolRpcErrorCode =
  | "unknown_tool"
  | "not_allowed"
  | "tool_error"
  | "timeout"
  | "malformed_request"
  | "call_budget_exceeded"
  | "output_truncated";

/** A single tool call issued by sandboxed/remote code. */
export interface ToolRpcRequest {
  id: number;
  tool: string;
  input: string;
}

/** The host's response to a single {@link ToolRpcRequest}. */
export interface ToolRpcResponse {
  id: number;
  ok: boolean;
  output: string;
  error?: ToolRpcErrorCode;
  elapsedMs: number;
}

/** A STYX provenance record emitted for every dispatched call. */
export interface ProvenanceEvent {
  seq: number;
  tool: string;
  inputSha256: string;
  outputSha256: string;
  ok: boolean;
  error?: ToolRpcErrorCode;
  startedAt: number;
  elapsedMs: number;
}

export interface ToolRpcBridgeOptions {
  /** If set, only these tool names may be called (subject to `deny`). */
  allow?: string[];
  /** Tool names that may never be called, regardless of `allow`. */
  deny?: string[];
  /** Max total dispatch attempts this bridge instance will service. Default 64. */
  maxCalls?: number;
  /** Wall-clock budget per tool call, in ms. Default 10000. */
  perCallTimeoutMs?: number;
  /** Max output size, in UTF-8 bytes, before truncation. Default 262144. */
  maxOutputBytes?: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Called once per emitted {@link ProvenanceEvent}. Errors are swallowed. */
  onEvent?: (e: ProvenanceEvent) => void;
}

export interface ToolRpcBridge {
  dispatch(req: ToolRpcRequest): Promise<ToolRpcResponse>;
  /** Defensive copy of every provenance event emitted so far, in seq order. */
  events(): ProvenanceEvent[];
  /** Total dispatch attempts serviced (all outcomes except malformed_request). */
  callCount(): number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CALLS = 64;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_OUTPUT_BYTES = 262144;

// ---------------------------------------------------------------------------
// Hashing — real node:crypto sha256, lowercase hex, UTF-8 bytes of the
// string. Same encoding as `styx/certificate.ts#sha256Hex`.
// ---------------------------------------------------------------------------

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function describeValue(v: unknown): string {
  if (typeof v === "function") return "a function";
  if (typeof v === "symbol") return v.toString();
  try {
    const json = JSON.stringify(v);
    return json === undefined ? "undefined" : json;
  } catch {
    return String(v);
  }
}

/**
 * Structural check of an unknown value against the {@link ToolRpcRequest}
 * shape. Returns a human-readable reason when invalid, or `null` when the
 * value is a well-formed request. Shared by {@link validateToolRpcRequest}
 * (which reports only the error code, per the locked signature) and
 * {@link createToolRpcBridge}'s `dispatch` (which also wants a message to
 * put in `ToolRpcResponse.output`).
 */
function requestShapeError(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `request must be a non-null JSON object, got ${describeValue(value)}`;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "number" || !Number.isFinite(obj.id)) {
    return `request.id must be a finite number, got ${describeValue(obj.id)}`;
  }
  if (typeof obj.tool !== "string" || obj.tool.length === 0) {
    return `request.tool must be a non-empty string, got ${describeValue(obj.tool)}`;
  }
  if (typeof obj.input !== "string") {
    return `request.input must be a string, got ${describeValue(obj.input)}`;
  }
  return null;
}

export function validateToolRpcRequest(
  value: unknown,
): { ok: true; req: ToolRpcRequest } | { ok: false; error: ToolRpcErrorCode } {
  if (requestShapeError(value) !== null) {
    return { ok: false, error: "malformed_request" };
  }
  const obj = value as { id: number; tool: string; input: string };
  return { ok: true, req: { id: obj.id, tool: obj.tool, input: obj.input } };
}

// ---------------------------------------------------------------------------
// Output truncation — a real hard byte cap. Naively slicing a UTF-8 Buffer
// and calling `.toString("utf8")` is NOT byte-safe: a dangling incomplete
// multi-byte sequence left at the cut gets replaced by Node with a single
// U+FFFD replacement character, which re-encodes to 3 bytes — so a 1-byte
// dangling fragment can turn into MORE bytes than the cap allowed. We use
// `node:string_decoder`'s `StringDecoder` instead (the same primitive
// Node's own streams use for this exact problem): it holds back an
// incomplete trailing multi-byte sequence rather than replacing it, so the
// returned string's own UTF-8 byte length is always <= maxBytes.
// ---------------------------------------------------------------------------

function truncateUtf8(input: string, maxBytes: number): { output: string; truncated: boolean } {
  const cap = Math.max(0, maxBytes);
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= cap) {
    return { output: input, truncated: false };
  }
  const decoder = new StringDecoder("utf8");
  const output = decoder.write(buf.subarray(0, cap));
  return { output, truncated: true };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export function createToolRpcBridge(
  registry: ToolRegistry,
  opts: ToolRpcBridgeOptions = {},
): ToolRpcBridge {
  const denySet = new Set(opts.deny ?? []);
  const allowSet = opts.allow ? new Set(opts.allow) : undefined;
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const now = opts.now ?? Date.now;
  const onEvent = opts.onEvent;

  const log: ProvenanceEvent[] = [];
  let seq = 0;
  let calls = 0;

  function emit(event: ProvenanceEvent): void {
    log.push(event);
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      // A hostile or broken observer must never be able to break the bridge.
    }
  }

  /** Finalize a counted (non-malformed) dispatch attempt: bump seq/calls,
   *  emit its provenance event, and build the response. */
  function settle(
    req: ToolRpcRequest,
    startedAt: number,
    ok: boolean,
    output: string,
    error: ToolRpcErrorCode | undefined,
  ): ToolRpcResponse {
    const elapsedMs = now() - startedAt;
    seq += 1;
    calls += 1;
    emit({
      seq,
      tool: req.tool,
      inputSha256: sha256Hex(req.input),
      outputSha256: sha256Hex(output),
      ok,
      ...(error !== undefined ? { error } : {}),
      startedAt,
      elapsedMs,
    });
    return {
      id: req.id,
      ok,
      output,
      ...(error !== undefined ? { error } : {}),
      elapsedMs,
    };
  }

  async function dispatch(reqUnknown: ToolRpcRequest): Promise<ToolRpcResponse> {
    const startedAt = now();

    const shapeError = requestShapeError(reqUnknown);
    if (shapeError !== null) {
      const rawId =
        reqUnknown !== null &&
        typeof reqUnknown === "object" &&
        typeof (reqUnknown as { id?: unknown }).id === "number"
          ? (reqUnknown as { id: number }).id
          : NaN;
      return {
        id: rawId,
        ok: false,
        output: `malformed request: ${shapeError}`,
        error: "malformed_request",
        elapsedMs: now() - startedAt,
      };
    }
    const req = reqUnknown;

    // Budget gate: an exhausted bridge rejects everything else outright,
    // including calls to unknown/denied tools. This attempt still counts.
    if (calls >= maxCalls) {
      return settle(
        req,
        startedAt,
        false,
        `call budget exceeded: this bridge allows at most ${maxCalls} calls`,
        "call_budget_exceeded",
      );
    }

    const tool = registry.get(req.tool);
    if (!tool) {
      return settle(req, startedAt, false, `unknown tool: ${req.tool}`, "unknown_tool");
    }

    if (denySet.has(req.tool) || (allowSet !== undefined && !allowSet.has(req.tool))) {
      return settle(req, startedAt, false, `tool not allowed: ${req.tool}`, "not_allowed");
    }

    const raced = await raceWithTimeout(registry, req, perCallTimeoutMs);
    if (raced.timedOut) {
      return settle(
        req,
        startedAt,
        false,
        `tool call timed out after ${perCallTimeoutMs}ms`,
        "timeout",
      );
    }

    const { output, truncated } = truncateUtf8(raced.output, maxOutputBytes);
    if (!raced.ok) {
      // A genuine tool-level failure always reports tool_error, even if its
      // (already-failed) output also happened to exceed the byte cap.
      return settle(req, startedAt, false, output, "tool_error");
    }
    if (truncated) {
      return settle(req, startedAt, true, output, "output_truncated");
    }
    return settle(req, startedAt, true, output, undefined);
  }

  return {
    dispatch,
    events: () => log.slice(),
    callCount: () => calls,
  };
}

/**
 * Race a real registry.run() against a real setTimeout. Settles exactly
 * once no matter which side wins, and never throws/rejects: a synchronously
 * throwing or rejecting tool is already caught inside `ToolRegistry.run`,
 * but we defend here too in case a future registry implementation doesn't.
 */
function raceWithTimeout(
  registry: ToolRegistry,
  req: ToolRpcRequest,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    // A pending sandbox timeout must never keep the host process alive.
    timer.unref?.();

    registry.run({ tool: req.tool, input: req.input }).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, ok: result.ok, output: result.output });
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, ok: false, output: `error: ${messageOf(err)}` });
      },
    );
  });
}
