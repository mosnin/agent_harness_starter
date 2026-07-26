import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "fs/promises";
import { compileGuidance } from "../guidance/compiler";
import {
  destructiveOpsGate,
  secretsGate,
  toolAllowlistGate,
  diffSizeGate,
  aggregateGateResults,
} from "../guidance/gates";
import type { GateContext, GuidanceRule, GateResult } from "../guidance/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmptyCtx(overrides: Partial<GateContext> = {}): GateContext {
  return { ...overrides };
}

function makeRule(overrides: Partial<GuidanceRule> = {}): GuidanceRule {
  return {
    id: "R001",
    text: "test rule",
    riskClass: "medium",
    toolClasses: ["all"],
    intents: [],
    domains: [],
    priority: 5,
    source: "root",
    isConstitution: false,
    ...overrides,
  };
}

// ── Compiler tests ─────────────────────────────────────────────────────────────

describe("compileGuidance — via temp files", () => {
  const rootPath = "/tmp/test-claude-root.md";
  const localPath = "/tmp/test-claude-local.md";

  afterEach(async () => {
    // Clean up temp files (ignore errors if they don't exist)
    await unlink(rootPath).catch(() => {});
    await unlink(localPath).catch(() => {});
  });

  it("empty file returns PolicyBundle with zero rules", async () => {
    await writeFile(rootPath, "", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.rules).toHaveLength(0);
    expect(bundle.constitutionRules).toHaveLength(0);
    expect(bundle.manifest.totalRules).toBe(0);
  });

  it("returns a PolicyBundle with compiledAt Date and sourceFiles", async () => {
    await writeFile(rootPath, "", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.compiledAt).toBeInstanceOf(Date);
    expect(Array.isArray(bundle.sourceFiles)).toBe(true);
  });

  it("explicit rule ID [R001] is extracted with correct id", async () => {
    await writeFile(rootPath, "- [R001] Never expose API keys to external services.\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.rules.length).toBeGreaterThanOrEqual(1);
    const rule = bundle.rules.find((r) => r.id === "R001");
    expect(rule).toBeDefined();
    expect(rule!.id).toBe("R001");
  });

  it("risk class (critical) is parsed correctly", async () => {
    await writeFile(rootPath, "- [R002] Never delete production data. (critical)\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R002");
    expect(rule).toBeDefined();
    expect(rule!.riskClass).toBe("critical");
  });

  it("tool class [bash] is parsed → toolClasses includes 'bash'", async () => {
    await writeFile(rootPath, "- [R003] Always validate [bash] commands before execution.\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R003");
    expect(rule).toBeDefined();
    expect(rule!.toolClasses).toContain("bash");
  });

  it("intent #security → intents includes 'security'", async () => {
    await writeFile(rootPath, "- [R004] Must use HTTPS for all external calls. #security\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R004");
    expect(rule).toBeDefined();
    expect(rule!.intents).toContain("security");
  });

  it("domain @security → domains includes '@security'", async () => {
    await writeFile(rootPath, "- [R005] Always sanitize inputs. @security\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R005");
    expect(rule).toBeDefined();
    expect(rule!.domains).toContain("@security");
  });

  it("implicit rules from bullet points with 'never' get generated IDs", async () => {
    await writeFile(
      rootPath,
      "## Rules\n\n- Never commit secrets to version control.\n- Always run tests before merging.\n",
      "utf-8"
    );
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.rules.length).toBeGreaterThanOrEqual(2);
    const implRules = bundle.rules.filter((r) => r.id.startsWith("IMPL-"));
    expect(implRules.length).toBeGreaterThanOrEqual(2);
  });

  it("implicit rule with 'must' action verb is captured", async () => {
    await writeFile(rootPath, "- Must validate all inputs before processing.\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const implRules = bundle.rules.filter((r) => r.id.startsWith("IMPL-"));
    expect(implRules.length).toBeGreaterThanOrEqual(1);
    expect(implRules[0].text).toContain("Must validate");
  });

  it("rules under ## Core Principles → isConstitution = true", async () => {
    await writeFile(
      rootPath,
      "## Core Principles\n\n- [R010] Always respect user privacy.\n",
      "utf-8"
    );
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R010");
    expect(rule).toBeDefined();
    expect(rule!.isConstitution).toBe(true);
    expect(bundle.constitutionRules).toContain(rule);
  });

  it("critical risk rules are also in constitutionRules", async () => {
    await writeFile(rootPath, "- [R011] Never expose credentials. (critical)\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R011");
    expect(rule).toBeDefined();
    expect(rule!.isConstitution).toBe(true);
    expect(bundle.constitutionRules.some((r) => r.id === "R011")).toBe(true);
  });

  it("hash: same content → same hash", async () => {
    const content = "- [R020] Always run tests. #testing\n";
    await writeFile(rootPath, content, "utf-8");
    const bundle1 = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const bundle2 = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle1.hash).toBe(bundle2.hash);
  });

  it("hash: different content → different hash", async () => {
    await writeFile(rootPath, "- [R021] Always run tests.\n", "utf-8");
    const bundle1 = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });

    await writeFile(rootPath, "- [R022] Never skip tests.\n", "utf-8");
    const bundle2 = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });

    expect(bundle1.hash).not.toBe(bundle2.hash);
  });

  it("local override: CLAUDE.local.md rules have source 'local'", async () => {
    await writeFile(rootPath, "", "utf-8");
    await writeFile(localPath, "- [R030] Must use local database for dev. #feature\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath });
    const localRule = bundle.rules.find((r) => r.id === "R030");
    expect(localRule).toBeDefined();
    expect(localRule!.source).toBe("local");
  });

  it("root rules have source 'root'", async () => {
    await writeFile(rootPath, "- [R031] Must log all errors.\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    const rule = bundle.rules.find((r) => r.id === "R031");
    expect(rule).toBeDefined();
    expect(rule!.source).toBe("root");
  });

  it("manifest.byRisk counts are correct", async () => {
    await writeFile(
      rootPath,
      "- [R040] Critical rule. (critical)\n- [R041] High rule. (high)\n- [R042] Default rule.\n",
      "utf-8"
    );
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.manifest.byRisk.critical).toBeGreaterThanOrEqual(1);
    expect(bundle.manifest.byRisk.high).toBeGreaterThanOrEqual(1);
    expect(bundle.manifest.totalRules).toBeGreaterThanOrEqual(3);
  });

  it("manifest.criticalRuleIds includes IDs of critical rules", async () => {
    await writeFile(rootPath, "- [R050] Critical rule. (critical)\n", "utf-8");
    const bundle = await compileGuidance({ rootPath, localPath: "/tmp/nonexistent-local.md" });
    expect(bundle.manifest.criticalRuleIds).toContain("R050");
  });
});

// ── Gate tests ─────────────────────────────────────────────────────────────────

describe("destructiveOpsGate", () => {
  it("detects 'rm -rf /tmp/test' → require-confirmation", () => {
    const ctx: GateContext = { command: "rm -rf /tmp/test" };
    const result = destructiveOpsGate(ctx, []);
    expect(result.decision).toBe("require-confirmation");
    expect(result.gateName).toBe("destructiveOpsGate");
  });

  it("'ls -la' → allow", () => {
    const ctx: GateContext = { command: "ls -la" };
    const result = destructiveOpsGate(ctx, []);
    expect(result.decision).toBe("allow");
  });

  it("'DROP TABLE users' → require-confirmation", () => {
    const ctx: GateContext = { command: "DROP TABLE users" };
    const result = destructiveOpsGate(ctx, []);
    expect(result.decision).toBe("require-confirmation");
    expect(result.reason).toContain("DROP TABLE");
  });

  it("'git reset --hard' → require-confirmation", () => {
    const ctx: GateContext = { command: "git reset --hard HEAD~3" };
    const result = destructiveOpsGate(ctx, []);
    expect(result.decision).toBe("require-confirmation");
  });

  it("'echo hello' → allow", () => {
    const ctx: GateContext = { command: "echo hello" };
    const result = destructiveOpsGate(ctx, []);
    expect(result.decision).toBe("allow");
  });
});

describe("secretsGate", () => {
  it("detects OpenAI-style API key 'sk-abc123...' → block", () => {
    const ctx: GateContext = { editContent: "const key = 'sk-abc123abc123abc123abc123'" };
    const result = secretsGate(ctx, []);
    expect(result.decision).toBe("block");
    expect(result.gateName).toBe("secretsGate");
  });

  it("detects 'BEGIN RSA PRIVATE KEY' → block", () => {
    const ctx: GateContext = { editContent: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB..." };
    const result = secretsGate(ctx, []);
    expect(result.decision).toBe("block");
  });

  it("'hello world' → allow", () => {
    const ctx: GateContext = { editContent: "hello world, nothing suspicious here" };
    const result = secretsGate(ctx, []);
    expect(result.decision).toBe("allow");
  });

  it("detects AWS key AKIA... → block", () => {
    const ctx: GateContext = { editContent: "aws_key=AKIAIOSFODNN7EXAMPLE" };
    const result = secretsGate(ctx, []);
    expect(result.decision).toBe("block");
  });

  it("no editContent → allow", () => {
    const ctx: GateContext = {};
    const result = secretsGate(ctx, []);
    expect(result.decision).toBe("allow");
  });
});

describe("toolAllowlistGate", () => {
  it("empty allowlist → always allow", () => {
    const ctx: GateContext = { toolName: "anything" };
    const result = toolAllowlistGate(ctx, [], []);
    expect(result.decision).toBe("allow");
  });

  it("tool in allowlist → allow", () => {
    const ctx: GateContext = { toolName: "web_search" };
    const result = toolAllowlistGate(ctx, ["web_search", "file_read"], []);
    expect(result.decision).toBe("allow");
  });

  it("tool not in allowlist → block", () => {
    const ctx: GateContext = { toolName: "shell_exec" };
    const result = toolAllowlistGate(ctx, ["web_search"], []);
    expect(result.decision).toBe("block");
    expect(result.gateName).toBe("toolAllowlistGate");
  });

  it("block result includes remediation listing permitted tools", () => {
    const ctx: GateContext = { toolName: "unknown_tool" };
    const result = toolAllowlistGate(ctx, ["web_search", "file_read"], []);
    expect(result.decision).toBe("block");
    expect(result.remediation).toContain("web_search");
  });
});

describe("diffSizeGate", () => {
  it("editContent with 400 lines → warn", () => {
    const bigContent = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const ctx: GateContext = { editContent: bigContent };
    const result = diffSizeGate(ctx, 300, []);
    expect(result.decision).toBe("warn");
    expect(result.gateName).toBe("diffSizeGate");
  });

  it("editContent with 50 lines → allow", () => {
    const smallContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const ctx: GateContext = { editContent: smallContent };
    const result = diffSizeGate(ctx, 300, []);
    expect(result.decision).toBe("allow");
  });

  it("no editContent → allow", () => {
    const ctx: GateContext = {};
    const result = diffSizeGate(ctx, 100, []);
    expect(result.decision).toBe("allow");
  });

  it("warn result includes line count info in reason", () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
    const ctx: GateContext = { editContent: content };
    const result = diffSizeGate(ctx, 100, []);
    expect(result.decision).toBe("warn");
    expect(result.reason).toContain("150");
  });
});

describe("aggregateGateResults", () => {
  it("block beats require-confirmation beats warn", () => {
    const results: GateResult[] = [
      { decision: "warn", gateName: "g1", reason: "warn", triggeredRules: [] },
      { decision: "require-confirmation", gateName: "g2", reason: "req", triggeredRules: [] },
      { decision: "block", gateName: "g3", reason: "block", triggeredRules: [] },
    ];
    const agg = aggregateGateResults(results);
    expect(agg.decision).toBe("block");
    expect(agg.gateName).toBe("aggregate");
  });

  it("require-confirmation beats warn and allow", () => {
    const results: GateResult[] = [
      { decision: "allow", gateName: "g1", reason: "allow", triggeredRules: [] },
      { decision: "warn", gateName: "g2", reason: "warn", triggeredRules: [] },
      { decision: "require-confirmation", gateName: "g3", reason: "req", triggeredRules: [] },
    ];
    const agg = aggregateGateResults(results);
    expect(agg.decision).toBe("require-confirmation");
  });

  it("all allow → allow", () => {
    const results: GateResult[] = [
      { decision: "allow", gateName: "g1", reason: "ok", triggeredRules: [] },
      { decision: "allow", gateName: "g2", reason: "ok", triggeredRules: [] },
    ];
    const agg = aggregateGateResults(results);
    expect(agg.decision).toBe("allow");
  });

  it("empty array → allow", () => {
    const agg = aggregateGateResults([]);
    expect(agg.decision).toBe("allow");
    expect(agg.gateName).toBe("aggregate");
  });

  it("aggregates reasons from all top-severity results", () => {
    const results: GateResult[] = [
      { decision: "block", gateName: "g1", reason: "reason A", triggeredRules: [] },
      { decision: "block", gateName: "g2", reason: "reason B", triggeredRules: [] },
    ];
    const agg = aggregateGateResults(results);
    expect(agg.reason).toContain("reason A");
    expect(agg.reason).toContain("reason B");
  });

  it("deduplicates triggered rules by id", () => {
    const sharedRule = makeRule({ id: "SHARED" });
    const results: GateResult[] = [
      { decision: "block", gateName: "g1", reason: "r1", triggeredRules: [sharedRule] },
      { decision: "block", gateName: "g2", reason: "r2", triggeredRules: [sharedRule] },
    ];
    const agg = aggregateGateResults(results);
    const sharedCount = agg.triggeredRules.filter((r) => r.id === "SHARED").length;
    expect(sharedCount).toBe(1);
  });
});
