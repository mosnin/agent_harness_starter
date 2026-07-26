import { ToolBox, createToolExecutor, type SwarmTool, type ToolRunner } from "../worker/toolbox";
import type { TaskExecutor, WorkerContext } from "../worker/executor";
import type { Claim, WorkerTask } from "../types";

/**
 * A skill is a curated bundle a worker can adopt: the capabilities it advertises,
 * the tools it unlocks, and a prompt fragment that specializes its behaviour.
 * This is the swarm analogue of Hermes' skills — package a coherent competence
 * (research, coding, data analysis) once and hand it to any worker.
 */
export interface SwarmSkill {
  name: string;
  description: string;
  /** Capabilities this skill grants (used for task routing + tool allowlisting). */
  capabilities: string[];
  /** Tools this skill makes available. */
  tools?: SwarmTool[];
  /** Prompt fragment injected into a worker using this skill. */
  promptFragment?: string;
}

export function defineSkill(skill: SwarmSkill): SwarmSkill {
  return skill;
}

export interface ResolvedSkills {
  skills: SwarmSkill[];
  capabilities: string[];
  toolbox: ToolBox;
  promptFragments: string[];
}

/**
 * Registry of skills. Resolving a set of skill names merges their capabilities,
 * tools, and prompt fragments into a single bundle a worker can run with —
 * deduping capabilities and tools by name.
 */
export class SkillRegistry {
  private skills = new Map<string, SwarmSkill>();

  constructor(skills: SwarmSkill[] = []) {
    for (const s of skills) this.register(s);
  }

  register(skill: SwarmSkill): void {
    this.skills.set(skill.name, skill);
  }
  get(name: string): SwarmSkill | undefined {
    return this.skills.get(name);
  }
  list(): SwarmSkill[] {
    return [...this.skills.values()];
  }

  /** Merge the named skills into one resolved bundle. Unknown names throw. */
  resolve(names: string[]): ResolvedSkills {
    const chosen: SwarmSkill[] = [];
    for (const n of names) {
      const s = this.skills.get(n);
      if (!s) throw new Error(`unknown skill: ${n}`);
      chosen.push(s);
    }
    const capabilities = dedupe(chosen.flatMap((s) => s.capabilities));
    const toolbox = new ToolBox();
    const seenTools = new Set<string>();
    for (const s of chosen) {
      for (const t of s.tools ?? []) {
        if (!seenTools.has(t.name)) {
          toolbox.register(t);
          seenTools.add(t.name);
        }
      }
    }
    const promptFragments = chosen.map((s) => s.promptFragment).filter((p): p is string => !!p);
    return { skills: chosen, capabilities, toolbox, promptFragments };
  }

  /** All capabilities across every registered skill (handy for pool config). */
  allCapabilities(): string[] {
    return dedupe(this.list().flatMap((s) => s.capabilities));
  }
}

/** A reasoner that also receives the merged skill prompt. */
export type SkilledReasoner = (
  task: WorkerTask,
  tools: ToolRunner,
  ctx: WorkerContext,
  skillPrompt: string
) => Promise<{ output: unknown; claims?: Claim[] }>;

/**
 * Build a worker executor from a resolved skill bundle: the skills' tools become
 * the worker's toolbox (allowlisted to the skills' capabilities), and their
 * prompt fragments are handed to the reasoner. Grounding is automatic via the
 * tool runner — a skilled worker is still held to the verification gate.
 */
export function createSkilledExecutor(resolved: ResolvedSkills, reason: SkilledReasoner): TaskExecutor {
  const skillPrompt = resolved.promptFragments.join("\n");
  return createToolExecutor({
    toolbox: resolved.toolbox,
    // The skill's curated toolbox *is* the boundary, so don't additionally
    // allowlist by task capability (capabilities and tool names differ).
    scopeToCapabilities: false,
    reason: (task, tools, ctx) => reason(task, tools, ctx, skillPrompt),
  });
}

// ── Built-in skill factories ─────────────────────────────────────────────────

/** A research skill backed by an injected web-search function. */
export function researchSkill(
  search: (q: string) => Promise<Array<{ title: string; url: string; snippet: string }>>
): SwarmSkill {
  return {
    name: "research",
    description: "Web research: search the open web and ground answers in sources.",
    capabilities: ["research", "web_search"],
    tools: [
      {
        name: "web_search",
        description: "Search the web.",
        async execute(args) {
          return (await search(String(args.query ?? args.q ?? ""))).slice(0, Number(args.limit ?? 5));
        },
      },
    ],
    promptFragment: "You are a researcher. Search before answering and cite what you found.",
  };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
