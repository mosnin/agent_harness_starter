/**
 * GET /api/composio/connect?app=GITHUB
 *
 * Initiates a Composio OAuth flow for the authenticated user.
 * Redirects to the provider's OAuth page.
 */

import { auth } from "@/agents/auth";
import { config } from "@/agents/lib/config";

export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const { searchParams } = new URL(req.url);
  const appName = searchParams.get("app");

  if (!appName) {
    return Response.json({ error: "Missing ?app= parameter" }, { status: 400 });
  }

  if (!config.composio.apiKey) {
    return Response.json({ error: "Composio not configured (COMPOSIO_API_KEY missing)" }, { status: 503 });
  }

  try {
    const { ComposioToolSet } = await import("composio-core");
    const toolset = new ComposioToolSet({
      apiKey: config.composio.apiKey,
      entityId: user.id,
    });

    const entity = (toolset as unknown as { getEntity: (id: string) => { initiateConnection: (app: string) => Promise<{ redirectUrl: string }> } }).getEntity(user.id);
    const { redirectUrl } = await entity.initiateConnection(appName);

    return Response.redirect(redirectUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Failed to initiate connection: ${msg}` }, { status: 500 });
  }
}
