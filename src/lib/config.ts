/**
 * Central runtime config — reads env vars once and validates them.
 * Import `config` anywhere instead of reading process.env directly.
 */

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export type DbProvider = "supabase" | "convex" | "prisma";
export type AuthProvider = "clerk" | "auth0" | "none";
export type SandboxProvider = "daytona" | "modal" | "none";

export const config = {
  openai: {
    apiKey: optional("OPENAI_API_KEY"),
    model: optional("OPENAI_MODEL", "gpt-4o"),
  },

  tavily: {
    apiKey: optional("TAVILY_API_KEY"),
  },

  composio: {
    apiKey: optional("COMPOSIO_API_KEY"),
    entityId: optional("COMPOSIO_ENTITY_ID", "default"),
  },

  browserbase: {
    apiKey: optional("BROWSERBASE_API_KEY"),
    projectId: optional("BROWSERBASE_PROJECT_ID"),
  },

  daytona: {
    apiKey: optional("DAYTONA_API_KEY"),
    serverUrl: optional("DAYTONA_SERVER_URL", "https://app.daytona.io/api"),
  },

  modal: {
    tokenId: optional("MODAL_TOKEN_ID"),
    tokenSecret: optional("MODAL_TOKEN_SECRET"),
  },

  sandbox: {
    provider: optional("SANDBOX_PROVIDER", "none") as SandboxProvider,
  },

  db: {
    provider: optional("DB_PROVIDER", "supabase") as DbProvider,
    supabase: {
      url: optional("NEXT_PUBLIC_SUPABASE_URL"),
      anonKey: optional("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
      serviceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY"),
    },
    convex: {
      url: optional("NEXT_PUBLIC_CONVEX_URL"),
    },
    prisma: {
      url: optional("DATABASE_URL"),
    },
  },

  auth: {
    provider: optional("AUTH_PROVIDER", "none") as AuthProvider,
    clerk: {
      publishableKey: optional("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
      secretKey: optional("CLERK_SECRET_KEY"),
    },
    auth0: {
      secret: optional("AUTH0_SECRET"),
      baseUrl: optional("AUTH0_BASE_URL", "http://localhost:3000"),
      issuerBaseUrl: optional("AUTH0_ISSUER_BASE_URL"),
      clientId: optional("AUTH0_CLIENT_ID"),
      clientSecret: optional("AUTH0_CLIENT_SECRET"),
    },
  },

  mcp: {
    servers: JSON.parse(optional("MCP_SERVERS", "[]")) as Array<{
      name: string;
      url: string;
      apiKey?: string;
    }>,
  },

  app: {
    url: optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
    apiSecret: optional("API_SECRET", ""),
  },
} as const;
