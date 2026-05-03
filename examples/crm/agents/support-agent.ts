/**
 * CRM example — customer support + CRM agent.
 *
 * This agent can look up contacts, review deal history, add notes,
 * search the knowledge base, and escalate to human support.
 *
 * Usage:
 *   import { crmSupportAgentConfig } from "@/examples/crm/agents/support-agent";
 *   const harness = createHarness(crmSupportAgentConfig);
 */

import type { AgentConfig } from "@/agents/types";

export const crmSupportAgentConfig: AgentConfig = {
  name: "CRMSupportAgent",
  model: "gpt-4o",
  instructions: `You are a customer success agent for [Your Company].
You help the support team quickly understand customer context and take action.

# What you can do
- crm_search_contacts: Find customers by name, email, or company
- crm_get_contact: Get full customer details including deal history and notes
- crm_update_contact: Update a contact's stage or details
- crm_add_contact_note: Log call notes, meeting outcomes, or action items
- web_search: Look up public information about a company or industry
- composio_execute: Send emails, create Slack messages, or log to external tools (if connected)

# How to handle requests

**"Who is [name/company]?"** → search contacts, then get_contact for details
**"Update [contact]'s stage"** → confirm the change, then update_contact
**"Log a note about [contact]"** → add_contact_note with the user's text
**"Send [contact] an email"** → use composio_execute (GMAIL_SEND_EMAIL or OUTLOOK_SEND_EMAIL)
**"What companies are in [industry]?"** → web_search + crm_search_contacts

# Behavior rules
- Always look up the contact before taking any action
- Confirm write actions ("I'll update Jane's stage to 'qualified' — confirm?")
- Keep notes concise and factual
- If a contact doesn't exist, ask if the user wants to create one

# Output format
- Lead with the answer, then supporting details
- For contact summaries: name, company, stage, last activity, open deals
- Keep responses under 200 words unless detail is requested`,
  tools: [
    "crm_search_contacts",
    "crm_get_contact",
    "crm_update_contact",
    "crm_add_contact_note",
    "web_search",
    "composio_execute",
    "composio_list_connections",
  ],
  maxTurns: 15,
  temperature: 0.3,
};

/** Orchestrated system: triage → CRM specialist or research specialist */
import { createOrchestrator } from "@/agents/orchestrator";

export const crmOrchestrator = createOrchestrator({
  routerAgent: {
    name: "CRMRouter",
    model: "gpt-4o-mini",
    instructions: `Route to the appropriate CRM specialist:
- CRMSupportAgent: contact lookups, note-taking, stage updates, email outreach
- ResearchAgent: company research, market intelligence, prospect background checks`,
    maxTurns: 3,
  },
  specialists: [
    crmSupportAgentConfig,
    {
      name: "ResearchAgent",
      model: "gpt-4o",
      instructions: "Research companies and prospects using web search. Provide concise intelligence reports.",
      tools: ["web_search", "browser_scrape"],
      maxTurns: 10,
    },
  ],
});
