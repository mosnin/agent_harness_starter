# 24 — Hermes-Swarm Runtime

A lightweight, Hermes-inspired swarm harness: a **manager agent** decomposes a
goal, **spawns each worker in its own isolated container**, delegates tasks, and
accepts a result only after it clears an **anti-hallucination verification gate**
and an **anti-rogue guardrail**. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for
the design; this page is the how-to.

## Run it

```bash
# Inline (single process — no Docker, great for a first look)
npm run swarm -- run "Summarize the repo architecture" --caps research,code

# Real process isolation (each worker is an OS child process over an HTTP control plane)
npm run swarm -- run "Audit the config for risky defaults" --mode process --workers 4

# Which backends are available on this machine?
npm run swarm -- doctor

# Live web dashboard (agent grid + task board + verification feed)
npm run swarm:dashboard        # → http://127.0.0.1:8080
```

Isolation modes (`--mode`):

| Mode | Isolation | When |
|---|---|---|
| `inline` | none (same process) | quick trials, tests |
| `process` | OS child process | local dev / CI without Docker |
| `docker` | container namespaces + cgroups | production |

## Full container swarm

```bash
# 1. Build the worker image the manager spawns
docker build -f docker/swarm/worker.Dockerfile -t hermes-swarm-worker:latest .

# 2. Bring up the manager + dashboard (manager spawns worker containers)
docker compose -f docker-compose.swarm.yml up --build

# 3. Open http://127.0.0.1:8080 and dispatch a goal
```

Every worker container runs hardened: `--cap-drop ALL`, `--no-new-privileges`,
`--read-only` rootfs, bounded PIDs, optional `--network none`, CPU/memory limits.

## Library usage

```typescript
import { createInlineSwarm } from "@agent-harness/core/swarm-runtime";

const swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize: 3 });
swarm.on("task:verified", (t, report) => console.log("verified", t.id, report.score));
const goal = await swarm.runGoal("Describe the module architecture");
console.log(goal.status, goal.synthesis);
await swarm.shutdown();
```

## Using a real model

Workers fall back to a deterministic demo executor when no key is set, so the
swarm always runs. Provide an OpenAI-compatible endpoint to make workers (and the
manager's planner) LLM-backed — any provider works (OpenAI, Nous Portal,
OpenRouter, local vLLM/Ollama):

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1     # or your endpoint
npm run swarm -- run "..." --mode process --workers 3 --caps research,code \
  # pass the model through the worker env (SWARM_MODEL) / --image for docker
```

Or wire your own executor (e.g. the full agent harness with its tool registry)
for real, tool-grounded workers:

```typescript
import { createInlineSwarm } from "@agent-harness/core/swarm-runtime";
import { LLMExecutor, createOpenAICompatibleChat } from "@agent-harness/core/swarm-runtime";

const chat = createOpenAICompatibleChat({ apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o-mini" });
const swarm = await createInlineSwarm({ capabilities: ["research"], executor: new LLMExecutor(chat) });
```

## Why it can't hallucinate its way to "done"

Every worker result must carry grounded claims (`{ statement, evidence[],
confidence }`) plus its full tool trace. The verification gate cross-references
each claim's evidence against what the worker **actually observed** — never
against the answer it generated — so a worker cannot cite its own fabrication.
Fabricated evidence fails the (heavily weighted) `evidence-traceable` check and
is an automatic reject. A goal completes only when **every** task is verified.

The in-app entry point lives at `/swarm` (`src/app/swarm/page.tsx`), which embeds
the dashboard.
