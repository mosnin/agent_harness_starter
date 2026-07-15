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
