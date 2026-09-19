/**
 * Jev on live orchestration paths — specialist router, workflow
 * predicates, swarm assignment. GodsBoy / notra / jev-router patterns.
 */

import type { AgentConfig, RunInput } from "../types";
import type { StepCondition, WorkflowContext } from "../workflow/types";
import type { SwarmAgent, SwarmTask } from "../swarm/types";
import { URGENCY_LEVELS } from "./catalog";
import { createJevAsker } from "./client";
import { hasLocalInjection, hasLocalInjectionIn, localInjectionBlock } from "./inject";
import { GATES, NOUL, decideChoice, decideUnavailable } from "./policy";
import { choice, noul, score } from "./questions";
import { mapReduceChoice } from "./mapreduce";
import { hasSevereSecret, localSecretBlock } from "./redact";
import { routeIntent } from "./router";
import type { JevAsker, PolicyDecision } from "./types";
import { requireChoice, requireNoul } from "./validate";

/** Zero-RTT refuse: do not hand a jailbreak or key dump to a worker. */
export function screenSwarmTask(
  task: Pick<SwarmTask, "description"> & { payload?: unknown }
): PolicyDecision | null {
  if (hasSevereSecret(task.description) || hasSevereSecret(task.payload)) {
    return localSecretBlock("swarm_assign");
  }
  if (hasLocalInjection(task.description) || hasLocalInjectionIn(task.payload)) {
    return localInjectionBlock("swarm_assign");
  }
  return null;
}

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
  task: Pick<SwarmTask, "description" | "requiredCapabilities" | "priority"> & {
    payload?: unknown;
  };
  agents: SwarmAgent[];
  asker?: JevAsker;
}): Promise<{ agent?: SwarmAgent; decision: PolicyDecision }> {
  const capable = input.agents.filter(
    (a) =>
      a.status !== "offline" &&
      a.status !== "error" &&
      input.task.requiredCapabilities.every((cap) => a.capabilities.includes(cap))
  );
  const blocked = screenSwarmTask(input.task);
  if (blocked) {
    return { decision: blocked };
  }
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

  if (capable.length <= 8) {
    const asker = input.asker ?? createJevAsker();
    const asked = await asker.ask({
      state: {
        task: input.task.description.slice(0, 2000),
        required: input.task.requiredCapabilities,
        priority: input.task.priority,
      },
      questions: {
        pick: choice("Which agent should take `task` given load and capabilities?", {
          ...options,
          __none__: "None of these agents should take this task.",
        }),
        needs_human: noul("Does `task` need a human rather than a worker?"),
        urgency: score("How urgent is `task`?", URGENCY_LEVELS),
      },
    });
    if (!asked.ok) {
      return { decision: decideUnavailable("swarm_assign", "__none__", "review") };
    }
    const needsHuman = requireNoul(asked.result.answers, "needs_human");
    if (needsHuman >= 0.7) {
      return {
        decision: {
          action: "review",
          value: "__none__",
          reason: "needs-human",
          node: "swarm_assign",
          answers: asked.result.answers,
        },
      };
    }
    const decision = {
      ...decideChoice("swarm_assign", requireChoice(asked.result.answers, "pick"), GATES.routing, "__none__"),
      answers: asked.result.answers,
    };
    const agent = capable.find((a) => a.id === decision.value);
    return { agent, decision };
  }

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
