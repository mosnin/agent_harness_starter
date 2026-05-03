export { createHarness } from "./harness";
export { createOrchestrator, runAgentsInParallel } from "./orchestrator";
export { toOpenAITool } from "./utils";
export type { AgentConfig, AgentEvent, RunInput, RunResult } from "./types";

// Example agents — copy and customize these
export { createResearchAgent, researchAgentConfig } from "./examples/research-agent";
export { createCodeAgent, codeAgentConfig } from "./examples/code-agent";
export { orchestratedSystem } from "./examples/orchestrated-agent";
