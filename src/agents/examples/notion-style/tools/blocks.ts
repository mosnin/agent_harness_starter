/**
 * Block tools — append and manipulate content blocks within a page.
 *
 * In Notion-style apps, pages contain blocks (paragraphs, headings, lists,
 * code blocks, callouts, etc.). These tools let the agent edit page structure
 * without rewriting the entire content each time.
 *
 * Stubs: replace execute bodies with your actual block-level storage calls.
 */

import { z } from "zod";
import { registerTool } from "../../../tools/registry";

export type BlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "code"
  | "callout"
  | "divider"
  | "quote";

export interface Block {
  id: string;
  type: BlockType;
  content: string;
  language?: string;   // for "code" blocks
  position: number;
}

// ── Tool: append_blocks ───────────────────────────────────────────────────────

registerTool({
  name: "notion_append_blocks",
  description: "Append one or more content blocks to the end of a page.",
  parameters: z.object({
    pageId: z.string(),
    blocks: z.array(z.object({
      type:     z.enum(["paragraph","heading_1","heading_2","heading_3","bulleted_list_item","numbered_list_item","code","callout","divider","quote"]),
      content:  z.string(),
      language: z.string().optional().describe("Programming language (for code blocks)."),
    })),
  }),
  execute: async ({ pageId, blocks }, ctx) => {
    // Replace with: await db.block.createMany({ data: blocks.map((b, i) => ({ ...b, pageId, userId: ctx.userId, position: existingCount + i })) })
    void ctx;
    return {
      pageId,
      appended: blocks.length,
      blockIds: blocks.map((_, i) => `block_${Date.now()}_${i}`),
    };
  },
});

// ── Tool: update_block ────────────────────────────────────────────────────────

registerTool({
  name: "notion_update_block",
  description: "Update the content of a specific block on a page.",
  parameters: z.object({
    blockId: z.string(),
    content: z.string().describe("New content for this block."),
  }),
  execute: async ({ blockId, content }, ctx) => {
    // Replace with: await db.block.update({ where: { id: blockId, userId: ctx.userId }, data: { content, updatedAt: new Date() } })
    void ctx;
    return { blockId, content, updatedAt: new Date().toISOString() };
  },
});

// ── Tool: get_page_blocks ─────────────────────────────────────────────────────

registerTool({
  name: "notion_get_page_blocks",
  description: "Retrieve all content blocks for a page in order.",
  parameters: z.object({
    pageId: z.string(),
  }),
  execute: async ({ pageId }, ctx) => {
    // Replace with: return await db.block.findMany({ where: { pageId, userId: ctx.userId }, orderBy: { position: "asc" } })
    void ctx;
    return [] as Block[];
  },
});
