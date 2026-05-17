import type { EmbeddingService, EmbeddingResult } from "../types";

export interface OpenAIEmbeddingOptions {
  apiKey?: string;      // default: process.env.OPENAI_API_KEY
  model?: string;       // default: "text-embedding-3-small"
  dimensions?: number;  // default: 1536 for ada, 1536 for 3-small
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number; object: string }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  readonly model: string;
  private readonly apiKey: string;

  constructor(options?: OpenAIEmbeddingOptions) {
    this.model = options?.model ?? "text-embedding-3-small";
    this.dimensions = options?.dimensions ?? 1536;
    const key = options?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "OpenAI API key is required. Provide via options.apiKey or OPENAI_API_KEY environment variable."
      );
    }
    this.apiKey = key;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: text, model: this.model }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;
    return {
      vector: data.data[0].embedding,
      model: data.model,
      tokenCount: data.usage.prompt_tokens,
      cached: false,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;
    // Sort by index to ensure correct order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    const tokensPerItem = Math.ceil(data.usage.prompt_tokens / texts.length);

    return sorted.map((item) => ({
      vector: item.embedding,
      model: data.model,
      tokenCount: tokensPerItem,
      cached: false,
    }));
  }
}
