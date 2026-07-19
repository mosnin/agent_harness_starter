/**
 * @module hades/exec — programmatic tool calling (Phase 1, `.plans/HADES_PAST_HERMES_20.md`).
 *
 * The `execute_code` stack: a model writes ONE program (JS or Python) that
 * calls every allowed tool through a typed Tool-RPC bridge, collapsing a
 * multi-turn ReAct pipeline into a single inference — and, beyond Hermes,
 * every RPC dispatch is bound into a hash-chained STYX provenance ledger so
 * the "single-inference pipeline" is still fully auditable.
 *
 *  - `tool-rpc.ts`       — the locked RPC protocol + capability-policed host bridge.
 *  - `sandbox-js.ts`     — worker_threads JS sandbox (hard-kill timeout, byte caps).
 *  - `sandbox-py.ts`     — real `python3 -I` subprocess sandbox (same contract).
 *  - `provenance.ts`     — the hash-chained, tamper-evident ProvenanceLedger.
 *  - `code-tool.ts`      — the `execute_code` Tool itself.
 *  - `pipeline-bench.ts` — the Phase 1 checkpoint: ReAct vs programmatic, counted.
 *
 * NOTE: `tool-rpc.ts#sha256Hex` is deliberately NOT re-exported here — the
 * canonical public `sha256Hex` already ships from `../styx/certificate` via
 * the `hades` barrel (identical implementation), and re-exporting a second
 * copy would make the star-export ambiguous and silently drop the name.
 */

import { builtinRegistry, ToolRegistry } from "../agent/tools";
import { createExecuteCodeTool, type ExecuteCodeOptions } from "./code-tool";

export {
  createToolRpcBridge,
  validateToolRpcRequest,
} from "./tool-rpc";
export type {
  ToolRpcErrorCode,
  ToolRpcRequest,
  ToolRpcResponse,
  ToolRpcBridgeOptions,
  ToolRpcBridge,
} from "./tool-rpc";
// `../acp/index` already exports its own (different) `ProvenanceEvent` through
// the `hades` barrel; alias the Tool-RPC one so both stay reachable instead of
// colliding. Direct imports from `./tool-rpc` keep the original name.
export type { ProvenanceEvent as ToolRpcProvenanceEvent } from "./tool-rpc";

export { runSandboxedJs } from "./sandbox-js";
export type { SandboxOptions, SandboxResult } from "./sandbox-js";

export { runSandboxedPython, isPythonAvailable, buildPythonBootstrap } from "./sandbox-py";

export { ProvenanceLedger, canonicalizeEvent } from "./provenance";
export type { ProvenanceRecord, LedgerVerification } from "./provenance";

export { createExecuteCodeTool, parseExecuteCodeInput } from "./code-tool";
export type { ExecuteCodeOptions, ExecuteCodeReport } from "./code-tool";

export { runPipelineBench, buildPipelineRegistry } from "./pipeline-bench";
export type { PipelineBenchResult, PipelineSideResult } from "./pipeline-bench";

/**
 * Central wiring helper: take a tool registry (default: the builtin one) and
 * register an `execute_code` tool bound to that same registry, so an agent
 * driving the registry — the ReAct loop, the MCP server, the CLI — can
 * programmatically chain every OTHER tool in a single call. Self-recursion
 * is structurally impossible (`code-tool.ts` unconditionally denies
 * `execute_code` inside the sandbox), so the self-referential registration
 * is safe.
 *
 * Returns the same registry instance for chaining.
 */
export function execEnabledRegistry(
  base?: ToolRegistry,
  opts?: Omit<ExecuteCodeOptions, "registry">,
): ToolRegistry {
  const registry = base ?? builtinRegistry();
  registry.register(createExecuteCodeTool({ ...(opts ?? {}), registry }));
  return registry;
}
