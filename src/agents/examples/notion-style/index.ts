/**
 * Notion-style example — a realistic integration showing how to make a
 * document workspace application agentic.
 *
 * Import this barrel to register all tools, skills, and agents:
 *   import "@/agents/examples/notion-style";
 *
 * Or import individual pieces:
 *   import { editorAgent } from "@/agents/examples/notion-style/agents/editor";
 *   import { searchAgent } from "@/agents/examples/notion-style/agents/search";
 *   import { runPublishPipeline } from "@/agents/examples/notion-style/workflow/publish-pipeline";
 */

// Register tools (side-effect imports — tools self-register on import)
export * from "./tools/pages";
export * from "./tools/search";
export * from "./tools/blocks";

// Export agent factories and configs
export { editorAgent, createEditorAgent, editorAgentConfig } from "./agents/editor";
export { searchAgent, createSearchAgent, searchAgentConfig } from "./agents/search";

// Export workflow runner
export { publishPipeline, runPublishPipeline } from "./workflow/publish-pipeline";
