# Skills Playbook — Integration Guide

A practical toolkit for defining agent capabilities as typed, composable, measurable skills.

---

## What is a Skill?

A **Skill** is a named, self-contained capability. It bundles:
- The **tools** an agent needs to perform the capability
- The **inputs** it expects and **outputs** it produces
- Its **internal logic** (how it reasons through a task)
- Its **boundaries** (what it cannot do, when to defer)
- Its **prerequisites** (what must be ready first)
- Its **combinations** (how it composes with other skills)
- Its **evaluation** (how you measure success)

Skills are injected into the agent's system prompt so the model understands exactly how to use them.

---

## 1. Defining a Skill

### Simple (tool bundle only)

```typescript
import { defineSkill } from "@/agents/skills";

defineSkill({
  name: "web",
  description: "Search the web and scrape pages for current information.",
  tools: ["web_search", "browser_scrape"],
});
```

### Extended (full definition)

```typescript
import { defineSkillExtended } from "@/agents/skills";

defineSkillExtended("research")
  .description("Search the web and synthesize cited answers.")
  .tools(["web_search", "browser_scrape"])
  .inputs([
    { name: "query",    description: "The research question or topic", required: true,  examples: ["What are LLM hosting costs in 2025?"] },
    { name: "depth",    description: "How many sources to consult",    required: false, examples: ["3", "10"] },
    { name: "language", description: "Response language",              required: false, examples: ["English", "Japanese"] },
  ])
  .outputs([
    { name: "answer",   description: "Synthesized answer with citations", type: "string" },
    { name: "sources",  description: "List of source URLs used",          type: "array of URLs" },
  ])
  .logic(`
    1. Use web_search to find the top K results for the query.
    2. For pages that require JavaScript rendering, use browser_scrape.
    3. Extract key facts from each source.
    4. Synthesize a coherent answer; include [Source N] citations inline.
    5. List all source URLs at the end.
  `)
  .boundaries({
    cannotDo: [
      "Access paywalled content without credentials",
      "Execute code or modify files",
      "Retrieve real-time financial data",
    ],
    deferWhen: [
      "The task requires code execution → use the 'code' skill",
      "The task requires database access → use the 'data' skill",
    ],
    confidenceThreshold: 0.7,
  })
  .prerequisites([
    { type: "tool",    name: "web_search",    reason: "Primary search capability", required: true },
    { type: "context", name: "userId",        reason: "Needed for memory retrieval", required: false },
  ])
  .combinations([
    { with: ["code"],     mode: "sequential", description: "Research → implement: find documentation, then write working code" },
    { with: ["data"],     mode: "sequential", description: "Research + verify: web facts cross-checked against internal DB" },
    { with: ["analysis"], mode: "parallel",   description: "Research and analyze simultaneously for faster results" },
  ])
  .tags(["web", "read-only", "async"])
  .cost("moderate")
  .evaluation({
    metrics: [
      { name: "citationCount",  type: "count",    description: "Number of sources cited", target: 3 },
      { name: "answerLength",   type: "count",    description: "Word count of the answer" },
      { name: "latencyMs",      type: "duration", description: "Time to complete",         target: 10_000 },
      { name: "hasAnswer",      type: "boolean",  description: "Output contains an answer" },
    ],
    evaluate: async (output) => {
      const hasCitations = /\[Source \d+\]/.test(output);
      const hasAnswer = output.length > 100;
      return hasCitations && hasAnswer ? 0.9 : 0.4;
    },
    minScore: 0.7,
  })
  .register();
```

---

## 2. Skill I/O Contracts

Inputs and outputs are injected into the system prompt. The model knows exactly what to expect and produce.

```typescript
// Inputs tell the model what it will receive:
.inputs([
  { name: "codeSnippet", description: "The code to analyze",  required: true },
  { name: "language",    description: "Programming language", required: false, examples: ["Python", "TypeScript"] },
])

// Outputs tell the model what to produce:
.outputs([
  { name: "issues",      description: "List of code issues found",       type: "array of strings" },
  { name: "suggestion",  description: "Improved version of the snippet", type: "string" },
  { name: "severity",    description: "Overall severity score",          type: "number 0-10" },
])
```

**What the agent sees in its prompt:**
```
## Skill: code-review
Analyze code for bugs, style, and security issues.

Inputs:
  - codeSnippet: The code to analyze
  - language (optional): Programming language (e.g. Python, TypeScript)

Outputs:
  - issues (array of strings): List of code issues found
  - suggestion (string): Improved version of the snippet
  - severity (number 0-10): Overall severity score
```

---

## 3. Skill Logic (internal reasoning process)

Use `.logic()` to describe _how_ the agent should process inputs — not just what tools to use.

```typescript
defineSkillExtended("code-execution")
  .logic(`
    1. Understand the task fully before writing any code.
    2. Write the code. Explain what it does in one sentence.
    3. Run it using sandbox_run_code. Check output and errors.
    4. If it fails: read the error, fix the code, re-run. Repeat up to 3 times.
    5. If all retries fail: explain why and suggest an alternative approach.
    6. Return the final working code and its actual output.
  `)
```

---

## 4. Skill Boundaries

Boundaries prevent skill scope creep.

```typescript
defineSkillExtended("data-query")
  .boundaries({
    // Hard capability limits
    cannotDo: [
      "Write or delete data (use the 'data-write' skill for mutations)",
      "Access tables not listed in the schema context",
      "Run queries that take longer than 30 seconds",
    ],

    // When to use a different skill
    deferWhen: [
      "The question requires joining > 5 tables → split into sub-queries",
      "The question requires real-time streaming data → use the 'streaming' skill",
      "The user asks for a data visualization → use the 'charting' skill",
    ],

    maxInputSize: 4000,      // characters
    confidenceThreshold: 0.75,
  })
```

---

## 5. Skill Prerequisites

Define what must be available before a skill can run.

```typescript
defineSkillExtended("personalized-reply")
  .prerequisites([
    {
      type: "context",
      name: "userId",
      reason: "Required to retrieve user preferences from memory",
      required: true,   // hard blocker
    },
    {
      type: "skill",
      name: "research",
      reason: "Background research is often needed before drafting a reply",
      required: false,  // warning only
    },
    {
      type: "tool",
      name: "get_user_profile",
      reason: "Needed to personalize tone and content",
      required: true,
    },
  ])
```

**Validate prerequisites before running:**

```typescript
import { checkPrerequisites } from "@/agents/skills";

const check = checkPrerequisites(
  "personalized-reply",
  ["userId", "threadId"],       // available context keys
  ["web_search", "get_user_profile"],  // available tools
  ["research"]                   // active skills
);

if (!check.satisfied) {
  console.error("Missing prerequisites:", check.missing);
  // → [{ name: "userId", type: "context", reason: "Required for memory retrieval" }]
}
if (check.warnings.length) {
  console.warn("Optional prerequisites not met:", check.warnings);
}
```

---

## 6. Skill Combinations

Define how skills compose for complex tasks.

```typescript
defineSkillExtended("research")
  .combinations([
    {
      with: ["code"],
      mode: "sequential",
      description: "Research → implement: find documentation, then write and run code",
      order: ["research", "code"],  // explicit ordering
    },
    {
      with: ["summarize", "translate"],
      mode: "sequential",
      description: "Full localization pipeline: research → summarize → translate",
    },
    {
      with: ["fact-check"],
      mode: "parallel",
      description: "Research and verify simultaneously",
    },
  ])
```

**Resolve a combination:**

```typescript
import { resolveSkillCombination } from "@/agents/skills";

const combo = resolveSkillCombination("research", ["code"]);
// → { skills: ["research", "code"], mode: "sequential", description: "..." }

// Use with the workflow builder:
import { createWorkflow, agentStep } from "@/agents/workflow";

if (combo) {
  const workflow = createWorkflow("research-then-implement");
  for (const skillName of combo.skills) {
    workflow.agent(skillName, getAgentForSkill(skillName));
  }
  await workflow.build().run(userMessage);
}
```

---

## 7. Skill Adaptability

Skills can track their own performance and adapt over time.

```typescript
defineSkillExtended("web-search")
  .adaptability({
    learningEnabled: true,
    adaptationStrategy: "tool-selection",  // switch tools on low scores
    minRunsBeforeAdapting: 20,
    adaptationThreshold: 0.1,             // adapt if score drops by 10%
  })
```

**Recording and reading skill runs:**

```typescript
import { recordSkillRun, getSkillAverageScore } from "@/agents/skills";

// After a skill executes:
recordSkillRun({
  skillName: "research",
  runId: "run-abc",
  score: 0.85,
  metrics: { citationCount: 4, latencyMs: 3200, hasAnswer: true },
  input: { query: "LLM cost trends" },
  output: "The average cost...",
  durationMs: 3200,
  timestamp: Date.now(),
  flagged: false,
});

// Check recent performance:
const avgScore = getSkillAverageScore("research", 50); // last 50 runs
if (avgScore !== null && avgScore < 0.7) {
  console.warn("Research skill performance degraded:", avgScore);
  // → trigger adaptation: switch retrieval k, adjust prompt, etc.
}
```

---

## 8. Skill Evaluation

Define criteria for measuring whether a skill executed well.

```typescript
defineSkillExtended("summarize")
  .evaluation({
    metrics: [
      { name: "compressionRatio", type: "score",    description: "Output / input length ratio", target: 0.2 },
      { name: "hasKeyPoints",     type: "boolean",  description: "Contains at least 3 key points" },
      { name: "latencyMs",        type: "duration", description: "Execution time",                target: 5_000 },
    ],
    evaluate: async (output, input) => {
      const ratio = output.length / (input.text as string).length;
      const hasKeyPoints = (output.match(/^\s*[-•*]/gm) ?? []).length >= 3;
      return ratio <= 0.25 && hasKeyPoints ? 1.0 : ratio <= 0.4 ? 0.7 : 0.4;
    },
    minScore: 0.7,
  })
```

**Automated evaluation hook (add to a plugin or workflow step):**

```typescript
import { getExtendedSkill, recordSkillRun } from "@/agents/skills";
import { transform } from "@/agents/workflow/steps";

const evaluateOutput = transform("evaluate", async (ctx) => {
  const skillName = "summarize";
  const skill = getExtendedSkill(skillName);
  if (!skill?.evaluation?.evaluate) return ctx.currentMessage;

  const score = await skill.evaluation.evaluate(
    ctx.currentMessage,
    { text: ctx.originalMessage }
  );

  recordSkillRun({
    skillName,
    runId: ctx.runId as string ?? "unknown",
    score,
    metrics: { score },
    input: { text: ctx.originalMessage },
    output: ctx.currentMessage,
    durationMs: Date.now() - (ctx.startedAt as number ?? Date.now()),
    timestamp: Date.now(),
    flagged: score < (skill.evaluation.minScore ?? 0.7),
  });

  return ctx.currentMessage;
});
```

---

## 9. Injecting Skill Guidance into Agent Prompts

```typescript
import { buildActiveSkillsPrompt } from "@/agents/skills";

// In a plugin or custom instructions:
const skillBlock = buildActiveSkillsPrompt(["research", "code"]);
// Returns a formatted prompt addendum with I/O, logic, boundaries for both skills.

const fullInstructions = `${baseInstructions}\n\n${skillBlock}`;
```

Or use the `withStructuredReasoning` plugin which picks up the skill context automatically.

---

## Quick Reference

| Need | Solution |
|------|---------|
| Simple tool bundle | `defineSkill({ name, description, tools })` |
| Full typed skill | `defineSkillExtended(name).inputs().outputs().logic().register()` |
| Check prerequisites | `checkPrerequisites(skillName, ctxKeys, tools, skills)` |
| Compose skills | `resolveSkillCombination(primary, [partner])` |
| Prompt guidance | `buildActiveSkillsPrompt(["skill1", "skill2"])` |
| Track performance | `recordSkillRun(record)` + `getSkillAverageScore(name)` |
| Per-agent access | Combine with `createToolPermissions()` |
| Skill boundaries in prompt | Injected automatically by `buildActiveSkillsPrompt` |
