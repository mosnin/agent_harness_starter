/**
 * Jev on live orchestration paths — specialist router, workflow
 * predicates, swarm assignment. GodsBoy / notra / jev-router patterns.
 */

import type { AgentConfig, RunInput } from "../types";
import type { StepCondition, WorkflowContext } from "../workflow/types";
import type { SwarmAgent, SwarmTask } from "../swarm/types";
import { createJevAsker } from "./client";
import { NOUL } from "./policy";
import { noul } from "./questions";
import { mapReduceChoice } from "./mapreduce";
import { routeIntent } from "./router";
import type { JevAsker, PolicyDecision } from "./types";
import { requireNoul } from "./validate";

export function createJevSpecialistRouter(opts: { asker?: JevAsker } = {}) {
  return async (
    input: string,
    specialists: AgentConfig[],
    _ctx?: RunInput["context"]
  ): Promise<AgentConfig | null> => {
    if (specialists.length === 0) return null;
    if (specialists.length === 1) return specialists[0] ?? null;

    const options = Object.fromEntries(
      specialists.map((s) => [s.name, s.name + (typeof s.instructions === "string" ? `: ${s.instructions.slice(0, 180)}` : "")])
    );
    const decision = specialists.length > 8
      ? await mapReduceChoice({
          node: "orchestrator",
          instructions: "Which specialist should handle `request`?",
          state: { request: input.slice(0, 6000) },
          options,
          asker: opts.asker,
          escape: "__llm__",
        })
      : await routeIntent({
          message: input,
          intents: options,
          asker: opts.asker,
        });

    if (decision.action !== "auto") return null;
    return specialists.find((s) => s.name === decision.value) ?? null;
  };
}

export function jevWhen(input: {
  question: string;
  threshold?: number;
  asker?: JevAsker;
}): StepCondition {
  const threshold = input.threshold ?? NOUL.needsSpecialist;
  return async (ctx: WorkflowContext) => {
    const asker = input.asker ?? createJevAsker();
    const asked = await asker.ask({
      state: {
        message: ctx.currentMessage.slice(0, 4000),
        original: ctx.originalMessage.slice(0, 2000),
      },
      questions: { match: noul(input.question) },
    });
    if (!asked.ok) return false;
    return requireNoul(asked.result.answers, "match") >= threshold;
  };
}

export function jevUntil(input: {
  question?: string;
  asker?: JevAsker;
  threshold?: number;
}): (ctx: WorkflowContext, iteration: number) => Promise<boolean> {
  const question = input.question ?? "Has the current draft satisfied the original request well enough to stop iterating?";
  const threshold = input.threshold ?? NOUL.finish;
  return async (ctx) => {
    const asker = input.asker ?? createJevAsker();
    const asked = await asker.ask({
      state: {
        original: ctx.originalMessage.slice(0, 2000),
        draft: ctx.currentMessage.slice(0, 4000),
      },
      questions: { done: noul(question) },
    });
    if (!asked.ok) return false;
    return requireNoul(asked.result.answers, "done") >= threshold;
  };
}

export async function pickSwarmAgent(input: {
  task: Pick<SwarmTask, "description" | "requiredCapabilities" | "priority">;
  agents: SwarmAgent[];
  asker?: JevAsker;
}): Promise<{ agent?: SwarmAgent; decision: PolicyDecision }> {
  const capable = input.agents.filter(
    (a) =>
      a.status !== "offline" &&
      a.status !== "error" &&
      input.task.requiredCapabilities.every((cap) => a.capabilities.includes(cap))
  );
  if (capable.length === 0) {
    return {
      decision: { action: "review", value: "", reason: "no-capable-agent", node: "swarm_assign" },
    };
  }
  if (capable.length === 1) {
    return {
      agent: capable[0],
      decision: { action: "auto", value: capable[0]!.id, reason: "only-capable", node: "swarm_assign" },
    };
  }

  const options = Object.fromEntries(
    capable.map((a) => [
      a.id,
      `${a.name} (load ${a.load.toFixed(2)}, caps: ${a.capabilities.join(", ")})`,
    ])
  );
  const decision = await mapReduceChoice({
    node: "swarm_assign",
    instructions: "Which agent should take `task` given load and capabilities?",
    state: {
      task: input.task.description.slice(0, 2000),
      required: input.task.requiredCapabilities,
      priority: input.task.priority,
    },
    options,
    asker: input.asker,
    escape: "__none__",
  });
  const agent = capable.find((a) => a.id === decision.value);
  return { agent, decision };
}
