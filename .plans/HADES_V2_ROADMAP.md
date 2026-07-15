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
- [x] 11. Skill **module manifest** (name, version, deps, capabilities, provides).
- [x] 12. Semver-ish dependency resolution + topological load order.
- [x] 13. Skill module loader: hot **load/unload/reload** into a live registry.
- [x] 14. Plugin **package** format + capability manifest + declared permissions.
- [x] 15. Unified module registry (skills + plugins) with conflict + version checks.

## Phase J — Parallel Execution & Speedup
- [x] 16. Parallel fan-out coordinator (map a task across the team).
- [x] 17. Work-stealing / load balancer across idle roster members.
- [x] 18. Map-reduce aggregation over A2A (scatter → gather → reduce).
- [x] 19. Pipeline stages across roles (assembly-line parallelism).
- [x] 20. Speedup benchmark: parallel-vs-serial wall-clock + efficiency metric.

## Phase K — Security Hardening (beat Hermes)
- [x] 21. Per-agent capability tokens (NHI) minted per team membership.
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

### Phase J — Parallel execution
- **Iter 16 — parallel fan-out.** `FanOutCoordinator.map(items)` distributes items across the roster through a **shared work queue** — each member processes one item at a time and pulls the next when free, so max parallelism equals roster size and faster members implicitly do more work. Results return in input order; `byAgent` reports load distribution; `continueOnError` collects `failures` while keeping successes (else the first error rejects). The "fraction of the time" primitive, over an injectable dispatch (RPC/local). 6 tests. Full suite green (995).
- **Iter 17 — work-stealing load balancer.** `LoadBalancer.run(items)` adds fault tolerance: a failed item is **stolen** to a *different* healthy member (up to `maxRetries`), and a member that fails repeatedly is **quarantined** out of rotation so it stops dragging the team down. Scheduling runs in parallel waves (width = healthy roster) for high throughput; items exhausting retries land in `failures`, and if all agents quarantine the rest fail cleanly. Where fan-out assumes reliable members, the balancer assumes they aren't. 6 tests. Full suite green (1001).
- **Iter 18 — map-reduce over A2A.** `mapReduce(agents, items, {map, reduce, initial})` runs the classic scatter → gather → reduce: the **map** fans across the roster in parallel (via `FanOutCoordinator`), the **gather** preserves input order regardless of completion order, and the **reduce** folds deterministically. The expensive map shrinks toward 1/N wall-clock on a team of N; verified with sum-of-squares and word-count reduces. 3 tests. Full suite green (1004).
- **Iter 19 — role pipeline (assembly-line).** `pipeline(items, stages)` flows every item through role-owned stages (researcher → coder → reviewer) with **no barrier between stages** — item B can be in stage 1 while item A is in stage 3 — so wall-clock is the slowest single-item chain, not the sum of per-stage totals. Each stage carries a concurrency bound (its role's agent count) via a semaphore; results stay in input order; `continueOnError` collects instead of rejecting. Overlap + bound verified by timeline. 4 tests. Full suite green (1008).
- **Iter 20 — speedup benchmark (Phase J complete).** `modelSpeedup(costs, agents)` predicts parallel makespan via greedy list-scheduling and returns `speedup` (serial/parallel) + `efficiency` (speedup/agents) deterministically — the metric a "fraction of the time" claim is measured against. `timed`/`benchmarkSpeedup` measure real serial-vs-parallel wall-clock with an injectable clock (deterministic in tests). 6 tests. **Phase J done.** Full suite green (1014).

### Phase K — Security
- **Iter 21 — capability tokens (NHI).** `security/tokens`: `CapabilityMinter` mints a per-agent `CapabilityToken` scoping exactly what a team member may do (capabilities, team, issued/expiry), one per membership (`mintForTeam` over the roster); `CapabilityChecker` validates (structure + expiry) and authorizes **deny-by-default** — a capability is granted only if the token holds it or `*`; `assert` throws for guard sites. The non-human-identity base for the A2A/spawn checks that follow. 6 tests. Full suite green (1020).

### Phase I — Modular skills & plugins
- **Iter 11 — module manifest + semver.** `modules/manifest`: `ModuleManifest` (name, semver version, kind skill/plugin/pack, dependencies as name→range, capabilities, provides, permissions) and a dependency-free semver matcher — `parseVersion`, `compareVersions`, and `satisfies` supporting `*`, exact, caret `^`, tilde `~`, and `>=/>/<=/<`. `validateManifest` checks name/version/kind shape and that every dependency range parses. The foundation for resolution + hot-load. 9 tests. Full suite green (966).
- **Iter 12 — dependency resolution + load order.** `resolveModules(available, roots)` chooses one version per module satisfying **all** accumulated ranges (highest wins) via a bounded constraint fixpoint, reports missing modules and unsatisfiable version conflicts, then returns the chosen set in **dependency-first topological order** (Kahn) — detecting cycles and deduping a shared dep across roots. 6 tests. Full suite green (972).
- **Iter 13 — hot skill-module loader.** `SkillModuleLoader` loads/unloads/reloads skill modules at runtime (validating each manifest, emitting load/unload/reload events) and `skillRegistry()` projects the currently-loaded set into a fresh `SkillRegistry` for the swarm. `loadAll` resolves dependency order first so nothing loads before what it needs; unloading a module others depend on is refused (returns `blockedBy`) unless forced. 5 tests. Full suite green (977).
- **Iter 14 — governed plugin packages.** `PluginPackage` = manifest (capabilities, provided hooks, **requested permissions**) + factory. `PluginPackageLoader` installs into a live `PluginManager` enforcing declared permissions **deny-by-default**: a package requesting any ungranted permission is refused before its code runs (returned as `denied`); permission-free packages always pass. Configurable via `allowedPermissions` or a custom `grant`; non-plugin manifests rejected; `installAll` resolves dependency order. More secure than a bare registry. 6 tests. Full suite green (983).
- **Iter 15 — unified module registry (Phase I complete).** `ModuleRegistry` is one catalog for skills, plugins, and packs: holds every available version (newest-first `find`/`latest`), counts by kind, rejects duplicate name+version, detects real conflicts (a name declared under more than one kind), and resolves a cross-kind install set into dependency-first load order via the shared resolver. The single registry the CLI/marketplace queries and loaders draw from. 6 tests. **Phase I done.** Full suite green (989).

### Phase H — Teams
- **Iter 6 — role registry + team blueprint.** `teams/`: `AgentRole` (capabilities route tasks; skills + prompt fragment specialize) and `RoleRegistry` with a `defaultRoleRegistry` (planner/researcher/coder/reviewer/tester) + `withCapability` lookup. `TeamBlueprint` (role requirements with counts + min/max, `maxAgents` runaway ceiling); pure `blueprintSize`, `validateBlueprint` (unknown roles, bad counts, oversize teams), and `expandRoster` → concrete namespaced `{agentId, role}` slots. 6 tests. Full suite green (941).
- **Iter 7 — TeamFormer.** Turns a `TaskSpec` into a concrete team: an injectable `decompose` (LLM) can design the blueprint, else the offline heuristic maps each required capability to a role, brackets the work with a planner + reviewer, falls back to a coder when nothing maps, applies per-role count overrides, validates, and expands to a namespaced roster — throwing when the design exceeds `maxAgents`. `slugify` derives a stable team id. This is "form the right team around a task, on demand." 6 tests. Full suite green (947).
- **Iter 8 — Team spawn over an injectable spawner.** `Team` spawns every roster slot concurrently (fast formation), wires each to the shared A2A transport, tracks members by id/role, and tears down in parallel; `spawn` is idempotent. `AgentSpawner` abstracts *how* a slot becomes a live agent: `InProcessAgentSpawner` (endpoint only — tests/local) and `BackendAgentSpawner` — provisions each member as a **containerized worker** on a `RemoteBackend` (Modal/SSH/Daytona/Singularity) with the role's capabilities, then connects its endpoint, terminating the worker on stop. Members talk over A2A immediately after spawn. On-demand containerized swarms, injectable end-to-end. 3 tests. Full suite green (950).
- **Iter 9 — team lifecycle.** `TeamRunner.run(task, work)` drives the full lifecycle — **form → spawn → work → disband** — with failure-aware teardown: whatever happens in `work`, the team is always torn down in the `finally`, so a failed run never leaks containers. State transitions (`forming`/`ready`/`working`/`disbanded`/`failed`) are observable; success ends `disbanded`, failure ends `failed` (with `lastError`) but still tears down every spawned agent. 3 tests. Full suite green (953).
- **Iter 10 — team coordinator (Phase H complete).** `TeamCoordinator` runs on its own A2A endpoint (`<team>.coordinator`) and gives the orchestrator team-level messaging over the roster: `direct`/`request` (RPC) an individual member, `announce` a topic to the whole team, `onTopic` to listen. It composes the A2A `RpcPeer` + `PubSub` — turning a bag of spawned agents into a coordinated team (the addressed + broadcast surface). 4 tests. **Phase H done.** Full suite green (957).
