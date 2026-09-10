import type { Claim, ToolCallRecord, WorkerTask } from "../types";
import type { ExecutionOutput, TaskExecutor, WorkerContext } from "./executor";

/** A tool a worker can invoke. Its output becomes traceable evidence. */
export interface SwarmTool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Registry of tools available to workers. */
export class ToolBox {
  private tools = new Map<string, SwarmTool>();
  constructor(tools: SwarmTool[] = []) {
    for (const t of tools) this.register(t);
  }
  register(tool: SwarmTool): void {
    this.tools.set(tool.name, tool);
  }
  get(name: string): SwarmTool | undefined {
    return this.tools.get(name);
  }
  list(): SwarmTool[] {
    return [...this.tools.values()];
  }
}

/**
 * Per-task tool caller. Every invocation is recorded into `records`, so the
 * worker's tool trace is built automatically and truthfully — a worker cannot
 * claim it "searched the web" without a matching record. Optionally enforces a
 * capability allowlist, blocking (and recording) any tool outside the task's
 * granted capabilities — anti-rogue enforcement at the point of use, before a
 * disallowed action can even run.
 */
export class ToolRunner {
  readonly records: ToolCallRecord[] = [];
  constructor(
    private readonly box: ToolBox,
    private readonly allow?: Set<string>
  ) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.allow && !this.allow.has(name)) {
      this.records.push({ tool: name, args, ok: false, output: "blocked: not in allowlist", at: Date.now() });
      throw new ToolAccessError(`tool "${name}" is not in this task's allowlist`);
    }
    const tool = this.box.get(name);
    if (!tool) {
      this.records.push({ tool: name, args, ok: false, output: "unknown tool", at: Date.now() });
      throw new ToolAccessError(`unknown tool "${name}"`);
    }
    try {
      const output = await tool.execute(args);
      this.records.push({ tool: name, args, ok: true, output: stringify(output), at: Date.now() });
      return output;
    } catch (e) {
      this.records.push({ tool: name, args, ok: false, output: `error: ${e instanceof Error ? e.message : e}`, at: Date.now() });
      throw e;
    }
  }
}

export class ToolAccessError extends Error {}

/** A reasoner decides which tools to call and what to conclude. */
export type Reasoner = (
  task: WorkerTask,
  tools: ToolRunner,
  ctx: WorkerContext
) => Promise<{ output: unknown; claims?: Claim[] }>;

export interface ToolExecutorOptions {
  toolbox: ToolBox;
  reason: Reasoner;
  /** Restrict tool use to the task's requiredCapabilities. Default true. */
  scopeToCapabilities?: boolean;
}

/**
 * Build a {@link TaskExecutor} whose grounding is automatic: the reasoner calls
 * tools through a {@link ToolRunner}, the runner records every call, and those
 * records become the tool trace. If the reasoner doesn't supply claims, grounded
 * ones are synthesized from the successful tool outputs — so a worker built this
 * way is grounded-by-construction.
 */
export function createToolExecutor(opts: ToolExecutorOptions): TaskExecutor {
  const scope = opts.scopeToCapabilities ?? true;
  return {
    async execute(task: WorkerTask, ctx: WorkerContext): Promise<ExecutionOutput> {
      const allow = scope && task.requiredCapabilities.length > 0 ? new Set(task.requiredCapabilities) : undefined;
      const runner = new ToolRunner(opts.toolbox, allow);
      try {
        const r = await opts.reason(task, runner, ctx);
        const claims = r.claims ?? autoClaims(r.output, runner.records);
        return { output: r.output, claims, toolTrace: runner.records };
      } catch (e) {
        return {
          output: null,
          claims: [],
          toolTrace: runner.records.length
            ? runner.records
            : [{ tool: "reasoner", args: {}, ok: false, output: String(e), at: Date.now() }],
        };
      }
    },
  };
}

/** Synthesize grounded claims from the successful tool calls a worker made. */
function autoClaims(output: unknown, records: ToolCallRecord[]): Claim[] {
  const ok = records.filter((r) => r.ok);
  const claims: Claim[] = ok.map((r) => ({
    statement: `Relied on tool "${r.tool}" output.`,
    evidence: [r.output.slice(0, 300)],
    confidence: 0.8,
  }));
  const outStr = stringify(output);
  if (outStr.trim()) {
    claims.push({
      statement: outStr.slice(0, 200),
      evidence: ok.length ? ok.map((r) => r.output.slice(0, 120)) : [outStr.slice(0, 120)],
      confidence: ok.length ? 0.85 : 0.4,
    });
  }
  return claims;
}

// ── Example tools (injectable / mockable) ────────────────────────────────────

/** Web search tool backed by an injected search function (Tavily, SerpAPI, …). */
export function webSearchTool(
  search: (query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>
): SwarmTool {
  return {
    name: "web_search",
    description: "Search the web and return titles, URLs, and snippets.",
    async execute(args) {
      const results = await search(String(args.query ?? args.q ?? ""));
      return results.slice(0, Number(args.limit ?? 5));
    },
  };
}

/** HTTP GET tool backed by an injected fetcher (defaults to global fetch). */
export function httpGetTool(fetcher: typeof fetch = fetch): SwarmTool {
  return {
    name: "http_get",
    description: "Fetch a URL and return its text body (truncated).",
    async execute(args) {
      const res = await fetcher(String(args.url));
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 4000) };
    },
  };
}

/** Define a custom tool inline. */
export function defineTool(
  name: string,
  description: string,
  execute: (args: Record<string, unknown>) => Promise<unknown>
): SwarmTool {
  return { name, description, execute };
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
