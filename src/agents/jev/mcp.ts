/**
 * Jev MCP surface — jev-mcp / decide-mcp style tools.
 * Register into the existing tool registry so /api/mcp exposes them.
 */

import { z } from "zod";
import { registerTool } from "../tools/registry";
import { assessToolRisk } from "./auto-mode";
import { verifyCitation, screenExternal } from "./guardrails";
import { judge, quietAsk } from "./decisions";
import { rerankResults } from "./scoring";
import { createJevAsker } from "./client";

export function registerJevMcpTools(): void {
  registerTool({
    name: "jev_screen",
    description: "Screen untrusted text for injection, secrets, and substance using Jev.",
    category: "jev",
    parameters: z.object({
      content: z.string().min(1),
      purpose: z.string().optional(),
    }),
    async execute(input) {
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
    async execute(input) {
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
    async execute(input) {
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
    async execute(input) {
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
    async execute(input) {
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
    async execute(input) {
      return assessToolRisk({
        userRequest: input.userRequest,
        toolName: input.toolName,
        toolArguments: input.toolArguments,
      });
    },
  });
}
