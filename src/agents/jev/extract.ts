/**
 * Find / extract / compare / SDE cascade / function-calling.
 * jev-mcp, TypeSafe cookbooks (semantic_find, function_calling, sde_cascade).
 */

import { createJevAsker } from "./client";
import { GATES, NOUL, decideChoice, decideUnavailable } from "./policy";
import { choice, noul } from "./questions";
import type { JevAsker, JevState, PolicyDecision } from "./types";
import { requireChoice, requireNoul } from "./validate";

export async function semanticFind(input: {
  query: string;
  candidates: Array<{ id: string; text: string }>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  if (input.candidates.length === 0) {
    return { action: "review", value: "none", reason: "empty-candidates", node: "jev_find" };
  }
  const criteria = Object.fromEntries([
    ...input.candidates.slice(0, 40).map((c) => [c.id, c.text.slice(0, 200)]),
    ["none", "No candidate answers the query."],
  ]);
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { query: input.query.slice(0, 2000), candidates: input.candidates.slice(0, 40) } as JevState,
      questions: {
        best: choice("Which candidate best answers `query`?", criteria),
        exists: noul("Does any candidate contain an answer to `query`?"),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("jev_find", "none", "review");
  const exists = requireNoul(asked.result.answers, "exists");
  const best = requireChoice(asked.result.answers, "best");
  if (exists < NOUL.absent) {
    return { action: "review", value: "none", reason: "absent", node: "jev_find", answers: asked.result.answers };
  }
  if (exists >= NOUL.exists) {
    return { ...decideChoice("jev_find", best, GATES.classification, "none"), answers: asked.result.answers };
  }
  return { action: "review", value: best.choice, reason: "uncertain-exists", node: "jev_find", answers: asked.result.answers };
}

export async function extractValue(input: {
  field: string;
  document: string;
  candidates: string[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  if (input.candidates.length < 2) {
    throw new Error("extractValue: need at least two candidates (include a none option)");
  }
  const asker = input.asker ?? createJevAsker();
  const criteria = Object.fromEntries(input.candidates.map((c) => [c, c === "none" ? "The document does not contain this field." : c]));
  const asked = await asker.ask(
    {
      state: { field: input.field, document: input.document.slice(0, 6000), candidates: input.candidates },
      questions: { value: choice(`Which candidate is the verbatim ${input.field} in \`document\`?`, criteria) },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("jev_extract", "none", "review");
  return { ...decideChoice("jev_extract", requireChoice(asked.result.answers, "value"), GATES.classification, "none"), answers: asked.result.answers };
}

export async function compareTexts(input: {
  left: string;
  right: string;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<PolicyDecision> {
  const asker = input.asker ?? createJevAsker();
  const asked = await asker.ask(
    {
      state: { left: input.left.slice(0, 4000), right: input.right.slice(0, 4000) },
      questions: {
        relation: choice("How do `left` and `right` relate?", {
          same_fact: "They assert the same fact.",
          contradicts: "They contradict each other.",
          different_facts: "They are about different things.",
        }),
      },
    },
    input.signal
  );
  if (!asked.ok) return decideUnavailable("jev_compare", "different_facts", "review");
  const rel = requireChoice(asked.result.answers, "relation");
  if (rel.choice === "contradicts") {
    return { action: "block", value: "contradicts", reason: "contradiction", node: "jev_compare", answers: asked.result.answers };
  }
  return { ...decideChoice("jev_compare", rel, GATES.classification, "different_facts"), answers: asked.result.answers };
}

export interface BoundFunction {
  name: string;
  description: string;
  args?: Record<string, Record<string, string>>;
}

export async function bindFunctionCall(input: {
  request: string;
  functions: BoundFunction[];
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<{ fn: string; args: Record<string, string>; decision: PolicyDecision }> {
  if (input.functions.length < 1) throw new Error("bindFunctionCall: functions required");
  const asker = input.asker ?? createJevAsker();
  const fnCriteria = Object.fromEntries([
    ...input.functions.map((f) => [f.name, f.description]),
    ["none", "No function applies."],
  ]);
  const asked = await asker.ask(
    {
      state: { request: input.request.slice(0, 4000) },
      questions: { fn: choice("Which function should be called for `request`?", fnCriteria) },
    },
    input.signal
  );
  if (!asked.ok) {
    return { fn: "none", args: {}, decision: decideUnavailable("function_call", "none", "review") };
  }
  const fnDecision = decideChoice("function_call", requireChoice(asked.result.answers, "fn"), GATES.routing, "none");
  const selected = input.functions.find((f) => f.name === fnDecision.value);
  const args: Record<string, string> = {};
  if (selected?.args && fnDecision.action === "auto") {
    const argQuestions = Object.fromEntries(
      Object.entries(selected.args).map(([k, opts]) => [k, choice(`Value of ${k} for ${selected.name}?`, { ...opts, unknown: "Not specified." })])
    );
    const argAsked = await asker.ask({ state: { request: input.request.slice(0, 4000), fn: selected.name }, questions: argQuestions }, input.signal);
    if (argAsked.ok) {
      for (const key of Object.keys(selected.args)) {
        const ans = argAsked.result.answers[key];
        if (ans?.type === "choice") args[key] = ans.choice;
      }
    }
  }
  return { fn: String(fnDecision.value), args, decision: fnDecision };
}

export async function sdeCascade(input: {
  document: string;
  fields: Record<string, string>;
  asker?: JevAsker;
  signal?: AbortSignal;
}): Promise<{ values: Record<string, string>; needsReasoning: boolean }> {
  const asker = input.asker ?? createJevAsker();
  const questions = Object.fromEntries(
    Object.entries(input.fields).map(([k, desc]) => [k, noul(`Does \`document\` clearly contain ${desc}?`)])
  );
  const asked = await asker.ask(
    { state: { document: input.document.slice(0, 8000) }, questions },
    input.signal
  );
  const values: Record<string, string> = {};
  let needsReasoning = !asked.ok;
  if (asked.ok) {
    for (const key of Object.keys(input.fields)) {
      const ans = asked.result.answers[key];
      const present = ans?.type === "noul" ? ans.noul : 0;
      values[key] = present >= 0.7 ? "present" : present <= 0.3 ? "absent" : "uncertain";
      if (values[key] === "uncertain") needsReasoning = true;
    }
  }
  return { values, needsReasoning };
}
