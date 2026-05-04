/**
 * Publish pipeline — research a topic, draft a document, review it,
 * then create it in the workspace.
 *
 * Demonstrates:
 *   - createWorkflow() builder with named steps
 *   - Passing output between steps via ctx.currentMessage
 *   - withRetry for flaky LLM calls
 *   - transform() for pure data shaping between agents
 *   - Reusing the editor agent's create_page tool at the end
 *
 * Usage:
 *   import { runPublishPipeline } from "@/agents/examples/notion-style/workflow/publish-pipeline";
 *   const result = await runPublishPipeline("The future of multiplayer AI editing tools");
 */

import { createWorkflow, agentStep, transform, withRetry } from "../../../workflow/index";
import { withMemory } from "../../../plugins/memory";
import type { AgentConfig } from "../../../types";

// ── Step agents ───────────────────────────────────────────────────────────────

const researcherConfig: AgentConfig = {
  name: "TopicResearcher",
  instructions: `You are a research assistant. Given a topic, gather key facts, trends, and insights.
Output a structured research brief with:
- Core concept (2 sentences)
- 3-5 key points with supporting evidence
- Relevant context or background
- Open questions worth exploring`,
  skills: ["research"],
  maxTurns: 8,
  plugins: [withMemory({ key: "userId", topK: 3 })],
};

const drafterConfig: AgentConfig = {
  name: "DocumentDrafter",
  instructions: `You are a document writer. Given a research brief, write a well-structured workspace page.

Format requirements:
- Start with a one-paragraph summary
- Use heading_2 sections for major topics
- Use bullet lists for supporting points
- End with a "Next Steps" section
- Output valid markdown`,
  maxTurns: 4,
};

const reviewerConfig: AgentConfig = {
  name: "ContentReviewer",
  instructions: `You are an editor. Review the draft document and return an improved version.

Check for:
- Clarity and conciseness
- Logical structure
- Missing context a reader would need
- Factual consistency with the research brief

Return the revised document in full. If the draft is already good, return it unchanged.`,
  maxTurns: 3,
};

// ── Workflow ──────────────────────────────────────────────────────────────────

export const publishPipeline = createWorkflow("research-draft-publish")
  .add(
    withRetry(agentStep("research", researcherConfig), {
      maxAttempts: 2,
      backoff: "fixed",
      baseDelayMs: 1000,
    })
  )
  .add(
    withRetry(agentStep("draft", drafterConfig), {
      maxAttempts: 2,
      backoff: "fixed",
      baseDelayMs: 500,
    })
  )
  .add(agentStep("review", reviewerConfig))
  .add(
    // Shape the reviewed draft into a create-page request for the editor tool
    transform("prepare-page-data", (ctx) => {
      const draft = ctx.currentMessage;
      // Extract first line as title, rest as content
      const lines = draft.trim().split("\n");
      const title = lines[0].replace(/^#\s*/, "").trim() || "Untitled";
      const content = lines.slice(1).join("\n").trim();
      // Pass as JSON so the next step (or API handler) can call notion_create_page
      return JSON.stringify({ title, content, tags: ["ai-generated"] });
    })
  )
  .build();

// ── Runner helper ─────────────────────────────────────────────────────────────

export async function runPublishPipeline(
  topic: string,
  context?: { userId?: string; signal?: AbortSignal }
): Promise<{ title: string; content: string; tags: string[] }> {
  const result = await publishPipeline.run(
    `Research and write a comprehensive document about: ${topic}`,
    context,
    context?.signal
  );

  try {
    return JSON.parse(result.finalOutput) as { title: string; content: string; tags: string[] };
  } catch {
    return { title: topic, content: result.finalOutput, tags: ["ai-generated"] };
  }
}
