/**
 * @module hades/agent
 *
 * The brain: a real ReAct tool-calling loop over an injected model client, a
 * sandboxed in-box toolset (no eval, no shell/network by default), and
 * V-TPH$ runners — a verification-gated swarm worker (answers, then a separate
 * verifier model decides whether to trust the answer) and a self-trusting
 * single-agent baseline. See `.plans/HADES_BEYOND_HERMES.md`.
 */
export { ToolRegistry, builtinTools, builtinRegistry, evalArithmetic } from "./tools";
export type { Tool, ToolCall, ToolResult } from "./tools";
export { AgentLoop } from "./loop";
export type { AgentLoopOptions, AgentLoopResult } from "./loop";
export { verifiedSwarmRunner, singleAgentRunner } from "./runner";
export type { RunnerOptions, SingleAgentOptions } from "./runner";
