/**
 * Page tools — CRUD operations on workspace documents.
 *
 * These are stubs. Replace each `execute` body with your actual service layer
 * call (Prisma, Supabase, Drizzle, etc.). The tool contracts — names, parameters,
 * return shapes — are what the agent understands; the implementation is yours.
 *
 * Stub pattern:
 *   1. The tool validates input with Zod.
 *   2. It receives the authenticated userId via ToolContext.
 *   3. You call your existing service/ORM function.
 *   4. Return a plain object the agent can read.
 *
 * Tools registered here are automatically available to all agents and the MCP server.
 */

import { z } from "zod";
import { registerTool } from "../../../tools/registry";

// ── Shared result shapes ──────────────────────────────────────────────────────

export interface PageSummary {
  id: string;
  title: string;
  emoji?: string;
  updatedAt: string;
  parentId?: string;
}

export interface PageDetail extends PageSummary {
  content: string;        // markdown or your app's native format
  tags: string[];
  createdAt: string;
  wordCount: number;
}

// ── Tool: get_page ────────────────────────────────────────────────────────────

registerTool({
  name: "notion_get_page",
  description: "Retrieve the full content and metadata of a page by its ID.",
  parameters: z.object({
    pageId: z.string().describe("The ID of the page to retrieve."),
  }),
  execute: async ({ pageId }, ctx) => {
    // Replace with: return await db.page.findUniqueOrThrow({ where: { id: pageId, userId: ctx.userId } })
    void ctx;
    return {
      id: pageId,
      title: "Stub page — replace with your DB call",
      content: "Page content goes here.",
      emoji: "📄",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      wordCount: 0,
    } satisfies PageDetail;
  },
});

// ── Tool: list_pages ──────────────────────────────────────────────────────────

registerTool({
  name: "notion_list_pages",
  description: "List pages in the workspace, optionally filtered by parent or tag.",
  parameters: z.object({
    parentId: z.string().optional().describe("Filter to children of this page."),
    tag: z.string().optional().describe("Filter to pages with this tag."),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async ({ parentId, tag, limit }, ctx) => {
    // Replace with: return await db.page.findMany({ where: { userId: ctx.userId, parentId, tags: { has: tag } }, take: limit })
    void ctx; void parentId; void tag; void limit;
    return [] as PageSummary[];
  },
});

// ── Tool: create_page ─────────────────────────────────────────────────────────

registerTool({
  name: "notion_create_page",
  description: "Create a new page in the workspace.",
  parameters: z.object({
    title:    z.string().describe("Page title."),
    content:  z.string().default("").describe("Initial page content in markdown."),
    emoji:    z.string().optional().describe("Page icon emoji."),
    parentId: z.string().optional().describe("Parent page ID (for nested pages)."),
    tags:     z.array(z.string()).default([]),
  }),
  execute: async ({ title, content, emoji, parentId, tags }, ctx) => {
    // Replace with: return await db.page.create({ data: { title, content, emoji, parentId, tags, userId: ctx.userId } })
    void ctx;
    const id = `page_${Date.now()}`;
    return { id, title, content, emoji, parentId, tags, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), wordCount: content.split(/\s+/).length } satisfies PageDetail;
  },
});

// ── Tool: update_page ─────────────────────────────────────────────────────────

registerTool({
  name: "notion_update_page",
  description: "Update the title, content, or tags of an existing page.",
  parameters: z.object({
    pageId:  z.string(),
    title:   z.string().optional(),
    content: z.string().optional().describe("Full replacement content in markdown."),
    emoji:   z.string().optional(),
    tags:    z.array(z.string()).optional(),
  }),
  execute: async ({ pageId, ...updates }, ctx) => {
    // Replace with: return await db.page.update({ where: { id: pageId, userId: ctx.userId }, data: updates })
    void ctx;
    return { id: pageId, ...updates, updatedAt: new Date().toISOString() };
  },
});

// ── Tool: delete_page ─────────────────────────────────────────────────────────

registerTool({
  name: "notion_delete_page",
  description: "Move a page to trash. This is reversible — use empty_trash to permanently delete.",
  parameters: z.object({
    pageId: z.string(),
    reason: z.string().optional().describe("Why this page is being deleted (for audit log)."),
  }),
  requiresApproval: true,   // ← harness pauses and requests human confirmation
  execute: async ({ pageId, reason }, ctx) => {
    // Replace with: return await db.page.update({ where: { id: pageId, userId: ctx.userId }, data: { deletedAt: new Date(), deleteReason: reason } })
    void ctx; void reason;
    return { id: pageId, trashedAt: new Date().toISOString() };
  },
});
