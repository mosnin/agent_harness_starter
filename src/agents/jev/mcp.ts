/**
 * Jev MCP surface — jev-mcp / decide-mcp style tools.
 * Register into the existing tool registry so /api/mcp exposes them.
 * Off by default: set HADES_MCP_JEV=true. Each tool requires ctx.userId
 * unless HADES_MCP_JEV_ANON=true.
 */

import { z } from "zod";
import { registerTool } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { assessToolRisk } from "./auto-mode";
import { verifyCitation, screenExternal } from "./guardrails";
import { judge, quietAsk } from "./decisions";
import { rerankResults } from "./scoring";
import { createJevAsker } from "./client";
import { semanticFind, extractValue, compareTexts, bindFunctionCall } from "./extract";
import { planAndRerankSearch } from "./search";
import { stopHook, assessGitRisk } from "./hooks";
import { filterPassages } from "./rag";

function requireJevMcpAuth(ctx: ToolContext): void {
  if (process.env.HADES_MCP_JEV_ANON === "true") return;
  if (!ctx.userId) {
    throw new Error("jev_* MCP tools require authentication");
  }
}

export function registerJevMcpTools(): void {
  registerTool({
    name: "jev_screen",
    description: "Screen untrusted text for injection, secrets, and substance using Jev.",
    category: "jev",
    parameters: z.object({
      content: z.string().min(1),
      purpose: z.string().optional(),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return screenExternal({ content: input.content, purpose: input.purpose, asker: createJevAsker() });
    },
  });

  registerTool({
    name: "jev_verify",
    description: "Verify a claim against evidence with a Jev citation check.",
    category: "jev",
    parameters: z.object({
      claim: z.string().min(1),
      evidence: z.string().min(1),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return verifyCitation(input);
    },
  });

  registerTool({
    name: "jev_decide",
    description: "Ask Jev to pick among closed alternatives, with ask_user / investigate escapes.",
    category: "jev",
    parameters: z.object({
      decision: z.string().min(1),
      evidence: z.string().min(1),
      candidates: z.record(z.string(), z.string()),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return judge(input);
    },
  });

  registerTool({
    name: "jev_rerank",
    description: "Rerank search candidates with per-item Jev relevance nouls.",
    category: "jev",
    parameters: z.object({
      request: z.string().min(1),
      results: z.array(z.object({
        id: z.string(),
        title: z.string().optional(),
        snippet: z.string(),
        source: z.string().optional(),
      })),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return rerankResults(input);
    },
  });

  registerTool({
    name: "jev_quiet_ask",
    description: "Decide whether Hades can answer a closed question without bothering the user.",
    category: "jev",
    parameters: z.object({
      question: z.string().min(1),
      options: z.record(z.string(), z.string()),
      userRequest: z.string().min(1),
      facts: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return quietAsk(input);
    },
  });

  registerTool({
    name: "jev_auto_mode",
    description: "Assess a pending tool call for destructive / exfil / scope risk.",
    category: "jev",
    parameters: z.object({
      userRequest: z.string().min(1),
      toolName: z.string().min(1),
      toolArguments: z.unknown(),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return assessToolRisk({
        userRequest: input.userRequest,
        toolName: input.toolName,
        toolArguments: input.toolArguments,
      });
    },
  });

  registerTool({
    name: "jev_find",
    description: "Pick the candidate that answers a query (semantic find).",
    category: "jev",
    parameters: z.object({
      query: z.string().min(1),
      candidates: z.array(z.object({ id: z.string(), text: z.string() })),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return semanticFind(input);
    },
  });

  registerTool({
    name: "jev_extract",
    description: "Extract a closed-set field value from a document.",
    category: "jev",
    parameters: z.object({
      field: z.string().min(1),
      document: z.string().min(1),
      candidates: z.array(z.string()).min(2),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return extractValue(input);
    },
  });

  registerTool({
    name: "jev_compare",
    description: "Decide whether two texts assert the same fact, contradict, or differ.",
    category: "jev",
    parameters: z.object({
      left: z.string().min(1),
      right: z.string().min(1),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return compareTexts(input);
    },
  });

  registerTool({
    name: "jev_bind",
    description: "Bind a request to a function name and closed-set arguments.",
    category: "jev",
    parameters: z.object({
      request: z.string().min(1),
      functions: z.array(z.object({
        name: z.string(),
        description: z.string(),
        args: z.record(z.string(), z.record(z.string(), z.string())).optional(),
      })),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return bindFunctionCall(input);
    },
  });

  registerTool({
    name: "jev_search",
    description: "Classify search intent/sources and rerank results.",
    category: "jev",
    parameters: z.object({
      request: z.string().min(1),
      results: z.array(z.object({
        id: z.string(),
        title: z.string().optional(),
        snippet: z.string(),
        source: z.string().optional(),
      })),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return planAndRerankSearch(input);
    },
  });

  registerTool({
    name: "jev_filter_passages",
    description: "Filter RAG passages for relevance and prompt injection.",
    category: "jev",
    parameters: z.object({
      query: z.string().min(1),
      passages: z.array(z.object({
        id: z.string(),
        text: z.string(),
        score: z.number().optional(),
      })),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return filterPassages(input);
    },
  });

  registerTool({
    name: "jev_stop",
    description: "Limpet-style stop-hook: did the reply violate a completion rule?",
    category: "jev",
    parameters: z.object({
      goal: z.string().min(1),
      finalMessage: z.string().min(1),
      rules: z.array(z.string()).optional(),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return stopHook(input);
    },
  });

  registerTool({
    name: "jev_git",
    description: "Assess a git command for force-push / unrecoverable risk.",
    category: "jev",
    parameters: z.object({
      command: z.string().min(1),
      userRequest: z.string().min(1),
    }),
    async execute(input, ctx) {
      requireJevMcpAuth(ctx);
      return assessGitRisk(input);
    },
  });
}
