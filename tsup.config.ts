import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index":               "src/agents/index.ts",
    "memory/index":        "src/agents/memory/index.ts",
    "governance/index":    "src/agents/governance/index.ts",
    "security/index":      "src/agents/security/index.ts",
    "workflow/index":      "src/agents/workflow/index.ts",
    "tools/index":         "src/agents/tools/index.ts",
    "skills/index":        "src/agents/skills/index.ts",
    "definitions/index":   "src/agents/definitions/index.ts",
    "observability/index": "src/agents/observability/index.ts",
    "routing/index":       "src/agents/routing/index.ts",
  },
  format: ["esm", "cjs"],
  dts: { resolve: true },
  tsconfig: "tsconfig.lib.json",
  outDir: "dist",
  clean: true,
  external: [
    "@openai/agents", "openai", "zod", "@anthropic-ai/sdk",
    "@clerk/nextjs", "@auth0/nextjs-auth0",
    "@supabase/supabase-js", "@pinecone-database/pinecone",
    "@prisma/client", "convex", "modal", "@daytonaio/sdk",
    "composio-core", "@modelcontextprotocol/sdk", "@upstash/redis",
    "next", "react", "react-dom",
  ],
});
