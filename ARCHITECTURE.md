# Hermes-Swarm Architecture

A lightweight, Hermes-inspired agent harness that runs **swarms of isolated
worker agents** coordinated by a **manager agent**. It keeps the plumbing that
makes Hermes useful — CLI, web dashboard, multiple execution backends, tool
plumbing, MCP, skills — but adds the piece the user's brief asked for and that
Hermes does not ship as a first-class primitive: a manager that **spawns each
worker in its own isolated container**, delegates tasks to them, and refuses to
accept any result that isn't provably grounded.

The design goal is stated plainly: **make it structurally hard for an agent to
hallucinate or go rogue.** That is not a prompt-engineering aspiration here — it
is enforced by two independent gates every worker output must clear before the
manager counts it as done.

---

## 1. Topology

```
                       ┌─────────────────────────────────────────┐
                       │              MANAGER AGENT               │
                       │  (only component that can spawn/kill      │
                       │   workers and accept/reject results)      │
   dashboard ◀── SSE ──┤                                          │
   REST API  ◀───────  │   Planner → Dispatch → Verify → Synthesize│
                       └───────┬───────────────┬──────────────────┘
                               │ spawn          │ enqueue tasks
                     ContainerProvider     pull-based bus (HTTP)
                               │                │
        ┌──────────────────────┼────────────────┼──────────────────────┐
        ▼                       ▼                ▼                       ▼
 ┌────────────┐         ┌────────────┐    ┌────────────┐         ┌────────────┐
 │  worker 1  │         │  worker 2  │    │  worker 3  │   …     │  worker N  │
 │ container  │         │ container  │    │ container  │         │ container  │
 │ (isolated) │         │ (isolated) │    │ (isolated) │         │ (isolated) │
 └────────────┘         └────────────┘    └────────────┘         └────────────┘
   one task at a time · no inbound port · cap-drop · read-only · no-new-privs
```

- **Manager** — plans the goal, spawns the worker pool, dispatches tasks whose
  dependencies are satisfied, and runs every returned result through the
  verification gate and anti-rogue guardrail before marking it verified.
- **Workers** — deliberately powerless. Each receives one task at a time, runs
  in its own isolation unit, and reports a result. A worker cannot mark its own
  work done, cannot spawn siblings, and reaches nothing but the authenticated
  bus.
- **Bus** — pull-based. Workers long-poll the manager's control plane for their
  next task, so they need no inbound port and can run network-restricted.

---

## 2. Isolation backends (`ContainerProvider`)

One interface, three implementations — pick the isolation strength you need:

| Provider | Isolation | Use |
|---|---|---|
| `InlineProvider` | none (same process) | tests, quick trials |
| `LocalProcessProvider` | OS child process | local dev, CI, no Docker |
| `DockerProvider` | container namespaces + cgroups | production |

The **Docker provider** hardens every worker container by default:
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` rootfs,
`--pids-limit`, optional `--network none`, and CPU/memory ceilings. A worker
that is prompt-injected or goes rogue cannot touch the host, the manager, or its
siblings.

The verification gate and guardrails run **identically** across all three
backends, so the trust guarantees do not depend on which isolation you choose —
only the blast radius does.

---

## 3. Anti-hallucination: the Verification Gate

Every `WorkerResult` carries not just an `output` but a list of **grounded
claims** (`{ statement, evidence[], confidence }`) and the worker's full
**tool-call trace**. The gate scores the result before the manager may accept
it:

| Check | Weight | What it enforces |
|---|---|---|
| `has-claims` | 1 | output must come with verifiable claims |
| `evidence-present` | 2 | every claim must cite evidence |
| **`evidence-traceable`** | **3** | cited evidence must trace back to the actual tool log — **fabricated evidence is caught here** |
| `no-ungrounded-hedging` | 1 | no speculative "I think / probably" claims without backing |
| `confidence-calibrated` | 1 | high confidence with zero evidence is rejected |
| `output-supported` | 1 | non-empty output backed by claims |
| `llm-judge` (optional) | 2 | independent adversarial second opinion |

A failed **`evidence-traceable`** check is an automatic reject regardless of the
aggregate score — *you cannot average your way past a fabrication.* Borderline
results are returned for **revision** with concrete feedback; the worker gets a
bounded number of attempts, then the task fails. A goal only completes when
**every** task is `verified`.

This is the core mechanism: a worker cannot assert a fact into existence,
because the manager cross-references each claim against what the worker actually
observed.

---

## 4. Anti-rogue: the Behavioural Guardrail

The gate asks *"is the output true?"*; the guardrail asks *"did the worker
behave?"*. It scans the tool trace and output for:

- **destructive commands** (`rm -rf /`, `mkfs`, fork bombs, `shutdown`) → **kill**
- **data exfiltration** (piping secrets/credentials to raw IPs) → **kill**
- **sandbox escape** (`/var/run/docker.sock`, `nsenter`, `--privileged`, `kubectl`) → **kill**
- **self-preservation** (disabling its own guardrail/verifier/oversight) → **kill**
- **capability escape** (using a tool it never declared) → **block**
- **egress violations** (contacting non-allowlisted hosts) → **block**
- **runaway loops** (tool-call count over the ceiling) → **kill**

A `kill` finding tears the worker's container down mid-flight and replaces it,
keeping the pool at strength. `block` forces a redo. The worker never gets the
benefit of the doubt.

---

## 5. Lifecycle of a goal

1. **Plan** — `Planner` decomposes the objective into a dependency-ordered task
   set (deterministic fan-out by default; `LLMPlanner` when a model is wired).
2. **Spawn** — the manager brings the worker pool up via the chosen provider.
3. **Dispatch** — tasks whose dependencies are all `verified` are enqueued;
   verified upstream outputs are threaded into the task input for grounding.
4. **Execute** — a worker pulls one task, runs its `TaskExecutor`, and reports
   output + claims + tool trace.
5. **Guard** — the anti-rogue guardrail inspects behaviour (may kill the worker).
6. **Verify** — the gate scores grounding → `accept` / `revise` / `reject`.
7. **Synthesize** — when every task verifies, the manager assembles the final
   answer from the synthesis task.

---

## 6. Surfaces

- **CLI** (`hermes-swarm`): `run`, `serve`, `doctor`; `--mode inline|process|docker`.
- **Web dashboard**: live agent grid, task board, and a verification feed that
  shows every verdict and check — served by `SwarmServer` over REST + SSE.
- **Docker**: `docker/swarm/worker.Dockerfile`, `manager.Dockerfile`, and
  `docker-compose.swarm.yml` for a one-command local swarm.
- **Library**: `import { createInlineSwarm, buildSwarm, SwarmServer } from "@agent-harness/core/swarm-runtime"`.

---

## 7. Module map

```
src/swarm-runtime/
├── types.ts                 # core types: providers, tasks, claims, verdicts
├── providers/               # inline | local-process | docker isolation
├── bus/                     # in-memory + HTTP control plane / worker client
├── verification/            # gate.ts (anti-hallucination) + guardrails.ts (anti-rogue)
├── manager/                 # manager.ts (orchestration) + planner.ts
├── worker/                  # runtime.ts + executor.ts + entrypoint.ts (container PID 1)
├── server/                  # build-swarm.ts + swarm-server.ts + dashboard.ts
├── cli.ts                   # hermes-swarm CLI
└── factory.ts               # createInlineSwarm — fully wired, zero-config
```

It builds on the existing in-process `src/agents/swarm` coordinator (logical
registry, load-balancing, consensus) and reuses the harness's guardrail and
claims concepts, adding the physical isolation and trust enforcement layer on
top.
