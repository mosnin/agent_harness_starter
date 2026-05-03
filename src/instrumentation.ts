/**
 * Next.js instrumentation hook — runs once at server startup.
 * Validates configuration and initializes singletons eagerly.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { config } = await import("@/lib/config");

  if (!config.openai.apiKey) {
    console.warn(
      "[startup] OPENAI_API_KEY is not set. Agent calls will fail. Add it to .env.local."
    );
  }

  // Log active providers
  console.info(
    `[startup] DB=${config.db.provider} | Auth=${config.auth.provider} | Sandbox=${config.sandbox.provider}`
  );

  if (!config.tavily.apiKey) {
    console.info("[startup] TAVILY_API_KEY not set — web_search tool will not work.");
  }

  if (!config.composio.apiKey) {
    console.info("[startup] COMPOSIO_API_KEY not set — Composio tools will not work.");
  }

  // Pre-register all tools so the MCP server has them on first request
  await import("@/tools/index");

  // Initialize DB adapter (catches misconfiguration early)
  const { db } = await import("@/db");
  void db; // touch singleton
}
