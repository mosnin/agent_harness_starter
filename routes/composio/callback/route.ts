/**
 * DROP THIS FILE INTO: your-app/src/app/api/composio/callback/route.ts
 *
 * OAuth callback handler for Composio app connections.
 *
 * After a user clicks an OAuth connect URL (from composio_connect_app tool),
 * Composio redirects here with a `connectedAccountId` param.
 *
 * Flow:
 *  1. User clicks "Connect GitHub" in your UI
 *  2. Your UI calls composio_connect_app → gets redirectUrl
 *  3. User is redirected to GitHub OAuth
 *  4. GitHub redirects back to Composio
 *  5. Composio redirects here with connectedAccountId
 *  6. You redirect the user back to your app
 *
 * Configure the redirect URL in your Composio dashboard:
 *   https://app.composio.dev → Settings → OAuth Redirect URLs
 *   Add: https://yourapp.com/api/composio/callback
 */

import { auth } from "@/agents/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const connectedAccountId = searchParams.get("connectedAccountId");
  const appName = searchParams.get("app") ?? "unknown";
  const errorParam = searchParams.get("error");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  if (errorParam) {
    console.error(`[composio/callback] OAuth error for app=${appName}:`, errorParam);
    return Response.redirect(`${appUrl}/settings/integrations?error=${encodeURIComponent(errorParam)}`);
  }

  if (!connectedAccountId) {
    return Response.redirect(`${appUrl}/settings/integrations?error=missing_account_id`);
  }

  // Optionally verify the user session here
  try {
    await auth.requireAuth(req);
  } catch {
    // Auth may not have a session cookie in this redirect flow — log and continue
    console.warn("[composio/callback] Could not verify user session during OAuth callback");
  }

  console.info(`[composio/callback] Connected: app=${appName} accountId=${connectedAccountId}`);

  // Redirect to your app's integration settings page with a success indicator
  return Response.redirect(
    `${appUrl}/settings/integrations?connected=${encodeURIComponent(appName)}&accountId=${connectedAccountId}`
  );
}
