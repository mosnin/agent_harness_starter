/**
 * CRM example — contact management tools.
 *
 * Replace the stubbed DB calls with your actual ORM / service layer.
 * These tools wire your CRM data into any agent that lists them.
 */

import { z } from "zod";
import { registerTool } from "@/agents/tools/registry";

// ─── Replace these with your actual data access ───────────────────────────────
async function getUserOrgId(userId: string): Promise<string> {
  // e.g. return db.users.findById(userId).then(u => u.orgId);
  throw new Error("Implement getUserOrgId with your actual DB");
}
// ─────────────────────────────────────────────────────────────────────────────

export const searchContactsTool = registerTool({
  name: "crm_search_contacts",
  description:
    "Search CRM contacts by name, email, or company. Returns name, email, company, deal stage, owner, and last activity date. Use when the user asks about customers, leads, prospects, or contacts.",
  parameters: z.object({
    query: z.string().describe("Search term — matches name, email, or company name"),
    status: z
      .enum(["active", "inactive", "prospect", "customer", "churned"])
      .optional()
      .describe("Filter by contact status"),
    ownerId: z.string().optional().describe("Filter by contact owner user ID"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ query, status, ownerId, limit }, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    // Replace with: return db.contacts.search({ orgId, query, status, ownerId, limit });
    return { contacts: [], total: 0, query, orgId };
  },
});

export const getContactTool = registerTool({
  name: "crm_get_contact",
  description:
    "Get full details for a specific CRM contact including their deals, activity history, and notes.",
  parameters: z.object({
    contactId: z.string().describe("The contact's unique ID"),
  }),
  async execute({ contactId }, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    // Replace with: return db.contacts.findById(contactId, { orgId });
    return { contactId, orgId };
  },
});

export const createContactTool = registerTool({
  name: "crm_create_contact",
  description:
    "Create a new CRM contact. Use ONLY when the user explicitly asks to add or create a contact. Always confirm the details before creating.",
  parameters: z.object({
    name: z.string().describe("Full name"),
    email: z.string().email().describe("Email address"),
    company: z.string().optional().describe("Company name"),
    phone: z.string().optional().describe("Phone number"),
    stage: z
      .enum(["prospect", "lead", "qualified", "customer"])
      .default("prospect")
      .describe("Initial pipeline stage"),
    notes: z.string().optional().describe("Initial notes"),
  }),
  async execute(params, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    // Replace with: const contact = await db.contacts.create({ ...params, orgId, createdBy: ctx.userId });
    return {
      success: true,
      message: `Created contact: ${params.name} (${params.email})`,
      // contactId: contact.id,
    };
  },
});

export const updateContactTool = registerTool({
  name: "crm_update_contact",
  description:
    "Update a CRM contact's details or pipeline stage. Confirm with the user before making changes.",
  parameters: z.object({
    contactId: z.string().describe("The contact's unique ID"),
    updates: z.object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      company: z.string().optional(),
      phone: z.string().optional(),
      stage: z.enum(["prospect", "lead", "qualified", "customer", "churned"]).optional(),
      notes: z.string().optional(),
    }).describe("Fields to update"),
  }),
  async execute({ contactId, updates }, ctx) {
    const orgId = await getUserOrgId(ctx.userId!);
    // Replace with: return db.contacts.update(contactId, { ...updates, orgId });
    return { success: true, contactId, updated: Object.keys(updates) };
  },
});

export const addContactNoteTool = registerTool({
  name: "crm_add_contact_note",
  description: "Add a note to a CRM contact's activity log.",
  parameters: z.object({
    contactId: z.string().describe("The contact's unique ID"),
    note: z.string().describe("The note text to add"),
  }),
  async execute({ contactId, note }, ctx) {
    // Replace with: return db.contactNotes.create({ contactId, note, authorId: ctx.userId });
    return { success: true, contactId, notePreview: note.slice(0, 50) };
  },
});
