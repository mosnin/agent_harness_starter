# Hermes-Swarm — 40-Iteration Build Roadmap

**North star:** a lightweight, Hermes-inspired agent harness that runs swarms of
isolated worker containers under a manager agent, with structural guarantees that
make it hard for agents to hallucinate or go rogue. Keep build + tests green
every iteration; commit each iteration to `claude/hermes-swarm-framework-vbhrot`.

**Working agreement (every iteration):**
1. Read this file → pick the next `[ ]` iteration.
2. Write a 2–4 line plan for it (in the log at the bottom).
3. Implement in a focused chunk.
4. `tsc` clean + `vitest run` green (add tests for new behavior).
5. Commit with a clear message. Update the checkbox + log here.
6. Never break a previously-green iteration.

Baseline already shipped (pre-roadmap): swarm-runtime core — providers
(inline/process/docker), manager, planner, verification gate, anti-rogue
guardrails, HTTP control-plane bus, CLI, web dashboard, LLM executor, Docker
infra. 582 tests green.

---

## Phase A — Anti-hallucination hardening (trust is the headline feature)
- [x] 1. Redundant-worker consensus: dispatch critical tasks to N workers, require majority agreement (reuse `majorityVote`).
- [x] 2. Cross-claim contradiction detection across a goal's verified results.
- [x] 3. Evidence provenance store — every accepted claim keeps a traceable citation record.
- [x] 4. Revision loop hardening: structured feedback, attempt caps, escalation.
- [x] 5. Semantic grounding check via embeddings (reuse `src/agents/embeddings`).
- [x] 6. Adversarial verifier: an independent skeptic pass that tries to refute claims.

## Phase B — Orchestration depth
- [x] 7. Task DAG scheduler: priorities, backpressure, ready-set batching.
- [x] 8. Worker autoscaling to ready parallelism (min/max bounds).
- [x] 9. Dead-worker detection, heartbeat timeouts, replacement + task requeue.
- [x] 10. Hierarchical swarms: a manager can spawn sub-managers.
- [x] 11. Per-goal budget/cost + tool-call accounting with ceilings.
- [x] 12. Goal cancellation / abort mid-flight (propagate to workers).
- [x] 13. Persistent goal/task state (file/SQLite) for crash recovery.

## Phase C — Integrations & modes (Hermes parity)
- [x] 14. Expose swarm control as MCP tools (spawn/status/dispatch).
- [x] 15. Cron-scheduled swarms (recurring goals).
- [x] 16. REST API expansion + documented schema.
- [x] 17. Harness-backed executor: wire the existing `@/agents` harness + tool registry into workers.
- [x] 18. Worker tool access (web search / sandbox) with grounded traces.
- [x] 19. Provider abstraction: OpenAI / Anthropic / Nous / OpenRouter / local.
- [ ] 20. Stream live worker token output to the dashboard.
- [ ] 21. Gateway trigger stub: a message (Slack/Discord/Telegram-shaped) launches a swarm.
- [ ] 22. Skills for workers (curated capability bundles).

## Phase D — GUI / UX
- [ ] 23. Dashboard: task DAG visualization.
- [ ] 24. Dashboard: per-worker log drill-down.
- [ ] 25. Dashboard: verification detail + evidence viewer.
- [ ] 26. Dashboard: goal history + replay.
- [ ] 27. Dashboard: live controls (pause / kill / scale).
- [ ] 28. Dashboard: metrics & charts.
- [ ] 29. TUI (terminal UI) for the swarm.

## Phase E — Ops / hardening
- [ ] 30. Dashboard auth + bus token rotation.
- [ ] 31. Structured logging + tracing + metrics export.
- [ ] 32. Resource-limit enforcement + tests (docker + process).
- [ ] 33. Docker: healthchecks, slimmer images, multi-arch notes.
- [ ] 34. Config file support (swarm.config.yaml / env precedence).
- [ ] 35. Graceful shutdown & signal handling everywhere.
- [ ] 36. Chaos tests: kill workers / drop network / slow responses.

## Phase F — Docs / polish / release
- [ ] 37. Comprehensive docs + runnable examples.
- [ ] 38. End-to-end integration test suite.
- [ ] 39. Benchmarks / load test + tuning.
- [ ] 40. Final review, README polish, CHANGELOG, release prep.

---

## Iteration log
_(newest last; one entry per completed iteration)_

- **Iter 1 — consensus voting.** Added `ConsensusSpec` + `WorkerTask.consensus`. Manager dispatches N replicas of a consensus task, evaluates each independently (guardrail + gate), then requires ≥`ceil(replicas·quorum)` gate-passing replicas to agree on canonical output (via `majorityVote`) before verifying. Round timeout backstop; timers cleared on shutdown. Wired `defaultConsensus` through factory. 3 tests (agree→pass, disagree→fail, single-worker unchanged). 585 tests green.
- **Iter 2 — contradiction detection.** New `verification/contradiction.ts`: conservative `subject <copula> value` parser that flags conflicting/negated values for the same subject across a goal's verified claims. Manager runs it at completion, attaches `Goal.contradictions`, emits `goal:contradiction`, and (opt-in `failOnContradiction`) fails an internally-inconsistent goal. 5 tests. 590 green.
- **Iter 3 — evidence provenance store.** New `verification/provenance.ts` + exported trace helpers from the gate. Manager records a `ProvenanceRecord` on every accept (single + consensus): claims, which evidence was confirmed against the tool trace, verdict/score. Exposed `listProvenance`/`getProvenance`/`groundingRate` and surfaced in `/api/state`. 3 tests. 593 green.
- **Iter 4 — revision loop hardening.** `WorkerTask.revisions` history + `RevisionEntry`. Rejections record attempt/verdict/score/failedChecks and re-dispatch with structured `_revision.failedChecks` feedback (LLMExecutor now cites the exact failed checks). New `escalateAfter` config + `task:escalated` event (fires at threshold and at terminal failure) carrying full history. 2 tests. 595 green.
- **Iter 5 — semantic grounding judge.** New `SemanticGroundingJudge` (implements the gate's `Judge` hook) that embeds each claim's evidence and the tool trace and scores best cosine similarity — catching correctly-paraphrased grounding (fewer false rejects) and semantic fabrication (keyword-overlap but wrong meaning). Composs via the existing `gate.judge` option; degrades to no-op if embeddings unavailable. Reuses `@/agents/embeddings`. 4 tests.
- **Iter 6 — adversarial verifier (Phase A complete).** New `AdversarialVerifier` interface + `RuleBasedAdversary` (deterministic skeptic: absolutes, overconfidence-vs-evidence, non-matching evidence) and `LLMAdversary`. Runs after the gate in `evaluateResult`; a result must *survive* refutation to be accepted (applies to single + consensus paths). Refutation is recorded as a gate check + revision feedback. 4 tests.
- **Iter 7 — DAG scheduler.** Extracted pure `manager/scheduler.ts` (`isReady`, `orderByPriority`, `scheduleReady`). Manager now dispatches ready tasks in priority order (FIFO tie-break) under a configurable `maxInFlight` backpressure cap (default unbounded); consensus replicas count as one in-flight task. 5 tests (pure logic + completes under tight cap).
- **Iter 8 — worker autoscaling.** `autoscale:{min,max}` config. `computeDemand` (consensus tasks want `replicas` slots) + `desiredWorkers` clamp. Manager scales up before dispatch and retires idle workers (never interrupts a running task) after progress. Pool starts at min. 3 tests. Full suite green.
- **Iter 9 — dead-worker detection + requeue.** Health monitor loop: reaps stale-heartbeat workers (emits `worker:dead`, replaces them) and requeues tasks whose worker hung/died past `taskTimeoutMs` (bounded by `maxRequeues`, emits `task:requeued`). `handleResult` now ignores late/duplicate results for terminal tasks. Fixed `InlineProvider.stop` to not block shutdown on a wedged worker. 2 tests. Full suite green.
- **Iter 10 — hierarchical swarms.** `SubSwarmExecutor`: a worker holding a delegated task (opt-in via `input.subSwarm`) spins up a whole child sub-swarm (own manager/workers/gate) to solve it, then returns the child's synthesis grounded in its verified sub-results — which the parent gate re-verifies, so delegation never bypasses trust. Falls back to a base executor for non-delegated tasks. 2 tests. Full suite green.
- **Iter 11 — per-goal budgets.** `BudgetSpec` (maxWorkerRuns/toolCalls/costUsd/wallClockMs) + `WorkerResult.costUsd`. Manager accounts every worker run (runs, tool calls, cost) and aborts a goal via `abortGoal` + `goal:aborted` when a ceiling breaks (pure `budgetBreach`). `runGoal` takes a per-goal `budget`; `getUsage` exposes live accounting; dispatch is blocked into non-running goals. 3 tests. Full suite green.
- **Iter 12 — goal cancellation.** Public `cancelGoal(goalId, reason)` + `runGoal` `AbortSignal` support. Cancellation reuses `abortGoal`: dispatch stops (non-running guard), in-flight results are ignored on arrival, non-terminal tasks are failed, goal resolves as `aborted`. 2 tests. Full suite green.
- **Iter 13 — persistent state (Phase B complete).** `persistence/state-store.ts`: `StateStore` with `MemoryStateStore` and atomic-write `FileStateStore` (temp+rename, no deps). Manager snapshots goals/tasks/usage (debounced) on plan/progress/abort, flushes on shutdown, and `loadState()` hydrates a fresh manager for post-crash inspection. Exported from the root barrel + factory. 2 tests. Full suite green.
- **Iter 14 — swarm MCP tools (Phase C start).** Refactored `runGoal` into `startGoal` (returns goalId + done promise, non-blocking) + thin wrapper. New `createSwarmMcpTools(manager)`: `swarm_run_goal` / `swarm_goal_status` / `swarm_cancel_goal` / `swarm_list_workers` / `swarm_provenance`, same self-contained tool shape the repo uses — register with the MCP server to drive the swarm from Claude Desktop/Cursor. 2 tests (async run+poll+provenance, cancel). Full suite green.
- **Iter 15 — cron-scheduled swarms.** `scheduling/`: dependency-free 5-field `cronMatches` (wildcards, steps, lists, ranges, stepped ranges) + `SwarmScheduler` that fires recurring goals by interval or cron via a `GoalRunner`, with an injectable clock for deterministic `tick(now)` testing, enable/disable, skipImmediate, and a real `start(pollMs)` timer. 10 tests (incl. restored DAG scheduler test I'd clobbered). Full suite green.
- **Iter 16 — REST API expansion.** SwarmServer now serves `/api/schema` (self-describing), `/api/workers`, `/api/goals/:id/{tasks,usage,provenance,cancel}`, and `/api/schedules` CRUD (when a SwarmScheduler is attached). POST /api/goals uses startGoal and returns the goalId. 2 HTTP tests. Full suite green.
- **Iter 17 — harness-backed executor.** `HarnessExecutor` runs each task through the project's real agent harness (structural `RunnableHarness` — no @openai/agents hard-dep), mapping the harness's `toolCalls` into the swarm's grounded tool-trace + claims so the gate verifies the agent's answer against its actual tool outputs. Threads token cost into budget accounting (added `ExecutionOutput.costUsd`, wired through the runtime → WorkerResult). 3 tests. Full suite green.
- **Iter 18 — worker tool access.** `worker/toolbox.ts`: `ToolBox` registry + `ToolRunner` that records every call into the trace (grounded-by-construction) and enforces a per-task capability allowlist (anti-rogue at the point of use). `createToolExecutor` auto-synthesizes grounded claims from tool outputs. Example `webSearchTool`/`httpGetTool`/`defineTool` (injectable/mockable). 4 tests. Full suite green.
- **Iter 19 — provider abstraction.** `worker/providers.ts`: `createChat({provider,model,...})` returns a `ChatFn` for OpenAI/Nous/OpenRouter/Together/Groq/local (OpenAI-compatible) and Anthropic (native messages API), resolving base URLs + key envs from a `PROVIDERS` directory. Injectable fetch. 3 tests (directory, unknown-provider, Anthropic request/response shaping). Full suite green.
- **Iter 20 — live worker output streaming.** Manager now buffers a rolling activity log (bounded) as worker log lines arrive over the bus, still emitting the SSE `log` event. New `recentLogs`/`getWorkerLogs`; SwarmServer serves `GET /api/logs` and `GET /api/workers/:id/logs`, and includes recent logs in `/api/state` so late-joining dashboard clients see history. 2 tests. Full suite green.
