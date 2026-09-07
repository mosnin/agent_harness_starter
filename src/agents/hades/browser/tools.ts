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
  const agentId =
    typeof ctx.meta?.agentId === "string" ? ctx.meta.agentId : undefined;
  if (!agentId) {
    throw new Error(
      "Browser tools need meta.agentId in the tool context to check consent.",
    );
  }
  return agentId;
}

/** Turn a consent refusal into something the model can act on. */
async function guarded<T>(
  run: () => Promise<T>,
): Promise<T | { refused: true; reason: string }> {
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
    return guarded(() =>
      getHadesBrowserClient().listTabs(agentId, workspaceId),
    );
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
    return guarded(() =>
      getHadesBrowserClient().readPage(agentId, tabId, { format, maxLength }),
    );
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
    background: z
      .boolean()
      .default(true)
      .describe("Leave true unless the user asked to be taken there"),
  }),
  async execute({ url, workspaceId, background }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().openTab(agentId, url, {
        workspaceId,
        background,
      }),
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
      getHadesBrowserClient().searchCollections(agentId, query, {
        limit,
        collectionIds,
      }),
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

// ── Agent mode ───────────────────────────────────────────────────────────────
//
// These act inside a page. The browser gates them a third time: they run only
// in its Agent space or on a site the user granted, they stop the moment the
// user touches the page, and a button that pays, sends or deletes is put to
// the user before it is clicked. A refusal names which of those applied.

function runIdFrom(ctx: {
  meta?: Record<string, unknown>;
}): string | undefined {
  return typeof ctx.meta?.runId === "string" ? ctx.meta.runId : undefined;
}

export const browserSnapshotTool = registerTool({
  name: "browser_snapshot",
  description:
    "See a page the way a person would: every link, button, field and heading with a ref you can act on, plus where each sits. Take a fresh snapshot after anything changes; refs from an old one are refused.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    interactiveOnly: z.boolean().default(true),
    maxNodes: z.number().int().min(20).max(1000).default(250),
    screenshot: z
      .boolean()
      .default(false)
      .describe("Attach a PNG of the viewport; costs a capture"),
  }),
  async execute({ tabId, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().snapshot(agentId, tabId, {
        ...options,
        runId: runIdFrom(ctx),
      }),
    );
  },
});

export const browserExtractTool = registerTool({
  name: "browser_extract",
  description:
    "Read the text of one element (by ref or CSS selector) or of the page's main content — a table, a price, an article — without the rest of the page.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    maxLength: z.number().int().min(200).max(200_000).default(20_000),
  }),
  async execute({ tabId, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().extract(agentId, tabId, {
        ...options,
        runId: runIdFrom(ctx),
      }),
    );
  },
});

export const browserWaitForTool = registerTool({
  name: "browser_wait_for",
  description:
    "Wait until text appears, the URL changes, a named element exists, or the page settles. Use it after a click that loads something instead of snapshotting in a loop.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    text: z.string().optional(),
    urlContains: z.string().optional(),
    name: z.string().optional(),
    networkIdle: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  }),
  async execute({ tabId, ...condition }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().waitFor(
        agentId,
        tabId,
        condition,
        runIdFrom(ctx),
      ),
    );
  },
});

export const browserClickTool = registerTool({
  name: "browser_click",
  description:
    "Click an element from the latest snapshot. Buttons that pay, send, delete or confirm pause and ask the user first. The result says whether a navigation started — take a new snapshot if so.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    ref: z.string().describe("A ref from browser_snapshot, e.g. r12"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    clickCount: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  async execute({ tabId, ref, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().click(agentId, tabId, ref, {
        ...options,
        runId: runIdFrom(ctx),
      }),
    );
  },
});

export const browserTypeTool = registerTool({
  name: "browser_type",
  description:
    "Type into a field from the latest snapshot. Never for passwords or verification codes — the browser refuses. Payment fields ask the user first. submit=true presses Enter afterwards.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    ref: z.string(),
    text: z.string(),
    clear: z.boolean().default(true),
    submit: z.boolean().default(false),
  }),
  async execute({ tabId, ref, text, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().type(agentId, tabId, ref, text, {
        ...options,
        runId: runIdFrom(ctx),
      }),
    );
  },
});

export const browserPressTool = registerTool({
  name: "browser_press",
  description:
    "Press a key (Enter, Tab, Escape, arrows…) in the focused element of a tab.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]),
  }),
  async execute({ tabId, key }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().press(agentId, tabId, key, runIdFrom(ctx)),
    );
  },
});

export const browserSelectTool = registerTool({
  name: "browser_select",
  description: "Choose an option in a select element by its label or value.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    ref: z.string(),
    value: z.string(),
  }),
  async execute({ tabId, ref, value }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().select(
        agentId,
        tabId,
        ref,
        value,
        runIdFrom(ctx),
      ),
    );
  },
});

export const browserScrollTool = registerTool({
  name: "browser_scroll",
  description:
    "Scroll a tab to the top or bottom, by an amount, or until an element is in view.",
  category: "browser",
  parameters: z.object({
    tabId: z.string(),
    to: z.enum(["top", "bottom"]).optional(),
    by: z
      .object({ x: z.number().optional(), y: z.number().optional() })
      .optional(),
    ref: z.string().optional(),
  }),
  async execute({ tabId, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().scroll(agentId, tabId, {
        ...options,
        runId: runIdFrom(ctx),
      }),
    );
  },
});

// ── Shared memory ────────────────────────────────────────────────────────────

export const browserRememberTool = registerTool({
  name: "browser_remember",
  description:
    "Remember something for later — a fact you learned, a preference the user stated, a summary of what you did. Shared with the Hades desktop app and every other agent the user connects.",
  category: "browser",
  parameters: z.object({
    kind: z.enum(["run", "page", "note", "fact", "preference"]),
    title: z.string().min(1).max(200),
    body: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    tags: z.array(z.string()).optional(),
    id: z.string().optional().describe("Overwrite an existing record"),
  }),
  async execute(record, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() => getHadesBrowserClient().remember(agentId, record));
  },
});

export const browserRecallTool = registerTool({
  name: "browser_recall",
  description:
    "Search what has been remembered: past runs, pages the user sent to Hades, facts and preferences. Check here before asking the user something they may have told an agent before.",
  category: "browser",
  parameters: z.object({
    query: z.string().min(1),
    kinds: z
      .array(z.enum(["run", "page", "note", "fact", "preference"]))
      .optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ query, ...options }, ctx) {
    const agentId = agentIdFrom(ctx);
    return guarded(() =>
      getHadesBrowserClient().recall(agentId, query, options),
    );
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
  "browser_snapshot",
  "browser_extract",
  "browser_wait_for",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_select",
  "browser_scroll",
  "browser_remember",
  "browser_recall",
] as const;

/** The subset that acts inside a page — grant these only to agents that should. */
export const HADES_BROWSER_ACTION_TOOL_NAMES = [
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_select",
  "browser_scroll",
] as const;
