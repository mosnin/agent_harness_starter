/**
 * Document Editor Agent — creates, edits, and organizes workspace pages.
 *
 * Wires together:
 *   - Page + block tools (CRUD on your documents)
 *   - User-scoped memory (remembers preferences and recent context)
 *   - Governance (delete operations require human approval via requiresApproval on tools)
 *   - Structured reasoning for multi-step edits
 *
 * Integration seam — where this connects to your app:
 *   ctx.userId  → scopes all DB calls to the authenticated user
 *   ctx.orgId   → multi-tenant: pass in AgentContext when calling runAgent()
 *
 * Usage in your API route:
 *   import { editorAgent } from "@/agents/examples/notion-style/agents/editor";
 *   const result = await editorAgent.run({ message, context: { userId, orgId } });
 */

import { defineAgent } from "../../../definitions/builder";
import { defineSkill } from "../../../skills/index";
import { createCoreHarness } from "../../../core";
import { withMemory } from "../../../plugins/memory";
import { withGovernance, STANDARD_ETHICS_POLICY, compliance } from "../../../governance/index";
import { registerAgent } from "../../../agent-registry";

// ── Register page-management skill ───────────────────────────────────────────
// Import the tools so they self-register, then bundle them into a skill.
import "../tools/pages";
import "../tools/blocks";

defineSkill({
  name: "page-management",
  description: "Create, read, update, and structure workspace pages and content blocks.",
  tools: [
    "notion_get_page",
    "notion_list_pages",
    "notion_create_page",
    "notion_update_page",
    "notion_delete_page",
    "notion_append_blocks",
    "notion_update_block",
    "notion_get_page_blocks",
  ],
});

// ── Agent definition ──────────────────────────────────────────────────────────

const definition = defineAgent("document-editor")
  .role("tooling")
  .description("Creates, edits, and organizes documents in the workspace.")
  .instructions((ctx) => {
    const who = ctx.userId ? `user ${ctx.userId}` : "the workspace user";
    return `You are a document editing assistant for ${who}.

Your capabilities:
- Create new pages with structured content
- Update existing page titles, content, and tags
- Append content blocks (paragraphs, headings, lists, code, callouts)
- Organize pages into hierarchies using parentId
- Search and retrieve related pages for context

Guidelines:
- Always retrieve the current page content before making edits
- Use structured blocks (headings, bullet lists) to organize content clearly
- Preserve existing content unless explicitly asked to replace it
- For page deletion: the system requires your confirmation — never delete proactively
- When creating technical content, use code blocks with the correct language set`;
  })
  .skills(["page-management"])
  .memory({
    scope: "user",
    ttl: "30d",
    topK: 5,
    persist: true,
  })
  .boundaries({
    refuseTopics: [
      "Permanently deleting pages (use trash only — user must empty trash manually)",
      "Accessing pages belonging to other users",
      "Modifying workspace settings or permissions",
    ],
    deferWhen: [
      "User asks for web research → use the research agent",
      "User asks for data analysis or code execution → use the code agent",
    ],
    maxOutputLength: 8000,
  })
  .autonomy("supervised")
  .constraints({
    requireApproval: ["notion_delete_page"],
    irreversibleTools: ["notion_delete_page"],
  })
  .build();

registerAgent("document-editor", definition);

export const editorAgentConfig = definition;

export function createEditorAgent() {
  return createCoreHarness({
    ...definition,
    plugins: [
      ...(definition.plugins ?? []),
      withMemory({ key: "userId", topK: 5 }),
      withGovernance({
        ethics: STANDARD_ETHICS_POLICY,
        compliance,
        agentId: "document-editor",
      }),
    ],
  });
}

export const editorAgent = createEditorAgent();
