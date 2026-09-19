/**
 * Data labeling and curation — jev-curate, jev-triage.
 */

import { URGENCY_LEVELS } from "./catalog";
import { createJevAsker } from "./client";
import { GATES, decideChoice, decideUnavailable } from "./policy";
import { choice, noul, score } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireChoice, requireNoul, requireScore } from "./validate";

export interface TriageItem {
  id: string;
  title: string;
  body: string;
}

export interface TriageResult {
  id: string;
  category: string;
  urgency: number;
  needsHuman: number;
  action: PolicyDecision["action"];
  decision: PolicyDecision;
}

export async function triageItems(input: {
  items: TriageItem[];
  categories: Record<string, string>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<TriageResult[]> {
  const batch = input.items.slice(0, 12);
  const questions = Object.fromEntries(
    batch.flatMap((item, i) => [
      [`c${i}`, choice(`What category is items[${i}] (id=${item.id})?`, { ...input.categories, other: "None of the named categories." })],
      [`u${i}`, score(`How urgent is items[${i}]?`, URGENCY_LEVELS)],
      [`h${i}`, noul(`Does items[${i}] need a human rather than automation?`)],
    ])
  );
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: {
        items: batch.map((item) => ({
          id: item.id,
          title: item.title.slice(0, 200),
          body: item.body.slice(0, 800),
        })),
      } as JevState,
      questions,
    },
    input.signal
  );

  return batch.map((item, i) => {
    if (!asked.ok) {
      const decision = decideUnavailable("triage", "other", "review");
      return { id: item.id, category: "other", urgency: 1, needsHuman: 1, action: decision.action, decision };
    }
    const category = requireChoice(asked.result.answers, `c${i}`);
    const urgency = requireScore(asked.result.answers, `u${i}`);
    const needsHuman = requireNoul(asked.result.answers, `h${i}`);
    const decision = needsHuman >= 0.7
      ? { action: "review" as const, value: category.choice, reason: "needs-human", node: "triage", answers: asked.result.answers }
      : decideChoice("triage", category, GATES.routing, "other");
    return {
      id: item.id,
      category: category.choice,
      urgency: urgency.score,
      needsHuman,
      action: decision.action,
      decision,
    };
  });
}

export async function curateLabel(input: {
  text: string;
  labels: Record<string, string>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { document: input.text.slice(0, 8000) },
      questions: {
        label: choice("Which label best describes `document`?", {
          ...input.labels,
          skip: "Do not keep this document.",
        }),
        keep: noul("Is `document` high-quality enough to keep in the training / knowledge set?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("curate", "skip", "review");
  const keep = requireNoul(asked.result.answers, "keep");
  const label = requireChoice(asked.result.answers, "label");
  if (keep < 0.45 || label.choice === "skip") {
    return { action: "block", value: "skip", reason: "low-quality", node: "curate", answers: asked.result.answers };
  }
  return { ...decideChoice("curate", label, GATES.classification, "skip"), answers: asked.result.answers };
}
