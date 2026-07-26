export { summarize, measure, BenchSuite } from "./harness";
export type { BenchStats, BenchResult } from "./harness";
export { Lazy, LazyModuleRegistry, footprintReport } from "./footprint";
export type { FootprintReport } from "./footprint";
export {
  benchA2ARoundTrip,
  benchA2AThroughput,
  benchHierarchyVsFlat,
  benchRoutingScaling,
  runAllBenchmarks,
} from "./live-bench";
export type { BenchmarkReport } from "./live-bench";
export { benchPooling, benchBatchedThroughput, runBatchBenchmarks } from "./a2a-batch-bench";
export { FlatOrchestrator } from "./flat-baseline";
export type { FlatExec, FlatRunStats } from "./flat-baseline";
export { runHeadToHead } from "./head-to-head";
export type { HeadToHeadRow, HeadToHeadReport } from "./head-to-head";
export {
  simulateMakespan,
  buildFlatTopology,
  buildBalancedTopology,
  compareMakespan,
} from "./latency-makespan";
export type { SimNode, LatencyParams, MakespanRow, MakespanReport } from "./latency-makespan";
export { benchMetricsOverhead, runMetricsBenchmarks } from "./metrics-overhead";
export type { MetricsOverheadResult, MetricsBenchReport } from "./metrics-overhead";
export { runSoak } from "./soak";
export type { SoakWindow, SoakResult } from "./soak";
export { probeLeaks } from "./leak-probe";
export type { LeakSample, LeakReport } from "./leak-probe";
export {
  linearFit,
  measureRouteScans,
  assertO1Routing,
  assertSubLinearGrowth,
  assertResultsMatch,
} from "./invariants";
export type { LinearFit } from "./invariants";
export { runChaosSuite, makeInstantTimer } from "./chaos-suite";
export type { ChaosScenarioResult, ChaosSuiteReport } from "./chaos-suite";
export { runVtph, compareVtph } from "./vtph";
export type { EvalTask, AgentRunResult, AgentRunner, VtphReport } from "./vtph";
// `hades showdown` — swarm vs self-trusting baseline, hash-chain audited.
export { generateShowdownSuite, verifyAuditChain, runShowdown } from "./showdown";
export type { ShowdownFamily, ShowdownMode, ShowdownOptions, AuditRecord, ShowdownResult } from "./showdown";
export { renderShowdownText, renderShowdownMarkdown, writeShowdownArtifacts } from "./showdown-report";
export type { ShowdownFsDeps } from "./showdown-report";
// `hades showdown live` — the keyed, budgeted, sha256-manifested exit lane.
export {
  LIVE_MANIFEST_VERSION,
  preflightLiveShowdown,
  runLiveShowdown,
  verifyLiveArtifacts,
} from "./showdown-live";
export type {
  LivePreflight,
  LiveRunManifest,
  LiveShowdownDeps,
  LiveShowdownFsDeps,
  LiveShowdownOptions,
} from "./showdown-live";
// Independent byte-level auditor for a published `runs/live-*` directory +
// the honest keyed-live readiness lane (`hades showdown verify --dir`/`ready`).
export { verifyLiveRunDir, renderManifestAudit, livePreflightSummary } from "./live-manifest-verify";
export type { AuditCheck, ManifestAudit, AuditFsDeps, ReadinessReport } from "./live-manifest-verify";
export { EVAL_TASKS, EVAL_CATEGORIES, tasksByCategory, decomposableTasks } from "./eval-suite";
