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
