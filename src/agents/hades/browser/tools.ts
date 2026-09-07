import { z } from "zod";
import { registerTool } from "../../tools/registry";
import { BrowserToolError, HadesBrowserClient } from "./client";

/**
 * Browser tools. These let an agent work inside the user's actual browser —
 * the tabs they already have open, the pages they saved — rather than
 * re-crawling the web from a headless instance with none of their sessions.
 *
 * Every call is gated twice on the browser side: the agent must hold the
 * tool's consent, and the workspace must allow agent access. A refusal comes
 * back as a readable message rather than an exception, so the model can adapt
 * instead of retrying the same denied call.
 */

let client: HadesBrowserClient | null = null;

export function setHadesBrowserClient(next: HadesBrowserClient | null): void {
  client = next;
}

export function getHadesBrowserClient(): HadesBrowserClient {
  if (!client) {
    throw new Error(
      "No Hades browser connected. Construct a HadesBrowserClient with the pairing token from the browser's Settings → Agents panel, connect it, and pass it to setHadesBrowserClient().",
    );
  }
  return client;
}

function agentIdFrom(ctx: { meta?: Record<string, unknown> }): string {
  const agentId = typeof ctx.meta?.agentId === "string" ? ctx.meta.agentId : undefined;
  if (!agentId) {
    throw new Error("Browser tools need meta.agentId in the tool context to check consent.");
  }
  return agentId;
}

/** Turn a consent refusal into something the model can act on. */
async function guarded<T>(run: () => Promise<T>): Promise<T | { refused: true; reason: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrowserToolError) {
      return { refused: true, reason: error.message };
    }
    throw error;
  }
}

export const browserListTabsTool = registerTool({
  name: "browser_list_tabs",
  description:
    "List the tabs the user has open, optionally in one workspace. Start here when the user refers to something they are looking at.",
  category: "browser",
  parameters: z.object({
    workspaceId: z.string().optional().describe("Limit to one workspace"),
  }),
  async execute({ workspaceId }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() => getHadesBrowserClient().listTabs(agentId, workspaceId));
  },
});

export const browserListWorkspacesTool = registerTool({
  name: "browser_list_workspaces",
  description:
    "List the user's browser workspaces. Each workspace has its own browser profile, so they may be signed in as different accounts.",
  category: "browser",
  parameters: z.object({}),
  async execute(_input, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() => getHadesBrowserClient().listWorkspaces(agentId));
  },
});

export const browserReadPageTool = registerTool({
  name: "browser_read_page",
  description:
    "Read the readable content of a tab the user already has open. Prefer this over fetching the URL yourself: the tab is already authenticated and past any paywall or login.",
  category: "browser",
  parameters: z.object({
    tabId: z.string().describe("Tab id from browser_list_tabs"),
    format: z.enum(["text", "markdown", "html"]).default("markdown"),
    maxLength: z.number().int().min(500).max(200_000).default(40_000),
  }),
  async execute({ tabId, format, maxLength }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() => getHadesBrowserClient().readPage(agentId, tabId, { format, maxLength }));
  },
});

export const browserOpenTabTool = registerTool({
  name: "browser_open_tab",
  description:
    "Open a URL in the user's browser. Opens in the background by default so the user keeps their place.",
  category: "browser",
  parameters: z.object({
    url: z.string().url(),
    workspaceId: z.string().optional(),
    background: z.boolean().default(true).describe("Leave true unless the user asked to be taken there"),
  }),
  async execute({ url, workspaceId, background }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().openTab(agentId, url, { workspaceId, background }),
    );
  },
});

export const collectionsSearchTool = registerTool({
  name: "browser_search_collections",
  description:
    "Search the pages the user saved into collections. These are pages they chose to keep, with the text captured at save time — check here before searching the web.",
  category: "browser",
  parameters: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(8),
    collectionIds: z.array(z.string()).optional(),
  }),
  async execute({ query, limit, collectionIds }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().searchCollections(agentId, query, { limit, collectionIds }),
    );
  },
});

export const collectionsListTool = registerTool({
  name: "browser_list_collections",
  description:
    "List the collections the user shared with agents, so you know what saved material is available.",
  category: "browser",
  parameters: z.object({}),
  async execute(_input, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() => getHadesBrowserClient().listCollections(agentId));
  },
});

export const activityDigestTool = registerTool({
  name: "browser_activity_digest",
  description:
    "Summarise what the user has been doing in their browser recently. Only works while the user has activity tracking switched on; a refusal means it is off, which is not an error to work around.",
  category: "browser",
  parameters: z.object({
    minutesBack: z.number().int().min(5).max(1440).default(60),
  }),
  async execute({ minutesBack }, ctx) {
    const agentId = agentIdFrom(ctx);
    const from = Date.now() - minutesBack * 60_000;
    return guarded(() => getHadesBrowserClient().activityDigest(agentId, from));
  },
});

export const HADES_BROWSER_TOOL_NAMES = [
  "browser_list_workspaces",
  "browser_list_tabs",
  "browser_read_page",
  "browser_open_tab",
  "browser_list_collections",
  "browser_search_collections",
  "browser_activity_digest",
] as const;
