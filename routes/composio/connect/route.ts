/**
 * GET /api/composio/connect?app=GITHUB
 *
 * Initiates a Composio OAuth flow for the authenticated user.
 * Redirects to the provider's OAuth page.
 *
 * App names must match Composio's naming convention (uppercase letters,
 * digits, underscores — e.g. GITHUB, GOOGLE_CALENDAR, SLACK).
 *
 * To restrict which apps are allowed, set COMPOSIO_ALLOWED_APPS in your
 * environment:
 *   COMPOSIO_ALLOWED_APPS=GITHUB,SLACK,NOTION
 * If unset, any validly-formatted app name is accepted.
 */

import { auth } from "@/agents/auth";
import { config } from "@/agents/lib/config";

/** Composio app names are always SCREAMING_SNAKE_CASE. */
const APP_NAME_RE = /^[A-Z][A-Z0-9_]{1,49}$/;

function validateAppName(app: string): { ok: true } | { ok: false; reason: string } {
  if (!APP_NAME_RE.test(app)) {
    return {
      ok: false,
      reason: "Invalid app name. Must be uppercase letters, digits, and underscores (e.g. GITHUB, GOOGLE_CALENDAR).",
    };
  }

  const allowedRaw = process.env.COMPOSIO_ALLOWED_APPS;
  if (allowedRaw) {
    const allowed = new Set(allowedRaw.split(",").map((s) => s.trim().toUpperCase()));
    if (!allowed.has(app)) {
      return {
        ok: false,
        reason: `App "${app}" is not in the allowed list. Set COMPOSIO_ALLOWED_APPS to configure it.`,
      };
    }
  }

  return { ok: true };
}

export async function GET(req: Request) {
  const user = await auth.requireAuth(req);
  const { searchParams } = new URL(req.url);
  const appName = searchParams.get("app")?.toUpperCase() ?? "";

  if (!appName) {
    return Response.json({ error: "Missing ?app= parameter" }, { status: 400 });
  }

  const validation = validateAppName(appName);
  if (!validation.ok) {
    return Response.json({ error: validation.reason }, { status: 400 });
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

    const entity = (toolset as unknown as {
      getEntity: (id: string) => {
        initiateConnection: (app: string) => Promise<{ redirectUrl: string }>;
      };
    }).getEntity(user.id);

    const { redirectUrl } = await entity.initiateConnection(appName);
    return Response.redirect(redirectUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Failed to initiate connection: ${msg}` }, { status: 500 });
  }
}
