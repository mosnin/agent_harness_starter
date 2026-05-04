import { describe, it, expect, vi } from "vitest";
import { createMemoryManager, scopeKey } from "../memory/manager";
import { SESSION_POLICY, USER_LONG_TERM_POLICY, GLOBAL_KNOWLEDGE_POLICY } from "../memory/policy";
import { estimateTokens } from "../routing/context-budget";
import type { MemoryAdapter, MemoryEntry } from "../memory/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "entry-1",
    key: "user:u1",
    content: "User prefers concise answers.",
    createdAt: new Date(),
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  return {
    store: vi.fn(async (_key: string, content: string, metadata?: Record<string, unknown>) =>
      makeEntry({ content, metadata })
    ),
    retrieve: vi.fn(async () => [makeEntry()]),
    deleteAll: vi.fn(async () => undefined),
    list: vi.fn(async () => [makeEntry()]),
    ...overrides,
  };
}

// ── scopeKey ──────────────────────────────────────────────────────────────────

describe("scopeKey", () => {
  it("generates agent-scoped key", () => {
    expect(scopeKey("agent", { agentId: "my-agent" })).toBe("agent:my-agent");
  });

  it("generates user-scoped key", () => {
    expect(scopeKey("user", { userId: "u123" })).toBe("user:u123");
  });

  it("generates thread-scoped key", () => {
    expect(scopeKey("thread", { threadId: "t456" })).toBe("thread:t456");
  });

  it("generates global key regardless of ids", () => {
    expect(scopeKey("global", {})).toBe("global");
  });

  it("falls back to default when id is absent", () => {
    expect(scopeKey("agent", {})).toBe("agent:default");
    expect(scopeKey("user", {})).toBe("user:anonymous");
  });
});

// ── createMemoryManager ───────────────────────────────────────────────────────

describe("createMemoryManager", () => {
  it("returns a manager with the configured adapter and policy", () => {
    const adapter = makeAdapter();
    const manager = createMemoryManager({ adapter, policy: SESSION_POLICY });
    expect(manager.adapter).toBe(adapter);
    expect(manager.policy).toBe(SESSION_POLICY);
  });
});

// ── store ─────────────────────────────────────────────────────────────────────

describe("manager.store", () => {
  it("delegates to adapter.store with the correct key and content", async () => {
    const adapter = makeAdapter();
    const manager = createMemoryManager({ adapter, policy: SESSION_POLICY });

    await manager.store("user:u1", "Test memory");

    expect(adapter.store).toHaveBeenCalledWith(
      "user:u1",
      "Test memory",
      expect.any(Object)
    );
  });

  it("returns a MemoryEntry with the stored content", async () => {
    const adapter = makeAdapter();
    const manager = createMemoryManager({ adapter, policy: SESSION_POLICY });

    const entry = await manager.store("user:u1", "Hello");
    expect(entry).toMatchObject({ content: "Hello" });
  });
});

// ── retrieve ──────────────────────────────────────────────────────────────────

describe("manager.retrieve", () => {
  it("returns results from the adapter", async () => {
    const adapter = makeAdapter();
    const manager = createMemoryManager({ adapter, policy: USER_LONG_TERM_POLICY });

    const results = await manager.retrieve("user:u1", "test query");
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── evictExpired ──────────────────────────────────────────────────────────────

describe("manager.evictExpired", () => {
  it("calls list on the adapter to find candidates", async () => {
    const adapter = makeAdapter({
      list: vi.fn(async () => []),
    });
    const manager = createMemoryManager({ adapter, policy: USER_LONG_TERM_POLICY });
    await manager.evictExpired("user:u1");
    expect(adapter.list).toHaveBeenCalledWith("user:u1", expect.any(Number));
  });
});

// ── compress ──────────────────────────────────────────────────────────────────

describe("manager.compress", () => {
  it("resolves without throwing", async () => {
    const adapter = makeAdapter({
      list: vi.fn(async () =>
        Array.from({ length: 10 }, (_, i) =>
          makeEntry({ id: `e${i}`, content: `Entry ${i}` })
        )
      ),
    });
    const manager = createMemoryManager({ adapter, policy: USER_LONG_TERM_POLICY });
    await expect(manager.compress("user:u1")).resolves.not.toThrow();
  });
});

// ── Pre-built policies ────────────────────────────────────────────────────────

describe("pre-built policies", () => {
  it("SESSION_POLICY has scope=thread", () => {
    // SESSION_POLICY uses "thread" scope per policy.ts
    expect(SESSION_POLICY.config.scope).toMatch(/thread|session/);
  });

  it("USER_LONG_TERM_POLICY has scope=user", () => {
    expect(USER_LONG_TERM_POLICY.config.scope).toBe("user");
  });

  it("GLOBAL_KNOWLEDGE_POLICY has scope=global", () => {
    expect(GLOBAL_KNOWLEDGE_POLICY.config.scope).toBe("global");
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns Math.ceil(length / 4)", () => {
    expect(estimateTokens("Hello")).toBe(Math.ceil("Hello".length / 4));
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles exactly divisible lengths", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});
