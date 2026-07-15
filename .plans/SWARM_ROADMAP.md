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
- [ ] 4. Revision loop hardening: structured feedback, attempt caps, escalation.
- [ ] 5. Semantic grounding check via embeddings (reuse `src/agents/embeddings`).
- [ ] 6. Adversarial verifier: an independent skeptic pass that tries to refute claims.

## Phase B — Orchestration depth
- [ ] 7. Task DAG scheduler: priorities, backpressure, ready-set batching.
- [ ] 8. Worker autoscaling to ready parallelism (min/max bounds).
- [ ] 9. Dead-worker detection, heartbeat timeouts, replacement + task requeue.
- [ ] 10. Hierarchical swarms: a manager can spawn sub-managers.
- [ ] 11. Per-goal budget/cost + tool-call accounting with ceilings.
- [ ] 12. Goal cancellation / abort mid-flight (propagate to workers).
- [ ] 13. Persistent goal/task state (file/SQLite) for crash recovery.

## Phase C — Integrations & modes (Hermes parity)
- [ ] 14. Expose swarm control as MCP tools (spawn/status/dispatch).
- [ ] 15. Cron-scheduled swarms (recurring goals).
- [ ] 16. REST API expansion + documented schema.
- [ ] 17. Harness-backed executor: wire the existing `@/agents` harness + tool registry into workers.
- [ ] 18. Worker tool access (web search / sandbox) with grounded traces.
- [ ] 19. Provider abstraction: OpenAI / Anthropic / Nous / OpenRouter / local.
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
