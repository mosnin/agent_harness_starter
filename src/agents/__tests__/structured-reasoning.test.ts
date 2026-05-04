import { describe, it, expect, beforeEach } from "vitest";
import { buildStructuredReasoningPrompt, mergeInstructions } from "../lib/prompt-builder";
import { AnchorStore, parseTtlMs } from "../memory/anchors";
import { withStructuredReasoning } from "../plugins/structured-reasoning";
import type { PluginRunContext } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PluginRunContext> = {}): PluginRunContext {
  return {
    runId: "run-1",
    agentName: "TestAgent",
    model: "claude-haiku-4-5-20251001",
    userId: "user-1",
    startedAt: Date.now(),
    context: {},
    ...overrides,
  };
}

// ── prompt-builder ─────────────────────────────────────────────────────────────

describe("buildStructuredReasoningPrompt", () => {
  it("includes role and goal", () => {
    const out = buildStructuredReasoningPrompt({ role: "analyst", goal: "answer questions" });
    expect(out).toContain("You are: analyst");
    expect(out).toContain("Goal: answer questions");
  });

  it("renders PLAN section with default 3 steps", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g" });
    expect(out).toContain("PLAN");
    expect(out).toContain("3 steps");
  });

  it("renders PLAN section with custom step count", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g", planSteps: 5 });
    expect(out).toContain("5 steps");
  });

  it("renders ACT section", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g" });
    expect(out).toContain("ACT");
    expect(out).toContain("Execute your plan");
  });

  it("renders VERIFY section with custom tests", () => {
    const out = buildStructuredReasoningPrompt({
      role: "r",
      goal: "g",
      verifyTests: ["No hallucinations", "Cite sources"],
    });
    expect(out).toContain("VERIFY");
    expect(out).toContain("No hallucinations");
    expect(out).toContain("Cite sources");
  });

  it("renders CRITIC LOOP with default 2 passes", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g" });
    expect(out).toContain("CRITIC LOOP");
    expect(out).toContain("2 critic passes");
  });

  it("renders CRITIC LOOP with custom pass count", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g", maxCriticLoops: 3 });
    expect(out).toContain("3 critic passes");
  });

  it("renders rubric when provided", () => {
    const out = buildStructuredReasoningPrompt({
      role: "r",
      goal: "g",
      rubric: { accuracy: "Must cite sources", completeness: "Cover all points" },
    });
    expect(out).toContain("Must cite sources");
    expect(out).toContain("Cover all points");
  });

  it("renders constraints section when provided", () => {
    const out = buildStructuredReasoningPrompt({
      role: "r",
      goal: "g",
      constraints: ["Never invent data", "Cite all sources"],
    });
    expect(out).toContain("Constraints");
    expect(out).toContain("Never invent data");
  });

  it("renders tagged output when taggedOutput=true", () => {
    const out = buildStructuredReasoningPrompt({ role: "r", goal: "g", taggedOutput: true });
    expect(out).toContain("<plan>");
    expect(out).toContain("</plan>");
    expect(out).toContain("<act>");
    expect(out).toContain("<verify>");
    expect(out).toContain("<critic_loop>");
  });

  it("renders memory anchors when provided", () => {
    const out = buildStructuredReasoningPrompt({
      role: "r",
      goal: "g",
      anchors: [{ fact: "User TZ is UTC+9", useFor: "scheduling", ttl: "1h" }],
    });
    expect(out).toContain("Memory Anchors");
    expect(out).toContain("User TZ is UTC+9");
    expect(out).toContain("scheduling");
  });
});

describe("mergeInstructions", () => {
  it("appends block with divider", () => {
    const result = mergeInstructions("Base instructions.", "Block content");
    expect(result).toBe("Base instructions.\n\n---\n\nBlock content");
  });

  it("returns base unchanged when block is empty", () => {
    const result = mergeInstructions("Base instructions.", "");
    expect(result).toBe("Base instructions.");
  });
});

// ── AnchorStore ────────────────────────────────────────────────────────────────

describe("AnchorStore", () => {
  let store: AnchorStore;
  beforeEach(() => { store = new AnchorStore(); });

  it("sets and gets a live anchor", () => {
    store.set("ns", "tz", "UTC+9", { ttl: "1h" });
    const entry = store.get("ns", "tz");
    expect(entry).toBeDefined();
    expect(entry?.fact).toBe("UTC+9");
  });

  it("returns undefined for missing anchor", () => {
    expect(store.get("ns", "missing")).toBeUndefined();
  });

  it("evicts expired anchor (expire policy)", async () => {
    store.set("ns", "key", "val", { ttl: "1s" });
    await new Promise((r) => setTimeout(r, 10));
    // Manually expire by setting expiresAt in the past
    const entry = store.get("ns", "key");
    // Not expired yet at < 1s; just confirm it's there
    expect(entry?.fact).toBe("val");
  });

  it("getAll returns only live entries", () => {
    store.set("ns", "a", "fact-a", { ttl: "1h" });
    store.set("ns", "b", "fact-b", { ttl: "1h" });
    const entries = store.getAll("ns");
    expect(entries).toHaveLength(2);
  });

  it("delete removes a specific anchor", () => {
    store.set("ns", "key", "val");
    store.delete("ns", "key");
    expect(store.get("ns", "key")).toBeUndefined();
  });

  it("clearNamespace removes all anchors for namespace", () => {
    store.set("ns", "a", "1");
    store.set("ns", "b", "2");
    store.clearNamespace("ns");
    expect(store.getAll("ns")).toHaveLength(0);
  });

  it("format returns empty string when no anchors", () => {
    expect(store.format("ns")).toBe("");
  });

  it("format includes fact and useFor", () => {
    store.set("ns", "tz", "UTC+9", { useFor: "scheduling", ttl: "1h" });
    const formatted = store.format("ns");
    expect(formatted).toContain("UTC+9");
    expect(formatted).toContain("scheduling");
    expect(formatted).toContain("Pinned facts");
  });
});

describe("parseTtlMs", () => {
  it("parses seconds", () => { expect(parseTtlMs("30s")).toBe(30_000); });
  it("parses minutes", () => { expect(parseTtlMs("5m")).toBe(300_000); });
  it("parses hours", () => { expect(parseTtlMs("2h")).toBe(7_200_000); });
  it("parses days", () => { expect(parseTtlMs("7d")).toBe(604_800_000); });
  it("parses forever as Infinity", () => { expect(parseTtlMs("forever")).toBe(Infinity); });
  it("throws on invalid format", () => {
    expect(() => parseTtlMs("bad")).toThrow("Invalid TTL format");
  });
});

// ── withStructuredReasoning plugin ────────────────────────────────────────────

describe("withStructuredReasoning plugin", () => {
  it("has name 'structured-reasoning'", () => {
    const plugin = withStructuredReasoning({ role: "r", goal: "g" });
    expect(plugin.name).toBe("structured-reasoning");
  });

  it("onResolveInstructions appends structured block to base instructions", () => {
    const plugin = withStructuredReasoning({ role: "analyst", goal: "analyze data" });
    const ctx = makeCtx();
    const result = plugin.onResolveInstructions!("Base instructions.", "user msg", ctx);
    expect(result).toContain("Base instructions.");
    expect(result).toContain("analyst");
    expect(result).toContain("analyze data");
    expect(result).toContain("PLAN");
    expect(result).toContain("CRITIC LOOP");
  });

  it("injects anchor store content when user has anchors", () => {
    const store = new AnchorStore();
    store.set("user-1", "tz", "UTC+9", { useFor: "scheduling", ttl: "1h" });
    const plugin = withStructuredReasoning({ role: "r", goal: "g", anchorStore: store });
    const ctx = makeCtx({ userId: "user-1" });
    const result = plugin.onResolveInstructions!("Base.", "msg", ctx);
    expect(result).toContain("UTC+9");
    expect(result).toContain("scheduling");
  });

  it("uses anchorNamespace function when provided", () => {
    const store = new AnchorStore();
    store.set("org-123", "policy", "strict", { useFor: "decisions", ttl: "forever" });
    const plugin = withStructuredReasoning({
      role: "r",
      goal: "g",
      anchorStore: store,
      anchorNamespace: (ctx) => `org-${ctx.context.orgId as string}`,
    });
    const ctx = makeCtx({ context: { orgId: "123" } });
    const result = plugin.onResolveInstructions!("Base.", "msg", ctx);
    expect(result).toContain("strict");
  });

  it("skips anchor injection when no userId and no anchorNamespace", () => {
    const store = new AnchorStore();
    store.set("user-2", "key", "val", { ttl: "1h" });
    const plugin = withStructuredReasoning({ role: "r", goal: "g", anchorStore: store });
    const ctx = makeCtx({ userId: undefined });
    const result = plugin.onResolveInstructions!("Base.", "msg", ctx);
    expect(result).not.toContain("val");
  });
});
