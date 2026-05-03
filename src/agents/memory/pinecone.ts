/**
 * Pinecone MemoryAdapter — stores embeddings in a Pinecone vector index.
 *
 * Required env vars:
 *   PINECONE_API_KEY
 *   PINECONE_INDEX      — name of the index
 *   OPENAI_API_KEY      — used for text-embedding-3-small
 *
 * Setup: create a Pinecone index with dimension=1536, metric=cosine.
 */

import { randomUUID } from "crypto";
import type { MemoryAdapter, MemoryEntry } from "./types";

export class PineconeAdapter implements MemoryAdapter {
  private index: unknown = null;

  private async getIndex() {
    if (!this.index) {
      const { Pinecone } = await import("@pinecone-database/pinecone");
      const client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
      this.index = client.Index(process.env.PINECONE_INDEX ?? "agent-memory");
    }
    return this.index as ReturnType<ReturnType<typeof import("@pinecone-database/pinecone").Pinecone>["Index"]>;
  }

  private async embed(text: string): Promise<number[]> {
    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return resp.data[0].embedding;
  }

  async store(
    key: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    const index = await this.getIndex();
    const embedding = await this.embed(content);
    const id = randomUUID();
    const createdAt = new Date();

    await index.upsert([
      {
        id,
        values: embedding,
        metadata: {
          key,
          content,
          createdAt: createdAt.toISOString(),
          ...(metadata ?? {}),
        },
      },
    ]);

    return { id, key, content, metadata, createdAt };
  }

  async retrieve(key: string, query: string, topK = 5): Promise<MemoryEntry[]> {
    const index = await this.getIndex();
    const embedding = await this.embed(query);

    const result = await index.query({
      vector: embedding,
      topK,
      filter: { key: { $eq: key } },
      includeMetadata: true,
    });

    return (result.matches ?? []).map((m) => ({
      id: m.id,
      key: (m.metadata?.key as string) ?? key,
      content: (m.metadata?.content as string) ?? "",
      metadata: m.metadata as Record<string, unknown>,
      createdAt: new Date((m.metadata?.createdAt as string) ?? Date.now()),
      score: m.score,
    }));
  }

  async deleteAll(key: string): Promise<void> {
    const index = await this.getIndex();
    // Pinecone doesn't support delete-by-filter in all plans; fetch IDs first
    const result = await index.query({
      vector: new Array(1536).fill(0),
      topK: 1000,
      filter: { key: { $eq: key } },
    });
    const ids = result.matches?.map((m) => m.id) ?? [];
    if (ids.length > 0) await index.deleteMany(ids);
  }

  async list(key: string, limit = 50): Promise<MemoryEntry[]> {
    return this.retrieve(key, "", limit);
  }
}
