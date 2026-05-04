/**
 * Context budget management — trims what gets sent to the model.
 *
 * Three tiers: small (1k), medium (4k), large (16k+).
 * Applies the playbook's "shrink what you send" strategy:
 *   - Retrieval chunks capped at maxChunkTokens
 *   - System prompt addenda trimmed to fit within the budget
 *   - Conversation history truncated from oldest first
 *
 * Token counting is approximate (4 chars ≈ 1 token) to avoid a heavy dep.
 * Swap estimateTokens() for tiktoken or the Anthropic token count API if needed.
 */

export type ContextTier = "small" | "medium" | "large";

export interface ContextBudgetConfig {
  /** Hard token budget for this tier. */
  maxTokens: number;
  /** Max tokens per retrieval chunk. */
  maxChunkTokens: number;
  /** Max number of retrieval chunks to include. */
  maxChunks: number;
  /** Max tokens for the conversation history (excluding system prompt). */
  maxHistoryTokens: number;
}

export const CONTEXT_BUDGETS: Record<ContextTier, ContextBudgetConfig> = {
  small: {
    maxTokens: 1024,
    maxChunkTokens: 200,
    maxChunks: 3,
    maxHistoryTokens: 400,
  },
  medium: {
    maxTokens: 4096,
    maxChunkTokens: 400,
    maxChunks: 4,
    maxHistoryTokens: 2000,
  },
  large: {
    maxTokens: 16384,
    maxChunkTokens: 800,
    maxChunks: 6,
    maxHistoryTokens: 8000,
  },
};

// ── Token estimation (4 chars ≈ 1 token) ─────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Retrieval chunk trimming ──────────────────────────────────────────────────

export interface RetrievalChunk {
  id: string;
  text: string;
  score?: number;
}

/**
 * Select and trim retrieval chunks to fit within the budget.
 * Prefers higher-scored chunks; truncates long ones.
 */
export function trimChunks(
  chunks: RetrievalChunk[],
  budget: ContextBudgetConfig
): RetrievalChunk[] {
  const sorted = chunks
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, budget.maxChunks);

  return sorted.map((chunk) => {
    const approxMaxChars = budget.maxChunkTokens * 4;
    if (chunk.text.length <= approxMaxChars) return chunk;
    return { ...chunk, text: chunk.text.slice(0, approxMaxChars) + "…" };
  });
}

// ── History truncation ────────────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Truncate conversation history from oldest first to fit within maxHistoryTokens.
 * System messages are always preserved.
 */
export function truncateHistory(
  messages: Message[],
  budget: ContextBudgetConfig
): Message[] {
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  let total = 0;
  const kept: Message[] = [];

  // Walk from newest to oldest
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(nonSystem[i].content);
    if (total + tokens > budget.maxHistoryTokens) break;
    total += tokens;
    kept.unshift(nonSystem[i]);
  }

  return [...system, ...kept];
}

// ── System prompt trimming ────────────────────────────────────────────────────

/**
 * Trim a system prompt to fit within a character budget.
 * Preserves the first section (identity) and truncates addenda.
 */
export function trimSystemPrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, maxChars - 3) + "...";
}

// ── ContextBuilder — assembles a budget-aware prompt ─────────────────────────

export interface BuiltContext {
  systemPrompt: string;
  messages: Message[];
  chunks: RetrievalChunk[];
  estimatedTokens: number;
  tier: ContextTier;
}

export function buildContext(opts: {
  tier: ContextTier;
  systemPrompt: string;
  messages: Message[];
  chunks?: RetrievalChunk[];
}): BuiltContext {
  const budget = CONTEXT_BUDGETS[opts.tier];
  const maxSystemChars = budget.maxChunkTokens * 4 * 2; // ~2× a chunk for the system prompt

  const trimmedSystem = trimSystemPrompt(opts.systemPrompt, maxSystemChars);
  const trimmedChunks = trimChunks(opts.chunks ?? [], budget);
  const trimmedHistory = truncateHistory(opts.messages, budget);

  const estimated =
    estimateTokens(trimmedSystem) +
    trimmedHistory.reduce((acc, m) => acc + estimateTokens(m.content), 0) +
    trimmedChunks.reduce((acc, c) => acc + estimateTokens(c.text), 0);

  return {
    systemPrompt: trimmedSystem,
    messages: trimmedHistory,
    chunks: trimmedChunks,
    estimatedTokens: estimated,
    tier: opts.tier,
  };
}
