# Hades Teams, A2A & Parallelism

Hades v2 makes the swarm **team-native**: a task forms the right team of
role-specialized agents in isolated containers, they coordinate directly over an
authenticated **agent-to-agent (A2A)** bus, work runs **in parallel**, and the
team disbands — more capable, more secure, and lighter than a flat worker pool.

Everything is injectable, so the whole stack tests **without containers, a
network, or credentials**.

## A2A — agents talk to each other

`src/hades/a2a/` adds direct agent messaging the manager↔worker bus lacked:

- **Addressing + envelope** — `AgentAddress` (agentId/role/team), the
  `A2AMessage` envelope, `MessageFactory`.
- **Bus + mailbox** — injectable `A2ATransport`, `InMemoryA2ATransport`,
  per-agent `Mailbox` (pull `take()` or push `on`), `AgentEndpoint`.
- **Pub/sub** — `PubSub` topic subscribe/publish + team broadcast.
- **RPC** — `RpcPeer` request/response, correlated, timeout, error-propagating.
- **Streaming** — `StreamPeer` ordered, lossless chunked replies.

## Teams — form, spawn, coordinate, disband

`src/hades/teams/`:

- `RoleRegistry` + `defaultRoleRegistry` (planner/researcher/coder/reviewer/tester).
- `TeamBlueprint` + `TeamFormer` — turn a task into a validated roster (`maxAgents`
  runaway ceiling).
- `Team` + `AgentSpawner` — spawn each member concurrently; `InProcessAgentSpawner`
  (local) or `BackendAgentSpawner` (**containerized** on Modal/SSH/Daytona/
  Singularity).
- `TeamRunner` — form → work → disband with failure-aware teardown (never leaks
  containers).
- `TeamCoordinator` — addressed `direct`/`request` + team `announce`/`onTopic`.

```
hades team roles              # list the role vocabulary
hades team plan "<objective>" # preview the team that would form
```

## Parallel execution — a fraction of the time

`src/hades/parallel/`:

- `FanOutCoordinator` — shared-queue map across the roster (parallelism = roster
  size; faster members do more).
- `LoadBalancer` — work-stealing with retry + quarantine of failing members.
- `mapReduce` — scatter → gather (ordered) → reduce.
- `pipeline` — assembly-line stages across roles (no barrier between stages).
- `modelSpeedup` / `benchmarkSpeedup` — measure speedup + efficiency.

## Security — more locked down than Hermes

`src/hades/security/`:

- **Capability tokens (NHI)** — `CapabilityMinter`/`CapabilityChecker`, per-agent,
  scoped, expiring, deny-by-default.
- **A2A signing** — `SigningA2ATransport` (HMAC) drops spoofed/tampered messages.
- **Least-privilege scopes** — `TeamPolicy` grants only requested ∩ allow ∩
  per-role minus deny.
- **Audit** — `AuditLog` + `AuditingA2ATransport` (who talked to whom, what
  spawned).
- **Secure-by-default spawn** — `applySpawnPolicy` (no network, read-only root,
  caps dropped, resource ceilings; network only with explicit request + egress
  allowlist).

## Modularity — skills & plugins as packages

`src/hades/modules/`: `ModuleManifest` (semver deps), `resolveModules`
(topological load order), `SkillModuleLoader` (hot load/unload/reload),
`PluginPackageLoader` (deny-by-default declared permissions), `ModuleRegistry`
(unified skill+plugin catalog).

## Runnable example

`src/hades/examples/team-parallel.ts` — `demoTeamParallel()` forms a team, spawns
it, has each member serve an A2A RPC handler, fans 12 subtasks across the roster
in parallel, aggregates, and reports the modeled speedup. Dependency-free; also a
regression test.
