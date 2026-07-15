# Hades Elite — Performance & Hierarchy Loop (agent-team driven)

**Goal (the user's /goal):** make Hades an **extremely high-performance** agent
that **beats Hermes on every measurable metric**, with our **signature swarm
hierarchy mode** as the centerpiece. Not more surface features — depth,
performance engineering, resilience, and proof.

**How every iteration runs (non-negotiable):**
1. Read this file → pick the next `[ ]` iteration.
2. **Spawn a team of subagents in parallel** (2–4 via the Agent tool) that each
   own DISTINCT new files (no shared-file conflicts; never touch `index.ts` or
   existing files — the main loop wires exports). At least one agent is an
   **adversarial verifier** that tries to break the others' work.
3. Integrate centrally: wire exports, run `tsc --noEmit -p tsconfig.lib.json`
   (must be clean) + `npx vitest run` (must be fully green).
4. Where the iteration is a performance claim, **run the real benchmark** and
   record the measured number (no fabricated numbers).
5. Commit to `claude/hermes-swarm-framework-vbhrot`; update checkbox + log; push
   periodically.
6. Never regress a previously-green iteration.

Baseline at loop start: 1076 tests / 133 files green; O(1) A2A routing, swarm
hierarchy mode (in-process + distributed), live benchmarks already landed.

---

## Iterations

### Hierarchy depth & resilience
- [x] 1. **Fault-tolerant hierarchy**: a coordinator whose child RPC fails/times-out re-delegates to a healthy sibling or a spare; node failure never fails the whole run. Adversarial agent injects flaky/dead nodes.
- [x] 2. **Adaptive/elastic hierarchy**: rebalance subtree width to load; grow/shrink branching from a work estimate; measure makespan vs a fixed tree.
- [x] 3. **Priority + deadline scheduling** through the hierarchy: high-priority subtasks preempt queue order; per-node deadline propagation + cancellation.
- [ ] 4. **Streaming aggregation up the tree**: partial results stream to parents as children finish (no buffering the whole level) — lower latency + memory.

### A2A performance engineering
- [ ] 5. **Batched delivery + message pooling**: coalesce bursts, reuse envelopes; benchmark messages/sec before/after with a real number.
- [ ] 6. **Credit-based backpressure** (real flow control, not a flag): bounded in-flight per link, sender awaits credit; prove no unbounded buffering under a fast producer / slow consumer.
- [ ] 7. **Cross-process transport parity**: an HTTP/WS `A2ATransport` with the SAME O(1) direct-routing semantics + a conformance test the in-memory transport also passes.
- [ ] 8. **Ordered + at-least-once delivery guarantees** with dedupe; property test message ordering per link under concurrency.

### Beat-Hermes proof
- [ ] 9. **Flat-baseline harness**: implement a naive flat manager→worker orchestrator in-repo and a head-to-head benchmark (throughput, latency, makespan, routing cost) — Hades hierarchy vs flat, with a generated comparison table.
- [ ] 10. **Metrics & live snapshot**: per-node throughput/latency/queue-depth counters with a `snapshot()` a dashboard can poll; overhead measured to be negligible.
- [ ] 11. **Load/soak test**: sustained high-rate workload, assert stable throughput + bounded memory + no leak (endpoint counts return to baseline).
- [ ] 12. **Regression guardrails**: perf-invariant tests (O(1) routing, depth-bounded critical path, aggregation correctness) that fail if a future change breaks them.

### Resilience & correctness
- [ ] 13. **Circuit breakers + timeouts** at each hierarchy hop; a persistently failing subtree is short-circuited, not retried forever.
- [ ] 14. **Property-based correctness**: randomized trees/workloads where the hierarchy result must equal a flat reference reducer (fuzz decompose/aggregate).
- [ ] 15. **Chaos pass**: adversarial agent injects drops, delays, reorders, node deaths; the swarm still returns a correct verified aggregate or a clean, audited failure.

### Release
- [ ] 16. **Elite release**: full head-to-head benchmark table in docs, `hades hierarchy`/swarm CLI + REPL wiring, README/CHANGELOG with measured wins, final verification; STOP the loop.

---

## Iteration log
_(newest last; one entry per completed iteration)_

- **Iter 3 — priority + deadline scheduling.** Team: a builder + an adversarial verifier in parallel. `PriorityScheduler` (`src/hades/hierarchy/scheduling.ts`) dispatches subtasks priority-desc with EDF tiebreak (then id, for a total deterministic order), and **sheds late work** — any subtask whose deadline has already passed at dispatch is cancelled (never run, emits `cancel-deadline`) instead of wasting compute; `propagateDeadline` carries the earliest deadline down the tree. Injectable clock (re-read per dispatch, so clock-advancing work can shed strictly-later jobs), bounded-concurrency worker pool that still pulls in priority order. Adversarial verifier: 9 tough tests (exact total order over a shuffled mix, `now===deadline` boundary, cascading deadline misses with a hand-computed completed/cancelled split, all-expired, event-stream consistency, 200-job seeded sort vs an independent comparator) — **all pass, no bugs found**; flagged a doc/code mismatch on the `order` field, which I aligned (order = full priority-ranked schedule, cancelled jobs keep their rank). Builder 7 + adversarial 9 tests. Full suite green (1121 / 138 files).

- **Iter 2 — adaptive/elastic hierarchy.** Team: a builder + an adversarial verifier in parallel. `planAdaptiveHierarchy(estimate)` (`src/hades/hierarchy/adaptive.ts`) sizes the tree shape (branching/depth/workers) to the workload and `compareToFixed` proves it against a fixed tree. **The adversarial verifier caught a real bug**: the tree search capped leaves at `maxWorkers` but ignored `itemCount`, provisioning 125 workers for a 100-item job (25 idle). Fixed centrally: the search is now makespan-optimal *within* a hard `min(maxWorkers, itemCount)` ceiling — never more workers than items, and for bottlenecked (skewed-cost) workloads it keeps the pool small at the same makespan (faster **and** lighter). Reconciled the builder's chunk-cost-era assertion to the improved contract; the adversarial suite (which itself fairly reframed an over-cap comparison) passes fully. Builder 8 + adversarial 10 tests. Full suite green (1105 / 137 files).

- **Iter 1 — fault-tolerant hierarchy.** Team: a builder agent + an adversarial-verifier agent in parallel against a locked API. `ResilientHierarchyOrchestrator` (`src/hades/hierarchy/resilient.ts`): a coordinator whose child subtree throws or times out re-delegates that subtask to a healthy sibling (round-robin), retrying up to `maxReassignments`; a node failing `deadAfter` times is marked dead and skipped; injectable timers make timeout deterministic; uncancellable timed-out work is ignored via a `settled` guard. Stats expose retries/reassignments/deadNodes + events. Builder: 5 tests. Adversarial verifier: 6 tough tests (partial/cascading failure exactness, dead-node dedup, exhaustion-without-hang via a deadline race, no double-execution of succeeded subtasks, event emission) — **all green, no implementation bugs found**; flagged that `deadAfter:1` retires a node after one recoverable failure (documented contract edge). Full suite green (1087 / 135 files).
