/**
 * Next.js instrumentation hook — runs once at server startup.
 * Validates configuration and initializes singletons eagerly.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { config } = await import("@/agents/lib/config");

  if (!config.openai.apiKey) {
    console.warn(
      "[startup] OPENAI_API_KEY is not set. Agent calls will fail. Add it to .env.local."
    );
  }

  console.info(
    `[startup] DB=${config.db.provider} | Auth=${config.auth.provider} | Sandbox=${config.sandbox.provider}`
  );

  if (!config.tavily.apiKey) {
    console.info("[startup] TAVILY_API_KEY not set — web_search tool will not work.");
  }
  if (!config.composio.apiKey) {
    console.info("[startup] COMPOSIO_API_KEY not set — Composio tools will not work.");
  }

  // Initialize DB adapter (catches misconfiguration early)
  const { db } = await import("@/agents/db");
  void db;

  // Tools self-register when their modules are first imported by routes/harness.
  // No eager registration here to avoid bundling heavy optional dependencies
  // (Daytona, Modal, Browserbase) at startup.
}
