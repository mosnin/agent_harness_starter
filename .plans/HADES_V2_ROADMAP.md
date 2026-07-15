# Hades v2 — Teams, A2A, and On-Demand Swarms (30-Iteration Build)

**Goal (the user's /goal):** beat Hermes on every axis — capability, security,
and footprint — by making Hades *team-native*. Hades should excel at **spawning
swarms of containerized agents on demand** that talk to each other directly
(**agent-to-agent / A2A**), carry out tasks **in parallel in a fraction of the
time**, and be assembled from **modular skills and plugins**.

**What Hermes has that we're closing:**
- Direct **A2A messaging** between agents (we only had manager↔worker).
- **Team / role** abstractions that form dynamically around a task.
- A **modular** skill + plugin package model (manifests, versions, hot-load).
- First-class **parallel fan-out** with measured speedup.
- Deeper **per-agent capability scoping** on the A2A surface.

**North star:** a task arrives → Hades forms the right *team* of role-specialized
agents in isolated containers → they coordinate over an authenticated A2A bus →
work runs in parallel → results are aggregated and verified by the swarm gate →
the team disbands. More capable, more secure, and lighter than Hermes.

**Working agreement (every iteration):**
1. Read this file → pick the next `[ ]` iteration.
2. Write a 2–4 line plan (in the log at the bottom).
3. Implement a focused chunk under `src/hades/` (new area: `src/hades/teams/`,
   `src/hades/a2a/`, `src/hades/modules/`, `src/hades/parallel/`,
   `src/hades/security/`, `src/hades/bench/`).
4. `tsc` clean + `vitest run` green (add tests; **injectable transports / clocks
   / spawners** so teams + A2A test without containers or credentials).
5. Commit to `claude/hermes-swarm-framework-vbhrot`. Update checkbox + log here.
6. Never break a previously-green iteration (swarm-runtime + Hades v1 stay green).

Baseline: swarm-runtime (699) + Hades v1 complete, **909 tests green**.

---

## Phase G — A2A Communication Layer
- [x] 1. A2A envelope + addressing (`AgentAddress`, `A2AMessage`, correlation ids).
- [x] 2. Per-agent mailbox + in-memory A2A bus (send/receive, injectable transport).
- [x] 3. Pub/sub topics + team broadcast (subscribe, publish, fan-out).
- [x] 4. Request/response RPC between agents (correlated, timeout, error).
- [x] 5. Streaming A2A (chunked replies) + backpressure-safe delivery.

## Phase H — Teams & Dynamic Spawning
- [x] 6. Role registry + `TeamBlueprint` (roles, capabilities, size bounds).
- [x] 7. `TeamFormer`: decompose a task → required roles → a concrete roster.
- [x] 8. `Team` spawn over injectable spawner (isolation providers / RemoteBackend).
- [x] 9. Team lifecycle: form → work → disband (+ failure-aware teardown).
- [x] 10. Team coordinator wiring the A2A bus to the roster (addressed + broadcast).

## Phase I — Modular Skills & Plugins v2
- [ ] 11. Skill **module manifest** (name, version, deps, capabilities, provides).
- [ ] 12. Semver-ish dependency resolution + topological load order.
- [ ] 13. Skill module loader: hot **load/unload/reload** into a live registry.
- [ ] 14. Plugin **package** format + capability manifest + declared permissions.
- [ ] 15. Unified module registry (skills + plugins) with conflict + version checks.

## Phase J — Parallel Execution & Speedup
- [ ] 16. Parallel fan-out coordinator (map a task across the team).
- [ ] 17. Work-stealing / load balancer across idle roster members.
- [ ] 18. Map-reduce aggregation over A2A (scatter → gather → reduce).
- [ ] 19. Pipeline stages across roles (assembly-line parallelism).
- [ ] 20. Speedup benchmark: parallel-vs-serial wall-clock + efficiency metric.

## Phase K — Security Hardening (beat Hermes)
- [ ] 21. Per-agent capability tokens (NHI) minted per team membership.
- [ ] 22. A2A message signing + verification (injectable signer; tamper-reject).
- [ ] 23. Least-privilege team permission scopes (deny-by-default capability grants).
- [ ] 24. A2A + team **audit trail** (who talked to whom, what was spawned).
- [ ] 25. Secure-by-default spawn policy (resource caps, no-net default, egress allowlist).

## Phase L — Benchmarks / Lightweight / Release
- [ ] 26. Benchmark harness: throughput, latency, A2A round-trip, spawn time.
- [ ] 27. Footprint pass: lazy module loading + slim team defaults (lightweight win).
- [ ] 28. `hades team` CLI surface + team/A2A docs + runnable team example.
- [ ] 29. End-to-end: task → form team → A2A parallel work → verified aggregate → disband.
- [ ] 30. Final review, README/CHANGELOG, benchmark table, build verification; STOP.

---

## Iteration log
_(newest last; one entry per completed iteration)_

### Phase G — A2A
- **Iter 1 — A2A envelope + addressing.** `a2a/types`: `AgentAddress` (agentId/role/team) + `BroadcastAddress`, the `A2AMessage` envelope (kinds: event/request/response/stream/stream_end/error, topic, correlationId), and pure delivery logic — `deliversTo` matches direct by agentId and broadcasts by team scope. `MessageFactory` stamps deterministic ids + injectable clock and builds each envelope kind (request seeds its own correlation id). This is the layer the manager↔worker bus lacked: agents addressing each other directly. 5 tests. Full suite green (914).
- **Iter 2 — mailbox + in-memory A2A bus.** `a2a/bus`: injectable `A2ATransport` (delivery only; addressing stays pure). `InMemoryA2ATransport` delivers each message to every agent it addresses (direct by id, broadcast by team) and never echoes to the sender. `Mailbox` supports both pull (`take()` — await the next message like a coroutine) and push (`on`) consumption. `AgentEndpoint` binds an address + outbound `MessageFactory` + inbound mailbox to the transport (`emit`/`broadcast`/`receive`/`on`/`close`). 6 tests. Full suite green (920).
- **Iter 3 — pub/sub topics.** `a2a/PubSub` over an `AgentEndpoint`: `subscribe(topic, handler)` so a team broadcast on `"build:done"` only wakes that topic's subscribers, `publish(topic, payload, {team})` is a topic-carrying team broadcast, and `ALL_TOPICS` taps the firehose (coordination/logging). Unsubscribe prunes empty topics; multiple subscribers per topic fan out. 4 tests. Full suite green (924).
- **Iter 4 — request/response RPC.** `a2a/RpcPeer` over an `AgentEndpoint` both `serve`s inbound requests and `request`s (awaiting the correlated response). Correlation by `correlationId`; a handler that throws surfaces to the caller as a rejected promise via an `error` message; an unanswered request rejects on timeout; concurrent requests correlate independently; `close()` rejects everything in flight. Timers are injectable, so timeout tests deterministically (manual scheduler). 5 tests. Full suite green (929).
- **Iter 5 — streaming A2A (Phase G complete).** `a2a/StreamPeer`: `serveStream` turns an async-iterable handler into a stream of `stream` messages terminated by `stream_end`/`error`; `requestStream` returns an async generator yielding chunks in order, completing on `stream_end`, throwing on producer error. Built on `AsyncQueue` — ordered, lossless, buffered, with a high-water-mark overflow flag as the backpressure signal. Independent streams run concurrently. 6 tests. **Phase G done.** Full suite green (935).

### Phase H — Teams
- **Iter 6 — role registry + team blueprint.** `teams/`: `AgentRole` (capabilities route tasks; skills + prompt fragment specialize) and `RoleRegistry` with a `defaultRoleRegistry` (planner/researcher/coder/reviewer/tester) + `withCapability` lookup. `TeamBlueprint` (role requirements with counts + min/max, `maxAgents` runaway ceiling); pure `blueprintSize`, `validateBlueprint` (unknown roles, bad counts, oversize teams), and `expandRoster` → concrete namespaced `{agentId, role}` slots. 6 tests. Full suite green (941).
- **Iter 7 — TeamFormer.** Turns a `TaskSpec` into a concrete team: an injectable `decompose` (LLM) can design the blueprint, else the offline heuristic maps each required capability to a role, brackets the work with a planner + reviewer, falls back to a coder when nothing maps, applies per-role count overrides, validates, and expands to a namespaced roster — throwing when the design exceeds `maxAgents`. `slugify` derives a stable team id. This is "form the right team around a task, on demand." 6 tests. Full suite green (947).
- **Iter 8 — Team spawn over an injectable spawner.** `Team` spawns every roster slot concurrently (fast formation), wires each to the shared A2A transport, tracks members by id/role, and tears down in parallel; `spawn` is idempotent. `AgentSpawner` abstracts *how* a slot becomes a live agent: `InProcessAgentSpawner` (endpoint only — tests/local) and `BackendAgentSpawner` — provisions each member as a **containerized worker** on a `RemoteBackend` (Modal/SSH/Daytona/Singularity) with the role's capabilities, then connects its endpoint, terminating the worker on stop. Members talk over A2A immediately after spawn. On-demand containerized swarms, injectable end-to-end. 3 tests. Full suite green (950).
- **Iter 9 — team lifecycle.** `TeamRunner.run(task, work)` drives the full lifecycle — **form → spawn → work → disband** — with failure-aware teardown: whatever happens in `work`, the team is always torn down in the `finally`, so a failed run never leaks containers. State transitions (`forming`/`ready`/`working`/`disbanded`/`failed`) are observable; success ends `disbanded`, failure ends `failed` (with `lastError`) but still tears down every spawned agent. 3 tests. Full suite green (953).
- **Iter 10 — team coordinator (Phase H complete).** `TeamCoordinator` runs on its own A2A endpoint (`<team>.coordinator`) and gives the orchestrator team-level messaging over the roster: `direct`/`request` (RPC) an individual member, `announce` a topic to the whole team, `onTopic` to listen. It composes the A2A `RpcPeer` + `PubSub` — turning a bag of spawned agents into a coordinated team (the addressed + broadcast surface). 4 tests. **Phase H done.** Full suite green (957).
