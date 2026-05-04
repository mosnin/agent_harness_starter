/**
 * PGVector MemoryAdapter — stores embeddings in Postgres via pgvector extension.
 * Compatible with Supabase and any Postgres instance with pgvector installed.
 *
 * Required env vars:
 *   DATABASE_URL or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   (NEXT_PUBLIC_SUPABASE_URL is also accepted as a fallback for Next.js projects)
 *   OPENAI_API_KEY (used for text-embedding-3-small)
 *
 * Setup SQL (run once):
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE agent_memories (
 *     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     key         TEXT NOT NULL,
 *     content     TEXT NOT NULL,
 *     metadata    JSONB,
 *     embedding   VECTOR(1536),
 *     created_at  TIMESTAMPTZ DEFAULT NOW()
 *   );
 *   CREATE INDEX ON agent_memories USING ivfflat (embedding vector_cosine_ops);
 *   CREATE INDEX ON agent_memories (key);
 */

import { randomUUID } from "crypto";
import type { MemoryAdapter, MemoryEntry } from "./types";

export class PgVectorAdapter implements MemoryAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getDb(): Promise<any> {
    if (!this.db) {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      this.db = createClient(url, key);
    }
    return this.db;
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
    const db = await this.getDb();
    const embedding = await this.embed(content);
    const id = randomUUID();

    const { error } = await db.from("agent_memories").insert({
      id,
      key,
      content,
      metadata,
      embedding: JSON.stringify(embedding),
    });

    if (error) throw new Error(`PgVector store error: ${error.message}`);

    return { id, key, content, metadata, createdAt: new Date() };
  }

  async retrieve(key: string, query: string, topK = 5): Promise<MemoryEntry[]> {
    const db = await this.getDb();
    const embedding = await this.embed(query);

    const { data, error } = await db.rpc("match_agent_memories", {
      query_embedding: JSON.stringify(embedding),
      match_key: key,
      match_count: topK,
    });

    if (error) throw new Error(`PgVector retrieve error: ${error.message}`);

    return (data ?? []).map(
      (row: { id: string; key: string; content: string; metadata: Record<string, unknown>; created_at: string; similarity: number }) => ({
        id: row.id,
        key: row.key,
        content: row.content,
        metadata: row.metadata,
        createdAt: new Date(row.created_at),
        score: row.similarity,
      })
    );
  }

  async deleteAll(key: string): Promise<void> {
    const db = await this.getDb();
    const { error } = await db.from("agent_memories").delete().eq("key", key);
    if (error) throw new Error(`PgVector deleteAll error: ${error.message}`);
  }

  async list(key: string, limit = 50): Promise<MemoryEntry[]> {
    const db = await this.getDb();
    const { data, error } = await db
      .from("agent_memories")
      .select("*")
      .eq("key", key)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`PgVector list error: ${error.message}`);

    return (data ?? []).map(
      (row: { id: string; key: string; content: string; metadata: Record<string, unknown>; created_at: string }) => ({
        id: row.id,
        key: row.key,
        content: row.content,
        metadata: row.metadata,
        createdAt: new Date(row.created_at),
      })
    );
  }
}
