/**
 * Composio integration — provides authenticated access to 100+ apps
 * (GitHub, Slack, Gmail, Notion, Linear, etc.) via OAuth.
 *
 * Each user gets their own Composio entity so credentials are isolated.
 * Docs: https://docs.composio.dev
 */

import { z } from "zod";
import { registerTool } from "../registry";
import { config } from "../../lib/config";
import type { ToolContext } from "../types";

type ComposioClient = {
  getEntity: (entityId: string) => {
    execute: (actionName: string, params: Record<string, unknown>) => Promise<unknown>;
    getConnections: () => Promise<Array<{ appName: string; status: string }>>;
    initiateConnection: (appName: string) => Promise<{ redirectUrl: string }>;
  };
  getTools: (opts: { apps: string[] }) => Promise<unknown[]>;
};

let _composio: ComposioClient | null = null;

async function getComposio(): Promise<ComposioClient> {
  if (!_composio) {
    const { ComposioToolSet } = await import("composio-core");
    _composio = new ComposioToolSet({ apiKey: config.composio.apiKey }) as unknown as ComposioClient;
  }
  return _composio;
}

/** Resolve the Composio entity ID from ToolContext.userId (falls back to default). */
function entityId(ctx: ToolContext): string {
  return (ctx.userId ?? config.composio.entityId) || "default";
}

/**
 * Execute any Composio action by name.
 * Action names follow the pattern: APP_ACTION_NAME (e.g., GITHUB_CREATE_ISSUE).
 * See https://app.composio.dev/apps for all available actions.
 */
export const composioExecuteTool = registerTool({
  name: "composio_execute",
  description:
    "Execute an authenticated action via Composio (GitHub, Slack, Gmail, Notion, Linear, and 100+ more). The action name follows the pattern APP_ACTION_NAME. The user must have connected the app first.",
  parameters: z.object({
    actionName: z
      .string()
      .describe("Composio action name, e.g. GITHUB_CREATE_ISSUE or SLACK_SEND_MESSAGE"),
    params: z
      .record(z.unknown())
      .default({})
      .describe("Action parameters as defined by the Composio action schema"),
  }),
  async execute({ actionName, params }, ctx) {
    const composio = await getComposio();
    const entity = composio.getEntity(entityId(ctx));
    return entity.execute(actionName, params);
  },
});

/**
 * List all apps the user has connected via Composio.
 */
export const composioListConnectionsTool = registerTool({
  name: "composio_list_connections",
  description:
    "List all apps the current user has connected via Composio OAuth (e.g., GitHub, Slack).",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const composio = await getComposio();
    const entity = composio.getEntity(entityId(ctx));
    return entity.getConnections();
  },
});

/**
 * Get an OAuth connection URL for a Composio app.
 * Redirect the user to this URL to authorize the connection.
 */
export const composioConnectAppTool = registerTool({
  name: "composio_connect_app",
  description:
    "Get an OAuth URL so the user can connect a new app to Composio (e.g., connect their GitHub account).",
  parameters: z.object({
    appName: z
      .string()
      .describe("App identifier (e.g., 'github', 'slack', 'gmail', 'notion')"),
  }),
  async execute({ appName }, ctx) {
    const composio = await getComposio();
    const entity = composio.getEntity(entityId(ctx));
    const conn = await entity.initiateConnection(appName);
    return { redirectUrl: conn.redirectUrl };
  },
});

/**
 * Get OpenAI-compatible tool definitions for specific Composio apps.
 * Pass these directly to the OpenAI Agents SDK to let the model call them.
 */
export async function getComposioToolsForApps(apps: string[]): Promise<unknown[]> {
  const composio = await getComposio();
  return composio.getTools({ apps });
}
