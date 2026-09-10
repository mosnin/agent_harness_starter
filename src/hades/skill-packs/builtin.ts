import type { SkillPack } from "./pack";
import { SkillPackCatalog } from "./pack";

/** DevOps: CI/CD, deployment, and monitoring competences. */
export const devopsPack: SkillPack = {
  name: "devops",
  description: "CI/CD, deployment, and monitoring",
  version: "1.0.0",
  skills: [
    {
      name: "deploy",
      description: "Plan and execute a safe deployment",
      capabilities: ["deploy", "rollback"],
      promptFragment: "Prefer blue-green or canary rollouts; always have a rollback plan and verify health checks before shifting traffic.",
    },
    {
      name: "ci-pipeline",
      description: "Design and debug CI pipelines",
      capabilities: ["ci", "build"],
      promptFragment: "Keep pipelines fast and deterministic; cache dependencies, fail early, and surface the first failing step.",
    },
    {
      name: "observability",
      description: "Instrument and diagnose via metrics/logs/traces",
      capabilities: ["monitoring", "alerting"],
      promptFragment: "Diagnose from the golden signals (latency, traffic, errors, saturation) before guessing at causes.",
    },
  ],
};

/** Research: search, synthesis, and citation discipline. */
export const researchPack: SkillPack = {
  name: "research",
  description: "Search, synthesis, and citation",
  version: "1.0.0",
  skills: [
    {
      name: "literature-search",
      description: "Find and triage relevant sources",
      capabilities: ["search", "browse"],
      promptFragment: "Search broadly, then narrow; prefer primary sources and note the date of each.",
    },
    {
      name: "synthesis",
      description: "Synthesize findings across sources",
      capabilities: ["summarize", "compare"],
      promptFragment: "Reconcile disagreements between sources explicitly; never present one source's claim as consensus.",
    },
    {
      name: "citation",
      description: "Attribute every claim to a source",
      capabilities: ["cite"],
      promptFragment: "Attach a source to each non-obvious claim; if you can't cite it, flag it as unverified.",
    },
  ],
};

/** Finance: analysis, forecasting, and risk. */
export const financePack: SkillPack = {
  name: "finance",
  description: "Analysis, forecasting, and risk",
  version: "1.0.0",
  skills: [
    {
      name: "financial-analysis",
      description: "Analyze statements and ratios",
      capabilities: ["analyze", "valuation"],
      promptFragment: "Show the formula and inputs for every ratio; state the accounting basis and period.",
    },
    {
      name: "forecasting",
      description: "Build and sanity-check forecasts",
      capabilities: ["forecast", "modeling"],
      promptFragment: "State assumptions explicitly and run a downside scenario; never present a point estimate without a range.",
    },
    {
      name: "risk",
      description: "Identify and quantify risk exposures",
      capabilities: ["risk"],
      promptFragment: "Quantify exposure and likelihood separately; call out tail risks the base case hides.",
    },
  ],
};

export const BUILTIN_PACKS: SkillPack[] = [devopsPack, researchPack, financePack];

/** The built-in skill-pack catalog (devops, research, finance). */
export function builtinSkillPackCatalog(): SkillPackCatalog {
  return new SkillPackCatalog(BUILTIN_PACKS);
}
