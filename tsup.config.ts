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
    "errors/index":        "src/agents/errors/index.ts",
    "guardrails/index":    "src/agents/guardrails/index.ts",
    "cache/index":         "src/agents/cache/index.ts",
    "providers/index":     "src/agents/providers/index.ts",
    "guidance/index":      "src/agents/guidance/index.ts",
    "swarm/index":         "src/agents/swarm/index.ts",
    "claims/index":        "src/agents/claims/index.ts",
    "embeddings/index":    "src/agents/embeddings/index.ts",
    "federation/index":    "src/agents/federation/index.ts",
    "codex/index":         "src/agents/codex/index.ts",
    "runtime":             "src/agents/runtime.ts",
    "swarm-runtime/index": "src/swarm-runtime/index.ts",
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
    "playwright-core", "chromium-bidi", "@browserbasehq/sdk", "@tavily/core",
    "next", "react", "react-dom",
    // node: builtins are always external at runtime (platform: node), but the
    // dts bundler (`dts.resolve: true`) also needs them declared external —
    // otherwise it tries to inline @types/node's ambient modules and fails
    // ('"EventEmitter" is not exported by "node:events"').
    /^node:/,
  ],
});
