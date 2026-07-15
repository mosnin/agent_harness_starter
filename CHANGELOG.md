# Changelog

## Hermes-Swarm runtime (`src/swarm-runtime/`)

A lightweight, Hermes-inspired swarm harness added on top of the agent library: a
manager agent decomposes a goal, spawns isolated worker agents (Docker / OS
process / inline), delegates tasks, and accepts a result only after it clears a
layered anti-hallucination + anti-rogue trust pipeline. Built across 40
iterations (see [`.plans/SWARM_ROADMAP.md`](./.plans/SWARM_ROADMAP.md)).

### Anti-hallucination / anti-rogue
- Verification gate: per-result grounding — cited evidence must trace to the
  worker's actual tool output; fabricated evidence is auto-rejected.
- Redundant-worker consensus voting (majority agreement required).
- Cross-claim contradiction detection across a goal's results.
- Evidence provenance store (confirmed-evidence audit trail + grounding rate).
- Semantic grounding judge (embeddings) and independent adversarial verifier.
- Anti-rogue guardrail: kills workers on destructive / exfil / sandbox-escape /
  self-preservation / runaway behaviour.

### Orchestration
- Isolation providers: Docker (hardened: cap-drop, no-new-privileges,
  read-only rootfs, pids-limit, cpu/mem), OS process, inline.
- Priority DAG scheduler with backpressure; worker autoscaling; dead-worker
  detection + task requeue; hierarchical sub-swarms; per-goal budgets;
  cancellation; persistent (crash-recoverable) state.

### Integrations & modes
- Pull-based HTTP control plane with token rotation; MCP tools; expanded REST
  API; cron-scheduled goals; harness-backed + tool + LLM executors; provider
  abstraction (OpenAI / Anthropic / Nous / OpenRouter / Together / Groq /
  local); chat gateways (Slack / Discord / Telegram); worker skills.

### GUI / UX / ops
- Web dashboard (DAG, logs, evidence viewer, goal history, live kill/scale
  controls, metrics) + SSE; terminal UI; `hermes-swarm` CLI (run/serve/tui/doctor).
- Dashboard auth; `/healthz`; Prometheus `/metrics`; structured ndjson logging;
  config file (defaults < file < env); graceful shutdown; chaos + e2e +
  benchmark suites.

**699 tests. Zero-config quickstart:** `npm run swarm:demo`.

---

## Hades — the learning agent (`src/hades/`)

The fuller agent layered on the Hermes-Swarm core: it remembers, learns, and
lives where you do, without bypassing the swarm's verification gate. Built across
a second 40 iterations (see [`.plans/HADES_ROADMAP.md`](./.plans/HADES_ROADMAP.md)).
Everything is injectable, so the whole tree tests without real credentials, a
network, an LLM, or a real clock.

### Closed learning loop (Phase A)
- Cross-session memory store (ranked by lexical overlap · salience · recency)
  and session store with FTS-style search.
- Agent-curated memory extraction; memory nudges; autonomous skill creation
  (`SkillForge`) and skill self-improvement (`SkillTuner`) from trajectories.
- Durable dialectic user model; memory-augmented executor that injects learned
  context into worker prompts.

### Platform connectors (Phase B)
- `ConnectorHub` (one handler, many channels; rate-limit + mirror) with
  Telegram / Slack / Discord / WhatsApp Cloud / Signal connectors over injectable
  transports; voice pipeline (injectable STT/TTS); cross-platform conversation
  continuity (one identity + session across channels with a link-code flow).

### Execution backends (Phase C)
- `RemoteBackend` registry beyond local isolation: SSH, Modal (serverless),
  Daytona (persistent serverless), Singularity/Apptainer (HPC); `ScaleToZeroManager`
  idle-hibernate + wake-on-demand.

### Protocols, models, plugins (Phase D)
- ACP adapter (server + session model, streamed updates) with edit-approval,
  permissions, and a provenance log; model-switching UX (`hades model`);
  `HadesPlugin` system + example plugins (browser/kanban/achievements) + local
  registry; domain skill packs (devops/research/finance) + loader.

### Research/training + REPL (Phase E)
- Trajectory recording (goal→task→tool→result); batch generation runner;
  compression → JSONL training data; interactive REPL (multiline, history,
  slash commands + autocomplete + interrupt) wired to memory + a conversational
  agent loop.

### Packaging / polish (Phase F)
- Unified `hades` CLI; layered config + `HADES_*` env + i18n (en/es);
  `Dockerfile.hades` + `scripts/install-hades.sh`; guide + architecture docs +
  a runnable example; an end-to-end suite composing gateway + backend + learning
  loop + REPL.

**Swarm + Hades: 909 tests.**

---

## Hades v2 — Teams, A2A & on-demand parallel swarms (`src/hades/{a2a,teams,modules,parallel,security,bench}/`)

A third 30-iteration build makes Hades team-native — closing the remaining gaps
against Hermes on capability, security, and footprint. Everything is injectable,
so teams of containerized agents test without containers, a network, or
credentials. See [`.plans/HADES_V2_ROADMAP.md`](./.plans/HADES_V2_ROADMAP.md).

### A2A communication (Phase G)
- Agent-to-agent addressing + envelope; per-agent mailbox + in-memory bus;
  topic pub/sub + team broadcast; correlated request/response RPC (timeout,
  error propagation); ordered lossless streaming.

### Teams & dynamic spawning (Phase H)
- Role registry + `TeamBlueprint`; `TeamFormer` (task → validated roster);
  `Team` spawn over an injectable spawner — in-process or **containerized** on a
  RemoteBackend (Modal/SSH/Daytona/Singularity); form→work→disband lifecycle with
  failure-aware teardown; `TeamCoordinator` (addressed + broadcast).

### Modular skills & plugins (Phase I)
- Module manifests with semver dependency resolution + topological load order;
  hot skill-module load/unload/reload; plugin packages with deny-by-default
  declared permissions; a unified skill+plugin registry with conflict checks.

### Parallel execution (Phase J)
- Fan-out (shared-queue map across the roster); work-stealing load balancer
  (retry + quarantine); map-reduce (scatter/gather/reduce); assembly-line role
  pipeline; deterministic speedup + efficiency metrics.

### Security hardening (Phase K)
- Per-agent capability tokens (NHI); HMAC A2A signing with tamper-reject;
  least-privilege team permission scopes; an append-only audit trail (who talked
  to whom, what spawned); secure-by-default spawn policy (no network, read-only
  root, caps dropped, resource ceilings, egress allowlist).

### Benchmarks / lightweight / release (Phase L)
- Latency/throughput/round-trip benchmark harness; lazy-loading footprint pass;
  `hades team` CLI; teams/A2A docs + a runnable parallel-team example; a secure
  end-to-end team scenario.

**Swarm + Hades + Hades v2: 1054 tests.**

---

## Hades v2 performance level-up + signature swarm hierarchy mode

Built with a team of subagents working in parallel (distributed hierarchy, live
benchmarks, scale tests), integrated and verified centrally.

- **O(1) A2A routing.** Direct messages (all RPC + streaming) dispatch by an
  indexed `Map.get(agentId)` lookup — a 10,000-agent roster resolves a
  point-to-point send in exactly one comparison, not 10,000. Only broadcasts fan
  out. Instrumented via `routeScans`.
- **Swarm hierarchy mode** (`src/hades/hierarchy/`). Recursive coordinator→worker
  tree with parallel fan-out at every level: B^D workers in D coordination hops.
  `buildBalancedHierarchy` + `hierarchyStats` + in-process `HierarchyOrchestrator`
  + `DistributedHierarchy` (the same tree over the real A2A bus — each node its
  own endpoint + RPC peer). Scale-tested to 2048 workers deep / 243 wide.
- **Runnable benchmarks** (`src/hades/bench/live-bench.ts`, `docs/HADES_BENCHMARKS.md`):
  ~2.4M A2A messages/sec, ~230k RPC round-trips/sec, ~28–42× hierarchy-vs-serial
  speedup on 64 workers, and O(1) routing confirmed at 10k agents.

**Swarm + Hades + Hades v2: 1076 tests across 133 files.**

## Hades Elite — high-performance hierarchy vs a flat baseline (in-process)

> Scope note: the routing/makespan headlines below are an operation-count ratio
> and a virtual-clock model respectively — they prove in-process complexity and
> correctness properties, not end-to-end agent throughput. The measured wall-clock
> head-to-head currently favors the flat baseline. Real verified-throughput
> measurement is the [`.plans/HADES_BEYOND_HERMES.md`](./.plans/HADES_BEYOND_HERMES.md)
> roadmap.


A 16-iteration performance-engineering loop
([`.plans/HADES_ELITE_LOOP.md`](./.plans/HADES_ELITE_LOOP.md)) run under a sustained
autonomous `/loop`. **Every iteration was built by a team of 2–4 parallel subagents
with a dedicated adversarial verifier** trying to break the others' work; the main
loop integrated centrally, kept `tsc` clean and the suite green, ran the real
benchmark, and recorded only measured numbers. The adversarial passes caught and
forced fixes for real bugs (an over-provisioning tree search, a chaos-harness leaf
crash) rather than rubber-stamping.

### Beat-the-flat-baseline proof
- **Head-to-head harness** (`bench/flat-baseline.ts`, `bench/head-to-head.ts`): a
  naive flat manager→worker orchestrator (honest, still concurrent) vs the swarm
  hierarchy on an identical workload. **Routing cost O(N²)→O(N)**: measured **6.8×
  @16, 24.8× @64, 96.8× @256 workers** (hard `routeScans` counts, not wall-clock),
  aggregate parity proven every row.
- **Makespan O(N)→O(log N)** (`bench/latency-makespan.ts`): under a realistic
  discrete-event latency model (delivery costs latency; each agent is one
  sequential event loop) flat makespan is linear, hierarchy logarithmic —
  **1.33×→4.1×→13.5×→45.5×** speedup growing with N. The one regime where flat wins
  (single-node pure-CPU aggregation) is stated plainly, not hidden.

### Resilience, correctness & observability
- **Reliable delivery** (`a2a/reliable.ts`): exactly-once, in-order over a lossy
  link (seq/ACK/retransmit/dedupe) — property-tested across 30 chaos seeds.
- **Live metrics** (`metrics/collector.ts`): per-node throughput / nearest-rank
  latency percentiles / queue depth with an atomic pure-read `snapshot()` at
  **~180 ns/op** overhead.
- **Soak + leak probe** (`bench/soak.ts`, `bench/leak-probe.ts`): ~1.1M msg/s stable
  under sustained load, **zero leak** (endpoints return to baseline, maxDrift 0).
- **Circuit breakers + timeouts** (`hierarchy/circuit-breaker.ts`,
  `breaker-registry.ts`): a persistently failing subtree is short-circuited
  (≤threshold retries, never forever); per-hop timeouts feed the same breaker.
- **Property-based correctness** (`hierarchy/fuzz.ts`): 300 random trees ×
  reductions × workloads — hierarchy result **==** flat reference every time.
- **Chaos pass** (`hierarchy/chaos.ts`, `bench/chaos-suite.ts`): under
  drops/delays/reorders/node-deaths the swarm returns a correct **verified**
  aggregate **or** a clean **audited** failure — **0 silent-wrong across 125 runs**.
- **Regression guardrails** (`bench/invariants.ts`): perf-invariant tests that fail
  CI if O(1) routing, the depth-bounded critical path, or aggregation correctness
  ever regress.
- **CLI**: `hades hierarchy <head-to-head|makespan|chaos|fuzz|stats>` runs any of
  the above from the terminal.

**Swarm + Hades + Hades v2 + Elite: 1444 tests across 169 files.**
