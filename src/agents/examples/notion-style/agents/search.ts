/**
 * Search & Discovery Agent — finds and surfaces relevant workspace content.
 *
 * This agent uses full-text and semantic search tools to answer questions
 * grounded in the user's actual documents. It never modifies content.
 *
 * Usage:
 *   import { searchAgent } from "@/agents/examples/notion-style/agents/search";
 *   const result = await searchAgent.run({ message: "What did we decide about pricing?" });
 */

import { defineAgent } from "../../../definitions/builder";
import { defineSkill } from "../../../skills/index";
import { createCoreHarness } from "../../../core";
import { withMemory } from "../../../plugins/memory";
import { registerAgent } from "../../../agent-registry";

// ── Register search skill ─────────────────────────────────────────────────────

import "../tools/search";
import "../tools/pages";   // needed for notion_get_page to retrieve full content

defineSkill({
  name: "workspace-search",
  description: "Search and retrieve workspace pages using full-text and semantic search.",
  tools: [
    "notion_search_pages",
    "notion_semantic_search",
    "notion_get_related_pages",
    "notion_get_page",
    "notion_list_pages",
  ],
});

// ── Agent definition ──────────────────────────────────────────────────────────

const definition = defineAgent("workspace-search")
  .role("retrieval")
  .description("Finds and surfaces relevant content from the workspace.")
  .instructions((ctx) => {
    const who = ctx.userId ? `user ${ctx.userId}` : "the workspace user";
    return `You are a search and discovery assistant for ${who}'s workspace.

Your job is to find the most relevant pages and content to answer questions.

Process:
1. Run notion_search_pages for keyword matches.
2. Run notion_semantic_search for concept-level matches.
3. For the top 2-3 results, use notion_get_page to read the full content.
4. Synthesize an answer grounded in what you found.
5. Always cite the page titles and IDs you used.

If you find conflicting information across pages, surface both and note the discrepancy.
If nothing relevant is found, say so clearly — do not hallucinate content.`;
  })
  .skills(["workspace-search"])
  .memory({
    scope: "user",
    ttl: "7d",
    topK: 3,
    persist: false,
  })
  .boundaries({
    refuseTopics: [
      "Creating, editing, or deleting any content",
      "Accessing content belonging to other users",
    ],
    deferWhen: [
      "User wants to create or edit content → use the document-editor agent",
    ],
  })
  .autonomy("full")   // read-only agent can run without supervision
  .build();

registerAgent("workspace-search", definition);

export const searchAgentConfig = definition;

export function createSearchAgent() {
  return createCoreHarness({
    ...definition,
    plugins: [
      ...(definition.plugins ?? []),
      withMemory({ key: "userId", topK: 3 }),
    ],
  });
}

export const searchAgent = createSearchAgent();
