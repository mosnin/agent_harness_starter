import { z } from "zod";
import { registerTool } from "../registry";
import { config } from "@/lib/config";

const SearchResult = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().optional(),
});

export type TavilySearchResult = z.infer<typeof SearchResult>;

export const tavilySearchTool = registerTool({
  name: "web_search",
  description:
    "Search the web for up-to-date information using Tavily. Use this when you need current events, facts, or information beyond your training data.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Maximum number of results to return"),
    searchDepth: z
      .enum(["basic", "advanced"])
      .default("basic")
      .describe("'advanced' is slower but more thorough"),
    includeAnswer: z
      .boolean()
      .default(true)
      .describe("Whether to include a synthesized answer"),
  }),
  async execute({ query, maxResults, searchDepth, includeAnswer }, { signal }) {
    const { tavily } = await import("@tavily/core");
    const client = tavily({ apiKey: config.tavily.apiKey });

    const response = await client.search(query, {
      maxResults,
      searchDepth,
      includeAnswer,
    });

    return {
      answer: response.answer ?? null,
      results: (response.results ?? []).map((r: Record<string, unknown>) => ({
        title: r.title as string,
        url: r.url as string,
        content: r.content as string,
        score: r.score as number | undefined,
      })),
    };
  },
});
