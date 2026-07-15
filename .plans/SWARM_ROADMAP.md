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
- [x] 20. Stream live worker token output to the dashboard.
- [x] 21. Gateway trigger stub: a message (Slack/Discord/Telegram-shaped) launches a swarm.
- [x] 22. Skills for workers (curated capability bundles).

## Phase D — GUI / UX
- [x] 23. Dashboard: task DAG visualization.
- [x] 24. Dashboard: per-worker log drill-down.
- [x] 25. Dashboard: verification detail + evidence viewer.
- [x] 26. Dashboard: goal history + replay.
- [x] 27. Dashboard: live controls (pause / kill / scale).
- [x] 28. Dashboard: metrics & charts.
- [x] 29. TUI (terminal UI) for the swarm.

## Phase E — Ops / hardening
- [x] 30. Dashboard auth + bus token rotation.
- [x] 31. Structured logging + tracing + metrics export.
- [x] 32. Resource-limit enforcement + tests (docker + process).
- [x] 33. Docker: healthchecks, slimmer images, multi-arch notes.
- [x] 34. Config file support (swarm.config.yaml / env precedence).
- [x] 35. Graceful shutdown & signal handling everywhere.
- [x] 36. Chaos tests: kill workers / drop network / slow responses.

## Phase F — Docs / polish / release
- [x] 37. Comprehensive docs + runnable examples.
- [x] 38. End-to-end integration test suite.
- [x] 39. Benchmarks / load test + tuning.
- [x] 40. Final review, README polish, CHANGELOG, release prep.

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
- **Iter 21 — gateway trigger.** `gateway/`: platform-agnostic `InboundMessage` + Slack/Telegram/Discord parsers, and `SwarmGateway.handle()` that launches a goal from a chat message and replies with the verified synthesis (or contradiction warning). Access allowlist, optional trigger prefix, sync/async modes. 5 tests. Full suite green.
- **Iter 22 — worker skills (Phase C complete).** `skills/`: `SwarmSkill` = capabilities + tools + prompt fragment; `SkillRegistry.resolve(names)` merges/dedupes into a bundle (capabilities, ToolBox, prompts). `createSkilledExecutor` turns a bundle into a grounded tool-executor (curated toolbox is the boundary). Built-in `researchSkill`. 4 tests. Phase C done. Full suite green.
- **Iter 23 — task-DAG visualization.** Pure `computeDagLayout(tasks)` (topological levels, edges, cycle-safe) + `GET /api/goals/:id/dag`. Dashboard renders tasks grouped by level with status-colored nodes + consensus counts. 3 unit tests + HTTP dag-endpoint assertion. Full suite green.
- **Iter 24 — per-worker log drill-down.** Dashboard agent cards are now clickable → fetch `GET /api/workers/:id/logs` and render that worker's timestamped log stream. Added HTTP test for the per-worker logs endpoint. Full suite green.
- **Iter 25 — verification detail + evidence viewer.** Dashboard shows overall grounding-rate badge and a per-record provenance panel: each accepted claim with its confirmed (traced) evidence and grounded ✓/✗ marks. New `dashboard.test.ts` asserts the served HTML is well-formed and includes the panels. Full suite green.
- **Iter 26 — goal history + replay.** Manager `listGoals()` (newest-first) + `replayGoal(id)`; `GET /api/goals` list + `POST /api/goals/:id/replay`. Dashboard Goal History panel with per-goal replay (finished) / cancel (running) buttons. 4 tests (manager + REST). Full suite green.
- **Iter 27 — live controls.** Public `killWorker` (kills + replaces, returns bool) and `scalePool(n)`/`workerCount()`. Endpoints `POST /api/workers/:id/kill` and `POST /api/pool/scale`. Dashboard: per-agent kill button + pool ＋/− scale controls. 3 tests (manager + REST). Full suite green.
- **Iter 28 — metrics & charts.** `manager.metrics()` aggregates goals/tasks/workers/verification/usage into a `SwarmMetrics`; `GET /api/metrics` + metrics in the streamed snapshot. Dashboard Metrics panel: stat tiles (goals done, grounded %, cost) + accepted/verified bar charts + summary line. 2 tests. Full suite green.
- **Iter 29 — TUI (Phase D complete).** Pure `renderTui(state)` renders a boxed terminal view (metrics, verify meter, workers, tasks, recent logs) with uniform line width; `hermes-swarm tui` CLI command polls a running dashboard's /api/state and redraws each second. 3 tests (sections, empty state, alignment). Phase D done. Full suite green.
- **Iter 30 — dashboard auth + bus token rotation (Phase E start).** SwarmServer optional `authToken` guards `/api/*` (bearer, X-Swarm-Token, or `?token=` for SSE); dashboard page stays open. HttpControlPlane gains `rotateToken(new, graceMs)` with a dual-token grace window so workers re-auth without being dropped, plus `activeTokens()`. `--auth-token` CLI flag. 2 tests. Full suite green.
- **Iter 31 — observability.** `observability/`: `formatPrometheus(metrics)` (labelled + scalar gauges) served at `GET /metrics` for scrapers; `attachStructuredLogging(manager, sink)` emits ndjson records for worker/task/goal lifecycle events (default stdout sink). 3 tests. Full suite green.
- **Iter 32 — resource-limit enforcement + tests.** Extracted pure `buildDockerRunArgs(spec, opts)` from DockerProvider so every hardening/limit flag (no-new-privileges, pids-limit, cpus/memory, --network none, --read-only, --cap-drop ALL, env) is unit-testable without a daemon. Tests also verify LocalProcessProvider kills a worker at its lifetime ceiling. 5 tests. Full suite green.
- **Iter 33 — docker hardening.** Unauth `GET /healthz` liveness probe (works even when API is token-guarded); worker touches a health-heartbeat file each beat (`SWARM_HEALTH_FILE`, best-effort). Added `HEALTHCHECK` to worker (file-freshness) and manager (/healthz) Dockerfiles + multi-arch buildx notes. 2 tests. Full suite green.
- **Iter 34 — config file support.** `config/`: pure `resolveConfig` merge with defaults < file < env precedence (undefined never clobbers), `configFromEnv` (SWARM_* vars), `loadConfigFile` (JSON), `loadSwarmConfig` convenience. `swarm.config.example.json`. 7 tests. Full suite green.
- **Iter 35 — graceful shutdown.** `lifecycle/installGracefulShutdown(cleanup, opts)`: run-once cleanup on SIGINT/SIGTERM with a hard-timeout force-exit (injectable `exit` for tests) so a wedged drain can't hang a container. Manager `shutdown()` made idempotent. CLI serve now uses it. 4 tests. Full suite green.
- **Iter 36 — chaos tests (Phase E complete).** Resilience integration suite: worker killed mid-goal → requeue+replace recovers; flaky executor throwing on early attempts → retry loop recovers; jittery slow responses → still completes; all-ungrounded → fails cleanly without hanging. 4 tests. Phase E done. Full suite green.
- **Iter 37 — docs + runnable example (Phase F start).** `examples/swarm/demo.ts` (+README, `npm run swarm:demo`): offline inline swarm with a mock research skill, prints plan/verification/synthesis/provenance/metrics — verified running end-to-end. Expanded `docs/24-swarm-runtime.md` with a full module/anti-hallucination-layer/config/REST-endpoint reference. Full suite green.
- **Iter 38 — end-to-end integration suite.** One `e2e.test.ts` drives the whole stack together: REST goal start → DAG → poll to completion → provenance (all gate-cleared); a Slack-shaped gateway message launches + replies; the scheduler registers + fires a cron goal; /healthz + Prometheus /metrics; and structured logging captures lifecycle events. Full suite green.
- **Iter 39 — benchmarks / load test.** Pure `summarizeLatencies`/`percentile`/`formatSummary` (throughput + p50/p95/p99) + `examples/swarm/bench.ts` (`npm run swarm:bench`). Load test surfaced and fixed an EventEmitter listener leak under concurrent goals (`setMaxListeners(0)`); inline bench ~2500 goals/s, 100% grounded. 4 tests. Full suite green.
- **Iter 40 — final review & release prep (COMPLETE).** Added CHANGELOG.md; polished the README swarm section (full feature map + demo/tui commands); rebuilt the esbuild worker/CLI bundle and smoke-tested the compiled `dist-swarm/cli.js` (goal completed). Final verification: **0 type errors, 699 tests pass, tsup ESM+CJS+DTS lib build succeeds**.

---

## ✅ BUILD COMPLETE — all 40 iterations done

Hermes-Swarm is a lightweight, Hermes-inspired dockerized agent-swarm harness: a manager agent plans a goal, spawns isolated worker agents (docker/process/inline), delegates tasks, and accepts a result only after it clears a 7-layer anti-hallucination + anti-rogue trust pipeline (grounding gate, consensus, contradiction detection, provenance, semantic + adversarial verification, behavioural guardrail). Ships orchestration (priority DAG scheduler, autoscaling, dead-worker recovery, hierarchical sub-swarms, budgets, cancellation, crash-recoverable persistence), integrations (MCP tools, cron, chat gateways, worker skills, multi-provider LLM, harness/tool executors), a full web dashboard + terminal TUI + CLI, and ops hardening (auth + token rotation, /healthz, Prometheus /metrics, structured logging, config files, graceful shutdown, chaos + e2e + benchmark suites).

Started from 582 tests → **699 tests**, all green; typecheck clean; library + docker bundles build. Try it: `npm run swarm:demo`.
