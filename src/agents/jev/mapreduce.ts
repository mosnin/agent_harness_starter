/**
 * Map-reduce + hierarchical beam search over large Choice catalogs.
 * GodsBoy skill router, pi-jev-router, jev-bfs, TypeSafe hierarchical classification.
 */

import { createJevAsker } from "./client";
import { GATES, decideChoice, decideUnavailable } from "./policy";
import { choice } from "./questions";
import type { JevAsker, PolicyDecision, SkillRoute } from "./types";
import { requireChoice } from "./validate";

const BATCH = 8;

export async function mapReduceChoice(input: {
  node: string;
  instructions: string;
  state: Record<string, unknown>;
  options: Record<string, string>;
  keepPerBatch?: number;
  asker?: JevAsker;
  signal?: AbortSignal;
  escape?: string;
}): Promise<PolicyDecision> {
  const escape = input.escape ?? "__review__";
  const entries = Object.entries(input.options);
  if (entries.length === 0) {
    throw new Error("mapReduceChoice: options must be non-empty");
  }
  const asker = input.asker ?? createJevAsker();
  const keep = input.keepPerBatch ?? 2;

  let pool = entries;
  while (pool.length > BATCH) {
    const batches: Array<Array<[string, string]>> = [];
    for (let i = 0; i < pool.length; i += BATCH) batches.push(pool.slice(i, i + BATCH));
    const winners = await Promise.all(
      batches.map(async (batch) => {
        const criteria = Object.fromEntries([...batch, [escape, "No option in this batch fits."]]);
        const asked = await asker.ask(
          {
            state: input.state as never,
            questions: { pick: choice(input.instructions, criteria) },
          },
          input.signal
        );
        if (!asked.ok) return batch.slice(0, keep);
        const pick = requireChoice(asked.result.answers, "pick");
        const ranked = Object.entries(pick.probabilities)
          .filter(([k]) => k !== escape)
          .sort((a, b) => b[1] - a[1])
          .slice(0, keep)
          .map(([k]) => batch.find(([id]) => id === k))
          .filter((x): x is [string, string] => Boolean(x));
        return ranked.length > 0 ? ranked : batch.slice(0, keep);
      })
    );
    pool = winners.flat();
  }

  const finalCriteria = Object.fromEntries([...pool, [escape, "None of these options fit."]]);
  const asked = await asker.ask(
    {
      state: input.state as never,
      questions: { pick: choice(input.instructions, finalCriteria) },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable(input.node, escape, "review");
  return { ...decideChoice(input.node, requireChoice(asked.result.answers, "pick"), GATES.routing, escape), answers: asked.result.answers };
}

export async function routeSkillMapReduce(input: {
  message: string;
  skills: SkillRoute[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const options = Object.fromEntries(input.skills.map((s) => [s.id, s.description]));
  return mapReduceChoice({
    node: "skill_router",
    instructions: "Which specialist skill should handle `request`?",
    state: { request: input.message.slice(0, 6000) },
    options,
    asker: input.asker,
    signal: input.signal,
    escape: "__review__",
  });
}

export async function beamClassify(input: {
  text: string;
  tree: Record<string, Record<string, string>>;
  asker?: JevAsker;
  signal?: AbortSignal;
  width?: number;
}): Promise<{ path: string[]; decision: PolicyDecision }> {
  const width = input.width ?? 2;
  const levels = Object.keys(input.tree);
  if (levels.length === 0) throw new Error("beamClassify: tree must have at least one level");
  const asker = input.asker ?? createJevAsker();
  const path: string[] = [];
  let last: PolicyDecision = { action: "fallback", value: "", reason: "empty", node: "beam" };

  for (const level of levels) {
    const options = input.tree[level];
    if (!options) continue;
    const asked = await asker.ask(
      {
        state: { document: input.text.slice(0, 6000), path, level },
        questions: {
          pick: choice(`Which ${level} does \`document\` belong to given path ${path.join(" > ") || "(root)"}?`, {
            ...options,
            other: "None of these.",
          }),
        },
      },
      input.signal
    );
    if (!asked.ok) {
      last = decideUnavailable("beam", "other", "review");
      break;
    }
    const pick = requireChoice(asked.result.answers, "pick");
    const top = Object.entries(pick.probabilities).sort((a, b) => b[1] - a[1]).slice(0, width);
    const winner = top[0]?.[0] ?? pick.choice;
    path.push(winner);
    last = { ...decideChoice("beam", { ...pick, choice: winner }, GATES.routing, "other"), answers: asked.result.answers };
    if (winner === "other") break;
  }
  return { path, decision: last };
}
