/**
 * Default Hades route catalog — Qwen via OpenRouter for generation,
 * Jev for every structured decision.
 *
 * Mirrors LangChain ModelRouterMiddleware:
 *   fast / balanced / powerful with human-readable criteria Jev reads.
 */

import type { ModelRoute, SkillRoute } from "./types";

export const HADES_QWEN_ROUTES: ModelRoute[] = [
  {
    id: "fast",
    model: process.env.HADES_FAST_MODEL ?? "qwen/qwen3-32b",
    criteria: "Direct lookups, extraction, localized edits, greetings, and short factual answers.",
    what: "Cheap, low-latency generation when the task is bounded and well specified.",
    notFor: "Architecture, novel debugging, multi-file refactors, or high-stakes decisions.",
  },
  {
    id: "balanced",
    model: process.env.HADES_BALANCED_MODEL ?? "qwen/qwen-2.5-72b-instruct",
    criteria: "Typical agent work: multi-step tools, moderate reasoning, support replies, code edits with tests.",
    what: "Default generation model for most Hades runs.",
    notFor: "Trivial one-liners (use fast) or irreversible system design (use powerful).",
  },
  {
    id: "powerful",
    model: process.env.HADES_POWERFUL_MODEL ?? "qwen/qwen3-235b-a22b",
    criteria: "Architecture, high-stakes decisions, novel debugging, long-horizon plans, ambiguous requirements.",
    what: "Highest-capability Qwen route. Use only when cheaper routes would fail.",
    notFor: "Lookups, formatting, or follow-up confirmations.",
  },
];

export const HADES_ROUTE_ORDER = HADES_QWEN_ROUTES.map((route) => route.id);

export const DEFAULT_HADES_SKILLS: SkillRoute[] = [
  { id: "research", description: "Web search, browsing, and synthesis of external sources." },
  { id: "code", description: "Read, edit, test, and explain source code." },
  { id: "support", description: "Customer support, billing, account, and policy questions." },
  { id: "browser", description: "Operate a live browser: click, type, extract, navigate." },
  { id: "ops", description: "Git, deploy, infra, and company-OS actions." },
  { id: "desktop", description: "Hades desktop capture, project edit, and local export on this machine." },
  { id: "__no_skill__", description: "The request can be answered without a specialist skill." },
  { id: "__review__", description: "Ambiguous or high-risk — a human or supervisor should review." },
];

export const COMPLEXITY_LEVELS = [
  "None — greeting or acknowledgement",
  "Very low — single fact or lookup",
  "Low — short explanation or localized change",
  "Moderate — multi-step but well specified",
  "High — cross-cutting reasoning or several tools",
  "Very high — novel, ambiguous, or high blast radius",
  "Severe — irreversible or safety-critical",
];

export const IMPACT_LEVELS = [
  "Reversible and local; no user-visible side effects",
  "Limited write or network; easy to undo",
  "Broad write, deploy, payment, or credential use",
  "Destructive, irreversible, or likely to leak secrets",
];

export const SLOP_LEVELS = [
  "Human, specific, and grounded",
  "Mostly useful with mild generic phrasing",
  "Generic filler, hedging, or ungrounded claims",
  "Obvious AI slop: vague, repetitive, or fabricated",
];

export const URGENCY_LEVELS = [
  "No time pressure",
  "Soon, but not blocking",
  "Blocking someone now",
  "Immediate outage or revenue loss",
];
